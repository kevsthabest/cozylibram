// Regression pins for the IndexedDB load path's transform and restore
// integrity:
//
//   #330 — loadSlotState's one-time wishlist transforms persisted
//     through persistBooks(), which targets the ambient currentDb —
//     during an account switch that is still the OUTGOING slot. The
//     transform's write landed in the wrong database (or was rejected
//     by its count check with a spurious "Couldn't save" error), and
//     the incoming slot silently kept its pre-transform rows.
//   #331 (IDB flavor) — the transforms' done-flags were written BEFORE
//     the transformed data was durable, so one failed persist lost
//     the migration for that slot while the flag claimed it ran.
//   #337 — migrateSlotFromLegacy did not carry the legacy backend's
//     wishlist-transform flags into the slot kv, so both transforms
//     ran a second time on a partition's first IDB load.
//   #332 — restorePartition displaced books without tombstoning them,
//     so the next sync merge resurrected them from the cloud.
//
// The fake IndexedDB follows .test/idb-storage.test.js (plus a store
// delete), installed before the app scripts load. One fidelity fix
// over that pattern: values are cloned on put and on read, as real
// IndexedDB structured-clones in both directions — without it the
// "store" aliases the app's live objects and a load-time mutation
// would masquerade as a write that never happened.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const { loadApp } = require(path.join(APP_DIR, '.test', 'harness'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// --- Fake IndexedDB (idb-storage pattern) ---
function makeFakeIndexedDB() {
  const dbs = {};
  const fake = {
    failWrites: false,
    _dbs: dbs,
    getAll(name, store) {
      const s = dbs[name] && dbs[name].stores[store];
      return s ? Array.from(s.map.values()) : [];
    },
    getKv(name, key) {
      const s = dbs[name] && dbs[name].stores.kv;
      const row = s && s.map.get(key);
      return row ? row.v : undefined;
    },
  };
  function req() { return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null }; }
  function succeed(r, result) { r.result = result; setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
  function failR(r, err) { r.error = err; setTimeout(() => { if (r.onerror) r.onerror({ target: r }); }, 0); return r; }
  function makeTx(db) {
    const tx = {
      _failed: null,
      _fail(e) { if (!this._failed) this._failed = e; },
      objectStore(name) {
        const st = db.stores[name];
        if (!st) throw new Error('fake: no such store ' + name);
        const keyOf = v => (st.keyPath === 'id' ? v.id : v.k);
        return {
          clear() { const r = req(); if (fake.failWrites) { tx._fail(new Error('fake write failure')); return failR(r, new Error('fake write failure')); } st.map.clear(); return succeed(r, undefined); },
          put(v) { const r = req(); if (fake.failWrites) { tx._fail(new Error('fake write failure')); return failR(r, new Error('fake write failure')); } st.map.set(keyOf(v), JSON.parse(JSON.stringify(v))); return succeed(r, keyOf(v)); },
          delete(k) { const r = req(); if (fake.failWrites) { tx._fail(new Error('fake write failure')); return failR(r, new Error('fake write failure')); } st.map.delete(k); return succeed(r, undefined); },
          get(k) { return succeed(req(), st.map.has(k) ? JSON.parse(JSON.stringify(st.map.get(k))) : undefined); },
          getAll() { return succeed(req(), Array.from(st.map.values()).map(v => JSON.parse(JSON.stringify(v)))); },
          count() { return succeed(req(), st.map.size); },
        };
      },
      abort() { this._fail(new Error('fake: aborted')); },
      oncomplete: null, onerror: null, onabort: null,
      get error() { return this._failed; },
    };
    setTimeout(() => {
      if (tx._failed) { if (tx.onabort) tx.onabort({ target: tx }); if (tx.onerror) tx.onerror({ target: tx }); }
      else if (tx.oncomplete) tx.oncomplete({ target: tx });
    }, 0);
    return tx;
  }
  function makeDb(db) {
    return {
      get objectStoreNames() { return { contains: n => !!db.stores[n] }; },
      createObjectStore(name, opts) { db.stores[name] = { map: new Map(), keyPath: opts && opts.keyPath }; return {}; },
      transaction() { return makeTx(db); },
    };
  }
  fake.open = (name, version) => {
    const r = req();
    setTimeout(() => {
      let db = dbs[name];
      const isNew = !db;
      if (isNew) { db = { name, stores: {} }; dbs[name] = db; }
      r.result = makeDb(db);
      if (isNew && r.onupgradeneeded) r.onupgradeneeded({ target: r });
      if (r.onsuccess) r.onsuccess({ target: r });
    }, 0);
    return r;
  };
  return fake;
}

function makeWindow() {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const w = dom.window;
  w.fetch = async () => { throw new Error('no network in tests'); };
  w.indexedDB = makeFakeIndexedDB();
  loadApp(w);
  return w;
}
const book = (id, extra) => Object.assign({ id, title: 'T-' + id, authors: ['A'], status: 'tbr' }, extra || {});
const storeBook = (w, slot, id) => w.indexedDB.getAll('cozylibram.' + slot, 'books').find(b => b.id === id);

(async () => {
  // ---------- A1: #330 + #331 happy path — switch-time transform lands in the incoming slot ----------
  {
    const w = makeWindow();
    w.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([book('o1'), book('o2')]));
    await w.eval('storageReady'); await tick();
    await w.eval(`idbPersistSlot('uB', { library: [
      { id: 'b1', title: 'B One', authors: ['A'], status: 'read', owned: 'tobuy' },
      { id: 'b2', title: 'B Two', authors: ['A'], status: 'tbr' },
    ], tombstones: [], tombstoneFloor: 0, upNext: [] })`);
    await w.eval(`setLocalUser('uB')`);
    await w.eval('storageDrain()'); await tick();
    ok('#330 the transformed book is durable in the INCOMING slot',
      (storeBook(w, 'uB', 'b1') || {}).owned === 'owned');
    ok('#330 nothing from B leaked into the outgoing (offline) slot',
      !storeBook(w, 'offline', 'b1') && w.indexedDB.getAll('cozylibram.offline', 'books').length === 2);
    ok('#331 the done-flag is set once the data is durable',
      w.indexedDB.getKv('cozylibram.uB', 'wishlistShelfV529') === 1);
  }

  // ---------- A2: #331 — a failed transform write leaves the flag unset and retries ----------
  {
    const w = makeWindow();
    await w.eval('storageReady'); await tick();
    await w.eval(`idbPersistSlot('uB', { library: [
      { id: 'b1', title: 'B One', authors: ['A'], status: 'read', owned: 'tobuy' },
    ], tombstones: [], tombstoneFloor: 0, upNext: [] })`);
    w.indexedDB.failWrites = true;
    await w.eval(`setLocalUser('uB').catch(() => {})`);
    await w.eval('storageDrain()').catch(() => {}); await tick();
    ok('#331 flag NOT set when the transform write failed',
      w.indexedDB.getKv('cozylibram.uB', 'wishlistShelfV529') === undefined);
    ok('#331 the slot store still holds the pre-transform row',
      (storeBook(w, 'uB', 'b1') || {}).owned === 'tobuy');
    w.indexedDB.failWrites = false;
    await w.eval(`setLocalUser(null)`); await w.eval('storageDrain()'); await tick();
    await w.eval(`setLocalUser('uB')`); await w.eval('storageDrain()'); await tick();
    ok('#331 the retry lands the transform and then the flag',
      (storeBook(w, 'uB', 'b1') || {}).owned === 'owned' &&
      w.indexedDB.getKv('cozylibram.uB', 'wishlistShelfV529') === 1);
  }

  // ---------- A3: #337 — legacy migration carries the transform flags ----------
  {
    const w = makeWindow();
    w.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([
      { id: 'r1', title: 'R One', authors: ['A'], status: 'read', owned: 'tobuy' },
    ]));
    w.localStorage.setItem('spicyshelves.library.v1.wishlist529', '1');
    w.localStorage.setItem('spicyshelves.library.v1.wishlist559', '1');
    await w.eval('storageReady'); await tick();
    ok('#337 the v529 flag is carried into the slot kv',
      w.indexedDB.getKv('cozylibram.offline', 'wishlistShelfV529') === 1);
    ok('#337 the v559 flag is carried into the slot kv',
      w.indexedDB.getKv('cozylibram.offline', 'wishlistUnifiedV559') === 1);
    ok('#337 the transform does NOT re-run: the legitimate tobuy facet survives',
      (storeBook(w, 'offline', 'r1') || {}).owned === 'tobuy');
  }

  // ---------- A4: #332 — restore tombstones the displaced books ----------
  {
    const w = makeWindow();
    w.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([book('keep1'), book('disp1')]));
    await w.eval('storageReady'); await tick();
    await w.eval(`idbPersistSlot('uR', { library: [
      { id: 'keep1', title: 'Kept', authors: ['A'], status: 'tbr' },
      { id: 'rest1', title: 'Restored', authors: ['A'], status: 'tbr' },
    ], tombstones: [], tombstoneFloor: 0, upNext: [] })`);
    await w.eval(`restorePartition('cozylibram.uR')`);
    await w.eval('storageDrain()'); await tick();
    ok('#332 the displaced book is tombstoned (sync cannot resurrect it)',
      w.eval(`tombstones.some(t => t.id === 'disp1')`) === true);
    ok('#332 the displaced book is gone from the local store',
      !storeBook(w, 'offline', 'disp1'));
    ok('#332 the restored set is what the store and the plan now hold',
      w.eval(`JSON.stringify([...knownBookIds].sort())`) === '["keep1","rest1"]' &&
      !!storeBook(w, 'offline', 'rest1'));
  }

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
