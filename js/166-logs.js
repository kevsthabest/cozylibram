'use strict';

/* ---------------- Logs (v167) ----------------
   The Observatory's Logs tab, extracted into its own module
   (architecture candidate 6, final piece): the on-device
   log viewer — the render path is renderLogsTab(),
   dispatched from the Observatory shell in js/199-admin.js
   (adminTab === 'logs'). It reads AppLog (js/002-log.js) at
   runtime and shares no state with the shell, which is why
   it travels as its own zone. Nothing else moves: the shell
   and the other tabs stay in js/199 (the Trope, Character,
   Analytics, Spine Lab and Edition Assets tabs live in
   js/161–165). Load order: after js/165 and before js/199
   (whose dispatch calls renderLogsTab at runtime); every
   cross-file reference is a runtime call through the shared
   global scope — this file declares only its own state at
   eval time. */

/* ---------------- v167: on-device log viewer ----------------
   Read AppLog (js/002-log.js). On this device only — nothing is uploaded.
   Reproduce the problem first, then open this tab before clearing site
   data (clearing wipes the log along with everything else). */
let adminLogFilter = 'all'; // all | warn | error
function renderLogsTab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  const paint = () => {
    const level = adminLogFilter === 'all' ? 'info' : adminLogFilter;
    const entries = AppLog.entries(level);
    const filtBtn = (id, label) =>
      '<button class="btn sm' + (adminLogFilter === id ? '' : ' ghost') + '" data-logf="' + id + '">' + label + '</button>';
    const shown = entries.slice(0, 150);
    const rows = shown.map(e =>
      '<div class="log-row"><span class="log-time">' + esc(new Date(e.t).toLocaleString()) + '</span>' +
      '<span class="log-badge ' + e.level + '">' + e.level + '</span>' +
      '<span class="log-tag">' + esc(e.tag) + '</span>' +
      '<span class="log-msg">' + esc(e.msg) + '</span></div>').join('');
    body.innerHTML =
      '<div class="ob-card"><h3>' + icon('warn') + ' Error &amp; activity log</h3>' +
      '<p class="note">On this device only — these entries never leave your device. Newest first. ' +
      'Cover changes, sync pushes, and uncaught errors all land here.</p>' +
      '<div class="log-tools">' +
      filtBtn('all', 'All') + filtBtn('warn', 'Warnings+') + filtBtn('error', 'Errors only') +
      '<button class="btn sm ghost" id="log-refresh">Refresh</button>' +
      '<button class="btn sm ghost" id="log-clear">Clear log</button>' +
      '<span class="note">' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') +
      (entries.length > shown.length ? ' (showing ' + shown.length + ')' : '') + '</span>' +
      '</div>' +
      (rows ? '<div class="log-list">' + rows + '</div>'
            : '<p class="note">No log entries at this level yet.</p>') +
      '</div>';
    body.querySelectorAll('[data-logf]').forEach(b => b.addEventListener('click', () => {
      adminLogFilter = b.dataset.logf;
      paint();
    }));
    const refresh = document.getElementById('log-refresh');
    if (refresh) refresh.addEventListener('click', paint);
    const clear = document.getElementById('log-clear');
    if (clear) clear.addEventListener('click', async () => {
      if (await confirmModal('Clear the on-device log?', { okLabel: 'Clear' })) { AppLog.clear(); paint(); }
    });
  };
  paint();
}
