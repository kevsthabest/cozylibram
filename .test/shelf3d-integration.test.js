// v405: 3D shelf tab integration tests.
// Verifies: view-mode persistence, book mapping (palette + caps), theme
// application, WebGL-failure fallback, and file/index.html/sw.js wiring.
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
ok('caps at 60 books', many === 60);
ok('empty input -> empty', run(`shelfBooks3D([]).length`) === 0);
ok('null input -> empty', run(`shelfBooks3D(null).length`) === 0);

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
  const keys = ['dark','light','hearthside','candlelight','twilight','verdant','midnight','velvet','abyss','frost','haunt','yuletide','fete','amour','shamrock','pastel','harvest'];
  const allOk = keys.every(k => {
    const p = forTheme(k, 'rose');
    return p && p.woodBase && p.mood && typeof p.ambientLevel === 'number';
  });
  ok('all 17 themes resolve', allOk);
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
  const themes = ['dark','light','hearthside','candlelight','twilight','verdant','midnight','velvet','abyss','frost','haunt','yuletide','fete','amour','shamrock','pastel','harvest'];
  const setsOk = themes.every(k => {
    const set = D.setFor(k);
    return Array.isArray(set) && set.length > 0 && set.every(id => ids.includes(id));
  });
  ok('all 17 themes have valid sets', setsOk);
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
  ok('all 17 themes have well-formed presets', presetsOk);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
