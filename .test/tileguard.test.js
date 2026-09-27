// Tile guard tests (v55): enforces uniform 2:3 cover boxes even if a stale
// styles.css is applied. Uses JSDOM with a mocked getBoundingClientRect.
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

function makeWindow(ratios) {
  // ratios: array of h/w for each fake .tile-cover
  const dom = new JSDOM('<div id="view"></div>',
    { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  require('./harness').loadApp(window);
  // Inject tiles AFTER loadApp: boot() renders on load and clears #view.
  window.document.getElementById('view').innerHTML =
    ratios.map(() => '<div class="tile-cover"></div>').join('');
  const tiles = window.document.querySelectorAll('#view .tile-cover');
  tiles.forEach((t, i) => {
    const w = 120, h = 120 * ratios[i];
    t.getBoundingClientRect = () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
  });
  return window;
}

ok('tileGuard is defined', (() => {
  const w = makeWindow([1.5]);
  return typeof w.tileGuard === 'function';
})());

// CSS correct (all 2:3): no-op, no inline styles, state css-ok.
(() => {
  const w = makeWindow([1.5, 1.5, 1.5]);
  w.tileGuard();
  const tiles = w.document.querySelectorAll('#view .tile-cover');
  const untouched = Array.from(tiles).every(t => t.style.height === '');
  ok('no-op when tiles are already 2:3', untouched && w.tileGuardState === 'css-ok');
})();

// Stale CSS (photo-shaped tiles): forces 2:3 via inline height, state fixed.
(() => {
  const w = makeWindow([2.1, 1.5, 0.9]);
  w.tileGuard();
  const tiles = w.document.querySelectorAll('#view .tile-cover');
  const fixed = Array.from(tiles).every(t => t.style.height === '180px'); // 120 * 1.5
  ok('forces 2:3 inline height when CSS is stale', fixed && w.tileGuardState === 'fixed');
})();

// No tiles: does not throw, state stays not-run.
(() => {
  const w = makeWindow([]);
  let threw = false;
  try { w.tileGuard(); } catch (e) { threw = true; }
  ok('handles empty grid without throwing', !threw && w.tileGuardState === 'not-run');
})();

// cssHasTileFix marker detection (181-appversion.js).
(() => {
  const w = makeWindow([1.5]);
  const f = w.cssHasTileFix;
  ok('cssHasTileFix defined', typeof f === 'function');
  ok('detects the v55 marker', f('/* v55-tile */ .x{}') === true);
  ok('rejects old CSS', f('.cover-tile .tile-cover { aspect-ratio: 2/3; }') === false);
  ok('handles empty', f('') === false && f(null) === false);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
