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

/* ---------------- Trope Lab ----------------
   The Trope Lab (coverage, review + claim queues, provider picker,
   all-libraries backfill, proposals, renderTropeLab) moved to
   js/161-tropelab.js (architecture candidate 6). This file keeps the
   Observatory shell and the other tabs; renderAdmin() still dispatches
   adminTab === 'tropes' to renderTropeLab() there. */

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

/* ---------------- Character Lab ----------------
   The Character Lab (curation views, merge/unmerge and the
   restore companions, renderCharacterLab) moved to
   js/162-charlab.js (architecture candidate 6). This file keeps
   the Observatory shell and the other tabs; renderAdmin() still
   dispatches adminTab === 'characters' to renderCharacterLab() there. */
