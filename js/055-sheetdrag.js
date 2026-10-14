'use strict';

/* ---------------- sheet drag-to-dismiss + body scroll lock ----------------
   Extracted from js/150-modal-discovery.js (v553): this is shared UI
   machinery — every sheet/modal in the app wires its swipe-down-to-dismiss
   gesture through wireSheetDrag — so it lives in its own early module,
   loaded before all consumers (first consumer is js/134). Pure relocation:
   function names, signatures and behaviour unchanged. */
/* ---- v215: bottom-sheet drag-to-dismiss (touch only) + background scroll lock.
   The sheet follows the finger only when its scrollable content is at the
   very top (scrollTop <= 0) — otherwise the gesture is a normal content
   scroll. Desktop keeps the close button; no mouse-drag. Gesture feel needs
   on-phone QA; the decision math below is unit-tested. ---- */
const SHEET_DISMISS_PX = 120; // drag distance that dismisses the sheet
const SHEET_FLICK_V = 0.55;   // px/ms downward velocity that dismisses (a flick)
// Pure decision logic — testable in node.
function shouldDismissDrag(dy, v, scrollTop) {
  if (dy <= 0 || scrollTop > 0) return false;
  return dy >= SHEET_DISMISS_PX || v >= SHEET_FLICK_V;
}
// Idempotent: safe to call on every re-render (e.g. jumping to a similar
// book re-renders without closing first); one unlock releases the lock.
let bodyScrollLocked = false, bodyScrollPrev = '';
function lockBodyScroll() {
  if (bodyScrollLocked || typeof document === 'undefined') return;
  bodyScrollLocked = true;
  bodyScrollPrev = document.body.style.overflow || '';
  document.body.style.overflow = 'hidden';
}
function unlockBodyScroll() {
  if (!bodyScrollLocked || typeof document === 'undefined') return;
  bodyScrollLocked = false;
  document.body.style.overflow = bodyScrollPrev;
}
/* v511: a drag that starts inside a horizontally scrollable descendant
   (a chip row, a similar-books rail) belongs to that scroller, not to
   the sheet — walk from the touch target up to the sheet and refuse
   the dismiss gesture for such starts. Generic: any descendant whose
   content overflows horizontally with overflow-x auto/scroll. */
function sheetDragStartsInHScroller(sheet, el) {
  try {
    while (el && el.nodeType === 1) {
      if (el.scrollWidth > el.clientWidth + 1 &&
          typeof window !== 'undefined' && window.getComputedStyle) {
        const ox = window.getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      if (el === sheet) break;
      el = el.parentElement;
    }
  } catch (e) { /* detection failure must never break dismiss */ }
  return false;
}
function wireSheetDrag(sheet, onDismiss) {
  if (!sheet || typeof window === 'undefined' || !('ontouchstart' in window)) return;
  let y0 = null, x0 = null, t0 = 0, dragging = false, dy = 0, refused = false;
  const cancel = () => {
    y0 = null; x0 = null; dragging = false; dy = 0; refused = false;
    sheet.style.transition = ''; sheet.style.transform = '';
  };
  sheet.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; t0 = e.timeStamp;
    dragging = false; dy = 0;
    refused = sheetDragStartsInHScroller(sheet, e.target);
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (y0 == null || e.touches.length !== 1) { if (e.touches.length !== 1) cancel(); return; }
    if (refused) return; // gesture belongs to a nested horizontal scroller
    const d = e.touches[0].clientY - y0;
    if (!dragging) {
      if (d < 10 || sheet.scrollTop > 0) return; // not a top-of-sheet downward swipe
      /* v511: a predominantly horizontal gesture is a swipe at content,
         not a dismiss — refuse it for the rest of this touch, exactly
         as the browser hands it to the horizontal scroller. */
      if (x0 != null && Math.abs(e.touches[0].clientX - x0) > Math.abs(d)) { refused = true; return; }
      dragging = true;
      // Re-anchor: the sheet starts following from this finger position so it
      // can't jump if the gesture reached the top mid-swipe.
      y0 = e.touches[0].clientY; t0 = e.timeStamp; dy = 0;
      sheet.style.transition = 'none';
      return;
    }
    if (d <= 0) { // finger came back up — hand the gesture back, re-anchor
      dragging = false; dy = 0;
      sheet.style.transition = ''; sheet.style.transform = '';
      y0 = e.touches[0].clientY; t0 = e.timeStamp;
      return;
    }
    dy = d;
    // passive:false — stop scroll chaining so the library behind can't move.
    if (e.cancelable) e.preventDefault();
    sheet.style.transform = 'translateY(' + d + 'px)';
  }, { passive: false });
  sheet.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dt = Math.max(1, (e.timeStamp || 0) - t0);
    const dist = dy, v = dist / dt, wasDragging = dragging;
    y0 = null; x0 = null; dragging = false; dy = 0; refused = false;
    if (!wasDragging) return;
    if (shouldDismissDrag(dist, v, sheet.scrollTop)) {
      sheet.style.transition = 'transform .18s ease-in';
      sheet.style.transform = 'translateY(110%)';
      setTimeout(onDismiss, 190);
    } else { // spring back
      sheet.style.transition = ''; sheet.style.transform = '';
    }
  }, { passive: true });
  sheet.addEventListener('touchcancel', cancel, { passive: true });
}
