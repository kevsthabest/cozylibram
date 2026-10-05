// Orbit guided detection (v297): with a guide ROI the detector verifies
// book-like edge presence and trusts the guide rect itself — the user framed
// the shot; re-measuring the outline is what background clutter corrupted.
// Regression tests for the real-device failures (monitor scene, wood floor).
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
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1);

const prelude = `
function synthGray(w, h, rects) {
  var g = new Uint8ClampedArray(w * h), x, y, i;
  for (i = 0; i < w * h; i++) g[i] = 18;
  (rects || []).forEach(function (r) {
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (Math.abs(x - r.cx) <= r.rw / 2 && Math.abs(y - r.cy) <= r.rh / 2) g[y * w + x] = 220;
    }
  });
  return g;
}
function stripes(g, w, h, x0, x1, y0, y1) {
  for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) g[y * w + x] = ((y >> 2) % 2) ? 150 : 60;
}
`;

// ---- 1. presence: book in guide vs empty guide ----
const presBook = run(prelude + `JSON.stringify(ecGuidePresence(
  synthGray(240, 320, [{ cx: 110, cy: 160, rw: 52, rh: 220 }]), 240, 320,
  { x: 75, y: 40, w: 70, h: 240 }))`);
{
  const p = JSON.parse(presBook);
  ok('book in guide has strong vertical presence', Math.max(p.v, p.h) >= 0.35);
}

const presEmpty = run(prelude + `(function () {
  var g = new Uint8ClampedArray(240 * 320), x, y;
  for (y = 0; y < 320; y++) for (x = 0; x < 240; x++) g[y * 240 + x] = 120 + ((x * 13 + y * 7) % 17);
  var p = ecGuidePresence(g, 240, 320, { x: 75, y: 40, w: 70, h: 240 });
  return JSON.stringify(p);
})()`);
{
  const p = JSON.parse(presEmpty);
  ok('empty guide has no presence', Math.max(p.v, p.h) < 0.35);
}

// ---- 2. guide trust: the clutter scene that returned null in v294-v296 ----
const clutter = run(prelude + `(function () {
  var g = synthGray(240, 320, [{ cx: 110, cy: 170, rw: 52, rh: 220 }]);
  stripes(g, 240, 320, 158, 236, 20, 300); // background clutter wins the old component race
  var roi = { x: 75, y: 50, w: 70, h: 240 };
  var r = ecDetectBookRect(g, 240, 320, roi, 'tall');
  return r ? JSON.stringify({ cx: Math.round(r.cx), cy: Math.round(r.cy),
                              w: Math.round(r.w), h: Math.round(r.h) }) : 'null';
})()`);
{
  const r = clutter === 'null' ? null : JSON.parse(clutter);
  ok('clutter scene locks onto the guide rect', !!r &&
    near(r.cx, 75 + 35, 2) && near(r.cy, 50 + 120, 2) && near(r.w, 70, 2) && near(r.h, 240, 2));
}

// ---- 3. no presence -> null (guidance shows instead of a bad capture) ----
const noPres = run(prelude + `(function () {
  var g = new Uint8ClampedArray(240 * 320), x, y;
  for (y = 0; y < 320; y++) for (x = 0; x < 240; x++) g[y * 240 + x] = 120 + ((x * 13 + y * 7) % 17);
  return ecDetectBookRect(g, 240, 320, { x: 75, y: 40, w: 70, h: 240 }, 'tall') ? 'found' : 'null';
})()`);
ok('empty guide returns null', noPres === 'null');

// ---- 4. no-ROI behavior unchanged (classic flow) ----
const classic = run(prelude + `(function () {
  var r = ecDetectBookRect(synthGray(240, 320, [{ cx: 120, cy: 160, rw: 80, rh: 160 }]), 240, 320);
  return r ? JSON.stringify({ cx: Math.round(r.cx), w: Math.round(r.w) }) : 'null';
})()`);
{
  const r = classic === 'null' ? null : JSON.parse(classic);
  ok('classic no-ROI detection unchanged', !!r && Math.abs(r.cx - 120) <= 10 && Math.abs(r.w - 80) <= 16);
}

// ---- 5. portrait guide (front/back covers) ----
const portrait = run(prelude + `(function () {
  var g = synthGray(240, 320, [{ cx: 120, cy: 160, rw: 140, rh: 210 }]);
  var roi = { x: 40, y: 45, w: 160, h: 230 };
  var r = ecDetectBookRect(g, 240, 320, roi, 'portrait');
  return r ? JSON.stringify({ cx: Math.round(r.cx), w: Math.round(r.w), h: Math.round(r.h) }) : 'null';
})()`);
{
  const r = portrait === 'null' ? null : JSON.parse(portrait);
  ok('portrait guide locks onto the guide rect', !!r &&
    near(r.cx, 120, 2) && near(r.w, 160, 2) && near(r.h, 230, 2));
}

// ---- 6. ecGuideRoiMath (unchanged from v296) ----
const tall916 = run(`JSON.stringify(ecGuideRoiMath(
  { left: 90.3, top: 35.2, width: 59.4, height: 249.6 },
  { left: 0, top: 0, width: 240, height: 320 },
  720, 1280, 240, 427))`);
{
  const r = JSON.parse(tall916);
  ok('guide maps to the center band on a 9:16 video',
    near(r.x, 90.3, 1) && near(r.y, 88.6, 1) && near(r.w, 59.4, 1) && near(r.h, 249.8, 1));
}
ok('degenerate inputs return null',
  run(`ecGuideRoiMath(null, { width: 1 }, 1, 1, 1, 1)`) === null &&
  run(`ecGuideRoiMath({ width: 0 }, { left: 0, top: 0, width: 240, height: 320 }, 720, 1280, 240, 427)`) === null);

// ---- 7. ecTopComponents still ranks center-biased (used by ecLargestComponent) ----
const topk = run(`(function () {
  var m = new Uint8Array(240 * 320);
  function blob(cx, cy, rw, rh) {
    for (var y = Math.max(0, cy - rh / 2); y < Math.min(320, cy + rh / 2); y++)
      for (var x = Math.max(0, cx - rw / 2); x < Math.min(240, cx + rw / 2); x++) m[y * 240 + x] = 1;
  }
  blob(120, 160, 40, 40);
  blob(30, 40, 60, 60);
  return JSON.stringify(ecTopComponents(m, 240, 320, 2).map(function (c) { return Math.round(c.cx); }));
})()`);
{
  const cs = JSON.parse(topk);
  ok('top components are score-ordered', cs.length === 2 && cs[0] === 120 && cs[1] === 30);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
