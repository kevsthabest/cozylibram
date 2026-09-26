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
render();
initCloud();
