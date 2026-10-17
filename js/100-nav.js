'use strict';

/* ---------------- navigation ---------------- */
// v121: five primary destinations. Sub-views highlight their parent tab so
// the nav always reflects where the user is.
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const NAV_PARENT = {
  library: 'library', wishlist: 'library', upnext: 'library', quotes: 'library',
  discover: 'discover', pick: 'discover', authors: 'discover', author: 'discover',
  add: 'add',
  stats: 'stats',
  shelf: 'shelf',
  coven: 'coven', 'coven-friend': 'coven',
  settings: 'settings', // v171: sidebar settings entry highlights itself
  // Hybrid: Profile is its own view again (reached from the avatar menu,
  // not the bottom nav) — it has no nav parent, as before v590.
};
export function navTab(v) {
  if (v === 'series') return NAV_PARENT[typeof seriesReturn !== 'undefined' ? seriesReturn : ''] || 'discover';
  return NAV_PARENT[v] || null;
}
export function go(v) {
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


/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this file
   can see them. The consumers — 050-helpers.js, 095-gate.js,
   096-onboarding.js, 105-account.js, 120-favorites.js, 132-import.js,
   139-import-concierge.js, 140-collections.js, 150-modal-discovery.js,
   155-authors.js, 159-characters.js, 160-roulette.js, 170-stats.js,
   180-settings.js, 195-coven.js, 198-discovery.js, 205-shelfview.js and
   237-handles.js — reach these names at runtime, so the bridge republishes
   exactly the pre-conversion public surface on window. Bare-name lookups in
   classic scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place before
   any consumer can run. Remove a name from this bridge only when its last
   classic caller is gone.
 */
window.NAV_PARENT = NAV_PARENT;
window.navTab = navTab;
window.go = go;
