// Measurement editor (v287): handle dots scale to screen px, not image px.
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

(async () => {
  // Open the editor, then drive img.onload manually with a stubbed layout:
  // a 4000px phone photo displayed at 380 CSS px.
  run(`library = [{ id: 'm1', title: 'Measure Me' }];
editionMeasureOpenEditor('data:image/png;base64,iVBOR', 'm1');`);
  var img = q('#edm-img');
  Object.defineProperty(img, 'naturalWidth', { value: 4000, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 3000, configurable: true });
  img.getBoundingClientRect = function () {
    return { width: 380, height: 285, left: 0, top: 0, right: 380, bottom: 285 };
  };
  img.onload();

  var k = 4000 / 380;
  var dotR = parseFloat(q('#ed-measure .edm-point').getAttribute('r'));
  ok('dots render at screen size on hi-res photos (not image px)',
    Math.abs(dotR - 12 * k) < 0.01);
  var haloR = parseFloat(q('#ed-measure .edm-halo').getAttribute('r'));
  ok('halos give a fat grab target', Math.abs(haloR - 30 * k) < 0.01);
  var lw = parseFloat(q('#edm-ref').getAttribute('stroke-width'));
  ok('line width scales with the dots', Math.abs(lw - 5 * k) < 0.01);

  // Dragging a halo moves its point.
  var halo = q('#ed-measure .edm-halo[data-i="1"]');
  var before = halo.getAttribute('cx');
  halo.dispatchEvent(new window.PointerEvent('pointerdown',
    { bubbles: true, clientX: 200, clientY: 100, pointerId: 1 }));
  q('#edm-svg').dispatchEvent(new window.PointerEvent('pointermove',
    { bubbles: true, clientX: 250, clientY: 120, pointerId: 1 }));
  var after = halo.getAttribute('cx');
  ok('dragging a halo moves its point', before !== after &&
    Math.abs(parseFloat(after) - 250 * k) < 1);

  // Degenerate layout (no rect yet): scale falls back to 1, no explosion.
  img.getBoundingClientRect = function () {
    return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  };
  img.onload();
  var dotR2 = parseFloat(q('#ed-measure .edm-point').getAttribute('r'));
  ok('zero-size layout falls back safely', dotR2 === 12);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
