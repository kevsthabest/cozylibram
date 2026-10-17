// Data-layer performance tests (v495: #125 dirty-flag saves, #127 single-save
// sweep, #128 differential push + tombstone pruning).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(APP_DIR + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in data-perf tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const waitFor = async (key, tries) => {
  for (let i = 0; i < (tries || 100) && window[key] === undefined; i++)
    await new Promise(r => setTimeout(r, 20));
};
const tick = (n) => new Promise(r => setTimeout(r, (n || 2) * 20));

(async () => {
// ---------- #125: dirty-flag tracking ----------
runInWindow(`
  var __b = migrateBook({ id: 'd1', title: 'Dirty One' });
  window.__t1 = dirtyBooks.has(__b);              // newly wrapped books start dirty
  unmarkDirty(__b);
  window.__t2 = !dirtyBooks.has(__b);
  __b.title = 'Dirty One (edited)';               // top-level set
  window.__t3 = dirtyBooks.has(__b);
  unmarkDirty(__b);
  __b.ratings.plot = 5;                           // nested object set
  window.__t4 = dirtyBooks.has(__b);
  unmarkDirty(__b);
  __b.log.push({ d: '2026-01-01', from: 1, to: 5 }); // nested array push
  window.__t5 = dirtyBooks.has(__b);
  unmarkDirty(__b);
  __b.title = __b.title;                          // same-value set: no-op
  window.__t6 = !dirtyBooks.has(__b);
  unmarkDirty(__b);
  __b.extra = 'temp'; unmarkDirty(__b);
  delete __b.extra;                               // deleteProperty
  window.__t7 = dirtyBooks.has(__b);
  window.__t8 = (trackBook(__b) === __b);         // idempotent
  window.__t9 = !dirtyBooks.has({ id: 'raw' });   // untracked never dirty
`);
ok('#125: migrateBook marks the book dirty', window.__t1 === true);
ok('#125: unmarkDirty clears it', window.__t2 === true);
ok('#125: top-level set dirties', window.__t3 === true);
ok('#125: nested object set dirties the root book', window.__t4 === true);
ok('#125: nested array push dirties the root book', window.__t5 === true);
ok('#125: same-value set does not dirty', window.__t6 === true);
ok('#125: delete dirties', window.__t7 === true);
ok('#125: trackBook is idempotent', window.__t8 === true);
ok('#125: untracked objects are never dirty', window.__t9 === true);

// cross-book reroot: tracked content moved via Object.assign (bookmory pattern)
runInWindow(`
  var __r1 = migrateBook({ id: 'r1', title: 'R1', log: [{ d: 'x', from: 1, to: 5 }] });
  var __r2 = migrateBook({ id: 'r2', title: 'R2' });
  unmarkDirty(__r1); unmarkDirty(__r2);
  Object.assign(__r2, __r1);
  __r2.log.push({ d: 'y', from: 1, to: 2 });
  window.__r2dirty = dirtyBooks.has(__r2);
  window.__r1dirty = dirtyBooks.has(__r1);
  window.__rerooted = (proxyRootOf.get(__r2.log) === __r2);
`);
ok('#125: nested mutation after cross-book assign dirties the containing book', window.__r2dirty === true);
ok('#125: cross-book assign does not dirty the source book', window.__r1dirty === false);
ok('#125: moved subtree is re-rooted to the containing book', window.__rerooted === true);

// merge must not ping-pong _mtime (#125 x #128)
runInWindow(`
  var __m1 = migrateBook({ id: 'm1', title: 'Same', _mtime: 100 }); unmarkDirty(__m1);
  var __m2 = migrateBook({ id: 'm2', title: 'Old', _mtime: 100 }); unmarkDirty(__m2);
  var __mlib = [__m1, __m2];
  mergeCloudBooks(__mlib, [
    { book_id: 'm1', data: { id: 'm1', title: 'Same', _mtime: 200 } },
    { book_id: 'm2', data: { id: 'm2', title: 'New', _mtime: 200 } },
    { book_id: 'm3', data: { id: 'm3', title: 'Brand New', _mtime: 50 } },
  ]);
  window.__m1ok = (__m1._mtime === 200 && !dirtyBooks.has(__m1));
  window.__m2ok = (__m2.title === 'New' && !dirtyBooks.has(__m2));
  window.__m3ok = dirtyBooks.has(__mlib.find(b => b.id === 'm3'));
`);
ok('#125: merge adopts newer _mtime without dirtying (no ping-pong)', window.__m1ok === true);
ok('#125: merge applies changed rows without dirtying', window.__m2ok === true);
ok('#125: merge marks brand-new books dirty (must persist)', window.__m3ok === true);

// stampMtimes only bumps dirty books
runInWindow(`
  library = [migrateBook({ id: 's1', title: 'S1' }), migrateBook({ id: 's2', title: 'S2' })];
  unmarkDirty(library[0]); unmarkDirty(library[1]);
  library[0].title = 'S1b';
  saveLibrary({ noCloud: true });
  window.__s1m = library[0]._mtime;
  window.__s2m = library[1]._mtime;
  window.__s2clean = !dirtyBooks.has(library[1]);
  library = [];
`);
ok('#125: changed book gets _mtime', window.__s1m > 0);
ok('#125: unchanged book keeps _mtime 0', window.__s2m === 0);
ok('#125: unchanged book stays clean after save', window.__s2clean === true);

// cloneForStore: proxies never reach the IDB layer
runInWindow(`
  var __cb = migrateBook({ id: 'cb', title: 'CB', log: [{ d: 'x', from: 1, to: 2 }] });
  var __raw = cloneForStore(__cb);
  window.__rawOk = (__raw.title === 'CB' && __raw.log.length === 1
    && !proxyRootOf.has(__raw) && !proxyRootOf.has(__raw.log) && !proxyRootOf.has(__raw.log[0]));
  __raw.log.push({ d: 'y' });
  window.__rawIso = (__cb.log.length === 1);
`);
ok('#125: cloneForStore returns a deep raw clone (no proxies)', window.__rawOk === true);
ok('#125: cloneForStore output is isolated from the book', window.__rawIso === true);

// computePersistPlan: pure diff selection
runInWindow(`
  var __k1 = migrateBook({ id: 'k1', title: 'K1' }); unmarkDirty(__k1);
  var __k2 = migrateBook({ id: 'k2', title: 'K2' }); // stays dirty
  var __plan = computePersistPlan(new Set(['k1', 'k2', 'gone']), [__k1, __k2]);
  window.__pDirty = __plan.dirty.map(b => b.id).sort().join(',');
  window.__pDel = __plan.deleted.sort().join(',');
  window.__pExp = __plan.expectedCount;
  window.__pIds = [...__plan.ids].sort().join(',');
  var __plan2 = computePersistPlan(new Set(['a', 'b', 'c']), [migrateBook({ id: 'd', title: 'D' })]);
  window.__p2Del = __plan2.deleted.sort().join(',');
  window.__p2Exp = __plan2.expectedCount;
`);
ok('#125: computePersistPlan selects only dirty books', window.__pDirty === 'k2');
ok('#125: computePersistPlan detects deletions', window.__pDel === 'gone');
ok('#125: computePersistPlan expectedCount = kept + added', window.__pExp === 2 && window.__pIds === 'k1,k2');
ok('#125: computePersistPlan handles wholesale replace', window.__p2Del === 'a,b,c' && window.__p2Exp === 1);

// idbPutDirtyBooks: differential write against a minimal fake IDB
runInWindow(`
window.__fakeDb = (() => {
  const books = new Map();
  return { books, db: {
    transaction(names, mode) {
      const tx = {};
      tx.objectStore = () => ({
        put(v) { books.set(v.id, JSON.parse(JSON.stringify(v))); },
        delete(id) { books.delete(id); },
        clear() { books.clear(); },
        count() { const req = {}; setTimeout(() => { req.result = books.size; req.onsuccess && req.onsuccess(); }, 0); return req; },
      });
      setTimeout(() => { tx.oncomplete && tx.oncomplete(); }, 0);
      return tx;
    }
  } };
})();
window.__fakeDb.books.set('a', { id: 'a', title: 'A' });
window.__fakeDb.books.set('b', { id: 'b', title: 'B' });
window.__fakeDb.books.set('c', { id: 'c', title: 'C' });
(async () => {
  try {
    // update b (as a tracked proxy — proves proxies never reach IDB), add d, delete a
    const dirty = [migrateBook({ id: 'b', title: 'B2' }), migrateBook({ id: 'd', title: 'D' })];
    await idbPutDirtyBooks(window.__fakeDb.db, dirty, ['a'], 3);
    const bk = window.__fakeDb.books;
    window.__diffOk = (bk.size === 3 && bk.get('b').title === 'B2' && bk.has('d') && !bk.has('a') && bk.has('c'));
    window.__cloneOk = !proxyRootOf.has(bk.get('b'));
    try { await idbPutDirtyBooks(window.__fakeDb.db, [], [], 999); window.__mismatchOk = false; }
    catch (e) { window.__mismatchOk = /count mismatch/.test(e.message); }
    try { await idbPutDirtyBooks(window.__fakeDb.db, [{ title: 'noid' }], [], 3); window.__noidOk = false; }
    catch (e) { window.__noidOk = /without an id/.test(e.message); }
  } catch (e) { window.__diffErr = String((e && e.stack) || e); }
})();
`);
await waitFor('__diffOk'); await tick(4);
ok('#125: idbPutDirtyBooks writes only the diff (put+delete, one txn)', window.__diffOk === true);
ok('#125: idbPutDirtyBooks stores raw clones (proxy-safe)', window.__cloneOk === true);
ok('#125: idbPutDirtyBooks rejects on count mismatch', window.__mismatchOk === true);
ok('#125: idbPutDirtyBooks rejects a book without an id', window.__noidOk === true);
ok('#125: idbPutDirtyBooks no unexpected error', !window.__diffErr);

// ---------- #128: differential push ----------
runInWindow(`
  var __b1 = migrateBook({ id: 'p1', title: 'P1', _mtime: 50 }); unmarkDirty(__b1);
  var __b2 = migrateBook({ id: 'p2', title: 'P2', _mtime: 150 }); unmarkDirty(__b2);
  var __sel = selectPushBatch([__b1, __b2, { id: 'p3', title: 'P3', _mtime: 0 }], 100);
  window.__selIds = __sel.batch.map(b => b.id).sort().join(',');
  window.__selCeil = __sel.sendCeil;
  window.__bootIds = selectPushBatch([__b1, __b2], 0).batch.map(b => b.id).sort().join(',');
  window.__emptyCeil = selectPushBatch([__b1], 100).sendCeil;
`);
ok('#128: selectPushBatch skips unchanged books (untracked included as fail-safe)', window.__selIds === 'p2,p3');
ok('#128: selectPushBatch sendCeil is the batch max', window.__selCeil === 150);
ok('#128: selectPushBatch bootstrap (no high-water) pushes everything', window.__bootIds === 'p1,p2');
ok('#128: selectPushBatch empty batch keeps sendCeil at high-water', window.__emptyCeil === 100);

// convergence: a book edited mid-push must not be skipped by the high-water mark
runInWindow(`
  var __c1 = migrateBook({ id: 'c1', title: 'C1', _mtime: 120 }); unmarkDirty(__c1);
  var __csel = selectPushBatch([__c1], 100);
  __c1._mtime = __csel.sendCeil + 50; // edit lands after batch selection
  window.__rescanHit = [__c1].some(b => b && (b._mtime || 0) > __csel.sendCeil);
  var __c2 = migrateBook({ id: 'c2', title: 'C2', _mtime: 110 }); unmarkDirty(__c2);
  var __csel2 = selectPushBatch([__c2], 100);
  window.__rescanMiss = [__c2].some(b => b && (b._mtime || 0) > __csel2.sendCeil);
`);
ok('#128: re-scan catches a book edited mid-push', window.__rescanHit === true);
ok('#128: re-scan stays quiet when nothing changed mid-push', window.__rescanMiss === false);

// tombstone pruning age boundary
runInWindow(`
  var __now = Date.now(), __day = 864e5;
  var __pr = pruneTombstones([
    { id: 't1', at: __now - 89 * __day },
    { id: 't2', at: __now - 91 * __day },
    { id: 't3', at: __now - 200 * __day },
    { id: 't4' },
    { id: 't5', at: __now - 10 * __day },
  ], __now);
  window.__prIds = __pr.map(t => t.id).sort().join(',');
`);
ok('#128: pruneTombstones keeps <90d, drops >90d and dateless', window.__prIds === 't1,t5');

// high-water mark round-trip (jsdom has no IDB: localStorage backend)
runInWindow(`(async () => {
  await writePushHighWater(12345);
  window.__hw = await readPushHighWater();
})();`);
await waitFor('__hw'); await tick();
ok('#128: pushHighWater write/read round-trip', window.__hw === 12345);

// ---------- #127: single-save sweep ----------
runInWindow(`
  window.__sweepSaves = 0;
  window.__origSaveLibrary = saveLibrary;
  saveLibrary = function (o) { window.__sweepSaves++; return window.__origSaveLibrary(o); };
  hcEnrichBusy = false;
  window.__origHcReady = hcReady;
  hcReady = () => true;
  window.__origHcSweep = hcSweepTargets;
  hcSweepTargets = () => [migrateBook({ id: 'e1', title: 'E1' }), migrateBook({ id: 'e2', title: 'E2' })];
  window.__origEnrich = enrichHardcover;
  enrichHardcover = async (b) => { b.hcEnriched = true; return true; };
  autoEnrichSweep().then(() => { window.__sweepDone = true; }).catch(e => { window.__sweepErr = String(e); });
`);
await waitFor('__sweepDone', 600); await tick(4);
ok('#127: autoEnrichSweep saves once for the whole sweep', window.__sweepSaves === 1);
ok('#127: autoEnrichSweep completed without errors', !window.__sweepErr);
runInWindow(`
  saveLibrary = window.__origSaveLibrary;
  hcReady = window.__origHcReady;
  hcSweepTargets = window.__origHcSweep;
  enrichHardcover = window.__origEnrich;
`);

// ---------- #125: an edit landing mid-persist must not be lost ----------
// (regression test for unmark-before-write: unmarking after completion would
// clear the newer edit's flag)
runInWindow(`
window.__race = (() => {
  const books = new Map();
  books.set('r1', { id: 'r1', title: 'Orig', _mtime: 10 });
  const db = {
    transaction(names, mode) {
      const tx = {};
      tx.objectStore = () => ({
        put(v) { books.set(v.id, JSON.parse(JSON.stringify(v))); },
        delete(id) { books.delete(id); },
        clear() { books.clear(); },
        count() { const req = {}; setTimeout(() => { req.result = books.size; req.onsuccess && req.onsuccess(); }, 0); return req; },
      });
      setTimeout(() => { tx.oncomplete && tx.oncomplete(); }, 30); // slow txn: the edit lands mid-write
      return tx;
    }
  };
  return { books, db };
})();
window.__origIdbDisabled = idbDisabled;
window.__origDb = currentDb;
window.__origKnown = knownBookIds;
idbDisabled = false;
currentDb = window.__race.db;
knownBookIds = new Set(['r1']);
library = [migrateBook({ id: 'r1', title: 'Orig', _mtime: 10 })];
unmarkDirty(library[0]);
library[0].title = 'Edit1';            // dirty; stamped on save
saveLibrary({ noCloud: true });        // write1 starts (clones 'Edit1')
setTimeout(() => {
  library[0].title = 'Edit2';          // edit lands while write1 is in flight
  saveLibrary({ noCloud: true });      // write2 queued behind write1
  storageDrain().then(() => {
    window.__raceTitle = window.__race.books.get('r1').title;
    const __plan = computePersistPlan(knownBookIds, library);
    window.__raceClean = (__plan.dirty.length === 0 && __plan.deleted.length === 0);
    window.__raceKnown = knownBookIds.has('r1');
    idbDisabled = window.__origIdbDisabled;   // restore the jsdom legacy backend
    currentDb = window.__origDb;
    knownBookIds = window.__origKnown;
    library = [];
    window.__raceDone = true;
  });
}, 5);
`);
await waitFor('__raceDone', 600); await tick(4);
ok('#125: edit during a persist is not lost (unmark-before-write)', window.__raceTitle === 'Edit2');
ok('#125: no redundant rewrite once the store is clean', window.__raceClean === true);
ok('#125: knownBookIds tracks the store after persist', window.__raceKnown === true);

console.log(`\ndata-perf: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
