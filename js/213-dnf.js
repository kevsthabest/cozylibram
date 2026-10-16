/* ---- DNF Autopsy (v398): when a user marks a book DNF, a quick 3-tap
   bottom sheet captures why. Builds a personal "avoid" profile over time.
   Reasons stored on the book object (b.dnfReason, b.dnfAt) for local-first
   + synced via existing book sync. Also logged to Supabase dnf_reasons
   table for aggregate insights. ---- */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
// icon = an ICONS glyph name (js/050), rendered via icon() — the line-art
// set themes with the UI; the old emoji here did not. (Icon sweep.)
export const DNF_REASONS = [
  { key: 'too_slow', label: 'Too slow', icon: 'hourglass' },
  { key: 'hated_trope', label: 'Hated the trope', icon: 'dnf' },
  { key: 'wrong_mood', label: 'Wrong mood', icon: 'cloud' },
  { key: 'writing_style', label: "Writing style", icon: 'pencil' },
  { key: 'characters', label: "Didn't connect with characters", icon: 'friends' },
  { key: 'too_long', label: 'Too long', icon: 'ruler' },
];

export function openDnfReasonSheet(b) {
  // Dedup: don't stack sheets if one is already open
  if (document.querySelector('.dnf-bottom-sheet')) return;
  const reasonBtns = DNF_REASONS.map(r =>
    '<button class="dnf-reason-btn" data-reason="' + r.key + '">' +
    '<span class="dnf-icon">' + icon(r.icon) + '</span>' +
    '<span class="dnf-label">' + r.label + '</span>' +
    '</button>').join('');

  const bodyHTML =
    '<div class="dnf-sheet">' +
    '<p class="dnf-title">Why the DNF?</p>' +
    '<p class="dnf-sub">Quick tap — helps your recommendations get smarter.</p>' +
    '<div class="dnf-grid">' + reasonBtns + '</div>' +
    '<button class="btn btn-ghost" id="dnf-skip" style="margin-top:16px;width:100%">Skip</button>' +
    '</div>';

  // Use the shelf sheet pattern for a bottom sheet
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = '<div class="sheet dnf-bottom-sheet">' + bodyHTML + '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
    if (typeof overlayClosed === 'function') overlayClosed(token);
  };
  const token = (typeof overlayOpened === 'function') ? overlayOpened('dnf-reason', close) : null;

  /* v513: drag-to-dismiss — the other .sheet-foundation consumer was
     missing the same wireSheetDrag wiring as the portrait sheet. */
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(overlay.querySelector('.dnf-bottom-sheet'), close);

  overlay.querySelectorAll('.dnf-reason-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      saveDnfReason(b, btn.dataset.reason);
      close();
    }));
  overlay.querySelector('#dnf-skip').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

export function saveDnfReason(b, reasonKey) {
  const reason = DNF_REASONS.find(r => r.key === reasonKey);
  if (!reason) return;
  // Guard: user may have changed status away from DNF during the sheet delay
  if (b.status !== 'dnf') return;

  // Local-first: store on the book object (syncs via existing book sync)
  b.dnfReason = reasonKey;
  b.dnfAt = new Date().toISOString();
  const progressPct = b.pageCount ? Math.round((b.progress || 0) / b.pageCount * 100) : null;
  if (progressPct != null) b.dnfProgressPct = progressPct;
  saveLibrary();

  // Supabase: log to dnf_reasons table for aggregate insights.
  // v536 (audit #12): the insert never carried user_id, but the column
  // is NOT NULL and the insert policy checks auth.uid() = user_id — so
  // every insert since v398 violated NOT NULL before RLS even ran and
  // the "aggregate insights" half of this feature silently never
  // landed. Send the signed-in user's id, and surface failures through
  // AppLog (the app's error path) instead of a lone console.warn nobody
  // reads. Signed out, there is no id the policy would accept — skip.
  const uid = (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.id) || null;
  if (uid && typeof supa !== 'undefined' && supa) {
    supa.from('dnf_reasons').insert({
      user_id: uid,
      book_id: b.id,
      reason: reasonKey,
      progress_pct: progressPct,
    }).then(({ error }) => {
      if (error) {
        try { AppLog.error('dnf', 'reason log insert failed: ' + error.message); } catch (_) {}
      }
    }).catch((err) => {
      try { AppLog.error('dnf', 'reason log network failure: ' + (err && err.message)); } catch (_) {}
    });
  }

  track('dnf_reason', { reason: reasonKey, progress_pct: progressPct });
  toast('Noted! Your recos will learn from this.');
}

/* ---- DNF insights: "You DNF 80% of books with X" ---- */
export function dnfInsightsHTML() {
  const dnfs = library.filter(b => b.status === 'dnf' && b.dnfReason);
  if (dnfs.length < 3) return '';

  const reasonCount = {};
  dnfs.forEach(b => { reasonCount[b.dnfReason] = (reasonCount[b.dnfReason] || 0) + 1; });
  const top = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0];
  const reasonLabel = (DNF_REASONS.find(r => r.key === top[0]) || {}).label || top[0];
  const pct = Math.round(top[1] / dnfs.length * 100);

  // Trope pattern in DNFs
  const dnfTropeCount = {};
  dnfs.forEach(b => (b.tropes || []).forEach(t => { dnfTropeCount[t] = (dnfTropeCount[t] || 0) + 1; }));
  const topDnfTrope = Object.entries(dnfTropeCount).sort((a, b) => b[1] - a[1])[0];

  let html = '<div class="stat-sub">' + icon('search') + ' DNF Autopsy</div><div class="kv">';
  html += '<div class="kv-row"><span>Most common reason</span><b>' + esc(reasonLabel) + ' (' + pct + '%)</b></div>';
  html += '<div class="kv-row"><span>Total DNFs tracked</span><b>' + dnfs.length + '</b></div>';
  if (topDnfTrope && topDnfTrope[1] >= 2)
    html += '<div class="kv-row"><span>Trope you bail on most</span><b>' + esc(topDnfTrope[0]) + ' (' + topDnfTrope[1] + '×)</b></div>';
  html += '</div>';
  return html;
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The classic consumers, js/150-modal-discovery.js and js/170-stats.js, call these functions at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.DNF_REASONS = DNF_REASONS;
window.openDnfReasonSheet = openDnfReasonSheet;
window.saveDnfReason = saveDnfReason;
window.dnfInsightsHTML = dnfInsightsHTML;
