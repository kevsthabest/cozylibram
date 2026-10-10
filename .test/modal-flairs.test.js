// v417: modal flair catalog + selection + injection tests.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

const dom = new JSDOM('<!doctype html><html><body><div id="modal-root"></div></body></html>',
  { url: 'https://cozylibram.pages.dev/', runScripts: 'dangerously' });
const { window } = dom;
window.__theme = 'dark';
window.getTheme = function () { return window.__theme || 'dark'; };
const scr = window.document.createElement('script');
scr.textContent = fs.readFileSync(ROOT + '/js/151-modal-flairs.js', 'utf8');
window.document.body.appendChild(scr);
const run = (js) => window.eval(js);

/* ---- 1. catalog structure ---- */
const ids = JSON.parse(run('JSON.stringify(ModalFlairs.CATALOG.map(function(e){return e.id}))'));
ok('catalog has 36 entries', ids.length === 36);

const req = ['id', 'name', 'motif', 'placement', 'themes', 'file', 'svg'];
let allFields = true, allSvg = true, noHex = true;
for (const id of ids) {
  const e = JSON.parse(run(`JSON.stringify(ModalFlairs.byId('${id}'))`));
  for (const f of req) if (!(f in e)) allFields = false;
  if (typeof e.svg !== 'string' || e.svg.indexOf('<svg') < 0) allSvg = false;
  // No hardcoded hex except #000 (pure black at low opacity for shading —
  // neutral, works on any background; used by velvet/verdant vines)
  const hexes = e.svg.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  if (hexes.some(h => h.toLowerCase() !== '#000')) noHex = false;
  // stormrider-vine is Kevin's own raster emblem (his explicit direction), exempt from currentColor
  if (id !== 'stormrider-vine' && e.svg.indexOf('currentColor') < 0) allSvg = false;
  if (e.file !== 'Asset/flairs/' + id + '.svg' && e.file !== 'Asset/packs/' + id + '.svg' && e.file !== 'Asset/packs/' + id + '.png') allFields = false;
}
ok('every entry has id/name/motif/placement/themes/file/svg', allFields);
ok('every svg is inline currentColor-only, no hardcoded hex', allSvg && noHex);

const placements = JSON.parse(run('JSON.stringify(ModalFlairs.PLACEMENTS)'));
ok('five placements', JSON.stringify(placements) === JSON.stringify(['vine','corners','divider','garland','watermark']));

/* ---- 2. tiers ---- */
const premium = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return e.premium}).map(function(e){return e.id}))`));
ok('8 premium flagged', premium.length === 8 &&
  ['watermark-moon','watermark-constellation'].every(function(id){return premium.indexOf(id) >= 0}));
const seasonal = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return e.seasonal}).map(function(e){return e.id}))`));
ok('8 seasonal garlands', seasonal.length === 8 && seasonal.every(function(id){return id.indexOf('garland-') === 0}));
const free = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return !e.premium && !e.seasonal}).map(function(e){return e.id}))`));
ok('20 free core entries (10 vines + 10 corners)', free.length === 20);

/* ---- 3. theme mapping ---- */
const themes = ['dark','light','hearthside','candlelight','twilight','verdant','midnight','velvet','abyss','frost','haunt','yuletide','fete','amour','shamrock','pastel','harvest','solstice','stormrider','briarthrone','voidsignal','wisp','wisp-night'];
let vineOk = true;
// Claude set: all 10 core themes have vines. Seasonal garland themes and
// solstice (banner-only) intentionally have none.
const noVine = ['fete','yuletide','haunt','shamrock','pastel','harvest','solstice'];
for (const t of themes) {
  const s = JSON.parse(run(`JSON.stringify({v: (ModalFlairs.flairFor('vine','${t}')||{}).id || null})`));
  if (noVine.indexOf(t) < 0 && !s.v) vineOk = false;
  if (noVine.indexOf(t) >= 0 && s.v) vineOk = false;
}
ok('vine mapped for 16/23 themes (7 garland themes intentionally none)', vineOk);
ok('haunt garland is seasonal', run(`ModalFlairs.flairFor('garland','haunt').id`) === 'garland-haunt');
ok('dark has no garland (not seasonal)', run(`ModalFlairs.flairFor('garland','dark')`) === null);
ok('dark has corners (Claude set)', run(`ModalFlairs.flairFor('corners','dark').id`) === 'corner-nightshade');

/* ---- 3b. signature mapping (Claude core10 set: each core theme's vine) ---- */
const sigExpect = {
  dark: 'vine-nightshade', light: 'vine-bookrose', verdant: 'vine-fernshroom',
  hearthside: 'vine-fireoak', candlelight: 'vine-taper',
  twilight: 'vine-starcompass', midnight: 'vine-moonphases',
  velvet: 'vine-thornrose', frost: 'vine-frostbranch', abyss: 'vine-jellyfish',
  haunt: 'garland-haunt', yuletide: 'garland-holly', fete: 'garland-gala',
  amour: 'garland-rose', shamrock: 'garland-clover', pastel: 'garland-blossom',
  harvest: 'garland-wheat', solstice: 'garland-solstice',
  stormrider: 'stormrider-vine', briarthrone: 'briarthrone-vine',
  voidsignal: 'voidsignal-vine', wisp: 'wisp-vine', 'wisp-night': 'wisp-vine',
};
let sigOk = true;
for (const t of Object.keys(sigExpect)) {
  const got = run(`(ModalFlairs.signatureFor('${t}')||{}).id || null`);
  if (got !== sigExpect[t]) { sigOk = false; console.log('SIG MISMATCH', t, 'got', got, 'want', sigExpect[t]); }
}
ok('signature table matches the approved mapping (23 themes)', sigOk);
ok('solstice signature is garland-solstice', run(`(ModalFlairs.signatureFor('solstice')||{}).id || null`) === 'garland-solstice');

/* ---- 4. injection (v426: signature system) ---- */
window.__theme = 'midnight';
window.document.getElementById('modal-root').innerHTML =
  '<div class="modal detail-v174"><div class="d-hero"><h2>T</h2></div>' +
  '<div class="d-tabs"></div>' +
  '<div class="d-panel" id="dtab-details">' +
  '<div class="field"><label>Title</label></div>' +
  '<div class="field"><label>Author</label></div>' +
  '<div class="field"><label>About</label></div>' +
  '</div><div class="modal-actions"></div></div>';
ok('apply returns true', run('ModalFlairs.apply()') === true);

const q = (sel) => window.document.querySelectorAll(sel).length;
// midnight signature is now the moon-phase vine; corners also render
ok('midnight: signature vine injected in hero', q('.mflair-vine') === 1);
ok('midnight: corners injected', q('.mflair-corners') === 1);
ok('midnight: no watermark (vine is the signature)', q('.mflair-watermark') === 0);
ok('no absolute top-edge garland', q('.mflair-garland') === 0);
ok('plain hairline dividers between the 3 fields (no motifs)', q('.mflair-divider-plain') === 2 && q('.mflair-divider .motif') === 0);

let ariaOk = true;
window.document.querySelectorAll('.mflair').forEach(function(n){ if (n.getAttribute('aria-hidden') !== 'true') ariaOk = false; });
ok('all flair containers aria-hidden', ariaOk);

ok('no duplicate svg title ids (namespaced)', window.document.querySelectorAll('[id="t"]').length === 0);

// idempotent re-apply (theme change path)
run('ModalFlairs.apply()');
ok('re-apply is idempotent (no duplicates)', q('.mflair-vine') === 1 && q('.mflair-corners') === 1 && q('.mflair-divider-plain') === 2);

// seasonal theme: garland becomes an in-flow banner, no vine for yuletide
window.__theme = 'yuletide';
run('ModalFlairs.apply()');
ok('yuletide: garland-holly injected as in-flow banner', q('.mflair-banner') === 1);
ok('yuletide: banner sits above the Details panel', (function(){
  const b = window.document.querySelector('.mflair-banner');
  const p = window.document.querySelector('#dtab-details');
  return b && p && b.parentNode === p.parentNode &&
    (b.compareDocumentPosition(p) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
})());
ok('yuletide: no vine (by design)', q('.mflair-vine') === 0);
ok('yuletide: no absolute garland strip', q('.mflair-garland') === 0);

// vine theme: dark gets the nightshade vine at full presence, plus corners
window.__theme = 'dark';
run('ModalFlairs.apply()');
ok('dark: signature vine injected in hero', q('.mflair-vine') === 1);
ok('dark: corners injected', q('.mflair-corners') === 1);
ok('dark: no banner (not seasonal)', q('.mflair-banner') === 0);
ok('dark: no watermark (theme has none)', q('.mflair-watermark') === 0);

// no modal open -> false, no throw
window.document.getElementById('modal-root').innerHTML = '';
ok('apply with no modal returns false', run('ModalFlairs.apply()') === false);
run('ModalFlairs.refresh()');
ok('refresh with no modal does not throw', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
