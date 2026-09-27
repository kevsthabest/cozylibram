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

['covers', 'list', 'series', 'quotes'].forEach(n => {
  const svg = window.icon(n);
  ok(n + ' renders an inline svg', /<svg[^>]*class="ticon"/.test(svg) && svg.includes('</svg>'));
  ok(n + ' uses currentColor line-art', svg.includes('stroke="currentColor"') && svg.includes('fill="none"'));
});
ok('unknown icon falls back to covers', window.icon('nope') === window.icon('covers'));

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
