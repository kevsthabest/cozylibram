// Roaming settings (v518): user_state migration shape + js/229-user-state.js
// sync behavior against a mocked Supabase client — newer-pull applies,
// older-pull ignored, push is hash-gated, seeding order (pull before push),
// cross-account baseline, offline fail-open.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in user-state tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const ls = window.localStorage;

function makeFake() {
  const SECTION_COLS = ['warning_prefs', 'up_next', 'release_state', 'shelf_state', 'privacy_state', 'milestone_state', 'prefs_state', 'finale_state', 'reco_state'];
  const COL_DEFAULTS = { settings: {}, warning_prefs: {}, up_next: [], release_state: {}, shelf_state: {}, privacy_state: {}, milestone_state: {}, prefs_state: {}, finale_state: {}, reco_state: {} };
  const fake = {
    rows: new Map(), // user_id -> { user_id, settings, warning_prefs, up_next, release_state, shelf_state, updated_at }
    upserts: [],
    failSelect: false,
    throwFrom: false,
    missingColumns: false, // v520: simulate a pre-sections database (columns absent)
    from(table) {
      if (table !== 'user_state') throw new Error('unexpected table: ' + table);
      if (fake.throwFrom) throw new Error('client exploded');
      return {
        select(cols) {
          const wanted = String(cols || 'settings').split(',').map(s => s.trim());
          const filters = {};
          const b = {
            eq(col, val) { filters[col] = val; return b; },
            maybeSingle: async () => {
              if (fake.failSelect) return { data: null, error: new Error('network down') };
              const missing = wanted.find(c => SECTION_COLS.includes(c));
              if (fake.missingColumns && missing) {
                return { data: null, error: { code: '42703', message: 'column user_state.' + missing + ' does not exist' } };
              }
              const row = fake.rows.get(filters.user_id) || null;
              if (!row) return { data: null, error: null };
              const out = {};
              for (const c of wanted) out[c] = (c in row) ? row[c] : COL_DEFAULTS[c];
              return { data: out, error: null };
            },
          };
          return b;
        },
        upsert: async (row) => {
          const badCol = SECTION_COLS.find(c => c in row);
          if (fake.missingColumns && badCol) {
            return { error: { code: '42703', message: 'column user_state.' + badCol + ' does not exist' } };
          }
          fake.upserts.push(row);
          // PostgREST upsert merges into the existing row: columns not in
          // the payload keep their stored values.
          fake.rows.set(row.user_id, Object.assign({}, fake.rows.get(row.user_id) || {}, row));
          return { error: null };
        },
      };
    },
  };
  return fake;
}

// Wipe every key the module can touch (in-scope settings, the v520
// section keys, and bookkeeping), simulating a fresh device or a new
// scenario. Also resets the in-window Up Next queue + account partition.
function clearState() {
  const doomed = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && (k.indexOf('cozylibram.userstate') === 0 ||
      ['theme', 'accent', 'spicyshelves.animation', 'spicyshelves.favstyle',
        'pshareStyle', 'portraitShareV1', 'cozylibram.tagline', 'cl_hide_spoilers',
        'cozylibram.dnaSurveyOff', 'cozylibram.dnaNudgesOff', 'spicyshelves.onboarded',
        'spicyshelves.storeRegion', 'spicyshelves.sortby', 'spicyshelves.seriesfilter',
        'cozylibram.warningPrefs.v1',
        'cozylibram.finale.v1',
        'cozylibram.privacy.v1',
        'spicyshelves.analytics', 'spicyshelves.logremove',
        'cozylibram.bookdress', 'cozylibram.ambience.volume',
        'shelfViewMode',
        'cozylibram.s3d.deco.v2', 'cozylibram.s3d.deco.v1', 'cozylibram.s3d.dressed.v1',
        'cozylibram.s3d.arrange', 'cozylibram.s3d.spines',
        'spicyshelves.auto_releases', 'spicyshelves.auto_releases_seen', 'spicyshelves.dismissed_releases',
        'spicyshelves.reco_dismissed'].includes(k) ||
      k.indexOf('spicyshelves.upnext.v1') === 0 ||
      k.indexOf('spicyshelves.shelforder.v1') === 0 ||
      k.indexOf('seasonThemeNudge:') === 0 || k.indexOf('wrapped-banner-') === 0)) doomed.push(k);
  }
  doomed.forEach(k => ls.removeItem(k));
  runInWindow('try { upNext = []; } catch (e) {} try { localUid = null; } catch (e) {}' +
    ' try { shelfOrderCache = null; } catch (e) {}');
}
const setUser = (id) => runInWindow("cloudUser = { id: '" + id + "', email: 'u@example.com' };");
// Point the app's per-account partition + in-memory Up Next queue at a
// scenario state (what setLocalUser would have established at sign-in).
const setQueue = (uid, arr) => runInWindow(
  'localUid = ' + (uid ? "'" + uid + "'" : 'null') + '; upNext = ' + JSON.stringify(arr) + ';');
const probeQueue = () => {
  runInWindow('window.__probeUpNext = (typeof upNext !== "undefined" && Array.isArray(upNext)) ? upNext.slice() : null;');
  return window.__probeUpNext;
};
// v521: set / probe the 2D shelf order doc through the app's own write
// path (saveShelfOrder + cache), the same pair js/229's apply uses.
const setShelfDoc = (doc) => runInWindow(
  'saveShelfOrder(' + JSON.stringify(doc) + '); shelfOrderCache = ' + JSON.stringify(doc) + ';');
const probeShelfDoc = () => {
  runInWindow('window.__probeShelf = JSON.parse(JSON.stringify(shelfOrder()));');
  return window.__probeShelf;
};
// Key-order-insensitive stringify for doc comparisons.
const canon = (o) => JSON.stringify(o, (k, v) =>
  (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.keys(v).sort().reduce((a, key) => { a[key] = v[key]; return a; }, {})
    : v);
// v575: the local Discover dismissal set, read back through js/198's own
// reader (IDB in production; the localStorage fallback in this env).
const probeDismissals = async () => Array.from(await window.recoDismissedSet());
const setEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

(async () => {
  /* ---------- migration + registration shape ---------- */
  const sqlPath = path.join(ROOT, 'supabase/migrations/v518_user_state.sql');
  ok('migration file exists', fs.existsSync(sqlPath));
  const sql = fs.readFileSync(sqlPath, 'utf8');
  ok('creates user_state table', /create table if not exists public\.user_state/.test(sql));
  ok('user_id is PK referencing auth.users with cascade',
    /user_id uuid primary key references auth\.users \(id\) on delete cascade/.test(sql));
  ok('settings jsonb defaults to empty object',
    /settings jsonb not null default '\{\}'::jsonb/.test(sql));
  ok('updated_at timestamptz default now()',
    /updated_at timestamptz not null default now\(\)/.test(sql));
  ok('RLS enabled', /alter table public\.user_state enable row level security/.test(sql));
  ok('own-rows policy for all',
    /create policy "own state" on public\.user_state\s+for all using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/.test(sql));
  ok('profiles is NOT altered (circle-read leak guard)', !/alter table (public\.)?profiles/.test(sql));
  ok('index.html registers js/229-user-state.js', html.includes('<script src="js/229-user-state.js"></script>'));
  const swText = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok('sw.js precaches 229-user-state.js', swText.includes("'229-user-state.js'"));
  ok('version pairing is v616',
    /APP_VERSION = 'v616'/.test(fs.readFileSync(path.join(ROOT, 'js/181-appversion.js'), 'utf8')) &&
    swText.includes("cozy-libram-v616"));

  /* ---------- v520 sections migration shape ---------- */
  const sql520Path = path.join(ROOT, 'supabase/migrations/v520_user_state_sections.sql');
  ok('v520 migration file exists', fs.existsSync(sql520Path));
  const sql520 = fs.readFileSync(sql520Path, 'utf8');
  ok('v520 adds warning_prefs jsonb with {} default',
    /add column if not exists warning_prefs jsonb not null default '\{\}'::jsonb/.test(sql520));
  ok('v520 adds up_next jsonb with [] default',
    /add column if not exists up_next jsonb not null default '\[\]'::jsonb/.test(sql520));
  ok('v520 adds release_state jsonb with {} default',
    /add column if not exists release_state jsonb not null default '\{\}'::jsonb/.test(sql520));
  ok('v520 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql520) && !/alter table (public\.)?profiles/.test(sql520));

  /* ---------- v521 shelf migration shape ---------- */
  const sql521Path = path.join(ROOT, 'supabase/migrations/v521_user_state_shelf.sql');
  ok('v521 migration file exists', fs.existsSync(sql521Path));
  const sql521 = fs.readFileSync(sql521Path, 'utf8');
  ok('v521 adds shelf_state jsonb with {} default',
    /add column if not exists shelf_state jsonb not null default '\{\}'::jsonb/.test(sql521));
  ok('v521 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql521) && !/alter table (public\.)?profiles/.test(sql521));

  /* ---------- v524 privacy migration shape ---------- */
  const sql524Path = path.join(ROOT, 'supabase/migrations/v524_user_state_privacy.sql');
  ok('v524 migration file exists', fs.existsSync(sql524Path));
  const sql524 = fs.readFileSync(sql524Path, 'utf8');
  ok('v524 adds privacy_state jsonb with {} default',
    /add column if not exists privacy_state jsonb not null default '\{\}'::jsonb/.test(sql524));
  ok('v524 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql524) && !/alter table (public\.)?profiles/.test(sql524));

  /* ---------- v536 milestone-pin migration shape ---------- */
  const sql536Path = path.join(ROOT, 'supabase/migrations/v536_user_state_milestone.sql');
  ok('v536 migration file exists', fs.existsSync(sql536Path));
  const sql536 = fs.readFileSync(sql536Path, 'utf8');
  ok('v536 adds milestone_state jsonb with {} default',
    /add column if not exists milestone_state jsonb not null default '\{\}'::jsonb/.test(sql536));
  ok('v536 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql536) && !/alter table (public\.)?profiles/.test(sql536));

  /* ---------- v537 prefs migration shape ---------- */
  const sql537Path = path.join(ROOT, 'supabase/migrations/v537_user_state_prefs.sql');
  ok('v537 migration file exists', fs.existsSync(sql537Path));
  const sql537 = fs.readFileSync(sql537Path, 'utf8');
  ok('v537 adds prefs_state jsonb with {} default',
    /add column if not exists prefs_state jsonb not null default '\{\}'::jsonb/.test(sql537));
  ok('v537 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql537) && !/alter table (public\.)?profiles/.test(sql537));

  /* ---------- v567 finale migration shape ---------- */
  const sql567Path = path.join(ROOT, 'supabase/migrations/v567_user_state_finale.sql');
  ok('v567 migration file exists', fs.existsSync(sql567Path));
  const sql567 = fs.readFileSync(sql567Path, 'utf8');
  ok('v567 adds finale_state jsonb with {} default',
    /add column if not exists finale_state jsonb not null default '\{\}'::jsonb/.test(sql567));
  ok('v567 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql567) && !/alter table (public\.)?profiles/.test(sql567));

  /* ---------- v536 milestone pin section: collect/apply ---------- */
  clearState();
  ok('milestone pin collect is null when unset',
    window.userStateCollectMilestonePin().value === null);
  ls.setItem('cozylibram.milestonePin.v1', 'first-book');
  ok('milestone pin collect reads the device key',
    window.userStateCollectMilestonePin().value === 'first-book');
  window.userStateApplyMilestonePin({ value: 'series-finished-dune' });
  ok('milestone pin apply writes the device key',
    ls.getItem('cozylibram.milestonePin.v1') === 'series-finished-dune');
  window.userStateApplyMilestonePin({ value: null });
  ok('milestone pin apply with null clears the pin',
    ls.getItem('cozylibram.milestonePin.v1') === null);
  window.userStateApplyMilestonePin({ value: 42 });
  ok('milestone pin apply rejects a non-string value (clears instead)',
    ls.getItem('cozylibram.milestonePin.v1') === null);
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (no milestone key in USER_STATE_KEYS)',
    !window.__probeKeys.includes('cozylibram.milestonePin.v1'));

  /* ---------- v537 device-prefs section: collect/apply ---------- */
  clearState();
  ok('prefs collect is empty when neither key is set',
    JSON.stringify(window.userStateCollectPrefs()) === '{"values":{}}');
  ls.setItem('spicyshelves.analytics', '0');
  ls.setItem('spicyshelves.logremove', 'on');
  ok('prefs collect reads both device keys',
    window.userStateCollectPrefs().values['spicyshelves.analytics'] === '0' &&
    window.userStateCollectPrefs().values['spicyshelves.logremove'] === 'on');
  window.userStateApplyPrefs({ values: { 'spicyshelves.analytics': '1', 'spicyshelves.logremove': 'off' } });
  ok('prefs apply writes both keys',
    ls.getItem('spicyshelves.analytics') === '1' && ls.getItem('spicyshelves.logremove') === 'off');
  window.userStateApplyPrefs({ values: { 'spicyshelves.analytics': '0' } });
  ok('prefs apply is full-snapshot: a key absent from the snapshot is removed',
    ls.getItem('spicyshelves.analytics') === '0' && ls.getItem('spicyshelves.logremove') === null);
  window.userStateApplyPrefs({ values: null });
  ok('prefs apply with a malformed payload clears both keys (never throws)',
    ls.getItem('spicyshelves.analytics') === null && ls.getItem('spicyshelves.logremove') === null);
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (neither prefs key joins USER_STATE_KEYS)',
    !window.__probeKeys.includes('spicyshelves.analytics') &&
    !window.__probeKeys.includes('spicyshelves.logremove'));
  ok('settings snapshot never collects the prefs keys',
    !('spicyshelves.analytics' in window.userStateCollect()) &&
    !('spicyshelves.logremove' in window.userStateCollect()));
  /* ---------- v572: the ambience volume joins the prefs inventory ----------
     A new key in THIS section (never the frozen settings snapshot):
     collect reads it, apply writes it, and it stays out of
     USER_STATE_KEYS like the other prefs keys. */
  clearState();
  ls.setItem('cozylibram.ambience.volume', '0.5');
  ok('prefs collect reads the ambience volume key',
    window.userStateCollectPrefs().values['cozylibram.ambience.volume'] === '0.5');
  window.userStateApplyPrefs({ values: { 'cozylibram.ambience.volume': '0.25' } });
  ok('prefs apply writes the ambience volume key',
    ls.getItem('cozylibram.ambience.volume') === '0.25');
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (no ambience key in USER_STATE_KEYS)',
    !window.__probeKeys.includes('cozylibram.ambience.volume'));
  ok('settings snapshot never collects the ambience volume key',
    !('cozylibram.ambience.volume' in window.userStateCollect()));
  clearState();
  /* ---------- v572: the prefs inventory is the composed union ----------
     The book-dressing (v571) and ambience (v572) branches each added a
     key to this section from parallel bases; the merge composes
     PREFS_STATE_KEYS to the union of all four — the original pair, the
     dressing toggle, and the ambience volume. This block pins the
     composed list behaviourally: all four keys collect and apply
     through the one prefs section, and none joins USER_STATE_KEYS. */
  clearState();
  ls.setItem('spicyshelves.analytics', '0');
  ls.setItem('spicyshelves.logremove', 'on');
  ls.setItem('cozylibram.bookdress', 'off');
  ls.setItem('cozylibram.ambience.volume', '0.5');
  const composedPrefs = window.userStateCollectPrefs().values;
  ok('prefs collect reads the composed four-key inventory',
    composedPrefs['spicyshelves.analytics'] === '0' &&
    composedPrefs['spicyshelves.logremove'] === 'on' &&
    composedPrefs['cozylibram.bookdress'] === 'off' &&
    composedPrefs['cozylibram.ambience.volume'] === '0.5');
  window.userStateApplyPrefs({ values: { 'spicyshelves.analytics': '1', 'spicyshelves.logremove': 'off', 'cozylibram.bookdress': 'on', 'cozylibram.ambience.volume': '0.75' } });
  ok('prefs apply writes the composed four-key inventory',
    ls.getItem('spicyshelves.analytics') === '1' &&
    ls.getItem('spicyshelves.logremove') === 'off' &&
    ls.getItem('cozylibram.bookdress') === 'on' &&
    ls.getItem('cozylibram.ambience.volume') === '0.75');
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (no composed prefs key in USER_STATE_KEYS)',
    !window.__probeKeys.includes('cozylibram.bookdress') &&
    !window.__probeKeys.includes('cozylibram.ambience.volume'));
  clearState();
  /* ---------- v574: the Marginalia off switch joins the prefs inventory ----------
     A fifth key in THIS section (never the frozen settings
     snapshot): collect reads it, apply writes it, and it stays out
     of USER_STATE_KEYS like the other prefs keys. (profiles is
     authoritative for serving — this key is js/242's UI state.) */
  clearState();
  ls.setItem('cozylibram.marginalia', 'off');
  ok('prefs collect reads the marginalia key',
    window.userStateCollectPrefs().values['cozylibram.marginalia'] === 'off');
  window.userStateApplyPrefs({ values: { 'cozylibram.marginalia': 'off' } });
  ok('prefs apply writes the marginalia key',
    ls.getItem('cozylibram.marginalia') === 'off');
  window.userStateApplyPrefs({ values: {} });
  ok('prefs apply full-snapshot: an absent marginalia key is removed (back to default ON)',
    ls.getItem('cozylibram.marginalia') === null);
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (no marginalia key in USER_STATE_KEYS)',
    !window.__probeKeys.includes('cozylibram.marginalia'));
  ok('settings snapshot never collects the marginalia key',
    !('cozylibram.marginalia' in window.userStateCollect()));
  clearState();
  /* ---------- v567 finale section: collect/apply ---------- */
  clearState();
  ok('finale collect is null when unset',
    window.userStateCollectFinale().value === null);
  const finRec = { kind: 'complete', at: 1750000000000, name: 'The Test Saga', count: 3, pages: 960, first: '2025-01-10T00:00:00.000Z', last: '2025-06-10T00:00:00.000Z', ratings: [5, 4, 0], favChar: null, override: false, seen: true };
  ls.setItem('cozylibram.finale.v1', JSON.stringify({ 'the test saga': finRec, bogus: { kind: 'everything' } }));
  ok('finale collect reads the device key and normalizes (bad kinds dropped)',
    !!window.userStateCollectFinale().value['the test saga'] &&
    !('bogus' in window.userStateCollectFinale().value));
  window.userStateApplyFinale({ value: { 'the test saga': { ...finRec, kind: 'caughtup' } } });
  ok('finale apply writes the device key',
    JSON.parse(ls.getItem('cozylibram.finale.v1'))['the test saga'].kind === 'caughtup');
  window.userStateApplyFinale({ value: null });
  ok('finale apply with null clears the key',
    ls.getItem('cozylibram.finale.v1') === null);
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (no finale key in USER_STATE_KEYS)',
    !window.__probeKeys.includes('cozylibram.finale.v1'));
  ok('settings snapshot never collects the finale key',
    !('cozylibram.finale.v1' in window.userStateCollect()));

  // Local-first: an opt-out already on the device is the live read at
  // boot, with no pull having run (analyticsEnabled reads localStorage).
  ls.setItem('spicyshelves.analytics', '0');
  ok('local opt-out is honoured from the local read (no sync needed)',
    window.eval('analyticsEnabled()') === false);
  ls.removeItem('spicyshelves.analytics');
  ok('no local opt-out reads as enabled (default)', window.eval('analyticsEnabled()') === true);

  /* ---------- collect: scope is exact ---------- */
  clearState();
  ls.setItem('theme', 'dark');
  ls.setItem('spicyshelves.storeRegion', 'ca');
  ls.setItem('seasonThemeNudge:halloween', '1');
  ls.setItem('wrapped-banner-2026', 'x');
  ls.setItem('spicyshelves.sortby', 'title');       // roams (User override)
  ls.setItem('spicyshelves.seriesfilter', 'all');   // roams (User override)
  ls.setItem('shelfViewMode', 'grid');              // not a settings key (rides the v521 shelf section)
  ls.setItem('spicyshelves.setgroups', '{}');       // stays local (navigation transient)
  ls.setItem('cozylibram.warningPrefs.v1', '{"excluded":[],"prominent":[],"detail":"gentle"}'); // v520 section, NOT a settings key
  ls.setItem('spicyshelves.auto_releases', '{"at":1,"list":[]}'); // v520 section, NOT a settings key
  const collected = window.userStateCollect();
  ok('collect includes core keys', collected.theme === 'dark');
  ok('collect includes storeRegion (User override)', collected['spicyshelves.storeRegion'] === 'ca');
  ok('collect includes sort + series filter (User override)',
    collected['spicyshelves.sortby'] === 'title' && collected['spicyshelves.seriesfilter'] === 'all');
  ok('collect includes prefix families',
    collected['seasonThemeNudge:halloween'] === '1' && collected['wrapped-banner-2026'] === 'x');
  ok('collect excludes shelf-state + navigation transients',
    !('shelfViewMode' in collected) && !('spicyshelves.setgroups' in collected));
  ok('settings snapshot stays v518-shaped (section keys never join it)',
    !('cozylibram.warningPrefs.v1' in collected) && !('spicyshelves.auto_releases' in collected));
  const shelfCollected = window.userStateCollectShelf();
  ok('shelf collect scope is exact (viewmode only; no transients, no settings keys)',
    canon(Object.keys(shelfCollected.values).sort()) === '["viewmode"]' &&
    shelfCollected.values.viewmode === 'grid');

  /* ---------- pull applies newer server state, incl. restyle ---------- */
  const fake = makeFake();
  window.__sbStub = fake;
  fake.rows.set('user-1', {
    user_id: 'user-1',
    settings: { _at: 5000, values: { theme: 'velvet', accent: 'gold', 'spicyshelves.storeRegion': 'us' } },
  });
  clearState();
  ls.setItem('theme', 'dark');
  setUser('user-1');
  const applied = await window.userStatePull();
  ok('pull reports applied', applied === true);
  ok('pull writes server values', ls.getItem('theme') === 'velvet' && ls.getItem('accent') === 'gold');
  ok('pull writes storeRegion', ls.getItem('spicyshelves.storeRegion') === 'us');
  ok('pull restyles via applyTheme',
    window.document.documentElement.dataset.theme === 'velvet' &&
    window.document.documentElement.dataset.accent === 'gold');
  const meta1 = JSON.parse(ls.getItem('cozylibram.userstate.v1.user-1') || 'null');
  ok('pull records per-user meta', !!meta1 && meta1.at === 5000 && typeof meta1.hash === 'string');

  /* ---------- v534: adopted sort/series filter apply live, no reload ---------- */
  runInWindow(`sortBy = 'added'; seriesFilter = 'all';`);
  fake.rows.set('user-1', {
    user_id: 'user-1',
    settings: { _at: 6000, values: { theme: 'velvet', accent: 'gold', 'spicyshelves.storeRegion': 'us', 'spicyshelves.sortby': 'title', 'spicyshelves.seriesfilter': 'started' } },
  });
  const appliedView = await window.userStatePull();
  ok('v534: pull with roamed sort/filter applies', appliedView === true);
  ok('v534: adopted sortBy takes effect on the live global (no reload)',
    window.eval(`sortBy`) === 'title');
  ok('v534: adopted seriesFilter takes effect on the live global (no reload)',
    window.eval(`seriesFilter`) === 'started');

  /* ---------- pull ignores older server state ---------- */
  fake.rows.set('user-1', {
    user_id: 'user-1',
    settings: { _at: 4000, values: { theme: 'frost' } },
  });
  const appliedOlder = await window.userStatePull();
  ok('older pull is ignored', appliedOlder === false && ls.getItem('theme') === 'velvet');

  /* ---------- push is hash-gated; sections seed once after a pull ---------- */
  const pushed0 = await window.userStatePush();
  ok('first push after pull seeds the sections only (settings already synced)',
    pushed0 === true && fake.upserts.length === 1 && !('settings' in fake.upserts[0]) &&
    !!fake.upserts[0].warning_prefs && !!fake.upserts[0].up_next && !!fake.upserts[0].release_state);
  const pushedNoop = await window.userStatePush();
  ok('push with unchanged snapshot is a no-op', pushedNoop === false && fake.upserts.length === 1);
  ls.setItem('theme', 'frost');
  const pushed1 = await window.userStatePush();
  ok('push fires on value change', pushed1 === true && fake.upserts.length === 2);
  ok('push upserts own row with fresh _at',
    fake.upserts[1].user_id === 'user-1' &&
    fake.upserts[1].settings.values.theme === 'frost' &&
    fake.upserts[1].settings._at > 5000);
  const pushed2 = await window.userStatePush();
  ok('second push without change is a no-op', pushed2 === false && fake.upserts.length === 2);

  /* ---------- seeding: empty server, first device seeds on push ---------- */
  const fake2 = makeFake();
  window.__sbStub = fake2;
  clearState();
  ls.setItem('theme', 'hearthside');
  setUser('user-1');
  const seedPull = await window.userStatePull();
  ok('empty-server pull applies nothing', seedPull === false && fake2.upserts.length === 0);
  const seeded = await window.userStatePush();
  ok('first device seeds the row',
    seeded === true && fake2.rows.get('user-1').settings.values.theme === 'hearthside' &&
    Number((fake2.rows.get('user-1').warning_prefs || {})._at) > 0);

  /* ---------- second device adopts before its first push ---------- */
  clearState(); // fresh device: no meta, no owner marker
  ls.setItem('theme', 'dark'); // device default, must NOT clobber the seed
  const adopted = await window.userStatePull();
  ok('second device adopts server state', adopted === true && ls.getItem('theme') === 'hearthside');
  const overwrite = await window.userStatePush();
  ok('second device does not overwrite after adopting',
    overwrite === false && fake2.rows.get('user-1').settings.values.theme === 'hearthside');

  /* ---------- cross-account: another account's values are baselined ---------- */
  const fake3 = makeFake();
  window.__sbStub = fake3;
  clearState();
  ls.setItem('theme', 'velvet'); // user-1's theme still on the device
  ls.setItem('cozylibram.userstate.owner', 'user-1');
  setUser('user-2');
  await window.userStatePull();
  const leaked = await window.userStatePush();
  ok('no seed push of another account\'s values',
    leaked === false && fake3.upserts.length === 0 && !fake3.rows.has('user-2'));
  ls.setItem('theme', 'abyss'); // a change made under user-2
  const ownChange = await window.userStatePush();
  ok('change under the new account pushes to its own row',
    ownChange === true && fake3.rows.get('user-2').settings.values.theme === 'abyss');

  /* ---------- fail-open: errors and signed-out state change nothing ---------- */
  const fake4 = makeFake();
  window.__sbStub = fake4;
  fake4.failSelect = true;
  clearState();
  ls.setItem('theme', 'dark');
  setUser('user-1');
  let threw = false, pullResult = null;
  try { pullResult = await window.userStatePull(); } catch (e) { threw = true; }
  ok('select error fails open', !threw && pullResult === false && ls.getItem('theme') === 'dark');
  fake4.failSelect = false;
  fake4.throwFrom = true;
  threw = false; pullResult = null;
  try { pullResult = await window.userStatePull(); } catch (e) { threw = true; }
  ok('client explosion fails open', !threw && pullResult === false && ls.getItem('theme') === 'dark');
  runInWindow('cloudUser = null;');
  const signedOutPull = await window.userStatePull();
  const signedOutPush = await window.userStatePush();
  ok('signed out: pull and push are no-ops', signedOutPull === false && signedOutPush === false);

  /* ---------- v520: warning prefs seed, adopt, newer-wins ---------- */
  const fake5 = makeFake();
  window.__sbStub = fake5;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  ls.setItem('cozylibram.warningPrefs.v1', JSON.stringify({ excluded: ['gore'], prominent: ['sa'], detail: 'detailed' }));
  await window.userStatePull();
  const wpSeeded = await window.userStatePush();
  const wpRow = fake5.rows.get('user-1') || {};
  ok('warning prefs seed into their own column',
    wpSeeded === true && !!wpRow.warning_prefs && wpRow.warning_prefs._at > 0 &&
    wpRow.warning_prefs.value.detail === 'detailed' &&
    JSON.stringify(wpRow.warning_prefs.value.excluded) === '["gore"]');
  // second device adopts
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  await window.userStatePull();
  const adoptedPrefs = JSON.parse(ls.getItem('cozylibram.warningPrefs.v1') || 'null');
  ok('warning prefs adopt on a second device',
    !!adoptedPrefs && adoptedPrefs.detail === 'detailed' &&
    JSON.stringify(adoptedPrefs.excluded) === '["gore"]' &&
    JSON.stringify(adoptedPrefs.prominent) === '["sa"]');
  // older server section is ignored; newer applies; settings untouched either way
  const row5 = fake5.rows.get('user-1');
  row5.warning_prefs = { _at: 1, value: { excluded: ['x'], prominent: [], detail: 'gentle' } };
  await window.userStatePull();
  ok('older warning prefs are ignored',
    JSON.parse(ls.getItem('cozylibram.warningPrefs.v1')).detail === 'detailed');
  ls.setItem('theme', 'dark');
  row5.warning_prefs = { _at: Date.now() + 100000, value: { excluded: ['y'], prominent: [], detail: 'gentle' } };
  await window.userStatePull();
  ok('newer warning prefs apply',
    JSON.parse(ls.getItem('cozylibram.warningPrefs.v1')).detail === 'gentle');
  ok('section pull leaves settings keys alone', ls.getItem('theme') === 'dark');

  /* ---------- v520: warning prefs never leak across accounts ---------- */
  const fake6 = makeFake();
  window.__sbStub = fake6;
  clearState();
  setQueue('user-1', []);
  ls.setItem('cozylibram.warningPrefs.v1', JSON.stringify({ excluded: ['gore'], prominent: [], detail: 'gentle' }));
  ls.setItem('cozylibram.userstate.owner', 'user-1'); // device last synced by user-1
  setUser('user-2');
  await window.userStatePull();
  const wpLeak = await window.userStatePush();
  ok('warning prefs: no seed push of another account\'s values',
    wpLeak === false && fake6.upserts.length === 0 && !fake6.rows.has('user-2'));
  ls.setItem('cozylibram.warningPrefs.v1', JSON.stringify({ excluded: ['gore'], prominent: [], detail: 'detailed' }));
  const wpOwn = await window.userStatePush();
  ok('warning prefs: a change under the new account pushes to its own row',
    wpOwn === true && fake6.rows.get('user-2').warning_prefs.value.detail === 'detailed' &&
    !fake6.rows.has('user-1'));

  /* ---------- v520: combined — B HAS a settings row; sections still baselined ---------- */
  // The owner-ordering regression: userStatePull must capture the device
  // owner marker BEFORE the settings pull runs, because applying B's
  // settings claims ownership for B (userStateClaimOwner). Captured after,
  // the marker would read "user-2" here and the sections would be treated
  // as B's own unseeded values — the next push would seed account A's
  // leftover section values into B's row. The cross-account tests above
  // never caught this: their B had no server row at all, so the settings
  // pull never claimed ownership mid-pull.
  const fake10 = makeFake();
  window.__sbStub = fake10;
  fake10.rows.set('user-2', {
    user_id: 'user-2',
    settings: { _at: 5000, values: { theme: 'frost' } }, // B's synced settings; NO sections
  });
  clearState();
  // The device last synced user-1; user-1's section values are still on it.
  ls.setItem('cozylibram.userstate.owner', 'user-1');
  ls.setItem('theme', 'velvet'); // user-1's theme, replaced by B's below
  ls.setItem('cozylibram.warningPrefs.v1', JSON.stringify({ excluded: ['gore'], prominent: ['sa'], detail: 'gentle' }));
  ls.setItem('spicyshelves.auto_releases_seen', '999');
  ls.setItem('spicyshelves.dismissed_releases', JSON.stringify(['user-1-book']));
  setQueue('user-1', ['a1', 'a2']); // user-1's queue still in the collect source
  setUser('user-2');
  const appliedB = await window.userStatePull();
  ok('combined: B\'s server settings apply on sign-in (ownership gets claimed)',
    appliedB === true && ls.getItem('theme') === 'frost' &&
    ls.getItem('cozylibram.userstate.owner') === 'user-2');
  const metaB = JSON.parse(ls.getItem('cozylibram.userstate.v1.user-2') || 'null');
  ok('combined: sections baselined against the PRE-pull owner, not left as B\'s to seed',
    !!metaB && !!metaB.sections &&
    metaB.sections.warning.hash === window.userStateHash(window.userStateCollectWarning()) &&
    metaB.sections.upnext.hash === window.userStateHash(window.userStateCollectUpNext()) &&
    metaB.sections.release.hash === window.userStateHash(window.userStateCollectRelease()));
  const leakPushB = await window.userStatePush();
  const rowB = fake10.rows.get('user-2') || {};
  ok('combined: no push writes user-1\'s section values into B\'s row',
    leakPushB === false && fake10.upserts.length === 0 &&
    !('warning_prefs' in rowB) && !('up_next' in rowB) && !('release_state' in rowB));
  // And a change B actually makes still pushes — B is not wedged.
  ls.setItem('cozylibram.warningPrefs.v1', JSON.stringify({ excluded: [], prominent: [], detail: 'detailed' }));
  const ownPushB = await window.userStatePush();
  ok('combined: B\'s own later section change pushes to B\'s row only',
    ownPushB === true && fake10.rows.get('user-2').warning_prefs.value.detail === 'detailed' &&
    !fake10.rows.has('user-1'));

  /* ---------- v520: Up Next queue roams, keyed per account ---------- */
  const fake7 = makeFake();
  window.__sbStub = fake7;
  clearState();
  setUser('user-1');
  setQueue('user-1', ['b1', 'b2']);
  await window.userStatePull();
  const unSeeded = await window.userStatePush();
  const unRow = fake7.rows.get('user-1') || {};
  ok('up next seeds the account queue array as-is',
    unSeeded === true && !!unRow.up_next && unRow.up_next._at > 0 &&
    JSON.stringify(unRow.up_next.value) === '["b1","b2"]');
  // second device adopts into memory + the per-uid localStorage key
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  await window.userStatePull();
  ok('up next adopts on a second device (memory + per-uid key)',
    JSON.stringify(probeQueue()) === '["b1","b2"]' &&
    ls.getItem('spicyshelves.upnext.v1.user-1') === '["b1","b2"]');
  // a second account on this device never receives the first account's queue
  setQueue('user-2', []);
  setUser('user-2');
  await window.userStatePull();
  const unLeak = await window.userStatePush();
  ok('up next: no seed push of another account\'s queue',
    unLeak === false && !fake7.rows.has('user-2'));
  setQueue('user-2', ['b7']);
  const unOwn = await window.userStatePush();
  ok('up next: the new account\'s own queue pushes to its own row',
    unOwn === true && JSON.stringify(fake7.rows.get('user-2').up_next.value) === '["b7"]' &&
    JSON.stringify(fake7.rows.get('user-1').up_next.value) === '["b1","b2"]');

  /* ---------- v520: release state roams as one section ---------- */
  const fake8 = makeFake();
  window.__sbStub = fake8;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  ls.setItem('spicyshelves.auto_releases', JSON.stringify({ at: 111, list: [{ id: 'x' }] }));
  ls.setItem('spicyshelves.auto_releases_seen', '222');
  ls.setItem('spicyshelves.dismissed_releases', JSON.stringify(['hc1']));
  await window.userStatePull();
  const relSeeded = await window.userStatePush();
  const relRow = fake8.rows.get('user-1') || {};
  ok('release state seeds all three keys as one section',
    relSeeded === true && !!relRow.release_state && relRow.release_state._at > 0 &&
    relRow.release_state.values['spicyshelves.auto_releases_seen'] === '222' &&
    relRow.release_state.values['spicyshelves.dismissed_releases'] === '["hc1"]' &&
    JSON.parse(relRow.release_state.values['spicyshelves.auto_releases']).list[0].id === 'x');
  // second device adopts
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  await window.userStatePull();
  ok('release state adopts on a second device',
    ls.getItem('spicyshelves.auto_releases_seen') === '222' &&
    ls.getItem('spicyshelves.dismissed_releases') === '["hc1"]' &&
    JSON.parse(ls.getItem('spicyshelves.auto_releases')).list[0].id === 'x');
  // a key dropped from a newer snapshot is removed locally (full-snapshot apply)
  const row8 = fake8.rows.get('user-1');
  row8.release_state = { _at: Date.now() + 100000, values: { 'spicyshelves.auto_releases': '{"at":333,"list":[]}' } };
  await window.userStatePull();
  ok('release state: keys absent from a newer snapshot are removed',
    ls.getItem('spicyshelves.auto_releases_seen') === null &&
    ls.getItem('spicyshelves.dismissed_releases') === null &&
    JSON.parse(ls.getItem('spicyshelves.auto_releases')).at === 333);

  /* ---------- v520: pre-migration database fails open ---------- */
  const fake9 = makeFake();
  fake9.missingColumns = true;
  window.__sbStub = fake9;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  ls.setItem('theme', 'dark');
  ls.setItem('cozylibram.warningPrefs.v1', JSON.stringify({ excluded: ['gore'], prominent: [], detail: 'gentle' }));
  let threw9 = false, pull9 = null;
  try { pull9 = await window.userStatePull(); } catch (e) { threw9 = true; }
  ok('missing section columns: pull fails open, local state untouched',
    !threw9 && pull9 === false && ls.getItem('theme') === 'dark' &&
    JSON.parse(ls.getItem('cozylibram.warningPrefs.v1')).detail === 'gentle');
  const push9 = await window.userStatePush();
  const row9 = fake9.rows.get('user-1') || {};
  ok('missing section columns: settings still push; sections simply stay local',
    push9 === true && !!row9.settings && row9.settings.values.theme === 'dark' &&
    !('warning_prefs' in row9));
  row9.settings = { _at: Date.now() + 100000, values: { theme: 'velvet' } };
  const pull9b = await window.userStatePull();
  ok('missing section columns: settings pull still applies',
    pull9b === true && ls.getItem('theme') === 'velvet');

  /* ---------- v521: shelf state seeds, adopts, newer wins ---------- */
  const fakeS1 = makeFake();
  window.__sbStub = fakeS1;
  clearState();
  setUser('user-1');
  setQueue('user-1', []); // localUid = user-1 (the shelforder partition)
  const orderDoc1 = {
    layout: 'series', format: 'compact', season: 'spring',
    tbr: ['b2', 'b1'], reading: ['b7'],
    decor: { tbr: [{ d: 'plant', at: 1 }, { d: 'candle', at: 3 }] },
  };
  const decoDoc1 = JSON.stringify({ v: 2, cases: {
    'tbr:0': [{ type: 'plant', pi: 0, x: 1.5, z: -0.25, room: false }],
    'read:1': [{ type: 'mug', pi: 2, x: -2, z: 0.5, room: false }],
  } });
  setShelfDoc(orderDoc1);
  ls.setItem('cozylibram.s3d.deco.v2', decoDoc1);
  ls.setItem('cozylibram.s3d.dressed.v1', 'velvet');
  ls.setItem('cozylibram.s3d.arrange', 'colour');
  ls.setItem('cozylibram.s3d.spines', 'classic');
  ls.setItem('shelfViewMode', '2d');
  await window.userStatePull();
  const shelfSeeded = await window.userStatePush();
  const shelfRow = fakeS1.rows.get('user-1') || {};
  ok('shelf state seeds into its own column',
    shelfSeeded === true && !!shelfRow.shelf_state && shelfRow.shelf_state._at > 0);
  ok('shelf seed carries every piece',
    !!shelfRow.shelf_state &&
    canon(JSON.parse(shelfRow.shelf_state.values.order)) === canon(orderDoc1) &&
    shelfRow.shelf_state.values.deco === decoDoc1 &&
    shelfRow.shelf_state.values.dressed === 'velvet' &&
    shelfRow.shelf_state.values.arrange === 'colour' &&
    shelfRow.shelf_state.values.spines === 'classic' &&
    shelfRow.shelf_state.values.viewmode === '2d');
  // second device adopts: order doc lands via the app write path, the
  // localStorage pieces land as raw strings
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  await window.userStatePull();
  ok('shelf state adopts on a second device (order doc via saveShelfOrder + cache)',
    canon(probeShelfDoc()) === canon(orderDoc1) &&
    ls.getItem('spicyshelves.shelforder.v1.user-1') === JSON.stringify(orderDoc1));
  ok('shelf state adopts on a second device (localStorage pieces)',
    ls.getItem('cozylibram.s3d.deco.v2') === decoDoc1 &&
    ls.getItem('cozylibram.s3d.dressed.v1') === 'velvet' &&
    ls.getItem('cozylibram.s3d.arrange') === 'colour' &&
    ls.getItem('cozylibram.s3d.spines') === 'classic' &&
    ls.getItem('shelfViewMode') === '2d');
  const shelfNoop = await window.userStatePush();
  ok('adopted shelf state does not push back', shelfNoop === false);
  // older server section is ignored
  const rowS1 = fakeS1.rows.get('user-1');
  rowS1.shelf_state = { _at: 1, values: { viewmode: '3d' } };
  await window.userStatePull();
  ok('older shelf state is ignored', ls.getItem('shelfViewMode') === '2d');
  // newer applies with full-snapshot semantics: pieces absent from the
  // newer snapshot are cleared locally
  const orderDoc2 = { layout: 'manual', tbr: ['b9'] };
  rowS1.shelf_state = { _at: Date.now() + 100000, values: {
    order: JSON.stringify(orderDoc2), viewmode: '3d',
  } };
  await window.userStatePull();
  ok('newer shelf state applies; absent pieces are cleared',
    canon(probeShelfDoc()) === canon(orderDoc2) &&
    ls.getItem('shelfViewMode') === '3d' &&
    ls.getItem('cozylibram.s3d.deco.v2') === null &&
    ls.getItem('cozylibram.s3d.dressed.v1') === null &&
    ls.getItem('cozylibram.s3d.arrange') === null &&
    ls.getItem('cozylibram.s3d.spines') === null);
  // a malformed deco piece never wipes good local decorations, while
  // the well-formed pieces of the same snapshot still apply
  ls.setItem('cozylibram.s3d.deco.v2', decoDoc1);
  rowS1.shelf_state = { _at: Date.now() + 200000, values: {
    order: JSON.stringify(orderDoc2),
    deco: '{"v":1,"decorations":[]}',
    viewmode: '2d',
  } };
  await window.userStatePull();
  ok('malformed deco piece is ignored; sibling pieces still apply',
    ls.getItem('cozylibram.s3d.deco.v2') === decoDoc1 &&
    ls.getItem('shelfViewMode') === '2d');

  /* ---------- v521: shelf state never leaks across accounts ---------- */
  const fakeS2 = makeFake();
  window.__sbStub = fakeS2;
  clearState();
  setQueue('user-1', []);
  setShelfDoc(orderDoc1);
  ls.setItem('cozylibram.s3d.deco.v2', decoDoc1);
  ls.setItem('shelfViewMode', '2d');
  ls.setItem('cozylibram.userstate.owner', 'user-1'); // device last synced by user-1
  setUser('user-2');
  await window.userStatePull();
  const shelfLeak = await window.userStatePush();
  ok('shelf state: no seed push of another account\'s values',
    shelfLeak === false && fakeS2.upserts.length === 0 && !fakeS2.rows.has('user-2'));
  ls.setItem('shelfViewMode', '3d'); // a change made under user-2
  const shelfOwn = await window.userStatePush();
  ok('shelf state: a change under the new account pushes to its own row only',
    shelfOwn === true && !!fakeS2.rows.get('user-2') &&
    fakeS2.rows.get('user-2').shelf_state.values.viewmode === '3d' &&
    !fakeS2.rows.has('user-1'));

  /* ---------- v521: large shelf payload round-trips ---------- */
  const fakeS3 = makeFake();
  window.__sbStub = fakeS3;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  const bigOrder = { layout: 'manual', format: 'standard', season: 'spring',
    decor: { tbr: [{ d: 'plant', at: 5 }, { d: 'candle', at: 9 }] } };
  for (const g of ['tbr', 'reading', 'read']) {
    bigOrder[g] = [];
    for (let i = 0; i < 300; i++) bigOrder[g].push('bk-' + g + '-' + i);
  }
  const bigDecoDoc = { v: 2, cases: {} };
  for (let c = 0; c < 24; c++) {
    const list = [];
    for (let i = 0; i < 12; i++) list.push({ type: 'plant', pi: i, x: 1.25 + i, z: -0.5, room: false });
    bigDecoDoc.cases['read:' + c] = list;
  }
  const bigDeco = JSON.stringify(bigDecoDoc);
  setShelfDoc(bigOrder);
  ls.setItem('cozylibram.s3d.deco.v2', bigDeco);
  ls.setItem('shelfViewMode', '3d');
  await window.userStatePull();
  const bigSeeded = await window.userStatePush();
  const bigRow = fakeS3.rows.get('user-1') || {};
  const bigPayloadBytes = bigRow.shelf_state ? JSON.stringify(bigRow.shelf_state).length : 0;
  ok('large shelf payload seeds (order 900 ids + 24 cases x 12 decorations)',
    bigSeeded === true && bigPayloadBytes > 20000);
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  await window.userStatePull();
  ok('large shelf payload adopts intact on a second device',
    canon(probeShelfDoc()) === canon(bigOrder) &&
    ls.getItem('cozylibram.s3d.deco.v2') === bigDeco &&
    ls.getItem('shelfViewMode') === '3d');
  const bigNoop = await window.userStatePush();
  ok('large adopted payload is hash-stable (no push-back)', bigNoop === false);

  /* ---------- v521: pre-migration database fails open for shelf ---------- */
  const fakeS4 = makeFake();
  fakeS4.missingColumns = true;
  window.__sbStub = fakeS4;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  ls.setItem('theme', 'dark');
  setShelfDoc(orderDoc1);
  ls.setItem('cozylibram.s3d.deco.v2', decoDoc1);
  let threwS4 = false, pullS4 = null;
  try { pullS4 = await window.userStatePull(); } catch (e) { threwS4 = true; }
  ok('missing shelf column: pull fails open, local shelf state untouched',
    !threwS4 && pullS4 === false &&
    canon(probeShelfDoc()) === canon(orderDoc1) &&
    ls.getItem('cozylibram.s3d.deco.v2') === decoDoc1);
  const pushS4 = await window.userStatePush();
  const rowS4 = fakeS4.rows.get('user-1') || {};
  ok('missing shelf column: settings still push; shelf simply stays local',
    pushS4 === true && !!rowS4.settings && rowS4.settings.values.theme === 'dark' &&
    !('shelf_state' in rowS4) &&
    canon(probeShelfDoc()) === canon(orderDoc1));

  /* ---------- v537: prefs seed, adopt, toggle-push ---------- */
  const fakeP = makeFake();
  window.__sbStub = fakeP;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  // Device 1: the reader opts out (js/180's toggle writes via
  // setAnalyticsEnabled, js/065) and shows the log-remove entry button.
  runInWindow('setAnalyticsEnabled(false);');
  ls.setItem('spicyshelves.logremove', 'on');
  await window.userStatePull();
  const prefsSeeded = await window.userStatePush();
  const prefsRow = fakeP.rows.get('user-1') || {};
  ok('prefs seed into their own column (analytics opt-out + logremove)',
    prefsSeeded === true && !!prefsRow.prefs_state && prefsRow.prefs_state._at > 0 &&
    prefsRow.prefs_state.values['spicyshelves.analytics'] === '0' &&
    prefsRow.prefs_state.values['spicyshelves.logremove'] === 'on');
  // Device 2: fresh local state adopts the opt-out, and it applies live.
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  ok('second device starts with analytics enabled (no local opt-out)',
    window.eval('analyticsEnabled()') === true);
  await window.userStatePull();
  ok('prefs adopt on a second device (the opt-out roams)',
    ls.getItem('spicyshelves.analytics') === '0' && ls.getItem('spicyshelves.logremove') === 'on');
  ok('adopted opt-out applies live (analyticsEnabled flips, no reload)',
    window.eval('analyticsEnabled()') === false);
  const prefsNoop = await window.userStatePush();
  ok('adopted prefs are hash-stable (no push-back)', prefsNoop === false);
  // Toggling back on this device pushes the new value via the section.
  runInWindow('setAnalyticsEnabled(true);');
  const prefsToggled = await window.userStatePush();
  ok('opting back in pushes through the prefs section',
    prefsToggled === true &&
    (fakeP.rows.get('user-1') || {}).prefs_state.values['spicyshelves.analytics'] === '1');

  /* ---------- v537: pre-migration database fails open for prefs ---------- */
  const fakeP2 = makeFake();
  fakeP2.missingColumns = true;
  window.__sbStub = fakeP2;
  clearState();
  setUser('user-1');
  setQueue('user-1', []);
  ls.setItem('theme', 'dark');
  runInWindow('setAnalyticsEnabled(false);');
  let threwP = false, pullP = null;
  try { pullP = await window.userStatePull(); } catch (e) { threwP = true; }
  ok('missing prefs column: pull fails open, local opt-out untouched',
    !threwP && pullP === false && ls.getItem('spicyshelves.analytics') === '0');
  const pushP = await window.userStatePush();
  const rowP = fakeP2.rows.get('user-1') || {};
  ok('missing prefs column: settings still push; prefs simply stay local',
    pushP === true && !!rowP.settings && !('prefs_state' in rowP) &&
    window.eval('analyticsEnabled()') === false);
  runInWindow('setAnalyticsEnabled(true);');

  /* ---------- v575 reco migration shape ---------- */
  const sql575Path = path.join(ROOT, 'supabase/migrations/v575_user_state_reco.sql');
  ok('v575 migration file exists', fs.existsSync(sql575Path));
  const sql575 = fs.readFileSync(sql575Path, 'utf8');
  ok('v575 adds reco_state jsonb with {} default',
    /add column if not exists reco_state jsonb not null default '\{\}'::jsonb/.test(sql575));
  ok('v575 migration touches only user_state (no policies, no other tables)',
    !/create policy|drop policy|create table/.test(sql575) && !/alter table (public\.)?profiles/.test(sql575));
  runInWindow('window.__probeRecoCol = USER_STATE_SECTION_COLS.reco;' +
    ' window.__probeRecoFns = typeof USER_STATE_SECTION_FNS.reco.collect === "function" &&' +
    ' typeof USER_STATE_SECTION_FNS.reco.apply === "function";');
  ok('reco section is registered (column reco_state, collect+apply wired)',
    window.__probeRecoCol === 'reco_state' && window.__probeRecoFns === true);
  runInWindow('window.__probeKeys = USER_STATE_KEYS.slice();');
  ok('settings key list stays frozen (no reco key in USER_STATE_KEYS)',
    !window.__probeKeys.includes('reco_dismissed') &&
    !('spicyshelves.reco_dismissed' in window.userStateCollect()));

  /* ---------- v575 reco section: collect / union-apply units ---------- */
  clearState();
  ok('reco collect is empty when nothing was dismissed',
    JSON.stringify(window.userStateCollectReco()) === '{"value":[]}');
  await window.recoDismiss('hc:1');
  await window.recoDismiss('hc:2');
  ok('reco collect reads the local dismissal set',
    JSON.stringify(window.userStateCollectReco().value) === '["hc:1","hc:2"]');
  const recoExtras1 = window.userStateApplyReco({ value: ['hc:2', 'hc:3'] });
  ok('reco apply unions the roamed set into the local store',
    setEq(await probeDismissals(), ['hc:1', 'hc:2', 'hc:3']));
  ok('reco apply reports local extras (a push is owed so the union propagates)',
    recoExtras1 === true);
  const recoExtras2 = window.userStateApplyReco({ value: ['hc:1', 'hc:2', 'hc:3', 'hc:9'] });
  ok('reco apply adopts server-only keys',
    setEq(await probeDismissals(), ['hc:1', 'hc:2', 'hc:3', 'hc:9']));
  ok('reco apply with a superset payload reports no local extras',
    recoExtras2 === false);
  // Cap after merge: 150 local + 150 disjoint roamed keys union to 300;
  // the merged set keeps the newest 200 (local tail, then roamed keys).
  clearState();
  await window.recoDismissedSet(); // fresh session: mirror re-reads the (empty) store
  const bigA = []; for (let i = 0; i < 150; i++) bigA.push('hc:a' + i);
  const bigB = []; for (let i = 0; i < 150; i++) bigB.push('hc:b' + i);
  window.recoMergeRoamedDismissals(bigA); // seed the local store via the write path
  window.userStateApplyReco({ value: bigB });
  const capped = await probeDismissals();
  ok('reco merge caps at 200 after merging, keeping the tail',
    capped.length === 200 && capped[0] === 'hc:a100' &&
    capped[capped.length - 1] === 'hc:b149' && !capped.includes('hc:a99'));

  /* ---------- v575 reco: first push seeds from the local set ---------- */
  const fakeR1 = makeFake();
  window.__sbStub = fakeR1;
  clearState();
  setUser('user-1');
  await window.recoDismiss('hc:a1');
  await window.recoDismiss('hc:a2');
  await window.userStatePull();
  const recoSeeded = await window.userStatePush();
  const recoRow1 = fakeR1.rows.get('user-1') || {};
  ok('reco seed push carries the existing local dismissals (never an empty array)',
    recoSeeded === true && !!recoRow1.reco_state && recoRow1.reco_state._at > 0 &&
    setEq(recoRow1.reco_state.value, ['hc:a1', 'hc:a2']));

  /* ---------- v575 reco: two-device union merge ---------- */
  // Device B: fresh local state, one dismissal made before its first
  // pull (offline). The pull must union, not overwrite; B's push must
  // carry the union up; A then adopts B's dismissal on its next pull.
  clearState();
  setUser('user-1');
  await window.recoDismiss('hc:b1');
  await window.userStatePull();
  ok('two-device: pull unions the server set into the local store (nothing lost)',
    setEq(await probeDismissals(), ['hc:a1', 'hc:a2', 'hc:b1']));
  const recoUnionPush = await window.userStatePush();
  ok('two-device: the union pushes back up',
    recoUnionPush === true &&
    setEq((fakeR1.rows.get('user-1') || {}).reco_state.value, ['hc:a1', 'hc:a2', 'hc:b1']));
  // Device A returns (fresh local copy of its own two dismissals):
  clearState();
  setUser('user-1');
  await window.recoDismiss('hc:a1');
  await window.recoDismiss('hc:a2');
  await window.userStatePull();
  ok('two-device: the first device adopts the other device\'s dismissal',
    setEq(await probeDismissals(), ['hc:a1', 'hc:a2', 'hc:b1']));
  await window.recoDismiss('hc:a1'); // re-dismiss an already-roamed key
  ok('two-device: overlap dedupes (re-dismissing a roamed key changes nothing)',
    (await probeDismissals()).length === 3);

  /* ---------- v575 reco: a stale device's push cannot drop newer dismissals ---------- */
  // This device last synced when the server held the same single local
  // dismissal; since then another device pushed two more. This device
  // dismisses one of its own and pushes — the push must read-merge the
  // server set so the other device's dismissals survive and are adopted.
  const fakeR2 = makeFake();
  window.__sbStub = fakeR2;
  clearState();
  setUser('user-1');
  await window.recoDismiss('hc:l1');
  fakeR2.rows.set('user-1', {
    user_id: 'user-1',
    settings: { _at: 5000, values: {} },
    reco_state: { _at: 5000, value: ['hc:s1', 'hc:s2'] },
  });
  runInWindow("userStatePatchMeta('user-1', { at: 5000," +
    ' hash: userStateHash(userStateCollect()),' +
    ' sections: { reco: { at: 5000, hash: userStateHash(userStateCollectReco()) } } });');
  await window.recoDismiss('hc:l2');
  const stalePush = await window.userStatePush();
  const recoRow2 = fakeR2.rows.get('user-1') || {};
  ok('stale push read-merges: the other device\'s dismissals survive',
    stalePush === true && !!recoRow2.reco_state &&
    setEq(recoRow2.reco_state.value, ['hc:l1', 'hc:l2', 'hc:s1', 'hc:s2']));
  ok('stale push adopts the server dismissals locally',
    setEq(await probeDismissals(), ['hc:l1', 'hc:l2', 'hc:s1', 'hc:s2']));

  /* ---------- v575: pre-migration database fails open for reco ---------- */
  const fakeR3 = makeFake();
  fakeR3.missingColumns = true;
  window.__sbStub = fakeR3;
  clearState();
  setUser('user-1');
  await window.recoDismiss('hc:keep');
  let threwR = false, pullR = null;
  try { pullR = await window.userStatePull(); } catch (e) { threwR = true; }
  ok('missing reco column: pull fails open, local dismissals untouched',
    !threwR && pullR === false && setEq(await probeDismissals(), ['hc:keep']));
  const pushR = await window.userStatePush();
  const rowR3 = fakeR3.rows.get('user-1') || {};
  ok('missing reco column: settings still push; dismissals simply stay local',
    pushR === true && !!rowR3.settings && !('reco_state' in rowR3) &&
    setEq(await probeDismissals(), ['hc:keep']));

  /* ---------- v575 reco: a failed push re-read skips the column, retries next cycle ---------- */
  // The server gains a dismissal from another device after this device's
  // last pull. This device's push then cannot re-read reco_state (the
  // read errors): it must NOT upsert its local-only set over the server
  // copy. The reco column is skipped, the section bookkeeping stays
  // un-advanced, and the next healthy push completes the union.
  const fakeR4 = makeFake();
  window.__sbStub = fakeR4;
  clearState();
  setUser('user-1');
  fakeR4.rows.set('user-1', {
    user_id: 'user-1',
    settings: { _at: 5000, values: {} },
    reco_state: { _at: 5000, value: ['hc:s1'] },
  });
  await window.recoDismiss('hc:l1');
  await window.userStatePull(); // establish meta; union [l1, s1] locally, reco owes a push
  // Another device dismisses hc:s2 and syncs it after our pull.
  fakeR4.rows.get('user-1').reco_state = { _at: 6000, value: ['hc:s1', 'hc:s2'] };
  await window.recoDismiss('hc:l2');
  const upsertsBeforeR4 = fakeR4.upserts.length;
  fakeR4.failSelect = true;
  await window.userStatePush();
  fakeR4.failSelect = false;
  const rowR4 = fakeR4.rows.get('user-1') || {};
  ok('reco re-read error: the server copy is not overwritten',
    !!rowR4.reco_state && setEq(rowR4.reco_state.value, ['hc:s1', 'hc:s2']));
  ok('reco re-read error: no upsert in that push carried reco_state',
    fakeR4.upserts.slice(upsertsBeforeR4).every(r => !('reco_state' in r)));
  ok('reco re-read error: the local dismissal set is untouched',
    setEq(await probeDismissals(), ['hc:l1', 'hc:s1', 'hc:l2']));
  const metaR4 = JSON.parse(ls.getItem('cozylibram.userstate.v1.user-1') || 'null');
  ok('reco re-read error: the section bookkeeping stays un-advanced',
    !!metaR4 && !!metaR4.sections && !!metaR4.sections.reco && metaR4.sections.reco.hash === null);
  const retryPushR4 = await window.userStatePush();
  const rowR4b = fakeR4.rows.get('user-1') || {};
  ok('next healthy push completes the union on the server',
    retryPushR4 === true && !!rowR4b.reco_state &&
    setEq(rowR4b.reco_state.value, ['hc:l1', 'hc:s1', 'hc:l2', 'hc:s2']));
  ok('next healthy push adopts the server-only dismissal locally',
    setEq(await probeDismissals(), ['hc:l1', 'hc:s1', 'hc:l2', 'hc:s2']));
  ok('after the retry the reco section is clean (a further push is a no-op)',
    (await window.userStatePush()) === false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
