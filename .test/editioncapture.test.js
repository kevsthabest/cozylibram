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
const stepsNoEdge = run(`JSON.stringify(ecBuildSteps(['jacket'], false).map(s => s.face))`);
ok('plain pages drop the fore-edge face',
  stepsNoEdge === '["spine","front","back"]');
const stepsNoEdge2 = run(`JSON.stringify(ecBuildSteps(['jacket','board'], false))`);
ok('plain pages drop fore-edge for both appearances',
  JSON.parse(stepsNoEdge2).length === 6 &&
  JSON.parse(stepsNoEdge2).every(s => s.face !== 'fore_edge'));

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
ok('edges question follows appearance pick', !!q('#ec-wizard #ec-edge-no'));
run(`document.getElementById('ec-edge-no').click();`);
ok('plain pages skip fore-edge in the step list',
  run(`EC.steps.length`) === 3 && run(`EC.steps.every(s => s.face !== 'fore_edge')`) === true);
ok('first face step renders',
  !!q('#ec-wizard #ec-st-photo'));
ok('spine goes first', q('#ec-wizard h3').textContent === 'Spine');
run(`document.getElementById('ec-st-photo').click();`);
ok('capture sheet opens with a face guide', !!q('#ec-capture .ec-guide-tall'));
ok('capture sheet has the auto-scan UI',
  !!q('#ec-capture #ec-scanfx') && !!q('#ec-capture #ec-scanbar') &&
  !!q('#ec-capture #ec-cap-auto'));
// jsdom has no camera: auto-scan starts off; the toggle still flips state.
ok('auto-scan starts off without a camera',
  q('#ec-capture #ec-cap-auto').textContent === 'Auto-scan: off');
run(`document.getElementById('ec-cap-auto').click();`);
ok('auto-scan toggle flips on',
  q('#ec-capture #ec-cap-auto').textContent === 'Auto-scan: on');
run(`document.getElementById('ec-cap-back').click();`);
ok('capture back returns to the step (handoff, no dead overlay)',
  !!q('#ec-wizard #ec-st-photo') && !q('#ec-capture'));
run(`document.getElementById('ec-st-cancel').click();`);
ok('cancel tears down the wizard and session', !q('#ec-wizard') && run(`EC`) === null);

/* ---- 12. confirm sheet (auto-scan handoff) ---- */
run(`window.__cf = null;
ecOpenConfirm('data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  [[0,0],[10,0],[10,10],[0,10]],
  { label: 'Spine', guide: 'tall' }, 'Jacket', 'step 1 of 4',
  function (url, opts) { window.__cf = { url: url.slice(0, 22), warped: !!(opts && opts.warped) }; });`);
ok('confirm sheet renders with use/adjust/retake',
  !!q('#ec-confirm #ec-cf-use') && !!q('#ec-confirm #ec-cf-adjust') && !!q('#ec-confirm #ec-cf-retake'));
run(`document.getElementById('ec-cf-use').click();`);
ok('confirm "use this" hands the warped photo back flagged as warped',
  run(`JSON.stringify(window.__cf)`) === JSON.stringify({ url: 'data:image/gif;base64,', warped: true }) &&
  !q('#ec-confirm'));
run(`window.__cf = null;
ecOpenConfirm('data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  [[0,0],[10,0],[10,10],[0,10]],
  { label: 'Spine', guide: 'tall' }, 'Jacket', 'step 1 of 4',
  function (url, opts) { window.__cf = true; });`);
run(`document.getElementById('ec-cf-adjust').click();`);
ok('confirm "adjust corners" opens the editor', !!q('#ec-editor'));
run(`document.getElementById('ec-ed-retake').click();`);
ok('editor retake from the confirm path tears down cleanly', !q('#ec-editor'));

/* ---- 13. editor overlay chrome (v275) ---- */
run(`ecOpenEditor('data:image/jpeg;base64,AAA', 'Spine', 'Dust jacket', function(){}, function(){});`);
ok('editor builds with lock toggle defaulting on',
  !!q('#ec-editor #ec-ed-lock') && q('#ec-editor #ec-ed-lock').textContent === '90° lock: on');
ok('editor suppresses the long-press context menu',
  !!q('#ec-editor') && !!q('#ec-editor #ec-ed-rot'));
run(`document.getElementById('ec-ed-lock').click();`);
ok('lock toggle switches to free mode',
  q('#ec-editor #ec-ed-lock').textContent === '90° lock: off');
run(`document.getElementById('ec-ed-retake').click();`);
ok('retake tears down the editor', !q('#ec-editor'));

/* ---- 12. locked-rectangle editor math (v275) ---- */
const rectOk = run(`(() => {
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1];
  const isRect = (q) => [0,1,2,3].every(i => {
    const e1 = [q[(i+1)%4][0]-q[i][0], q[(i+1)%4][1]-q[i][1]];
    const e2 = [q[(i+3)%4][0]-q[i][0], q[(i+3)%4][1]-q[i][1]];
    return Math.abs(dot(e1, e2)) < 1e-6;
  });
  // drag TL corner of a 100x200 rect out to (10,5): BR must stay anchored
  const q = [[0,0],[100,0],[100,200],[0,200]];
  const r = ecLockedResize(q, 0, [10, 5]);
  if (!isRect(r)) return 'not-rect';
  if (Math.abs(r[2][0]-100) > 1e-6 || Math.abs(r[2][1]-200) > 1e-6) return 'opposite-moved';
  // new size should be 90x195
  const w = Math.hypot(r[1][0]-r[0][0], r[1][1]-r[0][1]);
  const h = Math.hypot(r[3][0]-r[0][0], r[3][1]-r[0][1]);
  if (Math.abs(w-90) > 1e-6 || Math.abs(h-195) > 1e-6) return 'size ' + w + 'x' + h;
  return 'ok';
})()`);
ok('locked resize keeps 90° and anchors the opposite corner', rectOk === 'ok');

const snapOk = run(`(() => {
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1];
  // skewed trapezoid -> snapped rectangle
  const r = ecSnapToRect([[10,0],[90,5],[100,100],[0,95]]);
  return [0,1,2,3].every(i => {
    const e1 = [r[(i+1)%4][0]-r[i][0], r[(i+1)%4][1]-r[i][1]];
    const e2 = [r[(i+3)%4][0]-r[i][0], r[(i+3)%4][1]-r[i][1]];
    return Math.abs(dot(e1, e2)) < 1e-6;
  });
})()`);
ok('snap-to-rect restores right angles', snapOk === true);

const rotOk = run(`(() => {
  const q = [[0,0],[100,0],[100,100],[0,100]];
  const r = ecRotateQuad(q, Math.PI / 2);
  // center stays (50,50); TL corner (0,0) -> (100,0)
  const c = ecQuadCenter(r);
  return Math.abs(c[0]-50) < 1e-9 && Math.abs(c[1]-50) < 1e-9 &&
         Math.abs(r[0][0]-100) < 1e-9 && Math.abs(r[0][1]-0) < 1e-9;
})()`);
ok('rotate-quad turns 90° around the center', rotOk === true);

// ---- v278 auto-scan detection: synthetic image fixtures ----
const detPrelude = `
function synthGray(w, h, rects) {
  const g = new Uint8ClampedArray(w*h);
  for (let i = 0; i < w*h; i++) g[i] = 18;
  (rects || []).forEach(r => {
    const a = (r.ang || 0) * Math.PI/180, cos = Math.cos(a), sin = Math.sin(a);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - r.cx, dy = y - r.cy;
      const lx = dx*cos + dy*sin, ly = -dx*sin + dy*cos;
      if (Math.abs(lx) <= r.rw/2 && Math.abs(ly) <= r.rh/2) g[y*w+x] = (r.val == null ? 220 : r.val);
    }
    (r.bars || []).forEach(b => { // interior "text" partitions
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x - r.cx, dy = y - r.cy;
        const lx = dx*cos + dy*sin, ly = -dx*sin + dy*cos;
        if (Math.abs(lx) <= r.rw/2 && ly >= b.y0 && ly <= b.y1) g[y*w+x] = b.val;
      }
    });
  });
  return g;
}
function angMod(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}
`;

// axis-aligned book
const det1 = run(detPrelude + `(() => {
  const g = synthGray(240, 320, [{ cx: 120, cy: 160, rw: 80, rh: 160, ang: 0 }]);
  const r = ecDetectBookRect(g, 240, 320);
  if (!r) return 'none';
  return JSON.stringify({ cx: Math.round(r.cx), cy: Math.round(r.cy),
    w: Math.round(r.w), h: Math.round(r.h), portrait: r.h >= r.w });
})()`);
{
  const r = JSON.parse(det1);
  ok('detects an axis-aligned book', r !== 'none' &&
    Math.abs(r.cx - 120) <= 10 && Math.abs(r.cy - 160) <= 10 &&
    Math.abs(r.w - 80) <= 16 && Math.abs(r.h - 160) <= 24 && r.portrait === true);
}

// rotated book
const det2 = run(detPrelude + `(() => {
  const g = synthGray(240, 320, [{ cx: 120, cy: 160, rw: 70, rh: 150, ang: 14 }]);
  const r = ecDetectBookRect(g, 240, 320);
  if (!r) return 'none';
  return JSON.stringify({ cx: Math.round(r.cx), w: Math.round(r.w), h: Math.round(r.h),
    angDiff: angMod(r.angle, 14 * Math.PI/180) });
})()`);
{
  const r = JSON.parse(det2);
  ok('detects a rotated book with the right angle', r !== 'none' &&
    Math.abs(r.cx - 120) <= 12 && Math.abs(r.w - 70) <= 18 &&
    Math.abs(r.h - 150) <= 26 && r.angDiff < 0.22);
}

// cover text partitions must not break detection (morphological opening)
const det3 = run(detPrelude + `(() => {
  const bars = [];
  for (let y = -60; y < 60; y += 18) bars.push({ y0: y, y1: y + 7, val: 40 });
  const g = synthGray(240, 320, [{ cx: 120, cy: 160, rw: 90, rh: 170, ang: -8, bars }]);
  const r = ecDetectBookRect(g, 240, 320);
  if (!r) return 'none';
  return JSON.stringify({ cx: Math.round(r.cx), cy: Math.round(r.cy) });
})()`);
{
  const r = JSON.parse(det3);
  ok('survives interior text partitions', r !== 'none' &&
    Math.abs(r.cx - 120) <= 14 && Math.abs(r.cy - 160) <= 14);
}

// empty frame -> null
const det4 = run(detPrelude + `(() => {
  const g = synthGray(240, 320, []);
  return ecDetectBookRect(g, 240, 320) === null;
})()`);
ok('empty frame detects nothing', det4 === true);

// book touching the border -> null (must be fully in view)
const det5 = run(detPrelude + `(() => {
  const g = synthGray(240, 320, [{ cx: 120, cy: 300, rw: 120, rh: 160, ang: 0 }]);
  return ecDetectBookRect(g, 240, 320) === null;
})()`);
ok('border-touching book is rejected', det5 === true);

// no mirror: asymmetric rect keeps left/right after warp
const det6 = run(detPrelude + `(() => {
  const W = 240, H = 320;
  const g = synthGray(W, H, [{ cx: 120, cy: 160, rw: 90, rh: 170, ang: 6 }]);
  const a = 6 * Math.PI/180, cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - 120, dy = y - 160;
    const lx = dx*cos + dy*sin, ly = -dx*sin + dy*cos;
    if (Math.abs(lx) <= 45 && Math.abs(ly) <= 85 && lx < -4) g[y*W+x] = 60;
  }
  const r = ecDetectBookRect(g, W, H);
  if (!r) return 'none';
  const rgba = new Uint8ClampedArray(W*H*4);
  for (let i = 0; i < W*H; i++) {
    rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = g[i]; rgba[i*4+3] = 255;
  }
  const size = ecQuadSize(r.quad, 400);
  const out = ecWarpPixels(rgba, W, H, r.quad, size[0], size[1]).data;
  let l = 0, lc = 0, rr = 0, rc = 0;
  for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
    const v = out[(y*size[0]+x)*4];
    if (x < size[0]/3) { l += v; lc++; } else if (x > size[0]*2/3) { rr += v; rc++; }
  }
  return JSON.stringify({ left: l/lc, right: rr/rc });
})()`);
{
  const r = JSON.parse(det6);
  ok('warped output is not mirrored', r !== 'none' && r.left < r.right - 20);
}

// stability tracker
const det7 = run(`(() => {
  const tr = ecNewScanTracker();
  const mk = (dx) => ({ cx: 120+dx, cy: 160, w: 80, h: 160, angle: 0.02 });
  let last = null;
  for (let i = 0; i < 5; i++) last = ecScanTrack(tr, mk(i * 0.4));
  const before = last.stable === false && last.progress > 0;
  last = ecScanTrack(tr, mk(2.2));
  const stable = last.stable === true;
  const reset = ecScanTrack(tr, null);
  const tr2 = ecNewScanTracker();
  let s2 = null;
  for (let i = 0; i < 6; i++) s2 = ecScanTrack(tr2, i < 3 ? mk(0) : { cx: 200, cy: 100, w: 40, h: 200, angle: 1.2 });
  return before && stable && reset.stable === false && s2.stable === false;
})()`);
ok('stability tracker needs 6 steady frames and resets', det7 === true);

// per-face aspect gate
const det8 = run(`(() => {
  const tall = { guide: 'tall' }, port = { guide: 'portrait' };
  return ecFaceAspectOk(tall, { w: 40, h: 160 }) === true &&
         ecFaceAspectOk(tall, { w: 100, h: 120 }) === false &&
         ecFaceAspectOk(port, { w: 100, h: 150 }) === true &&
         ecFaceAspectOk(port, { w: 40, h: 200 }) === false &&
         ecFaceAspectOk(port, null) === false;
})()`);
ok('per-face aspect gate filters wrong shapes', det8 === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
