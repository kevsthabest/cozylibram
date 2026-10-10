// Theming tests: light/dark mode + accent options + v416 visual theme gallery.
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
const css = fs.readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8');

// 1. Defaults with empty storage (v416: no forced rose — theme default wins)
window.localStorage.clear();
window.applyTheme();
ok('default theme is dark', window.getTheme() === 'dark');
ok('no stored accent returns null', window.getAccent() === null);
ok('dataset.theme=dark applied', window.document.documentElement.dataset.theme === 'dark');
ok('no data-accent attr when unset (theme CSS default wins)', !window.document.documentElement.hasAttribute('data-accent'));
ok('meta theme-color dark', q('meta[name="theme-color"]').getAttribute('content') === '#14101a');

// 2. Effective accent resolution (v416)
ok('dark effective accent is violet (T4)', window.effectiveAccent() === 'violet');
ok('themeDefaultAccent dark is violet', window.themeDefaultAccent('dark') === 'violet');
ok('themeDefaultAccent twilight is violet', window.themeDefaultAccent('twilight') === 'violet');
ok('themeDefaultAccent verdant is sage', window.themeDefaultAccent('verdant') === 'sage');
ok('themeDefaultAccent abyss is teal', window.themeDefaultAccent('abyss') === 'teal');
ok('themeDefaultAccent amour is blush (T1)', window.themeDefaultAccent('amour') === 'blush');
ok('themeDefaultAccent hearthside is ember (T2)', window.themeDefaultAccent('hearthside') === 'ember');
ok('themeDefaultAccent candlelight is gold (T3)', window.themeDefaultAccent('candlelight') === 'gold');
ok('themeDefaultAccent solstice is gold (T6)', window.themeDefaultAccent('solstice') === 'gold');
window.localStorage.setItem('accent', 'teal');
ok('stored accent wins over theme default', window.effectiveAccent() === 'teal');
window.applyTheme();
ok('stored accent sets data-accent', window.document.documentElement.dataset.accent === 'teal');
window.localStorage.removeItem('accent');

// 3. Accent pairings (v416 P2)
ok('velvet pairings', window.themeAccentPairings('velvet').join(',') === 'rose,blush,gold');
ok('dark pairings', window.themeAccentPairings('dark').join(',') === 'violet,rose,gold');
ok('unknown theme falls back to its default', window.themeAccentPairings('nope').join(',') === 'rose');

// 4. Gallery replaces the dropdown (v416 P1)
window.localStorage.setItem('theme', 'light');
window.renderSettings();
const cards = qa('.tcard');
ok('gallery has 18 theme cards (10 core + 8 seasonal)', cards.length === 18);
ok('core cards first', cards.slice(0, 10).map(c => c.dataset.th).join(',') === 'dark,light,hearthside,candlelight,twilight,verdant,midnight,velvet,abyss,frost');
ok('seasonal cards follow', cards.slice(10).map(c => c.dataset.th).join(',') === 'haunt,yuletide,fete,amour,shamrock,pastel,harvest,solstice');
ok('no blind dropdown remains', !q('#th-theme'));
const darkCard = cards.find(c => c.dataset.th === 'dark');
ok('cards show the per-theme social name', cards.every(c => c.querySelector('.tmeta span').textContent.length > 0));
ok('dark card names the coven', darkCard.querySelector('.tmeta span').textContent.includes('Coven'));
ok('twilight card names the night court', cards.find(c => c.dataset.th === 'twilight').querySelector('.tmeta span').textContent.includes('Night Court'));
ok('haunt card names the haunt coven (T8)', cards.find(c => c.dataset.th === 'haunt').querySelector('.tmeta span').textContent.includes('Haunt Coven'));
ok('solstice card names the sun court (T6)', cards.find(c => c.dataset.th === 'solstice').querySelector('.tmeta span').textContent.includes('Sun Court'));
ok('active theme card is marked', cards.find(c => c.dataset.th === 'light').classList.contains('sel'));
ok('active card shows checkmark', !!cards.find(c => c.dataset.th === 'light').querySelector('.check'));
ok('mini previews carry inline theme colors', cards.every(c => {
  const mini = c.querySelector('.mini');
  return mini && /background:\s*#[0-9a-f]{6}/i.test(mini.getAttribute('style') || '');
}));
ok('twelve accent swatches in settings', qa('#th-accent .sw').length === 12);
ok('swatch active follows effective accent (rose on light)', qa('#th-accent .sw').find(b => b.dataset.a === 'rose').classList.contains('active'));

// 5. Card tap -> live preview + detail sheet; Use confirms, scrim reverts (v416 P2/P3)
const velvetCard = cards.find(c => c.dataset.th === 'velvet');
velvetCard.click();
ok('sheet opens on card tap', !!q('#tsSheetWrap'));
ok('tap live-previews the theme app-wide', window.document.documentElement.dataset.theme === 'velvet');
ok('preview uses theme default accent (no data-accent)', !window.document.documentElement.hasAttribute('data-accent'));
ok('sheet shows coven identity', q('.tsheet .cov').textContent.includes('Rose Court'));
ok('sheet accent label names theme default', q('#tsAccentName').textContent.includes('Rose') && q('#tsAccentName').textContent.includes('theme default'));
ok('pairing buttons rendered', qa('#tsPairs .pair').length === 3);
ok('theme default pairing marked suggested', qa('#tsPairs .pair.sug').length >= 1);
ok('sheet has full swatch row', qa('#tsSwatches .sw').length === 12);
ok('sheet CSS present', css.includes('.tsheet') && css.includes('.tgrid') && css.includes('.tcard'));
// pick a pairing
qa('#tsPairs .pair').find(b => b.dataset.a === 'blush').click();
ok('pairing click previews accent', window.document.documentElement.dataset.accent === 'blush');
ok('accent label updates', q('#tsAccentName').textContent.includes('Blush') && !q('#tsAccentName').textContent.includes('theme default'));
// reset to default
q('#tsResetAccent').click();
ok('reset clears preview accent', !window.document.documentElement.hasAttribute('data-accent'));
// confirm
q('#tsUse').click();
ok('use persists theme', window.localStorage.getItem('theme') === 'velvet');
ok('use with default accent removes stored accent', window.localStorage.getItem('accent') === null);
ok('sheet closes on use', !q('#tsSheetWrap'));
ok('gallery reflects new active theme', qa('.tcard').find(c => c.dataset.th === 'velvet').classList.contains('sel'));
// revert path: preview then scrim-click
qa('.tcard').find(c => c.dataset.th === 'abyss').click();
ok('abyss previewed', window.document.documentElement.dataset.theme === 'abyss');
q('#tsScrim').click();
ok('scrim click reverts theme', window.document.documentElement.dataset.theme === 'velvet');
ok('revert keeps stored theme', window.localStorage.getItem('theme') === 'velvet');
ok('sheet closes on revert', !q('#tsSheetWrap'));

// 6. CSS carries all themes incl. solstice + v416 palette fixes
const allThemes = ['dark', 'light', 'hearthside', 'candlelight', 'twilight', 'verdant', 'midnight', 'velvet', 'abyss', 'frost', 'solstice'];
ok('all theme blocks exist', allThemes.every(t => css.includes('[data-theme="' + t + '"]')));
ok('solstice block exists (T6)', css.includes('[data-theme="solstice"]'));
ok('dark accent is violet (T4)', /\[data-theme="dark"\][^}]*--accent:\s*#8b5cf6/.test(css));
ok('hearthside accent is ember (T2)', /\[data-theme="hearthside"\][^}]*--accent:\s*#e0722a/.test(css));
ok('hearthside floral tint burns orange (T2)', /\[data-theme="hearthside"\][^}]*--floral-tint:\s*#e0722a/.test(css));
ok('candlelight accent is gold (T3)', /\[data-theme="candlelight"\][^}]*--accent:\s*#c08a24/.test(css));
ok('amour bg lifted pinker (T1)', /\[data-theme="amour"\][^}]*--bg:\s*#2a1420/.test(css));
ok('amour accent is blush (T1)', /\[data-theme="amour"\][^}]*--accent:\s*#f2a3c0/.test(css));
ok('all accent blocks exist', ['violet', 'gold', 'teal', 'crimson', 'ember', 'ocean', 'sage', 'blush', 'copper', 'mint', 'lilac'].every(a => css.includes('[data-accent="' + a + '"]')));
ok('no var(--rose) references remain', !css.includes('var(--rose'));
ok('every theme defines --floral-tint', allThemes.every(t => {
  const m = css.match(new RegExp('\\[data-theme="' + t + '"\\][^}]*--floral-tint:\\s*(#[0-9a-f]{6})'));
  return !!m;
}));

// 7. Nav uses custom SVG icons, not emoji (v37: Settings moved to the account menu)
const navBtns = qa('.bottom-nav button');
ok('seven nav entries (v171: 5 primary + desktop-only settings; v250 adds Shelf)', navBtns.length === 7);
ok('every nav button has an inline svg', navBtns.every(b => b.querySelector('svg')));
ok('no emoji left in nav', !navBtns.some(b => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(b.textContent)));
ok('nav svgs are aria-hidden (labels on buttons)', navBtns.every(b => b.querySelector('svg').getAttribute('aria-hidden') === 'true'));

// 8. Themes apply, persist, and unknown values fall back
window.localStorage.setItem('theme', 'hearthside');
window.applyTheme();
ok('hearthside applied', window.document.documentElement.dataset.theme === 'hearthside');
ok('meta theme-color hearthside', q('meta[name="theme-color"]').getAttribute('content') === '#1e0e0a');
ok('hearthside names the fireside', q('.bottom-nav [data-nav="coven"] span').textContent === 'Fireside');
window.localStorage.setItem('theme', 'nope');
ok('unknown theme falls back to dark', window.getTheme() === 'dark');
window.applyTheme();
ok('fallback applies dataset dark', window.document.documentElement.dataset.theme === 'dark');

// 9. Seasonal coven names incl. solstice
window.localStorage.setItem('theme', 'solstice');
window.applyTheme();
ok('solstice applied', window.document.documentElement.dataset.theme === 'solstice');
ok('meta theme-color solstice', q('meta[name="theme-color"]').getAttribute('content') === '#fdf1d7');
ok('solstice names the sun court', q('.bottom-nav [data-nav="coven"] span').textContent === 'Sun Court');
window.localStorage.setItem('theme', 'midnight');
window.applyTheme();
for (const [th, name] of [['velvet', 'Rose Court'], ['abyss', 'The Deep'], ['frost', 'Winter Court']]) {
  window.localStorage.setItem('theme', th);
  window.applyTheme();
  ok(th + ' names ' + name, q('.bottom-nav [data-nav="coven"] span').textContent === name);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
