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
// Central removal path: drops the book locally and records a tombstone.
function removeBook(id) {
  library = library.filter(b => b.id !== id);
  bookSnapshots.delete(id);
  if (!tombstones.some(t => t.id === id)) tombstones.push({ id: id, at: Date.now() });
  saveTombstones();
  saveLibrary();
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
function setLocalUser(uid) {
  if (uid === localUid) return;
  try { localStorage.setItem(libKey(), JSON.stringify(library)); } catch (e) {}
  try { localStorage.setItem(tombKey(), JSON.stringify(tombstones)); } catch (e) {}
  const hadBooks = library.length > 0;
  const hadTombs = tombstones.length > 0;
  localUid = uid || null;
  bookSnapshots.clear();
  let next = loadLibrary();
  if (uid && next.length === 0 && hadBooks) {
    next = library;
    try {
      localStorage.setItem(libKey(), JSON.stringify(next));
      localStorage.removeItem(LS_KEY);
    } catch (e) {}
  }
  library = next;
  library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
  let nextTombs = loadTombstones();
  if (uid && nextTombs.length === 0 && hadTombs) {
    nextTombs = tombstones;
    try {
      localStorage.setItem(tombKey(), JSON.stringify(nextTombs));
      localStorage.removeItem('spicyshelves.tombstones.v1');
    } catch (e) {}
  }
  tombstones = nextTombs;
}

