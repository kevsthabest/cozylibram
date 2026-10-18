// Progress-percent clamp regression tests — issue #365.
// Two sites computed a progress percent with no clamp: the Stats
// Currently-Reading card (js/170) and the DNF store (js/213
// saveDnfReason). An edition switch that shrinks pageCount under an
// existing progress (400 pages into a 320-page edition) rendered
// "400 / 320 pages · 125%" with a 125%-wide bar, and DNF-ing in that
// state persisted dnfProgressPct = 125. The app's convention
// (progressPctOf, js/040) clamps to 0-100; these sites now do too.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in progress-clamp tests'); };
require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (code) => window.eval(code);
const q = (s) => window.document.querySelector(s);
const mk = (id, extra) => Object.assign({
  id, isbn: '', title: 'Book ' + id, authors: ['A'], cover: '', description: '',
  pageCount: 320, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'reading', ratings: {}, axes: [], myRating: 0,
  tropes: [], progress: 400, log: [], dateAdded: new Date().toISOString(),
  dateFinished: null, notes: ''
}, extra);

(async () => {
  // --- Stats card: progress beyond the (shrunken) page count ---
  run(`library = ${JSON.stringify([mk('pc1', {})])};`);
  run(`renderStats();`);
  const card = q('.now-reading .book-card');
  ok('stats card renders for the over-progress book', !!card);
  const cardHtml = card ? card.innerHTML : '';
  ok('stats card never shows 125%', !cardHtml.includes('125%'));
  ok('stats card shows the clamped 100%', cardHtml.includes('100%'));
  ok('stats bar width is clamped to 100%', cardHtml.includes('width:100%') && !cardHtml.includes('width:125%'));
  ok('stats text still shows the true page numbers', cardHtml.includes('400 / 320 pages · 100%'));

  // --- DNF store: the persisted percent is clamped too ---
  run(`library = ${JSON.stringify([mk('pc2', { status: 'dnf' })])};`);
  run(`window.__dnf = library.find(b => b.id === 'pc2'); saveDnfReason(window.__dnf, 'too_slow');`);
  ok('dnfProgressPct clamps to 100 (was 125)', window.__dnf.dnfProgressPct === 100);

  // Control: an ordinary in-range percent is untouched by the clamp.
  run(`library = ${JSON.stringify([mk('pc3', { status: 'dnf', progress: 160 })])};`);
  run(`window.__dnf3 = library.find(b => b.id === 'pc3'); saveDnfReason(window.__dnf3, 'too_slow');`);
  ok('dnfProgressPct leaves an in-range 50% alone', window.__dnf3.dnfProgressPct === 50);

  console.log('progress-clamp: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
