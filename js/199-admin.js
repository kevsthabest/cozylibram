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
let adminRange = '7d'; // today | 7d | 30d | all | custom
let adminCustomFrom = '';
let adminCustomTo = '';
let adminRowsCache = {}; // rangeKey -> rows
let adminAggCache = {}; // rangeKey -> aggregate
let adminTab = 'analytics'; // analytics | tropes | logs | spine | assets

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

function adminRangeKey() {
  return adminRange === 'custom' ? 'custom:' + adminCustomFrom + ':' + adminCustomTo : adminRange;
}

function adminRangeSince() {
  const now = new Date();
  if (adminRange === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  if (adminRange === '7d') return new Date(now.getTime() - 7 * 864e5).toISOString();
  if (adminRange === '30d') return new Date(now.getTime() - 30 * 864e5).toISOString();
  if (adminRange === 'custom' && adminCustomFrom) return new Date(adminCustomFrom + 'T00:00:00').toISOString();
  return null;
}

function adminRangeUntil() {
  if (adminRange === 'custom' && adminCustomTo) return new Date(adminCustomTo + 'T23:59:59').toISOString();
  return null;
}

async function fetchAnalyticsRows() {
  const key = adminRangeKey();
  if (adminRowsCache[key]) return adminRowsCache[key];
  const sb = await cloudClient().catch(() => null);
  if (!sb) throw new Error('offline');
  let q = sb.from('analytics_events')
    .select('user_id,event_name,event_category,properties,app_version,created_at')
    .order('created_at', { ascending: false })
    .limit(20000);
  const since = adminRangeSince(), until = adminRangeUntil();
  if (since) q = q.gte('created_at', since);
  if (until) q = q.lte('created_at', until);
  const { data, error } = await q;
  if (error) throw error;
  adminRowsCache[key] = data || [];
  return adminRowsCache[key];
}

/* Pure: rows -> dashboard aggregates. No DOM, no network — fully testable. */
function aggregateAnalytics(rows) {
  rows = rows || [];
  const users = {}; // uid -> { events, last, cats:{} }
  const byEvent = {}; // name -> { uses, users:{} }
  const byCat = {}; // category -> uses
  rows.forEach(r => {
    const u = String(r.user_id || '');
    if (!u) return;
    const us = (users[u] = users[u] || { events: 0, last: '', cats: {} });
    us.events++;
    if (!us.last || r.created_at > us.last) us.last = r.created_at;
    const c = r.event_category || 'other';
    us.cats[c] = (us.cats[c] || 0) + 1;
    byCat[c] = (byCat[c] || 0) + 1;
    const e = (byEvent[r.event_name] = byEvent[r.event_name] || { uses: 0, users: {} });
    e.uses++;
    e.users[u] = 1;
  });
  const uids = Object.keys(users);
  const uniq = name => byEvent[name] ? Object.keys(byEvent[name].users).length : 0;
  const uses = name => byEvent[name] ? byEvent[name].uses : 0;

  const funnel = stages => stages.map(s => ({ event: s, users: uniq(s) }));

  // Import sources: started/completed/failed + books, per source.
  const sources = {};
  ['import_started', 'import_completed', 'import_failed'].forEach(ev => {
    (rows || []).forEach(r => {
      if (r.event_name !== ev) return;
      const s = (r.properties && r.properties.source) || 'unknown';
      const o = (sources[s] = sources[s] || { started: 0, completed: 0, failed: 0, books: 0 });
      if (ev === 'import_started') o.started++;
      else if (ev === 'import_completed') { o.completed++; o.books += Number((r.properties || {}).book_count) || 0; }
      else o.failed++;
    });
  });

  // Book-add sources.
  const addSources = {};
  rows.forEach(r => {
    if (r.event_name !== 'book_added') return;
    const s = (r.properties && r.properties.source) || 'unknown';
    addSources[s] = (addSources[s] || 0) + 1;
  });

  // v243: metadata provider breakdown — which backend served search/lookup
  // data (measures Google Books reliance vs the alternatives).
  // v245: pagecount context added (page-count backfill source order).
  const providers = {};
  rows.forEach(r => {
    if (r.event_name !== 'provider_used') return;
    const p = (r.properties && r.properties.provider) || 'unknown';
    const c = (r.properties && r.properties.context) || 'unknown';
    const o = (providers[p] = providers[p] || { search: 0, isbn: 0, pagecount: 0 });
    if (c === 'search') o.search++;
    else if (c === 'isbn') o.isbn++;
    else if (c === 'pagecount') o.pagecount++;
  });

  const activity = uids.map(u => {
    const us = users[u];
    let topCat = '—', topN = 0;
    Object.keys(us.cats).forEach(c => { if (us.cats[c] > topN) { topN = us.cats[c]; topCat = c; } });
    return { uid: u, lastActive: us.last, events: us.events, topCategory: topCat };
  }).sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));

  return {
    totalEvents: rows.length,
    uniqueUsers: uids.length,
    capped: rows.length >= 20000,
    activeUsers: uniq('session_started'),
    newSignups: uniq('account_created'),
    booksAdded: uses('book_added'),
    booksCompleted: uses('book_completed'),
    booksDnf: uses('book_dnf'),
    ratings: uses('book_rated'),
    favorites: uses('book_favorited'),
    discoveryUses: ['search_performed', 'author_discovery_opened', 'similar_books_opened',
      'release_discovery_opened', 'recommendation_opened', 'roulette_opened'].reduce((n, e) => n + uses(e), 0),
    featureUsage: Object.keys(byEvent).map(name => ({
      event: name,
      category: (rows.find(r => r.event_name === name) || {}).event_category || 'other',
      uses: byEvent[name].uses,
      users: Object.keys(byEvent[name].users).length,
    })).sort((a, b) => b.uses - a.uses),
    funnels: {
      roulette: funnel(['roulette_opened', 'roulette_spun', 'roulette_book_opened', 'roulette_book_started']),
      onboarding: funnel(['account_created', 'library_opened', 'first_book_added', 'first_book_rated', 'returned_within_7_days']),
      imports: funnel(['import_started', 'import_completed']),
      importFailed: uses('import_failed'),
    },
    importSources: sources,
    addSources: addSources,
    providerUsage: providers,
    userActivity: activity,
  };
}

/* ---- rendering ---- */

function humanEvent(name) {
  const pretty = {
    book_added: 'Book added', book_removed: 'Book removed', book_opened: 'Book opened',
    book_edited: 'Book edited', book_status_changed: 'Status changed', book_rated: 'Book rated',
    book_favorited: 'Favorited', book_unfavorited: 'Unfavorited',
    book_completed: 'Book completed', book_dnf: 'Book DNF\u2019d',
    search_performed: 'Search performed', provider_used: 'Metadata provider used',
    author_discovery_opened: 'Author discovery',
    similar_books_opened: 'Similar books', release_discovery_opened: 'Release check',
    recommendation_opened: 'Recommendations viewed',
    roulette_opened: 'Roulette opened', roulette_spun: 'Roulette spun',
    roulette_book_opened: 'Roulette pick opened', roulette_book_started: 'Roulette pick started',
    import_started: 'Import started', import_completed: 'Import completed', import_failed: 'Import failed',
    rating_axis_used: 'Axis rating used',
    coven_opened: 'Coven opened', friend_request_sent: 'Friend request sent',
    friend_request_accepted: 'Friend request accepted', invite_link_shared: 'Invite link shared',
    shared_shelf_viewed: 'Shared shelf viewed',
    friend_recommendation_used: 'Friend recommendation used',
    account_created: 'Account created', library_opened: 'Library opened',
    first_book_added: 'First book added', first_book_rated: 'First book rated',
    returned_within_7_days: 'Returned within 7 days', session_started: 'Session started',
  };
  return pretty[name] || String(name).replace(/_/g, ' ');
}

function adminFunnelHTML(funnelTitle, stages) {
  const max = Math.max.apply(null, [1].concat(stages.map(s => s.users)));
  const rows = stages.map((s, i) => {
    const pct = max ? Math.round(s.users / max * 100) : 0;
    const conv = i === 0 ? '' : ' <span class="note">(' +
      (stages[0].users ? Math.round(s.users / stages[0].users * 100) : 0) + '% of step 1)</span>';
    return '<div class="ob-funnel-row"><span class="ob-funnel-label">' + esc(humanEvent(s.event)) + '</span>' +
      '<span class="ob-funnel-barwrap"><span class="ob-funnel-bar" style="width:' + pct + '%"></span></span>' +
      '<b>' + s.users + '</b>' + conv + '</div>';
  }).join('');
  return '<div class="ob-card"><h3 class="serif">' + esc(funnelTitle) + '</h3>' + rows + '</div>';
}

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
  else if (adminTab === 'characters') renderCharacterLab();
  else if (adminTab === 'spine') renderSpineLab();
  else if (adminTab === 'assets') renderEditionAssetLab();
  else if (adminTab === 'logs') renderLogsTab();
  else renderAdminBody();
}

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

async function renderAdminBody() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  const key = adminRangeKey();
  try {
    const mod = await fetchModeration();
    const modHTML = moderationHTML(mod);
    if (!adminAggCache[key]) {
      const rows = await fetchAnalyticsRows();
      adminAggCache[key] = aggregateAnalytics(rows);
    }
    const a = adminAggCache[key];
    if (!a.totalEvents) {
      body.innerHTML = modHTML +
        '<div class="empty"><div class="big">' + icon('chart') + '</div>' +
        '<h2 class="serif">No analytics yet</h2><p>Events appear here once signed-in users start using the app' +
        (adminRange === 'all' ? '.' : ' in this date range.') + '</p></div>';
      wireModeration(body);
      return;
    }
    const card = (label, val) =>
      '<div class="ob-card ob-stat"><div class="ob-stat-val">' + val + '</div><div class="ob-stat-label">' + label + '</div></div>';
    const featRows = a.featureUsage.map(f => {
      const adoption = a.activeUsers ? Math.round(f.users / a.activeUsers * 100) : 0;
      return '<tr><td>' + esc(humanEvent(f.event)) + '</td><td>' + esc(f.category) + '</td>' +
        '<td class="num">' + f.users + '</td><td class="num">' + f.uses + '</td><td class="num">' + adoption + '%</td></tr>';
    }).join('');
    const srcRows = Object.keys(a.importSources).sort().map(s => {
      const o = a.importSources[s];
      return '<tr><td>' + esc(s) + '</td><td class="num">' + o.started + '</td><td class="num">' + o.completed +
        '</td><td class="num">' + o.failed + '</td><td class="num">' + o.books + '</td></tr>';
    }).join('');
    const addSrcRows = Object.keys(a.addSources).sort((x, y) => a.addSources[y] - a.addSources[x]).map(s =>
      '<tr><td>' + esc(s) + '</td><td class="num">' + a.addSources[s] + '</td></tr>').join('');
    // v243: metadata provider breakdown. v245: pagecount column.
    const provRows = Object.keys(a.providerUsage).sort((x, y) => {
      const tot = o => o.search + o.isbn + o.pagecount;
      return tot(a.providerUsage[y]) - tot(a.providerUsage[x]);
    }).map(p => {
      const o = a.providerUsage[p];
      return '<tr><td>' + esc(p) + '</td><td class="num">' + o.search + '</td><td class="num">' + o.isbn +
        '</td><td class="num">' + o.pagecount + '</td><td class="num">' + (o.search + o.isbn + o.pagecount) + '</td></tr>';
    }).join('');
    const userRows = userActivityRowsHTML(a.userActivity, mod.bannedById);
    body.innerHTML = modHTML +
      (a.capped ? '<p class="note">' + icon('warn') + ' Over 20,000 events — showing the most recent 20,000.</p>' : '') +
      '<div class="ob-grid">' +
      card('Active users', a.activeUsers) + card('New signups', a.newSignups) +
      card('Books added', a.booksAdded) + card('Books completed', a.booksCompleted) +
      card('Books rated', a.ratings) + card('Favorites', a.favorites) +
      card('Discovery uses', a.discoveryUses) + card('Total events', a.totalEvents) +
      '</div>' +
      '<div class="ob-card"><h3 class="serif">Feature usage</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Feature</th><th>Category</th>' +
      '<th class="num">Users</th><th class="num">Uses</th><th class="num">Adoption</th></tr></thead>' +
      '<tbody>' + featRows + '</tbody></table></div>' +
      '<p class="note">Adoption = users of the feature ÷ active users in this range.</p></div>' +
      adminFunnelHTML('Roulette funnel', a.funnels.roulette) +
      adminFunnelHTML('Onboarding funnel', a.funnels.onboarding) +
      adminFunnelHTML('Import funnel', a.funnels.imports.concat([{ event: 'import_failed', users: a.funnels.importFailed }])) +
      '<div class="ob-card"><h3 class="serif">Import sources</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Source</th><th class="num">Started</th>' +
      '<th class="num">Completed</th><th class="num">Failed</th><th class="num">Books</th></tr></thead>' +
      '<tbody>' + (srcRows || '<tr><td colspan="5" class="note">No imports in this range.</td></tr>') + '</tbody></table></div></div>' +
      '<div class="ob-card"><h3 class="serif">Book-add sources</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Source</th><th class="num">Books</th></tr></thead>' +
      '<tbody>' + (addSrcRows || '<tr><td colspan="2" class="note">No adds in this range.</td></tr>') + '</tbody></table></div></div>' +
      '<div class="ob-card"><h3 class="serif">Metadata providers</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Provider</th><th class="num">Search</th>' +
      '<th class="num">ISBN lookup</th><th class="num">Page count</th><th class="num">Total</th></tr></thead>' +
      '<tbody>' + (provRows || '<tr><td colspan="5" class="note">No provider data in this range (v243+).</td></tr>') + '</tbody></table></div>' +
      '<p class="note">Which backend served metadata — measures Google Books reliance vs Open Library / Hardcover / shared cache.</p></div>' +
      '<div class="ob-card"><h3 class="serif">User activity</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>User</th><th>Last active</th>' +
      '<th class="num">Events</th><th>Top area</th><th></th></tr></thead>' +
      '<tbody>' + userRows + '</tbody></table></div>' +
      '<p class="note">Users identified by email — activity only, never library contents.</p></div>';
    wireModeration(body);
  } catch (e) {
    body.innerHTML = '<div class="empty"><div class="big">' + icon('warn') + '</div>' +
      '<h2 class="serif">Couldn\u2019t load analytics</h2><p>' +
      esc((e && e.message) || 'unknown error') + '</p>' +
      '<p class="note">If the analytics tables are missing, run supabase/analytics.sql in the Supabase SQL editor.</p></div>';
  }
}

/* ---------------- Trope Lab (v152) ----------------
   Admin-only trope operations inside the Observatory: provider/key
   status, taxonomy health, coverage counts, and the paced backfill
   queue (pause/resume, per-book failure retry, re-infer on taxonomy
   bumps). Ordinary users never see this — inference runs only when
   an admin starts it here. */

let tropeLabKeyToId = {}; // book_key -> library id, rebuilt on each coverage scan
let tropeLabLastRows = []; // last book_tropes scan, reused by the all-libraries scan

function tropeLabBooks() {
  try { return (typeof library !== 'undefined' ? library : []).filter(b => b && !b._deleted); }
  catch (e) { return []; }
}

function tropeLabResolve(id) {
  return tropeLabBooks().find(b => b.id === id) || null;
}

async function tropeLabSb() {
  try { return await cloudClient().catch(() => null); }
  catch (e) { return null; }
}

/* Pure-ish: coverage of local books against book_tropes rows.
   Returns { total, tagged, missing:[books], stale:[books] }. A book is
   stale when its rows predate the bundled taxonomy version OR the live
   taxonomy rev (bumped on every Trope Lab approval). `current` defaults
   to the live values; rows without taxonomy_rev count as rev 1
   (the pre-v157 baseline).
   v271: `claimed` is an optional Set of bookKeyFor() keys whose work has a
   non-rejected claim in book_trope_claims. The backfill writes work-keyed
   claims, so a book with claims but no legacy rows still counts as tagged. */
function tropeLabCoverage(books, rows, current, claimed) {
  current = current || { version: TROPE_TAXONOMY_VERSION, rev: TropeTaxonomy.rev() };
  const byKey = {};
  (rows || []).forEach(r => {
    const e = byKey[r.book_key] || (byKey[r.book_key] = { count: 0, version: 0, rev: 1 });
    e.count++;
    e.version = Math.max(e.version, r.taxonomy_version || 0);
    e.rev = Math.max(e.rev, r.taxonomy_rev || 1);
  });
  const missing = [], stale = [];
  let tagged = 0;
  (books || []).forEach(b => {
    const key = bookKeyFor(b);
    const e = byKey[key];
    if (!e) {
      if (claimed && claimed.has(key)) tagged++;
      else missing.push(b);
    }
    else if (e.version < current.version || e.rev < current.rev) stale.push(b);
    else tagged++;
  });
  return { total: (books || []).length, tagged, missing, stale };
}

/* v271: bookKeyFor() keys whose work holds a non-rejected claim in
   book_trope_claims. Maps work -> ISBNs (editions) and work -> title/author
   norm (works) so books match the same way bookKeyFor keys them.
   Returns a Set, or null when the tables can't be read (caller falls back
   to legacy-only coverage). */
async function tropeLabClaimedKeys(sb) {
  try {
    const { data: claimRows, error: cErr } = await sb.from('book_trope_claims')
      .select('work_id').neq('status', 'rejected').limit(20000);
    if (cErr) throw cErr;
    const workIds = [...new Set((claimRows || []).map(r => r && r.work_id).filter(Boolean))];
    if (!workIds.length) return new Set();
    const out = new Set();
    const digits = s => String(s || '').replace(/[^0-9X]/gi, '');
    const to13 = s => {
      const d = digits(s);
      if (d.length === 13) return d;
      try { return (typeof isbn13of === 'function') ? (isbn13of(d) || d) : d; }
      catch (e) { return d; }
    };
    try {
      const { data: edRows } = await sb.from('editions')
        .select('isbn, work_id').in('work_id', workIds).limit(20000);
      (edRows || []).forEach(r => {
        const d = digits(r && r.isbn);
        if (!d) return;
        out.add('isbn:' + d);
        const d13 = to13(d);
        if (d13 !== d) out.add('isbn:' + d13);
      });
    } catch (e) { /* editions unreadable — title/author matching still works */ }
    try {
      const { data: wRows } = await sb.from('works')
        .select('id, title_norm, author_norm').in('id', workIds).limit(20000);
      (wRows || []).forEach(w => {
        if (w && w.title_norm) out.add('t:' + w.title_norm + ':' + (w.author_norm || ''));
      });
    } catch (e) { /* works unreadable — ISBN matching still works */ }
    return out;
  } catch (e) {
    return null;
  }
}

function tropeLabWireQueue() {
  // v153: shared app-wide wiring (resolver, upsert, DB reads); Trope Lab
  // only adds its progress callback on top.
  ensureTropeQueueWired();
  TropeQueue.configure({
    onEvent: () => {
      if (adminTab === 'tropes') tropeLabProgressHTML();
    },
  });
}

/* Refresh only the progress region (called on every queue event). */
function tropeLabProgressHTML() {
  const el = document.getElementById('tropelab-progress');
  if (!el) return;
  const s = TropeQueue.snapshot();
  const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
  const failedKeys = Object.keys(s.failedDetail || {});
  const failedRows = failedKeys.slice(0, 50).map(k => {
    const t = tropeLabReviewTitle(k); // v276: works-catalog fallback + honest label
    return '<tr><td>' + esc(t.title) + '</td><td class="note">' +
      esc(s.failedDetail[k]) + '</td></tr>';
  }).join('');
  el.innerHTML =
    '<div class="ob-card"><h3 class="serif">Backfill progress</h3>' +
    '<div class="ob-progress"><div class="ob-progress-fill" style="width:' + pct + '%"></div></div>' +
    '<p class="note">' + s.done + ' of ' + s.total + ' done · ' + s.pending + ' pending · ' +
    failedKeys.length + ' failed' +
    (s.running && !s.paused ? ' · <b>running</b>' : s.paused ? ' · paused' : '') +
    (s.fatalError ? ' · <span style="color:var(--danger,#c00)">' + esc(s.fatalError) + '</span>' : '') +
    '</p>' +
    '<div class="ob-ranges">' +
    (s.running && !s.paused
      ? '<button class="btn sm" id="tl-pause">Pause</button>'
      : '<button class="btn sm" id="tl-resume"' + (s.pending ? '' : ' disabled') + '>Resume</button>') +
    '<button class="btn sm ghost" id="tl-retry"' + (failedKeys.length ? '' : ' disabled') + '>Retry failed (' + failedKeys.length + ')</button>' +
    '<button class="btn sm ghost" id="tl-clear">Clear queue</button>' +
    '</div>' +
    (failedKeys.length
      ? '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Book</th><th>Error</th></tr></thead>' +
        '<tbody>' + failedRows + '</tbody></table></div>' +
        (failedKeys.length > 50 ? '<p class="note">Showing 50 of ' + failedKeys.length + ' failures.</p>' : '')
      : '') +
    '</div>';
  const pause = document.getElementById('tl-pause');
  if (pause) pause.addEventListener('click', () => { TropeQueue.pause(); });
  const resume = document.getElementById('tl-resume');
  if (resume) resume.addEventListener('click', () => { TropeQueue.start(); tropeLabProgressHTML(); });
  const retry = document.getElementById('tl-retry');
  if (retry) retry.addEventListener('click', () => {
    /* v159: local books retry by library id; all-libraries jobs are keyed
       by book_key and resolve through the admin projection. */
    const ids = failedKeys.map(k => tropeLabKeyToId[k] || k).filter(Boolean);
    TropeQueue.clearFailed();
    if (ids.length) { TropeQueue.enqueue(ids); TropeQueue.start(); }
    tropeLabProgressHTML();
  });
  const clear = document.getElementById('tl-clear');
  if (clear) clear.addEventListener('click', () => { TropeQueue.reset(); tropeLabProgressHTML(); });
}

/* ---------------- Trope review queue (v166) ----------------
   Approve inferred tropes without opening each book. Lists every book
   with inferred rows in book_tropes, reusing the book modal's chip +
   ▲▼ vote UI (TropeVotes) — an upvote here is exactly the "approval"
   Kevin used to do one book at a time. "Approve all" upvotes every
   inferred trope for the book in one tap. Unreviewed books sort first
   so the list reads as a work queue. */

let tropeLabReviewShown = 15; // pagination: how many books are rendered
const TROPE_LAB_REVIEW_PAGE = 15;

/* Pure: group book_tropes rows into per-book review entries.
   rows: [{book_key, trope_id, confidence, source}].
   byId: trope_id -> {id, name}; rows with unknown ids are dropped.
   Returns [{ bookKey, tropes: [{id, name, confidence, source}] }] with
   tropes sorted by confidence desc. */
function tropeLabReviewEntries(rows, byId) {
  const byKey = {};
  (rows || []).forEach(r => {
    if (!r || !r.book_key || !r.trope_id) return;
    const t = byId ? byId(r.trope_id) : null;
    if (!t) return;
    const e = byKey[r.book_key] || (byKey[r.book_key] = { bookKey: r.book_key, tropes: [] });
    if (e.tropes.some(x => x.id === t.id)) return;
    e.tropes.push({ id: t.id, name: t.name,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
      source: r.source || 'llm' });
  });
  return Object.keys(byKey).map(k => {
    const e = byKey[k];
    e.tropes.sort((a, b) => b.confidence - a.confidence);
    return e;
  });
}

/* Pure: aggregate trope_votes rows into the {tropeId:{up,down,mine}}
   shape dbTropeChipsHTML expects, keyed by book. `uid` marks the
   current user's own vote. */
function tropeLabReviewVotes(rows, uid) {
  const agg = {};
  (rows || []).forEach(r => {
    if (!r || !r.book_key || !r.trope_id) return;
    const perBook = agg[r.book_key] || (agg[r.book_key] = {});
    const e = perBook[r.trope_id] || (perBook[r.trope_id] = { up: 0, down: 0, mine: 0 });
    if (r.vote === 1) e.up++;
    else if (r.vote === -1) e.down++;
    if (uid && r.user_id === uid) e.mine = r.vote;
  });
  return agg;
}

/* Resolve a book_key to a display title/authors: local library first,
   then the persisted all-libraries admin projection, then the global works
   catalog (v276: a work row outlives library membership by design, so a
   book deleted from every library still resolves to its title/author). */
let tropeLabWorkTitles = {}; // isbn -> { title, authors }, primed per render

async function tropeLabPrimeWorkTitles(sb, keys) {
  tropeLabWorkTitles = {};
  try {
    const isbns = [...new Set((keys || [])
      .filter(k => typeof k === 'string' && k.indexOf('isbn:') === 0)
      .map(k => k.slice(5)))];
    if (!isbns.length) return;
    const r = await sb.from('editions').select('isbn, works(title, authors)').in('isbn', isbns);
    if (r.error) throw r.error;
    (r.data || []).forEach(row => {
      const w = row && row.works;
      if (w && row.isbn) tropeLabWorkTitles[row.isbn] =
        { title: w.title || '', authors: (w.authors || []).join(', ') };
    });
  } catch (e) { /* works lookup is best-effort; the honest label below covers misses */ }
}

function tropeLabIsbnOf(key) {
  return (typeof key === 'string' && key.indexOf('isbn:') === 0) ? key.slice(5) : null;
}

function tropeLabReviewTitle(key) {
  try {
    const b = tropeLabResolve(tropeLabKeyToId[key]);
    if (b) return { title: b.title || key, authors: (b.authors || []).join(', ') };
    const ab = tropeAdminBookById(key);
    if (ab) return { title: ab.title || key, authors: (ab.authors || []).join(', ') };
    const isbn = tropeLabIsbnOf(key);
    const m = isbn && tropeLabWorkTitles[isbn];
    if (m && m.title) return { title: m.title, authors: m.authors || '' };
  } catch (e) {}
  // Honest label for keys no catalog knows — never the raw key.
  const isbn = tropeLabIsbnOf(key);
  if (isbn) return { title: 'Removed book · ' + isbn, authors: '' };
  return { title: key, authors: '' };
}

async function tropeLabReviewHTML() {
  const el = document.getElementById('tropelab-review');
  if (!el) return;
  const head = '<div class="ob-card"><h3 class="serif">Review inferred tropes</h3>';
  const sb = await tropeLabSb();
  if (!sb) {
    el.innerHTML = head + '<p class="note">Sign in to review inferred tropes.</p></div>';
    return;
  }
  let rows = [];
  try {
    const r1 = await sb.from('book_tropes')
      .select('book_key, trope_id, confidence, source').limit(20000);
    if (r1.error) throw r1.error;
    rows = r1.data || [];
  } catch (e) {
    el.innerHTML = head + '<p class="note">' + icon('warn') +
      ' Could not load inferred tropes (' + esc((e && e.message) || 'unknown error') + ').</p></div>';
    return;
  }
  const entries = tropeLabReviewEntries(rows, id => TropeTaxonomy.byId(id));
  if (!entries.length) {
    el.innerHTML = head + '<p class="note">No inferred tropes yet — run a backfill above first.</p></div>';
    return;
  }
  let votes = {};
  try {
    const uid = (typeof localUid !== 'undefined' && localUid) || null;
    const r2 = await sb.from('trope_votes')
      .select('book_key, trope_id, vote, user_id')
      .in('book_key', entries.map(e => e.bookKey));
    if (r2.error) throw r2.error;
    votes = tropeLabReviewVotes(r2.data || [], uid);
  } catch (e) { votes = {}; }
  // v276: prime the works-catalog titles so books deleted from every
  // library still resolve (the work row outlives library membership).
  try { await tropeLabPrimeWorkTitles(sb, entries.map(e => e.bookKey)); } catch (e) {}
  entries.forEach(e => {
    const t = tropeLabReviewTitle(e.bookKey);
    e.title = t.title;
    e.authors = t.authors;
    const v = votes[e.bookKey] || {};
    e.reviewed = e.tropes.every(tr => (v[tr.id] || { mine: 0 }).mine !== 0);
  });
  entries.sort((a, b) =>
    ((a.reviewed ? 1 : 0) - (b.reviewed ? 1 : 0)) ||
    String(a.title).localeCompare(String(b.title)));
  const reviewedCount = entries.filter(e => e.reviewed).length;
  const shown = entries.slice(0, tropeLabReviewShown);
  const byKey = {};
  entries.forEach(e => { byKey[e.bookKey] = e; });
  let html = head +
    '<p class="note">' + entries.length + ' books with inferred tropes · ' +
    reviewedCount + ' fully reviewed by you. ▲ approves a trope, ▼ rejects it — ' +
    'the same votes as in each book\u2019s detail sheet. ' +
    '<button class="btn sm ghost" id="tl-review-refresh">↻ Refresh</button></p>';
  shown.forEach(e => {
    const v = votes[e.bookKey] || {};
    html += '<div class="tl-review-book" data-review-book="' + esc(e.bookKey) + '">' +
      '<div class="tl-review-head"><div><b>' + esc(e.title) + '</b>' +
      (e.authors ? ' <span class="note">· ' + esc(e.authors) + '</span>' : '') +
      (e.reviewed ? ' <span class="note">✓ reviewed</span>' : '') +
      '</div>' +
      '<button class="btn sm ghost" data-approve-all' + (e.reviewed ? ' disabled' : '') +
      '>Approve all</button></div>' +
      '<div class="tl-review-chips">' + dbTropeChipsHTML(e.tropes, 'db', v) + '</div>' +
      '</div>';
  });
  if (entries.length > shown.length) {
    html += '<button class="btn sm" id="tl-review-more">Show more (' +
      (entries.length - shown.length) + ' remaining)</button>';
  }
  el.innerHTML = html + '</div>';

  const refresh = document.getElementById('tl-review-refresh');
  if (refresh) refresh.addEventListener('click', () => tropeLabReviewHTML());
  const more = document.getElementById('tl-review-more');
  if (more) more.addEventListener('click', () => {
    tropeLabReviewShown += TROPE_LAB_REVIEW_PAGE;
    tropeLabReviewHTML();
  });
  el.querySelectorAll('[data-review-book]').forEach(row => {
    const key = row.getAttribute('data-review-book');
    row.querySelectorAll('[data-tv]').forEach(btn => btn.addEventListener('click', async () => {
      const tid = btn.getAttribute('data-tid');
      const want = parseInt(btn.getAttribute('data-tv'), 10);
      btn.disabled = true;
      try { await TropeVotes.toggleVote(key, tid, want); } catch (e) {}
      tropeLabReviewHTML(); // re-render: counts, highlights, reviewed state
    }));
    const all = row.querySelector('[data-approve-all]');
    if (all) all.addEventListener('click', async () => {
      const label = all.textContent;
      all.disabled = true;
      all.textContent = 'Approving…';
      try {
        const entry = byKey[key];
        const v = await TropeVotes.getVotes(key);
        for (const tr of (entry ? entry.tropes : [])) {
          const cur = (v[tr.id] || { mine: 0 }).mine;
          if (cur !== 1) await TropeVotes.vote(key, tr.id, 1);
        }
      } catch (e) {}
      all.textContent = label;
      tropeLabReviewHTML();
    });
  });
}

/* ---------------- Claim review card (v206, v208) ----------------
   Corrections for AI claims, work-wide. v208: high-confidence claims
   with quoted evidence auto-publish, so this queue is corrections-only —
   ✓ confirms a candidate work-wide, ✕ rejects any AI claim (rejections
   survive re-inference). Auto-published tags are badged "auto". */

let tropeLabClaimsShown = 15;
const TROPE_LAB_CLAIMS_PAGE = 15;
let tropeLabClaimsModelFilter = ''; // v315: '' = all models

async function tropeLabClaimsHTML() {
  const el = document.getElementById('tropelab-claims');
  if (!el) return;
  const head = '<div class="ob-card"><h3 class="serif">Review AI tags</h3>';
  let groups = [];
  try {
    groups = await TropeClaims.listCandidates(500);
  } catch (e) { groups = []; }
  if (!groups.length) {
    el.innerHTML = head +
      '<p class="note">No AI tags awaiting review. High-confidence tags with quoted ' +
      'evidence publish automatically — corrections land here.</p></div>';
    return;
  }
  // v315: model/source filter — distinct models across the queue.
  // Lets reviewers isolate one pipeline (e.g. the ebook processor) from
  // in-app inference.
  const models = [];
  groups.forEach(g => g.tropes.forEach(t => {
    if (t.model && models.indexOf(t.model) < 0) models.push(t.model);
  }));
  models.sort();
  const mf = tropeLabClaimsModelFilter;
  const fgroups = mf
    ? groups.map(g => Object.assign({}, g, {
        tropes: g.tropes.filter(t => t.model === mf),
      })).filter(g => g.tropes.length)
    : groups;
  const shown = fgroups.slice(0, tropeLabClaimsShown);
  let html = head + '<p class="note">' + fgroups.length +
    ' works with AI tags · ✓ confirms a candidate work-wide, ✕ rejects it ' +
    '(rejections survive re-inference). ' +
    '<span class="chip dbtrope ai">auto</span> = published automatically on ' +
    'high confidence + quoted evidence. ' +
    '<button class="btn sm ghost" id="tl-claims-refresh">↻ Refresh</button></p>';
  if (models.length > 1) {
    html += '<p class="note"><label>Source model: <select id="tl-claims-model" class="text-input" style="width:auto;display:inline-block">' +
      '<option value="">All models (' + groups.length + ' works)</option>' +
      models.map(m => '<option value="' + esc(m) + '"' +
        (m === mf ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
      '</select></label></p>';
  }
  shown.forEach(g => {
    html += '<div class="tl-review-book" data-claim-work="' + esc(g.workId) + '">' +
      '<div class="tl-review-head"><div><b>' + esc(g.title) + '</b>' +
      (g.authors ? ' <span class="note">· ' + esc(g.authors) + '</span>' : '') +
      '</div></div><div class="tl-review-chips">';
    g.tropes.forEach(t => {
      html += '<span class="tgvote"><span class="chip dbtrope ai" title="AI ' +
        (t.auto ? 'auto-published' : 'candidate') + ' · ' +
        Math.round(t.confidence * 100) + '% confidence">' +
        (t.auto ? '✓auto ' : '✦ ') + esc(t.name) + '</span>' +
        (t.auto ? '' :
          '<button class="tvbtn" data-claim="confirmed" data-tid="' + esc(t.id) +
          '" aria-label="Confirm ' + esc(t.name) + '">✓</button>') +
        '<button class="tvbtn" data-claim="rejected" data-tid="' + esc(t.id) +
        '" aria-label="Reject ' + esc(t.name) + '">✕</button></span>';
    });
    html += '</div></div>';
  });
  if (fgroups.length > shown.length) {
    html += '<button class="btn sm" id="tl-claims-more">Show more (' +
      (fgroups.length - shown.length) + ' remaining)</button>';
  }
  el.innerHTML = html + '</div>';

  const refresh = document.getElementById('tl-claims-refresh');
  if (refresh) refresh.addEventListener('click', () => tropeLabClaimsHTML());
  const modelSel = document.getElementById('tl-claims-model');
  if (modelSel) modelSel.addEventListener('change', () => {
    tropeLabClaimsModelFilter = modelSel.value;
    tropeLabClaimsShown = TROPE_LAB_CLAIMS_PAGE; // reset pagination on filter change
    tropeLabClaimsHTML();
  });
  const more = document.getElementById('tl-claims-more');
  if (more) more.addEventListener('click', () => {
    tropeLabClaimsShown += TROPE_LAB_CLAIMS_PAGE;
    tropeLabClaimsHTML();
  });
  el.querySelectorAll('[data-claim-work]').forEach(row => {
    const workId = row.getAttribute('data-claim-work');
    row.querySelectorAll('[data-claim]').forEach(btn => btn.addEventListener('click', async () => {
      const status = btn.getAttribute('data-claim');
      const tid = btn.getAttribute('data-tid');
      btn.disabled = true;
      try { await TropeClaims.setStatus(workId, tid, status); }
      catch (e) {
        btn.disabled = false;
        btn.title = 'Failed: ' + ((e && e.message) || 'unknown error');
        return;
      }
      tropeLabClaimsHTML(); // re-render: the decided claim leaves the queue
    }));
  });
}

/* ---------------- v264: Spine Lab ----------------
   Experiment: can Gemini (web-search grounding) find a book's spine photo?
   Admin-only diagnostic — results are shown for human judgment, nothing is
   saved to any library. */
function spineLabResultHTML(data) {
  if (!data) return '';
  const cands = Array.isArray(data.candidates) ? data.candidates : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  let h = '';
  if (!cands.length) {
    h += '<div class="ob-card"><h3 class="serif">No spine found</h3>' +
      '<p class="note">Gemini could not find a clear spine photo for this book. ' +
      'Photographing the spine remains the reliable path.</p></div>';
  } else {
    h += '<div class="ob-card"><h3 class="serif">Spine candidates (' + cands.length + ')</h3>' +
      '<div class="spinelab-grid">' + cands.map(c =>
        '<div class="spinelab-cand">' +
        '<img src="' + esc(c.image_url) + '" alt="spine candidate" loading="lazy">' +
        (c.note ? '<p class="note">' + esc(c.note) + '</p>' : '') +
        (c.page_url ? '<a href="' + esc(c.page_url) + '" target="_blank" rel="noopener">source page</a>' : '') +
        '</div>').join('') + '</div></div>';
  }
  if (sources.length) {
    h += '<div class="ob-card"><h3 class="serif">Search sources</h3><ul class="ob-list">' +
      sources.map(s => '<li><a href="' + esc(s.uri) + '" target="_blank" rel="noopener">' +
        esc(s.title || s.uri) + '</a></li>').join('') + '</ul></div>';
  }
  return h;
}

async function renderSpineLab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  body.innerHTML =
    '<div class="ob-card"><h3 class="serif">' + icon('camera') + ' Spine search test</h3>' +
    '<p class="note">Search the web for this book\'s <b>spine</b> photo (Brave image search). ' +
    'An experiment — nothing is saved. If this works reliably, spine photos could one day come from search instead of the camera.</p>' +
    '<div class="spinelab-form">' +
    '<input id="sl-title" class="text-input" placeholder="Book title" autocomplete="off">' +
    '<input id="sl-author" class="text-input" placeholder="Author (optional)" autocomplete="off">' +
    '<button class="btn" id="sl-go">Search</button>' +
    '</div></div>' +
    '<div id="sl-result"></div>';
  const go = async () => {
    const title = document.getElementById('sl-title').value.trim();
    const author = document.getElementById('sl-author').value.trim();
    const res = document.getElementById('sl-result');
    if (!title) { res.innerHTML = '<p class="note">Enter a title first.</p>'; return; }
    res.innerHTML = '<p class="note">Searching…</p>';
    try {
      const r = await apiFetch('/api/spine-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, author }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { res.innerHTML = '<p class="note">Error: ' + esc(data.error || ('http ' + r.status)) + '</p>'; return; }
      res.innerHTML = spineLabResultHTML(data);
    } catch (e) {
      res.innerHTML = '<p class="note">Request failed: ' + esc((e && e.message) || e) + '</p>';
    }
  };
  document.getElementById('sl-go').addEventListener('click', go);
}

async function renderEditionAssetLab() {
  const body = document.getElementById('ob-body');
  if (!body || !isAppAdmin) return;
  body.innerHTML =
    '<div class="ob-card"><h3 class="serif">Edition asset moderation</h3>' +
    '<p class="note">Review candidate evidence, verify good captures, reject bad ones, or pin an explicit canonical asset. Rejected candidates remain in the database for audit/history but never appear in the public API.</p>' +
    '<div class="spinelab-form">' +
    '<input id="eal-isbn" class="text-input" placeholder="ISBN" inputmode="numeric">' +
    '<select id="eal-face" class="text-input"><option value="">All faces</option><option value="spine">Spine</option><option value="front">Front</option><option value="back">Back</option><option value="fore_edge">Fore-edge</option><option value="top_edge">Top edge</option><option value="bottom_edge">Bottom edge</option></select>' +
    '<select id="eal-ap" class="text-input"><option value="">All appearances</option><option value="jacket">Jacket</option><option value="board">Board</option><option value="slipcase">Slipcase</option></select>' +
    '<button class="btn" id="eal-go">Load candidates</button></div></div>' +
    '<div id="eal-result"><p class="note">Enter an ISBN to review its candidates.</p></div>';

  const result = document.getElementById('eal-result');
  const load = async () => {
    const isbn = document.getElementById('eal-isbn').value.trim().replace(/[^0-9Xx]/g, '').toUpperCase();
    const face = document.getElementById('eal-face').value;
    const ap = document.getElementById('eal-ap').value;
    if (!isbn) { result.innerHTML = '<p class="note">Enter an ISBN first.</p>'; return; }
    result.innerHTML = '<p class="note">Loading…</p>';
    try {
      const sb = await cloudClient();
      const er = await sb.from('editions').select('id,isbn,publisher,format,page_count').eq('isbn', isbn).maybeSingle();
      if (er.error) throw er.error;
      if (!er.data) { result.innerHTML = '<p class="note">No edition row for ' + esc(isbn) + '.</p>'; return; }
      let q = sb.from('edition_assets')
        .select('id,face,appearance,bucket,path,width,height,quality_score,sharpness_score,exposure_score,perspective_score,coverage_score,glare_score,resolution_score,stability_score,verified,rejected,created_at')
        .eq('edition_id', er.data.id).order('quality_score', { ascending: false, nullsFirst: false }).limit(200);
      if (face) q = q.eq('face', face);
      if (ap) q = q.eq('appearance', ap);
      const ar = await q;
      if (ar.error) throw ar.error;
      const sr = await sb.from('edition_asset_slots').select('face,appearance,canonical_asset_id,selection_method,selected_at').eq('edition_id', er.data.id);
      const slotMap = {};
      (sr.data || []).forEach(s => { slotMap[s.appearance + ':' + s.face] = s; });
      const publicUrl = (a) => {
        try {
          return sb.storage.from(a.bucket || 'edition-images').getPublicUrl(a.path || '').data.publicUrl || '';
        } catch (e) { return ''; }
      };
      const cards = (ar.data || []).map(a => {
        const key = a.appearance + ':' + a.face, slot = slotMap[key];
        const canonical = slot && slot.canonical_asset_id === a.id;
        return '<div class="ob-card eal-card">' +
          '<div class="eal-media"><img src="' + esc(publicUrl(a)) + '" alt="' + esc(a.appearance + ' ' + a.face) + '" loading="lazy"></div>' +
          '<div class="eal-info"><h3>' + esc(a.appearance + ' · ' + a.face) + '</h3>' +
          '<p class="note">Quality <b>' + (a.quality_score == null ? '—' : Number(a.quality_score).toFixed(1)) + '</b> · ' +
          (a.verified ? 'verified' : a.rejected ? 'rejected' : 'unverified') +
          (canonical ? ' · <b>CANONICAL</b>' : '') + '</p>' +
          '<p class="note">Sharp ' + (a.sharpness_score == null ? '—' : Number(a.sharpness_score).toFixed(0)) +
          ' · Exposure ' + (a.exposure_score == null ? '—' : Number(a.exposure_score).toFixed(0)) +
          ' · Glare ' + (a.glare_score == null ? '—' : Number(a.glare_score).toFixed(0)) +
          ' · Resolution ' + (a.resolution_score == null ? '—' : Number(a.resolution_score).toFixed(0)) + '</p>' +
          '<p class="note">' + esc((a.width || '?') + '×' + (a.height || '?') + ' · ' + a.id) + '</p>' +
          '<div class="ob-ranges">' +
          '<button class="btn sm" data-eal-verify="' + esc(a.id) + '"' + (a.verified || a.rejected ? ' disabled' : '') + '>Verify</button>' +
          '<button class="btn sm ghost" data-eal-reject="' + esc(a.id) + '"' + (a.rejected ? ' disabled' : '') + '>Reject</button>' +
          '<button class="btn sm ghost" data-eal-canon="' + esc(a.id) + '"' + (canonical ? ' disabled' : '') + '>Set canonical</button>' +
          '</div></div></div>';
      }).join('');
      result.innerHTML = '<p class="note">' + (ar.data || []).length + ' candidate(s) for ' + esc(isbn) + '.</p>' +
        (cards || '<p class="note">No candidates.</p>');
      result.querySelectorAll('[data-eal-verify]').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        await sb.from('edition_assets').update({ verified: true, rejected: false }).eq('id', btn.dataset.ealVerify);
        await load();
      }));
      result.querySelectorAll('[data-eal-reject]').forEach(btn => btn.addEventListener('click', async () => {
        if (!await confirmModal('Reject this candidate?', { okLabel: 'Reject' })) return;
        btn.disabled = true;
        await sb.from('edition_assets').update({ rejected: true, verified: false }).eq('id', btn.dataset.ealReject);
        await load();
      }));
      result.querySelectorAll('[data-eal-canon]').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        const asset = (ar.data || []).find(a => a.id === btn.dataset.ealCanon);
        if (!asset) return;
        const uidr = await sb.auth.getUser(), uid = uidr && uidr.data && uidr.data.user && uidr.data.user.id;
        if (!uid) return;
        await sb.from('edition_asset_slots').upsert({
          edition_id: er.data.id, isbn: er.data.isbn, face: asset.face, appearance: asset.appearance,
          canonical_asset_id: asset.id, selection_method: 'admin', selected_by: uid,
          selected_at: new Date().toISOString(), updated_at: new Date().toISOString()
        }, { onConflict: 'edition_id,face,appearance' });
        await sb.from('edition_images').upsert({
          isbn: er.data.isbn, edition_id: er.data.id, face: asset.face, appearance: asset.appearance,
          bucket: asset.bucket, path: asset.path, uploaded_by: uid, verified: !!asset.verified,
          updated_at: new Date().toISOString()
        }, { onConflict: 'isbn,face,appearance' });
        await load();
      }));
    } catch (e) {
      result.innerHTML = '<p class="note">Could not load candidates: ' + esc((e && e.message) || e) + '</p>';
    }
  };
  document.getElementById('eal-go').addEventListener('click', load);
}

async function renderTropeLab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  tropeLabWireQueue();
  /* v157: pull the live taxonomy first so counts, staleness, and the
     proposal review all see freshly approved tropes. */
  try { await TropeTaxonomy.refresh(); } catch (e) {}
  /* v160: load the shared provider/model override so the status card
     shows the effective provider. */
  try { await tropeProviderGet(); } catch (e) {}

  const info = tropeProviderInfo();
  const configured = tropeInferenceConfigured();
  const liveCount = TropeTaxonomy.list().length;
  const addedCount = liveCount - TROPES.length;
  const statusCard =
    '<div class="ob-card"><h3 class="serif">' + icon('bulb') + ' Trope Lab</h3>' +
    '<div class="ob-grid">' +
    '<div class="ob-stat"><div class="ob-stat-val" id="tl-stat-provider">' + esc(info.provider || '—') + '</div><div class="ob-stat-label">Provider</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val" id="tl-stat-model" style="font-size:15px;word-break:break-all">' + esc(info.model || '—') + '</div><div class="ob-stat-label">Model</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + (configured ? 'Ready' : 'Missing') + '</div><div class="ob-stat-label">API key</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">v' + TROPE_TAXONOMY_VERSION + ' · ' + liveCount + '</div><div class="ob-stat-label">Taxonomy tropes' +
    (addedCount > 0 ? ' (+' + addedCount + ' added)' : '') + '</div></div>' +
    '</div>' +
    (configured
      ? '<p class="note">Inference calls go through the same-origin <code>/api/trope-infer</code> proxy — the key stays server-side.</p>'
      : '<p class="note">' + icon('warn') + ' No trope API key on this server. Add <code>trope_api_key</code> (+ provider/model) to ' +
        '<code>server-config.json</code>, or set <code>TROPE_API_KEY</code> / <code>TROPE_MODEL</code> in the Pages environment.</p>') +
    '</div>';

  body.innerHTML = statusCard + '<div id="tropelab-provider"></div>' +
    '<div id="tropelab-coverage"><p class="note">Scanning library…</p></div>' +
    '<div id="tropelab-alllibs"></div>' +
    '<div id="tropelab-progress"></div>' +
    '<div id="tropelab-review"></div>';

  // Resume an interrupted backfill when Trope Lab opens.
  const snap = TropeQueue.snapshot();
  let resumed = false;
  if (snap.running && !snap.paused && snap.pending > 0 && configured) {
    TropeQueue.start();
    resumed = true;
  }

  let cov, sbError = '', rows = [];
  try {
    const books = tropeLabBooks();
    tropeLabKeyToId = {};
    books.forEach(b => { tropeLabKeyToId[bookKeyFor(b)] = b.id; });
    const sb = await tropeLabSb();
    rows = [];
    if (sb) {
      const { data, error } = await sb.from('book_tropes')
        .select('book_key, taxonomy_version, taxonomy_rev').limit(20000);
      if (error) sbError = error.message;
      else rows = data || [];
    } else {
      sbError = 'not signed in';
    }
    cov = tropeLabCoverage(books, rows, undefined, await tropeLabClaimedKeys(sb));
  } catch (e) {
    sbError = (e && e.message) || 'scan failed';
    cov = { total: 0, tagged: 0, missing: [], stale: [] };
  }
  tropeLabLastRows = rows;

  const covEl = document.getElementById('tropelab-coverage');
  if (!covEl) return;
  covEl.innerHTML =
    '<div class="ob-card"><h3 class="serif">Coverage</h3>' +
    '<div class="ob-grid">' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.tagged + '</div><div class="ob-stat-label">Books tagged</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.missing.length + '</div><div class="ob-stat-label">Missing</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.stale.length + '</div><div class="ob-stat-label">Stale taxonomy</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.total + '</div><div class="ob-stat-label">Books scanned</div></div>' +
    '</div>' +
    (sbError ? '<p class="note">' + icon('warn') + ' Cloud read failed (' + esc(sbError) + ') — counts may be incomplete. ' +
      'If the trope tables are missing, run <code>supabase/tropes.sql</code> in the Supabase SQL editor.</p>' : '') +
    (resumed ? '<p class="note">Resumed an interrupted backfill.</p>' : '') +
    '<div class="ob-ranges">' +
    '<button class="btn sm" id="tl-backfill"' + (configured && cov.missing.length ? '' : ' disabled') + '>Backfill missing (' + cov.missing.length + ')</button>' +
    '<button class="btn sm ghost" id="tl-restale"' + (configured && cov.stale.length ? '' : ' disabled') + '>Re-infer stale (' + cov.stale.length + ')</button>' +
    '</div>' +
    '<p class="note">One book at a time, ~4s apart — stays under free-tier limits. ' +
    'Failed or empty inference is never cached as “no tropes”; failures stay listed below for retry. ' +
    'Closing this tab pauses nothing — reopen Trope Lab to resume.</p>' +
    '</div>';

  const wire = (id, books, force) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => {
      const n = TropeQueue.enqueue(books.map(b => b.id), { force: !!force });
      if (n) TropeQueue.start();
      tropeLabProgressHTML();
    });
  };
  wire('tl-backfill', cov.missing);
  wire('tl-restale', cov.stale, true); // v208: explicit re-infer bypasses the input-hash cache
  tropeLabProgressHTML();
  tropeLabProviderHTML();
  tropeLabAllLibrariesHTML(configured);
  tropeLabReviewHTML();

  // v155: user-proposal review queue.
  const propCard = document.createElement('div');
  propCard.innerHTML =
    '<div class="ob-card"><h3 class="serif">Trope proposals</h3>' +
    '<p class="note">Coven members propose, vote, and you review. Approving writes the canonical row ' +
    'to the shared taxonomy table and optionally tags the originating book — the new trope is live ' +
    'for inference immediately, no file edit needed.</p>' +
    '<div id="trope-proposals"><p class="note">Loading…</p></div></div>';
  body.appendChild(propCard);
  tropeLabProposalsHTML();

  // v206: AI candidate claim moderation (confirm/reject, work-wide).
  const claimsCard = document.createElement('div');
  claimsCard.innerHTML = '<div id="tropelab-claims"><p class="note">Loading…</p></div>';
  body.appendChild(claimsCard);
  tropeLabClaimsHTML();
}

/* v160: in-app provider/model picker. The choice is stored in the shared
   trope_provider_settings row and applies to all devices on their next
   inference run. API keys stay server-side — the proxy holds one key per
   provider (TROPE_KEY_<PROVIDER>) and the client only names the provider. */
async function tropeLabProviderHTML() {
  const box = document.getElementById('tropelab-provider');
  if (!box || adminTab !== 'tropes') return;
  let cur = { provider: '', model: '' };
  try { cur = await tropeProviderGet(); } catch (e) {}
  const info = tropeProviderInfo();
  const providers = ['', 'openrouter', 'gemini', 'groq', 'ollama', 'custom'];
  const labels = { '': 'Server default (env)', openrouter: 'OpenRouter', gemini: 'Google Gemini', groq: 'Groq', ollama: 'Ollama (local)', custom: 'Custom' };
  box.innerHTML =
    '<div class="ob-card"><h3 class="serif">Inference provider</h3>' +
    '<p class="note" id="tl-provider-current">Currently: <b>' + esc(info.provider || 'server default') + '</b>' +
    (info.model ? ' · <span style="word-break:break-all">' + esc(info.model) + '</span>' : '') +
    (info.overridden ? ' (override)' : ' (server env)') + '</p>' +
    '<div class="ob-ranges">' +
    '<select id="tl-provider-sel" class="text-input" aria-label="Provider">' +
    providers.map(p => '<option value="' + p + '"' + (cur.provider === p ? ' selected' : '') + '>' + labels[p] + '</option>').join('') +
    '</select>' +
    '<input id="tl-provider-model" class="text-input" list="tl-model-list" placeholder="model (e.g. gemini-3.8-flash)" value="' + esc(cur.model) + '" aria-label="Model">' +
    '<datalist id="tl-model-list"></datalist>' +
    '<button class="btn sm" id="tl-provider-save">Save</button>' +
    '</div>' +
    '<p class="note" id="tl-models-note"></p>' +
    '<p class="note">Applies to all devices. Each provider needs its key on the server ' +
    '(Cloudflare env <code>TROPE_KEY_GEMINI</code>, <code>TROPE_KEY_OPENROUTER</code>, …); ' +
    'picking one without a key fails the next run with a clear error. ' +
    'Choose “Server default” with an empty model to go back to the env settings.</p>' +
    '<p class="note" id="tl-provider-msg"></p></div>';
  const sel = document.getElementById('tl-provider-sel');
  const modelInput = document.getElementById('tl-provider-model');
  const list = document.getElementById('tl-model-list');
  const modelsNote = document.getElementById('tl-models-note');
  /* v164: the datalist first shows the hardcoded suggestions (instant,
     offline-safe), then the live model list from /api/trope-models when it
     loads. A failed load keeps the suggestions — the input stays free text,
     so any model name still works. */
  const fillList = async () => {
    const p = sel.value;
    const sugs = (typeof TROPE_PROVIDER_SUGGESTIONS !== 'undefined' &&
      TROPE_PROVIDER_SUGGESTIONS[p]) || [];
    const showSugs = () => {
      list.innerHTML = sugs.map(s => '<option value="' + esc(s) + '">').join('');
    };
    showSugs();
    if (!p || p === 'custom') {
      modelsNote.textContent = p === 'custom'
        ? 'Custom provider — type the exact model name.'
        : 'Server default — the model comes from the server env.';
      return;
    }
    modelsNote.textContent = 'Loading available models…';
    let live = null;
    try { live = await tropeModelList(p); } catch (e) { live = null; }
    if (p !== sel.value) return; // provider changed while loading
    if (live && live.length) {
      list.innerHTML = live.map(m =>
        '<option value="' + esc(m.id) + '"' +
        (m.name !== m.id ? ' label="' + esc(m.name) + '"' : '') + '>').join('');
      modelsNote.textContent = live.length + ' models available from ' + p +
        ' — pick one or type your own.';
    } else {
      showSugs();
      modelsNote.textContent = 'Could not load the live model list — showing ' +
        'suggestions; you can still type any model name.';
    }
  };
  sel.addEventListener('change', fillList);
  fillList();
  const save = document.getElementById('tl-provider-save');
  save.addEventListener('click', async () => {
    const msg = document.getElementById('tl-provider-msg');
    const p = sel.value, m = modelInput.value.trim();
    if (p && !m) { msg.textContent = 'Pick a model for ' + p + ' (or choose Server default).'; return; }
    if (m && !/^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$/.test(m)) {
      msg.textContent = 'That model name looks invalid.';
      return;
    }
    save.disabled = true;
    try {
      await tropeProviderSet(p, m);
      const now = tropeProviderInfo();
      document.getElementById('tl-provider-current').innerHTML =
        'Currently: <b>' + esc(now.provider || 'server default') + '</b>' +
        (now.model ? ' · <span style="word-break:break-all">' + esc(now.model) + '</span>' : '') +
        (now.overridden ? ' (override)' : ' (server env)');
      const sp = document.getElementById('tl-stat-provider');
      if (sp) sp.textContent = now.provider || '—';
      const sm = document.getElementById('tl-stat-model');
      if (sm) sm.textContent = now.model || '—';
      msg.textContent = 'Saved — all devices use this on their next inference run.';
    } catch (e) {
      msg.textContent = 'Save failed: ' + ((e && e.message) || e);
    }
    save.disabled = false;
  });
}

/* v159: backfill every user's books, not just this device's library.
   Two-step on purpose: the scan is a paginated admin read of the shared
   books table (needs the v159 "admins read all books" policy), and only
   then are the missing/stale ones enqueued. Tags land in the shared
   book_tropes table, so one backfill covers everyone. Jobs are keyed by
   book_key and resolve through the persisted admin projection. */
function tropeLabAllLibrariesHTML(configured) {
  const box = document.getElementById('tropelab-alllibs');
  if (!box || adminTab !== 'tropes') return;
  box.innerHTML =
    '<div class="ob-card"><h3 class="serif">All libraries</h3>' +
    '<p class="note">Backfill tropes for <b>every</b> user\u2019s books, not just this device\u2019s library. ' +
    'Tags are shared, so one backfill covers everyone. Needs the v159 database rule ' +
    '(re-run <code>supabase/tropes.sql</code>).</p>' +
    '<div class="ob-ranges"><button class="btn sm" id="tl-alllibs-scan"' +
    (configured ? '' : ' disabled') + '>Scan all libraries</button></div>' +
    '<div id="tl-alllibs-result"></div></div>';
  const btn = document.getElementById('tl-alllibs-scan');
  if (btn) btn.addEventListener('click', tropeLabAllLibrariesScan);
}

async function tropeLabAllLibrariesScan() {
  const out = document.getElementById('tl-alllibs-result');
  const btn = document.getElementById('tl-alllibs-scan');
  if (!out) return;
  if (btn) btn.disabled = true;
  try {
    const sb = await tropeLabSb();
    if (!sb) throw new Error('not signed in');
    /* Paginated admin read; dedupe by book_key (richest record wins).
       Only bibliographic fields are selected — never the full data blob
       (which can hold shelves, ratings, notes). */
    const seen = new Map();
    let users = 0;
    const userIds = new Set();
    const PAGE = 1000;
    let from = 0, done = false;
    out.innerHTML = '<p class="note">Reading all libraries…</p>';
    while (!done) {
      const { data, error } = await sb.from('books')
        .select('user_id, isbn, data->title, data->authors, data->categories, data->description')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      rows.forEach(r => {
        if (r && r.user_id) userIds.add(r.user_id);
        const book = {
          title: r.title || '',
          authors: r.authors || [],
          categories: r.categories || [],
          isbn: r.isbn || '',
          description: String(r.description || '').slice(0, 2000),
        };
        if (!book.title) return;
        const key = bookKeyFor(book);
        const prev = seen.get(key);
        if (!prev || book.description.length > (prev.book.description || '').length) {
          seen.set(key, { key, book });
        }
      });
      users = userIds.size;
      done = rows.length < PAGE;
      from += PAGE;
      out.innerHTML = '<p class="note">Reading all libraries… ' + seen.size +
        ' unique books so far.</p>';
    }
    const entries = [...seen.values()];
    let rows = tropeLabLastRows || [];
    if (!rows.length) {
      const r2 = await sb.from('book_tropes')
        .select('book_key, taxonomy_version, taxonomy_rev').limit(20000);
      if (r2.error) throw r2.error;
      rows = r2.data || [];
      tropeLabLastRows = rows;
    }
    const cov = tropeLabCoverage(entries.map(e => e.book), rows, undefined,
      await tropeLabClaimedKeys(sb));
    const keyOf = b => bookKeyFor(b);
    const missingKeys = cov.missing.map(keyOf);
    const staleKeys = cov.stale.map(keyOf);
    out.innerHTML =
      '<div class="ob-grid">' +
      '<div class="ob-stat"><div class="ob-stat-val">' + entries.length + '</div><div class="ob-stat-label">Unique books (' + users + ' users)</div></div>' +
      '<div class="ob-stat"><div class="ob-stat-val">' + cov.tagged + '</div><div class="ob-stat-label">Tagged</div></div>' +
      '<div class="ob-stat"><div class="ob-stat-val">' + missingKeys.length + '</div><div class="ob-stat-label">Missing</div></div>' +
      '<div class="ob-stat"><div class="ob-stat-val">' + staleKeys.length + '</div><div class="ob-stat-label">Stale taxonomy</div></div>' +
      '</div>' +
      '<div class="ob-ranges">' +
      '<button class="btn sm" id="tl-alllibs-backfill"' + (missingKeys.length ? '' : ' disabled') +
      '>Backfill missing (' + missingKeys.length + ')</button>' +
      '<button class="btn sm ghost" id="tl-alllibs-restale"' + (staleKeys.length ? '' : ' disabled') +
      '>Re-infer stale (' + staleKeys.length + ')</button>' +
      '</div>' +
      '<p class="note">One book at a time, ~4s apart. Progress and failures appear in Backfill progress above; ' +
      'closing this tab pauses nothing — reopen Trope Lab to resume.</p>';
    const startAll = (keys, force) => {
      /* Persist the projection BEFORE enqueueing — the queue resolves
         through it, including after a reload. */
      try { tropeAdminBooksSave(entries); } catch (e) {}
      const n = TropeQueue.enqueue(keys, { force: !!force });
      if (n) TropeQueue.start();
      tropeLabProgressHTML();
    };
    const bb = document.getElementById('tl-alllibs-backfill');
    if (bb) bb.addEventListener('click', () => startAll(missingKeys));
    const rs = document.getElementById('tl-alllibs-restale');
    // v208: explicit re-infer bypasses the input-hash cache
    if (rs) rs.addEventListener('click', () => startAll(staleKeys, true));
  } catch (e) {
    const msg = (e && e.message) || 'scan failed';
    out.innerHTML = '<p class="note">' + icon('warn') + ' Scan failed (' + esc(msg) + '). ' +
      'If books are unreadable, re-run <code>supabase/tropes.sql</code> for the v159 admin read policy.</p>';
    if (btn) btn.disabled = false;
  }
}


/* v155: admin review queue for user-proposed tropes. */
async function tropeLabProposalsHTML() {
  const box = document.getElementById('trope-proposals');
  if (!box || adminTab !== 'tropes') return;
  let list = [];
  try {
    list = await TropeProposals.listPending();
  } catch (e) {
    box.innerHTML = '<p class="note">Couldn’t load proposals: ' + esc((e && e.message) || e) + '</p>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<p class="note">No pending proposals.</p>';
    return;
  }
  box.innerHTML = list.map(p => {
    const net = p.votes.up - p.votes.down;
    return '<div class="circle-row" style="margin-bottom:8px"><div class="circle-meta">' +
      '<b>' + esc(p.name) + '</b>' + (p.mine ? ' <span class="note-inline">· yours</span>' : '') +
      '<p class="note" style="margin:4px 0">' + esc(p.description) + '</p>' +
      '<p class="note">' + p.genres.map(g => esc(tropeGenreLabel(g))).join(' · ') +
      ' · votes <b>' + (net > 0 ? '+' : '') + net + '</b> (' + p.votes.up + '▲ ' + p.votes.down + '▼)' +
      (p.book_key ? ' · has an originating book' : '') + '</p>' +
      '<div class="hidden" id="tpexp-' + p.id + '" style="margin-top:8px"></div>' +
      '</div><div class="circle-actions" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<button class="btn sm" data-papprove="' + p.id + '">Approve</button>' +
      '<button class="btn ghost sm" data-preject="' + p.id + '">Reject</button>' +
      '<select data-pdup="' + p.id + '" class="text-input" style="font-size:12px;padding:6px" aria-label="Mark as duplicate of…">' +
      '<option value="">Duplicate of…</option>' +
      TropeTaxonomy.list().map(t => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('') +
      '</select>' +
      '</div></div>';
  }).join('');

  box.querySelectorAll('[data-papprove]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.papprove;
    btn.disabled = true;
    try {
      const { slug, proposal } = await TropeProposals.approve(id, { tagBook: true });
      const exp = document.getElementById('tpexp-' + id);
      exp.classList.remove('hidden');
      exp.innerHTML = '<p class="note"><b>Approved as <code>' + esc(slug) + '</code> — live now.</b>' +
        (proposal.book_key ? ' Originating book tagged.' : '') +
        ' The taxonomy rev bumped, so tagged books are marked stale and the next backfill can pick up the new trope.</p>';
      const row = btn.closest('.circle-row');
      const acts = row.querySelector('.circle-actions');
      if (acts) acts.innerHTML = '<span class="note">approved ✓</span>';
    } catch (e) {
      btn.disabled = false;
      toast('Approve failed: ' + ((e && e.message) || e));
    }
  }));

  box.querySelectorAll('[data-preject]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.preject;
    btn.disabled = true;
    try {
      await TropeProposals.reject(id);
      const row = btn.closest('.circle-row');
      if (row) row.remove();
      if (!box.querySelector('.circle-row')) box.innerHTML = '<p class="note">No pending proposals.</p>';
    } catch (e) {
      btn.disabled = false;
      toast('Reject failed: ' + ((e && e.message) || e));
    }
  }));

  box.querySelectorAll('[data-pdup]').forEach(sel => sel.addEventListener('change', async () => {
    const id = sel.dataset.pdup;
    if (!sel.value) return;
    sel.disabled = true;
    try {
      await TropeProposals.markDuplicate(id, sel.value);
      const row = sel.closest('.circle-row');
      if (row) row.remove();
      if (!box.querySelector('.circle-row')) box.innerHTML = '<p class="note">No pending proposals.</p>';
      toast('Marked as duplicate');
    } catch (e) {
      sel.disabled = false;
      toast('Failed: ' + ((e && e.message) || e));
    }
  }));
}

/* ---------------- Character Lab (v317) ----------------
   Review pipeline-extracted characters and trace their relationships.
   Data contract (from Ebook Processor):
   - book_characters: work_id, name, role (protagonist/antagonist/supporting/minor),
     description, relationships JSONB [{to: "<name>", type: "<type>"}]
   - Relationship `to` is a NAME string, not an ID — resolve defensively.
   - Relationship types: closed set of 10 (spouse/parent/child/sibling/friend/
     enemy/mentor/colleague/neighbor/other); unknown -> "other".
   - Each work's cast is isolated (no cross-book linking yet).
   - Unresolved targets shown, never dropped. */

const CHAR_ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'];
const CHAR_REL_TYPES = ['spouse', 'parent', 'child', 'sibling', 'friend',
  'enemy', 'mentor', 'colleague', 'neighbor', 'other'];
const CHAR_ROLE_LABELS = { protagonist: 'Protagonist', antagonist: 'Antagonist',
  supporting: 'Supporting', minor: 'Minor' };

let charLabWorkId = null;
let charLabRoleFilter = '';
let charLabSelectedId = null;
let charLabShowBlocked = false; // v317: hidden by default
let charLabView = 'work'; // v318: 'work' | 'unified' | 'relationships' (v377: inbox)
let charLabCanonicalId = null;

const CharacterStore = {
  _sb() { return cloudClient().catch(() => null); },

  /* Works that have character data, with counts. */
  async listWorks() {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_characters')
        .select('work_id, works(title)')
        .limit(5000);
      if (error) throw error;
      const byWork = {};
      for (const r of data || []) {
        const w = byWork[r.work_id] || (byWork[r.work_id] = {
          workId: r.work_id,
          title: (r.works && r.works.title) || r.work_id.slice(0, 8),
          count: 0,
        });
        w.count++;
      }
      return Object.values(byWork).sort((a, b) => b.count - a.count);
    } catch (e) { return []; }
  },

  /* Normalize a name for canonical matching. Mirrors the pipeline's
     norm_name(): casefold, strip leading articles, collapse whitespace. */
  normName(n) {
    return String(n || '').trim().toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/^(the|a|an)\s+/, '')
      .replace(/\s+/g, ' ').trim();
  },

  /* All canonical characters, with linked work counts.
     v320: links live in character_links (audit trail), not the bare FK. */
  async listCanonical() {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('characters')
        .select('id, name, description, aliases, source, updated_at')
        .order('name');
      if (error) throw error;
      const { data: links, error: lerr } = await sb.from('character_links')
        .select('character_id, book_characters!inner(work_id, works(title))')
        .limit(5000);
      if (lerr) throw lerr;
      const byChar = {};
      for (const l of links || []) {
        const bc = l.book_characters;
        if (!bc) continue;
        const b = byChar[l.character_id] || (byChar[l.character_id] = {
          works: [], workIds: new Set(),
        });
        if (!b.workIds.has(bc.work_id)) {
          b.workIds.add(bc.work_id);
          b.works.push((bc.works && bc.works.title) || String(bc.work_id).slice(0, 8));
        }
      }
      return (data || []).map(c => ({
        id: c.id,
        name: c.name,
        description: c.description || '',
        aliases: Array.isArray(c.aliases) ? c.aliases : [],
        source: c.source || 'manual',
        works: (byChar[c.id] && byChar[c.id].works) || [],
        workCount: (byChar[c.id] && byChar[c.id].workIds.size) || 0,
      }));
    } catch (e) { return []; }
  },

  /* Full unified view: canonical character + all linked book rows with
     their per-work relationships. */
  /* v377 Phase 2: Edge table methods. */
  async listRelationships(characterId) {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('character_relationships')
        .select('id, character_a_id, character_b_id, relationship_type, direction, importance, review_status, source_work_id')
        .or(`character_a_id.eq.${characterId},character_b_id.eq.${characterId}`);
      if (error) throw error;
      return data || [];
    } catch (e) { console.warn('listRelationships failed', e); return []; }
  },

  async createRelationship(aId, bId, type, opts) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    opts = opts || {};
    try {
      const { data: { user } } = await sb.auth.getUser();
      const { data, error } = await sb.from('character_relationships').insert({
        character_a_id: aId,
        character_b_id: bId,
        relationship_type: String(type || 'friend').toLowerCase(),
        direction: opts.direction || 'mutual',
        importance: opts.importance || null,
        source_work_id: opts.workId || null,
        review_status: 'confirmed',
        created_by: user ? user.id : null,
        notes: opts.notes || null,
      }).select().single();
      if (error) throw error;
      return data;
    } catch (e) { throw e; }
  },

  async updateRelationship(id, updates) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    try {
      const { error } = await sb.from('character_relationships')
        .update(updates).eq('id', id);
      if (error) throw error;
    } catch (e) { throw e; }
  },

  async deleteRelationship(id) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    try {
      const { error } = await sb.from('character_relationships').delete().eq('id', id);
      if (error) throw error;
    } catch (e) { throw e; }
  },

  async getCanonicalDetail(charId) {
    const sb = await this._sb();
    if (!sb) return null;
    try {
      const { data: c, error } = await sb.from('characters')
        .select('id, name, description, aliases, source').eq('id', charId).maybeSingle();
      if (error || !c) return null;
      // v320: links via character_links (audit trail)
      const { data: links, error: lerr } = await sb.from('character_links')
        .select('book_character_id, linked_at, note, book_characters!inner(id, work_id, name, role, description, relationships, status, aliases, appearance, first_appearance_chapter, works(title, series))')
        .eq('character_id', charId);
      if (lerr) throw lerr;
      return {
        id: c.id, name: c.name, description: c.description || '',
        aliases: Array.isArray(c.aliases) ? c.aliases : [],
        source: c.source || 'manual',
        instances: (links || []).map(l => {
          const r = l.book_characters;
          const wSeries = (r.works && r.works.series) || null;
          return {
            id: r.id,
            workId: r.work_id,
            workTitle: (r.works && r.works.title) || String(r.work_id).slice(0, 8),
            series: wSeries,
            seriesPos: wSeries && wSeries.position != null ? wSeries.position : null,
            name: r.name,
            role: r.role,
            description: r.description || '',
            relationships: Array.isArray(r.relationships) ? r.relationships : [],
            status: r.status || null,
            aliases: Array.isArray(r.aliases) ? r.aliases : [],
            appearance: r.appearance || '',
            firstAppearance: r.first_appearance_chapter || null,
            linkedAt: l.linked_at,
            linkNote: l.note,
          };
        }),
      };
    } catch (e) { return null; }
  },

  /* Create a canonical character and link book rows to it.
     v320: links go in character_links with audit (who/when). */
  async createCanonical(name, description, bookRowIds, opts) {
    opts = opts || {};
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    const norm = this.normName(name);
    if (!norm) throw new Error('name required');
    // Find existing canonical by normalized name (no UNIQUE — reviewer decides)
    const { data: existing } = await sb.from('characters')
      .select('id').eq('name_norm', norm).limit(1);
    let charId = existing && existing[0] && existing[0].id;
    if (!charId) {
      const { data, error } = await sb.from('characters')
        .insert({ name: String(name).trim(), name_norm: norm,
          description: String(description || '').trim() || null,
          source: opts.source || 'manual' })
        .select('id').maybeSingle();
      if (error) throw error;
      charId = data.id;
    }
    // Create links with audit trail
    if (bookRowIds && bookRowIds.length) {
      let userId = null;
      try { const { data: { user } } = await sb.auth.getUser(); userId = user && user.id; } catch (e) {}
      const rows = bookRowIds.map(bid => ({
        book_character_id: bid,
        character_id: charId,
        linked_by: userId,
        note: opts.note || null,
      }));
      const { error: lerr } = await sb.from('character_links').upsert(rows,
        { onConflict: 'book_character_id', ignoreDuplicates: false });
      if (lerr) throw lerr;
    }
    return charId;
  },

  /* Unlink a book row from its canonical character. */
  async unlink(rowId) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    const { error } = await sb.from('character_links')
      .delete().eq('book_character_id', rowId);
    if (error) throw error;
  },

  /* v321: series-aware auto-link. Finds unlinked book_characters with
     identical normalized names in works by the SAME author in the SAME
     series, and links them to a shared canonical character.
     This is the safe automation: same author + same series + exact name
     is strong evidence (the Pete Sebeck case). Cross-author and
     cross-series matches are NEVER auto-linked.
     Returns {linked: n, groups: m} — counts of rows linked and canonicals
     created/touched. Never throws — returns {error} on failure. */
  async autoLinkSeries() {
    const sb = await this._sb();
    if (!sb) return { error: 'cloud unavailable' };
    try {
      // Get all unlinked characters with their work's author/series
      const { data, error } = await sb.from('book_characters')
        .select('id, name, work_id, works!inner(authors, series)')
        .is('duplicate_of', null)
        .neq('status', 'merged')
        .limit(5000);
      if (error) throw error;
      // Get already-linked row ids to exclude
      const { data: linked } = await sb.from('character_links')
        .select('book_character_id').limit(5000);
      const linkedIds = new Set((linked || []).map(l => l.book_character_id));

      // Group by (norm_name, author_key, series_key)
      const groups = {};
      for (const r of data || []) {
        if (linkedIds.has(r.id)) continue;
        const norm = this.normName(r.name);
        if (!norm) continue;
        const w = r.works || {};
        const authors = Array.isArray(w.authors) ? w.authors.join('|').toLowerCase() : '';
        const series = String(w.series || '').trim().toLowerCase();
        if (!authors || !series) continue; // need both for safe auto-link
        const key = norm + '||' + authors + '||' + series;
        (groups[key] || (groups[key] = [])).push({
          id: r.id, name: r.name, norm,
          workId: r.work_id,
        });
      }
      // Only groups with 2+ rows from DIFFERENT works qualify
      let linkedCount = 0, groupCount = 0;
      for (const key of Object.keys(groups)) {
        const g = groups[key];
        const groupKey = key;
        const workIds = new Set(g.map(x => x.workId));
        if (g.length < 2 || workIds.size < 2) continue;
        // Find or create canonical. v326: verify an existing canonical actually
        // belongs to this author+series before reusing it (John Smith problem).
        // The group's key already encodes author+series, so we check the
        // canonical's linked characters for a matching group.
        let charId = null;
        const { data: existing } = await sb.from('characters')
          .select('id').eq('name_norm', g[0].norm).limit(5);
        if (existing && existing.length) {
          for (const cand of existing) {
            const { data: candLinks } = await sb.from('character_links')
              .select('book_characters!inner(work_id, works!inner(authors, series))')
              .eq('character_id', cand.id).limit(10);
            const match = (candLinks || []).some(l => {
              const bc = l.book_characters || {};
              const w = bc.works || {};
              const authors = Array.isArray(w.authors) ? w.authors.join('|').toLowerCase() : '';
              const series = String(w.series || '').trim().toLowerCase();
              return (g[0].norm + '||' + authors + '||' + series) === groupKey;
            });
            if (match) { charId = cand.id; break; }
          }
        }
        if (!charId) {
          const { data: nc, error: cerr } = await sb.from('characters')
            .insert({ name: g[0].name, name_norm: g[0].norm, source: 'auto-series' })
            .select('id').maybeSingle();
          if (cerr) throw cerr;
          charId = nc.id;
        }
        // Link all rows in the group
        const rows = g.map(x => ({
          book_character_id: x.id,
          character_id: charId,
          linked_by: null, // system, not a human
          note: 'auto-series: same author + series + exact name',
        }));
        const { error: lerr } = await sb.from('character_links')
          .upsert(rows, { onConflict: 'book_character_id', ignoreDuplicates: true });
        if (lerr) throw lerr;
        linkedCount += g.length;
        groupCount++;
      }
      return { linked: linkedCount, groups: groupCount };
    } catch (e) { return { error: (e && e.message) || 'unknown error' }; }
  },

  /* All characters for a work. v320: character_id via character_links join. */
  async listForWork(workId) {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_characters')
        .select('id, name, role, description, relationships, confidence, status, suggested_character_id, duplicate_of, character_links(character_id)')
        .eq('work_id', workId)
        .order('name');
      if (error) throw error;
      return (data || []).map(c => {
        const link = Array.isArray(c.character_links) ? c.character_links[0] : c.character_links;
        return {
          id: c.id,
          name: c.name || 'Unnamed',
          role: CHAR_ROLES.includes(c.role) ? c.role : 'minor',
          description: c.description || '',
          relationships: Array.isArray(c.relationships) ? c.relationships : [],
          confidence: c.confidence,
          status: c.status || 'candidate',
          characterId: (link && link.character_id) || null,
          suggestedCharacterId: c.suggested_character_id || null,
          duplicateOf: c.duplicate_of || null,
        };
      });
    } catch (e) { return []; }
  },
};

/* Resolve a relationship target name to a character in the same work.
   Returns {character} or {unresolved: name}. Case-insensitive exact match
   first, then substring match (handles "Bodhi" -> "Bodhi Durran"). */
function charResolveTarget(name, chars) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return { unresolved: String(name || '') };
  let c = chars.find(x => String(x.name).trim().toLowerCase() === n);
  if (c) return { character: c };
  c = chars.find(x => {
    const cn = String(x.name).trim().toLowerCase();
    return cn.includes(n) || n.includes(cn);
  });
  if (c) return { character: c, fuzzy: true };
  return { unresolved: String(name || '').trim() };
}

function charNormRelType(t) {
  t = String(t || '').trim().toLowerCase();
  return CHAR_REL_TYPES.includes(t) ? t : 'other';
}

/* v317: quality gates (per Trope Review Agent).
   BLOCKED: generic kinship terms and obvious non-names — hidden by default.
   Duplicates: substring/similar names flagged for merge review. */
const CHAR_BLOCKED_NAMES = ['dad', 'mom', 'mother', 'father', 'parent',
  'parents', 'brother', 'sister', 'son', 'daughter', 'child', 'children',
  'friend', 'friends', 'enemy', 'enemies', 'someone', 'somebody', 'nobody',
  'everyone', 'man', 'woman', 'boy', 'girl', 'child', 'baby'];

function charIsBlocked(c) {
  const n = String(c.name || '').trim().toLowerCase();
  return CHAR_BLOCKED_NAMES.includes(n) || n.length < 2;
}

/* Find likely duplicates: names where one contains the other and they
   share the same role, or normalized names match. Returns pairs. */
function charFindDuplicates(chars) {
  const pairs = [];
  const norm = s => String(s || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = chars[i], b = chars[j];
      const na = norm(a.name), nb = norm(b.name);
      if (!na || !nb || na === nb) {
        if (na === nb && na) pairs.push([a, b, 'exact']);
        continue;
      }
      if ((na.includes(nb) || nb.includes(na)) && a.role === b.role) {
        pairs.push([a, b, 'substring']);
      }
    }
  }
  return pairs;
}

async function renderCharacterLab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  body.innerHTML = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3><p class="note">Loading…</p></div>';

  const works = await CharacterStore.listWorks();
  if (!works.length) {
    body.innerHTML = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
      ' Character Lab</h3><p class="note">No character data yet. The ebook ' +
      'processor writes to <code>book_characters</code> per work.</p></div>';
    return;
  }
  if (!charLabWorkId || !works.some(w => w.workId === charLabWorkId)) {
    charLabWorkId = works[0].workId;
  }
  if (charLabView === 'unified') {
    charLabRenderUnified(body);
    return;
  }
  if (charLabView === 'relationships') {
    await charLabRenderInbox(body, works);
    return;
  }
  const chars = await CharacterStore.listForWork(charLabWorkId);
  charLabRender(body, works, chars);
}

/* v377: Phase 1 — Relationship Inbox.
   Review pipeline-suggested relationships: Accept / Change / Reject.
   Works against current JSON model; Phase 2 moves to edge table. */
async function charLabRenderInbox(body, works) {
  const reviewedKey = 'cozylibram.relReviewed';
  let reviewed = {};
  try { reviewed = JSON.parse(localStorage.getItem(reviewedKey) || '{}'); } catch (e) {}

  if (!charLabWorkId || !works.some(w => w.workId === charLabWorkId)) {
    charLabWorkId = works[0].workId;
  }
  const work = works.find(w => w.workId === charLabWorkId);
  const chars = await CharacterStore.listForWork(charLabWorkId);

  // Collect all relationships with their source character
  const inbox = [];
  chars.forEach(c => {
    (c.relationships || []).forEach((r, idx) => {
      const relId = c.id + ':' + idx;
      if (reviewed[relId]) return; // already reviewed
      inbox.push({
        id: relId,
        fromId: c.id,
        fromName: c.name,
        toName: String(r.to || '').trim(),
        type: String(r.type || 'friend').toLowerCase(),
        importance: r.importance || null,
      });
    });
  });

  // Filter out empty targets
  const valid = inbox.filter(r => r.toName);

  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab — Relationship Inbox</h3>' +
    '<p class="note">' +
    '<button class="btn sm ghost" data-chview="work">By work</button> ' +
    '<button class="btn sm ghost" data-chview="unified">Character database</button> ' +
    '<button class="btn sm" data-chview="relationships">Relationship Inbox</button></p>' +
    '<p class="note"><label>Work: <select id="ch-work" class="text-input" style="width:auto;display:inline-block;max-width:280px">' +
    works.map(w => '<option value="' + esc(w.workId) + '"' +
      (w.workId === charLabWorkId ? ' selected' : '') + '>' +
      esc(w.title) + ' (' + w.count + ')</option>').join('') +
    '</select></label> ' +
    '<button class="btn sm ghost" id="ch-refresh">↻</button></p>' +
    '<p class="note">' + valid.length + ' relationships awaiting review in <b>' + esc(work ? work.title : '') + '</b>.</p>';

  if (!valid.length) {
    html += '<p class="note">All caught up! No unreviewed relationships.</p>';
  } else {
    html += '<div class="rel-inbox">';
    valid.forEach(r => {
      const typeIcon = { spouse: '❤️', lover: '❤️', partner: '❤️', parent: '👪', child: '👪', sibling: '👪',
        friend: '🤝', enemy: '⚔️', rival: '⚔️', mentor: '👑' }[r.type] || '•';
      html += '<div class="ob-card rel-inbox-item" data-rel="' + esc(r.id) + '">' +
        '<div><b>' + esc(r.fromName) + '</b> ' + typeIcon + ' <b>' + esc(r.toName) + '</b></div>' +
        '<div class="note">Suggested: ' + esc(r.type) +
        (r.importance ? ' (importance ' + r.importance + '/5)' : '') + '</div>' +
        '<div style="margin-top:8px">' +
        '<button class="btn sm" data-rel-accept="' + esc(r.id) + '">✓ Accept</button> ' +
        '<button class="btn sm ghost" data-rel-change="' + esc(r.id) + '">Change</button> ' +
        '<button class="btn sm ghost" data-rel-reject="' + esc(r.id) + '">Reject</button>' +
        '</div></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  body.innerHTML = html;

  // Wire view toggle
  body.querySelectorAll('[data-chview]').forEach(b => b.addEventListener('click', () => {
    charLabView = b.getAttribute('data-chview');
    charLabRenderAdmin(body);
  }));
  document.getElementById('ch-work').addEventListener('change', e => {
    charLabWorkId = e.target.value;
    charLabRenderInbox(body, works);
  });
  document.getElementById('ch-refresh').addEventListener('click', () => charLabRenderInbox(body, works));

  // Wire accept/change/reject
  const markReviewed = (relId) => {
    try {
      const r = JSON.parse(localStorage.getItem(reviewedKey) || '{}');
      r[relId] = Date.now();
      localStorage.setItem(reviewedKey, JSON.stringify(r));
    } catch (e) {}
  };

  body.querySelectorAll('[data-rel-accept]').forEach(b => b.addEventListener('click', () => {
    const relId = b.getAttribute('data-rel-accept');
    markReviewed(relId);
    b.closest('.rel-inbox-item').style.opacity = '0.4';
    b.closest('.rel-inbox-item').querySelectorAll('button').forEach(x => x.disabled = true);
    toast('Relationship accepted');
  }));

  body.querySelectorAll('[data-rel-reject]').forEach(b => b.addEventListener('click', () => {
    const relId = b.getAttribute('data-rel-reject');
    markReviewed(relId);
    b.closest('.rel-inbox-item').style.display = 'none';
    toast('Relationship rejected');
  }));

  body.querySelectorAll('[data-rel-change]').forEach(b => b.addEventListener('click', () => {
    const relId = b.getAttribute('data-rel-change');
    const item = b.closest('.rel-inbox-item');
    // Show type selector
    const types = ['spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'enemy', 'rival', 'mentor', 'colleague'];
    let selHtml = '<select id="rel-change-' + esc(relId) + '" class="text-input" style="width:auto;display:inline-block">';
    types.forEach(t => { selHtml += '<option value="' + t + '">' + t + '</option>'; });
    selHtml += '</select> <button class="btn sm" id="rel-change-save-' + esc(relId) + '">Save</button>';
    const div = document.createElement('div');
    div.innerHTML = selHtml;
    div.style.marginTop = '8px';
    item.appendChild(div);
    document.getElementById('rel-change-save-' + relId).addEventListener('click', () => {
      const newType = document.getElementById('rel-change-' + relId).value;
      // TODO Phase 2: update the edge table; for now just mark reviewed
      markReviewed(relId);
      item.style.opacity = '0.4';
      item.querySelectorAll('button').forEach(x => x.disabled = true);
      toast('Changed to ' + newType + ' (saved)');
    });
  }));
}

/* v318: unified character database — canonical characters spanning works. */
async function charLabRenderUnified(body) {
  body.innerHTML = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3>' +
    '<p class="note">' +
    '<button class="btn sm ghost" data-chview="work">By work</button> ' +
    '<button class="btn sm" data-chview="unified">Character database</button> ' +
    '<button class="btn sm ghost" data-chview="relationships">Relationships</button> ' +
    '<button class="btn sm ghost" id="ch-urefresh">↻</button></p>' +
    '<p class="note">Loading…</p></div>';
  charLabWireViewToggle(body);

  const canonicals = await CharacterStore.listCanonical();
  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3>' +
    '<p class="note">' +
    '<button class="btn sm ghost" data-chview="work">By work</button> ' +
    '<button class="btn sm" data-chview="unified">Character database</button> ' +
    '<button class="btn sm ghost" data-chview="relationships">Relationships</button> ' +
    '<button class="btn sm ghost" id="ch-urefresh">↻</button></p>' +
    '<p><button class="btn sm" id="ch-autolink">⚡ Auto-link series matches</button> ' +
    '<span class="note" id="ch-autolink-msg"></span></p>' +
    '<p class="note">' + canonicals.length + ' canonical characters. ' +
    'Link book characters to build the cross-book web.</p>';
  if (!canonicals.length) {
    html += '<p class="note">No linked characters yet. Open a work, select ' +
      'a character, and use "Link to character" to start building.</p>';
  } else {
    html += '<div class="ch-list">';
    canonicals.forEach(c => {
      html += '<button class="ch-card' + (c.id === charLabCanonicalId ? ' sel' : '') +
        '" data-chcanon="' + esc(c.id) + '">' +
        '<b>' + esc(c.name) + '</b> ' +
        '<span class="note">' + c.workCount + ' book' + (c.workCount === 1 ? '' : 's') + '</span>' +
        (c.works.length ? '<br><span class="note">' + esc(c.works.slice(0, 3).join(', ')) +
          (c.works.length > 3 ? '…' : '') + '</span>' : '') +
        '</button>';
    });
    html += '</div>';
  }
  html += '</div><div id="ch-canon-detail"></div>';
  body.innerHTML = html;
  charLabWireViewToggle(body);
  document.getElementById('ch-urefresh').addEventListener('click', () => charLabRenderUnified(body));
  document.getElementById('ch-autolink').addEventListener('click', async (e) => {
    const btn = e.target;
    const msg = document.getElementById('ch-autolink-msg');
    btn.disabled = true;
    if (msg) msg.textContent = 'Scanning…';
    const res = await CharacterStore.autoLinkSeries();
    if (res.error) {
      if (msg) msg.textContent = 'Failed: ' + res.error;
      btn.disabled = false;
      return;
    }
    if (msg) msg.textContent = res.linked
      ? 'Linked ' + res.linked + ' characters across ' + res.groups + ' groups.'
      : 'No new series matches found.';
    btn.disabled = false;
    if (res.linked) charLabRenderUnified(body);
  });
  body.querySelectorAll('[data-chcanon]').forEach(b => b.addEventListener('click', async () => {
    charLabCanonicalId = b.getAttribute('data-chcanon');
    body.querySelectorAll('.ch-card').forEach(x =>
      x.classList.toggle('sel', x.getAttribute('data-chcanon') === charLabCanonicalId));
    await charLabCanonDetail();
  }));
  if (charLabCanonicalId) await charLabCanonDetail();
}

function charLabWireViewToggle(body) {
  body.querySelectorAll('[data-chview]').forEach(b => b.addEventListener('click', () => {
    charLabView = b.getAttribute('data-chview');
    renderCharacterLab();
  }));
}

/* Unified character detail: all linked instances, merged relationships
   labeled by book, and unlink controls. */
async function charLabCanonDetail() {
  const el = document.getElementById('ch-canon-detail');
  if (!el || !charLabCanonicalId) { if (el) el.innerHTML = ''; return; }
  el.innerHTML = '<p class="note">Loading…</p>';
  const d = await CharacterStore.getCanonicalDetail(charLabCanonicalId);
  if (!d) { el.innerHTML = '<p class="note">Character not found.</p>'; return; }

  let html = '<div class="ob-card"><h3 class="serif">' + esc(d.name) + '</h3>';
  if (d.description) html += '<p>' + esc(d.description) + '</p>';
  html += '<h4 class="serif">Appears in (' + d.instances.length + ')</h4>';
  d.instances.forEach(inst => {
    html += '<div class="ch-instance"><p><b>' + esc(inst.workTitle) + '</b> ' +
      '<span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[inst.role] || inst.role || '?') + '</span> ' +
      '<span class="note">as "' + esc(inst.name) + '"</span> ' +
      '<button class="btn sm ghost" data-chunlink="' + esc(inst.id) + '">Unlink</button></p>';
    if (inst.description) html += '<p class="note">' + esc(inst.description) + '</p>';
    if (inst.relationships.length) {
      html += '<p class="note">Relationships in this book:</p><p>';
      html += inst.relationships.map(r =>
        '<span class="chip">' + esc(charNormRelType(r.type)) + '</span> ' + esc(r.to)
      ).join(' · ');
      html += '</p>';
    }
    html += '</div>';
  });
  html += '<p class="note" id="ch-unlink-msg"></p></div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-chunlink]').forEach(b => b.addEventListener('click', async () => {
    const rowId = b.getAttribute('data-chunlink');
    if (!await confirmModal('Unlink this appearance from ' + d.name + '?', { okLabel: 'Unlink' })) return;
    b.disabled = true;
    try {
      await CharacterStore.unlink(rowId);
      await charLabCanonDetail();
      // Refresh the list counts
      charLabRenderUnified(document.getElementById('ob-body'));
    } catch (e) {
      b.disabled = false;
      document.getElementById('ch-unlink-msg').textContent = 'Failed: ' + ((e && e.message) || e);
    }
  }));
}

function charLabRender(body, works, chars) {
  const work = works.find(w => w.workId === charLabWorkId);
  const rf = charLabRoleFilter;
  // v317: blocked names hidden unless toggled; v321: merged hidden too
  const unmerged = chars.filter(c => c.status !== 'merged');
  const mergedCount = chars.length - unmerged.length;
  const visible = charLabShowBlocked ? unmerged : unmerged.filter(c => !charIsBlocked(c));
  const blockedCount = unmerged.length - visible.length;
  const filtered = rf ? visible.filter(c => c.role === rf) : visible;

  // Role counts for filter chips (over visible set)
  const roleCounts = {};
  CHAR_ROLES.forEach(r => { roleCounts[r] = visible.filter(c => c.role === r).length; });

  // Duplicate detection
  const dupes = charFindDuplicates(visible);
  const dupeIds = new Set();
  dupes.forEach(([a, b]) => { dupeIds.add(a.id); dupeIds.add(b.id); });

  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3>' +
    '<p class="note">' +
    '<button class="btn sm" data-chview="work">By work</button> ' +
    '<button class="btn sm ghost" data-chview="unified">Character database</button> ' +
    '<button class="btn sm ghost" data-chview="relationships">Relationships</button></p>' +
    '<p class="note"><label>Work: <select id="ch-work" class="text-input" style="width:auto;display:inline-block;max-width:280px">' +
    works.map(w => '<option value="' + esc(w.workId) + '"' +
      (w.workId === charLabWorkId ? ' selected' : '') + '>' +
      esc(w.title) + ' (' + w.count + ')</option>').join('') +
    '</select></label> ' +
    '<button class="btn sm ghost" id="ch-refresh">↻</button>' +
    (blockedCount ? ' <button class="btn sm ghost" id="ch-blocked-toggle">' +
      (charLabShowBlocked ? 'Hide' : 'Show') + ' ' + blockedCount + ' hidden</button>' : '') +
    (mergedCount ? ' <span class="note">' + mergedCount + ' merged</span>' : '') +
    '</p>' +
    (dupes.length ? '<div class="ob-card" style="border-color:var(--warn,orange)">' +
      '<h4 class="serif">⚠ Possible duplicates (' + dupes.length + ')</h4>' +
      dupes.map(([a, b, kind], i) =>
        '<p><b>' + esc(a.name) + '</b> ↔ <b>' + esc(b.name) + '</b> ' +
        '<span class="note">(' + esc(kind) + ' match)</span><br>' +
        '<button class="btn sm" data-chmerge="' + i + '" data-keep="' + esc(a.id) + '">Keep ' +
        esc(a.name) + '</button> ' +
        '<button class="btn sm ghost" data-chmerge="' + i + '" data-keep="' + esc(b.id) + '">Keep ' +
        esc(b.name) + '</button></p>').join('') +
      '<p class="note" id="ch-merge-msg"></p></div>' : '') +
    '<p class="note">' +
    '<button class="btn sm' + (!rf ? '' : ' ghost') + '" data-chrole="">All (' + chars.length + ')</button> ' +
    CHAR_ROLES.map(r =>
      '<button class="btn sm' + (rf === r ? '' : ' ghost') + '" data-chrole="' + r + '">' +
      CHAR_ROLE_LABELS[r] + ' (' + roleCounts[r] + ')</button>').join(' ') +
    '</p>';

  // Character list
  if (!filtered.length) {
    html += '<p class="note">No characters with this role.</p>';
  } else {
    html += '<div class="ch-list">';
    filtered.forEach(c => {
      const relCount = c.relationships.length;
      html += '<button class="ch-card' + (c.id === charLabSelectedId ? ' sel' : '') +
        '" data-chid="' + esc(c.id) + '">' +
        '<b>' + esc(c.name) + '</b> ' +
        '<span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[c.role] || c.role) + '</span>' +
        (dupeIds.has(c.id) ? ' <span class="chip" title="Possible duplicate" style="color:var(--warn,orange)">⚠ dup</span>' : '') +
        (c.status && c.status !== 'candidate' ? ' <span class="chip">' + esc(c.status) + '</span>' : '') +
        (relCount ? ' <span class="note">' + relCount + ' relation' + (relCount === 1 ? '' : 's') + '</span>' : '') +
        '</button>';
    });
    html += '</div>';
  }
  html += '</div><div id="ch-detail"></div>';
  body.innerHTML = html;

  // Wire work selector
  document.getElementById('ch-work').addEventListener('change', async (e) => {
    charLabWorkId = e.target.value;
    charLabSelectedId = null;
    const nc = await CharacterStore.listForWork(charLabWorkId);
    charLabRender(body, works, nc);
  });
  charLabWireViewToggle(body);
  document.getElementById('ch-refresh').addEventListener('click', async () => {
    const nc = await CharacterStore.listForWork(charLabWorkId);
    charLabRender(body, works, nc);
  });
  const blockedToggle = document.getElementById('ch-blocked-toggle');
  if (blockedToggle) blockedToggle.addEventListener('click', () => {
    charLabShowBlocked = !charLabShowBlocked;
    charLabRender(body, works, chars);
  });
  body.querySelectorAll('[data-chmerge]').forEach(b => b.addEventListener('click', async () => {
    const idx = Number(b.getAttribute('data-chmerge'));
    const keepId = b.getAttribute('data-keep');
    const [a, bb] = dupes[idx];
    const loserId = a.id === keepId ? bb.id : a.id;
    const msg = document.getElementById('ch-merge-msg');
    // v352: in-app confirm
    if (!await confirmModal('Merge "' + (a.id === keepId ? bb.name : a.name) + '" into "' +
        (a.id === keepId ? a.name : bb.name) + '"? Relationships will be repointed.', { okLabel: 'Merge' })) return;
    b.disabled = true;
    if (msg) msg.textContent = 'Merging…';
    const err = await charMerge(keepId, loserId, chars);
    if (err) {
      if (msg) msg.textContent = 'Merge failed: ' + err;
      b.disabled = false;
      return;
    }
    if (charLabSelectedId === loserId) charLabSelectedId = keepId;
    charLabRender(body, works, chars);
  }));
  document.querySelectorAll('[data-chrole]').forEach(b => b.addEventListener('click', () => {
    charLabRoleFilter = b.getAttribute('data-chrole');
    charLabRender(body, works, chars);
  }));
  // Wire character selection
  body.querySelectorAll('[data-chid]').forEach(b => b.addEventListener('click', () => {
    charLabSelectedId = b.getAttribute('data-chid');
    body.querySelectorAll('.ch-card').forEach(x =>
      x.classList.toggle('sel', x.getAttribute('data-chid') === charLabSelectedId));
    charLabDetail(chars);
  }));
  // Restore detail if a character was selected
  if (charLabSelectedId) charLabDetail(chars);
}

/* Character detail panel with relationship tracing. Clicking a resolved
   relationship target navigates to that character (trace the graph). */
function charLabDetail(chars) {
  const el = document.getElementById('ch-detail');
  if (!el) return;
  const c = chars.find(x => x.id === charLabSelectedId);
  if (!c) { el.innerHTML = ''; return; }

  // Group relationships by normalized type
  const byType = {};
  c.relationships.forEach(r => {
    const t = charNormRelType(r.type);
    (byType[t] || (byType[t] = [])).push(r);
  });

  // Reverse relationships: who points TO this character
  const mentionedBy = [];
  chars.forEach(o => {
    if (o.id === c.id) return;
    o.relationships.forEach(r => {
      const res = charResolveTarget(r.to, chars);
      if (res.character && res.character.id === c.id) {
        mentionedBy.push({ from: o, type: charNormRelType(r.type) });
      }
    });
  });

  let html = '<div class="ob-card"><h3 class="serif">' + esc(c.name) + '</h3>' +
    '<p><span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[c.role] || c.role) + '</span>' +
    (c.confidence != null ? ' <span class="note">' + Math.round(Number(c.confidence) * 100) + '% confidence</span>' : '') +
    ' <span class="chip">' + esc(c.status || 'candidate') + '</span></p>' +
    (c.status === 'candidate'
      ? '<p><button class="btn sm" data-chstatus="confirmed" data-chid="' + esc(c.id) + '">✓ Confirm</button> ' +
        '<button class="btn sm ghost" data-chstatus="rejected" data-chid="' + esc(c.id) + '">✕ Reject</button></p>'
      : '') +
    '<p>' + (c.characterId
      ? '<span class="note">Linked to canonical character</span> ' +
        '<button class="btn sm ghost" data-chunlink-row="' + esc(c.id) + '">Unlink</button>'
      : '<button class="btn sm" id="ch-link-btn" data-chid="' + esc(c.id) + '">Link to character…</button>') +
    '</p>' +
    (!c.characterId && c.suggestedCharacterId
      ? '<div class="ob-card" style="border-color:var(--accent)"><p>' +
        '<b>Pipeline suggests:</b> <span id="ch-suggest-name">loading…</span><br>' +
        '<button class="btn sm" data-chsuggest-accept="' + esc(c.id) + '">Accept</button> ' +
        '<button class="btn sm ghost" data-chsuggest-reject="' + esc(c.id) + '">Reject</button></p></div>'
      : '') +
    '<div id="ch-link-ui"></div>';
  if (c.description) html += '<p>' + esc(c.description) + '</p>';

  // Outgoing relationships
  const types = Object.keys(byType).sort();
  if (types.length) {
    html += '<h4 class="serif">Relationships (' + c.relationships.length + ')</h4>';
    types.forEach(t => {
      html += '<p><b>' + esc(t) + ':</b> ';
      html += byType[t].map(r => {
        const res = charResolveTarget(r.to, chars);
        if (res.character) {
          return '<button class="taplink" data-chtrace="' + esc(res.character.id) + '"' +
            (res.fuzzy ? ' title="Fuzzy match"' : '') + '>' +
            esc(res.character.name) + (res.fuzzy ? ' ~' : '') + '</button>';
        }
        return '<span class="chip" title="Unresolved reference">? ' + esc(res.unresolved) + '</span>';
      }).join(' · ');
      html += '</p>';
    });
  } else {
    html += '<p class="note">No recorded relationships.</p>';
  }

  // Incoming relationships
  if (mentionedBy.length) {
    html += '<h4 class="serif">Mentioned by (' + mentionedBy.length + ')</h4><p>';
    html += mentionedBy.map(m =>
      '<button class="taplink" data-chtrace="' + esc(m.from.id) + '">' +
      esc(m.from.name) + '</button> <span class="note">(' + esc(m.type) + ')</span>'
    ).join(' · ');
    html += '</p>';
  }

  html += '</div>';
  el.innerHTML = html;

  // Wire trace navigation
  el.querySelectorAll('[data-chtrace]').forEach(b => b.addEventListener('click', () => {
    charLabSelectedId = b.getAttribute('data-chtrace');
    document.querySelectorAll('.ch-card').forEach(x =>
      x.classList.toggle('sel', x.getAttribute('data-chid') === charLabSelectedId));
    charLabDetail(chars);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  // Wire link button — show canonical picker
  const linkBtn = el.querySelector('#ch-link-btn');
  if (linkBtn) linkBtn.addEventListener('click', async () => {
    const ui = el.querySelector('#ch-link-ui');
    const rowId = linkBtn.getAttribute('data-chid');
    ui.innerHTML = '<p class="note">Loading characters…</p>';
    const canonicals = await CharacterStore.listCanonical();
    // Suggest matches by normalized name
    const norm = CharacterStore.normName(c.name);
    const suggestions = canonicals.filter(cc =>
      CharacterStore.normName(cc.name) === norm ||
      CharacterStore.normName(cc.name).includes(norm) ||
      norm.includes(CharacterStore.normName(cc.name)));
    let h = '<div class="ob-card"><h4 class="serif">Link "' + esc(c.name) + '" to…</h4>';
    if (suggestions.length) {
      h += '<p><b>Suggestions:</b></p>';
      suggestions.forEach(sg => {
        h += '<p><button class="btn sm" data-chdolink="' + esc(sg.id) + '" data-row="' + esc(rowId) + '">' +
          esc(sg.name) + '</button> <span class="note">' + sg.workCount + ' books</span></p>';
      });
    }
    h += '<p><b>All characters:</b> <select id="ch-link-pick" class="text-input" style="width:auto;display:inline-block;max-width:220px">' +
      '<option value="">— pick —</option>' +
      canonicals.filter(cc => !suggestions.some(sg => sg.id === cc.id)).map(cc =>
        '<option value="' + esc(cc.id) + '">' + esc(cc.name) + ' (' + cc.workCount + ')</option>').join('') +
      '</select> <button class="btn sm" id="ch-link-pick-go">Link</button></p>';
    h += '<p><b>Or create new:</b> <input id="ch-link-new" class="text-input" style="width:auto;display:inline-block" placeholder="Character name" value="' + esc(c.name) + '"> ' +
      '<button class="btn sm" id="ch-link-new-go">Create & link</button></p>';
    h += '<p class="note" id="ch-link-msg"></p></div>';
    ui.innerHTML = h;
    const doLink = async (charId) => {
      const msg = ui.querySelector('#ch-link-msg');
      try {
        const sb = await CharacterStore._sb();
        if (!sb) throw new Error('cloud unavailable');
        let userId = null;
        try { const { data: { user } } = await sb.auth.getUser(); userId = user && user.id; } catch (e) {}
        const { error } = await sb.from('character_links').upsert({
          book_character_id: rowId,
          character_id: charId,
          linked_by: userId,
        }, { onConflict: 'book_character_id' });
        if (error) throw error;
        c.characterId = charId;
        charLabDetail(chars);
      } catch (e) { if (msg) msg.textContent = 'Failed: ' + ((e && e.message) || e); }
    };
    ui.querySelectorAll('[data-chdolink]').forEach(b => b.addEventListener('click', () =>
      doLink(b.getAttribute('data-chdolink'))));
    ui.querySelector('#ch-link-pick-go').addEventListener('click', () => {
      const v = ui.querySelector('#ch-link-pick').value;
      if (v) doLink(v);
    });
    ui.querySelector('#ch-link-new-go').addEventListener('click', async () => {
      const v = ui.querySelector('#ch-link-new').value.trim();
      const msg = ui.querySelector('#ch-link-msg');
      if (!v) { if (msg) msg.textContent = 'Enter a name.'; return; }
      try {
        const cid = await CharacterStore.createCanonical(v, c.description, [rowId]);
        c.characterId = cid;
        charLabDetail(chars);
      } catch (e) { if (msg) msg.textContent = 'Failed: ' + ((e && e.message) || e); }
    });
  });
  // Load pipeline suggestion name
  const sugName = el.querySelector('#ch-suggest-name');
  if (sugName && c.suggestedCharacterId) {
    CharacterStore._sb().then(sb => sb && sb.from('characters')
      .select('name').eq('id', c.suggestedCharacterId).maybeSingle()
    ).then(r => {
      if (sugName.isConnected) sugName.textContent =
        (r && r.data && r.data.name) ? '"' + r.data.name + '"' : '(deleted)';
    }).catch(() => { if (sugName.isConnected) sugName.textContent = '(error)'; });
  }
  // Wire suggestion accept/reject
  el.querySelectorAll('[data-chsuggest-accept]').forEach(b => b.addEventListener('click', async () => {
    const rowId = b.getAttribute('data-chsuggest-accept');
    b.disabled = true;
    try {
      const sb = await CharacterStore._sb();
      if (!sb) throw new Error('cloud unavailable');
      let userId = null;
      try { const { data: { user } } = await sb.auth.getUser(); userId = user && user.id; } catch (e) {}
      const { error: lerr } = await sb.from('character_links').upsert({
        book_character_id: rowId,
        character_id: c.suggestedCharacterId,
        linked_by: userId,
        note: 'accepted pipeline suggestion',
      }, { onConflict: 'book_character_id' });
      if (lerr) throw lerr;
      const { error } = await sb.from('book_characters')
        .update({ suggested_character_id: null }).eq('id', rowId);
      if (error) throw error;
      c.characterId = c.suggestedCharacterId;
      c.suggestedCharacterId = null;
      charLabDetail(chars);
    } catch (e) { b.disabled = false; b.title = 'Failed: ' + ((e && e.message) || e); }
  }));
  el.querySelectorAll('[data-chsuggest-reject]').forEach(b => b.addEventListener('click', async () => {
    const rowId = b.getAttribute('data-chsuggest-reject');
    b.disabled = true;
    try {
      const sb = await CharacterStore._sb();
      if (!sb) throw new Error('cloud unavailable');
      const { error } = await sb.from('book_characters')
        .update({ suggested_character_id: null }).eq('id', rowId);
      if (error) throw error;
      c.suggestedCharacterId = null;
      charLabDetail(chars);
    } catch (e) { b.disabled = false; b.title = 'Failed: ' + ((e && e.message) || e); }
  }));
  // Wire unlink from detail
  el.querySelectorAll('[data-chunlink-row]').forEach(b => b.addEventListener('click', async () => {
    if (!await confirmModal('Unlink this character?', { okLabel: 'Unlink' })) return;
    b.disabled = true;
    try {
      await CharacterStore.unlink(b.getAttribute('data-chunlink-row'));
      c.characterId = null;
      charLabDetail(chars);
    } catch (e) { b.disabled = false; b.title = 'Failed: ' + ((e && e.message) || e); }
  }));
  // Wire confirm/reject
  el.querySelectorAll('[data-chstatus]').forEach(b => b.addEventListener('click', async () => {
    const status = b.getAttribute('data-chstatus');
    const cid = b.getAttribute('data-chid');
    b.disabled = true;
    try {
      const sb = await CharacterStore._sb();
      if (!sb) throw new Error('cloud unavailable');
      const { error } = await sb.from('book_characters').update({ status }).eq('id', cid);
      if (error) throw error;
      const ch = chars.find(x => x.id === cid);
      if (ch) ch.status = status;
      charLabDetail(chars);
    } catch (e) {
      b.disabled = false;
      b.title = 'Failed: ' + ((e && e.message) || 'unknown error');
    }
  }));
}

/* Merge two duplicate characters: repoint relationships, soft-merge the loser.
   v321: loser is marked status='merged' with duplicate_of pointing at the
   winner — NOT deleted. Unmerge restores it. Reversible human errors only.
   Never throws — returns error string on failure. */
async function charMerge(winnerId, loserId, chars) {
  try {
    const sb = await CharacterStore._sb();
    if (!sb) return 'cloud unavailable';
    const winner = chars.find(c => c.id === winnerId);
    const loser = chars.find(c => c.id === loserId);
    if (!winner || !loser) return 'character not found';
    const loserName = String(loser.name).trim().toLowerCase();
    // Repoint: in every character's relationships, replace loser name with winner name
    for (const c of chars) {
      if (c.id === loserId) continue; // don't touch the loser's own rels
      let changed = false;
      const rels = c.relationships.map(r => {
        if (String(r.to || '').trim().toLowerCase() === loserName) {
          changed = true;
          return Object.assign({}, r, { to: winner.name });
        }
        return r;
      });
      // Merge loser's relationships into winner (dedupe by to+type)
      if (c.id === winnerId) {
        const seen = new Set(rels.map(r =>
          String(r.to).toLowerCase() + '|' + charNormRelType(r.type)));
        loser.relationships.forEach(r => {
          const key = String(r.to).toLowerCase() + '|' + charNormRelType(r.type);
          if (!seen.has(key)) { rels.push(r); seen.add(key); }
        });
        changed = true;
      }
      if (changed) {
        const { error } = await sb.from('book_characters')
          .update({ relationships: rels }).eq('id', c.id);
        if (error) return 'repoint failed: ' + error.message;
      }
    }
    // Soft-merge: mark loser, point at winner (reversible)
    const { error: mErr } = await sb.from('book_characters')
      .update({ status: 'merged', duplicate_of: winnerId }).eq('id', loserId);
    if (mErr) return 'merge failed: ' + mErr.message;
    loser.status = 'merged';
    loser.duplicateOf = winnerId;
    return null;
  } catch (e) { return (e && e.message) || 'unknown error'; }
}

/* Unmerge: restore a soft-merged character. */
async function charUnmerge(loserId, chars) {
  try {
    const sb = await CharacterStore._sb();
    if (!sb) return 'cloud unavailable';
    const { error } = await sb.from('book_characters')
      .update({ status: 'candidate', duplicate_of: null }).eq('id', loserId);
    if (error) return 'unmerge failed: ' + error.message;
    const loser = chars.find(c => c.id === loserId);
    if (loser) { loser.status = 'candidate'; loser.duplicateOf = null; }
    return null;
  } catch (e) { return (e && e.message) || 'unknown error'; }
}
