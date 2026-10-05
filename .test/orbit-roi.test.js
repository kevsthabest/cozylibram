// Orbit ROI detection (v296): the detector constrains itself to the on-screen
// guide, so background clutter outside the guide can no longer win the
// component race. Regression test for the real-device failure where a
// well-framed spine returned null because monitor/desk clutter produced the
// largest edge component.
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

// Book + striped clutter region (the real-device failure shape).
const sceneJs = `
(function () {
  var w = 240, h = 320;
  var g = new Uint8ClampedArray(w * h);
  for (var i = 0; i < w * h; i++) g[i] = 18;
  var b = { cx: 110, cy: 170, rw: 52, rh: 220 };
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    if (Math.abs(x - b.cx) <= b.rw / 2 && Math.abs(y - b.cy) <= b.rh / 2) g[y * w + x] = 220;
  }
  for (var yy = 20; yy < 300; yy++) for (var xx = 158; xx < 236; xx++) {
    g[yy * w + xx] = ((yy >> 2) % 2) ? 150 : 60;
  }
  return g;
})()`;

const noRoi = run(`(function () { var g = (${sceneJs}); var r = ecDetectBookRect(g, 240, 320);
  return r ? JSON.stringify({ cx: Math.round(r.cx), w: Math.round(r.w), h: Math.round(r.h) }) : 'null'; })()`);
ok('without ROI the clutter wins and nothing validates (the real bug)', noRoi === 'null');

const withRoi = run(`(function () { var g = (${sceneJs});
  var r = ecDetectBookRect(g, 240, 320, { x: 75, y: 50, w: 70, h: 240 });
  return r ? JSON.stringify({ cx: Math.round(r.cx), w: Math.round(r.w), h: Math.round(r.h) }) : 'null'; })()`);
{
  const r = withRoi === 'null' ? null : JSON.parse(withRoi);
  ok('with ROI the book is detected', !!r && Math.abs(r.cx - 110) <= 8 &&
    Math.abs(r.w - 52) <= 14 && Math.abs(r.h - 220) <= 16);
}

// The ROI gate itself: a valid rect outside the guide must not be accepted.
const gateOff = run(`(function () {
  var g = new Uint8ClampedArray(240 * 320);
  for (var i = 0; i < 240 * 320; i++) g[i] = 18;
  for (var y = 0; y < 320; y++) for (var x = 0; x < 240; x++) {
    if (Math.abs(x - 200) <= 20 && Math.abs(y - 160) <= 90) g[y * 240 + x] = 220;
  }
  var r = ecDetectBookRect(g, 240, 320, { x: 20, y: 60, w: 60, h: 200 });
  return r ? 'found' : 'null';
})()`);
ok('a book outside the guide is rejected when ROI is given', gateOff === 'null');

const gateOn = run(`(function () {
  var g = new Uint8ClampedArray(240 * 320);
  for (var i = 0; i < 240 * 320; i++) g[i] = 18;
  for (var y = 0; y < 320; y++) for (var x = 0; x < 240; x++) {
    if (Math.abs(x - 200) <= 20 && Math.abs(y - 160) <= 90) g[y * 240 + x] = 220;
  }
  var plain = ecDetectBookRect(g, 240, 320);
  var r = ecDetectBookRect(g, 240, 320, { x: 160, y: 60, w: 80, h: 200 });
  return JSON.stringify({ plain: !!plain, roi: !!r });
})()`);
{
  const r = JSON.parse(gateOn);
  ok('no-ROI behavior is unchanged and covering ROI accepts', r.plain === true && r.roi === true);
}

// ecGuideRoiMath: 9:16 video in a 3:4 viewfinder, tall guide (CSS: 78% height,
// 1:4.2 aspect, centered).
const tall916 = run(`JSON.stringify(ecGuideRoiMath(
  { left: 90.3, top: 35.2, width: 59.4, height: 249.6 },
  { left: 0, top: 0, width: 240, height: 320 },
  720, 1280, 240, 427))`);
{
  const r = JSON.parse(tall916);
  ok('guide maps to the center band on a 9:16 video',
    near(r.x, 90.3, 1) && near(r.y, 88.6, 1) && near(r.w, 59.4, 1) && near(r.h, 249.8, 1));
}

// 4:3 video: width is the cropped dimension.
const wide43 = run(`JSON.stringify(ecGuideRoiMath(
  { left: 90.3, top: 35.2, width: 59.4, height: 249.6 },
  { left: 0, top: 0, width: 240, height: 320 },
  640, 480, 240, 180))`);
{
  const r = JSON.parse(wide43);
  ok('guide maps sanely on a 4:3 video',
    near(r.x, 103.3, 1) && near(r.y, 19.8, 1) && near(r.w, 33.4, 1) && near(r.h, 140.4, 1));
}

ok('degenerate inputs return null',
  run(`ecGuideRoiMath(null, { width: 1 }, 1, 1, 1, 1)`) === null &&
  run(`ecGuideRoiMath({ width: 0 }, { left: 0, top: 0, width: 240, height: 320 }, 720, 1280, 240, 427)`) === null);

// ecTopComponents ranks center-biased by score.
const topk = run(`(function () {
  var m = new Uint8Array(240 * 320);
  function blob(cx, cy, rw, rh) {
    for (var y = Math.max(0, cy - rh / 2); y < Math.min(320, cy + rh / 2); y++)
      for (var x = Math.max(0, cx - rw / 2); x < Math.min(240, cx + rw / 2); x++) m[y * 240 + x] = 1;
  }
  blob(120, 160, 40, 40);   // small, centered
  blob(30, 40, 60, 60);     // bigger, corner
  var t = ecTopComponents(m, 240, 320, 2);
  return JSON.stringify(t.map(function (c) { return Math.round(c.cx); }));
})()`);
{
  const cs = JSON.parse(topk);
  ok('top components are score-ordered (center bias beats raw area)',
    cs.length === 2 && cs[0] === 120 && cs[1] === 30);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
