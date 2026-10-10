/* 219-shelf3d-drag.js — pure drag primitives for the 3D shelf.
   Extracted from js/215-shelf3d.js (v432 code-health split) so the drag
   collision zone is testable in Node with synthetic events.

   Classic script, no modules. Exposes:
     window.Shelf3DDrag = {
       pressHoldToDrag(el, startFn, holdMs, holdSlop),
       slopExceeded(sx, sy, x, y, slop),
       computeRestY(levels, pi, isEdge)
     }

   All functions are pure (no closure state, no DOM globals beyond the
   element passed in), so they can be unit-tested without a browser. */

'use strict';

(function () {

  /* Slop check: has the pointer moved far enough to count as a scroll/drag
     rather than a tap? Pure math — extracted from pressHoldToDrag. */
  function slopExceeded(sx, sy, x, y, slop) {
    return Math.hypot(x - sx, y - sy) > slop;
  }

  /* Rest-Y computation for cross-shelf drags (v422 fix, extracted v432).
     When a dragged decoration enters another shelf, its rest height must
     follow the new shelf's level (plus the edge-decoration offset), or it
     snaps back vertically on drop. */
  function computeRestY(levels, pi, isEdge) {
    return levels[pi] + (isEdge ? 0.06 : 0);
  }

  /* Press-and-hold to drag (v420, extracted v432).
     Quick swipe scrolls the list; holding ~280ms grabs the item for dragging.
     If the finger moves beyond slop before the timer, it's a scroll and the
     hold is cancelled (with a swipe-suppression flag so the follow-up click
     doesn't fire tap-to-place, v427).
     Only for touch — mouse can drag immediately. */
  function pressHoldToDrag(el, startFn, holdMs, holdSlop) {
    var HOLD_MS = (typeof holdMs === 'number') ? holdMs : 280;
    var HOLD_SLOP = (typeof holdSlop === 'number') ? holdSlop : 10;
    var timer = null, sx = 0, sy = 0;
    el.addEventListener('pointerdown', function (e) {
      // Only for touch — mouse can drag immediately.
      if (e.pointerType !== 'touch') { startFn(e); return; }
      sx = e.clientX; sy = e.clientY;
      // v427: clear any stale swipe-suppression flag from a previous interaction.
      delete el.dataset.swiped;
      timer = setTimeout(function () {
        timer = null;
        startFn(e);
      }, HOLD_MS);
      var onMove = function (me) {
        if (slopExceeded(sx, sy, me.clientX, me.clientY, HOLD_SLOP)) {
          // Moved — it's a scroll, cancel the hold.
          // v427: mark as swiped so the follow-up click doesn't fire tap-to-place.
          if (timer) { clearTimeout(timer); timer = null; }
          el.dataset.swiped = '1';
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onUp);
        }
      };
      var onUp = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  window.Shelf3DDrag = {
    pressHoldToDrag: pressHoldToDrag,
    slopExceeded: slopExceeded,
    computeRestY: computeRestY
  };

})();
