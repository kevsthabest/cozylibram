// Deletion tombstones: local removal records a tombstone, sync pushes and
// pulls them, and tombstoned books never resurrect from another device.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in tombstone tests'); };

function makeSyncStub() {
  const books = [];   // { user_id, book_id, isbn, data }
  const deleted = []; // { user_id, book_id, deleted_at }
  return {
    books, deleted,
    from: (table) => {
      if (table === 'books') return {
        upsert: async (rows) => {
          for (const r of rows) {
            const i = books.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
            if (i >= 0) books[i] = r; else books.push(r);
          }
          return { error: null };
        },
        select: (cols) => require('./harness').chainableSelect(books,
          r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })),
      };
      if (table === 'deleted_books') return {
        upsert: async (rows) => {
          for (const r of rows) {
            const i = deleted.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
            if (i >= 0) deleted[i] = r; else deleted.push(r);
          }
          return { error: null };
        },
        select: async () => ({ data: deleted.map(r => ({ book_id: r.book_id })), error: null }),
        delete: () => {
          const filters = [];
          const chain = {
            eq: (col, val) => { filters.push(r => r[col] === val); return chain; },
            in: (col, vals) => { filters.push(r => vals.includes(r[col])); return chain; },
            then: (resolve) => {
              for (let i = deleted.length - 1; i >= 0; i--) {
                if (filters.every(f => f(deleted[i]))) deleted.splice(i, 1);
              }
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
      throw new Error('unexpected table: ' + table);
    }
  };
}

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const mk = (id) => `({ id: '${id}', isbn: '978${id}', title: 'Book ${id}', authors: ['A'], cover: '',
  description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', owned: true, ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: '' })`;

(async () => {
  // 1. removeBook: drops the book, records a tombstone, persists it
  runInWindow(`library = [${mk('t1')}, ${mk('t2')}]; tombstones = []; saveTombstones(); saveLibrary({noCloud:true});`);
  runInWindow(`removeBook('t1');`);
  ok('removeBook drops the book', window.eval(`library.map(b => b.id)`).join(',') === 't2');
  ok('removeBook records a tombstone', window.eval(`tombstones.map(t => t.id)`).join(',') === 't1');
  ok('tombstone persisted', JSON.parse(window.localStorage.getItem('spicyshelves.tombstones.v1')).some(t => t.id === 't1'));
  runInWindow(`removeBook('t1');`);
  ok('duplicate delete does not duplicate tombstone', window.eval(`tombstones.length`) === 1);

  // 2. untombstone: re-adding the same id clears it
  runInWindow(`untombstone('t1');`);
  ok('untombstone clears', window.eval(`tombstones.length`) === 0);

  // 3. mergeCloudBooks skips tombstoned rows (the resurrection fix)
  const local = [{ id: 'm1', title: 'Mine', _mtime: 5 }];
  const merged = window.mergeCloudBooks(local, [
    { book_id: 'm1', data: { id: 'm1', title: 'Newer', _mtime: 50 } },
  ]);
  ok('merge still works normally', merged && local[0].title === 'Newer');
  runInWindow(`tombstones = [{ id: 'gone', at: 1 }];`);
  const local2 = [];
  const merged2 = window.mergeCloudBooks(local2, [
    { book_id: 'gone', data: { id: 'gone', title: 'Zombie', _mtime: 99 } },
    { book_id: 'new', data: { id: 'new', title: 'Fresh', _mtime: 99 } },
  ]);
  ok('tombstoned row skipped', !local2.some(b => b.id === 'gone'));
  ok('other rows still merge', local2.some(b => b.id === 'new') && merged2);
  runInWindow(`tombstones = []; saveTombstones();`);

  // 4. applyTombstones: drops local books, records tombstones
  runInWindow(`library = [${mk('a1')}, ${mk('a2')}]; tombstones = []; saveLibrary({noCloud:true});`);
  const changed = window.applyTombstones(['a1']);
  ok('applyTombstones drops the book', window.eval(`library.map(b => b.id)`).join(',') === 'a2');
  ok('applyTombstones records it locally', window.eval(`tombstones.map(t => t.id)`).join(',') === 'a1');
  ok('applyTombstones reports change', changed === true);
  ok('applyTombstones no-op when empty', window.applyTombstones([]) === false);

  // 5. full sync: local deletion propagates to the cloud, remote row can't resurrect
  const stub = makeSyncStub();
  window.__sbStub = stub;
  runInWindow(`cloudUser = { id: 'u1' };`);
  // "device B" state in the cloud: both books present
  stub.books.push(
    { user_id: 'u1', book_id: 's1', isbn: null, data: { id: 's1', title: 'S1', _mtime: 10 } },
    { user_id: 'u1', book_id: 's2', isbn: null, data: { id: 's2', title: 'S2', _mtime: 10 } });
  runInWindow(`library = [${mk('s1')}, ${mk('s2')}]; tombstones = []; saveLibrary({noCloud:true});`);
  runInWindow(`removeBook('s1');`); // deleted on this device
  await window.cloudFirstSync();
  await tick(100);
  ok('deleted book not resurrected locally', window.eval(`library.map(b => b.id)`).join(',') === 's2');
  ok('tombstone pushed to cloud', stub.deleted.some(r => r.book_id === 's1' && r.user_id === 'u1'));

  // 6. full sync: remote deletion (from another device) applies here
  const stub2 = makeSyncStub();
  window.__sbStub = stub2;
  stub2.deleted.push({ user_id: 'u1', book_id: 'r1', deleted_at: new Date().toISOString() });
  stub2.books.push({ user_id: 'u1', book_id: 'r2', isbn: null, data: { id: 'r2', title: 'R2', _mtime: 10 } });
  runInWindow(`library = [${mk('r1')}, ${mk('r2')}]; tombstones = []; saveLibrary({noCloud:true});`);
  await window.cloudFirstSync();
  await tick(100);
  ok('remote deletion applied locally', window.eval(`library.map(b => b.id)`).join(',') === 'r2');
  ok('remote tombstone recorded locally', window.eval(`tombstones.map(t => t.id)`).join(',') === 'r1');
  ok('remote tombstone re-pushed (converges)', stub2.deleted.some(r => r.book_id === 'r1'));

  // 8. v141: resurrectCloudBooks — explicit "Download into this library" is an
  // un-delete. Reproduces the "books vanish on refresh" bug: stale cloud
  // tombstones re-applied on every boot, so a plain merge could never bring
  // the books back.
  const stub3 = makeSyncStub();
  window.__sbStub = stub3;
  runInWindow(`cloudUser = { id: 'u1' };`);
  stub3.books.push(
    { user_id: 'u1', book_id: 'z1', isbn: null, data: { id: 'z1', title: 'Z1', _mtime: 10 } },
    { user_id: 'u1', book_id: 'z2', isbn: null, data: { id: 'z2', title: 'Z2', _mtime: 10 } });
  stub3.deleted.push(
    { user_id: 'u1', book_id: 'z1', deleted_at: new Date().toISOString() },
    { user_id: 'u1', book_id: 'z2', deleted_at: new Date().toISOString() });
  runInWindow(`library = []; tombstones = [{ id: 'z1', at: 1 }, { id: 'z2', at: 2 }]; saveTombstones(); saveLibrary({noCloud:true});`);
  const zrows = stub3.books.map(r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data }));
  const skipped = window.mergeCloudBooks([], zrows);
  ok('bug reproduced: plain merge skips tombstoned rows', skipped === false);
  const added = await window.resurrectCloudBooks(zrows);
  await tick(100);
  ok('resurrect returns the added count', added === 2);
  ok('tombstoned books merged into the library',
    window.eval(`library.map(b => b.id).sort().join(',')`) === 'z1,z2');
  ok('local tombstones cleared', window.eval(`tombstones.length`) === 0);
  ok('cloud tombstone rows deleted', stub3.deleted.length === 0);
  ok('cloud book rows untouched', stub3.books.length === 2);
  // A later boot no longer re-applies the deletion.
  runInWindow(`library = [];`); // simulate a fresh boot load
  await window.cloudFirstSync();
  await tick(100);
  ok('books survive a reboot sync', window.eval(`library.map(b => b.id).sort().join(',')`) === 'z1,z2');

  // 7. tombstones partition per user via setLocalUser (with first-sign-in adoption)
  runInWindow(`localStorage.removeItem('spicyshelves.tombstones.v1');`);
  runInWindow(`localStorage.removeItem('spicyshelves.tombstones.v2.user-9');`);
  runInWindow(`tombstones = [{ id: 'adopted', at: 1 }]; saveTombstones();`); // offline state
  runInWindow(`setLocalUser('user-9');`);
  ok('offline tombstones adopted on first sign-in',
    window.eval(`tombstones.some(t => t.id === 'adopted')`));
  runInWindow(`tombstones.push({ id: 'u9dead', at: 2 }); saveTombstones();`);
  runInWindow(`setLocalUser(null);`);
  ok('signed-out shelf keeps the handed-back tombstones (v136)',
    window.eval(`tombstones.some(t => t.id === 'u9dead') && tombstones.some(t => t.id === 'adopted')`));
  runInWindow(`setLocalUser('user-9');`);
  ok('user tombstones restored on return',
    window.eval(`tombstones.some(t => t.id === 'u9dead') && tombstones.some(t => t.id === 'adopted')`));
  runInWindow(`setLocalUser(null); tombstones = []; saveTombstones();`);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
