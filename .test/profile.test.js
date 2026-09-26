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
  ok('on wide screens the menu docks to the top-right corner next to the nav', (() => {
    const css = fs.readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8');
    const mq = css.indexOf('@media (min-width: 760px)');
    const rule = css.indexOf('.topbar-menu-wrap', mq);
    const chunk = css.slice(rule, rule + 120);
    return mq > -1 && rule > mq && chunk.includes('position: fixed') && chunk.includes('right: 14px');
  })());

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

  // ---- profiles table sync (last-write-wins across devices) ----
  const mkStub = () => {
    const rows = {};
    return { rows, from: (table) => {
      if (table !== 'profiles') throw new Error('unexpected table ' + table);
      return {
        select: () => ({ eq: (col, val) => ({ maybeSingle: async () => ({ data: rows[val] || null, error: null }) }) }),
        upsert: async (row) => { rows[row.user_id] = Object.assign({}, row); return { error: null }; },
      };
    } };
  };
  const stub = mkStub();
  window.__sbStub = stub;
  const cloudRow = (uid, patch) => Object.assign(
    { user_id: uid, first_name: 'Cloud', last_name: 'Woman', avatar_id: 'moon', updated_at: new Date().toISOString() }, patch || {});
  const useAs = (uid) => runInWindow('cloudUser = { id: "' + uid + '", email: "' + uid + '@x.y" };');
  const wipeLocal = (uid) => window.localStorage.removeItem('spicyshelves.profile.' + uid);

  // Fresh device adopts the cloud profile.
  useAs('u20'); wipeLocal('u20');
  stub.rows['u20'] = cloudRow('u20', { updated_at: new Date(Date.now() + 60000).toISOString() });
  await probe('syncCloudProfile()'); await tick();
  const adopted = JSON.parse(lsGet('spicyshelves.profile.u20'));
  ok('fresh device adopts cloud names', adopted.firstName === 'Cloud' && adopted.lastName === 'Woman');
  ok('fresh device adopts cloud avatar', adopted.avatar.type === 'default' && adopted.avatar.id === 'moon');
  ok('topbar shows the adopted avatar', !!q('#menu-btn img') && q('#menu-btn img').src.includes('avatar-moon.webp'));

  // Newer local edit wins and pushes up.
  useAs('u21'); wipeLocal('u21');
  stub.rows['u21'] = cloudRow('u21', { first_name: 'Old', updated_at: new Date(Date.now() - 60000).toISOString() });
  runInWindow('touchProfile({ firstName: "Local", lastName: "Edit", avatar: { type: "letter" }, updatedAt: 0 });');
  await probe('syncCloudProfile()'); await tick();
  ok('newer local edit wins over the cloud row', stub.rows['u21'].first_name === 'Local');
  ok('local profile untouched when it wins', JSON.parse(lsGet('spicyshelves.profile.u21')).firstName === 'Local');

  // Newer cloud row wins and overwrites local.
  useAs('u22'); wipeLocal('u22');
  runInWindow('saveProfile({ firstName: "Stale", lastName: "", avatar: { type: "letter" }, updatedAt: ' + (Date.now() - 60000) + ' });');
  stub.rows['u22'] = cloudRow('u22', { first_name: 'Fresh', updated_at: new Date().toISOString() });
  await probe('syncCloudProfile()'); await tick();
  ok('newer cloud row overwrites stale local', JSON.parse(lsGet('spicyshelves.profile.u22')).firstName === 'Fresh');

  // Bogus avatar ids fall back to the initial.
  useAs('u23'); wipeLocal('u23');
  stub.rows['u23'] = cloudRow('u23', { avatar_id: 'nope', updated_at: new Date(Date.now() + 60000).toISOString() });
  await probe('syncCloudProfile()'); await tick();
  ok('bogus cloud avatar id falls back to initial', JSON.parse(lsGet('spicyshelves.profile.u23')).avatar.type === 'letter');

  // No cloud row yet + local content → row created.
  useAs('u24'); wipeLocal('u24');
  delete stub.rows['u24'];
  runInWindow('touchProfile({ firstName: "Solo", lastName: "", avatar: { type: "default", id: "dragon" }, updatedAt: 0 });');
  await probe('syncCloudProfile()'); await tick();
  ok('first sync creates the cloud row', stub.rows['u24'] && stub.rows['u24'].first_name === 'Solo');
  ok('avatar id stored in the row', stub.rows['u24'].avatar_id === 'dragon');

  // ---- profile photos in the private `avatars` bucket ----
  const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes-1234').toString('base64');
  const mkFullStub = () => {
    const rows = {};
    const files = {};
    return { rows, files,
      from: (table) => {
        if (table !== 'profiles') throw new Error('unexpected table ' + table);
        return {
          select: () => ({ eq: (col, val) => ({ maybeSingle: async () => ({ data: rows[val] || null, error: null }) }) }),
          upsert: async (row) => { rows[row.user_id] = Object.assign({}, row); return { error: null }; },
        };
      },
      storage: { from: (bucket) => {
        if (bucket !== 'avatars') throw new Error('unexpected bucket ' + bucket);
        return {
          upload: async (path, blob) => { files[path] = blob; return { error: null }; },
          download: async (path) => files[path]
            ? { data: files[path], error: null }
            : { data: null, error: { message: 'not found' } },
        };
      } },
    };
  };
  const fstub = mkFullStub();
  window.__sbStub = fstub;
  const toBlob = window.eval('dataUrlToBlob');

  // New photo picked → uploaded to the bucket, path stored in the row.
  useAs('u30'); wipeLocal('u30');
  runInWindow('touchProfile({ firstName: "Pic", lastName: "", avatar: { type: "upload", dataUrl: "' + PHOTO + '" }, avatarCloudPath: "", updatedAt: 0 });');
  await probe('pushCloudProfile(loadProfile())'); await tick();
  ok('uploaded photo lands in the avatars bucket', !!fstub.files['u30/avatar.jpg']);
  ok('row points at the photo path', fstub.rows['u30'] && fstub.rows['u30'].avatar_path === 'u30/avatar.jpg');
  ok('local profile remembers the cloud path', JSON.parse(lsGet('spicyshelves.profile.u30')).avatarCloudPath === 'u30/avatar.jpg');

  // Fresh device downloads the photo the winning row points at.
  useAs('u31'); wipeLocal('u31');
  fstub.files['u31/avatar.jpg'] = toBlob(PHOTO);
  fstub.rows['u31'] = cloudRow('u31', { avatar_id: '', avatar_path: 'u31/avatar.jpg', updated_at: new Date(Date.now() + 60000).toISOString() });
  await probe('syncCloudProfile()'); await tick();
  const got = JSON.parse(lsGet('spicyshelves.profile.u31'));
  ok('fresh device downloads the cloud photo', got.avatar.type === 'upload' && got.avatar.dataUrl === PHOTO);
  ok('downloaded photo path remembered', got.avatarCloudPath === 'u31/avatar.jpg');

  // Switching to a themed avatar clears the cloud photo reference.
  useAs('u32'); wipeLocal('u32');
  fstub.rows['u32'] = cloudRow('u32', { avatar_path: 'u32/avatar.jpg', updated_at: new Date(Date.now() - 60000).toISOString() });
  runInWindow('touchProfile({ firstName: "X", lastName: "", avatar: { type: "letter" }, avatarCloudPath: "u32/avatar.jpg", updatedAt: 0 });');
  await probe('syncCloudProfile()'); await tick();
  ok('themed avatar clears the cloud photo reference', fstub.rows['u32'].avatar_path === '');

  // Same photo on both sides → no re-download.
  useAs('u33'); wipeLocal('u33');
  const localPhoto = 'data:image/jpeg;base64,' + Buffer.from('local-bytes').toString('base64');
  const otherPhoto = 'data:image/jpeg;base64,' + Buffer.from('other-bytes').toString('base64');
  fstub.files['u33/avatar.jpg'] = toBlob(otherPhoto);
  fstub.rows['u33'] = cloudRow('u33', { first_name: 'New', avatar_path: 'u33/avatar.jpg', updated_at: new Date().toISOString() });
  runInWindow('saveProfile({ firstName: "Old", lastName: "", avatar: { type: "upload", dataUrl: "' + localPhoto + '" }, avatarCloudPath: "u33/avatar.jpg", updatedAt: ' + (Date.now() - 60000) + ' });');
  await probe('syncCloudProfile()'); await tick();
  const keptPhoto = JSON.parse(lsGet('spicyshelves.profile.u33'));
  ok('names still update from the newer row', keptPhoto.firstName === 'New');
  ok('identical photo path is not re-downloaded', keptPhoto.avatar.dataUrl === localPhoto);

  // Photo missing from the bucket → graceful fallback, no crash.
  useAs('u34'); wipeLocal('u34');
  delete fstub.files['u34/avatar.jpg'];
  fstub.rows['u34'] = cloudRow('u34', { avatar_id: 'raven', avatar_path: 'u34/avatar.jpg', updated_at: new Date(Date.now() + 60000).toISOString() });
  await probe('syncCloudProfile()'); await tick();
  const fellBack = JSON.parse(lsGet('spicyshelves.profile.u34'));
  ok('missing cloud photo falls back to the themed avatar', fellBack.avatar.type === 'default' && fellBack.avatar.id === 'raven');

  window.__sbStub = null;

  // Empty everywhere → nothing pushed.
  useAs('u26'); wipeLocal('u26');
  delete stub.rows['u26'];
  await probe('syncCloudProfile()'); await tick();
  ok('blank profile creates no cloud row', !stub.rows['u26']);

  // v37 legacy bridge: user_metadata carried forward once.
  useAs('u27'); wipeLocal('u27');
  delete stub.rows['u27'];
  runInWindow('adoptLegacyMetadata({ id: "u27", user_metadata: { first_name: "Old", last_name: "Meta", avatar_id: "raven" } });');
  const bridged = JSON.parse(lsGet('spicyshelves.profile.u27'));
  ok('legacy metadata adopted once', bridged.firstName === 'Old' && bridged.avatar.id === 'raven');
  runInWindow('saveProfile({ firstName: "Changed", lastName: "", avatar: { type: "letter" }, updatedAt: 0 });');
  runInWindow('adoptLegacyMetadata({ id: "u27", user_metadata: { first_name: "Old", last_name: "Meta", avatar_id: "raven" } });');
  ok('legacy bridge never overwrites local edits', JSON.parse(lsGet('spicyshelves.profile.u27')).firstName === 'Changed');
  window.__sbStub = null;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
