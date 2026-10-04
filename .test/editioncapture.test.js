// Edition-face capture (v274): homography math, pixel warp, step builder,
// and the three-touchpoint wiring (file, index.html, sw.js).
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
const q = (s) => window.document.querySelector(s);
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);

/* ---- 1. ecSolveHomography: identity ---- */
const idH = run(`JSON.stringify(ecSolveHomography(
  [[0,0],[100,0],[100,200],[0,200]], [[0,0],[100,0],[100,200],[0,200]]))`);
const idm = JSON.parse(idH);
ok('identity quad solves to identity matrix',
  near(idm[0][0], 1) && near(idm[1][1], 1) && near(idm[2][2], 1) &&
  near(idm[0][1], 0) && near(idm[0][2], 0) && near(idm[1][0], 0) &&
  near(idm[1][2], 0) && near(idm[2][0], 0) && near(idm[2][1], 0));

/* ---- 2. ecSolveHomography: scale x2 ---- */
const sc = run(`(() => {
  const H = ecSolveHomography([[0,0],[10,0],[10,10],[0,10]], [[0,0],[20,0],[20,20],[0,20]]);
  const p = ecApplyH(H, 5, 5);
  const q = ecApplyH(H, 0, 0);
  return JSON.stringify({ p, q });
})()`);
const scj = JSON.parse(sc);
ok('scale homography maps points correctly',
  near(scj.p[0], 10) && near(scj.p[1], 10) && near(scj.q[0], 0) && near(scj.q[1], 0));

/* ---- 3. ecSolveHomography: perspective (trapezoid -> rectangle) ---- */
const persp = run(`(() => {
  const H = ecSolveHomography([[10,0],[90,0],[100,100],[0,100]], [[0,0],[100,0],[100,100],[0,100]]);
  if (!H) return 'null';
  // every source corner must land on its destination corner
  const src = [[10,0],[90,0],[100,100],[0,100]];
  const dst = [[0,0],[100,0],[100,100],[0,100]];
  return src.every((s, i) => {
    const p = ecApplyH(H, s[0], s[1]);
    return Math.abs(p[0] - dst[i][0]) < 1e-4 && Math.abs(p[1] - dst[i][1]) < 1e-4;
  });
})()`);
ok('perspective homography maps all corners exactly', persp === true);

/* ---- 4. ecInvert3 round-trip ---- */
const inv = run(`(() => {
  const H = ecSolveHomography([[10,0],[90,0],[100,100],[0,100]], [[0,0],[100,0],[100,100],[0,100]]);
  const Hi = ecInvert3(H);
  const p = ecApplyH(H, 37, 52);   // src -> dst
  const q = ecApplyH(Hi, p[0], p[1]); // back to src
  return Math.abs(q[0] - 37) < 1e-4 && Math.abs(q[1] - 52) < 1e-4;
})()`);
ok('inverse homography round-trips', inv === true);

/* ---- 5. ecWarpPixels: identity warp preserves pixels ---- */
const warpId = run(`(() => {
  const w = 4, h = 4;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i*4] = i * 3; px[i*4+1] = i * 5; px[i*4+2] = i * 7; px[i*4+3] = 255; }
  const r = ecWarpPixels(px, w, h, [[0,0],[4,0],[4,4],[0,4]], 4, 4);
  if (!r || r.w !== 4 || r.h !== 4) return 'bad-shape';
  for (let i = 0; i < w * h * 4; i++) if (r.data[i] !== px[i]) return 'pixel ' + i;
  return 'ok';
})()`);
ok('identity warp is pixel-exact', warpId === 'ok');

/* ---- 6. ecWarpPixels: solid color survives a perspective warp ---- */
const warpSolid = run(`(() => {
  const w = 8, h = 8;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i*4] = 200; px[i*4+1] = 50; px[i*4+2] = 25; px[i*4+3] = 255; }
  const r = ecWarpPixels(px, w, h, [[1,0],[7,1],[6,7],[0,6]], 6, 6);
  if (!r) return 'null';
  // every output pixel samples inside the solid quad -> stays (200,50,25)
  for (let i = 0; i < 6 * 6; i++) {
    if (Math.abs(r.data[i*4] - 200) > 2 || Math.abs(r.data[i*4+1] - 50) > 2) return 'pixel ' + i;
  }
  return 'ok';
})()`);
ok('solid-color perspective warp stays solid', warpSolid === 'ok');

/* ---- 7. ecQuadSize ---- */
const qs = run(`JSON.stringify([ecQuadSize([[0,0],[100,0],[100,400],[0,400]], 1200),
  ecQuadSize([[0,0],[3000,0],[3000,3000],[0,3000]], 1200)])`);
ok('quad size averages edges and caps the long side', qs === '[[100,400],[1200,1200]]');

/* ---- 8. ecBuildSteps ---- */
const steps1 = run(`JSON.stringify(ecBuildSteps(['jacket']))`);
const s1 = JSON.parse(steps1);
ok('jacket-only builds 4 ordered steps',
  s1.length === 4 && s1.map(s => s.face).join(',') === 'spine,fore_edge,front,back' &&
  s1.every(s => s.appearance === 'jacket'));
ok('front/back are skippable, spine/fore_edge are not',
  s1[0].skippable === false && s1[1].skippable === false &&
  s1[2].skippable === true && s1[3].skippable === true);
const steps2 = run(`JSON.stringify(ecBuildSteps(['jacket','board']).map(s => s.appearance + ':' + s.face))`);
ok('jacket+board builds 8 steps, jacket first',
  JSON.parse(steps2).length === 8 && JSON.parse(steps2)[0] === 'jacket:spine' &&
  JSON.parse(steps2)[4] === 'board:spine');

/* ---- 9. face/appearance catalogs match the v273 DB contract ---- */
const faces = run(`JSON.stringify(EC_FACES.map(f => f.id))`);
ok('face ids match edition_images CHECK', faces === '["spine","fore_edge","front","back"]');
const aps = run(`JSON.stringify(EC_APPEARANCES.map(a => a.id))`);
ok('appearance ids match edition_images CHECK', aps === '["jacket","board"]');

/* ---- 10. three-touchpoint wiring ---- */
ok('index.html loads js/206-editioncapture.js',
  html.includes('<script src="js/206-editioncapture.js"></script>'));
const swText = fs.readFileSync(ROOT + '/sw.js', 'utf8');
ok('sw.js precaches js/206-editioncapture.js', swText.includes("'206-editioncapture.js'"));
ok('206 loads after 205 (uses its pool helpers)',
  html.indexOf('js/205-shelfview.js') < html.indexOf('js/206-editioncapture.js'));

/* ---- 11. wizard DOM flow (appearance -> step -> capture -> back) ---- */
run(`library = [{ id: 'ecb1', title: 'Test Book', isbn: '9780143127748' }]; ecStartScan('ecb1');`);
ok('appearance screen renders', !!q('#ec-wizard #ec-ap-jacket'));
run(`document.getElementById('ec-ap-jacket').click();`);
ok('first face step renders with 4 steps queued',
  !!q('#ec-wizard #ec-st-photo') && run(`EC.steps.length`) === 4);
ok('spine goes first', q('#ec-wizard h3').textContent === 'Spine');
run(`document.getElementById('ec-st-photo').click();`);
ok('capture sheet opens with a face guide', !!q('#ec-capture .ec-guide-tall'));
run(`document.getElementById('ec-cap-back').click();`);
ok('capture back returns to the step (handoff, no dead overlay)',
  !!q('#ec-wizard #ec-st-photo') && !q('#ec-capture'));
run(`document.getElementById('ec-st-cancel').click();`);
ok('cancel tears down the wizard and session', !q('#ec-wizard') && run(`EC`) === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
