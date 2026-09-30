'use strict';

/* ---------------- IndexedDB persistence (v202) ----------------
   Promise wrapper around the raw IndexedDB API. Each on-device library
   slot (offline, or one per signed-in user) gets its own database named
   `cozylibram.<slot>` with two stores:
     books — one record per book, keyPath 'id' (1:1 with future sync rows)
     kv    — small slot state: tombstones, tombstoneFloor, upNext, and the
             legacyMigrationDone marker (see migrateSlotFromLegacy)
   Values go through structured clone: no JSON stringify, no 5MB cap.

   Callers must feature-check: `typeof indexedDB === 'undefined'` means the
   old localStorage backend stays in charge (old browsers, the jsdom test
   env). A failed open at runtime is also recoverable — js/040-storage.js
   falls back to localStorage for the session. */

const IDB_VERSION = 1; // bump when the store layout changes

function idbOpenDb(name) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(name, IDB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed for ' + name));
    req.onblocked = () => reject(new Error('indexedDB open blocked for ' + name));
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
  });
}

/* Whole-library write, atomic: clear + re-put inside ONE transaction, then
   verify the count. Rejects on mismatch (or a book without an id) so the
   caller can fall back to the legacy backend instead of half-saving. */
function idbPutAllBooks(db, books) {
  for (const b of books) {
    if (!b || b.id == null || b.id === '') {
      return Promise.reject(new Error('idbPutAllBooks: refusing to write a book without an id'));
    }
  }
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('books', 'readwrite'); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore('books');
    try {
      store.clear();
      for (const b of books) store.put(b);
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      reject(e);
      return;
    }
    tx.oncomplete = () => {
      let countReq;
      try { countReq = db.transaction('books', 'readonly').objectStore('books').count(); }
      catch (e) { reject(e); return; }
      idbRequest(countReq).then(n => {
        if (n !== books.length) reject(new Error('idbPutAllBooks: count mismatch (' + n + ' != ' + books.length + ')'));
        else resolve(n);
      }, reject);
    };
    tx.onerror = () => reject(tx.error || new Error('idbPutAllBooks: transaction error'));
    tx.onabort = () => reject(tx.error || new Error('idbPutAllBooks: transaction aborted'));
  });
}

function idbGetAllBooks(db) {
  return idbRequest(db.transaction('books', 'readonly').objectStore('books').getAll());
}

function idbCountBooks(db) {
  return idbRequest(db.transaction('books', 'readonly').objectStore('books').count());
}

function idbClearBooks(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('books', 'readwrite'); }
    catch (e) { reject(e); return; }
    tx.objectStore('books').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('idbClearBooks failed'));
    tx.onabort = () => reject(tx.error || new Error('idbClearBooks aborted'));
  });
}

function idbKvGet(db, k) {
  return idbRequest(db.transaction('kv', 'readonly').objectStore('kv').get(k))
    .then(r => (r ? r.v : undefined));
}

function idbKvPut(db, k, v) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('kv', 'readwrite'); }
    catch (e) { reject(e); return; }
    tx.objectStore('kv').put({ k: k, v: v });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('idbKvPut failed'));
    tx.onabort = () => reject(tx.error || new Error('idbKvPut aborted'));
  });
}

/* Kick off the async storage init deferred from js/040-storage.js: open the
   slot, migrate legacy data, load state. 040 couldn't start it itself —
   these wrappers didn't exist yet when 040 ran, and a microtask/macrotask
   defer would be at the mercy of script-execution timing. This top-level
   call runs synchronously right after 040, so ordering is deterministic. */
if (!idbDisabled) storageReady = storageInit();
