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
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const SHEET_DISMISS_PX = 120; // drag distance that dismisses the sheet
export const SHEET_FLICK_V = 0.55;   // px/ms downward velocity that dismisses (a flick)
// Pure decision logic — testable in node.
export function shouldDismissDrag(dy, v, scrollTop) {
  if (dy <= 0 || scrollTop > 0) return false;
  return dy >= SHEET_DISMISS_PX || v >= SHEET_FLICK_V;
}
// Idempotent: safe to call on every re-render (e.g. jumping to a similar
// book re-renders without closing first); one unlock releases the lock.
export let bodyScrollLocked = false, bodyScrollPrev = '';
export function lockBodyScroll() {
  if (bodyScrollLocked || typeof document === 'undefined') return;
  bodyScrollLocked = true;
  bodyScrollPrev = document.body.style.overflow || '';
  document.body.style.overflow = 'hidden';
}
export function unlockBodyScroll() {
  if (!bodyScrollLocked || typeof document === 'undefined') return;
  bodyScrollLocked = false;
  document.body.style.overflow = bodyScrollPrev;
}
/* v511: a drag that starts inside a horizontally scrollable descendant
   (a chip row, a similar-books rail) belongs to that scroller, not to
   the sheet — walk from the touch target up to the sheet and refuse
   the dismiss gesture for such starts. Generic: any descendant whose
   content overflows horizontally with overflow-x auto/scroll. */
export function sheetDragStartsInHScroller(sheet, el) {
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
export function wireSheetDrag(sheet, onDismiss) {
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

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this file
   can see them. The consumers — 134-verify.js, 136-coverpicker.js,
   138-editions.js, 139-import-concierge.js, 150-modal-discovery.js,
   162-charlab.js, 180-settings.js, 195-coven.js, 205-shelfview.js,
   213-dnf.js, 221-trigger-check.js, 223-community-corpus-ui.js,
   226-dna-survey.js, 228-portrait-share.js, 236-sticker-picker.js,
   237-handles.js, 239-finale.js and 241-book-ambience.js — reach these
   names at runtime, so the bridge republishes exactly the pre-conversion
   public surface on window. Bare-name lookups in classic scripts resolve
   through the global object, so the caller needs no changes. Module scripts
   are deferred, so the bridge is in place before any consumer can run.
   Remove a name from this bridge only when its last classic caller is gone.
 */
window.SHEET_DISMISS_PX = SHEET_DISMISS_PX;
window.SHEET_FLICK_V = SHEET_FLICK_V;
window.shouldDismissDrag = shouldDismissDrag;
window.bodyScrollLocked = bodyScrollLocked;
window.bodyScrollPrev = bodyScrollPrev;
window.lockBodyScroll = lockBodyScroll;
window.unlockBodyScroll = unlockBodyScroll;
window.sheetDragStartsInHScroller = sheetDragStartsInHScroller;
window.wireSheetDrag = wireSheetDrag;
