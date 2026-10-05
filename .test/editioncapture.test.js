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

/* ---- 13. existing faces show on the appearance screen with removal ---- */
run(`library = [{ id: 'ecb3', title: 'Managed Book',
  editionFaces: { jacket: { spine: 'data:image/jpeg;base64,xx', fore_edge: 'data:image/jpeg;base64,yy' } } }];
ecStartScan('ecb3');`);
ok('appearance screen lists already-scanned faces',
  !!q('#ec-wizard [data-ec-rm="jacket:spine"]') && !!q('#ec-wizard [data-ec-rm="jacket:fore_edge"]'));
run(`document.querySelector('#ec-wizard [data-ec-rm="jacket:fore_edge"]').click();`);
ok('removing a face drops it from the book and the list',
  !q('#ec-wizard [data-ec-rm="jacket:fore_edge"]') &&
  !!q('#ec-wizard [data-ec-rm="jacket:spine"]') &&
  run(`JSON.stringify(Object.keys(library[0].editionFaces.jacket))`) === '["spine"]');
run(`document.querySelector('#ec-wizard [data-ec-rm="jacket:spine"]').click();`);
ok('removing the last face clears the section',
  !q('#ec-wizard .ec-existing') && run(`!('editionFaces' in library[0])`) === true);
run(`document.getElementById('ec-ap-cancel').click();`);

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

// ---- v280 existing-face management ----
const ex1 = run(`JSON.stringify(ecExistingFaces({
  editionFaces: { jacket: { spine: 'a', front: 'b' }, board: {} }
}))`);
ok('existing faces group by appearance, empties skipped',
  ex1 === JSON.stringify({ jacket: ['spine', 'front'] }));
ok('no faces -> empty object',
  run(`JSON.stringify(ecExistingFaces({}))`) === '{}');

const ex2 = run(`(() => {
  const b = { editionFaces: { jacket: { spine: 'a', front: 'b' } } };
  const r1 = ecRemoveFace(b, 'jacket', 'spine');
  const r2 = ecRemoveFace(b, 'jacket', 'nope');
  const left = JSON.stringify(b.editionFaces);
  const r3 = ecRemoveFace(b, 'jacket', 'front');
  return JSON.stringify({ r1, r2, left, gone: !('editionFaces' in b), r3 });
})()`);
{
  const r = JSON.parse(ex2);
  ok('removeFace deletes the face and reports', r.r1 === true &&
    r.left === JSON.stringify({ jacket: { front: 'b' } }));
  ok('removeFace reports missing faces', r.r2 === false);
  ok('last face cleans up the whole editionFaces', r.r3 === true && r.gone === true);
}

/* ---- 14. v281 AI enhance: review buttons, picker, compare ---- */
// Drive a fresh scan straight to the review screen.
run(`library = [{ id: 'ecb4', title: 'Enhance Me' }]; ecStartScan('ecb4');`);
run(`document.getElementById('ec-ap-jacket').click();`);
run(`document.getElementById('ec-edge-no').click();`);
// Pretend all three faces were captured, then render the review.
run(`EC.results = { jacket: { spine: 'data:image/jpeg;base64,S', front: 'data:image/jpeg;base64,F', back: 'data:image/jpeg;base64,B' } };
EC.idx = EC.steps.length; ecRenderReview();`);
ok('review thumbs have Enhance buttons',
  run(`document.querySelectorAll('#ec-wizard [data-ec-enhance]').length`) === 3);
run(`document.querySelector('#ec-wizard [data-ec-enhance="jacket:spine"]').click();`);
ok('enhance picker opens with both modes',
  !!q('#ec-enhance #ec-eh-sharpen') && !!q('#ec-enhance #ec-eh-restore'));
// Compare overlay renders standalone and Keep fires the context store.
run(`window.__kept = null;
EC.eh = { label: function () { return 'Spine'; },
  store: function (u) { window.__kept = u; }, after: function () {} };
ecEnhanceCompare('data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB');`);
ok('compare overlay shows before/after with keep/discard',
  !!q('#ec-enhance #ec-eh-keep') && !!q('#ec-enhance #ec-eh-discard'));
run(`document.getElementById('ec-eh-keep').click();`);
ok('compare Keep stores the enhanced URL and closes',
  run(`window.__kept`) === 'data:image/jpeg;base64,BBB' && !q('#ec-enhance'));
run(`document.getElementById('ec-rv-cancel').click();`);

// Async: ecRunEnhance posts image+mode and resolves the enhanced URL.
(async () => {
  const flush = async (expr, ms) => {
    const t0 = Date.now();
    while (run(`!!(${expr})`) !== true && Date.now() - t0 < (ms || 5000)) {
      await new Promise(r => setTimeout(r, 20)); // yield so jsdom promises resolve
    }
  };
  run(`window.__ehDone = false;
window.fetch = async (url, opts) => {
  window.__ehReq = { url: url, body: JSON.parse(opts.body) };
  return { ok: true, status: 200, json: async () => ({ image: 'data:image/jpeg;base64,ENH' }) };
};
ecRunEnhance('data:image/jpeg;base64,IN', 'restore').then(
  v => { window.__ehRes = v; window.__ehDone = true; },
  e => { window.__ehRes = 'ERR:' + e.message; window.__ehDone = true; });`);
  await flush('window.__ehDone');
  ok('enhance posts to /api/enhance-face with image+mode',
    run(`window.__ehReq.url`) === '/api/enhance-face' &&
    run(`window.__ehReq.body.mode`) === 'restore' &&
    run(`window.__ehReq.body.image`) === 'data:image/jpeg;base64,IN');
  ok('enhance resolves the enhanced data URL', run(`window.__ehRes`) === 'data:image/jpeg;base64,ENH');

  // Error path: 429 rejects with a friendly busy message.
  run(`window.__ehDone2 = false;
window.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
ecRunEnhance('data:image/jpeg;base64,IN', 'sharpen').then(
  () => { window.__ehRes2 = 'NO-THROW'; window.__ehDone2 = true; },
  e => { window.__ehRes2 = e.message; window.__ehDone2 = true; });`);
  await flush('window.__ehDone2');
  ok('enhance 429 rejects with a busy message', /busy/i.test(run(`window.__ehRes2`)));

  // v282: saved faces can be enhanced from the appearance screen.
  run(`library = [{ id: 'ecb6', title: 'Enhance Saved',
    editionFaces: { jacket: { spine: 'data:image/jpeg;base64,OLD' } } }];
ecStartScan('ecb6');`);
  ok('saved faces have enhance buttons', !!q('#ec-wizard [data-ec-eh="jacket:spine"]'));
  run(`window.__ehDone3 = false;
window.fetch = async () => ({ ok: true, status: 200,
  json: async () => ({ image: 'data:image/jpeg;base64,NEW' }) });
document.querySelector('#ec-wizard [data-ec-eh="jacket:spine"]').click();`);
  ok('saved-face enhance opens the picker', !!q('#ec-enhance #ec-eh-sharpen'));
  run(`document.getElementById('ec-eh-sharpen').click();
ecRunEnhance && null;
(function wait() {
  if (document.getElementById('ec-eh-keep')) {
    document.getElementById('ec-eh-keep').click();
    window.__ehDone3 = true;
  } else setTimeout(wait, 30);
})();`);
  await flush('window.__ehDone3');
  ok('kept enhancement is stored on the saved face',
    run(`library[0].editionFaces.jacket.spine`) === 'data:image/jpeg;base64,NEW' &&
    !!q('#ec-wizard [data-ec-eh="jacket:spine"]'));
  run(`document.getElementById('ec-ap-cancel').click();`);

  // v283: rescan with "Plain pages" clears a stale saved fore-edge.
  run(`window.__saved = false;
library = [{ id: 'ecb7', title: 'Clear Me',
  editionFaces: { jacket: { spine: 'data:image/jpeg;base64,S', fore_edge: 'data:image/jpeg;base64,BAD' } } }];
EC = { bookId: 'ecb7', token: null, appearances: ['jacket'], hasEdges: false,
  results: { jacket: { spine: 'data:image/jpeg;base64,NEWSPINE' } } };
ecSaveAll().then(() => { window.__saved = true; });`);
  await flush('window.__saved');
  ok('plain-pages rescan drops the stale fore-edge and keeps the new spine',
    run(`JSON.stringify(library[0].editionFaces.jacket)`) ===
      JSON.stringify({ spine: 'data:image/jpeg;base64,NEWSPINE' }));

  // v286: pool sharing under the immutable-candidate model. Every upload is a
  // candidate row in edition_assets at a content-addressed path
  // (face/appearance/<sha256>.jpg); first writer wins between users, and a
  // contributor's newer capture becomes a NEW candidate — never an overwrite.
  // jsdom has no webcrypto subtle and its Image never loads, so polyfill
  // subtle and stub the never-resolving quality analysis.
  window.crypto.subtle = require('crypto').webcrypto.subtle;
  run(`editionAnalyzeDataUrl = async function () { return null; };
window.__pool = { editions: {}, assets: [], slots: [], legacy: [] };
window.__uploads = [];
window.__moves = [];
window.__inserts = [];
window.__assetSeq = 0;
window.__blobBytes = 'x';
window.fetch = async function () {
  return { blob: async function () { return new Blob([window.__blobBytes], { type: 'image/jpeg' }); } };
};
function __findRows(table, filters) {
  var store = table === 'editions' ? Object.keys(window.__pool.editions).map(function (k) { return window.__pool.editions[k]; })
    : table === 'edition_assets' ? window.__pool.assets
    : table === 'edition_asset_slots' ? window.__pool.slots
    : table === 'edition_images' ? window.__pool.legacy : [];
  return store.filter(function (r) {
    return Object.keys(filters).every(function (k) { return r[k] === filters[k]; });
  });
}
function __chain(table) {
  var filters = {};
  var c = {};
  c.eq = function (k, v) { filters[k] = v; return c; };
  c.select = function () { return c; };
  c.limit = function () { return c; };
  c.order = function () { return c; };
  c.maybeSingle = async function () {
    var rows = __findRows(table, filters);
    return { data: rows[0] || null, error: null };
  };
  c.single = async function () {
    var rows = __findRows(table, filters);
    return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'none' } };
  };
  c.insert = function (obj) {
    var row = Object.assign({}, obj);
    if (!row.id) row.id = 'asset-' + (++window.__assetSeq);
    if (table === 'edition_assets') window.__pool.assets.push(row);
    window.__inserts.push({ table: table, row: row });
    return { select: function () { return { single: async function () { return { data: { id: row.id }, error: null }; } }; } };
  };
  c.upsert = async function (obj, opts) {
    window.__inserts.push({ table: table, upsert: true, opts: opts || null, row: obj });
    if (table === 'edition_asset_slots') {
      var ex = __findRows(table, { edition_id: obj.edition_id, face: obj.face, appearance: obj.appearance })[0];
      if (ex) { if (!(opts && opts.ignoreDuplicates)) Object.assign(ex, obj); }
      else window.__pool.slots.push(Object.assign({}, obj));
    } else if (table === 'edition_images') {
      var li = __findRows(table, { isbn: obj.isbn, face: obj.face, appearance: obj.appearance })[0];
      if (li) Object.assign(li, obj); else window.__pool.legacy.push(Object.assign({}, obj));
    }
    return { error: null };
  };
  c.delete = function () { c._del = true; return c; };
  c.then = function (resolve) {
    var rows = __findRows(table, filters);
    if (c._del) rows.forEach(function (r) {
      var store = table === 'edition_assets' ? window.__pool.assets : window.__pool.legacy;
      var i = store.indexOf(r);
      if (i !== -1) store.splice(i, 1);
    });
    resolve({ data: rows, error: null });
  };
  return c;
}
window.cloudClient = async function () {
  return {
    auth: { getUser: async function () { return { data: { user: { id: 'user-1' } } }; } },
    from: function (t) { return __chain(t); },
    storage: { from: function () { return {
      upload: async function (path, blob, opts) {
        window.__uploads.push({ path: path, upsert: !!(opts && opts.upsert) });
        return { error: null };
      },
      move: async function (from, to) { window.__moves.push([from, to]); return { error: null }; }
    }; } }
  };
};`);

  // First write: uploads (upsert:false) at the content-addressed path and
  // records an immutable candidate row attributed to the contributor.
  run(`window.__pool.editions['9780000000001'] = { id: 'ed-1', isbn: '9780000000001' };
window.__uploads = []; window.__inserts = []; window.__blobBytes = 'x';
window.__shareDone = false;
ecShareFace('9780000000001', 'jacket', 'spine', 'data:image/jpeg;base64,X')
  .then(function (r) { window.__shareRes = r; window.__shareDone = true; });`);
  await flush('window.__shareDone');
  const upA = run(`window.__uploads[0] && window.__uploads[0].path`);
  const hexA = upA && upA.split('/')[2].replace(/\.jpg$/, '');
  const candA = run(`(window.__inserts.filter(function (i) { return i.table === 'edition_assets'; })[0] || {}).row`);
  const slotUpA = run(`window.__inserts.filter(function (i) { return i.table === 'edition_asset_slots' && i.upsert; })[0]`);
  const legUpA = run(`(window.__inserts.filter(function (i) { return i.table === 'edition_images' && i.upsert; })[0] || {}).row`);
  ok('pool first write uploads (upsert:false) at the sha256 content path',
    run(`window.__shareRes`) === true &&
    run(`window.__uploads`).length === 1 &&
    /^spine\/jacket\/[0-9a-f]{64}\.jpg$/.test(upA) &&
    run(`window.__uploads[0].upsert`) === false);
  ok('pool first write records an immutable candidate attributed to the contributor',
    candA && candA.edition_id === 'ed-1' && candA.isbn === '9780000000001' &&
    candA.face === 'spine' && candA.appearance === 'jacket' &&
    candA.bucket === 'edition-images' && candA.path === upA &&
    candA.sha256 === hexA && candA.source_type === 'capture' &&
    candA.source_user_id === 'user-1' && candA.byte_size === 1);
  ok('pool first write seeds the slot with upsert+ignoreDuplicates (automatic)',
    slotUpA && slotUpA.opts && slotUpA.opts.onConflict === 'edition_id,face,appearance' &&
    slotUpA.opts.ignoreDuplicates === true &&
    slotUpA.row.canonical_asset_id === candA.id &&
    slotUpA.row.selection_method === 'automatic' && slotUpA.row.selected_by === 'user-1');
  ok('pool first write exposes the canonical asset through the legacy row',
    legUpA && legUpA.isbn === '9780000000001' && legUpA.face === 'spine' &&
    legUpA.appearance === 'jacket' && legUpA.bucket === 'edition-images' &&
    legUpA.path === upA && legUpA.uploaded_by === 'user-1');

  // Another contributor's candidate: immutable candidates coexist — the new
  // upload becomes a second candidate; the other row is never touched.
  run(`window.__pool.editions['9780000000002'] = { id: 'ed-2', isbn: '9780000000002' };
window.__pool.assets.push({ id: 'asset-seed', edition_id: 'ed-2', isbn: '9780000000002',
  face: 'spine', appearance: 'jacket', bucket: 'edition-images',
  path: 'spine/jacket/' + 'f'.repeat(64) + '.jpg', source_user_id: 'user-2' });
window.__uploads = []; window.__inserts = []; window.__blobBytes = 'zz';
window.__shareDone = false;
ecShareFace('9780000000002', 'jacket', 'spine', 'data:image/jpeg;base64,Y')
  .then(function (r) { window.__shareRes = r; window.__shareDone = true; });`);
  await flush('window.__shareDone');
  const upB = run(`window.__uploads[0] && window.__uploads[0].path`);
  const seedRow = run(`window.__pool.assets.filter(function (r) { return r.id === 'asset-seed'; })[0]`);
  ok("another contributor's candidate is left alone (immutable candidates coexist)",
    run(`window.__shareRes`) === true &&
    run(`window.__uploads`).length === 1 &&
    /^spine\/jacket\/[0-9a-f]{64}\.jpg$/.test(upB) &&
    upB !== 'spine/jacket/' + 'f'.repeat(64) + '.jpg' &&
    run(`window.__pool.assets`).length === 3 &&
    seedRow && seedRow.source_user_id === 'user-2' &&
    run(`window.__pool.assets`).every(function (r) { return r.bucket === 'edition-images'; }));

  // Re-sharing identical bytes dedups on the content path: no new upload.
  run(`window.__uploads = []; window.__inserts = []; window.__blobBytes = 'zz';
window.__shareDone = false;
ecShareFace('9780000000002', 'jacket', 'spine', 'data:image/jpeg;base64,Y2')
  .then(function (r) { window.__shareRes = r; window.__shareDone = true; });`);
  await flush('window.__shareDone');
  ok('re-sharing identical bytes dedups (no duplicate upload or candidate)',
    run(`window.__shareRes`) === true &&
    run(`window.__uploads`).length === 0 &&
    run(`window.__inserts`).filter(function (i) { return i.table === 'edition_assets' && !i.upsert; }).length === 0);

  // Own new capture: a second immutable candidate, never an overwrite. The
  // slot already exists (canonical = first candidate), so no slot upsert and
  // no legacy re-exposure — the new capture is evidence, not canonical.
  run(`window.__uploads = []; window.__inserts = []; window.__blobBytes = 'x-new';
window.__shareDone = false;
ecShareFace('9780000000001', 'jacket', 'spine', 'data:image/jpeg;base64,Z')
  .then(function (r) { window.__shareRes = r; window.__shareDone = true; });`);
  await flush('window.__shareDone');
  const upD = run(`window.__uploads[0] && window.__uploads[0].path`);
  ok("contributor's new capture becomes a second candidate (never overwrites)",
    run(`window.__shareRes`) === true &&
    run(`window.__uploads`).length === 1 && upD !== upA &&
    run(`window.__pool.assets`).filter(function (r) { return r.isbn === '9780000000001'; }).length === 2 &&
    run(`window.__pool.assets`).filter(function (r) { return r.isbn === '9780000000001'; })
      .every(function (r) { return r.source_user_id === 'user-1'; }) &&
    run(`window.__inserts`).filter(function (i) { return i.table === 'edition_asset_slots'; }).length === 0 &&
    run(`window.__pool.legacy`).filter(function (r) { return r.isbn === '9780000000001'; }).length === 1);

  // Withdrawing a face you contributed deletes your own candidates via their
  // STORED paths (quarantine) and the legacy row — true only when something
  // was actually withdrawn.
  run(`window.__pool.assets.push({ id: 'cand-wd-1', edition_id: 'ed-3', isbn: '9780000000003',
  face: 'fore_edge', appearance: 'jacket', bucket: 'edition-images',
  path: 'fore_edge/jacket/stored-path-abc.jpg', source_user_id: 'user-1' });
window.__pool.legacy.push({ isbn: '9780000000003', face: 'fore_edge', appearance: 'jacket',
  bucket: 'edition-images', path: 'fore_edge/jacket/9780000000003.jpg', uploaded_by: 'user-1' });
window.__moves = [];
library = [{ id: 'ecb8', title: 'Withdraw Me', isbn13: '9780000000003',
  editionFaces: { jacket: { fore_edge: 'data:image/jpeg;base64,BAD' } } }];
ecStartScan('ecb8');
document.querySelector('#ec-wizard [data-ec-rm="jacket:fore_edge"]').click();`);
  await flush('window.__moves.length > 0');
  ok('removing a contributed face withdraws it from the pool',
    run(`window.__pool.assets`).filter(function (r) { return r.id === 'cand-wd-1'; }).length === 0 &&
    run(`window.__pool.legacy`).filter(function (r) { return r.isbn === '9780000000003'; }).length === 0 &&
    JSON.stringify(run(`window.__moves`)) ===
      JSON.stringify([['fore_edge/jacket/stored-path-abc.jpg',
        'quarantine/withdrawn-fore_edge-jacket-9780000000003-candwd1.jpg']]) &&
    !q('#ec-wizard [data-ec-rm="jacket:fore_edge"]'));
  run(`document.getElementById('ec-ap-cancel').click();`);

  // Removing a face someone else contributed leaves the pool alone.
  run(`window.__pool.assets.push({ id: 'asset-other', edition_id: 'ed-4', isbn: '9780000000004',
  face: 'spine', appearance: 'jacket', bucket: 'edition-images',
  path: 'spine/jacket/' + 'b'.repeat(64) + '.jpg', source_user_id: 'user-2' });
window.__pool.legacy.push({ isbn: '9780000000004', face: 'spine', appearance: 'jacket',
  bucket: 'edition-images', path: 'spine/jacket/9780000000004.jpg', uploaded_by: 'user-2' });
window.__moves = [];
library = [{ id: 'ecb9', title: 'Not Mine', isbn13: '9780000000004',
  editionFaces: { jacket: { spine: 'data:image/jpeg;base64,S' } } }];
ecStartScan('ecb9');
document.querySelector('#ec-wizard [data-ec-rm="jacket:spine"]').click();`);
  await new Promise(function (r) { setTimeout(r, 300); });
  ok("removing a face contributed by someone else leaves the pool alone",
    run(`window.__pool.assets`).filter(function (r) { return r.id === 'asset-other'; }).length === 1 &&
    run(`window.__pool.legacy`).filter(function (r) { return r.isbn === '9780000000004'; }).length === 1 &&
    run(`window.__moves`).length === 0 &&
    !q('#ec-wizard [data-ec-rm="jacket:spine"]'));
  run(`document.getElementById('ec-ap-cancel').click();`);

  // Binary faces: the appearance-screen enhance button resolves the asset ref
  // to a data URL, and Keep stores the enhancement as a new binary asset.
  run(`window.ecBlobToDataUrl = async function () { return 'data:image/jpeg;base64,BINFACE'; };
window.ecBlobSha256 = async function () { return 'ee'.repeat(32); };
window.ecDataUrlSize = async function () { return { width: 120, height: 200 }; };
window.editionAssetBlob = async function () { return {}; };
window.fetch = async function (url, opts) {
  if (url === '/api/enhance-face') {
    return { ok: true, status: 200, json: async function () { return { image: 'data:image/jpeg;base64,ENH' }; } };
  }
  return { blob: async function () { return {}; } };
};
window.__ehBinDone = false;
library = [{ id: 'ecb10', title: 'Binary Enhance', isbn13: '9780000000010',
  editionFaceRefs: { jacket: { spine: { assetId: 'old-id', bucket: 'edition-images',
    path: 'spine/jacket/old.jpg', width: 120, height: 200 } } },
  spinePhotoAssetId: 'old-id' }];
ecStartScan('ecb10');`);
  ok('binary saved face has an enhance button', !!q('#ec-wizard [data-ec-eh="jacket:spine"]'));
  run(`document.querySelector('#ec-wizard [data-ec-eh="jacket:spine"]').click();`);
  await flush('!!document.getElementById("ec-eh-sharpen")');
  ok('binary face enhance resolves the ref and opens the picker', !!q('#ec-enhance #ec-eh-sharpen'));
  run(`document.getElementById('ec-eh-sharpen').click();`);
  await flush('!!document.getElementById("ec-eh-keep")');
  run(`document.getElementById('ec-eh-keep').click();
(function wait() {
  if (library[0].editionFaceRefs.jacket.spine.assetId !== 'old-id') { window.__ehBinDone = true; }
  else setTimeout(wait, 30);
})();`);
  await flush('window.__ehBinDone');
  ok('kept enhancement replaces the binary ref (new asset, no data URL)',
    run(`library[0].editionFaceRefs.jacket.spine.assetId`) !== 'old-id' &&
    run(`library[0].editionFaceRefs.jacket.spine.path`) === 'spine/jacket/' + 'ee'.repeat(32) + '.jpg' &&
    run(`library[0].spinePhotoAssetId`) === run(`library[0].editionFaceRefs.jacket.spine.assetId`) &&
    !run(`library[0].editionFaces`));
  run(`document.getElementById('ec-ap-cancel').click();`);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
