// Issue #214: picker-sized avatar derivatives. Painted avatars ship at
// 1600x1600 (2,246 KB across the 22-file catalog) but picker tiles render
// at <=84 CSS px and collection heroes at 52px — the picker must paint
// from ~256px derivatives (img/avatars/thumb/) and reserve the full-size
// originals for the applied/evaluated renders (fitting room, topbar,
// profile). Derivatives are runtime-cached, NEVER precached (the v500 /
// v558 pattern): the 2.25 MB of originals is already the precache cost;
// the thumbs must not add install weight.
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
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

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
  const avatars = probe('DEFAULT_AVATARS');
  const CLASSICS = ['rose', 'moon', 'dragon', 'raven', 'book', 'crown'];

  /* ---- disk: a 256px derivative exists per registered avatar ---- */
  let allExist = true, allDims = true, allSmaller = true, totOrig = 0, totThumb = 0;
  avatars.forEach(a => {
    const origP = path.join(APP_DIR, a.src);
    const thumbP = path.join(APP_DIR, 'img/avatars/thumb/avatar-' + a.id + '.webp');
    if (!fs.existsSync(thumbP)) { allExist = false; return; }
    const dim = webpSize(fs.readFileSync(thumbP));
    if (!dim || dim.w !== 256 || dim.h !== 256) allDims = false;
    const so = fs.statSync(origP).size, st = fs.statSync(thumbP).size;
    if (!(st < so)) allSmaller = false;
    totOrig += so; totThumb += st;
  });
  ok('a thumb derivative exists for every registered avatar', allExist);
  ok('every thumb is a 256x256 WebP', allDims);
  ok('every thumb is smaller than its original', allSmaller);
  ok('thumb catalog totals at least 5x fewer bytes than the originals (' +
    totThumb + ' vs ' + totOrig + ')', totThumb * 5 <= totOrig);

  /* ---- the generator is in the repo and reproducible ---- */
  const scriptP = path.join(APP_DIR, 'scripts/avatar-thumbs.py');
  ok('scripts/avatar-thumbs.py exists', fs.existsSync(scriptP));
  if (fs.existsSync(scriptP)) {
    const s = fs.readFileSync(scriptP, 'utf8');
    ok('the generator names the 256px size and the thumb dir',
      s.includes('256') && s.includes('img/avatars/thumb'));
  }

  /* ---- sw.js: thumbs are runtime-cached, never precached ---- */
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  const avatarsLine = sw.split('\n').find(l => l.startsWith('const AVATARS'));
  ok('sw.js AVATARS precache still lists originals only (no thumb paths)',
    !!avatarsLine && !avatarsLine.includes('thumb'));
  ok('sw.js declares the dedicated avatar-thumbs runtime cache',
    sw.includes("const AVATAR_THUMB_CACHE = 'cozy-libram-avatar-thumbs';"));
  ok('the activate keep-list retains the avatar-thumbs cache',
    /k !== AVATAR_THUMB_CACHE/.test(sw));
  const thumbRuleAt = sw.indexOf("url.pathname.indexOf(AVATAR_THUMBS_PATH)");
  const genericAt = sw.indexOf("caches.match(e.request).then((hit) => hit || fetch(e.request))");
  ok('a fetch rule serves /img/avatars/thumb/ before the generic same-origin branch',
    thumbRuleAt > -1 && genericAt > -1 && thumbRuleAt < genericAt);

  /* ---- picker behaviour: grids + heroes paint thumbs, fitting room
         and the applied-avatar path keep the full-size original ---- */
  ok('painted candidates carry a thumb path', (() => {
    const items = probe("pickerCollections().find(c => c.key === 'painted:classics').items");
    return items.length === 6 && items.every(c => c.thumb === 'img/avatars/thumb/avatar-' + c.id + '.webp');
  })());
  ok('sticker candidates are untouched (no thumb)', (() => {
    const c = probe("stickerCandidateFromId('stk:velvet/velvet-a-01')");
    return !!c && !c.thumb;
  })());

  window.localStorage.setItem('spicyshelves.profile.u1',
    JSON.stringify({ firstName: 'Ink', lastName: '', avatar: { type: 'letter' } }));
  const runInWindow = (js) => {
    const sc = window.document.createElement('script');
    sc.textContent = js; window.document.body.appendChild(sc);
  };
  runInWindow('cloudUser = { id: "u1", email: "ink@example.com" };');
  probe('renderTopbar()');
  q('#menu-btn').click(); await tick();
  q('#menu-pop [data-m="profile"]').click(); await tick();
  q('#pf-change').click(); await tick();
  ok('the picker sheet opens', !!q('#avatar-picker'));

  const heroSrcs = qa('#apk-stage1 [data-apk-col^="painted:"] .apk-card-hero img').map(i => i.getAttribute('src'));
  ok('stage-1 painted collection heroes paint the thumbs',
    heroSrcs.length === 3 && heroSrcs.every(s => s.indexOf('img/avatars/thumb/avatar-') === 0));

  q('#apk-stage1 [data-apk-col="painted:classics"]').click(); await tick();
  const tileSrcs = qa('#apk-stage2 .apk-tile img').map(i => i.getAttribute('src'));
  ok('the Classics grid renders all 6 tiles from thumbs',
    tileSrcs.length === 6 &&
    JSON.stringify(tileSrcs) === JSON.stringify(CLASSICS.map(id => 'img/avatars/thumb/avatar-' + id + '.webp')));

  qa('#apk-stage2 .apk-tile')[0].click(); await tick();
  const fitSrc = q('#apk-fit-big img') ? q('#apk-fit-big img').getAttribute('src') : '';
  ok('the fitting-room preview still renders the full-size original',
    fitSrc === 'img/avatars/avatar-rose.webp');

  // A sticker grid is byte-identical to before: no thumb paths anywhere.
  probe('closeAvatarPicker()');
  q('#pf-change').click(); await tick();
  q('#apk-stage1 [data-apk-col="stickers:velvet"]').click(); await tick();
  const stkSrcs = qa('#apk-stage2 .apk-tile img').map(i => i.getAttribute('src'));
  ok('sticker grids never reference avatar thumbs',
    stkSrcs.length > 0 && stkSrcs.every(s => s.indexOf('avatars/thumb') === -1));

  ok('avatarSrc (applied renders) still returns the original',
    probe("avatarSrc({ avatar: { type: 'default', id: 'crown' } })") === 'img/avatars/avatar-crown.webp');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
