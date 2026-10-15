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

const CHAR_ROLE_LABELS = { protagonist: 'Protagonist', antagonist: 'Antagonist',
  supporting: 'Supporting', minor: 'Minor' };

let charLabWorkId = null;
let charLabRoleFilter = '';
let charLabSelectedId = null;
let charLabShowBlocked = false; // v317: hidden by default
let charLabView = 'characters'; // v395: 'review' | 'relationships' | 'characters' (was 'work'|'relationships')
let charLabCanonicalId = null;

/* CharacterStore, the pure char helpers (charResolveTarget, charNormRelType,
   charIsBlocked, charFindDuplicates) and CHAR_ROLES / CHAR_REL_TYPES live in
   js/154-characterstore.js — the Character Lab UI below consumes them as
   globals, same as js/159 and js/225. */

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
  // v395: New navigation — Review | Relationships | Characters
  if (charLabView === 'review') {
    await charLabRenderReview(body, works);
    return;
  }
  if (charLabView === 'relationships') {
    await charLabRenderRelationships(body, works);
    return;
  }
  // Default: Characters view (was 'work')
  const chars = await CharacterStore.listForWork(charLabWorkId);
  charLabRender(body, works, chars);
}

/* v395: Review view — things needing human attention.
   Currently: relationship inbox. Future: characters needing review, identity matches. */
async function charLabRenderReview(body, works) {
  // For now, Review = Relationship Inbox
  await charLabRenderInbox(body, works);
}

/* v395: Relationships workspace — graph + inbox + table.
   Coming soon: D3 graph integration. Hidden from nav until then. */
async function charLabRenderRelationships(body, works) {
  body.innerHTML = '<div class="ob-card"><h3 class="serif">Relationships</h3>' +
    '<p class="note">Graph workspace coming soon. Use Review for now.</p></div>';
}

/* v397: Shared work deletion (consolidated from inbox + grid duplicates). */
async function deleteWork(workId, workTitle) {
  if (!await confirmModal('Delete work "' + workTitle + '"? This removes the work, its editions, characters, relationships, claims, and quotes. This cannot be undone.', { okLabel: 'Delete', danger: true })) return;
  try {
    const sb = await CharacterStore._sb();
    // ON DELETE CASCADE handles editions, characters, claims, quotes, links
    const { error } = await sb.from('works').delete().eq('id', workId);
    if (error) throw error;
    toast('Work deleted');
    charLabWorkId = null;
    renderCharacterLab();
  } catch (e) {
    toast('Delete failed: ' + (e.message || 'unknown error'));
  }
}

/* v377: Phase 1 — Relationship Inbox.
   Review pipeline-suggested relationships: Accept / Change / Reject.
   Works against current JSON model; Phase 2 moves to edge table. */
async function charLabRenderInbox(body, works) {
  // v395: Drive inbox from DB review_status, not localStorage (Claude bug 3)
  // Pipeline JSON items are matched to edge rows; reviewed = edge exists in any status

  if (!charLabWorkId || !works.some(w => w.workId === charLabWorkId)) {
    charLabWorkId = works[0].workId;
  }
  const work = works.find(w => w.workId === charLabWorkId);
  const chars = await CharacterStore.listForWork(charLabWorkId);

  // Get all edge rows for this work's characters (any status)
  let existingEdges = [];
  try {
    const sb = await CharacterStore._sb();
    const charIds = chars.map(c => c.id);
    if (charIds.length) {
      const { data } = await sb.from('character_relationships')
        .select('id, character_a_id, character_b_id, relationship_type, review_status')
        .in('character_a_id', charIds);
      existingEdges = data || [];
    }
  } catch (e) { console.warn('Edge fetch failed', e); }

  // Helper: find edge for a from/to pair (v395: type-agnostic to avoid duplicates — Advisor)
  const findEdge = (fromId, toName) => {
    const toChar = findCharByName(chars, toName);
    if (!toChar) return null;
    return existingEdges.find(e =>
      e.character_a_id === fromId &&
      e.character_b_id === toChar.id
    );
  };

  // v381: Collect pipeline JSON relationships AND user-suggested edges
  const inbox = [];
  chars.forEach(c => {
    (c.relationships || []).forEach((r, idx) => {
      const relId = c.id + ':' + idx;
      const type = String(r.type || 'friend').toLowerCase();
      const toName = String(r.to || '').trim();
      // Skip if an edge row exists (already reviewed in any status)
      if (findEdge(c.id, toName)) return;
      inbox.push({
        id: relId,
        fromId: c.id,
        fromName: c.name,
        toName: toName,
        type: type,
        importance: r.importance || null,
        source: 'pipeline',
      });
    });
  });

  // Add user-suggested edges (pending, created_by != null)
  try {
    const sb = await CharacterStore._sb();
    const charIds = chars.map(c => c.id);
    if (charIds.length) {
      const { data: suggested } = await sb.from('character_relationships')
        .select('id, character_a_id, character_b_id, relationship_type, importance, tags, created_by')
        .in('character_a_id', charIds)
        .eq('review_status', 'pending')
        .not('created_by', 'is', null);
      (suggested || []).forEach(edge => {
        const fromChar = chars.find(c => c.id === edge.character_a_id);
        const toChar = chars.find(c => c.id === edge.character_b_id);
        if (fromChar && toChar) {
          inbox.push({
            id: 'edge:' + edge.id,
            edgeId: edge.id,
            fromId: edge.character_a_id,
            fromName: fromChar.name,
            toName: toChar.name,
            type: edge.relationship_type,
            importance: edge.importance,
            tags: edge.tags || [],
            source: 'user',
          });
        }
      });
    }
  } catch (e) { console.warn('User suggestions fetch failed', e); }

  // Filter out empty targets
  const valid = inbox.filter(r => r.toName);

  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab — Review</h3>' +
    '<p class="note">Keyboard: ↑/↓ navigate · A accept · R reject · 1-5 importance · T cycle type</p>' +
    '<p class="note">' +
    '<button class="btn sm ghost" data-chview="characters">Characters</button> ' +
    '<button class="btn sm ghost" data-chview="relationships">Relationships</button> ' +
    '<button class="btn sm" data-chview="review">Review</button></p>' +
    '<p class="note"><label>Work: <select id="ch-work" class="text-input" style="width:auto;display:inline-block;max-width:280px">' +
    works.map(w => '<option value="' + esc(w.workId) + '"' +
      (w.workId === charLabWorkId ? ' selected' : '') + '>' +
      esc(w.title) + ' (' + w.count + ')</option>').join('') +
    '</select></label> ' +
    '<button class="btn sm ghost" id="ch-refresh">↻</button> ' +
    '<button class="btn sm ghost" id="ch-delete-work" style="color:var(--danger,red)">Delete work</button></p>' +
    '<p class="note">' + valid.length + ' relationships awaiting review in <b>' + esc(work ? work.title : '') + '</b>.</p>';

  // v386: Inbox as data grid
  if (!valid.length) {
    html += '<p class="note">All caught up! No unreviewed relationships.</p>';
  } else {
    html += '<div class="ch-grid-wrap" style="overflow-x:auto"><table class="ch-grid">' +
      '<thead><tr><th>From</th><th>Type</th><th>To</th><th>Importance</th><th>Source</th><th>Actions</th></tr></thead><tbody>';
    valid.forEach(r => {
      html += '<tr data-rel="' + esc(r.id) + '">' +
        '<td><b>' + esc(r.fromName) + '</b></td>' +
        '<td><select class="ch-grid-input" data-rel-type="' + esc(r.id) + '" style="min-width:100px">' +
        ['spouse','partner','parent','child','sibling','friend','enemy','rival','mentor','colleague'].map(t =>
          '<option value="' + t + '"' + (r.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
        '</select></td>' +
        '<td><b>' + esc(r.toName) + '</b></td>' +
        '<td><select class="ch-grid-input" data-rel-imp="' + esc(r.id) + '" style="min-width:60px">' +
        '<option value="">-</option>' +
        [1,2,3,4,5].map(i => '<option value="' + i + '"' + (r.importance == i ? ' selected' : '') + '>' + i + '</option>').join('') +
        '</select></td>' +
        '<td>' + (r.source === 'user' ?
          '<span title="Reader suggestion">🟡</span> <span class="chip">reader</span>' :
          '<span title="Pipeline suggestion">🔵</span> <span class="note">pipeline</span>') +
        (r.tags && r.tags.length ? '<br>' + r.tags.map(t => '<span class="chip sm">' + esc(t) + '</span>').join(' ') : '') + '</td>' +
        '<td style="white-space:nowrap">' +
        '<button class="btn sm" data-rel-accept="' + esc(r.id) + '">✓</button> ' +
        '<button class="btn sm ghost" data-rel-reject="' + esc(r.id) + '">✕</button>' +
        '</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  body.innerHTML = html;

  // Wire view toggle (v389: was renderAdminBody which lands on Analytics — Claude caught it)
  body.querySelectorAll('[data-chview]').forEach(b => b.addEventListener('click', () => {
    charLabView = b.getAttribute('data-chview');
    renderCharacterLab();
  }));
  document.getElementById('ch-work').addEventListener('change', e => {
    charLabWorkId = e.target.value;
    charLabRenderInbox(body, works);
  });
  document.getElementById('ch-refresh').addEventListener('click', () => charLabRenderInbox(body, works));
  document.getElementById('ch-delete-work').addEventListener('click', () => {
    deleteWork(charLabWorkId, work ? work.title : charLabWorkId);
  });

  // Wire accept/reject (v395: DB-driven, no localStorage)
  // v387: Inbox dropdowns save on change (Advisor MEDIUM — were decorative)
  body.querySelectorAll('[data-rel-type]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const relId = sel.getAttribute('data-rel-type');
      const newType = sel.value;
      // Store pending change — applied on Accept
      sel.closest('tr').dataset.pendingType = newType;
      sel.style.borderColor = 'var(--gold)';
    });
  });
  body.querySelectorAll('[data-rel-imp]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const relId = sel.getAttribute('data-rel-imp');
      const newImp = sel.value;
      sel.closest('tr').dataset.pendingImp = newImp;
      sel.style.borderColor = 'var(--gold)';
    });
  });

  body.querySelectorAll('[data-rel-accept]').forEach(b => b.addEventListener('click', async () => {
    const relId = b.getAttribute('data-rel-accept');
    const item = b.closest('tr[data-rel]');
    // v381: handle both edge IDs (user suggestions) and JSON relIds (pipeline)
    // v387: apply pending type/imp changes from dropdowns
    const row = item;
    const pendingType = row.dataset.pendingType;
    const pendingImp = row.dataset.pendingImp;
    try {
      if (relId.startsWith('edge:')) {
        // User suggestion — flip to confirmed (with pending changes)
        const edgeId = relId.slice(5);
        const updates = { review_status: 'confirmed' };
        if (pendingType) updates.relationship_type = pendingType;
        if (pendingImp) updates.importance = parseInt(pendingImp, 10) || null;
        await CharacterStore.updateRelationship(edgeId, updates);
      } else {
        // Pipeline JSON — upsert as before (v380)
        // v388: apply pending dropdown changes (Advisor — were silently discarded)
        const [fromId, idx] = relId.split(':');
        const chars = await CharacterStore.listForWork(charLabWorkId);
        const fromChar = chars.find(c => c.id === fromId);
        if (fromChar && fromChar.relationships && fromChar.relationships[idx]) {
          const r = fromChar.relationships[idx];
          const toName = String(r.to || '').trim();
          const origType = String(r.type || 'friend').toLowerCase();
          const newType = pendingType || origType;
          const newImp = pendingImp ? parseInt(pendingImp, 10) || null : (r.importance || null);
          const toChar = findCharByName(chars, toName);
          if (toChar) {
            const sb = await CharacterStore._sb();
            // Look up by ORIGINAL type (backfilled row) — not newType
            const { data: existing } = await sb.from('character_relationships')
              .select('id')
              .eq('character_a_id', fromId)
              .eq('character_b_id', toChar.id)
              .eq('relationship_type', origType)
              .eq('review_status', 'pending')
              .maybeSingle();
            if (existing) {
              await CharacterStore.updateRelationship(existing.id, {
                review_status: 'confirmed',
                relationship_type: newType,
                importance: newImp,
              });
            } else {
              await CharacterStore.createRelationship(fromId, toChar.id, newType, {
                direction: 'mutual',
                importance: newImp,
                workId: charLabWorkId,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Edge upsert failed', e);
      toast('Accept failed: ' + (e.message || 'unknown error'));
      return; // v389: don't mark reviewed on failure (Claude)
    }
    // v395: re-render to reflect DB state
    charLabRenderInbox(body, works);
    item.querySelectorAll('button').forEach(x => x.disabled = true);
    toast('Relationship accepted');
  }));

  body.querySelectorAll('[data-rel-reject]').forEach(b => b.addEventListener('click', async () => {
    const relId = b.getAttribute('data-rel-reject');
    try {
      if (relId.startsWith('edge:')) {
        const edgeId = relId.slice(5);
        await CharacterStore.updateRelationship(edgeId, { review_status: 'rejected' });
      } else {
        // v395: Pipeline JSON — create rejected edge so it's tracked in DB (Claude bug 3)
        const [fromId, idx] = relId.split(':');
        const chars = await CharacterStore.listForWork(charLabWorkId);
        const fromChar = chars.find(c => c.id === fromId);
        if (fromChar && fromChar.relationships && fromChar.relationships[idx]) {
          const r = fromChar.relationships[idx];
          const toName = String(r.to || '').trim();
          const toChar = findCharByName(chars, toName);
          if (toChar) {
            await CharacterStore.createRelationship(fromId, toChar.id, String(r.type || 'friend').toLowerCase(), {
              direction: 'mutual',
              importance: r.importance || null,
              workId: charLabWorkId,
              review_status: 'rejected',
            });
          }
        }
      }
    } catch (e) {
      console.warn('Reject failed', e);
      toast('Reject failed: ' + (e.message || 'unknown error'));
      return;
    }
    // v395: re-render to reflect DB state
    charLabRenderInbox(body, works);
    toast('Relationship rejected');
  }));

  // v386: Change is now inline via dropdowns (no dialog needed)

  // v395: Keyboard-driven inbox (Claude — biggest time saver)
  // ↑/↓ navigate, A accept, R reject, 1-5 importance, T cycle type
  let kbIndex = 0;
  const rows = () => [...body.querySelectorAll('tr[data-rel]')];
  const highlightRow = (idx) => {
    rows().forEach((r, i) => r.classList.toggle('kb-sel', i === idx));
    const row = rows()[idx];
    if (row) row.scrollIntoView({ block: 'nearest' });
  };
  const kbHandler = (e) => {
    // Only when inbox is visible and not typing in an input
    if (!body.contains(document.activeElement) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const rs = rows();
    if (!rs.length) return;
    const row = rs[kbIndex];
    if (!row) return;

    if (e.key === 'ArrowDown') { kbIndex = Math.min(kbIndex + 1, rs.length - 1); highlightRow(kbIndex); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { kbIndex = Math.max(kbIndex - 1, 0); highlightRow(kbIndex); e.preventDefault(); }
    else if (e.key === 'a' || e.key === 'A') { row.querySelector('[data-rel-accept]')?.click(); }
    else if (e.key === 'r' || e.key === 'R') { row.querySelector('[data-rel-reject]')?.click(); }
    else if (e.key >= '1' && e.key <= '5') {
      const sel = row.querySelector('[data-rel-imp]');
      if (sel) { sel.value = e.key; sel.dispatchEvent(new Event('change')); }
    }
    else if (e.key === 't' || e.key === 'T') {
      const sel = row.querySelector('[data-rel-type]');
      if (sel) {
        const opts = [...sel.options];
        const next = (sel.selectedIndex + 1) % opts.length;
        sel.selectedIndex = next;
        sel.dispatchEvent(new Event('change'));
      }
    }
  };
  // v395: Remove old handler before adding (Advisor HIGH — was leaking)
  if (body._kbHandler) document.removeEventListener('keydown', body._kbHandler);
  document.addEventListener('keydown', kbHandler);
  body._kbHandler = kbHandler;
  highlightRow(0);

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

  // v577: merged characters (hidden from the grid) surface here for unmerge
  const mergedChars = chars.filter(c => c.status === 'merged');

  // Duplicate detection
  const dupes = charFindDuplicates(visible);
  const dupeIds = new Set();
  dupes.forEach(([a, b]) => { dupeIds.add(a.id); dupeIds.add(b.id); });

  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3>' +
    '<p class="note">' +
    '<button class="btn sm" data-chview="characters">Characters</button> ' +

    '<button class="btn sm ghost" data-chview="relationships">Relationships</button> ' +
    '<button class="btn sm ghost" data-chview="review">Review</button></p>' +
    '<p class="note"><label>Work: <select id="ch-work" class="text-input" style="width:auto;display:inline-block;max-width:280px">' +
    works.map(w => '<option value="' + esc(w.workId) + '"' +
      (w.workId === charLabWorkId ? ' selected' : '') + '>' +
      esc(w.title) + ' (' + w.count + ')</option>').join('') +
    '</select></label> ' +
    '<button class="btn sm ghost" id="ch-refresh">↻</button> ' +
    '<button class="btn sm ghost" id="ch-delete-work2" style="color:var(--danger,red)">Delete work</button>' +
    (blockedCount ? ' <button class="btn sm ghost" id="ch-blocked-toggle">' +
      (charLabShowBlocked ? 'Hide' : 'Show') + ' ' + blockedCount + ' hidden</button>' : '') +
    (mergedCount ? ' <span class="note">' + mergedCount + ' merged</span>' : '') +
    '</p>' +
    (dupes.length ? '<div class="ob-card" style="border-color:var(--warn,orange)">' +
      '<h4 class="serif">' + icon('warn') + ' Possible duplicates (' + dupes.length + ')</h4>' +
      dupes.map(([a, b, kind], i) =>
        '<p><b>' + esc(a.name) + '</b> ↔ <b>' + esc(b.name) + '</b> ' +
        '<span class="note">(' + esc(kind) + ' match)</span><br>' +
        '<button class="btn sm" data-chmerge="' + i + '" data-keep="' + esc(a.id) + '">Keep ' +
        esc(a.name) + '</button> ' +
        '<button class="btn sm ghost" data-chmerge="' + i + '" data-keep="' + esc(b.id) + '">Keep ' +
        esc(b.name) + '</button></p>').join('') +
      '<p class="note" id="ch-merge-msg"></p></div>' : '') +
    (mergedChars.length ? '<div class="ob-card">' +
      '<h4 class="serif">' + icon('friends') + ' Merged characters</h4>' +
      // v578 (spec §1): the count line counts RESTORABLE merges only —
      // the UI never implies a restorable total it can't deliver.
      '<p class="note">' + mergedChars.filter(c => c.mergeSnapshot).length + ' can be restored</p>' +
      mergedChars.map(c => {
        const w = chars.find(x => x.id === c.duplicateOf);
        return '<p><b>' + esc(c.name) + '</b> <span class="note">merged into <b>' +
          esc(w ? w.name : 'a character no longer in this work') + '</b></span><br>' +
          (c.mergeSnapshot
            ? '<span class="note">' + esc(charMergeHistoryLine(c)) + '</span><br>' +
              '<button class="btn sm" data-chrestore="' + esc(c.id) + '">Review restore…</button>'
            : '<span class="note">No snapshot — can\'t be restored</span>') +
          '</p>';
      }).join('') + '</div>' : '') +
    '<p class="note">' +
    '<button class="btn sm' + (!rf ? '' : ' ghost') + '" data-chrole="">All (' + chars.length + ')</button> ' +
    CHAR_ROLES.map(r =>
      '<button class="btn sm' + (rf === r ? '' : ' ghost') + '" data-chrole="' + r + '">' +
      CHAR_ROLE_LABELS[r] + ' (' + roleCounts[r] + ')</button>').join(' ') +
    '</p>';

  // v385: Desktop data grid (rows/columns, inline editing)
  if (!filtered.length) {
    html += '<p class="note">No characters with this role.</p>';
  } else {
    html += '<div class="ch-grid-wrap" style="overflow-x:auto"><table class="ch-grid">' +
      '<thead><tr>' +
      '<th><input type="checkbox" id="ch-select-all"></th>' +
      '<th>Name</th><th>Role</th><th>Status</th><th>Rels</th><th>Actions</th>' +
      '</tr></thead><tbody>';
    filtered.forEach(c => {
      const relCount = (c.relationships || []).length;
      html += '<tr data-chid="' + esc(c.id) + '"' + (c.id === charLabSelectedId ? ' class="sel"' : '') + '>' +
        '<td><input type="checkbox" class="ch-select" value="' + esc(c.id) + '"></td>' +
        '<td><input type="text" class="ch-grid-input" data-field="name" data-id="' + esc(c.id) + '" value="' + esc(c.name || '') + '"></td>' +
        '<td><select class="ch-grid-input" data-field="role" data-id="' + esc(c.id) + '">' +
        CHAR_ROLES.map(r => '<option value="' + r + '"' + (c.role === r ? ' selected' : '') + '>' + CHAR_ROLE_LABELS[r] + '</option>').join('') +
        '</select></td>' +
        '<td><select class="ch-grid-input" data-field="vitality" data-id="' + esc(c.id) + '">' +
        ['alive', 'dead', 'unknown', 'missing'].map(st => '<option value="' + st + '"' + (c.vitality === st ? ' selected' : '') + '>' + st + '</option>').join('') +
        '</select></td>' +
        '<td>' + relCount + '</td>' +
        '<td><button class="btn sm ghost" data-chdetail="' + esc(c.id) + '">Detail</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
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
  // v397: Delete work from grid view (uses shared deleteWork)
  const delBtn2 = document.getElementById('ch-delete-work2');
  if (delBtn2) delBtn2.addEventListener('click', () => {
    deleteWork(charLabWorkId, work ? work.title : charLabWorkId);
  });
  const blockedToggle = document.getElementById('ch-blocked-toggle');
  if (blockedToggle) blockedToggle.addEventListener('click', () => {
    charLabShowBlocked = !charLabShowBlocked;
    charLabRender(body, works, chars);
  });
  // v385: Grid inline editing
  body.querySelectorAll('.ch-grid-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const id = inp.getAttribute('data-id');
      const field = inp.getAttribute('data-field');
      // v387: whitelist fields (Advisor MEDIUM — prevent mass assignment)
      if (!['name', 'role', 'vitality'].includes(field)) return;
      const val = inp.value;
      try {
        const sb = await CharacterStore._sb();
        const updates = {};
        updates[field] = val;
        const { error } = await sb.from('book_characters').update(updates).eq('id', id);
        if (error) throw error;
        // v391: update local chars array so filters see the change (Claude bug 4)
        const local = chars.find(c => c.id === id);
        if (local) local[field] = val;
        inp.style.borderColor = 'var(--gold)';
        setTimeout(() => inp.style.borderColor = '', 800);
      } catch (e) {
        toast('Save failed: ' + e.message);
        inp.style.borderColor = 'red';
      }
    });
  });

  // v385: Grid detail buttons
  body.querySelectorAll('[data-chdetail]').forEach(b => b.addEventListener('click', () => {
    charLabSelectedId = b.getAttribute('data-chdetail');
    charLabRender(body, works, chars);
    // Scroll to detail
    const detail = document.getElementById('ch-detail');
    if (detail) detail.scrollIntoView({ behavior: 'smooth' });
  }));

  // v385: Select all
  const selAll = document.getElementById('ch-select-all');
  if (selAll) selAll.addEventListener('change', () => {
    body.querySelectorAll('.ch-select').forEach(cb => cb.checked = selAll.checked);
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

  // v578: restore always starts from the preview sheet (spec §1/§2) —
  // nothing restores from the list itself. Legacy merges have no button;
  // charUnmerge refuses them again server-side regardless.
  body.querySelectorAll('[data-chrestore]').forEach(b => b.addEventListener('click', () => {
    openCharRestoreSheet(b.getAttribute('data-chrestore'), { body, works, chars });
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

  // v578 (spec §4): merge history — one line per snapshot-backed merge
  // into this character. A restored merge's line leaves with it: the
  // loser is no longer status='merged' and its snapshot is cleared.
  const mergesIn = chars.filter(x =>
    x.status === 'merged' && x.duplicateOf === c.id && x.mergeSnapshot);
  if (mergesIn.length) {
    html += '<h4 class="serif">Merge history</h4>' + mergesIn.map(l =>
      '<p class="note">' + esc(charMergeHistoryLine(l)) + '</p>').join('');
  }

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
   v577: the repoints are lossy (nothing recorded which relationships the
   merge rewrote), so the merge first computes every write, then stores
   ONE snapshot on the loser row (merge_snapshot) BEFORE any repoint
   lands — pre-merge relationship arrays for the winner and for every
   other character the merge rewrites, plus the loser's pre-merge
   status. The snapshot write is fail-closed: if it errors, the merge
   aborts untouched, so this code can never mint a fresh irreversible
   merge. charUnmerge restores from the snapshot only.
   Never throws — returns error string on failure. */
async function charMerge(winnerId, loserId, chars) {
  try {
    const sb = await CharacterStore._sb();
    if (!sb) return 'cloud unavailable';
    const winner = chars.find(c => c.id === winnerId);
    const loser = chars.find(c => c.id === loserId);
    if (!winner || !loser) return 'character not found';
    const loserName = String(loser.name).trim().toLowerCase();
    const deepCopy = (v) => JSON.parse(JSON.stringify(Array.isArray(v) ? v : []));
    // Compute every write first (pure): the repointed relationship array
    // for each character the merge changes, remembering the pre-merge
    // array of every non-winner it touches.
    const updates = [];
    const repoints = [];
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
        updates.push({ id: c.id, rels });
        if (c.id !== winnerId) repoints.push({ id: c.id, rels: deepCopy(c.relationships) });
      }
    }
    // Record the snapshot on the loser row before any repoint lands.
    let by = null;
    try {
      const { data: { user } } = await sb.auth.getUser();
      by = user ? user.id : null;
    } catch (e) { /* provenance is best-effort, as in character_links */ }
    const snap = {
      v: 1, at: new Date().toISOString(), by,
      winnerId, loserId,
      loserStatus: loser.status || 'candidate',
      winnerRels: deepCopy(winner.relationships),
      repoints,
    };
    const { error: sErr } = await sb.from('book_characters')
      .update({ merge_snapshot: snap }).eq('id', loserId);
    if (sErr) return 'snapshot failed: ' + sErr.message;
    // Apply the repoints (same order and failure behaviour as pre-v577).
    for (const u of updates) {
      const { error } = await sb.from('book_characters')
        .update({ relationships: u.rels }).eq('id', u.id);
      if (error) return 'repoint failed: ' + error.message;
    }
    // Soft-merge: mark loser, point at winner (reversible)
    const { error: mErr } = await sb.from('book_characters')
      .update({ status: 'merged', duplicate_of: winnerId }).eq('id', loserId);
    if (mErr) return 'merge failed: ' + mErr.message;
    loser.status = 'merged';
    loser.duplicateOf = winnerId;
    loser.mergeSnapshot = snap;
    return null;
  } catch (e) { return (e && e.message) || 'unknown error'; }
}

/* Unmerge: restore a soft-merged character.
   v577: restores ONLY from the merge_snapshot charMerge recorded on the
   loser row — the winner's and every repointed character's relationship
   arrays come back verbatim (original entries, direction and evidence
   keys included), and the loser returns to its exact pre-merge status
   (a confirmed character is restored confirmed, a rejected one stays
   rejected — unmerge never launders or resurrects a review state).
   Legacy merges (pre-v577) recorded no snapshot and REFUSE: nothing is
   reconstructed by inference. The loser row is written LAST and the
   snapshot is cleared only in that final write, so a failed unmerge
   leaves the loser still merged with its snapshot intact — every
   restore write is a verbatim snapshot value, so retrying is safe and
   a second unmerge after success refuses as "not merged" instead of
   duplicating anything. Never throws — returns error string on
   failure, null on success. */
async function charUnmerge(loserId, chars) {
  try {
    const sb = await CharacterStore._sb();
    if (!sb) return 'cloud unavailable';
    const loser = chars.find(c => c.id === loserId);
    if (!loser) return 'character not found';
    // Decide on the server's record, not the possibly stale in-memory copy.
    const { data: row, error: fErr } = await sb.from('book_characters')
      .select('id, status, duplicate_of, merge_snapshot').eq('id', loserId).maybeSingle();
    if (fErr) return 'unmerge failed: ' + fErr.message;
    if (!row) return 'character not found';
    if (row.status !== 'merged') return 'not merged — nothing to restore';
    const snap = row.merge_snapshot;
    if (!snap || !Array.isArray(snap.winnerRels) || !Array.isArray(snap.repoints)) {
      return 'no merge snapshot — cannot restore (this merge predates reversible merges)';
    }
    if (snap.winnerId !== row.duplicate_of || snap.loserId !== loserId) {
      return 'merge snapshot mismatch — cannot restore';
    }
    const winner = chars.find(c => c.id === snap.winnerId);
    if (!winner) return 'winner no longer in this work — cannot restore';
    const deepCopy = (v) => JSON.parse(JSON.stringify(v));
    for (const rp of snap.repoints) {
      const { error } = await sb.from('book_characters')
        .update({ relationships: deepCopy(rp.rels) }).eq('id', rp.id);
      if (error) return 'unmerge failed: ' + error.message;
    }
    const { error: wErr } = await sb.from('book_characters')
      .update({ relationships: deepCopy(snap.winnerRels) }).eq('id', snap.winnerId);
    if (wErr) return 'unmerge failed: ' + wErr.message;
    const { error: lErr } = await sb.from('book_characters')
      .update({ status: snap.loserStatus || 'candidate', duplicate_of: null, merge_snapshot: null })
      .eq('id', loserId);
    if (lErr) return 'unmerge failed: ' + lErr.message;
    loser.status = snap.loserStatus || 'candidate';
    loser.duplicateOf = null;
    loser.mergeSnapshot = null;
    return null;
  } catch (e) { return (e && e.message) || 'unknown error'; }
}

/* ================= v578: Unmerge companions — preview + history =====
   Presentation over the v577 restore core above; charUnmerge's
   semantics are untouched. Design record:
   docs/../prototypes character-unmerge-ui-spec (Designer, 2026-10-15) —
   the card counts restorable merges only, restore always starts from
   the preview sheet, results report in counts, and the winner's
   curation view carries the merge-history lines. The derivations are
   pure functions over the in-memory Lab list + the snapshot, so the
   counts the sheet shows are the counts the restore will perform.
   One copy deviation from the spec, forced by the shipped semantics:
   charUnmerge restores the rewritten relationship lists VERBATIM, so
   entries added to those lists after the merge are rewound, not kept —
   section C therefore enumerates the winner's own snapshot
   relationships as the stays and discloses the rewind, rather than
   claiming post-merge additions to those lists survive. */

function charUnmergeNameEq(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
function charUnmergeRelKey(r) {
  return String((r && r.to) || '').trim().toLowerCase() + '|' + charNormRelType(r && r.type);
}

/* The fold set, built exactly as charMerge builds its `seen`: the
   winner's pre-merge relationships with loser-pointing entries
   REPOINTED to the winner's name first, then keyed. charMerge folds a
   loser entry into the winner only when the entry's key is absent from
   this set — so in a mutual same-type pair (winner and loser pointing
   at each other with the same type) the loser's entry keys IN via the
   repoint, never folds, and stays on the loser's own array, which
   merge and unmerge both leave untouched. */
function charUnmergePostRepointKeys(winnerRels, winnerName, loserName) {
  return new Set((Array.isArray(winnerRels) ? winnerRels : []).map(r =>
    charUnmergeRelKey(charUnmergeNameEq(r.to, loserName)
      ? { to: winnerName, type: r.type } : r)));
}

/* The preview model for restoring `loser` from `winner`: who comes
   back, every move named with its landing place, what stays, and what
   a verbatim restore rewinds. */
function charUnmergePreview(loser, winner, chars) {
  const snap = (loser && loser.mergeSnapshot) || {};
  const loserName = loser ? loser.name : '';
  const winnerName = winner ? winner.name : '';
  const winnerRels = Array.isArray(snap.winnerRels) ? snap.winnerRels : [];
  const repoints = Array.isArray(snap.repoints) ? snap.repoints : [];
  const loserRels = (loser && Array.isArray(loser.relationships)) ? loser.relationships : [];
  const winnerNow = (winner && Array.isArray(winner.relationships)) ? winner.relationships : [];
  const winnerKeys = new Set(winnerRels.map(charUnmergeRelKey));
  const loserKeys = new Set(loserRels.map(charUnmergeRelKey));
  const postRepointKeys = charUnmergePostRepointKeys(winnerRels, winnerName, loserName);

  // Links back: third-party pointers the merge repointed at the winner.
  const linksBack = [];
  repoints.forEach(rp => {
    const owner = (chars || []).find(c => c.id === rp.id);
    (Array.isArray(rp.rels) ? rp.rels : []).forEach(r => {
      if (charUnmergeNameEq(r.to, loserName)) {
        linksBack.push({ name: owner ? owner.name : '(a character)', type: charNormRelType(r.type) });
      }
    });
  });
  // Relationships back, winner side: the winner's own pointers at the
  // loser, plus the loser entries the merge folded into the winner.
  const relsBack = [];
  winnerRels.forEach(r => {
    if (charUnmergeNameEq(r.to, loserName)) {
      relsBack.push({ name: winnerName, type: charNormRelType(r.type) });
    }
  });
  // Folded-in loser entries — tested against the POST-REPOINT set
  // (charMerge's `seen`), not the raw snapshot keys: against the raw
  // keys a mutual same-type entry would be listed as moving back when
  // it never folded and never moves.
  loserRels.forEach(r => {
    if (!postRepointKeys.has(charUnmergeRelKey(r))) {
      relsBack.push({ name: String(r.to || ''), type: charNormRelType(r.type) });
    }
  });
  // Stays: the winner's own pre-merge relationships that never involved
  // the loser — the winner's throughout, before and after the restore.
  const staysList = [];
  winnerRels.forEach(r => {
    if (!charUnmergeNameEq(r.to, loserName)) {
      staysList.push({ name: String(r.to || ''), type: charNormRelType(r.type) });
    }
  });
  // Rewound: entries on the winner NOW that the snapshot does not know
  // (added after the merge). Verbatim restore takes them off again.
  const rewound = [];
  winnerNow.forEach(e => {
    const k = charUnmergeRelKey(e);
    if (winnerKeys.has(k) || loserKeys.has(k)) return;
    const isRepointedOwn = winnerRels.some(w =>
      charNormRelType(w.type) === charNormRelType(e.type) &&
      charUnmergeNameEq(w.to, loserName) && charUnmergeNameEq(e.to, winnerName));
    if (!isRepointedOwn) rewound.push({ name: String(e.to || ''), type: charNormRelType(e.type) });
  });
  return {
    loserId: loser ? loser.id : null, loserName,
    winnerId: winner ? winner.id : null, winnerName,
    returnsAs: snap.loserStatus || 'candidate',
    linksBack, relsBack,
    movesBack: linksBack.concat(relsBack),
    staysList, rewound,
    counts: { links: linksBack.length, relationships: relsBack.length, stays: staysList.length },
    // internals for charUnmergeOutcome's post-hoc count
    winnerRels, repoints, loserRels,
  };
}

/* Long-list window for the preview sections: first 8, then "+N more"
   expanding in place (spec §2). */
function charUnmergeListWindow(items, expanded) {
  const list = Array.isArray(items) ? items : [];
  if (expanded || list.length <= 8) return { shown: list.slice(), moreCount: 0 };
  return { shown: list.slice(0, 8), moreCount: list.length - 8 };
}

/* Post-hoc movement count against a freshly read Lab list — how the
   partial-failure result reports what actually landed. An entry counts
   as back when the state charUnmerge writes verbatim is present: a
   third-party pointer naming the loser again, a winner pointer back in
   the snapshot array, a folded-in copy gone from the winner. */
function charUnmergeOutcome(preview, charsAfter) {
  const chars = Array.isArray(charsAfter) ? charsAfter : [];
  const byId = id => chars.find(c => c.id === id);
  let linksMoved = 0;
  (preview.repoints || []).forEach(rp => {
    const now = byId(rp.id);
    if (!now || !Array.isArray(now.relationships)) return;
    const avail = now.relationships.filter(r => charUnmergeNameEq(r.to, preview.loserName));
    (Array.isArray(rp.rels) ? rp.rels : []).forEach(r => {
      if (!charUnmergeNameEq(r.to, preview.loserName)) return;
      const i = avail.findIndex(x => charNormRelType(x.type) === charNormRelType(r.type));
      if (i >= 0) { linksMoved++; avail.splice(i, 1); }
    });
  });
  let relsMoved = 0;
  const w = byId(preview.winnerId);
  if (w && Array.isArray(w.relationships)) {
    const wKeys = new Set(w.relationships.map(charUnmergeRelKey));
    const postRepointKeys = charUnmergePostRepointKeys(
      preview.winnerRels, preview.winnerName, preview.loserName);
    (preview.winnerRels || []).forEach(r => {
      if (charUnmergeNameEq(r.to, preview.loserName) && wKeys.has(charUnmergeRelKey(r))) relsMoved++;
    });
    (preview.loserRels || []).forEach(r => {
      const k = charUnmergeRelKey(r);
      if (!postRepointKeys.has(k) && !wKeys.has(k)) relsMoved++;
    });
  }
  const loserAfter = byId(preview.loserId);
  return {
    linksMoved, relsMoved,
    finished: !!loserAfter && loserAfter.status !== 'merged',
  };
}

function charUnmergeCounted(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* The result-state text model (spec §3): counts, never a bare "Done";
   a partial failure gets its own heading and of-total counts. */
function charUnmergeResultModel(preview, outcome) {
  const p = preview;
  if (!outcome || outcome.finished) {
    const links = outcome ? outcome.linksMoved : p.counts.links;
    const rels = outcome ? outcome.relsMoved : p.counts.relationships;
    return {
      done: true,
      heading: p.loserName + ' is back.',
      countsLine: charUnmergeCounted(links, 'link', 'links') + ' moved back · ' +
        charUnmergeCounted(rels, 'relationship', 'relationships') + ' restored',
      staysLine: p.counts.stays
        ? charUnmergeCounted(p.counts.stays, 'item', 'items') + ' stayed with ' + p.winnerName
        : null,
      statusLine: p.loserName + ' returns as ' + p.returnsAs + '.',
    };
  }
  return {
    done: false,
    heading: "Restore didn't finish",
    countsLine: outcome.linksMoved + ' of ' + charUnmergeCounted(p.counts.links, 'link', 'links') +
      ' moved back · ' + outcome.relsMoved + ' of ' +
      charUnmergeCounted(p.counts.relationships, 'relationship', 'relationships') + ' restored',
    staysLine: null,
    statusLine: null,
  };
}

/* Spec §4: "Merged from {loser} · by {by} · {when}". The snapshot
   carries `at`; a snapshot without one reads "date not recorded" —
   never an invented date. Returns null for snapshot-less merges. */
function charMergeHistoryLine(loser) {
  const snap = loser && loser.mergeSnapshot;
  if (!snap) return null;
  const when = snap.at ? (fmtDate(snap.at) || 'date not recorded') : 'date not recorded';
  return 'Merged from ' + (loser.name || '') + ' · by ' + (snap.by || 'unknown') + ' · ' + when;
}

/* ---- the preview / result sheet ---- */
let chRestoreState = null; // { ctx, loserId, preview, expandedB, expandedC, phase, outcome, err, busy }
let chRestoreToken = null;

function openCharRestoreSheet(loserId, ctx) {
  const loser = ctx.chars.find(c => c.id === loserId);
  const winner = loser ? ctx.chars.find(c => c.id === loser.duplicateOf) : null;
  if (!loser || !loser.mergeSnapshot) return;
  if (!winner) { // same refusal charUnmerge would give — say it, don't swallow the click
    if (typeof toast === 'function') toast('Winner no longer in this work — cannot restore');
    return;
  }
  closeCharRestoreSheet();
  chRestoreState = {
    ctx, loserId,
    preview: charUnmergePreview(loser, winner, ctx.chars),
    expandedB: false, expandedC: false,
    phase: 'preview', outcome: null, err: null, busy: false,
  };
  const ov = document.createElement('div');
  ov.className = 'modal-backdrop';
  ov.id = 'ch-restore-back';
  ov.innerHTML =
    '<div class="modal" id="ch-restore-sheet" role="dialog" aria-modal="true" ' +
    'aria-label="Restore ' + esc(loser.name) + '">' +
    '<div class="sheet-grabber"></div><div id="ch-restore-body"></div></div>';
  document.body.appendChild(ov);
  if (typeof overlayOpened === 'function') {
    chRestoreToken = overlayOpened('char-restore', closeCharRestoreSheet);
  }
  // App rule: every sheet ships swipe-down-to-dismiss (js/055).
  if (typeof wireSheetDrag === 'function') {
    wireSheetDrag(ov.querySelector('#ch-restore-sheet'), closeCharRestoreSheet);
  }
  ov.addEventListener('click', e => { if (e.target === ov) closeCharRestoreSheet(); });
  ov.addEventListener('keydown', e => { if (e.key === 'Escape') closeCharRestoreSheet(); });
  chRestoreRender();
}

function closeCharRestoreSheet() {
  if (chRestoreToken != null) {
    const t = chRestoreToken; chRestoreToken = null;
    if (typeof overlayClosed === 'function') overlayClosed(t);
  }
  const ov = document.getElementById('ch-restore-back');
  if (ov) ov.remove();
  chRestoreState = null;
}

function chRestoreItemLines(items, lands, tail) {
  return items.map(it =>
    '<p>' + esc(it.name) + ' — ' + esc(it.type) + ' ' + tail + ' ' + esc(lands) + '</p>').join('');
}

function chRestorePreviewHtml(st) {
  const p = st.preview;
  const winB = charUnmergeListWindow(p.movesBack, st.expandedB);
  const winC = charUnmergeListWindow(p.staysList, st.expandedC);
  return '<h3 class="serif">Restore ' + esc(p.loserName) + '?</h3>' +
    '<h4 class="serif">Who comes back</h4>' +
    '<p><b>' + esc(p.loserName) + '</b> returns as its own character.<br>' +
    'Returns as: ' + esc(p.returnsAs) + '.</p>' +
    '<h4 class="serif">What moves back</h4>' +
    (winB.shown.length
      ? chRestoreItemLines(winB.shown, p.loserName, 'returns to')
      : '<p class="note">Nothing to move — the merge rewrote no relationships.</p>') +
    (winB.moreCount
      ? '<p><button class="taplink" data-chmore="b">+ ' + winB.moreCount + ' more</button></p>' : '') +
    '<h4 class="serif">Stays with ' + esc(p.winnerName) + '</h4>' +
    '<p class="note">Everything on ' + esc(p.winnerName) + ' that isn\'t listed above stays with ' +
    esc(p.winnerName) + '. Its relationship list returns to the merge snapshot, so changes made to ' +
    'the rewritten lists since the merge are rewound.</p>' +
    (winC.shown.length ? chRestoreItemLines(winC.shown, p.winnerName, 'stays with') : '') +
    (winC.moreCount
      ? '<p><button class="taplink" data-chmore="c">+ ' + winC.moreCount + ' more</button></p>' : '') +
    (p.rewound.length
      ? '<p class="note">Added to ' + esc(p.winnerName) + ' since the merge — these come off when ' +
        'the snapshot is restored:</p>' +
        p.rewound.map(it => '<p>' + esc(it.name) + ' — ' + esc(it.type) + '</p>').join('')
      : '') +
    (st.err ? '<p class="note" style="color:var(--danger,red)">' + esc(st.err) + '</p>' : '') +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="ch-restore-keep"' + (st.busy ? ' disabled' : '') + '>Keep merged</button>' +
    '<button class="btn" id="ch-restore-commit"' + (st.busy ? ' disabled' : '') + '>' +
    (st.busy ? 'Restoring…' : 'Restore ' + esc(p.loserName)) + '</button></div>';
}

function chRestoreResultHtml(st) {
  const p = st.preview;
  const m = charUnmergeResultModel(p, st.outcome);
  if (m.done) {
    return '<h3 class="serif">' + esc(m.heading) + '</h3>' +
      '<p>' + esc(m.countsLine) + '</p>' +
      (m.staysLine ? '<p>' + esc(m.staysLine) + '</p>' : '') +
      '<p>' + esc(m.statusLine) + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn ghost" id="ch-restore-done">Done</button>' +
      '<button class="btn" id="ch-restore-view">View ' + esc(p.loserName) + '</button></div>';
  }
  return '<h3 class="serif">' + esc(m.heading) + '</h3>' +
    (st.outcome
      ? '<p>' + esc(m.countsLine) + '</p>'
      : '<p class="note">Couldn\'t re-check what moved — reopen the Character Lab to see the current state.</p>') +
    (st.err ? '<p class="note" style="color:var(--danger,red)">' + esc(st.err) + '</p>' : '') +
    '<p class="note">Nothing is lost — the merge snapshot is still recorded, and restoring again is safe.</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="ch-restore-done">Close</button>' +
    '<button class="btn" id="ch-restore-retry">Try again</button></div>';
}

function chRestoreRender() {
  const st = chRestoreState;
  if (!st) return;
  const host = document.getElementById('ch-restore-body');
  if (!host) return;
  host.innerHTML = st.phase === 'preview' ? chRestorePreviewHtml(st) : chRestoreResultHtml(st);
  host.querySelectorAll('[data-chmore]').forEach(b => b.addEventListener('click', () => {
    if (b.getAttribute('data-chmore') === 'b') st.expandedB = true; else st.expandedC = true;
    chRestoreRender();
  }));
  const keep = document.getElementById('ch-restore-keep');
  if (keep) keep.addEventListener('click', closeCharRestoreSheet);
  const commit = document.getElementById('ch-restore-commit');
  if (commit) commit.addEventListener('click', chRestoreCommit);
  const done = document.getElementById('ch-restore-done');
  if (done) done.addEventListener('click', closeCharRestoreSheet);
  const view = document.getElementById('ch-restore-view');
  if (view) view.addEventListener('click', () => {
    const ctx = st.ctx, loserId = st.loserId;
    closeCharRestoreSheet();
    charLabSelectedId = loserId;
    charLabRender(ctx.body, ctx.works, ctx.chars);
    const detail = document.getElementById('ch-detail');
    if (detail && detail.scrollIntoView) detail.scrollIntoView({ behavior: 'smooth' });
  });
  const retry = document.getElementById('ch-restore-retry');
  if (retry) retry.addEventListener('click', () => {
    const loser = st.ctx.chars.find(c => c.id === st.loserId);
    const winner = loser ? st.ctx.chars.find(c => c.id === loser.duplicateOf) : null;
    if (!loser || !winner || !loser.mergeSnapshot) { closeCharRestoreSheet(); return; }
    st.preview = charUnmergePreview(loser, winner, st.ctx.chars);
    st.phase = 'preview'; st.outcome = null; st.err = null;
    st.expandedB = false; st.expandedC = false;
    chRestoreRender();
  });
}

async function chRestoreCommit() {
  const st = chRestoreState;
  if (!st || st.busy) return;
  st.busy = true;
  chRestoreRender();
  const err = await charUnmerge(st.loserId, st.ctx.chars);
  // Re-read the work so the Lab behind the sheet (card count, grid) and
  // the movement count reflect the server, not the pre-restore copy.
  let fresh = null;
  try { fresh = await CharacterStore.listForWork(charLabWorkId); } catch (e) { fresh = null; }
  if (fresh) st.ctx.chars = fresh;
  charLabRender(st.ctx.body, st.ctx.works, st.ctx.chars);
  st.phase = 'result';
  st.err = err;
  st.outcome = err ? (fresh ? charUnmergeOutcome(st.preview, fresh) : null) : null;
  st.busy = false;
  chRestoreRender();
}
