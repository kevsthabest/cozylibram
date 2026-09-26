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
}

applyTheme();

// One-time cleanup (v29): API keys moved to server-config.json on the home PC.
// Drop any copies left over from the old per-device Settings entries.
try {
  ['hc_token', 'gbooks_key', 'sb_url', 'sb_key'].forEach(k => localStorage.removeItem(k));
} catch (e) {}

render();
initCloud();
