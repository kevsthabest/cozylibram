// Issue #375: the 3D shelf trap. Three linked symptoms, three pins:
//
// (1) The hang — js/215's render loop let ambient effects (candle flames,
//     fairy bulbs) claim a full scene render on EVERY animation frame,
//     unconditionally. On a slow renderer a single render takes seconds,
//     so an unbroken chain of them starves input, transitions and
//     timers: the page reads as hung. The engine is device-verified
//     (jsdom has no WebGL), so — like shelf-reflow's maker parsing —
//     this suite pins the fix at the source contract: ambient-only
//     renders must be cadence-bounded behind a measured frame-cost gate,
//     and the unconditional ambient term must be gone from the render
//     decision. Interactive renders are never delayed by the bound.
//
// (2) The inventory panel — its close button and Escape handlers exist
//     and work when the thread runs; what the app rule (every sheet
//     dismisses by downward drag, via the shared helper or a documented
//     equivalent) never had here is a drag-to-dismiss. The panel is
//     engine-owned DOM, so js/215 carries its own equivalent on the
//     panel's head row. Pinned at the same source seam, plus the
//     pre-existing close/Escape wiring must stay.
//
// (3) The preference trap — js/217 behaviour, executed for real below
//     against a stubbed scene layer (the section-12 pattern from
//     shelf3d-integration): entering 3D arms a per-device watchdog flag;
//     it clears when the mount proves itself, on clean unmount, and on
//     the WebGL fallbacks. A flag that survives to a later page load
//     means the previous attempt wedged before proving — the next visit
//     must land in 2D with the preference reset, not back in the trap.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- source contracts: js/215 render bound + panel dismissal ---- */
const s215 = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
{
  // The render decision must not contain the old unconditional ambient
  // term (candle/fairy presence alone forcing a render every frame).
  ok('render loop: no unconditional ambient term in the render decision',
    !/candleFlames\.length > 0 \|\| fairyBulbs\.length > 0;\s*\n\s*if \(animating/.test(s215) &&
    !/if \(animating \|\| needsRender\)/.test(s215));
  ok('render loop: ambient-only renders are cadence-bounded behind measured frame cost',
    /frameEma/.test(s215) && /ambientOnly/.test(s215) && /lastAmbientRender/.test(s215));
  ok('panel: close button wiring intact', /\$\('s3dInvClose'\)\.addEventListener\('click'/.test(s215));
  ok('panel: Escape dismissal wiring intact',
    /'keydown'/.test(s215) && /e\.key === 'Escape'\) \{ closeInventory\(\)/.test(s215));
  const dragAt = s215.indexOf('invDrag');
  ok('panel: drag-to-dismiss wired on the panel head (documented wireSheetDrag equivalent)',
    dragAt >= 0 && /s3d-inv-head/.test(s215) &&
    s215.indexOf('closeInventory()', dragAt) > dragAt &&
    /pointermove/.test(s215.slice(dragAt, dragAt + 2500)));
  ok('panel: head row opts out of scroll-gesture stealing so the drag reaches it',
    /s3d-inv-head\{[^}]*touch-action:none/.test(s215));
}

/* ---- behaviour: js/217 watchdog against a stubbed scene layer ---- */
const WD = 'cozylibram.s3d.watchdog';
(async () => {
  const doc = window.document;
  run(`
    localStorage.removeItem('shelfViewMode');
    localStorage.removeItem('${WD}');
    window.__mountCalls = 0;
    window.Shelf3D = {
      mount: function () { window.__mountCalls++; return Promise.resolve(); },
      showCase: function () {}, highlightBook: function () {},
      setNeighbours: function () {}, unmount: function () {}
    };
    library = [{ id: 'bk1', title: 'Book One', status: 'read' }];
    shelfGroup = 'read';
    shelfSetViewMode('3d');
  `);

  // (a) a fresh 3D entry arms the watchdog and mounts.
  run(`renderShelf()`);
  await wait(60);
  ok('watchdog: entering 3D arms the flag', run(`localStorage.getItem('${WD}')`) === '1');
  ok('watchdog: the armed entry still mounts the scene', run(`window.__mountCalls`) === 1);
  ok('watchdog: the 3D view is on screen', !!doc.getElementById('shelf3d'));

  // (b) the mount proving itself clears the flag (proof window lapses).
  await wait(1900);
  ok('watchdog: a proven mount clears the flag', run(`localStorage.getItem('${WD}')`) === null);

  // (c) re-enter (unmount clears, re-arm), then a clean unmount before
  //     the proof window also clears it.
  run(`renderShelf()`);
  await wait(60);
  ok('watchdog: re-entry re-arms', run(`localStorage.getItem('${WD}')`) === '1');
  run(`shelfUnmount3D()`);
  ok('watchdog: clean unmount clears the flag', run(`localStorage.getItem('${WD}')`) === null);

  // (d) THE TRAP: a flag left behind by a previous page load (this
  //     module instance never armed — exactly the post-reload state)
  //     must break the cycle: 2D lands, the preference resets, the
  //     scene never mounts.
  run(`localStorage.setItem('${WD}', '1'); shelfSetViewMode('3d'); window.__mountCalls = 0;`);
  run(`renderShelf()`);
  await wait(60);
  ok('trap: a stale watchdog flag keeps the scene unmounted', run(`window.__mountCalls`) === 0);
  ok('trap: the visit lands in the 2D view', !doc.getElementById('shelf3d'));
  ok('trap: the persisted preference resets to 2d', run(`localStorage.getItem('shelfViewMode')`) === '2d');
  ok('trap: the stale flag is consumed', run(`localStorage.getItem('${WD}')`) === null);

  // (e) after the fallback, an explicit re-election of 3D gets its
  //     chance: the toggle path mounts again and re-arms.
  run(`shelfSetViewMode('3d'); renderShelf()`);
  await wait(60);
  ok('trap: explicit re-election mounts 3D again', run(`window.__mountCalls`) === 1);
  ok('trap: explicit re-election re-arms the watchdog', run(`localStorage.getItem('${WD}')`) === '1');
  run(`shelfUnmount3D()`);

  // (f) a mount that rejects (WebGL failure) concludes the attempt:
  //     the existing session-flag fallback runs AND no watchdog flag
  //     is left behind to punish the next visit.
  run(`
    window.Shelf3D = { mount: function () { return Promise.reject(new Error('webgl unavailable')); }, unmount: function () {} };
    _shelf3dWebGLFailed = false;
    renderShelf3D();
  `);
  await wait(80);
  ok('fallback: mount rejection still sets the session WebGL flag', run(`_shelf3dWebGLFailed`) === true);
  ok('fallback: mount rejection leaves no watchdog flag behind', run(`localStorage.getItem('${WD}')`) === null);

  run(`library = []; localStorage.removeItem('shelfViewMode'); localStorage.removeItem('${WD}'); delete window.Shelf3D;`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
