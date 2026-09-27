'use strict';

/* ---------------- tile guard (v57) ----------------
   Guarantees uniform 2:3 cover boxes in the library grid even if a stale
   styles.css is ever applied on a device. After the grid renders, it measures
   the real .bt-cover boxes; if they are not 2:3 (stale CSS), it forces the
   height via inline style. When the CSS is correct this is a no-op.
   The outcome is recorded for the Settings → App diagnostics. */
var tileGuardState = 'not-run'; // not-run | css-ok | fixed

function tileGuard() {
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
