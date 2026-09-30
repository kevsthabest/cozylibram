'use strict';

/* ---------------- render root ---------------- */
function setView(html) { document.getElementById('view').innerHTML = html; }
function render() {
  if (view === 'library') renderLibrary();
  else if (view === 'wishlist') renderWishlist();
  else if (view === 'add') renderAdd();
  else if (view === 'pick') renderPick();
  else if (view === 'stats') renderStats();
  else if (view === 'settings') renderSettings();
  else if (view === 'profile') renderProfile();
  else if (view === 'authors') renderAuthors();
  else if (view === 'author') renderAuthorDetail();
  else if (view === 'upnext') renderUpNext();
  else if (view === 'quotes') renderQuotes();
  else if (view === 'series') renderSeries();
  else if (view === 'verify') renderVerify();
  else if (view === 'coven') renderCoven();
  else if (view === 'coven-friend') renderCovenFriend();
  else if (view === 'discover') renderDiscover();
  else if (view === 'admin') renderAdmin();
}

applyTheme();

// One-time cleanup (v29): API keys moved to server-config.json on the home PC.
// Drop any copies left over from the old per-device Settings entries.
try {
  ['hc_token', 'gbooks_key', 'sb_url', 'sb_key'].forEach(k => localStorage.removeItem(k));
} catch (e) {}

// Boot (v204): signed-out mode is deprecated — the sign-in gate is the only
// entry point. A persisted session enters the app automatically via
// initCloud (Supabase reads the session from local storage, so returning
// users keep working from the on-device cache even while offline). First
// launch needs connectivity; there is no offline fallback anymore.
//
// v202: the library now persists in IndexedDB. One async init (open +
// migrate + load) runs before anything renders; the legacy localStorage
// backend (old browsers, test env) boots synchronously exactly like v201.
function boot() {
  // v204: the retired offline-mode flags are never honored again — drop any
  // copies left over from before signed-out mode was deprecated.
  try { localStorage.removeItem('spicyshelves.offline'); localStorage.removeItem('spicyshelves.offline.owner'); } catch (e) {}
  renderGate();
}

if (idbDisabled) {
  boot();
  initCloud();
} else {
  // storageInit() never rejects (it falls back internally); the rejection
  // branch is belt-and-braces so a blank screen is impossible.
  storageReady.then(() => { boot(); initCloud(); }, () => { boot(); initCloud(); });
}

// New zips ship often — ask the service worker for an update on every
// launch so devices pick up the latest version without a manual nudge.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistration()
    .then(r => { if (r) return r.update(); })
    .catch(() => {});
}
