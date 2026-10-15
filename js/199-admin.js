'use strict';

/* ---------------- Libram Observatory (v119) ----------------
   The admin analytics dashboard. First-party product analytics only:
   usage counts and funnels, never book content.

   Access control is layered:
   - Server: RLS — only admins (app_admins via is_admin()) can SELECT
     analytics_events at all. Non-admins get zero rows, enforced by Postgres.
   - Client: refreshAdminStatus() probes app_admins (itself RLS-gated) and
     only then shows the Observatory menu entry; renderAdmin() refuses to
     fetch or render data for non-admins.
   Aggregation is client-side over a capped raw fetch (limit 20000) — the
   right size for tens to hundreds of users, with no extra SQL surface. */

let isAppAdmin = false; // per-session; resolved by refreshAdminStatus()
let adminTab = 'analytics'; // analytics | tropes | curation | logs | spine | assets | characters

async function refreshAdminStatus() {
  isAppAdmin = false;
  try {
    if (typeof cloudUser === 'undefined' || !cloudUser) return;
    const sb = await cloudClient().catch(() => null);
    if (!sb) return;
    // app_admins is SELECT-gated to admins by RLS: empty/error = not admin.
    const { data, error } = await sb.from('app_admins').select('user_id').limit(1);
    if (!error && data && data.length) isAppAdmin = true;
  } catch (e) { isAppAdmin = false; }
}

/* ---------------- Analytics ----------------
   The Analytics tab (range state + caches, fetch +
   aggregation, renderers, renderAdminBody) moved to
   js/163-analytics.js (architecture candidate 6). This file
   keeps the Observatory shell and the other tabs;
   renderAdmin() still dispatches to renderAdminBody() there. */

function renderAdmin() {
  if (!signedIn() || !isAppAdmin) {
    setView('<div class="view-head"><h2 class="serif">' + icon('chart') + ' Libram Observatory</h2></div>' +
      '<div class="empty"><div class="big">' + icon('eyeoff') + '</div>' +
      '<h2 class="serif">Restricted area</h2><p>This dashboard is only visible to app administrators.</p></div>');
    return;
  }
  const ranges = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time'], ['custom', 'Custom']];
  const rangesHTML = '<div class="ob-ranges">' + ranges.map(r =>
      '<button class="btn sm' + (adminRange === r[0] ? '' : ' ghost') + '" data-range="' + r[0] + '">' + r[1] + '</button>').join('') +
    (adminRange === 'custom'
      ? '<input type="date" id="ob-from" class="text-input sm" value="' + esc(adminCustomFrom) + '">' +
        '<input type="date" id="ob-to" class="text-input sm" value="' + esc(adminCustomTo) + '">' +
        '<button class="btn sm" id="ob-apply">Apply</button>'
      : '') + '</div>';
  setView('<div class="view-head"><h2 class="serif">' + icon('chart') + ' Libram Observatory</h2>' +
    '<p class="note">Admin only · usage counts, never book content</p></div>' +
    '<div class="ob-ranges">' +
    '<button class="btn sm' + (adminTab === 'analytics' ? '' : ' ghost') + '" data-atab="analytics">Analytics</button>' +
    '<button class="btn sm' + (adminTab === 'tropes' ? '' : ' ghost') + '" data-atab="tropes">' + icon('bulb') + ' Trope Lab</button>' +
    '<button class="btn sm' + (adminTab === 'curation' ? '' : ' ghost') + '" data-atab="curation">' + icon('inbox') + ' Curation</button>' +
    '<button class="btn sm' + (adminTab === 'spine' ? '' : ' ghost') + '" data-atab="spine">' + icon('camera') + ' Spine Lab</button>' +
    '<button class="btn sm' + (adminTab === 'characters' ? '' : ' ghost') + '" data-atab="characters">' + icon('friends') + ' Characters</button>' +
    '<button class="btn sm' + (adminTab === 'assets' ? '' : ' ghost') + '" data-atab="assets">Edition Assets</button>' +
    '<button class="btn sm' + (adminTab === 'logs' ? '' : ' ghost') + '" data-atab="logs">' + icon('warn') + ' Logs</button>' +
    '</div>' +
    (adminTab === 'analytics' ? rangesHTML : '') +
    '<div id="ob-body"><p class="note">Loading…</p></div>');
  document.querySelectorAll('[data-atab]').forEach(b => b.addEventListener('click', () => {
    adminTab = b.dataset.atab;
    renderAdmin();
  }));
  document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
    adminRange = b.dataset.range;
    if (adminRange !== 'custom') renderAdmin();
    else renderAdmin(); // show the date inputs
  }));
  const apply = document.getElementById('ob-apply');
  if (apply) apply.addEventListener('click', () => {
    adminCustomFrom = document.getElementById('ob-from').value || '';
    adminCustomTo = document.getElementById('ob-to').value || '';
    adminRowsCache = {}; adminAggCache = {};
    renderAdminBody();
  });
  if (adminTab === 'tropes') renderTropeLab();
  else if (adminTab === 'curation' && typeof renderCurationQueue === 'function') renderCurationQueue();
  else if (adminTab === 'characters') renderCharacterLab();
  else if (adminTab === 'spine') renderSpineLab();
  else if (adminTab === 'assets') renderEditionAssetLab();
  else if (adminTab === 'logs') renderLogsTab();
  else renderAdminBody();
}

/* ---------------- Logs ----------------
   The Logs tab (on-device log viewer, renderLogsTab)
   moved to js/166-logs.js (architecture candidate 6).
   This file keeps the Observatory shell and the other
   tabs; renderAdmin() still dispatches adminTab === 'logs'
   to renderLogsTab() there. */

/* ---------------- User moderation (v246) ----------------
   Abuse reports filed from the coven tab land here, and admins can
   ban (reversible), unban, or permanently delete users. Banned users
   are signed out client-side and rejected by every /api/* function. */

let adminModCache = null; // { reports, banned, bannedById }

// v248: admin-only user directory (user_id -> email), so the moderation UI
// can identify users instead of showing truncated IDs.
let adminUserDir = {};
function modUserLabel(uid) {
  const e = adminUserDir[uid];
  return e ? e : String(uid).slice(0, 8);
}

async function fetchUserDirectory() {
  try {
    const r = await apiFetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list_users' }),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && Array.isArray(j.users)) {
      adminUserDir = {};
      j.users.forEach(u => { if (u.user_id) adminUserDir[u.user_id] = u.email || ''; });
    }
  } catch (e) { /* directory unavailable — truncated IDs it is */ }
}

async function fetchModeration() {
  if (adminModCache) return adminModCache;
  try {
    const sb = await cloudClient().catch(() => null);
    if (!sb) throw new Error('offline');
    const [rep, ban] = await Promise.all([
      sb.from('user_reports').select('id,reporter_id,reported_user_id,reason,details,created_at')
        .eq('status', 'open').order('created_at', { ascending: false }).limit(200),
      sb.from('banned_users').select('user_id,reason,banned_at,banned_by')
        .order('banned_at', { ascending: false }),
    ]);
    if (rep.error) throw rep.error;
    if (ban.error) throw ban.error;
    const bannedById = {};
    (ban.data || []).forEach(b => { bannedById[b.user_id] = true; });
    adminModCache = { reports: rep.data || [], banned: ban.data || [], bannedById };
  } catch (e) {
    // Moderation tables missing or unreachable — the rest of the
    // dashboard still works.
    adminModCache = { reports: [], banned: [], bannedById: {} };
  }
  await fetchUserDirectory(); // v248: best-effort, fails soft
  return adminModCache;
}

const REPORT_REASON_LABELS = {
  spam: 'Spam', harassment: 'Harassment', inappropriate: 'Inappropriate content',
  fake_account: 'Fake account', other: 'Other',
};

/* Pure: moderation data -> HTML cards. */
function moderationHTML(mod) {
  const rl = r => REPORT_REASON_LABELS[r] || r;
  const reportRows = mod.reports.map(r =>
    '<tr><td>' + esc(modUserLabel(r.reported_user_id)) + '</td>' +
    '<td>' + esc(modUserLabel(r.reporter_id)) + '</td>' +
    '<td>' + esc(rl(r.reason)) + '</td>' +
    '<td>' + esc(String(r.details || '').slice(0, 80)) + '</td>' +
    '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
    '<td class="nowrap"><button class="btn ghost sm" data-mod-report-ban="' + esc(r.id) +
      '" data-uid="' + esc(r.reported_user_id) + '">Ban</button> ' +
    '<button class="btn ghost sm" data-mod-dismiss="' + esc(r.id) + '">Dismiss</button></td></tr>').join('');
  const bannedRows = mod.banned.map(b =>
    '<tr><td>' + esc(modUserLabel(b.user_id)) + '</td>' +
    '<td>' + esc(b.reason || '—') + '</td>' +
    '<td>' + esc(fmtDate(b.banned_at)) + '</td>' +
    '<td class="nowrap"><button class="btn ghost sm" data-mod-unban="' + esc(b.user_id) + '">Unban</button> ' +
    '<button class="btn ghost sm danger" data-mod-delete="' + esc(b.user_id) + '">Delete</button></td></tr>').join('');
  let html = '<div class="ob-card"><h3 class="serif">Reports</h3>' +
    '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Reported user</th><th>Reporter</th>' +
    '<th>Reason</th><th>Details</th><th>Filed</th><th></th></tr></thead>' +
    '<tbody>' + (reportRows || '<tr><td colspan="6" class="note">No open reports.</td></tr>') + '</tbody></table></div>' +
    '<p class="note">Users report each other from the ' + esc(covenName()) + ' tab — abuse reports land here for review.</p></div>';
  if (mod.banned.length) {
    html += '<div class="ob-card"><h3 class="serif">Banned users</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>User</th><th>Reason</th><th>Banned</th><th></th></tr></thead>' +
      '<tbody>' + bannedRows + '</tbody></table></div>' +
      '<p class="note">Banned users are signed out and blocked from every /api/* endpoint. ' +
      'Delete removes the account and all of its data permanently — it cannot be undone.</p></div>';
  }
  return html;
}

async function modBan(uid) {
  const sb = await cloudClient();
  const { error } = await sb.from('banned_users').insert({
    user_id: uid, reason: 'manual ban from Observatory', banned_by: (cloudUser && cloudUser.id) || null,
  });
  if (error) throw error;
}
async function modUnban(uid) {
  const sb = await cloudClient();
  const { error } = await sb.from('banned_users').delete().eq('user_id', uid);
  if (error) throw error;
}
async function modSetReportStatus(id, status) {
  const sb = await cloudClient();
  const { error } = await sb.from('user_reports').update({
    status, handled_by: (cloudUser && cloudUser.id) || null, handled_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}
async function modDeleteUser(uid) {
  const r = await apiFetch('/api/admin-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete_user', target_user_id: uid }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
}

function wireModeration(body) {
  const refresh = async () => { adminModCache = null; await renderAdminBody(); };
  const run = async (label, fn) => {
    try { await fn(); toast(label); await refresh(); }
    catch (e) { toast('Couldn\u2019t: ' + ((e && e.message) || e)); }
  };
  body.querySelectorAll('[data-mod-ban]').forEach(b => b.addEventListener('click', async () => {
    // v352: in-app confirm
    if (!await confirmModal('Ban user ' + modUserLabel(b.dataset.modBan) + '? They will be signed out immediately.', { okLabel: 'Ban' })) return;
    run('User banned', () => modBan(b.dataset.modBan));
  }));
  body.querySelectorAll('[data-mod-unban]').forEach(b => b.addEventListener('click', () => {
    run('User unbanned', () => modUnban(b.dataset.modUnban));
  }));
  body.querySelectorAll('[data-mod-dismiss]').forEach(b => b.addEventListener('click', () => {
    run('Report dismissed', () => modSetReportStatus(b.dataset.modDismiss, 'dismissed'));
  }));
  body.querySelectorAll('[data-mod-report-ban]').forEach(b => b.addEventListener('click', async () => {
    if (!await confirmModal('Ban user ' + modUserLabel(b.dataset.uid) + '? They will be signed out immediately.', { okLabel: 'Ban' })) return;
    run('User banned', async () => {
      await modBan(b.dataset.uid);
      await modSetReportStatus(b.dataset.modReportBan, 'actioned');
    });
  }));
  body.querySelectorAll('[data-mod-delete]').forEach(b => b.addEventListener('click', async () => {
    const uid = b.dataset.modDelete, label = modUserLabel(uid);
    if (!await confirmModal('DELETE user ' + label + ' permanently?\n\nThis wipes their library and deletes their account. It cannot be undone.', { okLabel: 'Delete' })) return;
    if (!await confirmModal('Last chance \u2014 really delete ' + label + '?', { okLabel: 'Yes, delete' })) return;
    run('User deleted', () => modDeleteUser(uid));
  }));
}

/* Pure: user activity rows with Ban/Unban + Delete actions. */
function userActivityRowsHTML(activity, bannedById) {
  return activity.slice(0, 50).map(u => {
    const toggle = bannedById[u.uid]
      ? '<button class="btn ghost sm" data-mod-unban="' + esc(u.uid) + '">Unban</button>'
      : '<button class="btn ghost sm" data-mod-ban="' + esc(u.uid) + '">Ban</button>';
    return '<tr><td>' + esc(modUserLabel(u.uid)) + '</td><td>' + esc(fmtDate(u.lastActive)) +
      '</td><td class="num">' + u.events + '</td><td>' + esc(u.topCategory) + '</td>' +
      '<td class="nowrap">' + toggle + ' ' +
      '<button class="btn ghost sm danger" data-mod-delete="' + esc(u.uid) + '">Delete</button></td></tr>';
  }).join('');
}

/* ---------------- Trope Lab ----------------
   The Trope Lab (coverage, review + claim queues, provider picker,
   all-libraries backfill, proposals, renderTropeLab) moved to
   js/161-tropelab.js (architecture candidate 6). This file keeps the
   Observatory shell and the other tabs; renderAdmin() still dispatches
   adminTab === 'tropes' to renderTropeLab() there. */

/* ---------------- Spine Lab ----------------
   The Spine Lab (spine search test, renderSpineLab) moved
   to js/164-spinelab.js (architecture candidate 6). This
   file keeps the Observatory shell and the other tabs;
   renderAdmin() still dispatches adminTab === 'spine' to
   renderSpineLab() there. */

/* ---------------- Edition Assets ----------------
   The Edition Assets tab (asset moderation,
   renderEditionAssetLab) moved to js/165-editionassets.js
   (architecture candidate 6). This file keeps the
   Observatory shell and the other tabs; renderAdmin() still
   dispatches adminTab === 'assets' to it there. */

/* ---------------- Character Lab ----------------
   The Character Lab (curation views, merge/unmerge and the
   restore companions, renderCharacterLab) moved to
   js/162-charlab.js (architecture candidate 6). This file keeps
   the Observatory shell and the other tabs; renderAdmin() still
   dispatches adminTab === 'characters' to renderCharacterLab() there. */
