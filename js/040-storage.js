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

// Snapshots (excluding _mtime) so saveLibrary() can stamp only books that changed.
const bookSnapshots = new Map();
function bookSnap(b) {
  const c = {};
  Object.keys(b).sort().forEach(k => { if (k !== '_mtime') c[k] = b[k]; });
  return JSON.stringify(c);
}
function stampMtimes() {
  const now = Date.now();
  for (const b of library) {
    const s = bookSnap(b);
    if (bookSnapshots.get(b.id) !== s) { b._mtime = now; bookSnapshots.set(b.id, bookSnap(b)); }
  }
}
function snapshotBooks() {
  bookSnapshots.clear();
  library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
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
// Local-only for now — the queue is a reading plan, not synced to the cloud.
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
  library = loadLegacyLibrary();
  tombstones = loadLegacyTombstones();
  tombstoneFloor = loadLegacyTombFloor();
  upNext = loadLegacyUpNext();
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
  library = (await idbGetAllBooks(db)).map(migrateBook);
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
  snapshotBooks();
}
let storageReady;
if (idbDisabled) {
  // No indexedDB (old browsers, jsdom): v201 behavior, synchronous.
  loadLegacyAll();
  snapshotBooks();
  storageReady = Promise.resolve();
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
  if (idbDisabled) { saveLegacyLibrary(); return; }
  const db = currentDb, snap = library.slice();
  if (!db) { try { AppLog.error('storage', 'persistBooks: no open database'); } catch (_) {} return; }
  storageWriteThrough('library', () => idbPutAllBooks(db, snap));
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
}
function saveTombstones() { persistTombstones(); }
function saveTombFloor() { persistTombFloor(); }
function saveUpNext() { persistUpNext(); }

// Central removal path: drops the book locally and records a tombstone.
function removeBook(id) {
  library = library.filter(b => b.id !== id);
  upNext = upNext.filter(x => x !== id); // v74: a removed book leaves the queue too
  saveUpNext();
  bookSnapshots.delete(id);
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
// Daily reading log: one entry per book per day { d:'YYYY-MM-DD', from, to }.
// Logged on every page update (steppers, manual entry, mark-as-read).
function logPages(b, oldP, newP) {
  oldP = Number(oldP) || 0; newP = Number(newP) || 0;
  if (oldP === newP) return;
  if (!Array.isArray(b.log)) b.log = [];
  const k = dayKey(new Date());
  let e = b.log.find(x => x.d === k);
  if (!e) { e = { d: k, from: Math.min(oldP, newP), to: Math.max(oldP, newP) }; b.log.push(e); }
  else { e.from = Math.min(e.from, newP); e.to = Math.max(e.to, newP); }
  if (b.log.length > 730) b.log = b.log.slice(-730); // ~2 years cap
  b.lastPagedAt = new Date().toISOString(); // v59: exact touch time, so the
  // Recently read shelf can put the just-updated book first even when several
  // books were read on the same day.
}
function pagesOnDay(b, k) {
  return (b.log || []).filter(e => e.d === k).reduce((s, e) => s + Math.max(0, e.to - e.from), 0);
}
// v68: Settings toggle gating the "remove today's entry" button in the book modal.
function logRemoveEnabled() {
  try { return localStorage.getItem('spicyshelves.logremove') === 'on'; } catch (e) { return false; }
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
    const t = new Date(k + 'T12:00:00').getTime(); // local noon dodges DST edges
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
  bookSnapshots.clear();
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
  library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
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
  bookSnapshots.clear();
  currentDb = await idbOpenSlot(localUid);
  await migrateSlotFromLegacy(currentDb);
  await loadSlotState(currentDb);
  // v204: signed-out mode is deprecated — the only offline shelf left is a
  // pre-v204 library, which the first sign-in adopts into the new account's
  // slot. (The v136 sign-out hand-back is gone: signing out leaves the
  // shared offline slot alone; the per-user slot keeps its copy.)
  if (uid && library.length === 0 && hadBooks) {
    // First sign-in: the offline shelf moves into the new account's slot.
    library = prev.library; tombstones = prev.tombstones;
    tombstoneFloor = prev.tombstoneFloor; upNext = prev.upNext;
    await idbPersistSlot(localUid, { library: library, tombstones: tombstones, tombstoneFloor: tombstoneFloor, upNext: upNext });
    await idbClearBooks(await idbOpenSlot(prevUid)).catch(() => {}); // moved, not copied
    // v202: legacy localStorage partition keys are read-only — kept as the
    // grace-period fallback, not deleted.
  }
  snapshotBooks();
}

/* ---------------- library recovery ---------------- */
// Every on-device library partition: the shared offline slot plus one per
// signed-in user. Settings → "Find my library" lists them so a library that
// looks empty can be found and restored. (v136 introduced this for the
// sign-out hand-back; v204 removed the hand-back with signed-out mode, but
// the recovery UI stays as a grace-period safety net.)
// v202: lists the legacy localStorage partitions (grace-period fallback);
// the live data now lives in IndexedDB.
function libraryPartitions() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== 'spicyshelves.library.v1' && k.indexOf('spicyshelves.library.v2.') !== 0) continue;
      let n = -1;
      try { const a = JSON.parse(localStorage.getItem(k)); n = Array.isArray(a) ? a.length : -1; } catch (e) {}
      out.push({ key: k, n: n, current: k === libKey() });
    }
  } catch (e) {}
  out.sort((a, b) => b.n - a.n);
  return out;
}
function partitionLabel(p) {
  if (p.key === 'spicyshelves.library.v1') return 'Offline shelf (signed out)';
  if (localUid && p.key === 'spicyshelves.library.v2.' + localUid) return 'This account';
  return 'Another sign-in on this device';
}
// Restore a partition's books into the currently open library slot.
function restorePartition(key) {
  let arr = null;
  try { const a = JSON.parse(localStorage.getItem(key)); if (Array.isArray(a)) arr = a; } catch (e) {}
  if (!arr) return 0;
  library = arr.map(migrateBook);
  bookSnapshots.clear();
  library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
  saveLibrary();
  return library.length;
}
