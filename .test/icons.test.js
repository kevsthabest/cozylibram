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
ok('ownership buttons use line icons', qa('#f-owned .ticon').length === 2);
ok('axis chips use line icons', qa('#f-axes .ticon').length === window.__axesCount);
ok('axis pickers use line icons', qa('#f-axrows .picker .ticon').length === 5 * qa('#f-axrows .axrow').length);
ok('favorite button uses line icon', !!q('#f-fav .ticon'));
ok('change-cover button uses line icon', !!q('#m-changecover .ticon'));
ok('previously-read uses line icon', !!q('#f-prevwrap .ticon'));
ok('store links use line icon', qa('#m-buywrap .ticon').length > 0);
runInWindow(`document.getElementById('m-x').click();`);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
