// Seasonal app themes (v257): registry, season mapping, nudge logic,
// Settings optgroup, and CSS variable blocks.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in theme tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');

/* ---- 1. registry ---- */
ok('seven seasonal themes registered', run(`THEMES.filter(t => t.season).length`) === 7);
ok('every season has a theme', (() => {
  const seasons = run(`Object.keys(SHELF_SEASONS).filter(s => s !== 'none')`);
  const mapped = run(`THEMES.filter(t => t.season).map(t => t.season)`);
  return seasons.every(s => mapped.indexOf(s) !== -1);
})());
ok('seasonal theme keys unique', (() => {
  const keys = run(`THEMES.map(t => t.key)`);
  return new Set(keys).size === keys.length;
})());
ok('getTheme falls back for unknown', run(`localStorage.setItem('theme','nope'), getTheme()`) === 'dark');
run(`localStorage.removeItem('theme');`);

/* ---- 2. SEASON_THEMES mapping ---- */
ok('every season maps to a real theme+accent', (() => {
  const keys = run(`Object.keys(SEASON_THEMES)`);
  const themes = run(`THEMES.map(t => t.key)`);
  const accents = run(`ACCENTS.map(a => a.key)`);
  return keys.every(s => {
    const m = run(`SEASON_THEMES['${s}']`);
    return themes.indexOf(m.theme) !== -1 && accents.indexOf(m.accent) !== -1;
  });
})());
ok('season theme matches registry season tag', (() =>
  run(`Object.keys(SEASON_THEMES).every(s => { const th = THEMES.find(t => t.key === SEASON_THEMES[s].theme); return th && th.season === s; })`))());

/* ---- 3. nudge logic ---- */
run(`localStorage.removeItem('theme'); localStorage.removeItem('accent');
Object.keys(SEASON_THEMES).forEach(s => localStorage.removeItem('seasonThemeNudge:' + s));
shelfOrderCache = null; localStorage.removeItem('spicyshelves.shelforder.v1');`);
ok('nudge shows for active season', run(`shelfSetSeason('halloween'), seasonThemeNudge()`) === 'halloween');
ok('nudge html names the theme', run(`seasonThemeNudgeHTML()`).indexOf('Haunt') !== -1);
run(`seasonThemeDismiss('halloween');`);
ok('dismissed nudge stays hidden', run(`seasonThemeNudge()`) === null && run(`seasonThemeNudgeHTML()`) === '');
run(`localStorage.setItem('theme','haunt'); localStorage.removeItem('seasonThemeNudge:halloween');`);
ok('no nudge when already on the seasonal theme', run(`seasonThemeNudge()`) === null);
run(`localStorage.removeItem('theme'); shelfSetSeason('none');`);
ok('no nudge without a season', run(`seasonThemeNudge()`) === null);
run(`localStorage.removeItem('spicyshelves.shelforder.v1'); shelfOrderCache = null;`);

/* ---- 4. nudge apply wiring ---- */
run(`shelfSetSeason('christmas'); renderLibrary();`);
ok('nudge renders on library home', !!window.document.querySelector('#seasonNudge'));
run(`wireSeasonNudge(); window.document.querySelector('#snApply').click();`);
ok('apply sets seasonal theme+accent', run(`getTheme()`) === 'yuletide' && run(`getAccent()`) === 'crimson');
ok('apply dismisses future nudges', run(`seasonThemeNudge()`) === null);
run(`localStorage.removeItem('theme'); localStorage.removeItem('accent');
localStorage.removeItem('seasonThemeNudge:christmas');
localStorage.removeItem('spicyshelves.shelforder.v1'); shelfOrderCache = null;`);

/* ---- 5. Settings optgroup ---- */
run(`renderSettings();`);
ok('settings groups seasonal themes', !!window.document.querySelector('#th-theme optgroup[label="Seasonal"]'));
ok('optgroup holds seven themes', window.document.querySelectorAll('#th-theme optgroup option').length === 7);

/* ---- 6. CSS variable blocks ---- */
ok('css has all seven seasonal theme blocks',
  ['haunt', 'yuletide', 'fete', 'amour', 'shamrock', 'pastel', 'harvest']
    .every(k => css.indexOf('[data-theme="' + k + '"]') !== -1));
ok('seasonal blocks define core vars',
  ['haunt', 'pastel'].every(k => {
    const m = css.match(new RegExp('\\[data-theme="' + k + '"\\] \\{([^}]*)\\}'));
    return m && ['--bg', '--ink', '--accent', '--card', '--line', '--nav-bg'].every(v => m[1].indexOf(v + ':') !== -1);
  }));
ok('nudge css present', css.indexOf('.season-nudge') !== -1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
