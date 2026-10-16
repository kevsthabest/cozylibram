// Tests for v133 — series books shown inline:
// the series name is display-only; sibling books list right away with no
// tap-through overlay; the full-series Hardcover fill still works.
// MOVEMENT (Variant A modal rebuild, named in its PR): the inline block
// is now the header-zone series STRIP (one row of cover figures above
// the tabs, current book included and marked .cur, missing books as
// "+ Wishlist" figures). Pins below were rewritten to the strip shape;
// the behaviours they guard are unchanged.
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

// --- inline strip for series books ---
runInWindow(`openBookFromEl(null, 's1');`);
ok('inline series strip renders', !!q('#m-series'));
ok('series name shown as text', q('#m-series .lbl').textContent.includes('The Great Saga'));
ok('book position shown in the current figure caption',
  q('#m-series .strip-fig.cur figcaption').textContent.includes('#1'));
ok('no series taplink anywhere in the modal', !q('[data-series]'));
ok('old series-line tap row is gone', !q('#m-hc .series-line'));
const rows = qa('#m-series [data-book]').map(r => r.dataset.book);
ok('siblings carry data-book, current excluded (it is the .cur figure)',
  rows.length === 2 && !rows.includes('s1') && !!q('#m-series .strip-fig.cur'));
ok('siblings sorted by position', rows[0] === 's0' && rows[1] === 's2');

// --- tapping a sibling opens it ---
q('#m-series [data-book="s2"]').click();
ok('tapping a series figure opens that book', q('.d-hero h2').textContent === 'Second Book');
ok('opened book shows its own strip', !!q('#m-series') &&
  q('#m-series .strip-fig.cur figcaption').textContent.includes('#2'));

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
  // v535 (audit #19): the note no longer points at the removed
  // "Settings → Hardcover" section — Hardcover is configured
  // server-side, so the box just says it's unavailable.
  // Variant A: the note now rides in the strip itself (no #m-series-more box).
  ok('strip shows the Hardcover unavailable note without a token',
    q('#m-series .strip-note') && q('#m-series .strip-note').textContent.includes('isn’t available'));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}, 400);

// --- v239: manual series tagging ---
setTimeout(() => {
  // tag the standalone book as #3 of The Great Saga via the modal editor
  runInWindow(`openBookFromEl(null, 's3');`);
  q('#f-series').value = 'The Great Saga';
  q('#f-series-pos').value = '3';
  q('#m-x').click();
  const s3 = window.eval(`library.find(b => b.id === 's3')`);
  ok('save writes the manual series', s3.series && s3.series.name === 'The Great Saga' && String(s3.series.position) === '3');
  ok('manual series sets the seriesManual flag', s3.seriesManual === true);
  // reopening shows it in the inline block, sorted after #2
  runInWindow(`openBookFromEl(null, 's3');`);
  ok('strip appears for the newly-tagged book',
    !!q('#m-series') && q('#m-series .lbl').textContent.includes('The Great Saga') &&
    q('#m-series .strip-fig.cur figcaption').textContent.includes('#3'));
  const rows3 = Array.from(window.document.querySelectorAll('#m-series [data-book]')).map(r => r.dataset.book);
  ok('tagged book sees its shelf-mates, sorted by position',
    rows3.length === 3 && rows3[0] === 's0' && rows3[1] === 's1' && rows3[2] === 's2');
  // enrichment must not clobber a manual series
  const kept = window.eval(`(() => { const b = library.find(x => x.id === 's3');
    applyHardcoverDoc(b, { series_names: ['Some Other Series'] }); return b.series.name; })()`);
  ok('enrichment keeps a manual series', kept === 'The Great Saga');
  // ...but still applies when nothing was set by hand
  const applied = window.eval(`(() => { const b = library.find(x => x.id === 's1');
    applyHardcoverDoc(b, { series_names: ['The Great Saga'] }); return b.series.name; })()`);
  ok('enrichment still applies without the manual flag', applied === 'The Great Saga');
  // clearing the name removes the series and the flag
  runInWindow(`openBookFromEl(null, 's3');`);
  q('#f-series').value = '';
  q('#m-x').click();
  const cleared = window.eval(`(() => { const b = library.find(x => x.id === 's3'); return [b.series, b.seriesManual]; })()`);
  ok('clearing the name removes the series and flag', cleared[0] === null && cleared[1] === false);
  console.log(`\n${pass} passed, ${fail} failed (incl. v239)`);
  if (fail) process.exitCode = 1;
}, 800);
