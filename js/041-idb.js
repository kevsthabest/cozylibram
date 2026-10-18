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

const IDB_VERSION = 2; // v284: add binary edition asset store

function idbOpenDb(name) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(name, IDB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('editionAssets')) db.createObjectStore('editionAssets', { keyPath: 'id' });
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
   caller can fall back to the legacy backend instead of half-saving.
   v495 (#125): books are cloned via cloneForStore first — library books are
   tracking Proxies, and Proxies are not structured-cloneable (DataCloneError). */
function idbPutAllBooks(db, books) {
  const raw = books.map(cloneForStore);
  for (const b of raw) {
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
      for (const b of raw) store.put(b);
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
        if (n !== raw.length) reject(new Error('idbPutAllBooks: count mismatch (' + n + ' != ' + raw.length + ')'));
        else resolve(n);
      }, reject);
    };
    tx.onerror = () => reject(tx.error || new Error('idbPutAllBooks: transaction error'));
    tx.onabort = () => reject(tx.error || new Error('idbPutAllBooks: transaction aborted'));
  });
}

/* v495 (#125): differential write — upsert changed books + delete removed ids
   in ONE transaction, then verify the count. Same atomicity contract as
   idbPutAllBooks: the transaction either lands fully or rejects, and the
   caller keeps its dirty flags so the next save retries. expectedCount is
   computed by computePersistPlan (known - deleted + added). Books are cloned
   via cloneForStore for the same Proxy reason as above. */
function idbPutDirtyBooks(db, books, deletedIds, expectedCount) {
  const raw = books.map(cloneForStore);
  for (const b of raw) {
    if (!b || b.id == null || b.id === '') {
      return Promise.reject(new Error('idbPutDirtyBooks: refusing to write a book without an id'));
    }
  }
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('books', 'readwrite'); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore('books');
    try {
      for (const id of (deletedIds || [])) store.delete(id);
      for (const b of raw) store.put(b);
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
        if (n !== expectedCount) reject(new Error('idbPutDirtyBooks: count mismatch (' + n + ' != ' + expectedCount + ')'));
        else resolve(n);
      }, reject);
    };
    tx.onerror = () => reject(tx.error || new Error('idbPutDirtyBooks: transaction error'));
    tx.onabort = () => reject(tx.error || new Error('idbPutDirtyBooks: transaction aborted'));
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

/* v284: binary edition assets live outside the books store. Structured
   clone preserves Blob objects without base64 inflation. These helpers are
   intentionally independent of the book save path so normal cloud sync never
   serializes image bytes. */
function idbAssetPut(db, asset) {
  if (!asset || !asset.id) return Promise.reject(new Error('idbAssetPut: asset id required'));
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('editionAssets', 'readwrite'); }
    catch (e) { reject(e); return; }
    tx.objectStore('editionAssets').put(asset);
    tx.oncomplete = () => resolve(asset.id);
    tx.onerror = () => reject(tx.error || new Error('idbAssetPut failed'));
    tx.onabort = () => reject(tx.error || new Error('idbAssetPut aborted'));
  });
}
function idbAssetGet(db, id) {
  return idbRequest(db.transaction('editionAssets', 'readonly').objectStore('editionAssets').get(id));
}
function idbAssetDelete(db, id) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction('editionAssets', 'readwrite'); }
    catch (e) { reject(e); return; }
    tx.objectStore('editionAssets').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('idbAssetDelete failed'));
    tx.onabort = () => reject(tx.error || new Error('idbAssetDelete aborted'));
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
   these wrappers didn't exist yet when 040 ran.
   The start waits for DOMContentLoaded. The init's load path maps
   migrateBook, which lives in an ES module (js/020) whose window bridge
   runs only once the document has been parsed — module scripts are
   deferred, classic scripts are not. Starting the IndexedDB chain from
   this top-level call let a fast, warm IDB open reach that map before
   the bridge existed ("migrateBook is not defined"), and the session
   silently fell back to the localStorage backend. DOMContentLoaded is
   the first moment module execution is guaranteed complete.
   storageReady is still assigned synchronously as a promise, so the
   boot code that awaits it is unaffected — only the init's start moves.
   (A script executing mid-parse always sees readyState 'loading'; the
   Promise.resolve() arm covers a hypothetical late injection, where
   parsing — and therefore module execution — is long finished.) */
if (!idbDisabled) {
  const domReady = document.readyState === 'loading'
    ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();
  storageReady = domReady.then(() => storageInit());
}
