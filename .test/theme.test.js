// Theming tests: light/dark mode + accent options.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in theme tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));

// 1. Defaults with empty storage
window.localStorage.clear();
window.applyTheme();
ok('default theme is dark', window.getTheme() === 'dark');
ok('default accent is rose', window.getAccent() === 'rose');
ok('dataset.theme=dark applied', window.document.documentElement.dataset.theme === 'dark');
ok('dataset.accent=rose applied', window.document.documentElement.dataset.accent === 'rose');
ok('meta theme-color dark', q('meta[name="theme-color"]').getAttribute('content') === '#14101a');

// 2. Switching persists + applies
window.localStorage.setItem('theme', 'light');
window.localStorage.setItem('accent', 'violet');
window.applyTheme();
ok('light theme applied', window.document.documentElement.dataset.theme === 'light');
ok('violet accent applied', window.document.documentElement.dataset.accent === 'violet');
ok('meta theme-color light', q('meta[name="theme-color"]').getAttribute('content') === '#faf5ec');

// 3. Backup view renders the picker with correct state
window.renderSettings();
const themeBtns = qa('#th-theme button');
const swatches = qa('#th-accent .sw');
ok('six theme buttons', themeBtns.length === 6);
ok('theme keys', themeBtns.map(b => b.dataset.t).join(',') === 'dark,light,hearthside,candlelight,twilight,verdant');
ok('theme dots have colors', themeBtns.every(b => { const d = b.querySelector('.th-dot'); return d && d.style.background.startsWith('rgb'); }));
ok('four accent swatches', swatches.length === 4);
ok('swatch keys', swatches.map(b => b.dataset.a).join(',') === 'rose,violet,gold,teal');
ok('light button active', themeBtns.find(b => b.dataset.t === 'light').classList.contains('active'));
ok('violet swatch active', swatches.find(b => b.dataset.a === 'violet').classList.contains('active'));
ok('swatch colors set', swatches.every(b => b.style.getPropertyValue('--sw').startsWith('#')));

// 4. Clicking updates storage + live theme
themeBtns.find(b => b.dataset.t === 'dark').click();
ok('click dark: stored', window.localStorage.getItem('theme') === 'dark');
ok('click dark: applied live', window.document.documentElement.dataset.theme === 'dark');
ok('click dark: active class moved', themeBtns.find(b => b.dataset.t === 'dark').classList.contains('active'));
swatches.find(b => b.dataset.a === 'teal').click();
ok('click teal: stored', window.localStorage.getItem('accent') === 'teal');
ok('click teal: applied live', window.document.documentElement.dataset.accent === 'teal');

// 5. CSS carries both themes, all accents, and no stale --rose vars
const css = fs.readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8');
ok('all theme blocks exist', ['dark', 'light', 'hearthside', 'candlelight', 'twilight', 'verdant'].every(t => css.includes('[data-theme="' + t + '"]')));
ok('all accent blocks exist', ['violet', 'gold', 'teal'].every(a => css.includes('[data-accent="' + a + '"]')));
ok('no var(--rose) references remain', !css.includes('var(--rose'));
ok('swatch styles exist', css.includes('.swatches') && css.includes('.sw.active'));

// 6. Nav uses custom SVG icons, not emoji (v37: Settings moved to the account menu)
const navBtns = qa('.bottom-nav button');
ok('six nav buttons (authors added v43; settings lives in the account menu)', navBtns.length === 6);
ok('every nav button has an inline svg', navBtns.every(b => b.querySelector('svg')));
ok('no emoji left in nav', !navBtns.some(b => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(b.textContent)));
ok('nav svgs are aria-hidden (labels on buttons)', navBtns.every(b => b.querySelector('svg').getAttribute('aria-hidden') === 'true'));

// 6. New cozy themes apply, persist, and unknown values fall back
window.localStorage.setItem('theme', 'hearthside');
window.applyTheme();
ok('hearthside applied', window.document.documentElement.dataset.theme === 'hearthside');
ok('meta theme-color hearthside', q('meta[name="theme-color"]').getAttribute('content') === '#17100a');
themeBtns.find(b => b.dataset.t === 'twilight').click();
ok('click twilight: stored', window.localStorage.getItem('theme') === 'twilight');
ok('click twilight: applied live', window.document.documentElement.dataset.theme === 'twilight');
ok('click twilight: active class moved', themeBtns.find(b => b.dataset.t === 'twilight').classList.contains('active'));
window.localStorage.setItem('theme', 'nope');
ok('unknown theme falls back to dark', window.getTheme() === 'dark');
window.applyTheme();
ok('fallback applies dataset dark', window.document.documentElement.dataset.theme === 'dark');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
