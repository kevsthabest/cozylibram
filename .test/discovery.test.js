// Discovery tests: "more by author" (Google Books) + full series (Hardcover) in the collection sheet.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

const olDocs = [
  { title: 'Owned Book', author_name: ['Jane Doe'], isbn: ['9781111111111'], cover_i: 111 },
  { title: 'Missing Book One', author_name: ['Jane Doe'], isbn: ['9782222222222'], cover_i: 222 },
  { title: 'Missing Book Two', author_name: ['Jane Doe'], isbn: ['9783333333333'] },
  { title: 'Box Set A / Box Set B', author_name: ['Jane Doe'], isbn: ['9784444444440'] },
];
const hcSeries = { data: { series: [ { id: 7, name: 'Test Saga', author: { name: 'Jane Doe' }, books_count: 3,
  book_series: [
    { position: 1, details: '1', book: { id: 1, title: 'Owned Book', image: { url: 'http://x/s1.jpg' },
      default_physical_edition: { isbn_13: '9781111111111' } } },
    { position: 2, details: '2', book: { id: 2, title: 'Saga Book Two', image: { url: 'http://x/s2.jpg' },
      default_physical_edition: { isbn_13: '9784444444444' } } },
    { position: 3, details: '3', book: { id: 3, title: 'Saga Book Three', image: { url: '' },
      default_physical_edition: { isbn_13: null } } },
  ] } ] } };

window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('openlibrary.org/search.json?author=')) return { json: async () => ({ docs: olDocs }) };
  if (u.includes('api.hardcover.app')) {
    if (window.__hcDead) return { json: async () => ({ message: 'unauthorized' }) }; // no data field
    return { json: async () => hcSeries };
  }
  throw new Error('unexpected fetch: ' + u);
};

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
const mk = (id, title, series) =>
  `({ id: '${id}', isbn: '9781111111111', title: '${title}', authors: ['Jane Doe'], cover: '', ` +
  `description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, ` +
  `status: 'read', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0, ` +
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, owned: true, ` +
  (series ? `series: { name: 'Test Saga', position: 1 }, ` : `series: null, `) +
  `log: [], _mtime: 0 })`;

const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
  runInWindow(`localStorage.clear(); localStorage.setItem('hc_token', 'fake-token');
    library.push(${mk('d1', 'Owned Book', true)});`);

  // 1. author sheet: library section + external "more by author"
  runInWindow(`openCollection('author', 'Jane Doe', 'd1');`);
  await tick(); await tick();
  ok('author sheet opens', !!q('.collection-overlay'));
  ok('more-by-author heading', q('#c-more').textContent.includes('More by Jane Doe'));
  const extRows = qa('#c-more .crow.ext');
  ok('owned book excluded from external', extRows.length === 2);
  ok('external row shows title', extRows[0].textContent.includes('Missing Book One'));
  ok('external row has wishlist button', !!extRows[0].querySelector('[data-extadd]'));

  // 2. adding an external book -> wishlist
  extRows[0].querySelector('[data-extadd]').click();
  runInWindow(`window.__added = library[0];`);
  ok('added to library', window.__added.title === 'Missing Book One');
  ok('added as to-buy (wishlist)', window.__added.owned === false);
  ok('added as tbr', window.__added.status === 'tbr');
  ok('button becomes confirmation', q('#c-more').textContent.includes('In wishlist'));
  q('#c-x').click();

  // 3. series sheet via Hardcover
  runInWindow(`openCollection('series', 'Test Saga', 'd1');`);
  await tick(); await tick();
  ok('series heading', q('#c-more').textContent.includes('Every book in this series'));
  const sRows = qa('#c-more .crow.ext');
  ok('series excludes owned book', sRows.length === 2);
  ok('series position shown', sRows[0].textContent.includes('#2'));
  ok('series name carried for add', true);
  sRows[0].querySelector('[data-extadd]').click();
  runInWindow(`window.__sadded = library[0];`);
  ok('series book keeps series+position', window.__sadded.series &&
    window.__sadded.series.name === 'Test Saga' && window.__sadded.series.position === 2);
  ok('series book goes to wishlist', window.__sadded.owned === false);
  q('#c-x').click();

  // 4. series without token -> hint
  runInWindow(`localStorage.removeItem('hc_token'); seriesCache.clear(); openCollection('series', 'Test Saga', 'd1');`);
  await tick(); await tick();
  ok('no-token hint shown', q('#c-more').textContent.includes('Connect Hardcover'));
  q('#c-x').click();

  // 5. dedupe helpers
  ok('inLibrary matches isbn', window.inLibrary({ isbn: '9781111111111', title: 'X', author: 'Y' }) === true);
  ok('inLibrary matches title+author',
    window.inLibrary({ isbn: '', title: 'owned book', author: 'jane doe' }) === true);
  ok('inLibrary false for unknown',
    window.inLibrary({ isbn: '', title: 'Nope', author: 'Nobody' }) === false);

  // 6. dead Hardcover token -> honest error, not "nothing missing"
  runInWindow(`window.__hcDead = true; localStorage.setItem('hc_token', 'revoked-token');
    seriesCache.clear(); authorCache.clear(); openCollection('series', 'Test Saga', 'd1');`);
  await tick(); await tick();
  ok('dead token shows token hint, not empty-shelf',
    q('#c-more').textContent.includes('check the token') &&
    !q('#c-more').textContent.includes('Nothing missing'));
  q('#c-x').click();

  // 7. author lookup hits Open Library (quota-proof), not Google Books
  let sawOL = false;
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('openlibrary.org/search.json?author=')) sawOL = true;
    if (String(url).includes('googleapis.com')) throw new Error('must not use Google Books');
    return origFetch(url, opts);
  };
  runInWindow(`window.__hcDead = false; authorCache.clear(); openCollection('author', 'Jane Doe', 'd1');`);
  await tick(); await tick();
  ok('author discovery uses Open Library', sawOL);
  ok('author rows render (already-added book stays filtered)', qa('#c-more .crow.ext').length === 1);
  window.fetch = origFetch;
  q('#c-x').click();

  // 8. dedupe collapses editions (same title+author, different ISBNs); omnibus sets filtered
  const dupes = window.dedupeExternal([
    { title: 'Same Book', author: 'Jane Doe', isbn: '9780000000001' },
    { title: 'Same Book', author: 'Jane Doe', isbn: '9780000000002' },
    { title: 'Same Book', author: 'Jane Doe', isbn: '9780000000001' },
    { title: 'Other Book', author: 'Jane Doe', isbn: '' },
  ]);
  ok('dedupe collapses editions by title+author', dupes.length === 2);
  runInWindow(`authorCache.clear();`);
  const rows8 = await window.fetchMoreByAuthor('Jane Doe');
  ok('omnibus box sets filtered from author results',
    rows8.every(x => x.title.indexOf(' / ') === -1));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
