// v405: 3D shelf tab integration tests.
// Verifies: view-mode persistence, book mapping (palette + caps), theme
// application, decoration catalog/presets, camera fit/pan helpers, and
// file/index.html/sw.js wiring.
// Section 12 (QA Scout item 3) adds the orchestration coverage an earlier
// version of this header claimed but never performed: shelf3DCapable
// (URL / stored-preference / WebGL branches), renderShelf3D's structural
// DOM and mount contract against a stubbed scene layer, shelf3dGoCase
// clamping, and the WebGL-failure fallback (mount rejection AND
// Shelf3D-absent both land in the 2D render). Still unexecuted: the real
// THREE scene itself — mount internals, showCase rendering, cover
// painting against live canvases. jsdom has no WebGL; the engine stays
// device-verified, and section 12 stops at the stub seam on purpose.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);

/* ---- 1. view-mode persistence ---- */
run(`localStorage.removeItem('shelfViewMode')`);
ok('view mode defaults to 3d', run(`shelfViewMode()`) === '3d');
run(`shelfSetViewMode('2d')`);
ok('view mode persists 2d', run(`shelfViewMode()`) === '2d');
run(`shelfSetViewMode('3d')`);
ok('view mode persists 3d', run(`shelfViewMode()`) === '3d');
run(`shelfSetViewMode('bogus')`);
ok('invalid mode normalizes to 3d', run(`shelfViewMode()`) === '3d');
run(`localStorage.removeItem('shelfViewMode')`);

/* ---- 2. book mapping ---- */
const mapped = run(`JSON.stringify(shelfBooks3D([
  { id: 'b1', title: 'Dune' },
  { id: 'b2', title: 'Fourth Wing' },
  { id: 'b3' },
]))`);
{
  const m = JSON.parse(mapped);
  ok('maps all books', m.length === 3);
  ok('keeps ids', m[0].id === 'b1' && m[1].id === 'b2');
  ok('keeps titles', m[0].title === 'Dune');
  ok('untitled fallback', m[2].title === 'Untitled');
  ok('spine colors are hex', /^#[0-9a-f]{6}$/i.test(m[0].spineC1) && /^#[0-9a-f]{6}$/i.test(m[0].spineC2));
  ok('spineW in 3D range', m.every(b => b.spineW >= 0.3 && b.spineW <= 0.7));
  ok('spineH in 3D range', m.every(b => b.spineH >= 1.5 && b.spineH <= 2.6));
  const again = JSON.parse(run(`JSON.stringify(shelfBooks3D([{ id: 'b1', title: 'Dune' }]))`));
  ok('palette is deterministic', again[0].spineC1 === m[0].spineC1);
}
const many = run(`shelfBooks3D(Array.from({length: 200}, (_, i) => ({ id: 'x' + i, title: 'T' + i }))).length`);
ok('mapping no longer caps (the room pages instead)', many === 200);
/* ---- 2b. the room: cases, arrange ---- */
ok('200 books -> 4 cases of 60/60/60/20', run(`shelf3dCases(Array.from({length:200},(_, i)=>i), 60).map(c=>c.length).join()`) === '60,60,60,20');
ok('no books -> one empty case', run(`shelf3dCases([], 60).length`) === 1);
ok('case key', run(`shelf3dCaseKey('read', 2)`) === 'read:2');
ok('arrange by title ignores leading The', run(`shelf3dArrange([{title:'The Zed'},{title:'Apple'},{title:'A Banana'}],'title').map(b=>b.title).join('|')`) === 'Apple|A Banana|The Zed');
ok('arrange by series groups series first, in order', run(`shelf3dArrange([{title:'Solo'},{title:'B2',series:{name:'B',position:2}},{title:'B1',series:{name:'B',position:1}}],'series').map(b=>b.title).join()`) === 'B1,B2,Solo');
ok('arrange does not mutate input', run(`(function(){var a=[{title:'b'},{title:'a'}];shelf3dArrange(a,'title');return a[0].title;})()`) === 'b');
ok('arrange mine keeps order', run(`shelf3dArrange([{title:'b'},{title:'a'}],'mine').map(b=>b.title).join()`) === 'b,a');
ok('empty input -> empty', run(`shelfBooks3D([]).length`) === 0);
ok('null input -> empty', run(`shelfBooks3D(null).length`) === 0);

/* ---- 2c. spine colours from covers (v476) ---- */
ok('light cover colours are toned down for legibility', run(`shelf3dSpineTone('#f1c40f')`) !== '#f1c40f' && run(`shelf3dSpineTone('#203040')`) === '#203040');
ok('accent is lighter than spine', parseInt(run(`shelf3dSpineAccent('#2e86c1')`).slice(1,3),16) > 0x2e);
ok('hue: green ~145, grey -1', Math.round(run(`shelf3dHue('#27ae60')`)) === 145 && run(`shelf3dHue('#888888')`) === -1);
run(`localStorage.removeItem('cozylibram.s3d.spines')`);
ok('spines default to cover colours', run(`shelf3dSpinesMode()`) === 'cover');
run(`spineColorCache['k1'] = { hex: '#2e86c1', cover: 'u1' }`);
ok('cached cover colour is used', run(`shelfBooks3D([{id:'k1',title:'x',cover:'u1'}])[0].spineC1`) === run(`shelf3dSpineTone('#2e86c1')`));
ok('stale cache (cover changed) falls back to palette', run(`shelfBooks3D([{id:'k1',title:'x',cover:'u2'}])[0].spineC1`) !== run(`shelf3dSpineTone('#2e86c1')`));
run(`shelf3dSetSpinesMode('classic')`);
ok('classic mode ignores covers', run(`shelfBooks3D([{id:'k1',title:'x',cover:'u1'}])[0].spineC1`) !== run(`shelf3dSpineTone('#2e86c1')`));
run(`localStorage.removeItem('cozylibram.s3d.spines'); delete spineColorCache['k1']`);

/* ---- 3. theme application (mocked Shelf3D) ---- */
run(`
  window.__themeApplied = null;
  window.Shelf3D = {
    setTheme: function (p) { window.__themeApplied = p; },
    setThemeParams: function (p) { window.__themeApplied = p; },
    unmount: function () {}
  };
  _shelf3dMounted = true;
`);
run(`shelf3DApplyTheme()`);
{
  const applied = run(`JSON.stringify(window.__themeApplied)`);
  const p = JSON.parse(applied);
  ok('theme applied to Shelf3D', p && typeof p.woodBase === 'string');
  ok('theme has mood', typeof p.mood === 'string');
  ok('theme has accent glow', /^#[0-9a-f]{6}$/i.test(p.accentGlow));
}
run(`_shelf3dMounted = false; window.__themeApplied = null;`);
ok('no-op when unmounted', run(`shelf3DApplyTheme(), window.__themeApplied === null`));

/* ---- 4. unmount safety ---- */
ok('unmount safe when never mounted', run(`shelfUnmount3D(), true`));
run(`_shelf3dMounted = true`);
run(`shelfUnmount3D()`);
ok('unmount clears local flag', run(`_shelf3dMounted === false`));
run(`delete window.Shelf3D`);
ok('unmount safe when Shelf3D undefined', run(`shelfUnmount3D(), true`));

/* ---- 5. file wiring ---- */
const swJs = fs.readFileSync(ROOT + '/sw.js', 'utf8');
ok('sw.js precaches 215-shelf3d.js', swJs.includes('215-shelf3d.js'));
ok('sw.js precaches 216-shelf3d-theme.js', swJs.includes('216-shelf3d-theme.js'));
ok('sw.js precaches 217-shelf3d-view.js', swJs.includes('217-shelf3d-view.js'));
ok('index.html loads 215-shelf3d.js', html.includes('js/215-shelf3d.js'));
ok('index.html loads 216-shelf3d-theme.js', html.includes('js/216-shelf3d-theme.js'));
ok('index.html loads 217-shelf3d-view.js', html.includes('js/217-shelf3d-view.js'));
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
ok('styles.css has namespaced 3D styles', css.includes('#shelf3d #s3dScene'));

/* ---- 6. theme module standalone ---- */
const themeSrc = fs.readFileSync(ROOT + '/js/216-shelf3d-theme.js', 'utf8');
{
  const vm = require('vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(themeSrc, sandbox);
  const forTheme = sandbox.window.Shelf3DTheme.forTheme;
  const keys = ['dark','light','hearthside','candlelight','twilight','verdant','midnight','velvet','abyss','frost','haunt','yuletide','fete','amour','shamrock','pastel','harvest','solstice'];
  const allOk = keys.every(k => {
    const p = forTheme(k, 'rose');
    return p && p.woodBase && p.mood && typeof p.ambientLevel === 'number';
  });
  ok('all 18 themes resolve', allOk);
  const fb = forTheme('nope', 'nope');
  ok('unknown theme falls back', fb && fb.mood === 'cozy');
}


/* ---- 7. decoration catalog (218-shelf3d-decor.js, v406) ---- */
const decorSrc = fs.readFileSync(ROOT + '/js/218-shelf3d-decor.js', 'utf8');
{
  const vm = require('vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(decorSrc, sandbox);
  const D = sandbox.window.Shelf3DDecor;
  ok('catalog module loads', !!D && Array.isArray(D.CATALOG));

  // entry shape
  const ids = D.CATALOG.map(e => e.id);
  ok('all ids unique', new Set(ids).size === ids.length);
  const shapeOk = D.CATALOG.every(e =>
    typeof e.id === 'string' && typeof e.name === 'string' &&
    typeof e.build === 'string' && typeof e.svg === 'string' &&
    typeof e.stock === 'number' && typeof e.premium === 'boolean');
  ok('every entry has id/name/build/svg/stock/premium', shapeOk);
  ok('no locked entries (lantern+globe unlocked)', D.CATALOG.every(e => !e.locked));
  const prem = id => D.CATALOG.find(e => e.id === id).premium;
  ok('lantern flagged premium', prem('lantern') === true);
  ok('globe flagged premium', prem('globe') === true);
  ok('moon flagged premium', prem('moon') === true);
  ok('stargarland flagged premium', prem('stargarland') === true);
  ok('snowflake flagged premium', prem('snowflake') === true);
  ok('basics not premium', prem('plant') === false && prem('candle') === false && prem('mug') === false);
  const roomIds = D.CATALOG.filter(e => e.room).map(e => e.id).sort();
  ok('room tab has web/pumpkin/moon/snowflake',
    JSON.stringify(roomIds) === JSON.stringify(['moon', 'pumpkin', 'snowflake', 'web']));
  const vase = D.CATALOG.find(e => e.id === 'vase');
  ok('vase has 6 theme variants',
    vase.variants && ['amour','velvet','pastel','harvest','frost','yuletide'].every(k => vase.variants[k]));

  // sets: all 17 themes, every id resolves
  const themes = ['dark','light','hearthside','candlelight','twilight','verdant','midnight','velvet','abyss','frost','haunt','yuletide','fete','amour','shamrock','pastel','harvest','solstice'];
  const setsOk = themes.every(k => {
    const set = D.setFor(k);
    return Array.isArray(set) && set.length > 0 && set.every(id => ids.includes(id));
  });
  ok('all 18 themes have valid sets', setsOk);
  ok('unknown theme set falls back', D.setFor('nope').length > 0);

  // presets: all 17 themes, placements well-formed
  const presetsOk = themes.every(k => {
    const pre = D.presetFor(k);
    return Array.isArray(pre) && pre.length > 0 && pre.every(p => {
      if (!ids.includes(p.deco)) return false;
      if (p.room) return typeof p.x === 'number';
      return Number.isInteger(p.pi) && p.pi >= 0 && p.pi <= 2 && typeof p.x === 'number';
    });
  });
  ok('all 18 themes have well-formed presets', presetsOk);
  ok('harvest preset carries the north-star set',
    D.presetFor('harvest').some(p => p.deco === 'lights' && p.pi === 2) &&
    D.presetFor('harvest').some(p => p.deco === 'pumpkin' && p.room));
  const p1 = D.presetFor('dark'), p2 = D.presetFor('dark');
  p1[0].x = 999;
  ok('presetFor returns copies', p2[0].x !== 999);
}

/* ---- 8. 218 file wiring ---- */
ok('sw.js precaches 218-shelf3d-decor.js', swJs.includes('218-shelf3d-decor.js'));
ok('index.html loads 218-shelf3d-decor.js', html.includes('js/218-shelf3d-decor.js'));
ok('218 loads before 215 in index.html',
  html.indexOf('js/218-shelf3d-decor.js') < html.indexOf('js/215-shelf3d.js'));

/* ---- 9. reduced-motion: highlightBook skips the lift tween ---- */
{
  const src215 = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
  const hl = src215.slice(src215.indexOf('function highlightBook(id)'));
  const hlBody = hl.slice(0, hl.indexOf('\n    }\n') + 5);
  ok('highlightBook honors prefers-reduced-motion',
    hlBody.includes('prefers-reduced-motion') && hlBody.includes('markDirty'));
  ok('highlightBook returns true without the tween when reduced',
    /if\s*\(\s*reduce\s*\)\s*\{\s*markDirty\(\);\s*return true;/.test(hlBody));
}

/* ---- 10. v475 room shells: every theme dresses the room ---- */
{
  ok('shell table covers all 23 app themes',
    run(`THEMES.every(t => !!SHELF3D_SHELLS[t.key])`) && run(`Object.keys(SHELF3D_SHELLS).length`) === 23);
  const tw = JSON.parse(run(`JSON.stringify(shelf3dShellFor('twilight', SHELF3D_THEMES.dark))`));
  ok('twilight shell is starry', tw.pattern === 'starry' && tw.light === false);
  const fb = JSON.parse(run(`JSON.stringify(shelf3dShellFor('nope', { mood: 'bright', floorTint: '#aaaaaa', woodDark: '#bbbbbb' }))`));
  ok('unknown theme falls back to its own floor/wood colours',
    fb.wall === '#aaaaaa' && fb.pattern === 'plain' && fb.floor === '#bbbbbb' && fb.light === true);
  ok('theme palette carries its shell',
    run(`Shelf3DTheme.forTheme('frost').shell.floorKind`) === 'tile' &&
    run(`Shelf3DTheme.forTheme('frost').shell.light`) === true);
  const src215 = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
  ok('215 applies the shell from the palette', src215.includes('if (p.shell) applyShell(p.shell);'));
  ok('neighbour cases share the shell back panel', src215.includes('backMat);'));
}

/* ---- 11. camera fit + pan-while-zoomed (fit framing / pan clamps) ---- */
{
  const APP_DIR = require('./harness').APP_DIR;
  const srcFix = fs.readFileSync(APP_DIR + '/js/215-shelf3d.js', 'utf8');
  // section 4 deleted window.Shelf3D, so lift the pure helpers from source
  const f0 = srcFix.indexOf('function shelf3dFitDistance');
  const f1 = srcFix.indexOf('function shelf3dClampPan');
  const f2 = srcFix.indexOf('\n  }', f1) + 4;
  run(srcFix.slice(f0, f2) + '\n;window.__fit = shelf3dFitDistance; window.__clampPan = shelf3dClampPan;');
  const fit = window.__fit, clampPan = window.__clampPan;
  ok('fit + clamp helpers exposed on Shelf3D',
    srcFix.includes('fitDistance: shelf3dFitDistance') && srcFix.includes('clampPan: shelf3dClampPan'));
  ok('fit + clamp helpers defined', typeof fit === 'function' && typeof clampPan === 'function');
  const TAN21 = Math.tan(21 * Math.PI / 180);
  const FIT_W = (10 + 0.3 * 2) * 1.08, FIT_H = 2 * Math.max(8.04 - 3.6, 3.6) * 1.08;
  // portrait phone: distance must grow until the whole case width fits
  const dPortrait = fit(0.46, 42, FIT_W, FIT_H);
  ok('portrait aspect pulls back past 30', dPortrait > 30 && dPortrait < 35);
  ok('portrait fit actually frames the case width',
    2 * dPortrait * TAN21 * 0.46 >= FIT_W - 1e-9);
  // landscape: the height binds and stays under the historic 13.4 framing,
  // so layout's max(13.4, fit) leaves desktop framing exactly as before
  const dLand = fit(1.78, 42, FIT_W, FIT_H);
  ok('landscape fit is height-bound (≈12.5)', dLand > 12 && dLand < 13);
  ok('landscape fit does not exceed the historic 13.4', dLand <= 13.4);
  // square: width-bound and beyond 13.4 (the old framing cropped the case)
  const dSquare = fit(1.0, 42, FIT_W, FIT_H);
  ok('square aspect is width-bound past 13.4', dSquare > 13.4 && dSquare < 16);
  // degenerate aspect never divides by zero
  ok('zero aspect stays finite', isFinite(fit(0, 42, FIT_W, FIT_H)));
  // pan clamps: x within ±case half-width, target y within [1.2, TOP_Y-1.2]
  const cp = (x, y) => clampPan(x, y, 5.3, 3.6, 8.04);
  ok('pan centre unchanged', JSON.stringify(cp(0, 0)) === '[0,0]');
  ok('pan inside bounds unchanged', JSON.stringify(cp(2, 1)) === '[2,1]');
  ok('pan x clamps to ±half width', cp(99, 0)[0] === 5.3 && cp(-99, 0)[0] === -5.3);
  ok('pan y clamps target to TOP_Y-1.2', Math.abs(cp(0, 99)[1] - 3.24) < 1e-9);
  ok('pan y clamps target to 1.2', Math.abs(cp(0, -99)[1] - -2.4) < 1e-9);
  // wiring: layout frames via the fit, the frame loop applies the pan
  ok('layout fits via shelf3dFitDistance', srcFix.includes('shelf3dFitDistance(a, 42, fitW, fitH)'));
  ok('layout keeps the 13.4 floor', srcFix.includes('Math.max(13.4, shelf3dFitDistance'));
  ok('frame loop pans camera and target together',
    srcFix.includes('camBase.x + panX +') && srcFix.includes('camTarget.x + panX'));
  ok('pan only starts zoomed-in on empty space',
    srcFix.includes('zoomFactor < 0.99') && srcFix.includes('!bookAt(e)'));
}

/* ---- 12. orchestration: capability gate, render, case walking, fallback ----
   QA Scout item 3: the functions below had ZERO executions while this
   suite's header claimed fallback coverage. The scene layer (Shelf3D)
   is stubbed — the same pattern section 3 uses for theme application —
   and every assertion is on js/217's own behaviour: the gate's boolean,
   the DOM renderShelf3D builds, the mount contract, the case walk. */
const tick12 = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });
const section12 = (async () => {
  const doc = window.document;

  /* (a) shelf3DCapable: URL override > stored preference > WebGL probe */
  run(`localStorage.removeItem('shelfViewMode')`);
  ok('capable: stock jsdom has no WebGL context -> gate closed', run(`shelf3DCapable()`) === false);
  run(`
    window.__origCreate = document.createElement.bind(document);
    document.createElement = function (tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        return { getContext: function (kind) { return kind ? { __gl: kind } : null; } };
      }
      return window.__origCreate(tag);
    };
  `);
  ok('capable: WebGL present but a 2-core device -> gate closed (hardware-concurrency check)',
    run(`shelf3DCapable()`) === false);
  run(`Object.defineProperty(window.navigator, 'hardwareConcurrency', { value: 8, configurable: true })`);
  ok('capable: WebGL present + sufficient cores, no contrary preference -> gate open', run(`shelf3DCapable()`) === true);
  run(`localStorage.setItem('shelfViewMode', '2d')`);
  ok('capable: stored 2d preference closes the gate even with WebGL', run(`shelf3DCapable()`) === false);
  run(`localStorage.setItem('shelfViewMode', '3d')`);
  ok('capable: stored 3d opt-in opens the gate', run(`shelf3DCapable()`) === true);
  dom.reconfigure({ url: 'http://localhost:8000/?shelf=2d' });
  ok('capable: ?shelf=2d overrides a stored 3d', run(`shelf3DCapable()`) === false);
  dom.reconfigure({ url: 'http://localhost:8000/?shelf=3d' });
  run(`localStorage.setItem('shelfViewMode', '2d')`);
  ok('capable: ?shelf=3d overrides a stored 2d', run(`shelf3DCapable()`) === true);
  dom.reconfigure({ url: 'http://localhost:8000/' });
  run(`document.createElement = window.__origCreate; delete window.__origCreate;`);
  run(`delete window.navigator.hardwareConcurrency;`);
  run(`localStorage.setItem('shelfViewMode', '3d')`);
  ok('capable: stored 3d opt-in is respected even without WebGL', run(`shelf3DCapable()`) === true);
  run(`localStorage.removeItem('shelfViewMode')`);

  /* (b) renderShelf3D: structural DOM + mount contract, stubbed scene */
  run(`
    window.__mounts = [];
    window.__shows = [];
    window.Shelf3D = {
      mount: function (container, opts) { window.__mounts.push({ id: container && container.id, opts: opts }); return Promise.resolve(); },
      showCase: function () { window.__shows.push(Array.prototype.slice.call(arguments)); },
      highlightBook: function () {},
      setNeighbours: function () {},
      unmount: function () {}
    };
    library = Array.from({ length: 130 }, function (_, i) { return { id: 'bk' + i, title: 'Book ' + i, status: 'read' }; });
    shelfGroup = 'read';
  `);
  run(`renderShelf3D()`);
  ok('render: one chip per shelf group', doc.querySelectorAll('.shelfview .sv-chip').length === run(`SHELF_GROUPS.length`));
  const readChip = [...doc.querySelectorAll('.sv-chip')].find(c => c.dataset.g === 'read');
  ok('render: read chip carries the live count (130) and is active',
    !!readChip && readChip.querySelector('.n').textContent === '130' && readChip.classList.contains('active'));
  ok('render: case bar + mount container present', !!doc.getElementById('s3dCaseBar') && !!doc.getElementById('shelf3d'));
  ok('render: loading placeholder up until mount resolves', !!doc.querySelector('#shelf3d .s3d-loading'));
  await tick12(5);
  const mounts = JSON.parse(run(`JSON.stringify(window.__mounts.map(function (m) {
    return { id: m.id, caseKey: m.opts.caseKey, books: m.opts.initialBooks.length,
      prevIsNull: m.opts.initialNeighbours.prev === null,
      nextN: m.opts.initialNeighbours.next ? m.opts.initialNeighbours.next.length : -1 };
  }))`));
  const caseBooks0 = run(`shelf3dCaseBooks(shelf3dRoom(), 0).length`);
  const case1Len = run(`shelf3dRoom().cases[1].length`);
  const nCases = run(`shelf3dRoom().cases.length`);
  ok('render: mount called once, on #shelf3d', mounts.length === 1 && mounts[0].id === 'shelf3d');
  ok('render: mount opens at case read:0 with case+reservoir books and a next neighbour only',
    mounts.length === 1 && mounts[0].caseKey === 'read:0' && mounts[0].books === caseBooks0 &&
    mounts[0].prevIsNull === true && mounts[0].nextN === case1Len);
  ok('render: mounted flag set once mount resolves', run(`_shelf3dMounted`) === true);
  ok('render: loading placeholder removed after mount', !doc.querySelector('#shelf3d .s3d-loading'));
  ok('render: 130 books span at least 3 cases', nCases >= 3);
  ok('render: case bar reads Case 1 of N with matching dots',
    doc.getElementById('cbLabel').textContent === 'Case 1 of ' + nCases &&
    doc.querySelectorAll('.cb-dot').length === nCases && doc.querySelector('.cb-dot').classList.contains('on'));
  ok('render: prev disabled on the first case, next enabled',
    doc.getElementById('cbPrev').disabled === true && doc.getElementById('cbNext').disabled === false);

  /* (c) shelf3dGoCase: clamping at both ends, far jumps slide.
     The implemented semantic is CLAMP, not wrap — the bar buttons
     disable at the ends instead (asserted in (b) and below). */
  const last = nCases - 1;
  const showKeys = () => JSON.parse(run(`JSON.stringify(window.__shows.map(a => [a[0], a[2]]))`));
  run(`window.__shows.length = 0`);
  run(`shelf3dGoCase(999, 1)`);
  ok('goCase: overshoot clamps to the last case', run(`_shelf3dCaseIdx['read']`) === last);
  ok('goCase: engine is shown the clamped case', JSON.stringify(showKeys()) === JSON.stringify([['read:' + last, 2]]));
  ok('goCase: bar follows to the last case (next disabled)',
    doc.getElementById('cbLabel').textContent === 'Case ' + nCases + ' of ' + nCases &&
    doc.getElementById('cbNext').disabled === true && doc.getElementById('cbPrev').disabled === false);
  run(`window.__shows.length = 0`);
  run(`shelf3dGoCase(-4, -1)`);
  ok('goCase: undershoot clamps to the first case', run(`_shelf3dCaseIdx['read']`) === 0);
  ok('goCase: engine is shown case read:0', JSON.stringify(showKeys()) === JSON.stringify([['read:0', -2]]));
  run(`window.__shows.length = 0`);
  run(`shelf3dGoCase(` + last + `, 1)`);
  ok('goCase: a far jump slides (dir becomes 2) instead of gliding',
    JSON.stringify(showKeys()) === JSON.stringify([['read:' + last, 2]]));
  run(`shelf3dGoCase(0, 0)`);

  /* (d) WebGL-failure fallback — the claim the old header made.
     Both failure shapes must land in the 2D render with ONLY the
     session flag set (v408: the stored preference is never flipped). */
  run(`
    window.Shelf3D = { mount: function () { return Promise.reject(new Error('webgl unavailable')); }, unmount: function () {} };
    renderShelf3D();
  `);
  await tick12(6);
  ok('fallback: mount rejection sets the session WebGL-failed flag', run(`_shelf3dWebGLFailed`) === true);
  ok('fallback: mount rejection leaves the 3D view (2D render took over)', !doc.getElementById('shelf3d'));
  ok('fallback: stored view preference untouched by the failure', run(`localStorage.getItem('shelfViewMode')`) === null);
  run(`_shelf3dWebGLFailed = false; delete window.Shelf3D;`);
  run(`renderShelf3D()`);
  ok('fallback: Shelf3D absent -> same session-flag fallback, synchronously',
    run(`_shelf3dWebGLFailed`) === true && !doc.getElementById('shelf3d'));
  run(`library = []; shelfGroup = 'tbr';`);
})();

section12.then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
