// Dead-write removal regression tests — issue #360.
// Two guarded writes targeted elements no template emits, so the code
// claimed behaviour it did not have:
//   - refreshSeriesInline (js/150) wrote the header series position to
//     #d-pos, an element the Variant A modal never emits;
//   - backfillPageCounts (js/080) wrote progress text to
//     #pc-backfill-note, whose host Settings UI was removed in v476.
// The fix deletes the dead writes. These tests pin (a) the dead ids are
// gone from the sources, and (b) the live halves still work: the series
// strip repaint is covered by modal-series-inline.test.js, and the
// backfill still fills counts and reports via its return value/toast.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

// (a) Static: the dead targets are gone from the sources.
const src150 = fs.readFileSync(path.join(ROOT, 'js/150-modal-discovery.js'), 'utf8');
const src080 = fs.readFileSync(path.join(ROOT, 'js/080-pagecount.js'), 'utf8');
ok('js/150 no longer references #d-pos', !src150.includes('d-pos'));
ok('js/080 no longer references #pc-backfill-note', !src080.includes('pc-backfill-note'));
ok('refreshSeriesInline still repaints the series strip',
  src150.includes('refreshSeriesInline') && src150.includes("getElementById('m-series-wrap')"));

// (b) Live: backfill still fills a missing page count end to end.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
const jok = (j) => ({ ok: true, json: async () => j });
window.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  if (u.includes('/isbn/3333333333.json')) return jok({ number_of_pages: 250 });
  if (u.includes('openlibrary.org')) return { ok: false, status: 404 };
  throw new Error('unexpected fetch in dead-writes tests: ' + u);
};
require('./harness').loadApp(window);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

(async () => {
  runInWindow(`(function(){
    localStorage.clear();
    library.length = 0;
    window.__bk = { id: 'dw1', isbn: '3333333333', title: 'DW Book', authors: ['A'],
      cover: '', description: '', pageCount: null, publishedDate: '', categories: [],
      publicRating: null, ratingsCount: 0, status: 'tbr', ratings: {}, axes: [],
      myRating: 0, tropes: [], progress: 0, log: [],
      dateAdded: new Date().toISOString(), dateFinished: null, notes: '' };
    library.push(window.__bk);
    saveLibrary();
  })();`);
  const n = await window.backfillPageCounts(0);
  ok('backfill fills the missing count without the dead note element',
    n === 1 && window.__bk.pageCount === 250);
  const n2 = await window.backfillPageCounts(0);
  ok('backfill with nothing missing returns 0', n2 === 0);

  console.log('dead-writes: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
