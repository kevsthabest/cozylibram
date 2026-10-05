// v291: manual Capture shows the already-cropped best frame in the confirm
// sheet (like auto-scan), instead of the corner editor on the full frame.
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

(async () => {
  run(`
    window.HTMLVideoElement.prototype.play = function () { return Promise.resolve(); };
    window.requestAnimationFrame = function () { return 0; };
    window.cancelAnimationFrame = function () {};
    var fakeStream = { getTracks: function () { return []; }, getVideoTracks: function () { return []; } };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: function () { return Promise.resolve(fakeStream); } },
      configurable: true
    });
    var stubCtx = function () {
      return {
        drawImage: function () {},
        getImageData: function (x, y, w, h) {
          return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
        },
        clearRect: function () {}, save: function () {}, restore: function () {},
        beginPath: function () {}, moveTo: function () {}, lineTo: function () {},
        closePath: function () {}, stroke: function () {}, fill: function () {},
        arc: function () {}
      };
    };
    var realCE = document.createElement.bind(document);
    document.createElement = function (tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        return { width: 0, height: 0,
          getContext: function () { return stubCtx(); },
          toDataURL: function () { return 'data:image/jpeg;base64,FAKEFRAME'; } };
      }
      return realCE(tag);
    };
    // Deterministic quad detection + warp: the warp output is the "crop".
    ecDetectQuadForCanvas = function () { return [[20,20],[380,20],[380,280],[20,280]]; };
    ecWarpCanvas = function () {
      return { toDataURL: function () { return 'data:image/jpeg;base64,WARPED'; } };
    };
    window.__used = null;
    ecCaptureFace({ label: 'Front', guide: 'rect', hint: 'hint' }, 'sub', 'step 1',
      function (url, opts) { window.__used = { url: url, opts: opts }; });
  `);
  await wait(150); // getUserMedia resolves, viewfinder opens
  ok('viewfinder opened', !!q('#ec-video'));
  run(`
    Object.defineProperty(document.getElementById('ec-video'), 'videoWidth',
      { value: 400, configurable: true });
    Object.defineProperty(document.getElementById('ec-video'), 'videoHeight',
      { value: 300, configurable: true });
  `);
  q('#ec-cap-snap').click();
  await wait(1500); // 5-frame burst at 90ms + promise hops
  ok('manual capture opens the confirm sheet, not the corner editor',
    !!q('#ec-confirm') && !q('#ec-editor'));
  var img = q('#ec-confirm img');
  ok('confirm sheet shows the warped (already cropped) best frame',
    !!img && String(img.src).indexOf('data:image/jpeg;base64,WARPED') === 0);

  q('#ec-cf-use').click();
  await wait(150);
  ok('Use stores the cropped image directly',
    run(`window.__used && window.__used.url`) === 'data:image/jpeg;base64,WARPED' &&
    run(`window.__used && window.__used.opts && window.__used.opts.warped`) === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
