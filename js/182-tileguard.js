'use strict';

/* ---------------- tile guard (v57) ----------------
   Guarantees uniform 2:3 cover boxes in the library grid even if a stale
   styles.css is ever applied on a device. After the grid renders, it measures
   the real .bt-cover boxes; if they are not 2:3 (stale CSS), it forces the
   height via inline style. When the CSS is correct this is a no-op.
   The outcome is recorded for the Settings → App diagnostics. */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export var tileGuardState = 'not-run'; // not-run | css-ok | fixed

export function tileGuard() {
  tileGuardState = 'not-run';
  try {
    var tiles = document.querySelectorAll('#view .bt-cover');
    if (!tiles.length) return;
    var r = tiles[0].getBoundingClientRect();
    if (!(r.width > 0)) return;
    if (Math.abs(r.height / r.width - 1.5) > 0.08) {
      for (var i = 0; i < tiles.length; i++) {
        var w = tiles[i].getBoundingClientRect().width;
        if (w > 0) tiles[i].style.height = (w * 1.5).toFixed(1) + 'px';
      }
      tileGuardState = 'fixed';
    } else {
      tileGuardState = 'css-ok';
    }
  } catch (e) { /* never break rendering */ }
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The one classic consumer, js/120-favorites.js,
   calls tileGuard() at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.tileGuardState = tileGuardState;
window.tileGuard = tileGuard;
