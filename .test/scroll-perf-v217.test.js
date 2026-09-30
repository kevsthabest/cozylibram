// Tests for v217 — library grid scroll performance.
//
// Covered: bookTile() and coverHTML() emit decoding="async" on cover imgs
// (decode off the main thread) while keeping loading="lazy" and the
// onerror fallback behavior exactly as before. Tiles/cards without a cover
// still render the placeholder path (no img). The content-visibility CSS
// itself can't run in node — noted, not asserted.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const mk = (over) => Object.assign(
  { id: 'x', title: 'T', authors: ['A'], status: 'tbr', cover: '',
    tropes: [], genres: [], myRating: 0, ratings: {}, axes: [],
    favorite: false, progress: 0, pageCount: 0 }, over);

const tile = run(`bookTile(${JSON.stringify(mk({ cover: 'https://ex.com/c.jpg' }))}, 0)`);
ok('tile img has decoding="async"', /<img[^>]*decoding="async"/.test(tile));
ok('tile img keeps loading="lazy"', /<img[^>]*loading="lazy"/.test(tile));
ok('tile img keeps onerror fallback', /<img[^>]*onerror="this.remove\(\)"/.test(tile));

const tileNoCover = run(`bookTile(${JSON.stringify(mk({}))}, 0)`);
ok('tile without cover still renders fallback (no img)', !/<img/.test(tileNoCover));

const card = run(`bookCard(${JSON.stringify(mk({ cover: 'https://ex.com/c.jpg' }))}, 0)`);
ok('card img has decoding="async"', /<img[^>]*decoding="async"/.test(card));
ok('card img keeps loading="lazy"', /<img[^>]*loading="lazy"/.test(card));

const ch = run(`coverHTML(${JSON.stringify(mk({ cover: 'https://ex.com/c.jpg' }))})`);
ok('coverHTML img has decoding="async"', /<img[^>]*decoding="async"/.test(ch));
ok('coverHTML img keeps loading="lazy"', /<img[^>]*loading="lazy"/.test(ch));
const chNoCover = run(`coverHTML(${JSON.stringify(mk({}))})`);
ok('coverHTML without cover still renders placeholder (no img)', !/<img/.test(chNoCover));

console.log(`\nscroll-perf-v217: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
