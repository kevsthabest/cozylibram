'use strict';

/* js/166-logs.js — Logs: one tab of the Observatory (admin), the
 * on-device log viewer.
 *
 * renderLogsTab() draws AppLog's entries (js/002-log.js) newest-first
 * with a level filter (all / warnings and up / errors only), capped
 * at the newest 150, plus refresh and clear controls. The log lives
 * on this device only and nothing here uploads anything — which sets
 * the tab's diagnostic contract: reproduce the problem first, then
 * open this tab before clearing site data, because clearing wipes
 * the log along with everything else.
 *
 * The Observatory shell in js/199-admin.js dispatches here at runtime
 * (adminTab === 'logs') and is this file's only caller; it still
 * reads renderLogsTab through the window bridge at the bottom of
 * this file. The file shares no state with the shell: adminLogFilter
 * is its one piece of module state, so a chosen filter survives
 * repaints. This file's own outbound reads are wired as real
 * imports — AppLog from js/002-log.js, the rest from
 * js/050-helpers.js (see ADR-003).
 */
import { AppLog } from './002-log.js';
import { confirmModal, esc, icon } from './050-helpers.js';
export let adminLogFilter = 'all'; // all | warn | error
export function renderLogsTab() {
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

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its one consumer, js/199-admin.js, calls renderLogsTab() at runtime and still reads it as a global, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last window-reading caller has wired the read as an import
   (ADR-003). */
window.adminLogFilter = adminLogFilter;
window.renderLogsTab = renderLogsTab;
