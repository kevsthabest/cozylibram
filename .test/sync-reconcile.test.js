// Regression pins for issues #335 and #336 (2026-11-02 review):
//
// #335: cloudPushNow upserted its batch unconditionally. A stale device
// (old _mtime, e.g. one that was offline while another device edited)
// regressed the cloud copy to its older record, and since the pull
// merge also keys on _mtime, the divergence never healed — the newer
// edits were silently lost everywhere. The push must skip any row the
// cloud already holds a strictly newer _mtime for; the next pull then
// merges the newer record down and the devices converge.
//
// #336: mergeAssign was Object.assign, which can add/overwrite keys
// but never remove them. A field deleted on one device (the codebase
// represents a deleted book field by the key's ABSENCE — see the
// `delete b.x` cleanups in migrateBook, js/020) resurrected from every
// peer whose copy still carried it, forever. When a remote record
// wins the merge, keys absent from the winning record must be deleted
// from the local book.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sync-reconcile tests'); };

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
  // ---------- #336: a winning merge deletes keys the winner lacks ----------
  runInWindow(`library = [${mk('d1', ", _mtime: 100, legacyJunk: 'gone', progressUnit: 'pct'")}]; tombstones = []; tombstoneFloor = 0;`);
  runInWindow(`mergeCloudBooks(library, [{ book_id: 'd1', isbn: null, data: { id: 'd1', title: 'Winner', _mtime: 200 } }]);`);
  ok('#336 winning merge applies the winner\'s values', probe(`library[0].title`) === 'Winner');
  ok('#336 a key absent from the winning record is deleted locally',
    probe(`'legacyJunk' in library[0]`) === false);
  ok('#336 a real field absent from the winner is deleted too',
    probe(`'progressUnit' in library[0]`) === false);
  ok('#336 the deletion is stable across a re-merge (no resurrection)',
    probe(`mergeCloudBooks(library, [{ book_id: 'd1', isbn: null, data: { id: 'd1', title: 'Winner', _mtime: 200 } }]), 'legacyJunk' in library[0]`) === false);

  // The pure push-reconciliation helper, pinned directly.
  ok('#335 reconcile: a strictly newer cloud row blocks the stale push row',
    probe(`reconcilePushRows([{ book_id: 'a', data: { _mtime: 5 } }], [{ book_id: 'a', data: { _mtime: 9 } }]).keep.length`) === 0);
  ok('#335 reconcile: equal _mtime still pushes (the #129 tie-break owns ties)',
    probe(`reconcilePushRows([{ book_id: 'a', data: { _mtime: 9 } }], [{ book_id: 'a', data: { _mtime: 9 } }]).keep.length`) === 1);
  ok('#335 reconcile: a cloud row with no local counterpart is ignored',
    probe(`reconcilePushRows([{ book_id: 'a', data: { _mtime: 5 } }], [{ book_id: 'z', data: { _mtime: 99 } }]).keep.length`) === 1);

  // ---------- #335: cloudPushNow never regresses a newer cloud copy ----------
  const store = [
    { user_id: 'u1', book_id: 's1', isbn: null, data: { id: 's1', title: 'Cloud Newer', _mtime: 9000 } },
  ];
  const upserted = [];
  window.__sbStub = {
    from: (table) => {
      if (table === 'books') return {
        upsert: async (rows) => { upserted.push(...rows); return { error: null }; },
        select: () => require('./harness').chainableSelect(store,
          r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
      if (table === 'deleted_books') return {
        upsert: async () => ({ error: null }),
        select: () => require('./harness').chainableSelect([], () => ({})),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
      throw new Error('unexpected table: ' + table);
    },
  };
  runInWindow(`cloudUser = { id: 'u1' }; tombstones = [];
    library = [${mk('s1', ", _mtime: 100")}, ${mk('s2', ", _mtime: 500")}];
    library[0].title = 'Stale Local'; markDirty(library[0]); markDirty(library[1]);`);
  const pushed = await probe(`cloudPushNow()`);
  await tick(30);
  ok('#335 push reports success', pushed === true);
  ok('#335 the stale book is NOT upserted over the newer cloud copy',
    !upserted.some(r => r.book_id === 's1'));
  ok('#335 a book the cloud does not hold newer still pushes normally',
    upserted.some(r => r.book_id === 's2'));
  ok('#335 the cloud copy keeps its newer record',
    store.find(r => r.book_id === 's1').data.title === 'Cloud Newer' &&
    store.find(r => r.book_id === 's1').data._mtime === 9000);

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
