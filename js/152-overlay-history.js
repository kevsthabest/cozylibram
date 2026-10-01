/* ---- overlay history (v220): Android's system back-gesture must close the
   topmost overlay instead of navigating away. The SPA keeps its routes in
   memory (no hash routing), so without this the back gesture pops the
   document history — dropping Kevin to whatever page was open before the app.

   Design: every overlay registers with overlayOpened(slot, domCloser), which
   pushes a SAME-URL history entry (no URL/hash change, so no routing fires).
   A single global popstate listener then closes the topmost overlay when the
   gesture pops that entry. Programmatic closes (x / backdrop / Escape /
   swipe-down) consume their entry via history.back() behind a suppression
   flag, so no phantom entries linger. Sequential handoffs (preview +TBR ->
   real modal, collection row -> book modal) use overlayReplace: the new
   overlay adopts the old one's entry — exactly one entry per visible
   overlay, with no back()/pushState() race.

   Slots group overlays that replace each other in place: 'modal-root'
   covers BOTH the real book modal and the v219 preview modal, so a
   re-render (e.g. jumping to a similar book) swaps the closer without
   pushing a second entry.

   With no overlay open the popstate handler does nothing — normal history
   navigation is untouched. Where history.pushState is unavailable the
   manager degrades silently: overlays still open/close, the gesture just
   can't reach them. ---- */

let ovStack = []; // [{ token, slot, domCloser, pushed }]
let ovSeq = 0;
let ovSuppressPop = false; // our own history.back() is in flight — swallow its popstate
let ovAdoptNext = false; // overlayReplace armed: next overlayOpened adopts instead of pushing

function ovHistoryUsable() {
  try {
    return typeof window !== 'undefined' && !!window.history &&
      typeof window.history.pushState === 'function' &&
      typeof window.history.back === 'function';
  } catch (e) { return false; }
}

// Register an opening overlay. Returns its token; the caller passes the
// token to overlayClosed / overlayIsTop / overlayReplace. domCloser must do
// DOM teardown ONLY (no history) — the manager owns the history entry.
function overlayOpened(slot, domCloser) {
  const top = ovStack[ovStack.length - 1];
  if (top && top.slot === slot) {
    top.domCloser = domCloser; // same-slot re-render: keep the single entry
    return top.token;
  }
  const token = 'ov' + (++ovSeq);
  const adopt = ovAdoptNext; ovAdoptNext = false;
  let pushed = !!adopt; // adopted entries already own a history entry
  if (!adopt && ovHistoryUsable()) {
    try { window.history.pushState({ cozyOverlay: token }, ''); pushed = true; }
    catch (e) { pushed = false; }
  }
  ovStack.push({ token: token, slot: slot, domCloser: domCloser, pushed: pushed });
  return token;
}

// Programmatic close: drop the entry; if it was topmost, consume its history
// entry so a later back-gesture doesn't hit a phantom. A buried non-top close
// leaves its entry inert (self-heals as one dead gesture) rather than
// stealing a live overlay's entry via history.back().
function overlayClosed(token) {
  const i = ovStack.findIndex(function (e) { return e.token === token; });
  if (i === -1) return false;
  const wasTop = i === ovStack.length - 1;
  const entry = ovStack.splice(i, 1)[0];
  if (wasTop && entry.pushed && ovHistoryUsable()) {
    ovSuppressPop = true;
    try { window.history.back(); }
    catch (e) { ovSuppressPop = false; }
  }
  return true;
}

// True when token is the visible overlay — Escape handlers use this so only
// the topmost overlay answers Escape (no double-close through a stack).
function overlayIsTop(token) {
  const top = ovStack[ovStack.length - 1];
  return !!top && top.token === token;
}

// Sequential handoff: tear the old overlay's DOM down first, then call
// overlayReplace(oldToken, openFn) — openFn's overlay adopts the old one's
// history entry. If openFn opens nothing, the leftover entry self-heals.
function overlayReplace(oldToken, openFn) {
  const i = ovStack.findIndex(function (e) { return e.token === oldToken; });
  const pushed = i !== -1 ? ovStack.splice(i, 1)[0].pushed : false;
  ovAdoptNext = pushed;
  try { openFn(); } finally { ovAdoptNext = false; }
}

// System back-gesture (or any popstate): the browser already popped the
// entry — close the topmost overlay's DOM and keep the URL where it is.
function __overlayOnPopState() {
  if (ovSuppressPop) { ovSuppressPop = false; return; }
  const top = ovStack.pop();
  if (top && typeof top.domCloser === 'function') {
    try { top.domCloser(); } catch (e) { /* never break navigation */ }
  }
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('popstate', __overlayOnPopState);
}

// v224 (UX-23): full-view routes (author detail, series view) are not
// overlays, but the Android back-gesture still needs somewhere to go —
// without a history entry the gesture exits the app. A route registers a
// 'route' slot entry whose closer navigates back; any go() consumes it.
let routeBackToken = null;
let routeBackFn = null;
function routeBackOpened(onBack) {
  // Re-renders (e.g. the series filter chips) keep the existing entry and
  // just refresh where it leads — only the first open pushes history.
  if (routeBackToken) { routeBackFn = onBack; return; }
  routeBackFn = onBack;
  routeBackToken = overlayOpened('route', () => {
    routeBackToken = null;
    const fn = routeBackFn; routeBackFn = null;
    try { fn(); } catch (e) { /* never break navigation */ }
  });
}
function routeBackClosed() {
  if (routeBackToken) { overlayClosed(routeBackToken); routeBackToken = null; routeBackFn = null; }
}

// Test-only introspection (not part of the app contract).
function __overlayHistoryReset() {
  ovStack = []; ovSuppressPop = false; ovAdoptNext = false;
}
function __overlayStackDepth() { return ovStack.length; }
