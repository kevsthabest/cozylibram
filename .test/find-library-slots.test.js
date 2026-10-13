'use strict';
// v517 (#131): "Find my library" recovery must see the IndexedDB slots.
//
// Before the fix, libraryPartitions()/restorePartition() only read the
// legacy localStorage keys, so on any device whose library had migrated
// to an IndexedDB slot (v202+) Settings claimed "No saved libraries found
// on this device" while the books sat in `cozylibram.<uid|offline>`.
//
// Covered:
//  1. Slot enumeration via indexedDB.databases(): a cozylibram.<uid> slot
//     is listed with its real book count; the open slot is flagged current.
//  2. A slot supersedes its legacy localStorage twin (same library).
//  3. Legacy-only partitions (never became slots) still enumerate.
//  4. Restore from a slot returns its books, persists them into the open
//     slot, and untombstones their ids — the sync push deletes every id
//     in tombstonedIds(), so a restore that stayed tombstoned would be
//     re-deleted by the next push (the level sync tests model this at).
//  5. Legacy restore also untombstones.
//  6. databases() unavailable (older Firefox): no crash — the list
//     degrades to the legacy partitions plus the currently open slot.
//  7. Empty device: no partitions at all (the state behind Settings'
//     "No saved libraries found on this device." copy).

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const { loadApp } = require('./harness');

// ---------------------------------------------------------------------------
// Fake IndexedDB — modelled on .test/idb-storage.test.js, plus databases()
// and store.delete() (the differential persist needs it after a restore).
// ---------------------------------------------------------------------------
function makeFakeIndexedDB() {
  const dbs = {};
  const fake = {
    _dbs: dbs,
    getAll(name, store) {
      const s = dbs[name] && dbs[name].stores[store];
      return s ? Array.from(s.map.values()) : [];
    },
    databases() {
      return Promise.resolve(Object.keys(dbs).map(name => ({ name, version: 2 })));
    },
  };
  function req() {
    return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  }
  function succeed(r, result) {
    r.result = result;
    setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
    return r;
  }
  function makeTx(db) {
    const tx = {
      _failed: null,
      _fail(e) { if (!this._failed) this._failed = e; },
      objectStore(name) {
        const st = db.stores[name];
        if (!st) throw new Error('fake: no such store ' + name);
        const keyOf = v => (st.keyPath === 'id' ? v.id : v.k);
        return {
          clear() { st.map.clear(); return succeed(req(), undefined); },
          put(v) { st.map.set(keyOf(v), v); return succeed(req(), keyOf(v)); },
          delete(k) { st.map.delete(k); return succeed(req(), undefined); },
          get(k) { return succeed(req(), st.map.has(k) ? st.map.get(k) : undefined); },
          getAll() { return succeed(req(), Array.from(st.map.values())); },
          count() { return succeed(req(), st.map.size); },
        };
      },
      abort() { this._fail(new Error('fake: aborted')); },
      oncomplete: null, onerror: null, onabort: null,
      get error() { return this._failed; },
    };
    setTimeout(() => {
      if (tx._failed) {
        if (tx.onabort) tx.onabort({ target: tx });
        if (tx.onerror) tx.onerror({ target: tx });
      } else if (tx.oncomplete) tx.oncomplete({ target: tx });
    }, 0);
    return tx;
  }
  function makeDb(db) {
    return {
      get objectStoreNames() { return { contains: n => !!db.stores[n] }; },
      createObjectStore(name, opts) {
        db.stores[name] = { map: new Map(), keyPath: opts && opts.keyPath };
        return {};
      },
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

function makeWindow(fake) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.indexedDB = fake || makeFakeIndexedDB();
  loadApp(window);
  return window;
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}
const book = (id, title) => ({ id, title: title || ('Book ' + id), authors: ['A'], status: 'tbr' });
const ready = w => w.eval('storageReady');
const drain = w => w.eval('storageDrain()');

(async () => {
  // --- Scenarios 1–5: slots enumerate, supersede legacy, restore cleanly ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    const run = code => window.eval(code);
    await ready(window);
    ok('setup: IDB backend active', run('idbDisabled') === false);

    // The open (offline) slot holds 2 books, saved through the app itself.
    run('library = ' + JSON.stringify([book('c1'), book('c2')]) + '; saveLibrary({noCloud:true});');
    await drain(window);
    ok('setup: open slot persisted', fake.getAll('cozylibram.offline', 'books').length === 2);

    // Another sign-in's slot: 4 books, written straight into its database.
    await run("idbOpenSlot('user-9').then(db => idbPutAllBooks(db, " +
      JSON.stringify([book('s1'), book('s2'), book('s3'), book('s4')]) + '))');
    // Its stale legacy twin (3 books) must be superseded by the slot.
    window.localStorage.setItem('spicyshelves.library.v2.user-9',
      JSON.stringify([book('old1'), book('old2'), book('old3')]));
    // A legacy-only partition that never became a slot.
    window.localStorage.setItem('spicyshelves.library.v2.legacy-user',
      JSON.stringify([book('l1'), book('l2')]));

    const parts = await run('libraryPartitions()');
    const byKey = {};
    parts.forEach(p => { byKey[p.key] = p; });
    ok('slots: user slot listed with its real book count',
      !!byKey['cozylibram.user-9'] && byKey['cozylibram.user-9'].n === 4);
    ok('slots: open slot listed with its book count',
      !!byKey['cozylibram.offline'] && byKey['cozylibram.offline'].n === 2);
    ok('slots: open slot flagged current, the other not',
      byKey['cozylibram.offline'].current === true && byKey['cozylibram.user-9'].current === false);
    ok('slots: exactly one current partition', parts.filter(p => p.current).length === 1);
    ok('slots: legacy twin superseded (not listed twice)',
      !('spicyshelves.library.v2.user-9' in byKey) && parts.length === 3);
    ok('legacy: slot-less legacy partition still listed',
      !!byKey['spicyshelves.library.v2.legacy-user'] && byKey['spicyshelves.library.v2.legacy-user'].n === 2);
    ok('labels: offline slot', run("partitionLabel({key:'cozylibram.offline'})") === 'Offline shelf (signed out)');
    ok('labels: another sign-in slot', run("partitionLabel({key:'cozylibram.user-9'})") === 'Another sign-in on this device');

    // Tombstone one of the stranded slot's books, plus a control id.
    run("tombstones.push({id:'s2', at: Date.now()}, {id:'zz-control', at: Date.now()}); saveTombstones();");
    await drain(window);
    ok('setup: s2 tombstoned before restore', run("tombstonedIds().has('s2')") === true);

    const n = await run("restorePartition('cozylibram.user-9')");
    ok('slot restore: returns the book count', n === 4);
    ok('slot restore: library holds the slot books',
      run('library.length') === 4 && run("library.every(b => ['s1','s2','s3','s4'].includes(b.id))") === true);
    ok('slot restore: restored ids untombstoned (next push cannot re-delete them)',
      run("tombstonedIds().has('s2')") === false);
    ok('slot restore: unrelated tombstones untouched',
      run("tombstonedIds().has('zz-control')") === true);
    await drain(window);
    ok('slot restore: books persisted into the open slot',
      fake.getAll('cozylibram.offline', 'books').length === 4 &&
      fake.getAll('cozylibram.offline', 'books').every(b => ['s1', 's2', 's3', 's4'].includes(b.id)));

    // Legacy restore: same untombstone contract.
    run("tombstones.push({id:'l1', at: Date.now()}); saveTombstones();");
    const ln = await run("restorePartition('spicyshelves.library.v2.legacy-user')");
    ok('legacy restore: returns the book count', ln === 2);
    ok('legacy restore: library holds the legacy books', run('library.length') === 2);
    ok('legacy restore: restored ids untombstoned', run("tombstonedIds().has('l1')") === false);
    ok('restore: unknown slot returns 0', (await run("restorePartition('cozylibram.no-such-user')")) === 0);
  }

  // --- Scenario 6: databases() unavailable — degrade, don't go blind ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    const run = code => window.eval(code);
    await ready(window);
    run('library = ' + JSON.stringify([book('c1')]) + '; saveLibrary({noCloud:true});');
    await drain(window);
    window.localStorage.setItem('spicyshelves.library.v2.legacy-user',
      JSON.stringify([book('l1'), book('l2')]));
    fake.databases = undefined; // older Firefox: no database listing
    const parts = await run('libraryPartitions()');
    const byKey = {};
    parts.forEach(p => { byKey[p.key] = p; });
    ok('no databases(): legacy partitions still listed',
      !!byKey['spicyshelves.library.v2.legacy-user'] && byKey['spicyshelves.library.v2.legacy-user'].n === 2);
    ok('no databases(): the open slot is still vouched for',
      !!byKey['cozylibram.offline'] && byKey['cozylibram.offline'].n === 1 &&
      byKey['cozylibram.offline'].current === true);
  }

  // --- Scenario 7: empty device — nothing to find ---
  {
    const window = makeWindow();
    const run = code => window.eval(code);
    await ready(window);
    const parts = await run('libraryPartitions()');
    ok('empty device: no partitions (Settings shows "none found")',
      Array.isArray(parts) && parts.length === 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
