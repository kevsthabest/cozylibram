// Profile view + account menu (v37): the top-right avatar opens a dropdown
// (Profile / Settings / Logout when signed in; Settings / Sign in when not),
// and the Profile view edits names + avatar (themed defaults or upload).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in profile tests'); };
window.confirm = () => true;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });
const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
const menuIds = () => qa('#menu-pop [data-m]').map(b => b.dataset.m);

(async () => {
  await tick(3); // let boot() settle (no backend → library view)

  ok('settings removed from the bottom nav', !q('.bottom-nav [data-nav="settings"]'));
  ok('bottom nav keeps five tabs', qa('.bottom-nav button').length === 5);
  ok('menu button lives in the top-right header', !!q('.app-header .topbar-menu-wrap #menu-btn'));

  // Signed out, no backend → menu offers Settings only (no Sign in without config).
  q('#menu-btn').click(); await tick();
  ok('menu opens when signed out', !q('#menu-pop').hidden);
  ok('signed-out menu has Settings only', JSON.stringify(menuIds()) === '["settings"]');
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape' });
  window.document.dispatchEvent(esc); await tick();
  ok('Escape closes the menu', q('#menu-pop').hidden);

  // Signed out WITH backend + offline flag → Settings + Sign in.
  runInWindow('window.SPICY_CONFIG = { supabaseUrl: "https://xyz.supabase.co", supabaseAnonKey: "k" };');
  window.localStorage.setItem('spicyshelves.offline', '1');
  probe('renderTopbar()');
  q('#menu-btn').click(); await tick();
  ok('offline menu has Settings and Sign in', JSON.stringify(menuIds()) === '["settings","signin"]');
  q('#menu-pop [data-m="signin"]').click(); await tick();
  ok('Sign in clears the offline flag and shows the gate',
    lsGet('spicyshelves.offline') === null && !!q('#gate-signin'));
  runInWindow('delete window.SPICY_CONFIG;');
  window.localStorage.removeItem('spicyshelves.offline');
  probe('renderTopbar()');

  // Signed in → avatar + Profile / Settings / Logout.
  runInWindow('cloudUser = { id: "u1", email: "wife@example.com" };');
  probe('renderTopbar()');
  ok('signed-in menu button shows the account initial', q('#menu-btn').textContent.trim().toLowerCase() === 'w');
  q('#menu-btn').click(); await tick();
  ok('signed-in menu has Profile / Settings / Logout', JSON.stringify(menuIds()) === '["profile","settings","logout"]');
  ok('menu shows the account email', q('#menu-pop .menu-email').textContent === 'wife@example.com');
  window.document.body.click(); await tick();
  ok('clicking outside closes the menu', q('#menu-pop').hidden);

  // Profile view.
  q('#menu-btn').click(); await tick();
  q('#menu-pop [data-m="profile"]').click(); await tick();
  ok('profile view renders', !!q('#pf-first') && !!q('#pf-last'));
  ok('email field is read-only', !!q('#pf-last') && !!q('input[disabled]'));
  ok('email shows the account address', Array.from(qa('input')).some(i => i.value === 'wife@example.com'));
  ok('six themed default avatars offered', probe('DEFAULT_AVATARS.length') === 6);
  q('#pf-change').click(); await tick();
  ok('picker opens with six defaults + upload + initial',
    qa('#pf-picker [data-av]').length === 8);
  ok('avatar image files exist', probe("DEFAULT_AVATARS.every(a => a.src.indexOf('img/avatars/avatar-') === 0)"));

  // Save names.
  q('#pf-first').value = 'Ada';
  q('#pf-last').value = 'Lovelace';
  q('#pf-save').click(); await tick();
  const saved = JSON.parse(lsGet('spicyshelves.profile.u1'));
  ok('names saved to the per-user profile slot', saved.firstName === 'Ada' && saved.lastName === 'Lovelace');
  ok('menu button initial follows the first name', q('#menu-btn').textContent.trim() === 'A');

  // Pick a themed default.
  q('#pf-change').click(); await tick();
  q('#pf-picker [data-av="raven"]').click(); await tick();
  const saved2 = JSON.parse(lsGet('spicyshelves.profile.u1'));
  ok('default avatar choice saved', saved2.avatar.type === 'default' && saved2.avatar.id === 'raven');
  ok('topbar shows the chosen avatar image', q('#menu-btn img') && q('#menu-btn img').src.includes('avatar-raven.webp'));
  q('#pf-change').click(); await tick();
  ok('chosen avatar marked selected', !!q('#pf-picker [data-av="raven"].sel'));

  // Back button returns home.
  q('#pf-back').click(); await tick();
  ok('back button returns to the library', probe('view') === 'library');

  // Settings still reachable from the menu.
  q('#menu-btn').click(); await tick();
  q('#menu-pop [data-m="settings"]').click(); await tick();
  ok('settings opens from the menu', probe('view') === 'settings' && !!q('#st-back'));
  q('#st-back').click(); await tick();
  ok('settings back button returns home', probe('view') === 'library');

  // adoptCloudProfile: cloud metadata adopted when local slot is empty…
  runInWindow('cloudUser = { id: "u9", email: "x@y.z" };');
  runInWindow('adoptCloudProfile({ id: "u9", email: "x@y.z", user_metadata: { first_name: "Cloud", last_name: "Name", avatar_id: "moon" } });');
  const adopted = JSON.parse(lsGet('spicyshelves.profile.u9'));
  ok('cloud names adopted on sign-in', adopted.firstName === 'Cloud' && adopted.lastName === 'Name');
  ok('cloud default avatar adopted on sign-in', adopted.avatar.type === 'default' && adopted.avatar.id === 'moon');
  // …but local edits always win.
  runInWindow('saveProfile({ firstName: "Local", lastName: "", avatar: { type: "letter" } });');
  runInWindow('adoptCloudProfile({ id: "u9", email: "x@y.z", user_metadata: { first_name: "Cloud", last_name: "Name", avatar_id: "moon" } });');
  const kept = JSON.parse(lsGet('spicyshelves.profile.u9'));
  ok('local name wins over cloud metadata', kept.firstName === 'Local');
  ok('local avatar choice wins over cloud metadata', kept.avatar.type === 'letter');
  ok('bogus avatar ids never adopted', (() => {
    runInWindow('cloudUser = { id: "u10", email: "z@z.z" };');
    runInWindow('adoptCloudProfile({ id: "u10", email: "z@z.z", user_metadata: { avatar_id: "nope" } });');
    return lsGet('spicyshelves.profile.u10') === null;
  })());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
