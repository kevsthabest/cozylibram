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
ok('catalog has 32 entries', ids.length === 32);

const req = ['id', 'name', 'motif', 'placement', 'themes', 'file', 'svg'];
let allFields = true, allSvg = true, noHex = true;
for (const id of ids) {
  const e = JSON.parse(run(`JSON.stringify(ModalFlairs.byId('${id}'))`));
  for (const f of req) if (!(f in e)) allFields = false;
  if (typeof e.svg !== 'string' || e.svg.indexOf('<svg') < 0) allSvg = false;
  if (/#[0-9a-fA-F]{3,8}\b/.test(e.svg)) noHex = false;
  if (e.svg.indexOf('currentColor') < 0) allSvg = false;
  if (e.file !== 'Asset/flairs/' + id + '.svg' && e.file !== 'Asset/packs/' + id + '.svg') allFields = false;
}
ok('every entry has id/name/motif/placement/themes/file/svg', allFields);
ok('every svg is inline currentColor-only, no hardcoded hex', allSvg && noHex);

const placements = JSON.parse(run('JSON.stringify(ModalFlairs.PLACEMENTS)'));
ok('five placements', JSON.stringify(placements) === JSON.stringify(['vine','corners','divider','garland','watermark']));

/* ---- 2. tiers ---- */
const premium = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return e.premium}).map(function(e){return e.id}))`));
ok('15 premium flagged (v423: +12 pack flairs)', premium.length === 15 &&
  ['corner-gilded','watermark-moon','watermark-constellation'].every(function(id){return premium.indexOf(id) >= 0}));
const seasonal = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return e.seasonal}).map(function(e){return e.id}))`));
ok('7 seasonal garlands', seasonal.length === 7 && seasonal.every(function(id){return id.indexOf('garland-') === 0}));
const free = JSON.parse(run(`JSON.stringify(ModalFlairs.CATALOG.filter(function(e){return !e.premium && !e.seasonal}).map(function(e){return e.id}))`));
ok('10 free core entries', free.length === 10);

/* ---- 3. theme mapping ---- */
const themes = ['dark','light','hearthside','candlelight','twilight','verdant','midnight','velvet','abyss','frost','haunt','yuletide','fete','amour','shamrock','pastel','harvest','stormrider','briarthrone','voidsignal','wisp','wisp-night'];
let vineOk = true, divOk = true, cornerOk = true;
for (const t of themes) {
  const s = JSON.parse(run(`JSON.stringify({v: (ModalFlairs.flairFor('vine','${t}')||{}).id || null, d: ModalFlairs.flairFor('divider','${t}').id, c: ModalFlairs.flairFor('corners','${t}').id})`));
  if (['fete','yuletide'].indexOf(t) < 0 && !s.v) vineOk = false;  // every other theme has a vine
  if (['fete','yuletide'].indexOf(t) >= 0 && s.v) vineOk = false;   // ...except these two
  if (!s.d) divOk = false;                                          // divider always resolves (diamond fallback)
  if (s.c !== 'corner-filigree' && t !== 'voidsignal') cornerOk = false;  // free default wins over premium gilded (except voidsignal which has its own corner)
}
ok('vine mapped for 20/22 themes (fete, yuletide intentionally none)', vineOk);
ok('divider resolves for every theme via diamond fallback', divOk);
ok('corners default to free filigree (not premium gilded)', cornerOk);

ok('midnight vine is celestial', run(`ModalFlairs.flairFor('vine','midnight').id`) === 'vine-celestial');
ok('midnight divider prefers crescent over diamond fallback', run(`ModalFlairs.flairFor('divider','midnight').id`) === 'divider-crescent');
ok('verdant divider is leaf', run(`ModalFlairs.flairFor('divider','verdant').id`) === 'divider-leaf');
ok('dark divider falls back to diamond', run(`ModalFlairs.flairFor('divider','dark').id`) === 'divider-diamond');
ok('haunt garland is seasonal', run(`ModalFlairs.flairFor('garland','haunt').id`) === 'garland-haunt');
ok('dark has no garland (not seasonal)', run(`ModalFlairs.flairFor('garland','dark')`) === null);
ok('midnight watermark is moon (premium, alpha-unlocked)', run(`ModalFlairs.flairFor('watermark','midnight').id`) === 'watermark-moon');

/* ---- 4. injection ---- */
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
ok('vine injected in hero', q('.mflair-vine') === 1);
ok('corners injected (mirrored pair)', q('.mflair-corners') === 1 && q('.mflair-corners .c1') === 1 && q('.mflair-corners .c2') === 1);
ok('no garland for non-seasonal theme', q('.mflair-garland') === 0);
ok('watermark injected (premium, alpha-unlocked)', q('.mflair-watermark') === 1);
ok('divider ornaments between the 3 fields', q('.mflair-divider') === 2);

let ariaOk = true;
window.document.querySelectorAll('.mflair').forEach(function(n){ if (n.getAttribute('aria-hidden') !== 'true') ariaOk = false; });
ok('all flair containers aria-hidden', ariaOk);

ok('no duplicate svg title ids (namespaced)', window.document.querySelectorAll('[id="t"]').length === 0);

// idempotent re-apply (theme change path)
run('ModalFlairs.apply()');
ok('re-apply is idempotent (no duplicates)', q('.mflair-vine') === 1 && q('.mflair-divider') === 2);

// seasonal theme: garland appears, vine absent for yuletide
window.__theme = 'yuletide';
run('ModalFlairs.apply()');
ok('yuletide: garland-holly injected', q('.mflair-garland') === 1);
ok('yuletide: no vine (by design)', q('.mflair-vine') === 0);

// no modal open -> false, no throw
window.document.getElementById('modal-root').innerHTML = '';
ok('apply with no modal returns false', run('ModalFlairs.apply()') === false);
run('ModalFlairs.refresh()');
ok('refresh with no modal does not throw', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
