'use strict';

/* ---------------- storage ---------------- */
// On-device libraries are partitioned by signed-in user so several people can
// share one device without mixing shelves. `localUid` is null when signed out
// (classic single-device library under LS_KEY).
let localUid = null;
function libKey() {
  return localUid ? 'spicyshelves.library.v2.' + localUid : LS_KEY;
}
function loadLibrary() {
  try { return (JSON.parse(localStorage.getItem(libKey())) || []).map(migrateBook); }
  catch (e) { return []; }
}
// Snapshots (excluding _mtime) so saveLibrary() can stamp only books that changed.
const bookSnapshots = new Map();
// NOTE: library loads here (not at the top of the file) because migrateBook can
// reach RATING_AXES/autoDetectAxes — both must be initialized first.
let library = loadLibrary();
library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
function bookSnap(b) {
  const c = {};
  Object.keys(b).sort().forEach(k => { if (k !== '_mtime') c[k] = b[k]; });
  return JSON.stringify(c);
}

// Deletion tombstones: deleting a book records { id, at } so the deletion
// propagates through sync instead of the book resurrecting from another
// device's push. Partitioned per user exactly like the library.
let tombstones = [];
function tombKey() {
  return localUid ? 'spicyshelves.tombstones.v2.' + localUid : 'spicyshelves.tombstones.v1';
}
function loadTombstones() {
  try { return JSON.parse(localStorage.getItem(tombKey())) || []; }
  catch (e) { return []; }
}
function saveTombstones() {
  try { localStorage.setItem(tombKey(), JSON.stringify(tombstones)); } catch (e) {}
}
tombstones = loadTombstones();
function tombstonedIds() { return new Set(tombstones.map(t => t.id)); }
// "Up Next" queue (v74): ordered book ids, per-user like the library.
// Local-only for now — the queue is a reading plan, not synced to the cloud.
let upNext = [];
function upNextKey() {
  return localUid ? 'spicyshelves.upnext.v1.' + localUid : 'spicyshelves.upnext.v1';
}
function loadUpNext() {
  try {
    const have = new Set(library.map(b => b.id));
    const arr = (JSON.parse(localStorage.getItem(upNextKey())) || []).filter(id => have.has(id));
    try { localStorage.setItem(upNextKey(), JSON.stringify(arr)); } catch (e) {} // persist the cleanup
    return arr;
  } catch (e) { return []; }
}
function saveUpNext() {
  try { localStorage.setItem(upNextKey(), JSON.stringify(upNext)); } catch (e) {}
}
upNext = loadUpNext();
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
function saveLibrary(opts) {
  opts = opts || {};
  const now = Date.now();
  for (const b of library) {
    const s = bookSnap(b);
    if (bookSnapshots.get(b.id) !== s) { b._mtime = now; bookSnapshots.set(b.id, bookSnap(b)); }
  }
  try { localStorage.setItem(libKey(), JSON.stringify(library)); }
  catch (e) { toast('Storage full — export a backup!'); }
  if (!opts.noCloud) scheduleCloudPush();
}

// Switch the on-device library between users (null = signed out). On the
// first sign-in on a device, an existing offline library is adopted into the
// new per-user slot instead of being abandoned.
//
// v136: marks whose sign-out hand-back the offline shelf currently holds, so
// a *different* user signing in later won't adopt someone else's books.
const OFFLINE_OWNER_KEY = 'spicyshelves.offline.owner';
function offlineOwner() {
  try { return localStorage.getItem(OFFLINE_OWNER_KEY); } catch (e) { return null; }
}
function setLocalUser(uid) {
  if (uid === localUid) return;
  const prevUid = localUid;
  try { localStorage.setItem(libKey(), JSON.stringify(library)); } catch (e) {}
  try { localStorage.setItem(tombKey(), JSON.stringify(tombstones)); } catch (e) {}
  try { localStorage.setItem(upNextKey(), JSON.stringify(upNext)); } catch (e) {} // v74
  const hadBooks = library.length > 0;
  const hadTombs = tombstones.length > 0;
  const owner = offlineOwner();
  localUid = uid || null;
  bookSnapshots.clear();
  let next = loadLibrary();
  // The offline shelf is adoptable unless it's another user's hand-back.
  const adoptable = !owner || owner === uid;
  if (uid && next.length === 0 && hadBooks && adoptable) {
    next = library;
    try {
      localStorage.setItem(libKey(), JSON.stringify(next));
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(OFFLINE_OWNER_KEY);
    } catch (e) {}
  } else if (!uid && next.length === 0 && hadBooks) {
    // v136: signing out hands the library back to the shared offline slot
    // instead of stranding it in the per-user slot (which made the library
    // look deleted after sign-out / "Continue offline"). The per-user slot
    // keeps its copy too, so signing back in still finds it there.
    next = library;
    try {
      localStorage.setItem(libKey(), JSON.stringify(next));
      localStorage.setItem(tombKey(), JSON.stringify(tombstones));
      localStorage.setItem(upNextKey(), JSON.stringify(upNext));
      if (prevUid) localStorage.setItem(OFFLINE_OWNER_KEY, prevUid);
    } catch (e) {}
  }
  library = next;
  library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
  let nextTombs = loadTombstones();
  if (uid && nextTombs.length === 0 && hadTombs && adoptable) {
    nextTombs = tombstones;
    try {
      localStorage.setItem(tombKey(), JSON.stringify(nextTombs));
      localStorage.removeItem('spicyshelves.tombstones.v1');
    } catch (e) {}
  }
  tombstones = nextTombs;
  upNext = loadUpNext(); // v74: queue is per-user too
}

/* ---------------- library recovery (v136) ---------------- */
// Every on-device library partition: the shared offline slot plus one per
// signed-in user. Settings → "Find my library" lists them so a library that
// looks empty (e.g. after signing out) can be found and restored.
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

