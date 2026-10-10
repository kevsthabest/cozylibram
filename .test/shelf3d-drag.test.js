// v432: unit tests for extracted 3D-shelf drag/scroll pure functions.
// Tests Shelf3DDrag (pressHoldToDrag, slopExceeded, computeRestY) and
// Shelf3DInventory (invItemInnerHTML, filterByTab) with synthetic events.
// These cover the logic behind the v413/v420/v422 regression chain.
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

// Load the extracted modules via script elements (same pattern as harness).
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/', runScripts: 'dangerously' });
const window = dom.window;
// APP_ROOT points at the repo under test (worktree during dev, main repo in CI).
const APP_ROOT = process.env.APP_ROOT || '/tmp/code-health';
for (const f of ['js/219-shelf3d-drag.js', 'js/220-shelf3d-inventory.js']) {
  const el = window.document.createElement('script');
  el.textContent = fs.readFileSync(APP_ROOT + '/' + f, 'utf8');
  window.document.body.appendChild(el);
}

const D = window.Shelf3DDrag;
const I = window.Shelf3DInventory;

ok('Shelf3DDrag is exposed', !!D);
ok('Shelf3DInventory is exposed', !!I);

/* ---- slopExceeded ---- */
ok('slopExceeded: no movement', D.slopExceeded(0, 0, 0, 0, 10) === false);
ok('slopExceeded: within slop', D.slopExceeded(0, 0, 5, 5, 10) === false);
ok('slopExceeded: exactly at slop', D.slopExceeded(0, 0, 10, 0, 10) === false);
ok('slopExceeded: beyond slop', D.slopExceeded(0, 0, 11, 0, 10) === true);
ok('slopExceeded: diagonal beyond', D.slopExceeded(0, 0, 8, 8, 10) === true); // ~11.3

/* ---- computeRestY ---- */
const LEVELS = [1.0, 2.0, 3.0];
ok('computeRestY: non-edge', D.computeRestY(LEVELS, 1, false) === 2.0);
ok('computeRestY: edge adds 0.06', D.computeRestY(LEVELS, 1, true) === 2.06);
ok('computeRestY: shelf 0', D.computeRestY(LEVELS, 0, false) === 1.0);

/* ---- invItemInnerHTML ---- */
const html = I.invItemInnerHTML({ svg: '<svg></svg>', name: 'Plant', owned: 3 });
ok('invItemInnerHTML: has svg', html.includes('<svg></svg>'));
ok('invItemInnerHTML: has name', html.includes('Plant'));
ok('invItemInnerHTML: has count', html.includes('\u00d73'));

/* ---- filterByTab ---- */
const items = [
  { type: 'plant', room: false },
  { type: 'spiderweb', room: true },
  { type: 'candle', room: false },
];
ok('filterByTab: shelf tab', I.filterByTab(items, 'shelf').length === 2);
ok('filterByTab: room tab', I.filterByTab(items, 'room').length === 1);
ok('filterByTab: room item correct', I.filterByTab(items, 'room')[0].type === 'spiderweb');

/* ---- pressHoldToDrag (synthetic events) ---- */
function fire(el, type, props) {
  const e = new window.Event(type, { bubbles: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}

(function testPressHold() {
  const doc = window.document;
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  let started = 0;
  D.pressHoldToDrag(el, function () { started++; }, 50, 10); // short hold for test

  // Mouse: starts immediately (no hold).
  fire(el, 'pointerdown', { pointerType: 'mouse', clientX: 0, clientY: 0 });
  ok('pressHoldToDrag: mouse starts immediately', started === 1);

  // Touch: hold fires after timer.
  started = 0;
  fire(el, 'pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 });
  ok('pressHoldToDrag: touch does not start immediately', started === 0);

  // Touch: moving beyond slop cancels (no start).
  setTimeout(function () {
    fire(el, 'pointermove', { clientX: 20, clientY: 0 });
    fire(el, 'pointerup', {});
    setTimeout(function () {
      ok('pressHoldToDrag: slop cancels hold', started === 0);
      ok('pressHoldToDrag: swipe flag set', el.dataset.swiped === '1');

      // Touch: clean hold fires startFn.
      delete el.dataset.swiped;
      fire(el, 'pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 });
      setTimeout(function () {
        ok('pressHoldToDrag: hold fires startFn', started === 1);
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
      }, 80);
    }, 80);
  }, 10);
})();
