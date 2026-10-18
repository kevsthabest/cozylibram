// Regression pins for issue #334: updates that arrive via cloud merge
// changed the in-memory book but were never written to the local store.
// mergeAssign unmarked the book dirty (correctly — a merge must not bump
// _mtime or re-push), but the same dirty flag was the persist plan's only
// "content differs from the store" signal for a known book, so the plan
// skipped it and a restart reverted the book to the pre-merge copy.
//
// The fix separates the two meanings: dirtyBooks = "local edit, stamp
// and push"; persistOnlyBooks = "content differs from the local store,
// write it there, but never stamp or push on that account". These pins
// judge the pure seams the data-perf suite uses (the harness runs the
// legacy backend, so the IDB write itself is exercised only through
// computePersistPlan's selection, exactly as data-perf pins it).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(APP_DIR + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in merged-persist tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

(async () => {
// ---------- a merged update must reach the persist plan ----------
runInWindow(`
  var __b = migrateBook({ id: 'mp1', title: 'Before', _mtime: 100 }); unmarkDirty(__b);
  var __clean = migrateBook({ id: 'mp2', title: 'Untouched', _mtime: 100 }); unmarkDirty(__clean);
  var __lib = [__b, __clean];
  mergeCloudBooks(__lib, [
    { book_id: 'mp1', data: { id: 'mp1', title: 'After', _mtime: 200 } },
  ]);
  window.__mergedTitle = __b.title;
  window.__stillNotDirty = !dirtyBooks.has(__b);
  window.__persistOnly = (typeof persistOnlyBooks !== 'undefined') && persistOnlyBooks.has(__b);
  window.__cleanNotPersistOnly = (typeof persistOnlyBooks !== 'undefined') && !persistOnlyBooks.has(__clean);
  var __plan = computePersistPlan(new Set(['mp1', 'mp2']), __lib);
  window.__planIds = __plan.dirty.map(b => b.id).sort().join(',');
`);
ok('merge applies the newer remote record', window.__mergedTitle === 'After');
ok('merged book is NOT dirty (no _mtime ping-pong, no re-push)', window.__stillNotDirty === true);
ok('merged book IS marked persist-only', window.__persistOnly === true);
ok('untouched book is not persist-only', window.__cleanNotPersistOnly === true);
ok('persist plan includes the merged book (fails pre-fix)', window.__planIds === 'mp1');

// ---------- stampMtimes must not advance a merged book ----------
runInWindow(`
  library = __lib;
  stampMtimes();
  window.__mtimeAfterStamp = __b._mtime;
  library = [];
`);
ok('stampMtimes leaves the merged book at the remote _mtime', window.__mtimeAfterStamp === 200);

// ---------- a local edit after a merge re-dirties normally ----------
runInWindow(`
  __b.title = 'Edited locally';
  window.__editDirty = dirtyBooks.has(__b);
  library = [__b];
  stampMtimes();
  window.__mtimeAfterEdit = __b._mtime;
  library = [];
`);
ok('local edit after merge dirties the book', window.__editDirty === true);
ok('stampMtimes advances a locally edited book', window.__mtimeAfterEdit > 200);

// ---------- a plain local edit plans exactly as before ----------
runInWindow(`
  var __e = migrateBook({ id: 'mp3', title: 'Local', _mtime: 5 }); unmarkDirty(__e);
  __e.title = 'Local edit';
  var __plan2 = computePersistPlan(new Set(['mp3']), [__e]);
  window.__plan2Ids = __plan2.dirty.map(b => b.id).join(',');
`);
ok('locally edited known book is in the persist plan', window.__plan2Ids === 'mp3');

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
