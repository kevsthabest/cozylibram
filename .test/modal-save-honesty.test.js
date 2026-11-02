// Regression pins for issue #347 (remainder): the book modal's save
// status must reflect the real outcome of the save it reports.
//
// Diagnosis (2026-11-02): the modal write path itself was exonerated
// for #346, but doCommit only learned about failures that THREW out of
// applyDetailForm. Real storage failures never throw there: the IDB
// write-through catches its own errors (logs + toasts them on the
// storage chain), and the legacy backend swallowed quota errors
// inside saveLegacyLibrary. So a save whose toast said "Couldn't
// save" still flashed "Saved" in the header, and markSaved advanced
// the form baseline, dropping the staged edits from the retry set.
// The fix makes persist failures observable (storagePersistErrorCount)
// and has doCommit verify the commit against it — synchronously on
// the legacy backend, after the write chain drains on IDB — restoring
// the pre-commit baseline on failure so the edits stay staged.
//
// This file also carries the IDB-backend arm that
// modal-sequential-edits.test.js's header deferred to the #347 work:
// the sequential two-book title edits replayed under the IDB backend,
// plus the failure-honesty sequence under both backends.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

// ---------------------------------------------------------------------------
// Fake IndexedDB — the same minimal fake as idb-storage.test.js (suites
// are standalone by convention, so it is copied, not imported).
// ---------------------------------------------------------------------------
function makeFakeIndexedDB() {
  const dbs = {};
  const fake = {
    failWrites: false,
    dropPuts: false,
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

function seedBook(window) {
  // migrateBook wraps each book in the tracked proxy — plain literals
  // would bypass the dirty traps the IDB persist plan keys off.
  window.eval(`library = [
    migrateBook({ id: 'b1', title: 'Test Book', authors: ['Author'], status: 'reading',
      progress: 40, pageCount: 200, isbn: '9781250123456', publishedDate: '2021-05-01',
      cover: '', tropes: [], publicRating: 4.2, ratingsCount: 100,
      categories: ['Fiction / Romance'], genres: [], myRating: 0, ratings: {}, axes: [],
      favorite: false, owned: 'owned', format: 'paperback', notes: 'old notes',
      description: 'A great book.', quotes: [], log: [] }),
    migrateBook({ id: 'b2', title: 'Second Book', authors: ['Author'], status: 'tbr',
      progress: 0, pageCount: 220, cover: '', tropes: [], myRating: 0, ratings: {},
      axes: [], favorite: false, owned: 'owned', notes: '', description: '',
      quotes: [], log: [] })
  ]; openDetail('b1');`);
}
const typeTitle = (window, v) => {
  const el = window.document.querySelector('#f-title');
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const st = (window) => {
  const el = window.document.querySelector('#m-savestate');
  return el ? el.textContent : '<missing>';
};

// Fake-timer plumbing for the legacy arm (same pattern as modal-autosave).
function installFakeTimers(window) {
  const realST = window.setTimeout, realCT = window.clearTimeout;
  let fakeNow = 0, fakeSeq = 1;
  const fakeTimers = new Map();
  window.setTimeout = (cb, ms, ...a) => { const id = fakeSeq++; fakeTimers.set(id, { cb, at: fakeNow + (ms || 0), a }); return id; };
  window.clearTimeout = (id) => { fakeTimers.delete(id); };
  return {
    advance(ms) {
      const target = fakeNow + ms;
      for (;;) {
        let nextId = null, nextAt = Infinity;
        fakeTimers.forEach((t, id) => { if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; } });
        if (nextId === null) break;
        const t = fakeTimers.get(nextId);
        fakeTimers.delete(nextId);
        fakeNow = Math.max(fakeNow, t.at);
        t.cb(...t.a);
      }
      fakeNow = target;
    },
    uninstall() { window.setTimeout = realST; window.clearTimeout = realCT; fakeTimers.clear(); },
  };
}

(async () => {
  // ================= Legacy backend arm =================
  {
    const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
    const window = dom.window;
    require('./harness').loadApp(window);
    const run = (code) => window.eval(code);
    ok('legacy arm: legacy backend active', run(`idbDisabled`) === true);

    const timers = installFakeTimers(window);
    seedBook(window);
    // Quota failure on the library key only, via the Storage prototype
    // (instance-level stubbing is treated as stored items — see
    // persist-quota.test.js).
    run(`
      window.__storageProto = Object.getPrototypeOf(localStorage);
      window.__realSetItem = window.__storageProto.setItem;
      window.__storageProto.setItem = function (k, v) {
        if (String(k).indexOf('spicyshelves.library') === 0) throw new Error('quota exceeded');
        return window.__realSetItem.call(this, k, v);
      };
    `);
    typeTitle(window, 'Doomed Title');
    timers.advance(700);
    ok('legacy arm: a quota-failed commit does NOT say Saved',
      st(window) !== 'Saved' && /Couldn.t save/.test(st(window)));
    ok('legacy arm: the reason is visible in the header status', /quota exceeded/.test(st(window)));
    ok('legacy arm: the modal stays open', !!window.document.querySelector('#m-back'));
    window.document.querySelector('#m-x').click();
    ok('legacy arm: close is blocked while the commit cannot land',
      !!window.document.querySelector('#m-back'));
    run(`window.__storageProto.setItem = window.__realSetItem;`);
    window.document.querySelector('#m-x').click();
    await tick(50);
    ok('legacy arm: once storage recovers, close commits and closes',
      !window.document.querySelector('#m-back') && run(`library[0].title`) === 'Doomed Title');
    ok('legacy arm: the recovered commit reached localStorage',
      run(`(JSON.parse(localStorage.getItem(libKey())) || []).some(b => b.id === 'b1' && b.title === 'Doomed Title')`) === true);
    timers.uninstall();
  }

  // ================= IDB backend arm =================
  {
    const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
    const window = dom.window;
    window.fetch = async () => { throw new Error('no network in modal-save-honesty tests'); };
    const fake = makeFakeIndexedDB();
    window.indexedDB = fake;
    require('./harness').loadApp(window);
    const run = (code) => window.eval(code);
    await run(`storageReady`);
    ok('idb arm: IDB backend active', run(`idbDisabled`) === false);

    // The deferred sequential-edits arm: two books edited in sequence
    // under IDB keep their own titles, persisted in the IDB slot.
    seedBook(window);
    typeTitle(window, 'First Retitle');
    window.document.querySelector('#m-x').click();
    await run(`storageDrain()`);
    await tick(50);
    run(`openDetail('b2');`);
    typeTitle(window, 'Second Retitle');
    window.document.querySelector('#m-x').click();
    await run(`storageDrain()`);
    await tick(50);
    const stored = fake.getAll('cozylibram.offline', 'books');
    ok('idb arm: sequential edits keep their own titles in IDB',
      stored.some(b => b.id === 'b1' && b.title === 'First Retitle') &&
      stored.some(b => b.id === 'b2' && b.title === 'Second Retitle'));

    // Failure honesty under IDB: writes fail after boot; an autosave
    // commit must flip the status to the failure once the chain drains,
    // and the book's dirty flag must survive for the retry.
    run(`openDetail('b1');`);
    fake.failWrites = true;
    typeTitle(window, 'Unlucky Retitle');
    await tick(900); // debounce (700ms, real timers) + drain
    await run(`storageDrain()`);
    await tick(50);
    ok('idb arm: a failed IDB commit does NOT leave Saved standing',
      st(window) !== 'Saved' && /Couldn.t save/.test(st(window)));
    ok('idb arm: the book stays dirty after the failed commit (retryable)',
      run(`library.find(b => b.id === 'b1') && dirtyBooks.has(library.find(b => b.id === 'b1'))`) === true);
    fake.failWrites = false;
    window.document.querySelector('#m-x').click();
    await run(`storageDrain()`);
    await tick(50);
    ok('idb arm: once writes recover, close commits the staged edit to IDB',
      !window.document.querySelector('#m-back') &&
      fake.getAll('cozylibram.offline', 'books').some(b => b.id === 'b1' && b.title === 'Unlucky Retitle'));
  }

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
