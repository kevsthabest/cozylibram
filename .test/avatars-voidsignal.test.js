// Voidsignal avatar set (v544): eight original Darknet-inspired avatars
// (Daemon / Freedom(TM) reference — network webs, AR overlays, circuits,
// cornfields; never outer space) join DEFAULT_AVATARS as a third set,
// mirroring the v542 Stormrider shape. Registration in js/105 IS the sync
// allowlist, so the pins here are: all 22 ids registered with set/premium
// shape, sw.js precache == the registered ids exactly, every file exists
// on disk as a sane WebP, the picker renders three grouped sets, a
// Voidsignal id survives loadProfile / themedOrLetterAvatar validation,
// and — the v542 production catch as a pin — the eight new files' corner
// pixels are the set's deep blue-black ground, not a baked white
// app-icon frame (corners sampled by decoding the shipped WebPs).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
const VOIDSIGNAL = ['darknet', 'visor', 'daemon', 'cornsignal', 'drone', 'circuitkey', 'strands', 'silo'];

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

// Decode each shipped WebP with PIL and report, per file, the brightest
// corner channel mean (16x16 patches inset 2px). The v542 catch was a
// white app-icon frame baked into the generated art: white corners read
// ~255, this set's ground (#0a0f14) reads ~20 — the threshold sits far
// from both. Fails loudly if the decode tooling is unavailable.
function cornerMaxima(files) {
  const script = [
    'import sys, json',
    'from PIL import Image',
    'out = []',
    'for f in sys.argv[1:]:',
    '    im = Image.open(f).convert("RGB")',
    '    w, h = im.size',
    '    m = 0',
    '    for (x, y) in [(2, 2), (w-18, 2), (2, h-18), (w-18, h-18)]:',
    '        px = list(im.crop((x, y, x+16, y+16)).getdata())',
    '        for c in range(3):',
    '            m = max(m, sum(p[c] for p in px) / len(px))',
    '    out.append(round(m, 1))',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script].concat(files), { encoding: 'utf8' }).trim());
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
  ok('the eight Stormrider avatars still carry set stormrider + premium flag',
    STORMRIDER.every(id => byId[id] && byId[id].set === 'stormrider' && byId[id].premium === true));
  ok('the eight Voidsignal avatars carry set voidsignal + premium flag (alpha: flagged, never locked)',
    VOIDSIGNAL.every(id => byId[id] && byId[id].set === 'voidsignal' && byId[id].premium === true));
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

  /* ---- corner pixels: no baked app-icon frame on the new set ---- */
  let maxima = null;
  try {
    maxima = cornerMaxima(VOIDSIGNAL.map(id => path.join(APP_DIR, 'img/avatars/avatar-' + id + '.webp')));
  } catch (e) { maxima = null; }
  ok('corner pixel check ran (python3 + PIL decode of the shipped WebPs)', Array.isArray(maxima) && maxima.length === 8);
  ok('all eight Voidsignal corners are the deep blue-black ground (brightest corner channel mean <= 60; a baked white frame reads ~255)',
    !!maxima && maxima.every(m => m <= 60));

  /* ---- sw.js precache == registered ids, exactly ---- */
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  const m = sw.match(/const AVATARS = \[([^\]]+)\]/);
  const swIds = m ? Array.from(m[1].matchAll(/'([^']+)'/g)).map(x => x[1]) : [];
  ok('sw.js AVATARS precache lists all 22 ids, no more, no fewer',
    swIds.length === 22 && avatars.every(a => swIds.includes(a.id)));

  /* ---- sync validation: a Voidsignal id round-trips like a Classic ---- */
  ok('themedOrLetterAvatar accepts a Voidsignal id',
    JSON.stringify(probe("themedOrLetterAvatar('silo')")) === '{"type":"default","id":"silo"}');
  ok('themedOrLetterAvatar still rejects a bogus id',
    JSON.stringify(probe("themedOrLetterAvatar('nope')")) === '{"type":"letter"}');
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Operative', avatar: { type: 'default', id: 'darknet' } }));
  const loaded = probe('loadProfile()');
  ok('loadProfile keeps a synced Voidsignal avatar', loaded.avatar.type === 'default' && loaded.avatar.id === 'darknet');
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Operative', avatar: { type: 'default', id: 'not-a-real-id' } }));
  ok('loadProfile drops a bogus synced avatar id to the initial',
    probe('loadProfile()').avatar.type === 'letter');
  window.localStorage.removeItem('spicyshelves.profile.offline');

  /* ---- picker: three grouped sets, selection saves + syncs as before ---- */
  runInWindow('cloudUser = { id: "u1", email: "operative@example.com" };');
  probe('renderTopbar()');
  q('#menu-btn').click(); await tick();
  q('#menu-pop [data-m="profile"]').click(); await tick();
  q('#pf-change').click(); await tick();
  ok('picker renders all three set headings in AVATAR_SETS order',
    JSON.stringify(qa('#pf-picker .pf-set-label').map(e => e.textContent)) === '["Libram Classics","Stormrider","Voidsignal"]');
  ok('picker offers 22 avatars + upload + initial', qa('#pf-picker [data-av]').length === 24);
  const gridOf = (id) => {
    const btn = q('#pf-picker [data-av="' + id + '"]');
    const grid = btn && btn.closest('.pf-grid');
    const label = grid && grid.previousElementSibling;
    return label && label.classList.contains('pf-set-label') ? label.textContent : '';
  };
  ok('Voidsignal tiles sit under the Voidsignal heading',
    VOIDSIGNAL.every(id => gridOf(id) === 'Voidsignal'));
  ok('Stormrider tiles still sit under the Stormrider heading', gridOf('tabby') === 'Stormrider');
  q('#pf-picker [data-av="cornsignal"]').click(); await tick();
  const saved = JSON.parse(lsGet('spicyshelves.profile.u1'));
  ok('choosing a Voidsignal avatar saves it as a default avatar',
    saved.avatar.type === 'default' && saved.avatar.id === 'cornsignal');
  ok('topbar shows the chosen Voidsignal avatar image',
    !!q('#menu-btn img') && q('#menu-btn img').src.includes('avatar-cornsignal.webp'));
  q('#pf-change').click(); await tick();
  ok('chosen Voidsignal avatar is marked selected in the picker',
    !!q('#pf-picker [data-av="cornsignal"].sel'));

  console.log(`\navatars-voidsignal: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
