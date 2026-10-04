// Page-count lookup tests: ISBN-based fetch with mocked network,
// fillPageCount, modal lookup button, backfill, addBook background fill.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

const jok = (j) => ({ ok: true, json: async () => j });
const no = { ok: false, status: 404 };
const seenUrls = [];
const seenEvents = [];
window.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  seenUrls.push(u);
  if (u.includes('/api/inventaire/entities')) {
    // v245: Inventaire hit only for 7777777777; everything else misses.
    if (u.includes('uris=isbn:7777777777')) {
      return jok({ entities: { 'inv:abc': { uri: 'inv:abc', type: 'edition',
        labels: { fromclaims: 'Inv Book' },
        claims: { 'wdt:P212': ['7777777777'], 'wdt:P1104': [321] } } },
        redirects: { 'isbn:7777777777': 'inv:abc' } });
    }
    return jok({ entities: {}, redirects: {} });
  }
  if (u.includes('/isbn/1111111111.json')) return jok({ number_of_pages: 384 });
  if (u.includes('/isbn/2222222222.json')) return jok({ number_of_pages: 200 });
  if (u.includes('/isbn/3333333333.json')) return jok({ number_of_pages: 250 });
  if (u.includes('/isbn/6666666666.json')) return jok({ number_of_pages: 500 });
  if (u.includes('/isbn/4444444444.json')) return jok({ title: 'no pages here' });
  if (u.includes('search.json?isbn=4444444444')) return jok({ docs: [{ key: '/books/OL1' }, { key: '/books/OL2' }] });
  if (u.endsWith('/books/OL1.json')) return jok({ title: 'no pages' });
  if (u.endsWith('/books/OL2.json')) return jok({ number_of_pages: 300 });
  if (u.includes('openlibrary.org')) return no;
  throw new Error('unexpected fetch in pagecount tests: ' + u);
};

require('./harness').loadApp(window);
// Spy on analytics without touching the pipeline.
window.track = (name, props) => { seenEvents.push([name, props]); };

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 50));
const mk = (id, isbn, pc) => `({ id: '${id}', isbn: '${isbn}', title: 'PC ${id}', authors: ['A'], cover: '',
  description: '', pageCount: ${pc === null ? 'null' : pc}, publishedDate: '', categories: [],
  publicRating: null, ratingsCount: 0, status: 'tbr', ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: '' })`;

(async () => {
  // 1. v269: Google Books removed from the chain — Open Library serves it,
  // and GB is never consulted.
  seenUrls.length = 0;
  ok('OL hit returns pages', await window.fetchPageCountByISBN('1111111111') === 384);
  ok('GB never consulted', !seenUrls.some(u => u.includes('googleapis.com') || u.includes('/api/gbooks')));
  // 2. (GB exact-ISBN preference test retired with the GB step.)
  // 3. OL edition miss -> other editions via search
  // 4. OL edition w/o pages -> other editions via search
  ok('OL other-editions fallback', await window.fetchPageCountByISBN('4444444444') === 300);
  // 5. total miss / empty
  ok('total miss returns null', await window.fetchPageCountByISBN('5555555555') === null);
  ok('empty ISBN returns null', await window.fetchPageCountByISBN('') === null);

  // 6. fillPageCount fills + saves; skips when present or no ISBN
  runInWindow(`window.__a = ${mk('pca', '1111111111', null)}; library.push(window.__a);
    window.__b = ${mk('pcb', '', null)}; library.push(window.__b);
    window.__c = ${mk('pcc', '1111111111', 123)}; library.push(window.__c);`);
  ok('fillPageCount fills missing', await window.fillPageCount(window.__a) === true && window.__a.pageCount === 384);
  ok('fillPageCount skips no-ISBN', await window.fillPageCount(window.__b) === false);
  ok('fillPageCount skips existing', await window.fillPageCount(window.__c) === false && window.__c.pageCount === 123);

  // 7. modal lookup button fills the Total pages input
  runInWindow(`window.__d = ${mk('pcd', '1111111111', null)}; library.push(window.__d); openDetail('pcd');`);
  ok('lookup button shown when ISBN present', !!q('#pc-lookup'));
  q('#pc-lookup').click();
  await tick();
  ok('lookup fills Total pages input', q('#f-pagecount').value === '384');
  q('#m-save').click();
  ok('save persists looked-up pages', window.__d.pageCount === 384);

  // 8. no lookup button without ISBN
  runInWindow(`window.__e = ${mk('pce', '', null)}; library.push(window.__e); openDetail('pce');`);
  ok('no lookup button without ISBN', !q('#pc-lookup'));
  window.document.getElementById('m-x').click();

  // 9. backfill fills only missing-with-ISBN
  runInWindow(`window.__f = ${mk('pcf', '3333333333', null)}; library.push(window.__f);`);
  const n = await window.backfillPageCounts(0);
  ok('backfill found 1 book', n === 1 && window.__f.pageCount === 250);
  ok('backfill skipped no-ISBN book', window.__b.pageCount == null);

  // 10. addBook triggers background fill
  runInWindow(`window.addBook(${mk('pcg', '6666666666', null)});`);
  await tick(150);
  runInWindow(`window.__gpc = (library.find(b => b.id === 'pcg') || {}).pageCount;`);
  ok('addBook background fill', window.__gpc === 500);

  // 11. v245: Inventaire serves page counts (HC miss → Inventaire hit).
  seenUrls.length = 0; seenEvents.length = 0;
  ok('Inventaire hit returns pages', await window.fetchPageCountByISBN('7777777777') === 321);
  ok('provider_used tracked as inventaire/pagecount',
    seenEvents.some(e => e[0] === 'provider_used' && e[1].provider === 'inventaire' && e[1].context === 'pagecount'));

  // 12. v245: Hardcover first — stubbed doc wins; GB is gone in v269.
  const origHc = window.hcSearchDocs;
  window.hcSearchDocs = async () => [{ isbns: ['8888888888'], pages: 400, title: 'HC Book' }];
  seenUrls.length = 0; seenEvents.length = 0;
  ok('Hardcover hit wins', await window.fetchPageCountByISBN('8888888888') === 400);
  ok('GB not consulted on Hardcover hit',
    !seenUrls.some(u => u.includes('/api/gbooks')));
  ok('provider_used tracked as hardcover/pagecount',
    seenEvents.some(e => e[0] === 'provider_used' && e[1].provider === 'hardcover' && e[1].context === 'pagecount'));

  // 13. v245: HC fuzzy guard — doc ISBN must match the scanned ISBN.
  // v269: near-miss falls through to Inventaire/OL (GB removed) → null here.
  window.hcSearchDocs = async () => [{ isbns: ['9999999999'], pages: 400, title: 'Wrong Book' }];
  ok('HC near-miss ISBN falls through, no GB', await window.fetchPageCountByISBN('8888888888') === null);
  window.hcSearchDocs = origHc;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
