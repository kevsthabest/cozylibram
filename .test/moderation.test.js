// User moderation (v246): abuse reports from the coven tab, ban enforcement
// on sign-in, and the Observatory moderation cards.
//
// Covered: migration SQL shape (tables, RLS policies, self-report guard),
// report buttons on friend/request rows, the report sheet submit path,
// isBannedUser, the enterApp ban branch (sign-out + gate notice), and the
// pure moderationHTML cards. The API-side ban check and the admin-users
// function are covered in pages-functions.test.js.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in moderation tests'); };
window.confirm = () => true;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

// ---- stub supabase client ----
const db = { user_reports: [], banned_users: [] };
const tableStub = (name) => ({
  select() {
    const qq = { _conds: [],
      eq(c, v) { qq._conds.push([c, v]); return qq; },
      order() { return qq; },
      limit() { return qq; },
      maybeSingle() {
        const r = db[name].find(x => qq._conds.every(([c, v]) => x[c] === v));
        return Promise.resolve({ data: r || null, error: null });
      },
      then(res) { res({ data: db[name].filter(x => qq._conds.every(([c, v]) => x[c] === v)), error: null }); },
    };
    return qq;
  },
  insert(row) { db[name].push(Object.assign({ id: 'r' + db[name].length }, row)); return Promise.resolve({ error: null }); },
  update() { return Promise.resolve({ error: null }); },
  delete() { return { eq: () => Promise.resolve({ error: null }) }; },
});
window.__stubClient = { from: (t) => tableStub(t) };

(async () => {
  /* ---- 1. migration SQL shape ---- */
  const sql = fs.readFileSync(ROOT + '/supabase/migrations/v246_user_reports_and_bans.sql', 'utf8');
  ok('sql: user_reports table created', /create table if not exists user_reports/.test(sql));
  ok('sql: banned_users table created', /create table if not exists banned_users/.test(sql));
  ok('sql: reason enum check', /reason in \('spam', 'harassment', 'inappropriate', 'fake_account', 'other'\)/.test(sql));
  ok('sql: no self-reports', /reporter_id <> reported_user_id/.test(sql));
  ok('sql: users file only their own reports', /on user_reports for insert[\s\S]*?with check \(auth\.uid\(\) = reporter_id\)/.test(sql));
  ok('sql: admins manage reports', /on user_reports for all[\s\S]*?using \(is_admin\(\)\)/.test(sql));
  ok('sql: users see only their own ban row', /on banned_users for select[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(sql));
  ok('sql: admins manage bans', /on banned_users for all[\s\S]*?using \(is_admin\(\)\)/.test(sql));

  /* ---- 2. report buttons on coven rows ---- */
  run('cloudUser = { id: "me", email: "me@x.y" };');
  run('cloudClient = async () => window.__stubClient;');
  run(`ensureInviteCode = async () => 'testcode123';`);
  run(`circlePrivacy = async () => ({ share: true, hidden: [] });`);
  run(`refreshRecos = () => {}; refreshCovenStats = () => {};`);
  run(`renderCovenProposals = () => {}; consumePendingInvite = () => {};`);
  run(`circleLists = async () => ({
    received: [{ id: 'spammer', profile: { user_id: 'spammer', first_name: 'Spam', last_name: 'Mer', avatar_id: '', avatar_path: '' }, name: 'Spammer' }],
    sent: [],
    friends: [{ id: 'buddy', profile: { user_id: 'buddy', first_name: 'Bud', last_name: 'Dy', avatar_id: '', avatar_path: '' }, name: 'Buddy' }],
  });`);
  await run('renderCoven()'); await tick(5);
  const reportBtns = window.document.querySelectorAll('[data-report]');
  ok('report buttons render on request + friend rows',
    reportBtns.length === 2 &&
    reportBtns[0].dataset.report === 'spammer' &&
    reportBtns[1].dataset.report === 'buddy');

  /* ---- 3. report sheet submit path ---- */
  reportBtns[0].click(); await tick(2);
  ok('report sheet opens', !!q('#rp-reason') && !!q('#rp-send'));
  ok('report sheet lists the reason options',
    q('#rp-reason').options.length === 5 && q('#rp-reason').options[0].value === 'spam');
  q('#rp-reason').value = 'harassment';
  q('#rp-details').value = 'nasty messages';
  q('#rp-send').click(); await tick(5);
  ok('submit inserts one report', db.user_reports.length === 1);
  ok('report carries reporter/reported/reason/details',
    db.user_reports[0].reporter_id === 'me' &&
    db.user_reports[0].reported_user_id === 'spammer' &&
    db.user_reports[0].reason === 'harassment' &&
    db.user_reports[0].details === 'nasty messages');
  ok('sheet closes after submit', !q('#rp-send'));

  /* ---- 4. isBannedUser ---- */
  db.banned_users.push({ user_id: 'badguy', reason: 'x', banned_at: '2026-10-03T00:00:00Z' });
  ok('isBannedUser true for a banned id', await run('isBannedUser("badguy")') === true);
  ok('isBannedUser false for a clean id', await run('isBannedUser("me")') === false);

  /* ---- 5. enterApp ban branch ---- */
  run('cloudSignOut = async () => { window.__signedOut = (window.__signedOut || 0) + 1; };');
  run('gateEnteredUid = null; gateNotice = null; window.__signedOut = 0;');
  await run('enterApp({ id: "badguy" })'); await tick(2);
  ok('banned sign-in triggers sign-out', run('window.__signedOut') === 1);
  ok('banned sign-in sets the gate notice', run('gateNotice') === 'This account has been suspended.');
  ok('banned sign-in resets the entered uid', run('gateEnteredUid') === null);

  /* ---- 6. moderationHTML cards (pure) ---- */
  const mod = {
    reports: [{
      id: 'rep1', reporter_id: 'reporter-uuid-1', reported_user_id: 'reported-uuid-2',
      reason: 'spam', details: 'junk links', created_at: '2026-10-03T01:00:00Z',
    }],
    banned: [{ user_id: 'banned-uuid-9', reason: 'manual ban from Observatory', banned_at: '2026-10-03T02:00:00Z' }],
    bannedById: { 'banned-uuid-9': true },
  };
  const cards = run('moderationHTML(' + JSON.stringify(mod) + ')');
  ok('reports card shows the reported user (truncated)', cards.indexOf('reported') !== -1);
  ok('reports card labels the reason', cards.indexOf('Spam') !== -1);
  ok('reports card has Ban + Dismiss actions',
    cards.indexOf('data-mod-report-ban="rep1"') !== -1 && cards.indexOf('data-mod-dismiss="rep1"') !== -1);
  ok('banned card lists the banned user with Unban + Delete',
    cards.indexOf('data-mod-unban="banned-uuid-9"') !== -1 && cards.indexOf('data-mod-delete="banned-uuid-9"') !== -1);
  const emptyCards = run('moderationHTML({ reports: [], banned: [], bannedById: {} })');
  ok('empty reports show the empty state', emptyCards.indexOf('No open reports.') !== -1);
  ok('banned card hidden when nobody is banned', emptyCards.indexOf('Banned users') === -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
