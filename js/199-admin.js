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
    search_performed: 'Search performed', author_discovery_opened: 'Author discovery',
    similar_books_opened: 'Similar books', release_discovery_opened: 'Release check',
    recommendation_opened: 'Recommendations viewed',
    roulette_opened: 'Roulette opened', roulette_spun: 'Roulette spun',
    roulette_book_opened: 'Roulette pick opened', roulette_book_started: 'Roulette pick started',
    import_started: 'Import started', import_completed: 'Import completed', import_failed: 'Import failed',
    rating_axis_used: 'Axis rating used',
    coven_opened: 'Coven opened', friend_request_sent: 'Friend request sent',
    friend_request_accepted: 'Friend request accepted', shared_shelf_viewed: 'Shared shelf viewed',
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
  setView('<div class="view-head"><h2 class="serif">' + icon('chart') + ' Libram Observatory</h2>' +
    '<p class="note">Admin only · usage counts, never book content</p></div>' +
    '<div class="ob-ranges">' + ranges.map(r =>
      '<button class="btn sm' + (adminRange === r[0] ? '' : ' ghost') + '" data-range="' + r[0] + '">' + r[1] + '</button>').join('') +
    (adminRange === 'custom'
      ? '<input type="date" id="ob-from" class="text-input sm" value="' + esc(adminCustomFrom) + '">' +
        '<input type="date" id="ob-to" class="text-input sm" value="' + esc(adminCustomTo) + '">' +
        '<button class="btn sm" id="ob-apply">Apply</button>'
      : '') + '</div>' +
    '<div id="ob-body"><p class="note">Loading analytics…</p></div>');
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
  renderAdminBody();
}

async function renderAdminBody() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  const key = adminRangeKey();
  try {
    if (!adminAggCache[key]) {
      const rows = await fetchAnalyticsRows();
      adminAggCache[key] = aggregateAnalytics(rows);
    }
    const a = adminAggCache[key];
    if (!a.totalEvents) {
      body.innerHTML = '<div class="empty"><div class="big">' + icon('chart') + '</div>' +
        '<h2 class="serif">No analytics yet</h2><p>Events appear here once signed-in users start using the app' +
        (adminRange === 'all' ? '.' : ' in this date range.') + '</p></div>';
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
    const userRows = a.userActivity.slice(0, 50).map(u =>
      '<tr><td><code>' + esc(u.uid.slice(0, 8)) + '</code></td><td>' + esc(fmtDate(u.lastActive)) +
      '</td><td class="num">' + u.events + '</td><td>' + esc(u.topCategory) + '</td></tr>').join('');
    body.innerHTML =
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
      '<div class="ob-card"><h3 class="serif">User activity</h3>' +
      '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>User</th><th>Last active</th>' +
      '<th class="num">Events</th><th>Top area</th></tr></thead>' +
      '<tbody>' + userRows + '</tbody></table></div>' +
      '<p class="note">Users are anonymized IDs — activity only, never library contents.</p></div>';
  } catch (e) {
    body.innerHTML = '<div class="empty"><div class="big">' + icon('warn') + '</div>' +
      '<h2 class="serif">Couldn\u2019t load analytics</h2><p>' +
      esc((e && e.message) || 'unknown error') + '</p>' +
      '<p class="note">If the analytics tables are missing, run supabase/analytics.sql in the Supabase SQL editor.</p></div>';
  }
}
