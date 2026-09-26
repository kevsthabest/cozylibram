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
  else if (view === 'verify') renderVerify();
}

applyTheme();

// One-time cleanup (v29): API keys moved to server-config.json on the home PC.
// Drop any copies left over from the old per-device Settings entries.
try {
  ['hc_token', 'gbooks_key', 'sb_url', 'sb_key'].forEach(k => localStorage.removeItem(k));
} catch (e) {}

// Boot: no backend (or offline chosen) → straight to the library, classic
// behavior. Backend configured → sign-in gate first; initCloud() enters the
// app automatically when a session already exists.
function boot() {
  let offline = false;
  try { offline = localStorage.getItem(OFFLINE_KEY) === '1'; } catch (e) {}
  if (!cloudConfigured() || offline) render();
  else renderGate();
}

boot();
initCloud();
