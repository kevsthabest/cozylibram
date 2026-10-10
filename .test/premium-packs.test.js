// v423: premium theme packs — themes, flairs, decorations, gallery.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>',
  { url: 'https://cozylibram.pages.dev/', runScripts: 'dangerously' });
const { window } = dom;
const run = (js) => window.eval(js);
function load(f) {
  const scr = window.document.createElement('script');
  scr.textContent = fs.readFileSync(ROOT + '/' + f, 'utf8');
  window.document.body.appendChild(scr);
}
load('js/010-theming.js');
load('js/151-modal-flairs.js');
load('js/218-shelf3d-decor.js');
load('js/216-shelf3d-theme.js');

/* ---- 1. theme registration ---- */
const themeKeys = JSON.parse(run('JSON.stringify(THEMES.map(function(t){return t.key}))'));
for (const k of ['stormrider', 'briarthrone', 'voidsignal', 'wisp', 'wisp-night']) {
  ok('theme registered: ' + k, themeKeys.indexOf(k) >= 0);
}
const premThemes = JSON.parse(run('JSON.stringify(THEMES.filter(function(t){return t.premium}).map(function(t){return t.key}))'));
ok('5 premium themes flagged', premThemes.length === 5 &&
  ['stormrider','briarthrone','voidsignal','wisp','wisp-night'].every(k => premThemes.indexOf(k) >= 0));

/* ---- 2. theme previews / accents ---- */
for (const k of ['stormrider', 'briarthrone', 'voidsignal', 'wisp', 'wisp-night']) {
  const pv = JSON.parse(run(`JSON.stringify(themePreview('${k}'))`));
  ok('preview tokens for ' + k, pv && pv.bg && pv.card && pv.ink && pv.accent);
  const def = run(`themeDefaultAccent('${k}')`);
  ok('default accent for ' + k, typeof def === 'string' && def.length > 0);
  const pairs = JSON.parse(run(`JSON.stringify(themeAccentPairings('${k}'))`));
  ok('accent pairings for ' + k, Array.isArray(pairs) && pairs.length >= 2);
}

/* ---- 3. modal flairs ---- */
const packFlairs = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return e.premium && /^(stormrider|briarthrone|voidsignal|wisp)-/.test(e.id)}).map(function(e){return e.id}))`));
ok('12 pack flairs in catalog', packFlairCount() === 12);
function packFlairCount() { return packFlairs.length; }
const expectedFlairs = ['stormrider-vine','stormrider-divider','stormrider-garland',
  'briarthrone-vine','briarthrone-divider','briarthrone-watermark',
  'voidsignal-vine','voidsignal-divider','voidsignal-corner',
  'wisp-vine','wisp-divider','wisp-garland'];
ok('all 12 expected flair ids present',
  expectedFlairs.every(id => packFlairs.indexOf(id) >= 0));
// theme mapping: pack vines resolve for pack themes
for (const [theme, vine] of [['stormrider','stormrider-vine'],['briarthrone','briarthrone-vine'],['voidsignal','voidsignal-vine'],['wisp','wisp-vine'],['wisp-night','wisp-vine']]) {
  const got = run(`(ModalFlairs.flairFor('vine','${theme}')||{}).id || null`);
  ok(`vine resolves for ${theme}`, got === vine);
}
// all pack flair SVGs are currentColor-only
let flairSvgOk = true;
for (const id of expectedFlairs) {
  const e = JSON.parse(run(`JSON.stringify(ModalFlairs.byId('${id}'))`));
  if (!e || typeof e.svg !== 'string' || e.svg.indexOf('currentColor') < 0) flairSvgOk = false;
  if (/#[0-9a-fA-F]{3,8}\b/.test(e.svg)) flairSvgOk = false;
  if (e.file !== 'Asset/packs/' + id + '.svg') flairSvgOk = false;
}
ok('pack flair SVGs currentColor-only, correct file paths', flairSvgOk);

/* ---- 4. shelf decorations ---- */
const packDecos = ['dragon-egg','storm-lantern','rider-blade','thorn-crown','moon-goblet','night-bloom',
  'holo-cube','signal-dish','data-core','mushroom-cottage','firefly-jar','wisp-lantern'];
for (const id of packDecos) {
  const d = JSON.parse(run(`JSON.stringify(Shelf3DDecor.get('${id}'))`));
  ok('decoration registered: ' + id, d && d.id === id && d.premium === true && typeof d.build === 'string');
}
// unlocked during alpha: premium flag must NOT gate usage (no lock checks in catalog)
const lockedGates = JSON.parse(run(`JSON.stringify(Shelf3DDecor.CATALOG.filter(function(d){return d.premium && d.locked}).length)`));
ok('no premium decorations locked during alpha', lockedGates === 0);
// per-theme sets + presets include pack themes
for (const k of ['stormrider', 'briarthrone', 'voidsignal', 'wisp', 'wisp-night']) {
  const set = JSON.parse(run(`JSON.stringify(Shelf3DDecor.setFor('${k}'))`));
  const preset = JSON.parse(run(`JSON.stringify(Shelf3DDecor.presetFor('${k}'))`));
  ok(`decor set for ${k}`, Array.isArray(set) && set.length > 0);
  ok(`decor preset for ${k}`, Array.isArray(preset) && preset.length > 0);
}

/* ---- 5. 3D theme mapping ---- */
for (const k of ['stormrider', 'briarthrone', 'voidsignal', 'wisp', 'wisp-night']) {
  const m = JSON.parse(run(`JSON.stringify(Shelf3DTheme.forTheme('${k}', 'rose'))`));
  ok(`3D theme params for ${k}`, m && m.woodBase && m.lightWarm && m.mood);
}

/* ---- 6. source SVG files exist ---- */
for (const id of expectedFlairs) {
  ok('source SVG exists: ' + id, fs.existsSync(ROOT + '/Asset/packs/' + id + '.svg'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
