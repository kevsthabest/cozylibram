// Line-art icon tests (v79): cohesive SVG icon set for the toolbar + view headers.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in icons tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

['covers', 'list', 'series', 'quotes', 'spines'].forEach(n => {
  const svg = window.icon(n);
  ok(n + ' renders an inline svg', /<svg[^>]*class="ticon"/.test(svg) && svg.includes('</svg>'));
  ok(n + ' uses currentColor line-art', svg.includes('stroke="currentColor"') && svg.includes('fill="none"'));
});
// v84: book modal chrome + axis glyphs
['tbr', 'reading', 'read', 'dnf', 'upnext', 'owned', 'tobuy', 'external', 'history',
 'trash', 'search', 'image', 'heart', 'pepper', 'ghost', 'shock', 'swords'].forEach(n => {
  const svg = window.icon(n);
  ok(n + ' renders an inline svg', /<svg[^>]*class="ticon"/.test(svg) && svg.includes('</svg>'));
  ok(n + ' uses currentColor line-art', svg.includes('stroke="currentColor"') && svg.includes('fill="none"'));
});
// v85: full-UI sweep icons
['dice', 'sparkles', 'moon', 'sun', 'globe', 'eye', 'eyeoff', 'download', 'upload', 'doc',
 'camera', 'barcode', 'clipboard', 'share', 'copy', 'gear', 'user', 'logout', 'key', 'pencil',
 'gift', 'warn', 'calendar', 'chart', 'trophy', 'medal', 'flame', 'bulb', 'crystal', 'cloud',
 'pause', 'hourglass', 'help'].forEach(n => {
  const svg = window.icon(n);
  ok(n + ' renders an inline svg', /<svg[^>]*class=\"ticon\"/.test(svg) && svg.includes('</svg>'));
  ok(n + ' uses currentColor line-art', svg.includes('stroke="currentColor"') && svg.includes('fill="none"'));
});
ok('unknown icon falls back to covers', window.icon('nope') === window.icon('covers'));
runInWindow(`window.__axesOk = RATING_AXES.every(a => typeof a.icon === 'string' && icon(a.icon).includes('</svg>'));
window.__axesCount = RATING_AXES.length;`);
ok('every axis has a line-art icon', !!window.__axesOk);

runInWindow(`localStorage.clear(); localStorage.setItem('spicyshelves.animation', 'off'); go('library');`);
ok('view toggle uses line icons', qa('.view-toggle .ticon').length === 2);
ok('quotes toolbar button uses line icon', !!q('#lib-quotes .ticon'));
ok('series toolbar button uses line icon', !!q('#lib-series .ticon'));
ok('no emoji glyphs left in toolbar buttons',
  !q('#lib-quotes').textContent.includes('❝') && !q('#lib-series').textContent.includes('📚'));

runInWindow(`library.push({ id: 'q1', isbn: '', title: 'Q', authors: ['A'], cover: '', description: '',
  pageCount: 100, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, status: 'read',
  ratings: {}, axes: [], myRating: 0, tropes: [], progress: 0, log: [], dateAdded: new Date().toISOString(),
  dateFinished: null, notes: '', favorite: false, owned: true, series: { name: 'Icon Saga', position: 1 },
  series2: null, quotes: [] }); saveLibrary(); go('series');`);
ok('series view header uses line icon', !!q('#view h2 .ticon'));

// v84: book detail modal uses line-art icons instead of emoji glyphs
runInWindow(`openBookFromEl(null, 'q1');`);
ok('modal shelf buttons use line icons', qa('#f-status .ticon').length === 4);
ok('no emoji left in shelf buttons',
  !['📖','📘','✅','🚫'].some(e => q('#f-status').textContent.includes(e)));
ok('up next button uses line icon', !!q('#m-upnext .ticon'));
ok('ownership buttons use line icons', qa('#f-owned .ticon').length === 3);
ok('axis rows use line icons', qa('#f-axrows .axlab .ticon').length === qa('#f-axrows .axrow').length && qa('#f-axrows .axrow').length > 0);
ok('header rating hearts use line icons', qa('#f-myrating .ticon').length === 5);
ok('favorite button uses line icon', !!q('#f-fav .ticon'));
ok('change-cover button uses line icon', !!q('#m-changecover .ticon'));
ok('previously-read uses line icon', !!q('#f-prevwrap .ticon'));
ok('store links use line icon', qa('#m-buywrap .ticon').length > 0);

// v85: rest-of-UI line-art sweep
runInWindow(`go('library');`);
ok('shelf filter chips use line icons', qa('#view .chips .ticon').length >= 4);
ok('ownership filter chips use line icons', qa('#view .chips .ticon').length >= 6);
runInWindow(`library[0].status = 'reading'; renderLibrary();`);
ok('recently-read header uses line icon', !!q('.recent-head .ticon'));
runInWindow(`go('add');`);
ok('add tabs use line icons', qa('.tabs .ticon').length === 4);
runInWindow(`go('wishlist');`);
ok('wishlist header uses line icon', !!q('#view .wish-head .ticon'));
runInWindow(`go('authors');`);
ok('authors header uses line icon', !!q('#view .wish-head .ticon'));
runInWindow(`go('pick');`);
ok('roulette header uses line icon', !!q('#view h2 .ticon'));
ok('roulette empty state uses line icon', !!q('#view .empty .big .ticon'));
runInWindow(`go('stats');`);
ok('stats headers use line icons', qa('#view .stat-sub .ticon').length >= 3);
runInWindow(`go('settings');`);
ok('settings toggles use line icons', qa('#view .seg .ticon').length >= 4);
ok('settings buttons use line icons', qa('#view .btn .ticon').length >= 5);
runInWindow(`openBookFromEl(null, 'q1');`);
ok('my-rating picker uses line icons', qa('#f-myrating .ticon').length === 5);
ok('share button uses line icon', !!q('#m-share .ticon'));
runInWindow(`document.getElementById('m-x').click();`);

// v102: rating badges use theme-aware line-art instead of emoji
// (⚔️ renders near-black on some Android emoji fonts — invisible on dark themes)
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
[['spice', 3], ['scare', 2], ['suspense', 4], ['adventure', 5]].forEach(([k, v]) => {
  const html = window.ratingBadges({ axes: [k], ratings: { [k]: v } });
  ok(k + ' badge renders ' + v + ' line-art glyphs', (html.match(/<svg/g) || []).length === v);
  ok(k + ' badge contains no emoji', !EMOJI_RE.test(html));
  ok(k + ' badge has no hardcoded fill color', !/fill="#/.test(html));
});
ok('unrated axis renders no badge', window.ratingBadges({ axes: ['spice'], ratings: {} }) === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
