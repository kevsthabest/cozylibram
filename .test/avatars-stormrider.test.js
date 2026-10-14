// Stormrider avatar set (v542): eight original dragon-rider avatars join
// DEFAULT_AVATARS as a second set. Registration in js/105 IS the sync
// allowlist, so the pins here are: all ids registered with set/premium
// shape, sw.js precaches every id, every file exists on disk as a sane
// WebP, the picker renders grouped by set, and a Stormrider id survives
// the same loadProfile / themedOrLetterAvatar validation a Classic does.
// v544 re-pin: catalog totals moved 14 -> 22 when the Voidsignal set
// landed (shared-shape pins below follow the catalog; the Stormrider
// set's own pins are unchanged). The Voidsignal suite carries the new
// set's own pins, including the corner-pixel check.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { loadApp, APP_DIR } = require('./harness');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in avatar tests'); };
window.confirm = () => true;

loadApp(window);

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

const CLASSICS = ['rose', 'moon', 'dragon', 'raven', 'book', 'crown'];
const STORMRIDER = ['onyxdragon', 'golddragon', 'egg', 'daggers', 'goggles', 'parapet', 'ring', 'tabby'];

function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

(async () => {
  await tick(3);

  /* ---- registration shape (js/105 DEFAULT_AVATARS + AVATAR_SETS) ---- */
  const avatars = probe('DEFAULT_AVATARS');
  ok('22 default avatars registered', avatars.length === 22);
  ok('avatar ids are unique', new Set(avatars.map(a => a.id)).size === 22);
  ok('avatar ids are lowercase URL-safe', avatars.every(a => /^[a-z]+$/.test(a.id)));
  ok('AVATAR_SETS declares classics + stormrider + voidsignal',
    JSON.stringify(probe('AVATAR_SETS.map(s => s.key)')) === '["classics","stormrider","voidsignal"]');
  ok('every avatar belongs to a declared set',
    avatars.every(a => probe('AVATAR_SETS').some(s => s.key === a.set)));
  const byId = Object.fromEntries(avatars.map(a => [a.id, a]));
  ok('the six Classics carry set classics and no premium flag',
    CLASSICS.every(id => byId[id] && byId[id].set === 'classics' && !byId[id].premium));
  ok('the eight Stormrider avatars carry set stormrider + premium flag (alpha: flagged, never locked)',
    STORMRIDER.every(id => byId[id] && byId[id].set === 'stormrider' && byId[id].premium === true));
  ok('every src follows img/avatars/avatar-<id>.webp',
    avatars.every(a => a.src === 'img/avatars/avatar-' + a.id + '.webp'));

  /* ---- files on disk ---- */
  let filesOk = true, dimsOk = true, sizesOk = true;
  for (const a of avatars) {
    const f = path.join(APP_DIR, a.src);
    if (!fs.existsSync(f)) { filesOk = false; continue; }
    const buf = fs.readFileSync(f);
    const dim = webpSize(buf);
    if (!dim || dim.w !== 1600 || dim.h !== 1600) dimsOk = false;
    if (buf.length > 400 * 1024) sizesOk = false;
  }
  ok('every registered avatar file exists on disk', filesOk);
  ok('every avatar file is a 1600x1600 WebP', dimsOk);
  ok('every avatar file is <= 400 KB', sizesOk);

  /* ---- sw.js precache covers every registered id ---- */
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  const m = sw.match(/const AVATARS = \[([^\]]+)\]/);
  const swIds = m ? Array.from(m[1].matchAll(/'([^']+)'/g)).map(x => x[1]) : [];
  ok('sw.js AVATARS precache lists all 22 ids',
    swIds.length === 22 && avatars.every(a => swIds.includes(a.id)));

  /* ---- sync validation: a Stormrider id round-trips like a Classic ---- */
  ok('themedOrLetterAvatar accepts a Stormrider id',
    JSON.stringify(probe("themedOrLetterAvatar('tabby')")) === '{"type":"default","id":"tabby"}');
  ok('themedOrLetterAvatar still rejects a bogus id',
    JSON.stringify(probe("themedOrLetterAvatar('nope')")) === '{"type":"letter"}');
  // Signed out → profileKey() is the offline slot; loadProfile is the
  // sanitize-on-read path every device applies to synced profiles.
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Rider', avatar: { type: 'default', id: 'onyxdragon' } }));
  const loaded = probe('loadProfile()');
  ok('loadProfile keeps a synced Stormrider avatar', loaded.avatar.type === 'default' && loaded.avatar.id === 'onyxdragon');
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Rider', avatar: { type: 'default', id: 'not-a-real-id' } }));
  ok('loadProfile drops a bogus synced avatar id to the initial',
    probe('loadProfile()').avatar.type === 'letter');
  window.localStorage.removeItem('spicyshelves.profile.offline');

  /* ---- picker: grouped by set, selection saves + syncs as before ---- */
  runInWindow('cloudUser = { id: "u1", email: "rider@example.com" };');
  probe('renderTopbar()');
  q('#menu-btn').click(); await tick();
  q('#menu-pop [data-m="profile"]').click(); await tick();
  q('#pf-change').click(); await tick();
  ok('picker renders all three set headings, Classics first',
    JSON.stringify(qa('#pf-picker .pf-set-label').map(e => e.textContent)) === '["Libram Classics","Stormrider","Voidsignal"]');
  ok('picker offers 22 avatars + upload + initial', qa('#pf-picker [data-av]').length === 24);
  const gridOf = (id) => {
    const btn = q('#pf-picker [data-av="' + id + '"]');
    const grid = btn && btn.closest('.pf-grid');
    const label = grid && grid.previousElementSibling;
    return label && label.classList.contains('pf-set-label') ? label.textContent : '';
  };
  ok('Classics tiles sit under the Libram Classics heading', gridOf('raven') === 'Libram Classics');
  ok('Stormrider tiles sit under the Stormrider heading',
    STORMRIDER.every(id => gridOf(id) === 'Stormrider'));
  q('#pf-picker [data-av="tabby"]').click(); await tick();
  const saved = JSON.parse(lsGet('spicyshelves.profile.u1'));
  ok('choosing a Stormrider avatar saves it as a default avatar',
    saved.avatar.type === 'default' && saved.avatar.id === 'tabby');
  ok('topbar shows the chosen Stormrider avatar image',
    !!q('#menu-btn img') && q('#menu-btn img').src.includes('avatar-tabby.webp'));
  q('#pf-change').click(); await tick();
  ok('chosen Stormrider avatar is marked selected in the picker',
    !!q('#pf-picker [data-av="tabby"].sel'));

  console.log(`\navatars-stormrider: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
