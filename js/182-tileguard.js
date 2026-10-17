'use strict';

/* js/182-tileguard.js — Tile guard: a post-render safety net that keeps
 * library cover boxes at 2:3 even when a device is running a stale
 * styles.css.
 *
 * tileGuard() runs after the grid renders (its only caller is
 * js/120-favorites.js, right after the favourites grid is built). It
 * measures the first real .bt-cover box in #view; if the height/width
 * ratio is off 1.5 by more than 0.08 the CSS is stale, so it forces
 * every tile's height inline (width × 1.5). When the CSS is correct
 * the pass is a no-op. The whole pass is failure-swallowing by design:
 * a measuring error must never break rendering.
 *
 * tileGuardState records the outcome — 'not-run' | 'css-ok' | 'fixed'.
 * The state and tileGuard reach js/120 through the window bridge at
 * the bottom of this file; the state transitions are pinned by
 * .test/tileguard.test.js. This file reads nothing from any other
 * module.
 */
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
   file can see them. Its one consumer, js/120-favorites.js, still
   reads this surface as globals at runtime, so the bridge republishes
   exactly the pre-conversion public surface on window. Bare-name
   lookups resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last window-reading caller has wired the read as an
   import (ADR-003). */
window.tileGuardState = tileGuardState;
window.tileGuard = tileGuard;
