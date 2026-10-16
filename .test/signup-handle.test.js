// Signup handle (v551): Name, Email and handle are REQUIRED on the
// Create-account form (User directive, 2026-10-14). The handle is
// claimed later, not at form time: claim_handle needs an authenticated
// session and a profiles row, and email confirmation means the form
// usually runs signed-out. So the chosen handle rides user_metadata
// exactly like the signup names, and enterApp claims it on the first
// authenticated session via claimSignupHandle (js/237).
//
// Availability finding (checked in the v550 migration's grants):
// handle_available is granted to `authenticated` ONLY — a signed-out
// visitor cannot call it, and this change deliberately does NOT widen
// that grant. The form therefore validates format + the shared screen
// locally and states that the handle is confirmed when the account is
// created; claim-time is where availability is enforced.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const read = (p) => fs.readFileSync(path.join(APP_DIR, p), 'utf8');
const html = read('index.html');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in signup-handle tests'); };
window.confirm = () => true;
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);

const calls = { signUp: [], updateUser: [], rpc: [] };
let rpcImpl = async () => ({ data: null, error: null });
const selChain = (result) => {
  const b = { eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle: async () => result,
    then(res, rej) { return Promise.resolve(result).then(res, rej); } };
  return b;
};
const stub = {
  auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signUp: async (args) => { calls.signUp.push(args); return { data: { user: { id: 'u-new', email: args.email }, session: null }, error: null }; },
    updateUser: async (args) => { calls.updateUser.push(args); return { data: {}, error: null }; },
    signInWithPassword: async () => ({ data: {}, error: null }),
    signOut: async () => ({ error: null }),
  },
  rpc: async (name, args) => { calls.rpc.push([name, args]); return rpcImpl(name, args); },
  from: (table) => ({
    select(cols) { return selChain(stub._selectResult || { data: null, error: null }); },
    upsert: async () => ({ error: null }),
  }),
  _selectResult: null,
};

function fillSignupValid() {
  q('#gs-first').value = 'New';
  q('#gs-last').value = 'Reader';
  q('#gs-email').value = 'new@x.y';
  q('#gs-pass').value = 'secret1';
  q('#gs-pass2').value = 'secret1';
  q('#gs-band [data-b="adult"]').click();
}
const statusText = () => (q('#gs-status') || {}).textContent || '';

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;
  runInWindow('window.__toasts = []; toast = (m) => { window.__toasts.push(String(m)); };');

  /* ================= the form ================= */
  probe('renderGateSignup()'); await tick(2);
  ok('form: the handle field renders on the create-account form', !!q('#gs-handle'));
  ok('form: copy states the handle is confirmed when the account is created (no live availability while signed out)',
    /confirmed when your account is created/i.test((q('.gate-card') || {}).textContent || ''));

  const hIn = q('#gs-handle');
  hIn.value = '@Moon_Reader';
  hIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok('form: typing is normalized as you type (@ stripped, lowercase forced)', hIn.value === 'moon_reader');

  // Blocked submissions: everything else valid, only the handle varies.
  const blockedCase = async (handleValue, msgRe, label) => {
    probe('renderGateSignup()'); await tick(2);
    fillSignupValid();
    q('#gs-handle').value = handleValue;
    const before = calls.signUp.length;
    q('#gs-create').click(); await tick(3);
    ok('form: ' + label, calls.signUp.length === before && msgRe.test(statusText()));
  };
  await blockedCase('', /choose a handle/i, 'an empty handle blocks creation with the specific message, no auth call');
  await blockedCase('ab', /3–20 characters/i, 'a too-short handle blocks creation (invalid), no auth call');
  await blockedCase('xxfuckxx', /can’t be used/i, 'a slur handle blocks creation (screened), no auth call');
  await blockedCase('admin_x', /reserved/i, 'a reserved handle blocks creation (reserved), no auth call');

  probe('renderGateSignup()'); await tick(2);
  fillSignupValid();
  const happy = q('#gs-handle');
  happy.value = '@Moon_Reader';
  happy.dispatchEvent(new window.Event('input', { bubbles: true }));
  const suBefore = calls.signUp.length;
  q('#gs-create').click(); await tick(3);
  const suArgs = calls.signUp[suBefore] || {};
  const suMeta = (suArgs.options && suArgs.options.data) || {};
  ok('form: a valid handle lets creation proceed', calls.signUp.length === suBefore + 1);
  ok('form: the stash travels in the signUp user_metadata, cleaned',
    suMeta.handle === 'moon_reader');
  ok('form: names + age band still travel alongside the handle',
    suMeta.first_name === 'New' && suMeta.last_name === 'Reader' && suMeta.age_band === 'adult');

  /* ================= wiring pins ================= */
  const src090 = read('js/090-sync.js');
  const src095 = read('js/095-gate.js');
  const src237 = read('js/237-handles.js');
  ok('wiring: cloudSignUp carries the handle in user_metadata like the names',
    /meta\.handle\s*=\s*handle/.test(src090));
  ok('wiring: the gate passes the chosen handle to cloudSignUp',
    /cloudSignUp\(em, pw, first, last, band, handle\)/.test(src095));
  ok('wiring: enterApp attempts the deferred claim after the profile load completes',
    src095.indexOf('claimSignupHandle(user)') > src095.indexOf('await syncCloudProfile()') &&
    src095.indexOf('await syncCloudProfile()') !== -1);
  ok('wiring: the claim helper is once-per-user-per-session guarded',
    /signupHandleClaimFor/.test(src237));

  /* ================= the deferred claim ================= */
  const claims = () => calls.rpc.filter(([n]) => n === 'claim_handle').length;
  const seedProfile = (uid, obj) => runInWindow(
    'localStorage.setItem("spicyshelves.profile.' + uid + '", ' + JSON.stringify(JSON.stringify(obj)) + ');');
  const asUser = (uid, meta) => {
    runInWindow('cloudUser = { id: "' + uid + '", email: "' + uid + '@x.y", user_metadata: ' + JSON.stringify(meta || {}) + ' };');
    return { id: uid, email: uid + '@x.y', user_metadata: meta || {} };
  };

  // -- success: fires, confirms, clears the stash --
  rpcImpl = async (name) => {
    if (name === 'claim_handle') return { data: { ok: true, handle: 'moon_reader' }, error: null };
    if (name === 'handle_available') return { data: true, error: null };
    return { data: null, error: null };
  };
  seedProfile('u-a', { firstName: 'New', lastName: 'Reader', avatar: { type: 'letter' }, updatedAt: 1 });
  window.__toasts.length = 0; calls.updateUser.length = 0;
  const userA = asUser('u-a', { handle: 'moon_reader' });
  await probe('claimSignupHandle(' + JSON.stringify(userA) + ')'); await tick(2);
  ok('claim: a stashed handle is claimed on the first session', claims() === 1 &&
    calls.rpc.some(([n, a]) => n === 'claim_handle' && a && a.p_handle === 'moon_reader'));
  ok('claim: success lands the handle on the local profile',
    probe('loadProfile()').handle === 'moon_reader');
  ok('claim: success confirms to the user',
    window.__toasts.some(t => t.includes('Your handle @moon_reader is yours')));
  ok('claim: success clears the stash via updateUser',
    calls.updateUser.some(a => a && a.data && a.data.handle === ''));
  await probe('claimSignupHandle(' + JSON.stringify(userA) + ')'); await tick(2);
  ok('claim: the helper fires at most once per session (second call is a no-op)', claims() === 1);

  // -- no fire: the profile already has a handle (the real invariant) --
  seedProfile('u-b', { firstName: 'Has', lastName: 'One', avatar: { type: 'letter' }, updatedAt: 1, handle: 'kept_name' });
  const userB = asUser('u-b', { handle: 'other_name' });
  const claimsBeforeB = claims();
  await probe('claimSignupHandle(' + JSON.stringify(userB) + ')'); await tick(2);
  ok('claim: never fires into a profile that already has a handle', claims() === claimsBeforeB);

  // -- no fire: no stash --
  seedProfile('u-c', { firstName: 'No', lastName: 'Stash', avatar: { type: 'letter' }, updatedAt: 1 });
  const userC = asUser('u-c', {});
  const updBeforeC = calls.updateUser.length;
  await probe('claimSignupHandle(' + JSON.stringify(userC) + ')'); await tick(2);
  ok('claim: no stash, no claim, no stash-clearing write', claims() === claimsBeforeB && calls.updateUser.length === updBeforeC);

  // -- typed failure: taken → stash cleared, honest message, routed --
  rpcImpl = async (name) => {
    if (name === 'claim_handle') return { data: { ok: false, error: 'taken' }, error: null };
    if (name === 'handle_available') return { data: true, error: null };
    return { data: null, error: null };
  };
  seedProfile('u-d', { firstName: 'Too', lastName: 'Slow', avatar: { type: 'letter' }, updatedAt: 1 });
  window.__toasts.length = 0; calls.updateUser.length = 0;
  runInWindow('view = "library";');
  const userD = asUser('u-d', { handle: 'gone_handle' });
  await probe('claimSignupHandle(' + JSON.stringify(userD) + ')'); await tick(3);
  ok('claim (taken): the stash is cleared so it can never re-fire',
    calls.updateUser.some(a => a && a.data && a.data.handle === ''));
  ok('claim (taken): the user hears the handle was just taken',
    window.__toasts.some(t => t.includes('@gone_handle') && /just taken/i.test(t)));
  ok('claim (taken): the user is routed to Settings → Account to choose another (v590)',
    probe('view') === 'settings');

  // -- typed failure: quarantined → server wording + Profile routing --
  rpcImpl = async (name) => {
    if (name === 'claim_handle') return { data: { ok: false, error: 'quarantined' }, error: null };
    if (name === 'handle_available') return { data: true, error: null };
    return { data: null, error: null };
  };
  seedProfile('u-e', { firstName: 'Held', lastName: 'Back', avatar: { type: 'letter' }, updatedAt: 1 });
  window.__toasts.length = 0; calls.updateUser.length = 0;
  runInWindow('view = "library";');
  const userE = asUser('u-e', { handle: 'held_handle' });
  await probe('claimSignupHandle(' + JSON.stringify(userE) + ')'); await tick(3);
  ok('claim (quarantined): stash cleared, hold explained, routed to Settings → Account (v590)',
    calls.updateUser.some(a => a && a.data && a.data.handle === '') &&
    window.__toasts.some(t => /held for its previous owner/i.test(t) && /Settings/.test(t)) &&
    probe('view') === 'settings');

  // -- unsupported (pre-v550 database): stash kept, silent --
  rpcImpl = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } });
  seedProfile('u-f', { firstName: 'Old', lastName: 'Db', avatar: { type: 'letter' }, updatedAt: 1 });
  window.__toasts.length = 0; calls.updateUser.length = 0;
  runInWindow('view = "library";');
  const userF = asUser('u-f', { handle: 'later_handle' });
  await probe('claimSignupHandle(' + JSON.stringify(userF) + ')'); await tick(3);
  ok('claim (unsupported): the stash is KEPT for a later session, no route, no toast',
    calls.updateUser.length === 0 && probe('view') === 'library' && window.__toasts.length === 0);

  // -- transient failure: stash kept, no route --
  rpcImpl = async () => ({ data: null, error: { message: 'fetch failed' } });
  seedProfile('u-g', { firstName: 'Off', lastName: 'Line', avatar: { type: 'letter' }, updatedAt: 1 });
  window.__toasts.length = 0; calls.updateUser.length = 0;
  runInWindow('view = "library";');
  const userG = asUser('u-g', { handle: 'retry_handle' });
  await probe('claimSignupHandle(' + JSON.stringify(userG) + ')'); await tick(3);
  ok('claim (transient failure): the stash is KEPT, no route, no scary toast',
    calls.updateUser.length === 0 && probe('view') === 'library' && window.__toasts.length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
