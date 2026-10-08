// Tests for v119 — Libram Observatory (js/199-admin.js).
//
// Covered: pure aggregation (empty, multi-user, funnels, import sources,
// user activity, 20k cap), admin gating (menu entry, unauthorized view,
// no fetch for non-admins), refreshAdminStatus resolution, date ranges.
//
// The spec's security model is server-enforced (RLS); these tests cover the
// client layers: non-admins must never be shown the menu entry, must never
// trigger a fetch, and must get the restricted view.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; failures.push(name); console.log('FAIL - ' + name); }
}

function jsFiles() {
  return fs.readdirSync(path.join(ROOT, 'js'))
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(ROOT, 'js', f));
}

// Load the full app through the shared harness (index.html + script tags,
// runScripts:dangerously — the same environment the real app boots in).
const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);

function ev(uid, name, cat, props, created) {
  return { user_id: uid, event_name: name, event_category: cat, properties: props || {}, app_version: 'v119', created_at: created };
}

(async () => {
  const run = (code) => window.eval(code);

  /* ---- 1. empty aggregation ---- */
  {
    const a = run(`aggregateAnalytics([])`);
    ok('empty: zero events', a.totalEvents === 0);
    ok('empty: zero users', a.uniqueUsers === 0);
    ok('empty: funnels are zeroed', a.funnels.roulette.every(s => s.users === 0));
    ok('empty: not capped', a.capped === false);
  }

  /* ---- 2. multi-user aggregation ---- */
  {
    const rows = [
      ev('u1', 'session_started', 'session', {}, '2026-09-20T10:00:00Z'),
      ev('u1', 'book_added', 'library', { source: 'search' }, '2026-09-20T10:05:00Z'),
      ev('u1', 'book_added', 'library', { source: 'isbn_list' }, '2026-09-20T10:06:00Z'),
      ev('u1', 'roulette_opened', 'discovery', {}, '2026-09-20T10:10:00Z'),
      ev('u1', 'roulette_spun', 'discovery', {}, '2026-09-20T10:11:00Z'),
      ev('u1', 'roulette_book_opened', 'discovery', {}, '2026-09-20T10:12:00Z'),
      ev('u1', 'roulette_book_started', 'discovery', {}, '2026-09-20T10:13:00Z'),
      ev('u1', 'provider_used', 'discovery', { provider: 'gbooks', context: 'search' }, '2026-09-20T10:14:00Z'),
      ev('u1', 'provider_used', 'discovery', { provider: 'gbooks', context: 'isbn' }, '2026-09-20T10:15:00Z'),
      ev('u1', 'provider_used', 'discovery', { provider: 'cache', context: 'isbn' }, '2026-09-20T10:16:00Z'),
      ev('u2', 'provider_used', 'discovery', { provider: 'gbooks', context: 'pagecount' }, '2026-09-21T09:30:00Z'),
      ev('u2', 'session_started', 'session', {}, '2026-09-21T09:00:00Z'),
      ev('u2', 'book_added', 'library', { source: 'search' }, '2026-09-21T09:05:00Z'),
      ev('u2', 'roulette_opened', 'discovery', {}, '2026-09-21T09:10:00Z'),
      ev('u2', 'import_started', 'import', { source: 'goodreads' }, '2026-09-21T09:20:00Z'),
      ev('u2', 'import_completed', 'import', { source: 'goodreads', book_count: 120 }, '2026-09-21T09:25:00Z'),
      ev('u3', 'session_started', 'session', {}, '2026-09-22T08:00:00Z'),
      ev('u3', 'import_started', 'import', { source: 'storygraph' }, '2026-09-22T08:05:00Z'),
      ev('u3', 'import_failed', 'import', { source: 'storygraph' }, '2026-09-22T08:06:00Z'),
      ev('u4', 'account_created', 'onboarding', {}, '2026-09-22T12:00:00Z'),
      ev('u4', 'session_started', 'session', {}, '2026-09-22T12:01:00Z'),
      ev('u4', 'library_opened', 'onboarding', {}, '2026-09-22T12:02:00Z'),
      ev('u4', 'first_book_added', 'onboarding', {}, '2026-09-22T12:10:00Z'),
    ];
    const a = run(`aggregateAnalytics(${JSON.stringify(rows)})`);
    ok('multi-user: totals', a.totalEvents === rows.length && a.uniqueUsers === 4);
    ok('multi-user: active users = session_started users', a.activeUsers === 4);
    ok('multi-user: new signups', a.newSignups === 1);
    ok('multi-user: books added', a.booksAdded === 3);
    const bookAdded = a.featureUsage.find(f => f.event === 'book_added');
    ok('multi-user: feature usage users/uses', bookAdded.users === 2 && bookAdded.uses === 3);
    ok('multi-user: adoption math', bookAdded.users / a.activeUsers === 0.5);
    const r = a.funnels.roulette.map(s => s.users);
    ok('multi-user: roulette funnel stages', JSON.stringify(r) === JSON.stringify([2, 1, 1, 1]));
    const o = a.funnels.onboarding.map(s => s.users);
    ok('multi-user: onboarding funnel stages', JSON.stringify(o) === JSON.stringify([1, 1, 1, 0, 0]));
    const im = a.funnels.imports.map(s => s.users);
    ok('multi-user: import funnel + failure', JSON.stringify(im) === JSON.stringify([2, 1]) && a.funnels.importFailed === 1);
    ok('multi-user: import source books summed', a.importSources.goodreads.books === 120 && a.importSources.goodreads.completed === 1);
    ok('multi-user: import source failure recorded', a.importSources.storygraph.failed === 1 && a.importSources.storygraph.started === 1);
    ok('multi-user: add sources split', a.addSources.search === 2 && a.addSources.isbn_list === 1);
    ok('v243: provider usage split by backend and context',
      a.providerUsage.gbooks.search === 1 && a.providerUsage.gbooks.isbn === 1 &&
      a.providerUsage.cache.isbn === 1 && (a.providerUsage.cache.search || 0) === 0);
    ok('v245: pagecount context aggregated per provider',
      a.providerUsage.gbooks.pagecount === 1 && (a.providerUsage.cache.pagecount || 0) === 0);
    ok('multi-user: activity sorted by recency', a.userActivity[0].uid === 'u4' && a.userActivity.length === 4);
    ok('multi-user: top category detected', a.userActivity.find(u => u.uid === 'u1').topCategory === 'discovery');
  }

  /* ---- 3. 20k cap flag ---- */
  {
    const rows = [];
    for (let i = 0; i < 20000; i++) rows.push(ev('u' + (i % 5), 'session_started', 'session', {}, '2026-09-20T10:00:00Z'));
    const a = run(`aggregateAnalytics([])`); // small sets: not flagged
    ok('cap: small sets not flagged', a.capped === false);
    const big = run(`aggregateAnalytics(new Array(20000).fill(0).map((_,i)=>({user_id:'u'+(i%5),event_name:'session_started',event_category:'session',properties:{},app_version:'v119',created_at:'2026-09-20T10:00:00Z'})))`);
    ok('cap: 20000 rows flagged', big.capped === true && big.uniqueUsers === 5);
  }

  /* ---- 4. gating: non-admin never sees, never fetches ---- */
  {
    run(`var __fetched = false;
      window.__adminFake = {
        adminRows: [], eventRows: [],
        from(table) {
          const self = this;
          const b = { select(){return b;}, order(){return b;}, limit(){return b;}, gte(){return b;}, lte(){return b;},
            then(res, rej) { __fetched = true; return Promise.resolve({ data: table === 'app_admins' ? self.adminRows : self.eventRows, error: null }).then(res, rej); } };
          return b;
        }
      };
      cloudClient = async () => window.__adminFake;
      cloudUser = { email: 'reader@example.com' };
      isAppAdmin = false;`);
    const items = run(`menuItems().map(m => m.id)`);
    ok('gating: no Observatory menu entry for non-admin', !items.includes('observatory'));
    run(`renderAdmin()`);
    ok('gating: restricted view for non-admin', window.document.getElementById('view').innerHTML.includes('Restricted area'));
    ok('gating: no analytics fetch for non-admin', run(`__fetched`) === false);
  }

  /* ---- 5. refreshAdminStatus resolves both ways ---- */
  {
    run(`window.__adminFake.adminRows = [{ user_id: 'admin1' }];`);
    await run(`refreshAdminStatus()`);
    ok('admin check: registry hit → isAppAdmin true', run(`isAppAdmin`) === true);
    const items = run(`menuItems().map(m => m.id)`);
    ok('admin check: Observatory menu entry appears for admin', items.includes('observatory'));
    run(`window.__adminFake.adminRows = [];`);
    await run(`refreshAdminStatus()`);
    ok('admin check: empty registry → isAppAdmin false', run(`isAppAdmin`) === false);
  }

  /* ---- 6. admin render path fetches and aggregates ---- */
  {
    run(`window.__adminFake.adminRows = [{ user_id: 'admin1' }];
      window.__adminFake.eventRows = [
        { user_id: 'u1', event_name: 'session_started', event_category: 'session', properties: {}, app_version: 'v119', created_at: '2026-09-26T10:00:00Z' },
        { user_id: 'u1', event_name: 'book_added', event_category: 'library', properties: { source: 'search' }, app_version: 'v119', created_at: '2026-09-26T10:05:00Z' },
        { user_id: 'u2', event_name: 'session_started', event_category: 'session', properties: {}, app_version: 'v119', created_at: '2026-09-26T11:00:00Z' }
      ];
      adminRange = 'all'; adminRowsCache = {}; adminAggCache = {};`);
    await run(`refreshAdminStatus()`);
    run(`renderAdmin()`);
    await new Promise(r => setTimeout(r, 50));
    const html = window.document.getElementById('view').innerHTML;
    ok('render: overview cards present', html.includes('Active users') && html.includes('Books added'));
    ok('render: active user count shown', html.includes('ob-stat-val">2<'));
    ok('render: feature usage table', html.includes('Feature usage') && html.includes('Book added'));
    ok('render: funnels rendered', html.includes('Roulette funnel') && html.includes('Onboarding funnel'));
    ok('render: user activity anonymized', html.includes('User activity') && !html.includes('reader@example.com'));
  }

  /* ---- 7. date ranges ---- */
  {
    run(`adminRange = 'today';`);
    const since = run(`adminRangeSince()`);
    const d = new Date(since);
    ok('range: today starts at midnight', d.getHours() === 0 && d.getMinutes() === 0);
    run(`adminRange = '7d';`);
    const w = Date.now() - new Date(run(`adminRangeSince()`)).getTime();
    ok('range: 7d ≈ 7 days', Math.abs(w - 7 * 864e5) < 60e3);
    run(`adminRange = 'all';`);
    ok('range: all → no lower bound', run(`adminRangeSince()`) === null);
    run(`adminRange = 'custom'; adminCustomFrom = '2026-09-01'; adminCustomTo = '2026-09-10';`);
    const cs = new Date(run(`adminRangeSince()`)), cu = new Date(run(`adminRangeUntil()`));
    ok('range: custom bounds', cs.getFullYear() === 2026 && cs.getMonth() === 8 && cs.getDate() === 1 &&
      cu.getFullYear() === 2026 && cu.getMonth() === 8 && cu.getDate() === 10);
    ok('range: key distinguishes customs', run(`adminRangeKey()`).includes('2026-09-01'));
  }

  /* ---- 8. structural: the dashboard can only read safe columns ---- */
  {
    const src = fs.readFileSync(path.join(ROOT, 'js/199-admin.js'), 'utf8');
    const sels = [...src.matchAll(/\.select\('([^']+)'\)/g)].map(m => m[1]);
    // The third select is Trope Lab's coverage scan: book_key (a cache key,
    // ISBN or normalized title/author — no titles, descriptions, or notes)
    // plus taxonomy_version and taxonomy_rev (v157). Still no book content.
    // The fourth (v159) is the all-libraries backfill scan: it selects only
    // bibliographic jsonb fields via data-> — never the full data blob
    // (which can hold shelves, ratings, notes).
    // The fifth/sixth (v166) are the review queue: book_tropes rows
    // (book_key cache key, trope ids, confidence) and trope_votes rows
    // (votes + voter ids) — still no titles, descriptions, or notes.
    // The seventh/eighth (v246) are the moderation queue: user_reports rows
    // (ids, reason, reporter-written details) and banned_users rows —
    // abuse metadata only, never library contents.
    // The ninth/tenth/eleventh (v271) are the claims-aware coverage scan:
    // book_trope_claims work_ids, editions isbn->work_id pairs, and works
    // title_norm/author_norm — opaque ids and bibliographic fields only,
    // never shelves, ratings, or notes.
    // The twelfth (v276) is the Trope Lab orphan-title primer: editions
    // isbn plus the linked work's title/authors — global bibliographic
    // catalog data (public book metadata, same class as the v271 works
    // fields), never user library contents.
    // The thirteenth/fourteenth/fifteenth (v286) are the edition-asset
    // moderation lab: editions bibliographic fields (id, isbn, publisher,
    // format, page_count), edition_assets candidate metadata and quality
    // scores (deliberately NOT source_user_id — no contributor PII in the
    // projection), and edition_asset_slots canonical-slot state. Asset
    // evidence only, never library contents.
    // The sixteenth/seventeenth (v317) are the Character Lab: book_characters
    // work_ids with work titles (shared pipeline metadata, same class as the
    // v271 works fields), and per-work character rows (names, roles,
    // descriptions, relationships — pipeline-extracted fiction metadata,
    // never user library contents).
    const allowed = new Set([
      'user_id',
      'user_id,event_name,event_category,properties,app_version,created_at',
      'book_key, taxonomy_version, taxonomy_rev',
      'user_id, isbn, data->title, data->authors, data->categories, data->description',
      'book_key, trope_id, confidence, source',
      'book_key, trope_id, vote, user_id',
      'id,reporter_id,reported_user_id,reason,details,created_at',
      'user_id,reason,banned_at,banned_by',
      'work_id',
      'isbn, work_id',
      'id, title_norm, author_norm',
      'isbn, works(title, authors)',
      'id,isbn,publisher,format,page_count',
      'id,face,appearance,bucket,path,width,height,quality_score,sharpness_score,exposure_score,perspective_score,coverage_score,glare_score,resolution_score,stability_score,verified,rejected,created_at',
      'face,appearance,canonical_asset_id,selection_method,selected_at',
      'work_id, works(title)',
      'id, name, role, description, relationships, confidence, status, character_id, suggested_character_id',
      'character_id, work_id, works(title)',
      'id, name, description, updated_at',
      'id, name, description',
      'id',
      'id, work_id, name, role, description, relationships, works(title)',
      'name',
    ]);
    ok('structural: select projections are exactly the safe columns',
      sels.length > 0 && sels.every(s => allowed.has(s)) &&
      sels.includes('user_id, isbn, data->title, data->authors, data->categories, data->description'));
    ok('structural: never selects the whole book data blob',
      !sels.some(s => s.includes('data') && !s.includes('data->')));
    ok('structural: never reads content fields off properties',
      !/properties\.(title|author|isbn|cover|notes|tropes|rating)/i.test(src) &&
      !/properties\[['"](title|author|isbn)/i.test(src));
  }

  /* ---- v264: Spine Lab result rendering ---- */
  {
    const none = run(`spineLabResultHTML({ candidates: [], sources: [] })`);
    ok('spinelab: empty result explains the fallback', none.includes('No spine found'));
    const some = run(`spineLabResultHTML({ candidates: [
      { image_url: 'https://img.example/s.jpg', page_url: 'https://books.example/p', note: 'spine visible' }
    ], sources: [{ uri: 'https://books.example/p', title: 'Example' }] })`);
    ok('spinelab: candidate image rendered', some.includes('https://img.example/s.jpg'));
    ok('spinelab: source page linked', some.includes('https://books.example/p'));
    ok('spinelab: null data -> empty', run(`spineLabResultHTML(null)`) === '');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
