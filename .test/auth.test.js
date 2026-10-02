// Auth gate + per-user on-device libraries (v30): the app opens on a sign-in
// gate when cloud sync is configured; each user gets a partitioned local
// library; sign-out returns to the gate without leaking books between users.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in auth tests'); };
// Backend configured BEFORE boot so the gate path is exercised.
window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };

function makeFake() {
  const store = [];
  const deleted = [];
  const fake = {
    store, deleted, user: null, _cb: null,
    auth: {
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signUp: async ({ email, options }) => { fake.user = { id: 'u-' + email, email }; fake.signupMeta = (options && options.data) || {}; return { data: { session: { user: fake.user } }, error: null }; },
      signInWithPassword: async ({ email }) => { fake.user = { id: 'u-' + email, email }; return { data: { session: { user: fake.user } }, error: null }; },
      signOut: async () => { fake.user = null; return { error: null }; },
      signInWithOAuth: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async (email, opts) => { fake.resetTo = email; fake.resetRedirect = opts && opts.redirectTo; return { error: null }; },
      exchangeCodeForSession: async (code) => code === 'good-code'
        ? { data: { user: { id: 'u-r', email: 'r@x.com' } }, error: null }
        : { data: null, error: new Error('bad code') },
      updateUser: async ({ password }) => { fake.pwUpdated = password; return { error: null }; },
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: (table) => {
      if (table === 'deleted_books') return {
        upsert: async (rows) => { for (const r of rows) { const i = deleted.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id); if (i >= 0) deleted[i] = r; else deleted.push(r); } return { error: null }; },
        select: (cols) => require('./harness').chainableSelect(deleted,
          r => ({ book_id: r.book_id, deleted_at: r.deleted_at })),
      };
      return {
      upsert: async (rows) => {
        for (const r of rows) {
          const i = store.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
          const rec = Object.assign({}, r);
          if (i >= 0) store[i] = rec; else store.push(rec);
        }
        return { error: null };
      },
      // RLS-faithful: a signed-in user only ever sees their own rows.
      select: (cols) => require('./harness').chainableSelect(
        store.filter(r => fake.user && r.user_id === fake.user.id),
        r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })),
      delete: () => {
        const filters = [];
        const chain = {
          eq: (col, val) => { filters.push(r => r[col] === val); return chain; },
          in: (col, vals) => { filters.push(r => vals.includes(r[col])); return chain; },
          then: (resolve) => {
            for (let i = store.length - 1; i >= 0; i--) {
              if (filters.every(f => f(store[i]))) store.splice(i, 1);
            }
            resolve({ error: null });
          }
        };
        return chain;
      },
      };
    },
    fire: (event, user) => { fake.user = user || null; fake._cb(event, user ? { user } : null); },
  };
  return fake;
}
window.__sbStub = makeFake();
window.isSecureContext = true; // jsdom doesn't implement it; real localhost is a secure context

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });
const probe = (js) => { runInWindow('window.__probe = (' + js + ');'); return window.__probe; };
const lsGet = (k) => window.localStorage.getItem(k);
const lsBooks = (k) => { try { return JSON.parse(lsGet(k)) || []; } catch (e) { return []; } };

(async () => {
  await tick();

  ok('gate is sign-in only with a create-account option',
    !!q('#gate-signin') && !!q('#gate-show-signup') && !q('#gate-signup') && !!q('#gate-email'));

  // v90: "Create account" opens its own form: first/last name, email,
  // password + confirm password.
  q('#gate-show-signup').click();
  await tick();
  ok('create-account option opens the signup form',
    !!q('#gs-first') && !!q('#gs-last') && !!q('#gs-email') && !!q('#gs-pass') && !!q('#gs-pass2') && !!q('#gs-create'));
  ok('sign-in fields hidden on the signup form', !q('#gate-signin'));
  q('#gs-first').value = 'Wifey';
  q('#gs-last').value = 'Reader';
  q('#gs-email').value = 'new@example.com';
  q('#gs-pass').value = 'secret12';
  q('#gs-pass2').value = 'mismatch';
  q('#gs-create').click();
  await tick(2);
  ok('mismatched passwords rejected',
    q('#gs-status').textContent.indexOf("don't match") >= 0 && !window.__sbStub.signupMeta);
  q('#gs-first').value = '';
  q('#gs-pass2').value = 'secret12';
  q('#gs-create').click();
  await tick(2);
  ok('missing name rejected',
    q('#gs-status').textContent.indexOf('first and last name') >= 0 && !window.__sbStub.signupMeta);
  q('#gs-first').value = 'Wifey';
  q('#gs-create').click();
  await tick(4);
  ok('names travel in signup user_metadata',
    !!window.__sbStub.signupMeta &&
    window.__sbStub.signupMeta.first_name === 'Wifey' &&
    window.__sbStub.signupMeta.last_name === 'Reader');
  q('#gs-back').click();
  await tick();
  ok('back returns to the sign-in gate', !!q('#gate-signin') && !q('#gs-create'));
  ok('gate has Google button on secure localhost', !!q('#gate-google'));
  ok('bottom nav hidden on gate', q('.bottom-nav').style.display === 'none');
  ok('legacy storage key while signed out', probe('libKey()') === 'spicyshelves.library.v1');

  // v204: no "Continue offline" — sign-in is required. A legacy offline
  // flag is ignored and cleaned up; the gate stays.
  ok('no Continue offline button', !q('#gate-offline'));
  runInWindow("localStorage.setItem('spicyshelves.offline', '1'); boot();");
  await tick();
  ok('legacy offline flag ignored — gate stays', !!q('#gate-signin') && !q('#view .toolbar'));
  ok('legacy offline flag cleaned up', lsGet('spicyshelves.offline') === null);

  // Sign in with an existing offline library → adopted into the per-user slot.
  runInWindow(`
    localStorage.setItem('spicyshelves.library.v1',
      JSON.stringify([{ id: 'b1', title: 'Offline Book', authors: ['A U Thor'], status: 'tbr' }]));
    library = loadLegacyLibrary();
  `);
  window.__sbStub.fire('SIGNED_IN', { id: 'user-1', email: 'wife@example.com' });
  await tick(6);
  ok('signed in → library view', !q('#gate-signin') && !!q('#view .toolbar'));
  ok('per-user storage key active', probe('libKey()') === 'spicyshelves.library.v2.user-1');
  ok('offline books adopted to user library', probe('library.some(b => b.id === "b1")') === true);
  ok('legacy key removed after adoption', lsGet('spicyshelves.library.v1') === null);
  ok('books persisted under per-user key', lsBooks('spicyshelves.library.v2.user-1').some(b => b.id === 'b1'));
  ok('cloud received the books', window.__sbStub.store.some(r => r.user_id === 'user-1' && r.book_id === 'b1'));

  // Topbar account menu: avatar visible while signed in, dropdown has
  // Profile / Settings / Logout, logout item signs out on tap.
  const menuBtn = q('#menu-btn');
  ok('menu button shown while signed in', !!menuBtn);
  ok('menu button shows the account initial', menuBtn.textContent.trim().toLowerCase() === 'w');
  ok('menu button titles with the signed-in email', menuBtn.title.includes('wife@example.com'));
  menuBtn.click();
  await tick();
  ok('menu opens on tap', !q('#menu-pop').hidden);
  const menuIds = Array.from(q('#menu-pop').querySelectorAll('[data-m]')).map(b => b.dataset.m);
  ok('menu has Profile / Settings / Logout', JSON.stringify(menuIds) === '["profile","settings","logout"]');
  ok('menu shows the account email', q('#menu-pop .menu-email').textContent === 'wife@example.com');
  window.confirm = () => false; // dismiss the dialog → stays signed in
  q('#menu-pop [data-m="logout"]').click();
  await tick();
  ok('dismissed confirm keeps the session', !q('#gate-signin') && probe('cloudUser && cloudUser.id') === 'user-1');
  window.confirm = () => true; // confirm → sign out
  menuBtn.click();
  await tick();
  q('#menu-pop [data-m="logout"]').click();
  await tick(2);
  ok('logout menu item signs out to the gate', !!q('#gate-signin') && probe('cloudUser') === null);

  // v204: sign-out returns to the gate; the books stay in the per-user
  // slot — no hand-back to the offline shelf (signed-out mode is gone).
  await window.cloudSignOut();
  await tick();
  ok('gate shown after sign-out', !!q('#gate-signin'));
  // v242: no stray profile circle on the login prompt — the account menu
  // button is hidden while the gate is showing.
  ok('menu button hidden on the gate', q('#menu-btn').style.display === 'none');
  // v242: a signed-out visitor reaching Settings (Back) returns to the
  // gate, not an empty library.
  runInWindow('go(\'settings\');');
  await tick();
  ok('settings reachable while signed out', !!q('#st-back'));
  q('#st-back').click();
  await tick();
  ok('signed-out settings back returns to the gate', !!q('#gate-signin') && !q('#view .toolbar'));
  ok('offline shelf stays empty after sign-out',
    lsBooks('spicyshelves.library.v1').length === 0);
  ok('no owner marker written', lsGet('spicyshelves.offline.owner') === null);
  ok('per-user books kept on device', lsBooks('spicyshelves.library.v2.user-1').some(b => b.id === 'b1'));

  // Second user → clean shelf.
  window.__sbStub.fire('SIGNED_IN', { id: 'user-2', email: 'friend@example.com' });
  await tick(6);
  ok('second user starts with empty shelf', probe('library.length') === 0);
  ok('second user has own storage key', probe('libKey()') === 'spicyshelves.library.v2.user-2');
  ok('first user shelf untouched', lsBooks('spicyshelves.library.v2.user-1').some(b => b.id === 'b1'));

  // Sign back in as user-1 → shelf restored from the per-user slot.
  await window.cloudSignOut();
  window.__sbStub.fire('SIGNED_IN', { id: 'user-1', email: 'wife@example.com' });
  await tick(6);
  ok('first user shelf restored on re-sign-in', probe('library.some(b => b.id === "b1")') === true);

  // Password reset: forgot-link → reset email → code exchange → new password.
  await window.cloudSignOut();
  await tick(4);
  ok('gate has a forgot-password link', !!q('#gate-forgot'));
  q('#gate-forgot').click();
  await tick(2);
  ok('forgot link opens the reset view', !!q('#gr-email') && !!q('#gr-send'));
  q('#gr-email').value = 'wife@example.com';
  q('#gr-send').click();
  await tick(6);
  ok('reset email requested for the typed address', window.__sbStub.resetTo === 'wife@example.com');
  ok('reset redirect returns to the app', (window.__sbStub.resetRedirect || '').indexOf('#recovery') >= 0);
  ok('reset confirmation shown', q('#gr-status').textContent.indexOf('check your email') >= 0);
  q('#gr-back').click();
  await tick(2);
  ok('back returns to the gate', !!q('#gate-signin'));

  await window.handlePasswordRecovery(window.__sbStub, 'good-code');
  await tick(2);
  ok('valid reset code opens the new-password form', !!q('#np-pass') && !!q('#np-save'));
  q('#np-pass').value = 'short';
  q('#np-save').click();
  await tick(3);
  ok('short password rejected', q('#np-status').textContent.indexOf('6 characters') >= 0 && !window.__sbStub.pwUpdated);
  q('#np-pass').value = 'newsecret1';
  q('#np-save').click();
  await tick(8);
  ok('new password saved via updateUser', window.__sbStub.pwUpdated === 'newsecret1');
  ok('signed in after password reset', !!q('#view .toolbar'));
  // v242: the menu button hidden by the gate is restored on sign-in.
  ok('menu button restored after sign-in', q('#menu-btn').style.display !== 'none');

  await window.handlePasswordRecovery(window.__sbStub, 'bad-code');
  await tick(2);
  ok('expired reset code returns to the gate', !!q('#gate-signin'));

  // v90: names from signup user_metadata are adopted into the local profile
  // (and from there to the profiles table on sync).
  window.__sbStub.fire('SIGNED_IN', { id: 'user-9', email: 'new@example.com', user_metadata: { first_name: 'New', last_name: 'Kid' } });
  await tick(6);
  const prof9 = JSON.parse(lsGet('spicyshelves.profile.user-9') || '{}');
  ok('signup names adopted into the profile', prof9.firstName === 'New' && prof9.lastName === 'Kid');
  await window.cloudSignOut();
  await tick(2);

  // v204: no backend configured → the gate says sign-in isn't set up
  // (no more silent offline library).
  await window.cloudSignOut();
  runInWindow('delete window.SPICY_CONFIG;');
  await window.initCloud();
  runInWindow('boot();');
  await tick();
  ok('gate shown without backend config', !!q('#gate-status') && !q('#view .toolbar'));
  ok('gate names the missing setup', q('#gate-status').textContent.indexOf('isn\u2019t set up') >= 0);
  ok('no sign-in form without backend config', !q('#gate-signin'));
  ok('no account initial without a signed-in user', !!q('#menu-btn .ticon'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
