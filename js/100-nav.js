'use strict';

/* ---------------- navigation ---------------- */
// v121: five primary destinations. Sub-views highlight their parent tab so
// the nav always reflects where the user is.
const NAV_PARENT = {
  library: 'library', wishlist: 'library', upnext: 'library', quotes: 'library',
  discover: 'discover', pick: 'discover', authors: 'discover', author: 'discover',
  add: 'add',
  stats: 'stats',
  coven: 'coven', 'coven-friend': 'coven',
  settings: 'settings', // v171: sidebar settings entry highlights itself
};
function navTab(v) {
  if (v === 'series') return NAV_PARENT[typeof seriesReturn !== 'undefined' ? seriesReturn : ''] || 'discover';
  return NAV_PARENT[v] || null;
}
function go(v) {
  stopScan();
  if (typeof routeBackClosed === 'function') routeBackClosed(); // v224 (UX-23): route entries die on navigation
  if (rouletteTimer) { clearInterval(rouletteTimer); rouletteTimer = null; }
  view = v;
  animateIn = true;
  const tab = navTab(v);
  document.querySelectorAll('.bottom-nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === tab));
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.bottom-nav button').forEach(b =>
  b.addEventListener('click', () => go(b.dataset.nav)));

