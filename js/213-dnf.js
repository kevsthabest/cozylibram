/* ---- DNF Autopsy (v398): when a user marks a book DNF, a quick 3-tap
   bottom sheet captures why. Builds a personal "avoid" profile over time.
   Reasons stored on the book object (b.dnfReason, b.dnfAt) for local-first
   + synced via existing book sync. Also logged to Supabase dnf_reasons
   table for aggregate insights. ---- */

const DNF_REASONS = [
  { key: 'too_slow', label: 'Too slow', icon: '🐢' },
  { key: 'hated_trope', label: 'Hated the trope', icon: '🚫' },
  { key: 'wrong_mood', label: 'Wrong mood', icon: '🌧️' },
  { key: 'writing_style', label: "Writing style", icon: '✍️' },
  { key: 'characters', label: "Didn't connect with characters", icon: '👥' },
  { key: 'too_long', label: 'Too long', icon: '📏' },
];

function openDnfReasonSheet(b) {
  const reasonBtns = DNF_REASONS.map(r =>
    '<button class="dnf-reason-btn" data-reason="' + r.key + '">' +
    '<span class="dnf-icon">' + r.icon + '</span>' +
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

  overlay.querySelectorAll('.dnf-reason-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      saveDnfReason(b, btn.dataset.reason);
      close();
    }));
  overlay.querySelector('#dnf-skip').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function saveDnfReason(b, reasonKey) {
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

  // Supabase: log to dnf_reasons table for aggregate insights
  if (typeof supa !== 'undefined' && supa) {
    supa.from('dnf_reasons').insert({
      book_id: b.id,
      reason: reasonKey,
      progress_pct: progressPct,
    }).then(({ error }) => {
      if (error) console.warn('[dnf] Supabase log failed:', error.message);
    });
  }

  track('dnf_reason', { reason: reasonKey, progress_pct: progressPct });
  toast('Noted! ' + reason.icon + ' Your recos will learn from this.');
}

/* ---- DNF insights: "You DNF 80% of books with X" ---- */
function dnfInsightsHTML() {
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

  let html = '<div class="stat-sub">🔬 DNF Autopsy</div><div class="kv">';
  html += '<div class="kv-row"><span>Most common reason</span><b>' + esc(reasonLabel) + ' (' + pct + '%)</b></div>';
  html += '<div class="kv-row"><span>Total DNFs tracked</span><b>' + dnfs.length + '</b></div>';
  if (topDnfTrope && topDnfTrope[1] >= 2)
    html += '<div class="kv-row"><span>Trope you bail on most</span><b>' + esc(topDnfTrope[0]) + ' (' + topDnfTrope[1] + '×)</b></div>';
  html += '</div>';
  return html;
}
