// Tests for v133 — series books shown inline in Series & Discovery:
// the series name is display-only; sibling books list right away with no
// tap-through overlay; the full-series Hardcover fill still works.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in series tests'); };

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

const book = (id, over) => Object.assign({
  id, isbn: '', title: 'Title ' + id, authors: ['Author A'], cover: '', description: '',
  pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
  status: 'read', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 0, log: [],
  dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false,
  owned: true, series: null, series2: null, quotes: []
}, over);

const b0 = book('s0', { title: 'Prequel Book', series: { name: 'The Great Saga', position: 0.5 } });
const b1 = book('s1', { title: 'First Book', series: { name: 'The Great Saga', position: 1 } });
const b2 = book('s2', { title: 'Second Book', series: { name: 'The Great Saga', position: 2 } });
const b3 = book('s3', { title: 'Standalone', series: null });
runInWindow(`localStorage.clear(); library = [];
  library.push(${JSON.stringify(b0)}, ${JSON.stringify(b1)}, ${JSON.stringify(b2)}, ${JSON.stringify(b3)});
  saveLibrary();`);

// --- inline block for series books ---
runInWindow(`openBookFromEl(null, 's1');`);
ok('inline series block renders', !!q('#m-series'));
ok('series name shown as text', q('#m-series label').textContent.includes('The Great Saga'));
ok('book position shown', q('#m-series label').textContent.includes('Book 1'));
ok('no series taplink anywhere in the modal', !q('[data-series]'));
ok('old series-line tap row is gone', !q('#m-hc .series-line'));
const rows = qa('#m-series [data-book]').map(r => r.dataset.book);
ok('sibling books listed, current excluded', rows.length === 2 && !rows.includes('s1'));
ok('siblings sorted by position', rows[0] === 's0' && rows[1] === 's2');

// --- tapping a sibling opens it ---
q('#m-series [data-book="s2"]').click();
ok('tapping a series row opens that book', q('.modal-head h2').textContent === 'Second Book');
ok('opened book shows its own inline block', !!q('#m-series') &&
  q('#m-series label').textContent.includes('Book 2'));

// --- standalone books get no block ---
runInWindow(`openBookFromEl(null, 's3');`);
ok('no inline block for standalone books', !q('#m-series'));

// --- enrichment landing later adds the block without clobbering ---
runInWindow(`var bk = library.find(b => b.id === 's3');
  bk.series = { name: 'The Great Saga', position: 4 }; refreshSeriesInline(bk);`);
ok('enrichment refresh adds the inline block', !!q('#m-series'));
ok('enrichment block lists the series siblings',
  qa('#m-series [data-book]').length === 3);

// --- full-series fill without a Hardcover token ---
runInWindow(`openBookFromEl(null, 's1');`);
setTimeout(() => {
  ok('full-series box shows the Hardcover connect note without a token',
    q('#m-series-more') && q('#m-series-more').textContent.includes('Connect Hardcover'));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}, 400);
