// Handles (v550): unique, findable profile handles.
//
// Contract under test (design hardened by a doubt round; the migration
// header is the design record):
//  - a handle is a chosen public identity: friend surfaces display
//    @handle INSTEAD of the real name when one is set;
//  - findable is a separate opt-in, default OFF; lookup is exact-match
//    and its shape NEVER carries first/last name; every refusal
//    (unknown / not findable / blocked / limited) is indistinguishable;
//  - add-by-handle creates a PENDING request, never an instant link;
//  - released handles quarantine 90 days (owner may reclaim), renames
//    cool down 30 days, and the claim RPC is the only write path;
//  - one canonical screen list lives in SQL AND in js/237 — the two
//    copies must agree token-for-token.
//
// SQL is pinned as text contracts in the established migration-suite
// style (no database in the harness); client behaviour runs against
// the real app code with a stub Supabase client.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const read = (p) => fs.readFileSync(path.join(APP_DIR, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

/* ================= migration SQL contracts ================= */
const sql = read('supabase/migrations/v550_handles.sql');
const schema = read('supabase/schema.sql');
const fnBody = (text, name) => {
  const i = text.indexOf('function public.' + name);
  if (i < 0) return '';
  const j = text.indexOf('$$;', i);
  return j < 0 ? '' : text.slice(i, j + 3);
};

ok('sql: profiles gains handle / findable (default false) / handle_changed_at',
  /add column if not exists handle text/.test(sql) &&
  /add column if not exists findable boolean not null default false/.test(sql) &&
  /add column if not exists handle_changed_at timestamptz/.test(sql));
ok('sql: format CHECK pins the charset (lowercase a-z0-9_, 3-20)',
  /check \(handle is null or handle ~ '\^\[a-z0-9_\]\{3,20\}\$'\)/.test(sql));
ok('sql: uniqueness is a case-insensitive partial unique index',
  /create unique index if not exists profiles_handle_unique\s+on public\.profiles \(lower\(handle\)\)\s+where handle is not null/.test(sql));
ok('sql: tombstone + lookup-budget tables exist with RLS on',
  /create table if not exists public\.handle_history/.test(sql) &&
  /create table if not exists public\.handle_lookups/.test(sql) &&
  /alter table public\.handle_history enable row level security/.test(sql) &&
  /alter table public\.handle_lookups enable row level security/.test(sql));
ok('sql: NO client policies on the handle tables (definer access only)',
  !/create policy[^;]*on public\.handle_history/.test(sql) &&
  !/create policy[^;]*on public\.handle_lookups/.test(sql));

const lookupBody = fnBody(sql, 'lookup_handle');
ok('sql: lookup_handle exists (definer) and never projects a real name',
  /security definer/.test(lookupBody) && !/first_name|last_name/.test(lookupBody));
ok('sql: lookup gates bio/genres behind the same share_bio CASE as the view',
  /case when p\.share_bio then p\.bio end/.test(lookupBody) &&
  /case when p\.share_bio then p\.fav_genres end/.test(lookupBody));
ok('sql: lookup requires findable and excludes blocks in EITHER direction',
  /p\.findable is true/.test(lookupBody) &&
  /b\.blocker_id = v_me and b\.blocked_id = p\.user_id/.test(lookupBody) &&
  /b\.blocker_id = p\.user_id and b\.blocked_id = v_me/.test(lookupBody));
ok('sql: lookup spends the rate budget (30/hour) before answering',
  /handle_lookup_budget\(\)/.test(lookupBody) &&
  /v_recent <= 30/.test(fnBody(sql, 'handle_lookup_budget')) &&
  /interval '1 hour'/.test(fnBody(sql, 'handle_lookup_budget')));

const reqBody = fnBody(sql, 'request_by_handle');
ok('sql: request_by_handle creates a PENDING link, never an accepted one',
  /insert into public\.circle_links \(requester_id, addressee_id, status\)\s+values \(v_me, v_them, 'pending'\)/.test(reqBody) &&
  !/'accepted'\)/.test(reqBody.split('insert into')[1] || ''));
ok('sql: request refusals collapse into one indistinguishable failure shape',
  (reqBody.match(/return v_fail/g) || []).length >= 4 &&
  /'error', 'unavailable'/.test(reqBody));

const claimBody = fnBody(sql, 'claim_handle');
ok('sql: claim enforces the 90-day quarantine and the 30-day rename cooldown',
  /interval '90 days'/.test(claimBody) && /interval '30 days'/.test(claimBody));
ok('sql: claim returns typed errors (taken/quarantined/cooldown/screened/reserved/invalid)',
  ['taken', 'quarantined', 'cooldown', 'screened', 'reserved', 'invalid']
    .every(e => claimBody.includes("'error', '" + e + "'")));
ok('sql: the claim race is caught and reported as taken (the index holds)',
  /exception when unique_violation/.test(claimBody) && /'error', 'taken'/.test(claimBody));
ok('sql: claim and clear write tombstones on release',
  /insert into public\.handle_history \(handle, owner_id\) values \(v_cur, v_me\)/.test(claimBody) &&
  /insert into public\.handle_history \(handle, owner_id\) values \(v_cur, v_me\)/.test(fnBody(sql, 'clear_handle')));
ok('sql: clearing is never cooldown-gated (privacy exit stays open)',
  !/cooldown/.test(fnBody(sql, 'clear_handle')));

const guardBody = fnBody(sql, 'profiles_handle_guard');
ok('sql: a guard trigger makes the RPC the only handle write path',
  /create trigger profiles_handle_guard/.test(sql) &&
  /current_setting\('app\.handle_claim', true\)/.test(guardBody) &&
  /handles are set via claim_handle/.test(guardBody));
const screenBody = fnBody(sql, 'profiles_content_screen');
ok('sql: the name/bio screen trigger exists and screens CHANGED fields only',
  /create trigger profiles_content_screen/.test(sql) &&
  /new\.first_name is distinct from old\.first_name/.test(screenBody) &&
  /new\.last_name is distinct from old\.last_name/.test(screenBody) &&
  /new\.bio is distinct from old\.bio/.test(screenBody) &&
  /profile content screened/.test(screenBody));

const formerlyBody = fnBody(sql, 'friend_formerly');
ok('sql: friend_formerly is accepted-link gated and quarantine-scoped',
  /cl\.status = 'accepted'/.test(formerlyBody) && /interval '90 days'/.test(formerlyBody));
const inviterBody = fnBody(sql, 'invite_inviter_name');
ok('sql: invite_inviter_name prefers the inviter handle over the real name',
  /case when p\.handle is not null and p\.handle <> '' then '@' \|\| p\.handle end/.test(inviterBody));
ok('sql: block_by_handle and report_by_handle resolve server-side (no user_id on the card)',
  fnBody(sql, 'block_by_handle').includes('insert into public.blocks') &&
  fnBody(sql, 'report_by_handle').includes('insert into public.user_reports'));

/* ================= screen-list agreement (SQL <-> JS) ================= */
const sqlList = (fname) => {
  const body = fnBody(sql, fname);
  const m = /array\[([\s\S]*?)\]::text\[\]/.exec(body);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort() : null;
};
const js237Path = path.join(APP_DIR, 'js/237-handles.js');
const js237 = fs.existsSync(js237Path) ? fs.readFileSync(js237Path, 'utf8') : '';
const jsList = (vname) => {
  const m = new RegExp(vname + ' = \\[([\\s\\S]*?)\\];').exec(js237);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort() : null;
};
ok('lists: the SQL slur list and the JS slur list agree token-for-token',
  JSON.stringify(sqlList('handle_screen_slurs')) === JSON.stringify(jsList('HANDLE_SCREEN_SLURS')));
ok('lists: the SQL reserved list and the JS reserved list agree token-for-token',
  JSON.stringify(sqlList('handle_screen_reserved')) === JSON.stringify(jsList('HANDLE_SCREEN_RESERVED')));
ok('lists: reserved covers the brand/app/staff terms',
  ['cozylibram', 'luna', 'admin', 'support', 'moderator', 'official']
    .every(t => (jsList('HANDLE_SCREEN_RESERVED') || []).includes(t)));

/* ================= registration ================= */
const html = read('index.html');
const swText = read('sw.js');
ok('index.html registers js/237-handles.js', html.includes('<script src="js/237-handles.js"></script>'));
ok('sw.js precaches 237-handles.js', swText.includes("'237-handles.js'"));

/* ================= client behaviour ================= */
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in handles tests'); };
window.confirm = () => true;
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);

const ME = 'user-me', THEM = 'user-them';
let rpcImpl = async () => ({ data: null, error: null });
let upsertImpl = async () => ({ error: null });
const calls = { rpc: [], upserts: [], selects: [] };
const selChain = (result) => {
  const b = { eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle: async () => result,
    then(res, rej) { return Promise.resolve(result).then(res, rej); } };
  return b;
};
const stub = {
  rpc: async (name, args) => { calls.rpc.push([name, args]); return rpcImpl(name, args); },
  from: (table) => ({
    select(cols) { calls.selects.push([table, String(cols || '')]); return selChain(stub._selectResult || { data: [], error: null }); },
    upsert(row) { calls.upserts.push(row); return upsertImpl(row); },
  }),
  _selectResult: null,
};

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;
  runInWindow('cloudUser = { id: "' + ME + '", email: "me@x.y" };');
  runInWindow('window.__toasts = []; toast = (m) => { window.__toasts.push(String(m)); };');

  /* ---------- the display helper ---------- */
  ok('display: a set handle replaces the name (@handle, single token)',
    probe('friendDisplayName({ first_name: "Ona", last_name: "Optin", handle: "ona_reads" }, "A reader")') === '@ona_reads');
  ok('display: no handle keeps today\u2019s full-name behaviour',
    probe('friendDisplayName({ first_name: "Ona", last_name: "Optin", handle: "" }, "A reader")') === 'Ona Optin');
  ok('display: no name and no handle falls back',
    probe('friendDisplayName({ first_name: "", last_name: "", handle: null }, "A reader")') === 'A reader');
  ok('display: every converted surface uses the one helper',
    ['195-coven.js', '231-reactions.js', '232-thought-of-you.js', '233-buddy-reads.js', '234-outbox.js']
      .every(f => read('js/' + f).includes('friendDisplayName(')));
  ok('editor helper: the profile save screens names + bio before anything persists',
    typeof window.profileContentScreenHit === 'function' &&
    window.profileContentScreenHit({ firstName: 'Fuck', lastName: '', bio: '' }) === 'firstName' &&
    window.profileContentScreenHit({ firstName: 'Me', lastName: '', bio: 'total shit take' }) === 'bio' &&
    window.profileContentScreenHit({ firstName: 'Me', lastName: 'Myself', bio: 'I admin a book club' }) === null);

  /* ---------- the screen, client side ---------- */
  ok('screen: leet normalization decodes 4dm1n and n1gger',
    probe('handleNormalizeText("4dm1n")') === 'admin' && probe('handleNormalizeText("N1GGER")') === 'nigger');
  ok('screen (handle): a slur as substring is screened',
    probe('handleScreenHit("xxfuckxx", "handle")') === 'fuck');
  ok('screen (handle): a reserved token is screened (admin_x)',
    probe('handleScreenHit("admin_x", "handle")') === 'admin');
  ok('screen (handle): a reserved substring inside a word is NOT screened (modern_reader vs mod)',
    probe('handleScreenHit("modern_reader", "handle")') === null);
  ok('screen (handle): an ordinary handle passes',
    probe('handleScreenHit("moon_reader", "handle")') === null);
  ok('screen (name): a flagged substring inside a longer name is NOT screened (Scunthorpe rule)',
    probe('handleScreenHit("Scunthorpe", "name")') === null);
  ok('screen (name): a whole-token slur is screened',
    probe('handleScreenHit("Fuck Smith", "name")') === 'fuck');
  ok('screen (bio): staff words are ordinary prose in a bio',
    probe('handleScreenHit("I admin a tiny book club", "bio")') === null);
  ok('screen (bio): a whole-token slur is screened',
    probe('handleScreenHit("total shit take", "bio")') === 'shit');
  ok('format: valid shapes pass, invalid shapes fail',
    probe('handleFormatValid("moon_reader") && handleFormatValid("abc")') === true &&
    probe('handleFormatValid("Mo") || handleFormatValid("has space") || handleFormatValid("a".repeat(21))') === false);

  /* ---------- claim RPC wrapper + honest error copy ---------- */
  rpcImpl = async (name) => name === 'claim_handle'
    ? { data: { ok: false, error: 'cooldown', days_remaining: 12 }, error: null }
    : { data: null, error: null };
  const cool = await probe('claimHandleRpc("new_handle")');
  ok('claim wrapper passes the typed result through', cool && cool.ok === false && cool.error === 'cooldown');
  ok('claim copy: the cooldown message carries the days remaining, verbatim from the RPC',
    probe('handleClaimErrorMessage({ ok: false, error: "cooldown", days_remaining: 12 })').includes('12'));
  ok('claim copy: taken / quarantined / screened are distinct honest messages',
    ['taken', 'quarantined', 'screened', 'reserved', 'invalid'].every(e => {
      const m = probe('handleClaimErrorMessage({ ok: false, error: "' + e + '" })');
      return typeof m === 'string' && m.length > 8;
    }) && probe('handleClaimErrorMessage({ ok: false, error: "taken" })') !==
         probe('handleClaimErrorMessage({ ok: false, error: "quarantined" })'));
  rpcImpl = async (name) => name === 'claim_handle'
    ? { data: { ok: true, handle: 'moon_reader' }, error: null } : { data: null, error: null };
  const won = await probe('claimHandleRpc("@Moon_Reader")');
  ok('claim wrapper normalizes @ and case before it sends', won && won.ok === true &&
    calls.rpc.some(([n, a]) => n === 'claim_handle' && a && a.p_handle === 'moon_reader'));

  /* ---------- profile sync: findable rides, the handle never does ---------- */
  calls.upserts.length = 0;
  rpcImpl = async () => ({ data: null, error: null });
  upsertImpl = async () => ({ error: null });
  const p1 = { firstName: 'Me', lastName: 'Myself', gender: '', avatar: { type: 'letter' },
    avatarCloudPath: '', updatedAt: Date.now(), bio: '', favGenres: [], handle: 'moon_reader', findable: true };
  const pushOk = await probe('pushCloudProfile(' + JSON.stringify(p1) + ')');
  const row = calls.upserts[0] || {};
  ok('sync: pushCloudProfile succeeds and carries findable', !!pushOk && pushOk.ok === true && row.findable === true);
  ok('sync: pushCloudProfile NEVER writes the handle column (the RPC owns it)', !('handle' in row));
  upsertImpl = async () => ({ error: { code: '23514', message: 'profile content screened: first_name' } });
  window.__toasts.length = 0;
  const pushBad = await probe('pushCloudProfile(' + JSON.stringify(p1) + ')');
  ok('sync: a server screen rejection surfaces honestly (no silent "offline")',
    !!pushBad && pushBad.ok === false && window.__toasts.some(t => /can’t be used/i.test(t)));
  upsertImpl = async () => ({ error: null });

  calls.selects.length = 0;
  stub._selectResult = { data: { first_name: 'Me', last_name: 'Myself', avatar_id: '', avatar_path: '',
    updated_at: new Date(Date.now() + 60000).toISOString(), gender: '', bio: '', fav_genres: [],
    handle: 'moon_reader', findable: true }, error: null };
  await probe('syncCloudProfile()'); await tick(2);
  ok('sync: the full column tier asks for handle + findable',
    calls.selects.some(([t, c]) => t === 'profiles' && /handle/.test(c) && /findable/.test(c)));
  const pulled = probe('loadProfile()');
  ok('sync: a pulled handle + findable land on the local profile',
    pulled.handle === 'moon_reader' && pulled.findable === true);
  stub._selectResult = null;

  /* ---------- circle projection carries the handle (pre-migration safe) ---------- */
  stub._selectResult = { data: [{ user_id: THEM, first_name: 'Ona', last_name: 'Optin', avatar_id: 'moon',
    avatar_path: '', share_library: true, share_bio: true, share_activity: false, handle: 'ona_reads' }], error: null };
  const rows = await probe('circleFetchProfiles(["' + THEM + '"])');
  ok('projection: circleProjectRow keeps the handle', rows.length === 1 && rows[0].handle === 'ona_reads');
  ok('projection: the fetch asks the view for the handle column',
    calls.selects.some(([t, c]) => t === 'circle_profiles' && /handle/.test(c)));
  let selectCount = 0;
  stub._selectResult = null;
  const origFrom = stub.from;
  stub.from = (table) => ({
    select(cols) {
      calls.selects.push([table, String(cols || '')]);
      selectCount++;
      if (table === 'circle_profiles' && /handle/.test(String(cols || ''))) {
        return selChain({ data: null, error: { code: '42703', message: 'column circle_profiles.handle does not exist' } });
      }
      return selChain({ data: [{ user_id: THEM, first_name: 'Ona', last_name: 'Optin', avatar_id: 'moon',
        avatar_path: '', share_library: true, share_bio: true, share_activity: false }], error: null });
    },
    upsert(row) { calls.upserts.push(row); return upsertImpl(row); },
  });
  const legacyRows = await probe('circleFetchProfiles(["' + THEM + '"])');
  ok('projection: a pre-v550 view (no handle column) degrades to the legacy column set',
    legacyRows.length === 1 && legacyRows[0].first_name === 'Ona' && selectCount >= 2);
  stub.from = origFrom;

  /* ---------- add-by-handle: lookup + request through the wrappers ---------- */
  rpcImpl = async (name) => name === 'lookup_handle'
    ? { data: [{ handle: 'ona_reads', avatar_id: 'moon', avatar_path: '', bio: null, fav_genres: null }], error: null }
    : { data: null, error: null };
  const card = await probe('lookupHandleRpc("ona_reads")');
  ok('lookup wrapper returns the card row (handle + avatar, no name fields)',
    !!card && card.handle === 'ona_reads' && !('first_name' in card));
  rpcImpl = async (name) => name === 'lookup_handle' ? { data: [], error: null } : { data: null, error: null };
  const miss = await probe('lookupHandleRpc("no_such_handle")');
  ok('lookup wrapper: a miss / blocked / not-findable all read as no card', miss === null);
  rpcImpl = async (name) => name === 'request_by_handle'
    ? { data: { ok: true }, error: null } : { data: null, error: null };
  const req = await probe('requestByHandleRpc("ona_reads")');
  ok('request wrapper reports success (a pending request now exists server-side)', !!req && req.ok === true);

  /* ---------- the profile editor ---------- */
  stub._selectResult = null;
  rpcImpl = async (name) => {
    if (name === 'handle_available') return { data: true, error: null };
    if (name === 'claim_handle') return { data: { ok: true, handle: 'moon_reader' }, error: null };
    return { data: null, error: null };
  };
  runInWindow('localStorage.setItem("spicyshelves.profile.' + ME + '", JSON.stringify({ firstName: "Me", lastName: "Myself", avatar: { type: "letter" }, updatedAt: 1 }))');
  probe("view = 'profile'; renderProfile();"); await tick(3);
  ok('editor: the handle field renders (Profile view, hybrid)', !!q('#pf-handle'));
  ok('editor: the findable toggle renders, disabled until a handle exists', !!q('#pf-findable') &&
    q('#pf-findable').dataset.disabled === '1');
  q('#pf-handle').value = 'moon_reader';
  q('#pf-handle-save').click(); await tick(4);
  ok('editor: claiming writes the handle onto the local profile', probe('loadProfile()').handle === 'moon_reader');
  ok('editor: after claiming, the findable toggle enables', q('#pf-findable') && q('#pf-findable').dataset.disabled !== '1');
  rpcImpl = async (name) => {
    if (name === 'handle_available') return { data: false, error: null };
    if (name === 'claim_handle') return { data: { ok: false, error: 'taken' }, error: null };
    if (name === 'clear_handle') return { data: { ok: true, cleared: true }, error: null };
    return { data: null, error: null };
  };
  probe("view = 'profile'; renderProfile();"); await tick(3);
  ok('editor: an existing handle renders with a clear action', !!q('#pf-handle-clear'));
  q('#pf-handle-clear').click(); await tick(2);
  ok('editor: clearing asks for a second tap with the 90-day hold stated first',
    (q('#pf-handle-status') || {}).textContent.includes('90 days'));
  q('#pf-handle-clear').click(); await tick(4);
  ok('editor: the confirmed clear removes the local handle', probe('loadProfile()').handle === '');

  /* ---------- identity placement (hybrid: card in Settings, form on Profile) ---------- */
  runInWindow('localStorage.setItem("spicyshelves.profile.' + ME + '", JSON.stringify({ firstName: "Me", lastName: "Myself", avatar: { type: "letter" }, updatedAt: 1, handle: "moon_reader" }))');
  probe('renderSettings()'); await tick(2);
  const cardName = q('#ac-card-name');
  const profRows = [...window.document.querySelectorAll('.pf-row .st-pname')];
  ok('settings: the signed-in card keeps the name (it is the identity block)',
    !!cardName && cardName.textContent === 'Me Myself');
  ok('settings: exactly one identity row remains (the duplicate Profile & avatar row is gone)',
    profRows.length === 1);
  probe("view = 'profile'; renderProfile();"); await tick(2);
  ok('profile: the handle shows in the form handle block',
    !!q('#pf-handle-box') && q('#pf-handle-box').textContent.includes('@moon_reader'));
  runInWindow('localStorage.setItem("spicyshelves.profile.' + ME + '", JSON.stringify({ firstName: "Me", lastName: "Myself", avatar: { type: "letter" }, updatedAt: 1 }))');
  probe("view = 'profile'; renderProfile();"); await tick(2);
  ok('profile: with no handle the form invites setting one instead of repeating the name',
    !!q('#pf-handle-box') && /pick a handle/i.test(q('#pf-handle-box').textContent));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
