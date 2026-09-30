'use strict';
// v202 Phase 1: IndexedDB storage backend tests.
//
// JSDOM reports `indexedDB` as undefined, so this file installs a small
// in-memory fake BEFORE the app scripts load. The fake implements just
// enough of the IDB surface for js/041-idb.js: open (with onupgradeneeded),
// createObjectStore, transaction, and the request pattern the app uses.
//
// NOTE: `storageReady` is a `let` global, not a window property — it must be
// awaited via window.eval('storageReady'), never window.storageReady.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const { loadApp } = require('/home/hatch/workspace/booktok/.test/harness');

// ---------------------------------------------------------------------------
// Fake IndexedDB
// ---------------------------------------------------------------------------
function makeFakeIndexedDB() {
  const dbs = {};
  const fake = {
    failWrites: false, // put()/clear() requests fail -> tx aborts
    dropPuts: false,   // put() reports success but stores nothing (count mismatch)
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
  function req() {
    return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  }
  function succeed(r, result) {
    r.result = result;
    setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
    return r;
  }
  function failR(r, err) {
    r.error = err;
    setTimeout(() => { if (r.onerror) r.onerror({ target: r }); }, 0);
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
          clear() {
            const r = req();
            if (fake.failWrites) { tx._fail(new Error('fake write failure')); return failR(r, new Error('fake write failure')); }
            st.map.clear();
            return succeed(r, undefined);
          },
          put(v) {
            const r = req();
            if (fake.failWrites) { tx._fail(new Error('fake write failure')); return failR(r, new Error('fake write failure')); }
            if (!fake.dropPuts) st.map.set(keyOf(v), v);
            return succeed(r, keyOf(v));
          },
          get(k) { return succeed(req(), st.map.has(k) ? st.map.get(k) : undefined); },
          getAll() { return succeed(req(), Array.from(st.map.values())); },
          count() { return succeed(req(), st.map.size); },
        };
      },
      abort() { this._fail(new Error('fake: aborted')); },
      oncomplete: null, onerror: null, onabort: null,
      get error() { return this._failed; },
    };
    // Fire completion after the requests queued so far settle — mirrors IDB's
    // "complete when all requests done" closely enough for these tests.
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

// ---------------------------------------------------------------------------
// Window factory
// ---------------------------------------------------------------------------
function makeWindow(fake) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.indexedDB = fake || makeFakeIndexedDB();
  loadApp(window);
  return window;
}

const ready = window => window.eval('storageReady');
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
const book = (id, title) => ({ id, title, authors: ['Test Author'], status: 'tbr' });
const seedLegacy = window => {
  window.localStorage.setItem('spicyshelves.library.v1',
    JSON.stringify([book('m1', 'Migrated One'), book('m2', 'Migrated Two')]));
  window.localStorage.setItem('spicyshelves.tombstones.v1', JSON.stringify(['gone-1']));
  window.localStorage.setItem('spicyshelves.tombstoneFloor.v1', JSON.stringify(1700000000));
  window.localStorage.setItem('spicyshelves.upnext.v1',
    JSON.stringify([{ q: 'mystery', title: 'Want', author: 'Auth' }]));
};

// ---------------------------------------------------------------------------
// Tiny runner
// ---------------------------------------------------------------------------
const results = [];
function check(name, cond) {
  results.push({ name, pass: !!cond });
  if (process.env.VERBOSE) console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
}

(async () => {
  // --- Scenario 1: legacy localStorage migrates into IDB on first boot ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    seedLegacy(window);
    await ready(window);

    check('migration: library loaded into memory',
      window.eval('library.length') === 2);
    check('migration: books copied to the IDB slot',
      fake.getAll('cozylibram.offline', 'books').length === 2);
    check('migration: book ids survive the copy',
      fake.getAll('cozylibram.offline', 'books').every(b => b.id === 'm1' || b.id === 'm2'));
    check('migration: tombstones copied to kv',
      JSON.stringify(fake.getKv('cozylibram.offline', 'tombstones')) === JSON.stringify(['gone-1']));
    check('migration: upNext copied to kv',
      Array.isArray(fake.getKv('cozylibram.offline', 'upNext')));
    check('migration: legacy localStorage keys untouched (read-only)',
      window.localStorage.getItem('spicyshelves.library.v1') !== null &&
      window.localStorage.getItem('spicyshelves.tombstones.v1') !== null);
    const infos = window.eval(`AppLog.entries('info').map(e => e.msg).join('\\n')`);
    check('migration: copy is logged', /migrated 2 books/.test(infos));
  }

  // --- Scenario 2: failed copy verification falls back to localStorage ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    fake.dropPuts = true; // puts "succeed" but nothing lands -> count mismatch
    window.localStorage.setItem('spicyshelves.library.v1',
      JSON.stringify([book('m1', 'A'), book('m2', 'B')]));
    await ready(window);

    check('mismatch: falls back to the legacy backend',
      window.eval('idbDisabled') === true);
    check('mismatch: library still loads from localStorage',
      window.eval('library.length') === 2);
    const errs = window.eval(`AppLog.entries('error').map(e => e.msg).join('\\n')`);
    check('mismatch: fallback is logged', /IndexedDB init failed/.test(errs));
  }

  // --- Scenario 3: saveLibrary / saveTombstones write through to IDB ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    await ready(window);
    check('round-trip: IDB backend active', window.eval('idbDisabled') === false);

    window.eval(`
      library.push(${JSON.stringify(book('r1', 'Round Trip'))});
      saveLibrary({ noCloud: true });
      tombstones.push('gone-9');
      saveTombstones();
      tombstoneFloor = 1700000001;
      saveTombFloor();
    `);
    await window.eval('storageDrain()');
    await tick();

    const books = fake.getAll('cozylibram.offline', 'books');
    check('round-trip: saveLibrary wrote through to IDB',
      books.length === 1 && books[0].id === 'r1' && books[0].title === 'Round Trip');
    check('round-trip: tombstones wrote through to kv',
      JSON.stringify(fake.getKv('cozylibram.offline', 'tombstones')) === JSON.stringify(['gone-9']));
    check('round-trip: tombstoneFloor wrote through to kv',
      fake.getKv('cozylibram.offline', 'tombFloor') === 1700000001);
  }

  // --- Scenario 4: a failed IDB write is logged, never swallowed ---
  // failWrites is enabled AFTER init: a boot-time write failure correctly
  // falls back to the legacy backend, but here we test the runtime path —
  // the "disk full / quota exceeded" case mid-session.
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    await ready(window);
    check('write-failure setup: IDB backend active', window.eval('idbDisabled') === false);
    fake.failWrites = true;
    window.eval(`library.push(${JSON.stringify(book('f1', 'Doomed'))}); saveLibrary({ noCloud: true });`);
    await window.eval('storageDrain()');
    await tick();

    const errs = window.eval(`AppLog.entries('error').map(e => e.msg).join('\\n')`);
    check('write failure is logged via AppLog (not swallowed)',
      /library write failed/.test(errs));
  }

  // --- Scenario 5: sign-in adopts the offline slot into a per-user database ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    seedLegacy(window); // legacy key present: adoption must not delete it
    await ready(window);
    window.eval(`library.push(${JSON.stringify(book('a1', 'Adopt Me'))}); saveLibrary({ noCloud: true });`);
    await window.eval('storageDrain()');

    await window.eval(`setLocalUser('user-9')`);

    check('adoption: offline books moved to the new user slot',
      fake.getAll('cozylibram.user-9', 'books').length === 3);
    check('adoption: in-memory library follows the switch',
      window.eval(`library.length === 3 && localUid === 'user-9'`));
    check('adoption: source slot cleared (moved, not copied)',
      fake.getAll('cozylibram.offline', 'books').length === 0);
    check('adoption: legacy localStorage keys kept (read-only grace period)',
      window.localStorage.getItem('spicyshelves.library.v1') !== null);
  }

  // --- Scenario 6: sign-out hands the library back to the offline slot ---
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    await ready(window);
    window.eval(`library.push(${JSON.stringify(book('h1', 'Hand Back'))}); saveLibrary({ noCloud: true });`);
    await window.eval('storageDrain()');
    await window.eval(`setLocalUser('user-9')`);
    await window.eval(`setLocalUser(null)`); // sign out

    check('hand-back: books return to the offline slot',
      fake.getAll('cozylibram.offline', 'books').some(b => b.id === 'h1'));
    check('hand-back: per-user slot keeps its copy',
      fake.getAll('cozylibram.user-9', 'books').some(b => b.id === 'h1'));
    check('hand-back: offline slot is marked unowned',
      window.localStorage.getItem('spicyshelves.localuser.owner.v1') === null);
  }

  // --- Scenario 7: reload boots from IDB, not localStorage ---
  {
    const fake = makeFakeIndexedDB();
    const w1 = makeWindow(fake);
    await ready(w1);
    w1.eval(`library.push(${JSON.stringify(book('p1', 'Persisted'))}); saveLibrary({ noCloud: true });`);
    await w1.eval('storageDrain()');
    await tick();

    const w2 = makeWindow(fake); // same device: same fake IDB, fresh memory
    await ready(w2);
    check('reboot: library loads from IDB',
      w2.eval(`library.length === 1 && library[0].id === 'p1' && library[0].title === 'Persisted'`));
    check('reboot: localStorage library not consulted',
      w2.localStorage.getItem('spicyshelves.library.v1') === null);
  }

  // --- Scenario 8: the migration marker survives slot clearing ------------
  // Adoption clears the offline IDB slot; without the per-slot marker the
  // next sign-out would re-import the read-only legacy key, skip the v136
  // hand-back branch, and leak one user's books to the next sign-in.
  {
    const window = makeWindow();
    const fake = window.indexedDB;
    seedLegacy(window);
    await ready(window);
    await window.eval(`setLocalUser('user-9')`); // adoption: offline -> user-9
    await window.eval(`setLocalUser(null)`);     // sign out: hand-back

    check('marker: offline slot not re-imported from legacy on sign-out',
      fake.getAll('cozylibram.offline', 'books').length === 2);
    check('marker: hand-back branch ran (owner recorded)',
      window.localStorage.getItem('spicyshelves.offline.owner') === 'user-9');
    const migLogs = window.eval(`AppLog.entries('info').map(e => e.msg).join('\\n')`);
    check('marker: legacy migration ran exactly once',
      (migLogs.match(/migrated 2 books/g) || []).length === 1);

    await window.eval(`setLocalUser('user-X')`); // different user: must not adopt
    check('marker: different user does not adopt the hand-back',
      window.eval(`library.length`) === 0 &&
      fake.getAll('cozylibram.user-X', 'books').length === 0);
    check('marker: legacy keys still untouched',
      window.localStorage.getItem('spicyshelves.library.v1') !== null);
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\nidb-storage: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log('  - ' + f.name);
    process.exit(1);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
