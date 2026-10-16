/* ---- Trigger check (v455): a gentle one-time heads-up before starting a
   TBR book that has content warnings. Heads-up, never a gate — the reader
   always decides. The seen flag lives on the book object (b.triggerCheckSeen)
   so it's local-first and syncs via the existing book sync, like dnfReason.

   Milestones celebrate agency (checking, choosing, pausing) — see
   js/219-milestones.js aware-* (v467 replaced the old bravery framing). ---- */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
/* True when the sheet should be shown for this book: it has warnings and
   the reader hasn't seen the heads-up yet. Status-agnostic on purpose —
   callers decide which transitions qualify (Start Reading flows). */
export function triggerCheckNeeded(b) {
  if (!b || b.triggerCheckSeen) return false;
  return Array.isArray(b.contentWarnings) && b.contentWarnings.length > 0;
}

/* Shows the gentle bottom sheet. onStart() runs when the reader taps
   "Start anyway". "Not now" (or tapping the scrim) just dismisses —
   the book's status is untouched either way. One-time per book: the
   seen flag is set the moment the sheet opens. */
export function openTriggerCheckSheet(b, onStart) {
  // Dedup: don't stack sheets if one is already open
  if (document.querySelector('.tc-sheet')) return;
  // One-time: mark seen on open, so even a scrim-tap counts as "shown".
  // Respect the dismissal — we never nag twice for the same book.
  b.triggerCheckSeen = true;
  if (typeof saveLibrary === 'function') saveLibrary();

  // v535 (audit #1): the warning preferences finally apply here.
  // Prominent warnings come first and emphasised; the detail level
  // shapes how much is shown — 'gentle' (the default) is exactly the
  // pre-v535 sheet, 'detailed' adds taxonomy descriptions, and
  // 'on-request' holds the names behind an explicit reveal tap.
  const prefs = (typeof getWarningPrefs === 'function') ? getWarningPrefs() : { excluded: [], prominent: [], detail: 'gentle' };
  if (typeof primeWarningTaxonomy === 'function') {
    try {
      primeWarningTaxonomy().then(function () {
        // Never let a late taxonomy fill defeat an 'on-request' hold.
        if (prefs.detail === 'on-request' &&
            !(typeof warnIsRevealed === 'function' && warnIsRevealed(b))) return;
        const box = document.getElementById('tcTags');
        if (box && document.querySelector('.tc-sheet')) box.innerHTML = tcTagsHTML();
      }).catch(function () {});
    } catch (e) {}
  }
  const tcTagsHTML = function () {
    const ordered = (typeof warnOrderProminent === 'function')
      ? warnOrderProminent(b.contentWarnings, prefs) : (b.contentWarnings || []);
    return ordered.map(function (w) {
      const prom = (typeof warnIsProminent === 'function') && warnIsProminent(w, prefs);
      const desc = (prefs.detail === 'detailed' && typeof warnDescFor === 'function') ? warnDescFor(w) : '';
      return '<span class="tc-warn-item"><span class="warn-tag' + (prom ? ' warn-tag-prom' : '') + '">' +
        esc(String(w)) + '</span>' +
        (desc ? ' <span class="warn-desc">' + esc(desc) + '</span>' : '') + '</span>';
    }).join('');
  };
  const revealed = prefs.detail !== 'on-request' ||
    (typeof warnIsRevealed === 'function' && warnIsRevealed(b));
  const tagsBlock = revealed
    ? '<div class="warn-tags tc-tags" id="tcTags">' + tcTagsHTML() + '</div>'
    : '<div class="warn-tags tc-tags" id="tcTags"><span class="note">You\u2019ve chosen to see ' +
      'warnings only when you ask.</span></div>' +
      '<button class="btn ghost" id="tcShowWarns">Show warnings</button>';

  const bodyHTML =
    '<div class="tc-inner">' +
    '<div class="tc-glyph" aria-hidden="true">' + icon('flame') + '</div>' +
    '<p class="tc-title">A quick heads-up</p>' +
    '<p class="tc-sub">Readers flagged <b>' + esc(b.title || 'this book') + '</b> for:</p>' +
    tagsBlock +
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

  const showBtn = document.getElementById('tcShowWarns');
  if (showBtn) showBtn.addEventListener('click', function () {
    if (typeof warnReveal === 'function') warnReveal(b);
    const box = document.getElementById('tcTags');
    if (box) box.innerHTML = tcTagsHTML();
    showBtn.remove();
  });
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

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers, js/150-modal-discovery.js and js/160-roulette.js, call these functions at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.triggerCheckNeeded = triggerCheckNeeded;
window.openTriggerCheckSheet = openTriggerCheckSheet;
