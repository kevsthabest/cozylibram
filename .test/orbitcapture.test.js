// Orbit capture (v294): hands-free multi-face scan — stable quad matching the
// prompted face auto-captures, warps, and advances; skip/manual still work.
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Tall enough to fail the portrait gate (2.8): isolates each test face.
const TALL = () => ({ cx: 120, cy: 120, w: 60, h: 200, angle: 0, quad: [[90, 20], [150, 20], [150, 220], [90, 220]] });
const PORTRAIT = () => ({ cx: 120, cy: 120, w: 150, h: 200, angle: 0, quad: [[45, 20], [195, 20], [195, 220], [45, 220]] });

const DEFAULT_STEPS = [
  { appearance: 'jacket', face: 'spine', skippable: false },
  { appearance: 'jacket', face: 'front', skippable: true },
];

async function setup(steps) {
  const stepsJson = JSON.stringify(steps || DEFAULT_STEPS);
  run(`
    // Tear down any orbit/wizard left over from a previous case.
    try {
      var c = document.getElementById('ec-ob-cancel'); if (c) c.click();
      var w = document.getElementById('ec-wizard'); if (w) w.remove();
      var o = document.getElementById('ec-orbit'); if (o) o.remove();
    } catch (e) {}
    EC = null;
    // Free-running rAF driven by real time.
    window.requestAnimationFrame = function (fn) { return setTimeout(function () { fn(performance.now()); }, 0); };
    window.cancelAnimationFrame = function (id) { clearTimeout(id); };
    window.HTMLVideoElement.prototype.play = function () { return Promise.resolve(); };
    var fakeStream = { getTracks: function () { return []; }, getVideoTracks: function () { return []; } };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: function () { return Promise.resolve(fakeStream); } },
      configurable: true
    });
    var stubCtx = function () {
      return {
        drawImage: function () {},
        getImageData: function (x, y, w, h) {
          return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
        },
        putImageData: function () {},
        clearRect: function () {}, save: function () {}, restore: function () {},
        beginPath: function () {}, moveTo: function () {}, lineTo: function () {},
        closePath: function () {}, stroke: function () {}, fill: function () {},
        arc: function () {}
      };
    };
    var realCE = window.__realCE || (window.__realCE = document.createElement.bind(document));
    document.createElement = function (tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        return { width: 0, height: 0,
          getContext: function () { return stubCtx(); },
          toDataURL: function () { return 'data:image/jpeg;base64,WARPED'; } };
      }
      return realCE(tag);
    };
    window.__obRect = null;
    window.__now = 1000000;
    Date.now = function () { return window.__now; };
    ecDetectBookRect = function () { return window.__obRect ? window.__obRect() : null; };
    ecDetectQuadForCanvas = function () { return [[20,20],[380,20],[380,280],[20,280]]; };
    ecWarpCanvas = function () {
      return { toDataURL: function () { return 'data:image/jpeg;base64,WARPED'; } };
    };
    EC = { appearances: ['jacket'], steps: ` + stepsJson + `, idx: 0, results: {}, token: null };
  `);
  await wait(50);
}

async function openOrbit() {
  run(`ecOrbitCapture();`);
  await wait(200); // getUserMedia resolves, camera "streams"
  run(`
    Object.defineProperty(document.getElementById('ec-ob-video'), 'videoWidth', { value: 400, configurable: true });
    Object.defineProperty(document.getElementById('ec-ob-video'), 'videoHeight', { value: 300, configurable: true });
  `);
}

(async () => {
  // ---- 1. happy path: two faces auto-capture and land in the review ----
  await setup();
  run(`window.__obRect = ${TALL.toString()};`);
  await openOrbit();
  ok('orbit sheet opens on the first face', !!q('#ec-orbit') && q('#ec-ob-title').textContent === 'Spine');
  await wait(4500); // ~6 steady frames + burst + interstitial
  ok('spine auto-captured and stored warped',
    run(`EC.results.jacket.spine`) === 'data:image/jpeg;base64,WARPED');
  // interstitial ('captured') lasts 900ms — poll for the next prompt
  let title = '';
  for (let i = 0; i < 30 && title !== 'Front cover'; i++) {
    await wait(200);
    title = q('#ec-ob-title') ? q('#ec-ob-title').textContent : '';
  }
  ok('orbit advances to the next face', !!q('#ec-orbit') && title === 'Front cover');
  run(`window.__obRect = ${PORTRAIT.toString()};`);
  await wait(5000);
  ok('front auto-captured too', run(`EC.results.jacket.front`) === 'data:image/jpeg;base64,WARPED');
  ok('orbit finishes into the review', !!q('#ec-wizard') && !q('#ec-orbit'));

  // ---- 2. skip advances past a skippable face; non-skippable can't skip ----
  await setup([{ appearance: 'jacket', face: 'front', skippable: true }]);
  await openOrbit();
  ok('skip button visible on skippable face', q('#ec-ob-skip').style.display !== 'none');
  run(`document.getElementById('ec-ob-skip').click();`);
  await wait(1500);
  ok('skip lands in the review with nothing stored',
    !!q('#ec-wizard') && run(`!EC.results.jacket || !EC.results.jacket.front`));

  await setup([{ appearance: 'jacket', face: 'spine', skippable: false }]);
  await openOrbit();
  ok('skip hidden on non-skippable face', q('#ec-ob-skip').style.display === 'none');
  run(`document.getElementById('ec-ob-skip').click();`);
  await wait(300);
  ok('skip refused on non-skippable face', q('#ec-ob-title').textContent === 'Spine');

  // ---- 3. graduated no-lock guidance (v295): move closer, then flash tip ----
  await setup([{ appearance: 'jacket', face: 'spine', skippable: false }]);
  await openOrbit(); // __obRect stays null: nothing detected
  await wait(400);
  ok('initial prompt asks to show the face',
    q('#ec-ob-msg').textContent === 'Show the spine — hold steady');
  run(`window.__now += 9000;`);
  await wait(400);
  ok('8s with no lock asks the user to move closer',
    q('#ec-ob-msg').textContent === 'Move closer — fill the dashed guide with the spine');
  run(`window.__now += 12000;`);
  await wait(400);
  ok('20s with no lock mentions the flash trap',
    q('#ec-ob-msg').textContent.indexOf('flash off') !== -1);

  // ---- 4. manual mode drops into the classic per-face flow ----
  await setup();
  await openOrbit();
  run(`document.getElementById('ec-ob-manual').click();`);
  await wait(400);
  ok('manual mode exits orbit into the classic step',
    !q('#ec-orbit') && !!q('#ec-wizard') && !!q('#ec-st-photo'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
