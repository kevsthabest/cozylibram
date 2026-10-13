// Roaming settings (v518): user_state migration shape + js/229-user-state.js
// sync behavior against a mocked Supabase client — newer-pull applies,
// older-pull ignored, push is hash-gated, seeding order (pull before push),
// cross-account baseline, offline fail-open.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
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
  const fake = {
    rows: new Map(), // user_id -> { user_id, settings, updated_at }
    upserts: [],
    failSelect: false,
    throwFrom: false,
    from(table) {
      if (table !== 'user_state') throw new Error('unexpected table: ' + table);
      if (fake.throwFrom) throw new Error('client exploded');
      return {
        select() {
          const filters = {};
          const b = {
            eq(col, val) { filters[col] = val; return b; },
            maybeSingle: async () => {
              if (fake.failSelect) return { data: null, error: new Error('network down') };
              const row = fake.rows.get(filters.user_id) || null;
              return { data: row ? { settings: row.settings } : null, error: null };
            },
          };
          return b;
        },
        upsert: async (row) => {
          fake.upserts.push(row);
          fake.rows.set(row.user_id, Object.assign({}, row));
          return { error: null };
        },
      };
    },
  };
  return fake;
}

// Wipe every key the module can touch (in-scope settings + bookkeeping),
// simulating a fresh device or a new scenario.
function clearState() {
  const doomed = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && (k.indexOf('cozylibram.userstate') === 0 ||
      ['theme', 'accent', 'spicyshelves.animation', 'spicyshelves.favstyle',
        'pshareStyle', 'portraitShareV1', 'cozylibram.tagline', 'cl_hide_spoilers',
        'cozylibram.dnaSurveyOff', 'cozylibram.dnaNudgesOff', 'spicyshelves.onboarded',
        'spicyshelves.storeRegion', 'spicyshelves.sortby', 'spicyshelves.seriesfilter'].includes(k) ||
      k.indexOf('seasonThemeNudge:') === 0 || k.indexOf('wrapped-banner-') === 0)) doomed.push(k);
  }
  doomed.forEach(k => ls.removeItem(k));
}
const setUser = (id) => runInWindow("cloudUser = { id: '" + id + "', email: 'u@example.com' };");

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
  ok('version pairing is v518',
    /APP_VERSION = 'v518'/.test(fs.readFileSync(path.join(ROOT, 'js/181-appversion.js'), 'utf8')) &&
    swText.includes("cozy-libram-v518"));

  /* ---------- collect: scope is exact ---------- */
  clearState();
  ls.setItem('theme', 'dark');
  ls.setItem('spicyshelves.storeRegion', 'ca');
  ls.setItem('seasonThemeNudge:halloween', '1');
  ls.setItem('wrapped-banner-2026', 'x');
  ls.setItem('spicyshelves.sortby', 'title');       // roams (User override)
  ls.setItem('spicyshelves.seriesfilter', 'all');   // roams (User override)
  ls.setItem('shelfViewMode', 'grid');              // stays local (shelf state, follow-on)
  ls.setItem('spicyshelves.setgroups', '{}');       // stays local (navigation transient)
  const collected = window.userStateCollect();
  ok('collect includes core keys', collected.theme === 'dark');
  ok('collect includes storeRegion (User override)', collected['spicyshelves.storeRegion'] === 'ca');
  ok('collect includes sort + series filter (User override)',
    collected['spicyshelves.sortby'] === 'title' && collected['spicyshelves.seriesfilter'] === 'all');
  ok('collect includes prefix families',
    collected['seasonThemeNudge:halloween'] === '1' && collected['wrapped-banner-2026'] === 'x');
  ok('collect excludes shelf-state + navigation transients',
    !('shelfViewMode' in collected) && !('spicyshelves.setgroups' in collected));

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

  /* ---------- pull ignores older server state ---------- */
  fake.rows.set('user-1', {
    user_id: 'user-1',
    settings: { _at: 4000, values: { theme: 'frost' } },
  });
  const appliedOlder = await window.userStatePull();
  ok('older pull is ignored', appliedOlder === false && ls.getItem('theme') === 'velvet');

  /* ---------- push is hash-gated ---------- */
  const pushed0 = await window.userStatePush();
  ok('push with unchanged snapshot is a no-op', pushed0 === false && fake.upserts.length === 0);
  ls.setItem('theme', 'frost');
  const pushed1 = await window.userStatePush();
  ok('push fires on value change', pushed1 === true && fake.upserts.length === 1);
  ok('push upserts own row with fresh _at',
    fake.upserts[0].user_id === 'user-1' &&
    fake.upserts[0].settings.values.theme === 'frost' &&
    fake.upserts[0].settings._at > 5000);
  const pushed2 = await window.userStatePush();
  ok('second push without change is a no-op', pushed2 === false && fake.upserts.length === 1);

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
    seeded === true && fake2.rows.get('user-1').settings.values.theme === 'hearthside');

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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
