'use strict';

/* ---------------- storage (v202) ---------------- */
// On-device libraries are partitioned by signed-in user so several people can
// share one device without mixing shelves. `localUid` is null when signed out
// (classic single-device library under LS_KEY).
//
// v202: the persistence backend is IndexedDB — one database per slot named
// `cozylibram.<uid|offline>` (see js/041-idb.js) — which has no 5MB cap. The
// working model is unchanged: the library lives in the in-memory `library`
// array, call sites stay synchronous, and saves are async write-through.
// When indexedDB is missing (old browsers, the jsdom test env) or the IDB
// open fails at runtime, the v201 localStorage backend stays in charge for
// the session (`idbDisabled`); legacy keys are otherwise read-only.
let localUid = null;
let idbDisabled = (typeof indexedDB === 'undefined');
let currentDb = null; // IDBDatabase for the active slot (IDB backend only)
const slotDbs = {};   // slot db name -> IDBDatabase
const IDB_SLOT_PREFIX = 'cozylibram.'; // one database per slot: cozylibram.<uid|offline>

let library = [];
let tombstones = [];
let tombstoneFloor = 0;
let upNext = [];

/* ---------------- dirty-flag change tracking (v495, #125) ----------------
   Books are wrapped in a Proxy by trackBook(), hooked into migrateBook() (the
   choke point every book entering the library passes through) plus addBook()
   for the one path that skips migrateBook. Any set/deleteProperty — including
   nested mutations like b.log.push() or b.characters[0].name, via deep
   wrapping — marks the ROOT book dirty in the `dirtyBooks` WeakSet.
   saveLibrary() then persists only dirty books (+ deletes) instead of
   re-stringifying the whole library on every save (~190ms + ~12.6MB of
   snapshot strings per save at 500 character-rich books, measured).

   Bookkeeping lives in WeakSets/WeakMaps, never on the book objects: the
   _ccWarnEnriched incident proved stray props leak into sync payloads.

   Why a Proxy instead of explicit touchBook() at mutation sites: 65
   saveLibrary() call sites across 27 files mutate books via direct property
   sets — an explicit-marking audit would be a sprawling diff where any miss
   is silent data loss. The Proxy is exact and centralized.

   Two safety invariants make this fail-safe rather than fail-silent:
   1. Untracked books (never wrapped — shouldn't happen in production, but
      tests push raw objects) are treated as dirty everywhere: redundant
      persist/push beats dropped data.
   2. mergeCloudBooks UNMARKS after assigning the newer remote record: the
      set-traps fire on every assigned value, but merged content already lives
      in the cloud — dirtying here would bump _mtime and re-push on every
      cross-device merge, an _mtime ping-pong that never converges.
   3. A merged book still differs from the LOCAL store, so the merge also
      marks it in the second set below, `persistOnlyBooks`: "write me to
      the local store, but I am not a local edit — never stamp my _mtime,
      never push me on that account." One flag cannot serve both gates:
      when dirty alone decided the persist plan, merged updates were
      skipped by the plan and a restart silently reverted the book to
      its pre-merge copy (#334). */
const dirtyBooks = new WeakSet();    // root book proxies with unpersisted local edits
const persistOnlyBooks = new WeakSet(); // merged-in content the local store lacks
const proxyRootOf = new WeakMap();   // any tracked proxy -> root book proxy
const proxyTargetOf = new WeakMap(); // tracked proxy -> raw target
let knownBookIds = new Set();        // book ids currently in the IDB books store

function markDirty(b) {
  if (!b || typeof b !== 'object') return;
  dirtyBooks.add(proxyRootOf.get(b) || b);
}
function unmarkDirty(b) {
  if (!b || typeof b !== 'object') return;
  dirtyBooks.delete(proxyRootOf.get(b) || b);
}
function markPersistOnly(b) {
  if (!b || typeof b !== 'object') return;
  persistOnlyBooks.add(proxyRootOf.get(b) || b);
}
function unmarkPersistOnly(b) {
  if (!b || typeof b !== 'object') return;
  persistOnlyBooks.delete(proxyRootOf.get(b) || b);
}

// Re-point a tracked proxy and all its tracked descendants at a new root.
// Runs when a tracked value is assigned into a different book (merge and
// re-import assigns): nested mutations must dirty the CONTAINING book.
function rerootSubtree(p, newRoot) {
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (proxyRootOf.has(x)) proxyRootOf.set(x, newRoot);
    const t = proxyTargetOf.get(x) || x;
    if (Array.isArray(t)) { for (let i = 0; i < t.length; i++) walk(t[i]); }
    else {
      const proto = Object.getPrototypeOf(t);
      if (proto === Object.prototype || proto === null) {
        const ks = Object.keys(t);
        for (let i = 0; i < ks.length; i++) walk(t[ks[i]]);
      }
    }
  };
  walk(p);
}

function makeProxy(value, root, created) {
  // root: the root book proxy (non-null except during initial construction,
  // when trackBook fixes up the placeholder below).
  if (!value || typeof value !== 'object') return value;
  if (proxyRootOf.has(value)) return value; // already tracked (re-rooted by the set trap if it moved books)
  const p = new Proxy(value, {
    set(t, k, v, recv) {
      const old = t[k];
      // Resolve the CURRENT root dynamically: a nested proxy may have been
      // re-rooted into a different book since its traps were created.
      const myRoot = proxyRootOf.get(p) || p;
      let wv = v;
      if (v && typeof v === 'object') {
        if (proxyRootOf.has(v)) {
          if (proxyRootOf.get(v) !== myRoot) rerootSubtree(v, myRoot);
        } else {
          wv = makeProxy(v, myRoot, null);
        }
      }
      const ok = Reflect.set(t, k, wv);
      if (old !== wv) dirtyBooks.add(myRoot);
      return ok;
    },
    deleteProperty(t, k) {
      const had = Object.prototype.hasOwnProperty.call(t, k);
      const ok = Reflect.deleteProperty(t, k);
      if (had) dirtyBooks.add(proxyRootOf.get(p) || p);
      return ok;
    }
  });
  proxyRootOf.set(p, root || p);
  proxyTargetOf.set(p, value);
  if (created) created.push(p);
  // Deep-wrap existing children via RAW sets on the target (traps not active yet).
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const w = makeProxy(value[i], root || p, created);
      if (w !== value[i]) value[i] = w;
    }
  } else {
    const ks = Object.keys(value);
    for (let i = 0; i < ks.length; i++) {
      const w = makeProxy(value[ks[i]], root || p, created);
      if (w !== value[ks[i]]) value[ks[i]] = w;
    }
  }
  return p;
}

// Wrap a book (and its whole subtree) for dirty tracking. Idempotent.
// Newly wrapped books are marked dirty: anything entering the library must be
// persisted. Bulk-load paths (loadSlotState, loadLegacyLibrary) unmark right
// after, since that content is already in the store.
function trackBook(b) {
  if (!b || typeof b !== 'object' || proxyRootOf.has(b)) return b;
  const created = [];
  const p = makeProxy(b, null, created);
  for (const cp of created) proxyRootOf.set(cp, p);
  dirtyBooks.add(p);
  return p;
}

// Deep-clone a (possibly tracked) book into a raw object for IndexedDB.
// Proxies are NOT structured-cloneable (DataCloneError in every engine), so
// the proxy tree must be stripped — into a FRESH object, never in place
// (an in-place unwrap would destroy dirty tracking on the live book).
function cloneForStore(b) {
  const seen = new Map();
  const walk = (x) => {
    if (x === null || x === undefined || typeof x !== 'object') return x;
    const t = proxyTargetOf.get(x) || x;
    if (seen.has(t)) return seen.get(t);
    if (t instanceof Date) return new Date(t.getTime());
    let out;
    if (Array.isArray(t)) {
      out = []; seen.set(t, out);
      for (let i = 0; i < t.length; i++) out[i] = walk(t[i]);
      return out;
    }
    const proto = Object.getPrototypeOf(t);
    if (proto !== Object.prototype && proto !== null) return t; // class instances: pass through for structured clone
    out = {}; seen.set(t, out);
    const ks = Object.keys(t);
    for (let i = 0; i < ks.length; i++) out[ks[i]] = walk(t[ks[i]]);
    return out;
  };
  return walk(b);
}

// _mtime stamping for sync conflict resolution: only dirty books advance.
// (Untracked books keep whatever _mtime they have; the persist/push paths
// treat untracked as dirty via the fail-safe in computePersistPlan/selectPushBatch.)
function stampMtimes() {
  const now = Date.now();
  for (const b of library) {
    if (dirtyBooks.has(b)) b._mtime = now;
  }
}

// Pure diff for the differential persist: which books to upsert, which ids to
// delete, and the expected post-write store count (for the atomicity check).
// A book is written when it's dirty, persist-only (merged content the store
// doesn't have yet), untracked (fail-safe), or unknown to the store (new).
// Everything else is computed from id sets, so wholesale
// replaces (settings clear, partition restore) need no special-casing.
function computePersistPlan(knownIds, books) {
  const ids = new Set();
  const dirty = [];
  for (const b of books) {
    if (!b || b.id == null || b.id === '') continue;
    ids.add(b.id);
    if (dirtyBooks.has(b) || persistOnlyBooks.has(b) || !proxyRootOf.has(b) || !knownIds.has(b.id)) dirty.push(b);
  }
  const deleted = [];
  knownIds.forEach(id => { if (!ids.has(id)) deleted.push(id); });
  const seenNew = new Set(knownIds);
  let added = 0;
  for (const b of dirty) if (!seenNew.has(b.id)) { seenNew.add(b.id); added++; }
  return { dirty: dirty, deleted: deleted, ids: ids, expectedCount: knownIds.size - deleted.length + added };
}

/* ---------------- legacy localStorage backend (v201) ----------------
   Read-only in v202 except when the IDB backend is disabled, in which case
   these are the live read/write path exactly as before. `loadLegacyUpNext`
   keeps its v74 cleanup write; the IDB migration uses `readLegacyUpNext`
   (no write) instead. */
function libKey() {
  return localUid ? 'spicyshelves.library.v2.' + localUid : LS_KEY;
}
function loadLegacyLibrary() {
  try { return (JSON.parse(localStorage.getItem(libKey())) || []).map(migrateBook); }
  catch (e) { return []; }
}
function saveLegacyLibrary() {
  try { localStorage.setItem(libKey(), JSON.stringify(library)); }
  catch (e) { toast('Storage full — export a backup!'); }
}
// NOTE: library loads in storageInit/loadLegacyAll (not at the top of the
// file) because migrateBook can reach RATING_AXES/autoDetectAxes — both must
// be initialized first.

// Deletion tombstones: deleting a book records { id, at } so the deletion
// propagates through sync instead of the book resurrecting from another
// device's push. Partitioned per user exactly like the library.
function tombKey() {
  return localUid ? 'spicyshelves.tombstones.v2.' + localUid : 'spicyshelves.tombstones.v1';
}
function loadLegacyTombstones() {
  try { return JSON.parse(localStorage.getItem(tombKey())) || []; }
  catch (e) { return []; }
}
function saveLegacyTombstones() {
  try { localStorage.setItem(tombKey(), JSON.stringify(tombstones)); } catch (e) {}
}
function tombstonedIds() { return new Set(tombstones.map(t => t.id)); }
// v142: tombstone floor — after an explicit "Download into this library"
// un-delete, cloud tombstones older than this timestamp are ignored on this
// device. Kills the loop where stale deletion rows (re-pushed by another
// device, or left behind by a blocked cloud delete) wipe restored books on
// every boot. Partitioned per user exactly like the tombstones.
function tombFloorKey() {
  return localUid ? 'spicyshelves.tombfloor.v2.' + localUid : 'spicyshelves.tombfloor.v1';
}
function loadLegacyTombFloor() {
  try { return Number(localStorage.getItem(tombFloorKey())) || 0; } catch (e) { return 0; }
}
function saveLegacyTombFloor() {
  try { localStorage.setItem(tombFloorKey(), String(tombstoneFloor)); } catch (e) {}
}
// "Up Next" queue (v74): ordered book ids, per-user like the library.
// Roams between devices since v520 via the user_state up_next section
// (js/229-user-state.js collects/applies this array).
function upNextKey() {
  return localUid ? 'spicyshelves.upnext.v1.' + localUid : 'spicyshelves.upnext.v1';
}
function readLegacyUpNext() {
  try { return JSON.parse(localStorage.getItem(upNextKey())) || []; }
  catch (e) { return []; }
}
function loadLegacyUpNext() {
  try {
    const have = new Set(library.map(b => b.id));
    const arr = readLegacyUpNext().filter(id => have.has(id));
    try { localStorage.setItem(upNextKey(), JSON.stringify(arr)); } catch (e) {} // persist the cleanup
    return arr;
  } catch (e) { return []; }
}
function saveLegacyUpNext() {
  try { localStorage.setItem(upNextKey(), JSON.stringify(upNext)); } catch (e) {}
}
function loadLegacyAll() {
  // v559: one-time wishlist unification, legacy-backend flavour — the
  // v529 pattern with its own per-partition flag, but it must run on
  // the RAW stored rows: loadLegacyLibrary() maps migrateBook, whose
  // status coercion would erase the status-'wishlist' evidence the
  // transform keys on. When it converts anything, the unified rows
  // are written straight back before the normal load reads them; the
  // transform's _mtime bump rides the next regular push. A partition
  // that somehow never ran v529 gets the v529 transform FIRST, on the
  // rows as its block below would see them (post-migrateBook), under
  // its own flag — the two transforms must land in version order, or
  // the v529 pass would re-wishlist what v559 just unified.
  try {
    const fkU = libKey() + '.wishlist559';
    if (!localStorage.getItem(fkU)) {
      let raw = JSON.parse(localStorage.getItem(libKey())) || [];
      // Captured before any mapping: in the both-flags-unset path the
      // v529 pre-run's migrateBook map coerces these rows' status, and
      // the sweep below still owes them the unification pair.
      const storedWish = new Set(raw.filter(b => b && b.status === 'wishlist').map(b => b.id));
      let dirtyRaw = false;
      const fk9 = libKey() + '.wishlist529';
      if (!localStorage.getItem(fk9)) {
        raw = raw.map(migrateBook);
        if (wishlistShelfTransform(raw)) dirtyRaw = true;
        localStorage.setItem(fk9, '1');
      }
      let nU = wishlistUnifyTransform(raw);
      if (storedWish.size) {
        const now = Date.now();
        for (const b of raw) {
          if (b && storedWish.has(b.id) && b.owned !== 'tobuy') { b.owned = 'tobuy'; b._mtime = now; nU++; }
        }
      }
      if (nU) dirtyRaw = true;
      localStorage.setItem(fkU, '1');
      if (dirtyRaw) localStorage.setItem(libKey(), JSON.stringify(raw));
    }
  } catch (e) {}
  library = loadLegacyLibrary();
  tombstones = loadLegacyTombstones();
  tombstoneFloor = loadLegacyTombFloor();
  upNext = loadLegacyUpNext();
  // v529: one-time wishlist-shelf migration, legacy-backend flavour —
  // the flag is a per-partition localStorage key beside the library.
  // This runs during script load, so persistence is the direct legacy
  // write (no cloud scheduling yet); the transform's _mtime bump
  // guarantees the changed books ride the next regular push.
  try {
    const fk = libKey() + '.wishlist529';
    if (!localStorage.getItem(fk)) {
      const nW = wishlistShelfTransform(library);
      localStorage.setItem(fk, '1');
      if (nW) saveLegacyLibrary();
    }
  } catch (e) {}
}

/* ---------------- IndexedDB backend (v202) ---------------- */
function idbSlotName(uid) { return IDB_SLOT_PREFIX + (uid || 'offline'); }
async function idbOpenSlot(uid) {
  const name = idbSlotName(uid);
  if (!slotDbs[name]) slotDbs[name] = await idbOpenDb(name);
  return slotDbs[name];
}

/* First open of a slot: copy the legacy localStorage partition into IDB and
   verify the book count. Throws on mismatch so the caller falls back to the
   legacy backend for this session (and retries the migration next boot).
   A per-slot `legacyMigrationDone` kv marker records that migration ran: an
   emptied slot (e.g. the offline slot after first-sign-in adoption clears it)
   must NOT re-import the read-only legacy key on a later visit — without the
   marker, sign-out would resurrect the legacy copy. The marker is written
   only after the copies and the book-count verification succeed. */
async function migrateSlotFromLegacy(db) {
  if (await idbCountBooks(db) > 0) return false; // already on IDB
  if (await idbKvGet(db, 'legacyMigrationDone')) return false; // migrated before; slot deliberately empty
  const legacy = loadLegacyLibrary();
  if (legacy.length) {
    await idbPutAllBooks(db, legacy);
    AppLog.info('storage', 'v202: migrated ' + legacy.length + ' books from localStorage to IndexedDB');
  }
  const t = loadLegacyTombstones();
  if (t.length) await idbKvPut(db, 'tombstones', t);
  const f = loadLegacyTombFloor();
  if (f) await idbKvPut(db, 'tombFloor', f);
  const u = readLegacyUpNext();
  if (u.length) await idbKvPut(db, 'upNext', u);
  await idbKvPut(db, 'legacyMigrationDone', true);
  return true;
}

async function loadSlotState(db) {
  // v559: the stored ids carrying status 'wishlist' are captured from
  // the RAW rows before the migrateBook map below — its coercion to
  // 'tbr' would erase the evidence the unification keys on. The
  // transform itself runs after the v529 block (see there).
  const rawBooks = await idbGetAllBooks(db);
  const storedWishIds = new Set(rawBooks.filter(b => b && b.status === 'wishlist').map(b => b.id));
  library = rawBooks.map(migrateBook);
  // v495 (#125): freshly loaded books are already in the store — unmark the
  // dirty flags trackBook() set, and record the store's id set so the
  // differential persist below knows what's new vs. deleted. The
  // persist-only set clears too: nothing merged can be pending against a
  // library that was just read out of this store.
  for (const b of library) { unmarkDirty(b); unmarkPersistOnly(b); }
  knownBookIds = new Set(library.map(b => b.id));
  // v529: one-time wishlist-shelf migration (js/020 wishlistShelfTransform),
  // flagged per slot in the slot kv. Changed books re-dirty via their
  // proxies and carry a fresh _mtime from the transform, so they
  // persist + push on the next save at the latest (at boot, right now).
  if (!(await idbKvGet(db, 'wishlistShelfV529'))) {
    const nW = wishlistShelfTransform(library);
    await idbKvPut(db, 'wishlistShelfV529', 1);
    if (nW) {
      persistBooks();
      if (typeof scheduleCloudPush === 'function') scheduleCloudPush();
    }
  }
  // v559: one-time wishlist unification, its own per-slot kv flag —
  // sequenced AFTER the v529 block so the transforms land in version
  // order. Books the v529 pass just shelved carry status 'wishlist'
  // in the library and the transform converts them; stored
  // status-'wishlist' rows were coerced to 'tbr' by the map above, so
  // their captured ids get the same pair directly (status already
  // 'tbr'; the facet is the transform's one sanctioned write).
  // Mutations ride the proxies, so changed books re-dirty and persist
  // + push exactly like the v529 pass above.
  if (!(await idbKvGet(db, 'wishlistUnifiedV559'))) {
    let nU = wishlistUnifyTransform(library);
    if (storedWishIds.size) {
      const now = Date.now();
      for (const b of library) {
        if (storedWishIds.has(b.id) && b.owned !== 'tobuy') { b.owned = 'tobuy'; b._mtime = now; nU++; }
      }
    }
    await idbKvPut(db, 'wishlistUnifiedV559', 1);
    if (nU) {
      persistBooks();
      if (typeof scheduleCloudPush === 'function') scheduleCloudPush();
    }
  }
  tombstones = (await idbKvGet(db, 'tombstones')) || [];
  tombstoneFloor = Number(await idbKvGet(db, 'tombFloor')) || 0;
  upNext = (await idbKvGet(db, 'upNext')) || [];
  // v74 cleanup, IDB edition: drop queued ids for books that no longer exist.
  const have = new Set(library.map(b => b.id));
  const cleaned = upNext.filter(id => have.has(id));
  if (cleaned.length !== upNext.length) { upNext = cleaned; persistUpNext(); }
}

async function idbPersistSlot(uid, state) {
  const db = await idbOpenSlot(uid);
  await idbPutAllBooks(db, state.library);
  await idbKvPut(db, 'tombstones', state.tombstones);
  await idbKvPut(db, 'tombFloor', state.tombstoneFloor);
  await idbKvPut(db, 'upNext', state.upNext);
}

/* Boot init: open the slot, migrate once, load state. Never rejects — any
   failure drops back to the v201 localStorage backend for the session. */
async function storageInit() {
  try {
    currentDb = await idbOpenSlot(localUid);
    await migrateSlotFromLegacy(currentDb);
    await loadSlotState(currentDb);
  } catch (e) {
    idbDisabled = true;
    currentDb = null;
    loadLegacyAll();
    try { AppLog.error('storage', 'IndexedDB init failed, using localStorage fallback: ' + (e && e.message)); } catch (_) {}
  }
}
let storageReady;
if (idbDisabled) {
  // No indexedDB (old browsers, jsdom): the v201 legacy load, but NOT
  // synchronously here. loadLegacyAll maps the stored rows through
  // migrateBook, and the bridge for it lives in js/020 — a deferred
  // module that only executes once the document has parsed. Running
  // the load during parsing therefore loads an empty library (the map
  // throws and is caught as []), and loadLegacyUpNext then persists an
  // empty queue over the stored one (#326). The IDB boot learned the
  // same lesson in js/041: gate on DOMContentLoaded, which fires only
  // after deferred modules have run. storageReady is still assigned
  // synchronously as a promise, so boot code awaits it exactly as it
  // does on the IDB path.
  const domReady = document.readyState === 'loading'
    ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();
  storageReady = domReady.then(() => { loadLegacyAll(); });
} else {
  // The async init is kicked off at the end of js/041-idb.js (which loads
  // right after this file): storageInit must not *start* before idbOpenDb
  // et al. exist. (The legacy branch above is unaffected — synchronous.)
  storageReady = null;
}

/* Write-through, serialized: rapid saves can't interleave transactions, and
   — the v201 lesson — a failed write is logged and toasted, never swallowed.
   Arrays are snapshotted at enqueue so a slot switch can't redirect a queued
   write into the wrong database. */
let storageWriteChain = Promise.resolve();
function storageWriteThrough(label, fn) {
  storageWriteChain = storageWriteChain.then(fn, fn).catch(e => {
    try { AppLog.error('storage', label + ' write failed: ' + (e && e.message)); } catch (_) {}
    try { toast('Couldn\'t save — export a backup!'); } catch (_) {}
  });
  return storageWriteChain;
}
/* Test hook: resolves when all queued write-throughs have settled. */
function storageDrain() { return storageWriteChain; }

function persistBooks() {
  if (idbDisabled) {
    saveLegacyLibrary();
    // v495 (#125): the legacy backend rewrites the whole library, so a
    // completed write means everything is persisted — clear the flags, or
    // _mtime would bump on every save and the differential push would
    // re-push the whole shelf each round. (saveLegacyLibrary never throws;
    // on quota failure it toasts and the flags stay set for a retry.)
    for (const b of library) { unmarkDirty(b); unmarkPersistOnly(b); }
    return;
  }
  const db = currentDb;
  if (!db) { try { AppLog.error('storage', 'persistBooks: no open database'); } catch (_) {} return; }
  storageWriteThrough('library', () => {
    // v495 (#125): differential persist. The diff is computed at EXECUTION
    // time (not enqueue) so a book edited between enqueue and execution can't
    // be missed. Slot-switch safety comes from the db identity check instead
    // of an enqueue-time array snapshot: setLocalUserIdb (v494 #130) flushes
    // the outgoing slot before flipping currentDb, so a write queued for a
    // superseded db is a no-op we can safely skip.
    if (db !== currentDb) return Promise.resolve();
    const plan = computePersistPlan(knownBookIds, library);
    if (!plan.dirty.length && !plan.deleted.length) return Promise.resolve();
    // Unmark BEFORE the async write (not after): a book edited while the
    // write is in flight re-dirties via its set-trap, so the next plan picks
    // it up. Unmarking after completion would clear that newer edit's flag
    // and lose it. On failure each book's flags are restored so the next
    // save retries — restored to the set it was actually in, not blanket-
    // marked dirty: a persist-only (merged) book restored as dirty would
    // get its _mtime stamped on the next save and re-push content that
    // already lives in the cloud.
    const written = plan.dirty.slice();
    const wasDirty = written.filter(b => dirtyBooks.has(b));
    const wasPersistOnly = written.filter(b => persistOnlyBooks.has(b));
    for (const b of written) { unmarkDirty(b); unmarkPersistOnly(b); }
    return idbPutDirtyBooks(db, plan.dirty, plan.deleted, plan.expectedCount).then(() => {
      knownBookIds = new Set(plan.ids);
    }, (err) => {
      for (const b of wasDirty) markDirty(b);
      for (const b of wasPersistOnly) markPersistOnly(b);
      throw err;
    });
  });
}
function persistTombstones() {
  if (idbDisabled) { saveLegacyTombstones(); return; }
  const db = currentDb, snap = tombstones.slice();
  if (!db) return;
  storageWriteThrough('tombstones', () => idbKvPut(db, 'tombstones', snap));
}
function persistTombFloor() {
  if (idbDisabled) { saveLegacyTombFloor(); return; }
  const db = currentDb, floor = tombstoneFloor;
  if (!db) return;
  storageWriteThrough('tombstoneFloor', () => idbKvPut(db, 'tombFloor', floor));
}
function persistUpNext() {
  if (idbDisabled) { saveLegacyUpNext(); return; }
  const db = currentDb, snap = upNext.slice();
  if (!db) return;
  storageWriteThrough('upNext', () => idbKvPut(db, 'upNext', snap));
}

function saveLibrary(opts) {
  opts = opts || {};
  stampMtimes();
  persistBooks();
  if (!opts.noCloud) scheduleCloudPush();
  // v571: a status/progress/cover change can change what the app dresses
  // for (or end the dressing) — re-resolve. Cheap + idempotent.
  try { if (typeof refreshBookDressing === 'function') refreshBookDressing(); } catch (e) {}
}
function saveTombstones() { persistTombstones(); }
function saveTombFloor() { persistTombFloor(); }
function saveUpNext() { persistUpNext(); }

// Central removal path: drops the book locally and records a tombstone.
function removeBook(id) {
  library = library.filter(b => b.id !== id);
  upNext = upNext.filter(x => x !== id); // v74: a removed book leaves the queue too
  saveUpNext();
  if (!tombstones.some(t => t.id === id)) tombstones.push({ id: id, at: Date.now() });
  saveTombstones();
  saveLibrary();
  track('book_removed');
}
// Re-adding the exact same book id is an un-delete.
function untombstone(id) {
  const i = tombstones.findIndex(t => t.id === id);
  if (i >= 0) { tombstones.splice(i, 1); saveTombstones(); }
}
// Daily reading log: one entry per book per day per unit,
// { d:'YYYY-MM-DD', from, to } for pages, plus u:'pct' on percent entries
// (audiobooks log percent — a recording has no meaningful page). An entry
// with no u is a page entry, forever: history written before percent
// logging existed stays valid untouched, and a book's current progress
// derives from its latest entry, whichever unit that entry used.
// Logged on every progress update (steppers, manual entry, mark-as-read).
function entryUnit(e) { return e && e.u === 'pct' ? 'pct' : 'page'; }
function logProgress(b, oldV, newV, unit) {
  oldV = Number(oldV) || 0; newV = Number(newV) || 0;
  if (oldV === newV) return;
  if (!Array.isArray(b.log)) b.log = [];
  const k = dayKey(new Date());
  // The fold matches on unit as well as day: folding a percent update into
  // a page entry (or the reverse) would corrupt both ranges, so a
  // mixed-unit day holds one entry per unit.
  let e = b.log.find(x => x.d === k && entryUnit(x) === unit);
  if (!e) {
    // v468: reading session counter for portrait nudges — its unit is
    // a DAY with a log, so only the day's first entry (of either unit)
    // counts; a mixed-unit day is still one day.
    const dayAlreadyLogged = b.log.some(x => x.d === k);
    e = { d: k, from: Math.min(oldV, newV), to: Math.max(oldV, newV) };
    if (unit === 'pct') e.u = 'pct';
    b.log.push(e);
    if (!dayAlreadyLogged) b.readSessions = (b.readSessions || 0) + 1;
  }
  else { e.from = Math.min(e.from, newV); e.to = Math.max(e.to, newV); }
  if (b.log.length > 730) b.log = b.log.slice(-730); // ~2 years cap
  b.lastPagedAt = new Date().toISOString(); // v59: exact touch time, so the
  // Recently read shelf can put the just-updated book first even when several
  // books were read on the same day.
}
function logPages(b, oldP, newP) { logProgress(b, oldP, newP, 'page'); }
// The unit a book's current progress is expressed in: the marker the write
// paths stamp, else the latest log entry's unit, else pages. Audiobooks
// with only pre-percent page history therefore still read as page books
// until their first percent entry lands.
function progressUnitOf(b) {
  if (!b) return 'page';
  if (b.progressUnit === 'pct' || b.progressUnit === 'page') return b.progressUnit;
  const log = b.log || [];
  for (let i = log.length - 1; i >= 0; i--) { if (log[i]) return entryUnit(log[i]); }
  return 'page';
}
// Display percent for either unit; null when a page book has no page
// count to divide by (percent books always know their percent).
function progressPctOf(b) {
  if (!b) return null;
  const v = Number(b.progress) || 0;
  if (progressUnitOf(b) === 'pct') return Math.max(0, Math.min(100, Math.round(v)));
  return b.pageCount > 0 ? Math.max(0, Math.min(100, Math.round(v / b.pageCount * 100))) : null;
}
function loggedOnDay(b, k, unit) {
  return (b.log || []).filter(e => e.d === k && entryUnit(e) === unit)
    .reduce((s, e) => s + Math.max(0, e.to - e.from), 0);
}
// Pages only: a percent entry's span is percentage points, and summing it
// as pages would poison every page statistic downstream.
function pagesOnDay(b, k) { return loggedOnDay(b, k, 'page'); }
// Seconds of listening left, or null when the question has no answer:
// no recorded length, progress not in percent, or already finished.
// Display-only by design — nothing here feeds pace or deadline framing.
function audioLeftSecs(b) {
  if (!b || b.format !== 'audio') return null;
  const total = Number(b.audioSecs) || 0;
  if (total <= 0 || progressUnitOf(b) !== 'pct') return null;
  const p = Number(b.progress) || 0;
  if (p >= 100) return null;
  return Math.round(total * (100 - Math.max(0, p)) / 100);
}
// "11 h 22 min" / "1 h" / "42 min" — the shape durations are shown in.
function fmtHMS(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  const h = Math.floor(s / 3600);
  let m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0 && s > 0) m = 1;
  if (h && m) return h + ' h ' + m + ' min';
  if (h) return h + ' h';
  return m + ' min';
}
// v68: Settings toggle gating the "remove today's entry" button in the book modal.
// v590 (Variant B): the Show/Hide SETTING is retired — the button only ever
// appears on days with an entry to remove, so context is the gate and the
// behaviour is hardcoded Show. The stored key (spicyshelves.logremove, a
// frozen roamed pref) is simply no longer read.
function logRemoveEnabled() {
  return true;
}
function readingStreak() {
  const days = new Set();
  library.forEach(b => {
    (b.log || []).forEach(e => { if (e.to > e.from) days.add(e.d); });
    if (b.status === 'read' && b.dateFinished) days.add(dayKey(new Date(b.dateFinished)));
  });
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // streak alive if yesterday logged
  let s = 0;
  while (days.has(dayKey(d))) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
// Longest-ever run of consecutive reading days (v62).
function longestStreak() {
  const days = new Set();
  library.forEach(b => {
    (b.log || []).forEach(e => { if (e.to > e.from) days.add(e.d); });
    if (b.status === 'read' && b.dateFinished) days.add(dayKey(new Date(b.dateFinished)));
  });
  const sorted = Array.from(days).sort();
  let best = 0, run = 0, prev = null;
  sorted.forEach(k => {
    // Day keys are calendar days, so the gap is measured in UTC (the
    // pattern js/170's year streak already uses): local noon-to-noon
    // is 23h or 25h across a DST change, never the exact 864e5 the
    // comparison needs — the local-noon version silently broke every
    // run spanning a clock change.
    const p = k.split('-');
    const t = Date.UTC(+p[0], +p[1] - 1, +p[2]);
    run = (prev != null && t - prev === 864e5) ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  });
  return best;
}

// Switch the on-device library between users (null = signed out).
// Serialized: a sign-out followed by a fast sign-in can't interleave the
// async slot switches. Legacy backend: the v201 implementation, synchronous.
let localUserChain = Promise.resolve();
function setLocalUser(uid) {
  if (idbDisabled) { setLocalUserLegacy(uid); return undefined; }
  // A rejected switch must not poison later switches: run the next switch
  // even if the previous one failed (its own error is still returned to
  // this caller via the chained promise).
  localUserChain = localUserChain.then(() => setLocalUserIdb(uid), () => setLocalUserIdb(uid));
  return localUserChain;
}

function setLocalUserLegacy(uid) {
  if (uid === localUid) return;
  const prevUid = localUid;
  try { localStorage.setItem(libKey(), JSON.stringify(library)); } catch (e) {}
  try { localStorage.setItem(tombKey(), JSON.stringify(tombstones)); } catch (e) {}
  try { localStorage.setItem(tombFloorKey(), String(tombstoneFloor)); } catch (e) {} // v142
  try { localStorage.setItem(upNextKey(), JSON.stringify(upNext)); } catch (e) {} // v74
  const hadBooks = library.length > 0;
  const hadTombs = tombstones.length > 0;
  const hadFloor = tombstoneFloor > 0; // v142
  localUid = uid || null;
  let next = loadLegacyLibrary();
  // v204: signed-out mode is deprecated — the only offline shelf left is a
  // pre-v204 library, which the first sign-in adopts into the new account's
  // slot. (The v136 sign-out hand-back is gone: signing out no longer copies
  // anything into the shared offline slot.)
  if (uid && next.length === 0 && hadBooks) {
    next = library;
    try {
      localStorage.setItem(libKey(), JSON.stringify(next));
      localStorage.removeItem(LS_KEY);
    } catch (e) {}
  }
  library = next;
  let nextTombs = loadLegacyTombstones();
  if (uid && nextTombs.length === 0 && hadTombs) {
    nextTombs = tombstones;
    try {
      localStorage.setItem(tombKey(), JSON.stringify(nextTombs));
      localStorage.removeItem('spicyshelves.tombstones.v1');
    } catch (e) {}
  }
  tombstones = nextTombs;
  // v142: the floor roams with the tombstones on first-sign-in adoption, and
  // the per-user slot keeps its own otherwise.
  let nextFloor = loadLegacyTombFloor();
  if (uid && nextFloor === 0 && hadFloor) {
    nextFloor = tombstoneFloor;
    try {
      localStorage.setItem(tombFloorKey(), String(nextFloor));
      localStorage.removeItem('spicyshelves.tombfloor.v1');
    } catch (e) {}
  }
  tombstoneFloor = nextFloor;
  upNext = loadLegacyUpNext(); // v74: queue is per-user too
  // v529: the same one-time wishlist-shelf migration for the incoming
  // partition, under its own flag. (The first-sign-in adoption moves
  // the pre-v204 offline shelf — pre-migration data by construction,
  // since signed-out mode is retired — so transforming it here under
  // the account's flag is the same one-time pass, not a re-run.)
  try {
    const fk = libKey() + '.wishlist529';
    if (!localStorage.getItem(fk)) {
      const nW = wishlistShelfTransform(library);
      localStorage.setItem(fk, '1');
      if (nW) saveLibrary();
    }
  } catch (e) {}
  // v559: the same one-time wishlist unification for the incoming
  // partition, under its own flag. The incoming rows arrive through
  // loadLegacyLibrary (already migrateBook-coerced), and loadLegacyAll
  // runs the raw-row pass under this same flag on the next legacy
  // load — in practice this finds nothing; it keeps the per-partition
  // flag bookkeeping identical across the adoption path.
  try {
    const fkU = libKey() + '.wishlist559';
    if (!localStorage.getItem(fkU)) {
      const nU = wishlistUnifyTransform(library);
      localStorage.setItem(fkU, '1');
      if (nU) saveLibrary();
    }
  } catch (e) {}
}

async function setLocalUserIdb(uid) {
  if (uid === localUid) return;
  // Let in-flight write-throughs land in the outgoing slot before switching.
  await storageDrain();
  const prevUid = localUid;
  const prev = { library: library, tombstones: tombstones, tombstoneFloor: tombstoneFloor, upNext: upNext };
  const hadBooks = prev.library.length > 0;
  const hadTombs = prev.tombstones.length > 0;
  const hadFloor = prev.tombstoneFloor > 0;
  // Belt-and-braces flush of the outgoing slot (write-through already did it).
  try { await idbPersistSlot(prevUid, prev); }
  catch (e) { try { AppLog.error('storage', 'slot flush failed: ' + (e && e.message)); } catch (_) {} }
  localUid = uid || null;
  // v494 (#130): flip currentDb only AFTER the new slot's state is loaded.
  // Assigning first left a window where currentDb pointed at the new slot's
  // database while `library` still held the old slot's books — a
  // saveLibrary() in that window persisted the wrong books into the new
  // slot (self-healed on the next save, but a reload inside the window
  // loaded the wrong library). With the flip deferred, an in-window save
  // targets the old slot's database with the old slot's books — a harmless
  // no-op, since the outgoing slot was already flushed above.
  const db = await idbOpenSlot(localUid);
  await migrateSlotFromLegacy(db);
  await loadSlotState(db);
  currentDb = db;
  // v204: signed-out mode is deprecated — the only offline shelf left is a
  // pre-v204 library, which the first sign-in adopts into the new account's
  // slot. (The v136 sign-out hand-back is gone: signing out leaves the
  // shared offline slot alone; the per-user slot keeps its copy.)
  if (uid && library.length === 0 && hadBooks) {
    // First sign-in: the offline shelf moves into the new account's slot.
    library = prev.library; tombstones = prev.tombstones;
    tombstoneFloor = prev.tombstoneFloor; upNext = prev.upNext;
    await idbPersistSlot(localUid, { library: library, tombstones: tombstones, tombstoneFloor: tombstoneFloor, upNext: upNext });
    knownBookIds = new Set(library.map(b => b.id)); // v495 (#125): adopted wholesale — the store now holds exactly these
    await idbClearBooks(await idbOpenSlot(prevUid)).catch(() => {}); // moved, not copied
    // v202: legacy localStorage partition keys are read-only — kept as the
    // grace-period fallback, not deleted.
  }
}

/* ---------------- library recovery ---------------- */
// Every on-device library partition: the shared offline slot plus one per
// signed-in user. Settings → "Find my library" lists them so a library that
// looks empty can be found and restored. (v136 introduced this for the
// sign-out hand-back; v204 removed the hand-back with signed-out mode, but
// the recovery UI stays as a grace-period safety net.)
// v517 (#131): the live libraries have lived in IndexedDB slots
// (`cozylibram.<uid|offline>`) since v202, but this listing only ever read
// the legacy localStorage keys — so on a device whose data had migrated
// (or that never had legacy keys) Settings reported "No saved libraries
// found" while the books sat in a slot, invisible to recovery. Enumeration
// is now async and slot-first: slots are discovered via
// indexedDB.databases(), each slot supersedes its legacy twin (the
// read-only grace copy of the same library), and the legacy keys remain
// as the fallback for browsers without databases() and for pre-v202
// partitions that never became slots.
async function libraryPartitions() {
  const byKey = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== 'spicyshelves.library.v1' && k.indexOf('spicyshelves.library.v2.') !== 0) continue;
      let n = -1;
      try { const a = JSON.parse(localStorage.getItem(k)); n = Array.isArray(a) ? a.length : -1; } catch (e) {}
      byKey[k] = { key: k, n: n, current: k === libKey() };
    }
  } catch (e) {}
  for (const s of await slotPartitions()) {
    delete byKey[legacyKeyForSlot(s.key)]; // the slot is the live copy
    byKey[s.key] = s;
  }
  const out = Object.keys(byKey).map(k => byKey[k]);
  out.sort((a, b) => b.n - a.n);
  return out;
}
// The legacy localStorage key that held the same library a slot now holds.
function legacyKeyForSlot(dbName) {
  const suffix = dbName.slice(IDB_SLOT_PREFIX.length);
  return suffix === 'offline' ? 'spicyshelves.library.v1'
    : 'spicyshelves.library.v2.' + suffix;
}
// The slot uid behind a partition key (null = the offline slot), for
// idbOpenSlot. Keys that aren't slot database names return undefined.
function slotUidForKey(key) {
  if (typeof key !== 'string' || key.indexOf(IDB_SLOT_PREFIX) !== 0) return undefined;
  const suffix = key.slice(IDB_SLOT_PREFIX.length);
  return suffix === 'offline' ? null : suffix;
}
// On-device IndexedDB slots with their book counts. Empty slots are not
// saved libraries and are omitted. Where indexedDB.databases() is
// unavailable (older Firefox) only the currently open slot can be vouched
// for; the legacy enumeration above still runs, so the list degrades
// instead of going blind.
async function slotPartitions() {
  if (idbDisabled || typeof indexedDB === 'undefined') return [];
  let names = null;
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      names = (list || []).map(d => d && d.name)
        .filter(n => typeof n === 'string' && n.indexOf(IDB_SLOT_PREFIX) === 0);
    } catch (e) { names = null; }
  }
  if (!names) {
    return (currentDb && library.length)
      ? [{ key: idbSlotName(localUid), n: library.length, current: true }] : [];
  }
  const out = [];
  for (const name of names) {
    try {
      const db = await idbOpenSlot(slotUidForKey(name));
      const n = await idbCountBooks(db);
      if (n < 1) continue;
      out.push({ key: name, n: n, current: name === idbSlotName(localUid) });
    } catch (e) { /* an unreadable slot shouldn't hide the rest */ }
  }
  return out;
}
function partitionLabel(p) {
  if (p.key === 'spicyshelves.library.v1' || p.key === idbSlotName(null)) return 'Offline shelf (signed out)';
  if (p.key === libKey() || (localUid && p.key === idbSlotName(localUid))) return 'This account';
  return 'Another sign-in on this device';
}
// Restore a partition's books into the currently open library slot. Slot
// partitions are read from their IndexedDB database; legacy partitions
// from localStorage. A restore is an explicit un-delete: the restored ids
// are untombstoned, or the next sync push would re-delete them (the same
// contract resurrectCloudBooks follows for cloud restores, js/090-sync.js).
async function restorePartition(key) {
  let arr = null;
  const slotUid = slotUidForKey(key);
  if (slotUid !== undefined) {
    if (idbDisabled || typeof indexedDB === 'undefined') return 0;
    try {
      const books = await idbGetAllBooks(await idbOpenSlot(slotUid));
      if (Array.isArray(books)) arr = books;
    } catch (e) { return 0; }
  } else {
    try { const a = JSON.parse(localStorage.getItem(key)); if (Array.isArray(a)) arr = a; } catch (e) {}
  }
  if (!arr) return 0;
  library = arr.map(migrateBook); // v495 (#125): migrateBook wraps+dirties — restored content may differ from the store, so it all persists
  library.forEach(b => untombstone(b.id));
  saveLibrary();
  return library.length;
}
