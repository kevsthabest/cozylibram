// Tests for "The App Dresses for Your Book" (spec: docs/book-dressing-spec.md).
// Pins: accent-only dressing from the CURRENTLY-READING book's CACHED spine
// palette (js/120 spineColorCache — cache-only, no new sampler); the contrast
// gate (built-in floor: no built-in accent scores below ~1.99 against its own
// theme's bg/card, so the gate is 2.0 against BOTH surfaces of the active
// theme, hue preserved, nearest passing lightness); toggle default ON, stored
// as 'off' in the prefs section (v537 roamed home — NOT the frozen v518
// settings list); boot mirror (v543 lesson: last resolved accent re-applied
// pre-paint from localStorage, js/240 re-resolves authoritatively).
'use strict';

let _pass = 0, _fail = 0;
function ok(name, cond) {
  if (cond) { _pass++; }
  else { _fail++; console.log('FAIL - ' + name); }
}
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classicize } = require('./harness');
const ROOT = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function makeLS(seed) {
  return {
    _s: Object.assign({}, seed || {}),
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
  };
}
function makeDocEl() {
  return {
    dataset: {},
    style: {
      _p: {}, _sets: 0,
      setProperty(k, v) { this._p[k] = String(v); this._sets++; },
      removeProperty(k) { delete this._p[k]; },
      getPropertyValue(k) { return this._p[k] || ''; },
    },
  };
}
function loadJS(rel, extra) {
  const sandbox = {
    console: console,
    localStorage: makeLS(),
    module: { exports: {} },
    window: {},
  };
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  // R3 repoint (migration plan §9.3): js/240 is a real ES module since
  // phase 2 batch 6. classicize restores the classic body before vm
  // evaluation (identity on the classic files loaded here). Loading
  // plumbing only — assertions untouched.
  try { vm.runInContext(classicize(read(rel), rel), sandbox, { filename: rel }); } catch (e) { /* top-level DOM touches may throw in stubs */ }
  return sandbox;
}

/* ---------- theming (real THEME_PREVIEW / getTheme) ---------- */
const themeSbx = loadJS('js/010-theming.js', {});
const themePreview = themeSbx.themePreview || vm.runInContext('themePreview', themeSbx);

/* ---------- the dressing module, fully stubbed environment ---------- */
function dressEnv(opts) {
  opts = opts || {};
  const ls = makeLS(opts.ls);
  const docEl = makeDocEl();
  const toasts = [];
  const sbx = loadJS('js/240-book-dressing.js', {
    localStorage: ls,
    document: { documentElement: docEl },
    library: opts.library || [],
    spineColorCache: opts.cache || {},
    getTheme: () => opts.theme || 'dark',
    themePreview: themePreview,
    toast: m => toasts.push(m),
  });
  return { sbx, ls, docEl, toasts };
}

const M = dressEnv({}).sbx.module.exports;
ok('module exports present', !!M && typeof M.resolveBookDressing === 'function' && typeof M.refreshBookDressing === 'function');
const { dressingGate, dressingContrast, dressingHue, DRESSING_GATE_MIN, BOOK_DRESS_KEY } = M;

/* ---------- gate maths ---------- */
eq('gate floor is the measured built-in floor', DRESSING_GATE_MIN, 2.0);
// every built-in accent passes the gate against its own theme's surfaces
{
  const THEMES = ['dark', 'light', 'hearthside', 'candlelight', 'twilight', 'verdant', 'midnight', 'velvet', 'abyss', 'frost', 'haunt', 'yuletide', 'fete', 'amour', 'shamrock', 'pastel', 'harvest', 'solstice', 'stormrider', 'briarthrone', 'voidsignal', 'wisp', 'wisp-night'];
  let allPass = true;
  for (const t of THEMES) {
    const pv = themePreview(t);
    if (!dressingGate(pv.accent, [pv.bg, pv.card])) { allPass = false; console.log('  built-in fails own gate:', t, pv.accent); }
  }
  ok('all 23 built-in accents pass the gate on their own theme', allPass);
}
// a washout pale cover on the Light theme is pulled to a passing shade, hue kept
{
  const pv = themePreview('light');
  const g = dressingGate('#f2e2a0', [pv.bg, pv.card]);
  ok('pale cover on Light still dresses (lightness pulled)', !!g);
  ok('gated accent passes vs bg', g && dressingContrast(g.accent, pv.bg) >= DRESSING_GATE_MIN - 1e-9);
  ok('gated accent passes vs card', g && dressingContrast(g.accent, pv.card) >= DRESSING_GATE_MIN - 1e-9);
  ok('hue preserved through the gate', g && Math.abs(dressingHue(g.accent) - dressingHue('#f2e2a0')) < 6);
  ok('deep is a darker sibling of accent', g && dressingContrast(g.deep, '#000000') < dressingContrast(g.accent, '#000000'));
}
// a near-black cover on the Dark theme is lifted to a passing shade
{
  const pv = themePreview('dark');
  const g = dressingGate('#1c1030', [pv.bg, pv.card]);
  ok('near-black cover on Dark still dresses (lightness lifted)', !!g);
  ok('lifted accent passes vs card', g && dressingContrast(g.accent, pv.card) >= DRESSING_GATE_MIN - 1e-9);
}
// gate failures: near-gray has no hue worth wearing; an impossible bar fails closed
eq('near-gray cover fails the gate (chroma floor)', dressingGate('#8a8a8a', ['#14101a', '#241a30']), null);
eq('impossible threshold fails closed', dressingGate('#8b5cf6', ['#14101a', '#241a30'], 21), null);
// determinism
{
  const a = dressingGate('#7a4a21', ['#faf5ec', '#fffdf7']);
  const b = dressingGate('#7a4a21', ['#faf5ec', '#fffdf7']);
  eq('gate is deterministic', JSON.stringify(a), JSON.stringify(b));
}

/* ---------- fixtures ---------- */
const coverA = 'https://covers.example/a.jpg';
const coverB = 'https://covers.example/b.jpg';
const readingBook = { id: 'bkA', title: 'Ember Court', status: 'reading', cover: coverA, lastPagedAt: '2026-10-14T20:00:00.000Z', _mtime: 100 };
const cacheA = { bkA: { hex: '#7a2a3a', cover: coverA } };

/* ---------- resolve: the four brief pins + selection rules ---------- */
{
  // no current-reading book -> theme accents unchanged
  const e = dressEnv({ library: [{ id: 'x', title: 'T', status: 'read', cover: coverA }], cache: cacheA });
  eq('no reading book -> no dressing', e.sbx.module.exports.resolveBookDressing(), null);
}
{
  // palette present + gate passes -> accents follow
  const e = dressEnv({ library: [readingBook], cache: cacheA });
  const r = e.sbx.module.exports.resolveBookDressing();
  ok('reading + cached palette -> dresses', !!r && r.bookId === 'bkA');
  const pv = themePreview('dark');
  ok('resolved accent passes the gate on the active theme', !!r && dressingContrast(r.accent, pv.bg) >= 2.0 - 1e-9 && dressingContrast(r.accent, pv.card) >= 2.0 - 1e-9);
  ok('resolved accent keeps the cover hue', !!r && Math.abs(dressingHue(r.accent) - dressingHue('#7a2a3a')) < 6);
}
{
  // cache-only: a reading book whose cover was never sampled does not dress
  const e = dressEnv({ library: [readingBook], cache: {} });
  eq('reading but palette not cached -> no dressing (no new sampler)', e.sbx.module.exports.resolveBookDressing(), null);
}
{
  // stale palette: cache entry for a previous cover is ignored
  const e = dressEnv({ library: [readingBook], cache: { bkA: { hex: '#7a2a3a', cover: 'https://covers.example/old.jpg' } } });
  eq('stale cache entry (cover changed) -> no dressing', e.sbx.module.exports.resolveBookDressing(), null);
}
{
  // gate fails at resolve level: near-gray cached palette -> theme accents kept
  const e = dressEnv({ library: [readingBook], cache: { bkA: { hex: '#8a8a8a', cover: coverA } } });
  eq('near-gray palette -> gate fails -> no dressing', e.sbx.module.exports.resolveBookDressing(), null);
}
{
  // several reading: most recent progress update wins (lastPagedAt), not _mtime
  const older = { id: 'bkOld', title: 'Old', status: 'reading', cover: coverA, lastPagedAt: '2026-10-10T09:00:00.000Z', _mtime: 9999 };
  const newer = { id: 'bkNew', title: 'New', status: 'reading', cover: coverB, lastPagedAt: '2026-10-14T09:00:00.000Z', _mtime: 5 };
  const e = dressEnv({ library: [older, newer], cache: { bkOld: { hex: '#7a2a3a', cover: coverA }, bkNew: { hex: '#2a4a7a', cover: coverB } } });
  const r = e.sbx.module.exports.resolveBookDressing();
  eq('most recent progress update wins', r && r.bookId, 'bkNew');
}
{
  // toggle OFF -> never dresses
  const e = dressEnv({ library: [readingBook], cache: cacheA, ls: { [BOOK_DRESS_KEY]: 'off' } });
  eq('toggle OFF -> no dressing even with reading book + palette', e.sbx.module.exports.resolveBookDressing(), null);
  eq('bookDressingEnabled reads the key live', e.sbx.module.exports.bookDressingEnabled(), false);
}
{
  const e = dressEnv({});
  eq('toggle defaults ON (key absent)', e.sbx.module.exports.bookDressingEnabled(), true);
}

/* ---------- refresh: DOM application ---------- */
{
  const e = dressEnv({ library: [readingBook], cache: cacheA });
  e.sbx.refreshBookDressing();
  ok('refresh sets inline --accent', /^#[0-9a-f]{6}$/.test(e.docEl.style.getPropertyValue('--accent')));
  ok('refresh sets inline --accent-deep', /^#[0-9a-f]{6}$/.test(e.docEl.style.getPropertyValue('--accent-deep')));
  eq('refresh marks data-dressed with the book id', e.docEl.dataset.dressed, 'bkA');
  const applied = JSON.parse(e.ls.getItem('cozylibram.bookdress.applied') || 'null');
  ok('refresh writes the boot-mirror cache', !!applied && applied.accent === e.docEl.style.getPropertyValue('--accent'));
  eq('first activation explains itself once (toast)', e.toasts.length, 1);
  const setsAfterFirst = e.docEl.style._sets;
  e.sbx.refreshBookDressing();
  eq('refresh is idempotent (no redundant style writes)', e.docEl.style._sets, setsAfterFirst);
  eq('explainer toast does not repeat', e.toasts.length, 1);
  // finishing the book undresses: theme cascade returns
  e.sbx.library = [Object.assign({}, readingBook, { status: 'read' })];
  e.sbx.refreshBookDressing();
  eq('book finished -> inline --accent removed', e.docEl.style.getPropertyValue('--accent'), '');
  eq('book finished -> data-dressed removed', e.docEl.dataset.dressed, undefined);
  eq('book finished -> boot-mirror cache cleared', e.ls.getItem('cozylibram.bookdress.applied'), null);
}
{
  // toggle OFF mid-session undresses and stays off
  const e = dressEnv({ library: [readingBook], cache: cacheA });
  e.sbx.refreshBookDressing();
  e.ls.setItem(BOOK_DRESS_KEY, 'off');
  e.sbx.refreshBookDressing();
  eq('toggle OFF -> undresses immediately', e.docEl.style.getPropertyValue('--accent'), '');
  eq('toggle OFF -> data-dressed removed', e.docEl.dataset.dressed, undefined);
}
{
  // nothing reading: refresh writes nothing at all
  const e = dressEnv({ library: [], cache: {} });
  e.sbx.refreshBookDressing();
  eq('no reading book -> no style writes', e.docEl.style._sets, 0);
  eq('no reading book -> no data-dressed', e.docEl.dataset.dressed, undefined);
}

/* ---------- roamed home: the prefs section (v537), settings list untouched ---------- */
{
  const sbx = loadJS('js/229-user-state.js', {});
  const keys = vm.runInContext('PREFS_STATE_KEYS.slice()', sbx);
  ok('prefs section carries the dressing key', keys.includes('cozylibram.bookdress'));
  const settingsKeys = vm.runInContext('USER_STATE_KEYS.slice()', sbx);
  ok('frozen v518 settings list does NOT gain the dressing key', !settingsKeys.includes('cozylibram.bookdress'));
  const ls = sbx.localStorage;
  ls.setItem('cozylibram.bookdress', 'off');
  eq('prefs collect picks up the OFF state', sbx.userStateCollectPrefs().values['cozylibram.bookdress'], 'off');
  sbx.userStateApplyPrefs({ values: {} });
  eq('prefs apply full-snapshot: absent key removed (back to default ON)', ls.getItem('cozylibram.bookdress'), null);
  sbx.userStateApplyPrefs({ values: { 'cozylibram.bookdress': 'off' } });
  eq('prefs apply writes a roamed OFF', ls.getItem('cozylibram.bookdress'), 'off');
}

/* ---------- wiring pins ---------- */
{
  const html = read('index.html');
  // R1 repoint (migration plan §9.3): the tag pin accepts either exact
  // tag form — classic or module; the registration intent is unchanged.
  ok('index.html loads js/240-book-dressing.js',
    html.includes('<script src="js/240-book-dressing.js"></script>') ||
    html.includes('<script type="module" src="js/240-book-dressing.js"></script>'));
  ok('sw.js precaches js/240-book-dressing.js', read('sw.js').includes("'240-book-dressing.js'"));
  const s180 = read('js/180-settings.js');
  ok('Settings > Display renders the toggle', s180.includes('id="st-bookdress"') && s180.includes('Dress for my current book'));
  ok('Settings toggle writes the prefs key', s180.includes("localStorage.setItem('cozylibram.bookdress', 'off')"));
  for (const rel of ['js/010-theming.js', 'js/040-storage.js', 'js/120-favorites.js', 'js/229-user-state.js', 'js/095-gate.js']) {
    ok(rel + ' carries the guarded dressing refresh hook', /typeof refreshBookDressing === 'function'/.test(read(rel)));
  }
}

/* ---------- boot mirror: no undressed flash (v543 lesson) ---------- */
{
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const boot = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
    .find(b => b.includes('dataset.theme') && b.includes('THEME_KEYS'));
  ok('boot resolver exists', !!boot);
  ok('boot resolver mirrors the dressed accent', !!boot && boot.includes("localStorage.getItem('cozylibram.bookdress.applied')"));
  ok('boot mirror respects the toggle', !!boot && boot.includes("localStorage.getItem('cozylibram.bookdress')"));
  function runBoot(stored, withStyle) {
    const docEl = { dataset: {} };
    if (withStyle) docEl.style = { _p: {}, setProperty(k, v) { this._p[k] = v; }, getPropertyValue(k) { return this._p[k] || ''; } };
    const sandbox = { localStorage: makeLS(stored), document: { documentElement: docEl } };
    vm.createContext(sandbox);
    let threw = false;
    try { vm.runInContext(boot, sandbox); } catch (e) { threw = true; }
    return { docEl, threw };
  }
  const applied = JSON.stringify({ accent: '#7a2a3a', deep: '#5c1f2c' });
  let r = runBoot({ 'cozylibram.bookdress.applied': applied }, true);
  eq('boot: stored dressed accent applied pre-paint', r.docEl.style.getPropertyValue('--accent'), '#7a2a3a');
  eq('boot: stored dressed deep applied pre-paint', r.docEl.style.getPropertyValue('--accent-deep'), '#5c1f2c');
  r = runBoot({ 'cozylibram.bookdress.applied': applied, 'cozylibram.bookdress': 'off' }, true);
  eq('boot: toggle OFF -> no dressed mirror', r.docEl.style.getPropertyValue('--accent'), '');
  r = runBoot({ 'cozylibram.bookdress.applied': applied }, false);
  ok('boot: style-less stub (boot-theme harness shape) does not throw', !r.threw);
  r = runBoot({}, true);
  eq('boot: no applied cache -> nothing set', r.docEl.style.getPropertyValue('--accent'), '');
}

console.log('\n' + _pass + ' passed, ' + _fail + ' failed');
process.exit(_fail ? 1 : 0);
