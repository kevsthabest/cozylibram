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

// 3. Settings renders the theme picker as a dropdown (v99: settings was getting crowded)
window.renderSettings();
const themeSel = q('#th-theme');
const themeOpts = qa('#th-theme option');
const swatches = qa('#th-accent .sw');
ok('theme picker is a select dropdown', themeSel && themeSel.tagName === 'SELECT');
ok('ten theme options', themeOpts.length === 10);
ok('theme option values', themeOpts.map(o => o.value).join(',') === 'dark,light,hearthside,candlelight,twilight,verdant,midnight,velvet,abyss,frost');
ok('options show the per-theme social name', themeOpts.every(o => o.textContent.includes('·')));
ok('dark option names the coven', themeOpts.find(o => o.value === 'dark').textContent.includes('Coven'));
ok('twilight option names the night court', themeOpts.find(o => o.value === 'twilight').textContent.includes('Night Court'));
ok('light option is selected', themeOpts.find(o => o.value === 'light').hasAttribute('selected'));
ok('twelve accent swatches', swatches.length === 12);
ok('swatch keys', swatches.map(b => b.dataset.a).join(',') === 'rose,violet,gold,teal,crimson,ember,ocean,sage,blush,copper,mint,lilac');
ok('violet swatch active', swatches.find(b => b.dataset.a === 'violet').classList.contains('active'));
ok('swatch colors set', swatches.every(b => b.style.getPropertyValue('--sw').startsWith('#')));

// 4. Changing the dropdown updates storage + live theme
themeSel.value = 'dark';
themeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
ok('select dark: stored', window.localStorage.getItem('theme') === 'dark');
ok('select dark: applied live', window.document.documentElement.dataset.theme === 'dark');
ok('select dark: nav label follows theme', q('.bottom-nav [data-nav="coven"] span').textContent === 'Coven');
themeSel.value = 'twilight';
themeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
ok('select twilight: nav label becomes Night Court', q('.bottom-nav [data-nav="coven"] span').textContent === 'Night Court');
swatches.find(b => b.dataset.a === 'teal').click();
ok('click teal: stored', window.localStorage.getItem('accent') === 'teal');
ok('click teal: applied live', window.document.documentElement.dataset.accent === 'teal');

// 5. CSS carries all themes, all accents, and no stale --rose vars
const css = fs.readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8');
const allThemes = ['dark', 'light', 'hearthside', 'candlelight', 'twilight', 'verdant', 'midnight', 'velvet', 'abyss', 'frost'];
ok('all theme blocks exist', allThemes.every(t => css.includes('[data-theme="' + t + '"]')));
ok('all accent blocks exist', ['violet', 'gold', 'teal', 'crimson', 'ember', 'ocean', 'sage', 'blush', 'copper', 'mint', 'lilac'].every(a => css.includes('[data-accent="' + a + '"]')));
ok('no var(--rose) references remain', !css.includes('var(--rose'));
ok('swatch styles exist', css.includes('.swatches') && css.includes('.sw.active'));
// v170: every theme carries a floral tint for the decorative vine
ok('every theme defines --floral-tint', allThemes.every(t => {
  const m = css.match(new RegExp('\\[data-theme="' + t + '"\\][^}]*--floral-tint:\\s*(#[0-9a-f]{6})'));
  return !!m;
}));
ok('floral vine rule on modal (desktop)', css.includes('.modal::after') && css.includes('mask-image') && css.includes('min-width: 900px'));

// 6. Nav uses custom SVG icons, not emoji (v37: Settings moved to the account menu)
const navBtns = qa('.bottom-nav button');
ok('seven nav entries (v171: 5 primary + desktop-only settings; v250 adds Shelf)', navBtns.length === 7);
ok('every nav button has an inline svg', navBtns.every(b => b.querySelector('svg')));
ok('no emoji left in nav', !navBtns.some(b => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(b.textContent)));
ok('nav svgs are aria-hidden (labels on buttons)', navBtns.every(b => b.querySelector('svg').getAttribute('aria-hidden') === 'true'));
// v171: desktop sidebar chrome
ok('sidebar brand block present', !!q('.nav-brand .nav-brand-name') && q('.nav-brand .nav-brand-name').textContent === 'Cozy Libram');
ok('settings entry has gear icon + label', !!q('.bottom-nav [data-nav="settings"] svg') && q('.bottom-nav [data-nav="settings"] span').textContent === 'Settings');
ok('settings maps to its own nav tab', window.navTab('settings') === 'settings');
ok('sidebar CSS: 1024px breakpoint', css.includes('@media (min-width: 1024px)'));
ok('sidebar CSS: brand hidden on mobile', css.includes('.nav-brand { display: none; }'));
ok('sidebar CSS: active pill style', css.includes('.bottom-nav button.active { background: var(--card2);'));

// 6. New cozy themes apply, persist, and unknown values fall back
window.localStorage.setItem('theme', 'hearthside');
window.applyTheme();
ok('hearthside applied', window.document.documentElement.dataset.theme === 'hearthside');
ok('meta theme-color hearthside', q('meta[name="theme-color"]').getAttribute('content') === '#17100a');
ok('hearthside names the fireside', q('.bottom-nav [data-nav="coven"] span').textContent === 'Fireside');
themeSel.value = 'twilight';
themeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
ok('select twilight: stored', window.localStorage.getItem('theme') === 'twilight');
ok('select twilight: applied live', window.document.documentElement.dataset.theme === 'twilight');
ok('select twilight: dropdown reflects it', themeSel.value === 'twilight');
window.localStorage.setItem('theme', 'nope');
ok('unknown theme falls back to dark', window.getTheme() === 'dark');
window.applyTheme();
ok('fallback applies dataset dark', window.document.documentElement.dataset.theme === 'dark');

// 7. v170: new themes apply, persist, and name their social circle
window.localStorage.setItem('theme', 'midnight');
window.applyTheme();
ok('midnight applied', window.document.documentElement.dataset.theme === 'midnight');
ok('meta theme-color midnight', q('meta[name="theme-color"]').getAttribute('content') === '#191a30');
ok('midnight names the moon court', q('.bottom-nav [data-nav="coven"] span').textContent === 'Moon Court');
for (const [th, name] of [['velvet', 'Rose Court'], ['abyss', 'The Deep'], ['frost', 'Winter Court']]) {
  window.localStorage.setItem('theme', th);
  window.applyTheme();
  ok(th + ' names ' + name, q('.bottom-nav [data-nav="coven"] span').textContent === name);
}
window.localStorage.setItem('accent', 'blush');
window.applyTheme();
ok('blush accent applied', window.document.documentElement.dataset.accent === 'blush');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
