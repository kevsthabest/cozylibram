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
let adminTab = 'analytics'; // analytics | tropes (Trope Lab)

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
  else renderAdminBody();
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
      '<p class="note">Users shown as truncated account IDs — activity only, never library contents.</p></div>';
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
   (the pre-v157 baseline). */
function tropeLabCoverage(books, rows, current) {
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
    if (!e) missing.push(b);
    else if (e.version < current.version || e.rev < current.rev) stale.push(b);
    else tagged++;
  });
  return { total: (books || []).length, tagged, missing, stale };
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
    const b = tropeLabResolve(tropeLabKeyToId[k]);
    const ab = b ? null : tropeAdminBookById(k); // v159: all-libraries jobs
    return '<tr><td>' + esc(b ? b.title : (ab && ab.title) || k) + '</td><td class="note">' +
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
    '<div id="tropelab-progress"></div>';

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
    cov = tropeLabCoverage(books, rows);
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

  const wire = (id, books) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => {
      const n = TropeQueue.enqueue(books.map(b => b.id));
      if (n) TropeQueue.start();
      tropeLabProgressHTML();
    });
  };
  wire('tl-backfill', cov.missing);
  wire('tl-restale', cov.stale);
  tropeLabProgressHTML();
  tropeLabProviderHTML();
  tropeLabAllLibrariesHTML(configured);

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
    const cov = tropeLabCoverage(entries.map(e => e.book), rows);
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
    const startAll = keys => {
      /* Persist the projection BEFORE enqueueing — the queue resolves
         through it, including after a reload. */
      try { tropeAdminBooksSave(entries); } catch (e) {}
      const n = TropeQueue.enqueue(keys);
      if (n) TropeQueue.start();
      tropeLabProgressHTML();
    };
    const bb = document.getElementById('tl-alllibs-backfill');
    if (bb) bb.addEventListener('click', () => startAll(missingKeys));
    const rs = document.getElementById('tl-alllibs-restale');
    if (rs) rs.addEventListener('click', () => startAll(staleKeys));
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
