/* ---- Trigger check (v455): a gentle one-time heads-up before starting a
   TBR book that has content warnings. Heads-up, never a gate — the reader
   always decides. The seen flag lives on the book object (b.triggerCheckSeen)
   so it's local-first and syncs via the existing book sync, like dnfReason.

   Milestones celebrate agency (checking, choosing, pausing) — see
   js/219-milestones.js aware-* (v467 replaced the old bravery framing). ---- */

/* True when the sheet should be shown for this book: it has warnings and
   the reader hasn't seen the heads-up yet. Status-agnostic on purpose —
   callers decide which transitions qualify (Start Reading flows). */
function triggerCheckNeeded(b) {
  if (!b || b.triggerCheckSeen) return false;
  return Array.isArray(b.contentWarnings) && b.contentWarnings.length > 0;
}

/* Shows the gentle bottom sheet. onStart() runs when the reader taps
   "Start anyway". "Not now" (or tapping the scrim) just dismisses —
   the book's status is untouched either way. One-time per book: the
   seen flag is set the moment the sheet opens. */
function openTriggerCheckSheet(b, onStart) {
  // Dedup: don't stack sheets if one is already open
  if (document.querySelector('.tc-sheet')) return;
  // One-time: mark seen on open, so even a scrim-tap counts as "shown".
  // Respect the dismissal — we never nag twice for the same book.
  b.triggerCheckSeen = true;
  if (typeof saveLibrary === 'function') saveLibrary();

  const tags = (b.contentWarnings || []).map(function (w) {
    return '<span class="warn-tag">' + esc(String(w)) + '</span>';
  }).join('');

  const bodyHTML =
    '<div class="tc-inner">' +
    '<div class="tc-emoji" aria-hidden="true">🕯️</div>' +
    '<p class="tc-title">A quick heads-up</p>' +
    '<p class="tc-sub">Readers flagged <b>' + esc(b.title || 'this book') + '</b> for:</p>' +
    '<div class="warn-tags tc-tags">' + tags + '</div>' +
    '<p class="tc-note">No pressure — just wanted you to know before you dive in. Take it at your own pace. 🤎</p>' +
    '<button class="btn tc-start" id="tcStart">Start anyway</button>' +
    '<button class="btn ghost tc-later" id="tcLater">Not now</button>' +
    '</div>';

  const scrim = document.createElement('div');
  scrim.className = 'sv-scrim'; scrim.id = 'tcScrim';
  const sheet = document.createElement('div');
  sheet.className = 'sv-sheet tc-sheet'; sheet.id = 'tcSheet';
  sheet.innerHTML = bodyHTML;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { sheet.classList.add('open'); });
  else sheet.classList.add('open');

  const close = function () {
    sheet.classList.remove('open');
    setTimeout(function () {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    }, 250);
    if (typeof overlayClosed === 'function') overlayClosed(token);
  };
  const token = (typeof overlayOpened === 'function') ? overlayOpened('trigger-check', close) : null;

  /* v513: drag-to-dismiss — standing app rule: every sheet wires the
     shared helper. Same outcome as a scrim tap: shown, then dismissed. */
  if (typeof wireSheetDrag === 'function') wireSheetDrag(sheet, close);

  document.getElementById('tcStart').addEventListener('click', function () {
    close();
    if (typeof onStart === 'function') onStart();
  });
  document.getElementById('tcLater').addEventListener('click', function () {
    // v468: self-reported deferral — feeds "The Right Time" portrait milestone
    // (never inferred from inactivity).
    try { b.triggerCheckDeferred = true; if (typeof saveLibrary === 'function') saveLibrary(); } catch (e) {}
    close();
  });
  scrim.addEventListener('click', close);
}
