// Sync apply integrity — three pins from the 2026-10-18 data/sync bug review:
//
// #372: applyTombstones must record the deletion's ORIGINAL time, not
// Date.now(). The fabricated stamp is what the next push publishes, and a
// fresh stamp defeats the v142 tombstone floor cross-device: a device that
// merely applied an old deletion re-publishes it as happening now, newer
// than another device's explicit restore, and the restored book is
// re-deleted there.
//
// #333: mergeCloudBooks must force the merged book's id to the cloud row's
// book_id (row key wins). Letting the payload's data.id (or its sanitized
// form) win detaches the local book from its server row: the row is
// re-added as new on every pull (duplication), duplicates break the batch
// upsert, and deletion tombstones the wrong id so the book is undeletable.
//
// #329: cloudPushNow's tombstone leg must use the account and tombstone
// set captured when the push was materialized — not the live globals,
// which a mid-push sign-out/sign-in replaces. Only the high-water write
// was slot-pinned (v495); the tombstone upsert/delete/prune were not.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sync-apply tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const mk = (id, extra) => `({ id: '${id}', isbn: '978${id}', title: 'Book ${id}', authors: ['A'], cover: '',
  description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', owned: true, ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
  ${extra || ''} })`;

(async () => {
  // Await the boot load before seeding (the production contract since
  // the legacy boot was DOMContentLoaded-gated) so it cannot land
  // mid-scenario and replace the seeded state.
  await window.eval('storageReady');
  // ---------- #372: applied tombstones keep their original time ----------
  runInWindow(`library = [${mk('x1')}]; tombstones = []; tombstoneFloor = 0;`);
  runInWindow(`applyTombstones([{ id: 'x1', at: 1000000 }]);`);
  ok('#372 applied tombstone keeps the original deletion time',
    probe(`tombstones.find(t => t.id === 'x1')`).at === 1000000);
  ok('#372 the book is dropped', probe(`library.length`) === 0);

  // The floor contract the stamp feeds: a deletion older than the floor
  // (an explicit restore happened after it) must not re-delete the book.
  runInWindow(`library = [${mk('y1')}]; tombstones = []; tombstoneFloor = 1050000;`);
  const changedFloor = probe(`applyTombstones([{ id: 'y1', at: 1000000 }])`);
  ok('#372 a pre-floor deletion does not re-delete a restored book',
    changedFloor === false && probe(`library.length`) === 1);

  // ---------- #333: the row key wins over the payload id ----------
  runInWindow(`library = []; tombstones = []; tombstoneFloor = 0;`);
  runInWindow(`mergeCloudBooks(library, [{ book_id: 'bm1', isbn: null, data: { id: 'bm2', title: 'T', _mtime: 10 } }]);`);
  ok('#333 new merged book takes the row key as its id',
    probe(`library.length`) === 1 && probe(`library[0].id`) === 'bm1');
  runInWindow(`mergeCloudBooks(library, [{ book_id: 'bm1', isbn: null, data: { id: 'bm2', title: 'T', _mtime: 10 } }]);`);
  ok('#333 re-pulling the same row does not duplicate the book',
    probe(`library.length`) === 1);

  runInWindow(`library = [];`);
  runInWindow(`mergeCloudBooks(library, [{ book_id: 'bm9', isbn: null, data: { id: 'bm.9', title: 'S', _mtime: 3 } }]);`);
  ok('#333 a payload id that sanitizes away from the key still lands on the key',
    probe(`library.length`) === 1 && probe(`library[0].id`) === 'bm9');

  runInWindow(`library = [${mk('bm1', ", _mtime: 1")}]; library[0].title = 'Old';`);
  runInWindow(`mergeCloudBooks(library, [{ book_id: 'bm1', isbn: null, data: { id: 'zz', title: 'New', _mtime: 99 } }]);`);
  ok('#333 a winning remote record does not rewrite the local book id',
    probe(`library[0].id`) === 'bm1' && probe(`library[0].title`) === 'New');

  // ---------- #329: the tombstone leg belongs to the push that started ----------
  const calls = { deletedUpsert: null, booksDeleteEq: null };
  let releaseBooksUpsert = null;
  const stub = {
    from: (table) => {
      if (table === 'books') return {
        upsert: (rows) => new Promise(res => { releaseBooksUpsert = () => res({ error: null }); }),
        select: () => require('./harness').chainableSelect([], () => ({})),
        delete: () => ({
          eq: (col, val) => { calls.booksDeleteEq = val; return { in: () => Promise.resolve({ error: null }) }; },
        }),
      };
      if (table === 'deleted_books') return {
        upsert: async (rows) => { calls.deletedUpsert = rows; return { error: null }; },
        select: () => require('./harness').chainableSelect([], () => ({})),
        delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
      };
      throw new Error('unexpected table: ' + table);
    },
  };
  window.__sbStub = stub;
  runInWindow(`cloudUser = { id: 'uA' }; tombstones = [{ id: 'deadA', at: 123 }];
    library = [${mk('bk1', ", _mtime: 5000")}]; markDirty(library[0]);`);
  const pushPromise = probe(`cloudPushNow()`);
  await tick(60); // the books upsert is now in flight
  // The user signs out and in as B while A's push is suspended.
  runInWindow(`cloudUser = { id: 'uB' }; tombstones = [{ id: 'deadB', at: 1 }];`);
  releaseBooksUpsert();
  await pushPromise;
  ok('#329 tombstone upsert carries the push owner\'s id and set',
    Array.isArray(calls.deletedUpsert) && calls.deletedUpsert.length === 1 &&
    calls.deletedUpsert[0].user_id === 'uA' && calls.deletedUpsert[0].book_id === 'deadA');
  ok('#329 cloud-row delete is scoped to the push owner', calls.booksDeleteEq === 'uA');
  ok('#329 the new slot\'s tombstone set is not pruned or persisted by the old push',
    probe(`tombstones.length`) === 1 && probe(`tombstones[0].id`) === 'deadB');

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
