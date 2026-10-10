// 3D edition viewer (v279): proportions math, appearance picking, pool
// merge, and the file/index.html/sw.js wiring (three.module.js is lazy-loaded,
// so it is NOT in index.html — but it must be in the sw precache).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);

/* ---- 1. b3dDims: proportions from real face aspects ---- */
const dims1 = run(`JSON.stringify(b3dDims({ w: 130, h: 200 }, { w: 30, h: 200 }))`);
{
  const d = JSON.parse(dims1);
  ok('cover width follows the front aspect', near(d.coverW, 1.3));
  ok('thickness follows the spine aspect', near(d.thick, 0.3));
  ok('height is fixed at 2 units', d.H === 2);
}
const dims2 = run(`JSON.stringify(b3dDims(null, null))`);
{
  const d = JSON.parse(dims2);
  ok('missing faces fall back to defaults', near(d.coverW, 1.3) && near(d.thick, 0.26));
}
const dims3 = run(`JSON.stringify(b3dDims({ w: 400, h: 200 }, { w: 5, h: 200 }))`);
{
  const d = JSON.parse(dims3);
  ok('proportions are clamped to sane bounds',
    d.coverW <= 1.7 && d.thick >= 0.1 && d.thick <= 0.75);
}

/* ---- 2. b3dPickAppearance: jacket wins, then boards ---- */
ok('jacket wins when both have faces',
  run(`b3dPickAppearance({ jacket: { spine: 'x' }, board: { spine: 'y' } })`) === 'jacket');
ok('board is the fallback',
  run(`b3dPickAppearance({ board: { spine: 'y' } })`) === 'board');
ok('null when nothing scanned',
  run(`b3dPickAppearance({})`) === null);
ok('empty appearance objects do not count',
  run(`b3dPickAppearance({ jacket: {} })`) === null);

/* ---- 3. b3dMergeFaces: local wins, pool fills gaps ---- */
const merged = run(`JSON.stringify(b3dMergeFaces(
  { spine: 'local-spine' },
  { spine: 'pool-spine', front: 'pool-front' },
  { back: 'pool-back' }))`);
{
  const m = JSON.parse(merged);
  ok('local scan wins its slot', m.spine === 'local-spine');
  ok('pool fills the same appearance', m.front === 'pool-front');
  ok('pool other-appearance is the last resort', m.back === 'pool-back');
  ok('missing slots stay null', m.fore_edge === null);
}

/* ---- 4. wiring ---- */
ok('index.html loads js/207-book3d.js',
  html.includes('<script src="js/207-book3d.js"></script>'));
ok('207 loads after 206 (scan flow)',
  html.indexOf('js/206-editioncapture.js') < html.indexOf('js/207-book3d.js'));
const swText = fs.readFileSync(ROOT + '/sw.js', 'utf8');
ok('sw.js precaches js/207-book3d.js', swText.includes("'207-book3d.js'"));
ok('sw.js precaches vendored three.module.js (lazy-loaded, offline-safe)',
  swText.includes("'three.module.js'"));
ok('three.module.js is NOT a render-blocking script tag (lazy load)',
  !html.includes('<script src=') || !html.match(/<script src="[^"]*three\.module\.js"/));
ok('three.module.js ES module vendor file exists',
  fs.existsSync(ROOT + '/js/vendor/three.module.js'));
ok('importmap maps three to the vendored ES module',
  html.includes('"three"') && html.includes('three.module.js'));
ok('modal has a View in 3D button wired to b3dOpenViewer',
  run(`typeof b3dOpenViewer`) === 'function' &&
  fs.readFileSync(ROOT + '/js/150-modal-discovery.js', 'utf8').includes('m-view3d'));
const appVer = run(`APP_VERSION`);
const swVer = (swText.match(/cozy-libram-(v\d+)/) || [])[1];
ok('APP_VERSION matches the sw cache name', appVer === swVer);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
