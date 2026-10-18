// Regression pins for issue #328: a slot switch was not failure-atomic.
// setLocalUserIdb flipped localUid before the load, loadSlotState
// published the library incrementally (books first, tombstones and
// Up Next last), and enterApp logged a failed switch and rendered +
// cloud-synced anyway — one storage fault could put the previous
// user's books under the new user's cloud id, or write the new user's
// books into the old slot's database. Now the load stages everything
// and publishes in one block, a failed switch restores the previous
// uid and rethrows, and enterApp aborts to the gate on failure.
// The fake IDB structured-clones on read/write (like the real one) so
// only genuine writes change the store, and can fail kv reads per key.
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
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));

function makeFakeIdb() {
  const dbs = new Map();
  const fake = { failGetKeys: new Set() };
  function openDb(name) {
    if (!dbs.has(name)) dbs.set(name, { books: new Map(), kv: new Map(), meta: new Map() });
    const st = dbs.get(name);
    const req = (fn) => { const r = { onsuccess: null, onerror: null }; queueMicrotask(() => { try { const v = fn(); if (r.onsuccess) { r.result = v; r.onsuccess({ target: r }); } } catch (e) { if (r.onerror) r.onerror({ target: { error: e } }); } }); return r; };
    const fail = (msg) => { const r = { onsuccess: null, onerror: null }; queueMicrotask(() => { if (r.onerror) r.onerror({ target: { error: new Error(msg) } }); }); return r; };
    const storeApi = (map, keyPath) => ({
      put: (rec) => req(() => { map.set(keyPath === 'id' ? rec.id : rec.k, clone(rec)); }),
      get: (k) => (keyPath === 'k' && fake.failGetKeys.has(k)) ? fail('injected kv read failure: ' + k) : req(() => clone(map.get(k))),
      getAll: () => req(() => [...map.values()].map(clone)),
      delete: (k) => req(() => { map.delete(k); }),
      clear: () => req(() => { map.clear(); }),
      count: () => req(() => map.size),
    });
    const db = {
      name, objectStoreNames: { contains: () => true },
      transaction: (names) => {
        const stores = {};
        for (const n of [].concat(names)) stores[n] = storeApi(st[n], n === 'books' ? 'id' : 'k');
        const tx = { oncomplete: null, onerror: null, onabort: null };
        tx.objectStore = (n) => stores[n];
        queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
        return tx;
      },
      createObjectStore: () => ({}),
    };
    return db;
  }
  fake.indexedDB = {
    open: (name) => { const db = openDb(name); const r = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null }; queueMicrotask(() => { r.result = db; if (r.onsuccess) r.onsuccess({ target: r }); }); return r; },
    deleteDatabase: () => { const r = { onsuccess: null }; queueMicrotask(() => { if (r.onsuccess) r.onsuccess({ target: r }); }); return r; },
  };
  return fake;
}

(async () => {
  const fake = makeFakeIdb();
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.indexedDB = fake.indexedDB;
  window.__fake = fake;
  loadApp(window);
  const run = (js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
  const probe = (js) => window.eval(js);
  await probe('storageReady');
  await tick();

  // ---------- S1: a load that fails midway publishes NOTHING ----------
  // The live (signed-out) slot holds one book, loaded and published.
  await probe(`(async () => {
      const db0 = await idbOpenSlot(null);
      await idbPersistSlot(null, { library: [{ id: 'a1', title: 'Offline A', authors: ['Au'], status: 'read', ratings: {}, owned: 'owned', _mtime: 5 }],
        tombstones: [], tombstoneFloor: 0, upNext: [] });
      await idbKvPut(db0, 'wishlistShelfV529', 1); await idbKvPut(db0, 'wishlistUnifiedV559', 1);
      await loadSlotState(db0);
    })()`);
  await tick(60);
  ok('setup: the signed-out library is live', JSON.stringify(probe(`library.map(b => b.id)`)) === '["a1"]');
  // Seed account B's slot, then make its tombstone read fail mid-load.
  await probe(`(async () => {
      const dbB = await idbOpenSlot('uB');
      await idbPersistSlot('uB', { library: [{ id: 'b1', title: 'B One', authors: ['Bu'], status: 'read', ratings: {}, owned: 'owned', _mtime: 9 }],
        tombstones: [{ id: 'tb', at: 1 }], tombstoneFloor: 0, upNext: ['b1'] });
      await idbKvPut(dbB, 'wishlistShelfV529', 1); await idbKvPut(dbB, 'wishlistUnifiedV559', 1);
      window.__fake.failGetKeys.add('tombstones');
      window.__switchErr = null;
      try { await setLocalUser('uB'); } catch (e) { window.__switchErr = String(e && e.message || e); }
      window.__fake.failGetKeys.clear();
    })()`);
  await tick(60);
  ok('#328 the failed switch surfaces an error', !!probe(`window.__switchErr`));
  ok('#328 the failed switch restores the previous uid (signed-out)',
    probe(`localUid`) === null);
  ok('#328 the live library is still the outgoing slot\'s, whole',
    JSON.stringify(probe(`library.map(b => b.id)`)) === '["a1"]');
  ok('#328 currentDb still names the outgoing slot',
    await probe(`idbOpenSlot(null).then(db => db === currentDb)`));
  ok('#328 the outgoing tombstones/queue are untouched',
    probe(`tombstones.length`) === 0 && probe(`upNext.length`) === 0);

  // ---------- S2: a successful switch publishes together, and the ----------
  // ---------- Up Next cleanup persists into the NEW slot ----------
  run(`window.__fake.failGetKeys.clear();`);
  await probe(`(async () => {
      const dbB = await idbOpenSlot('uB');
      await idbKvPut(dbB, 'upNext', ['b1', 'ghost']);
      await setLocalUser('uB');
      window.__bUpNextStored = await idbKvGet(await idbOpenSlot('uB'), 'upNext');
    })()`);
  await tick(60);
  ok('#328 the successful switch publishes B\'s library',
    JSON.stringify(probe(`library.map(b => b.id)`)) === '["b1"]');
  ok('#328 the cleaned queue is live (ghost id dropped)',
    JSON.stringify(probe(`upNext`)) === '["b1"]');
  ok('#328 the cleaned queue was persisted into B\'s slot, not the outgoing one',
    JSON.stringify(probe(`window.__bUpNextStored`)) === '["b1"]');
  ok('#328 B\'s tombstones published with the same switch',
    probe(`tombstones.length`) === 1 && probe(`tombstones[0].id`) === 'tb');

  // ---------- S3: enterApp aborts on a failed switch ----------
  // Back to signed-out with a good state, then fail B's load again and
  // drive the real enterApp.
  await probe(`setLocalUser(null)`);
  await tick(60);
  run(`window.__sbStub = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        auth: { getUser: async () => ({ data: { user: null } }) } };
    window.__renderCalls = 0; window.__syncCalls = 0; window.__hideCalls = 0;
    render = () => { window.__renderCalls++; };
    cloudFirstSync = async () => { window.__syncCalls++; return {}; };
    hideGate = () => { window.__hideCalls++; };
    window.__fake.failGetKeys.add('tombstones');`);
  await probe(`enterApp({ id: 'uB', user_metadata: {} }).catch(() => {})`);
  await tick(80);
  run(`window.__fake.failGetKeys.clear();`);
  ok('#328 enterApp resets the entered marker so a retry is possible',
    probe(`gateEnteredUid`) === null);
  ok('#328 enterApp never renders or syncs after a failed switch',
    probe(`window.__renderCalls`) === 0 && probe(`window.__syncCalls`) === 0 && probe(`window.__hideCalls`) === 0);
  ok('#328 the app is still on the outgoing (signed-out) state',
    probe(`localUid`) === null && JSON.stringify(probe(`library.map(b => b.id)`)) === '["a1"]');

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
