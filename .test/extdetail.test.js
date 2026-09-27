// External book detail sheet (v60): tapping a missing book shows its details.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in extdetail tests'); };
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const probe = (js) => window.eval(js);

(async () => {
  runInWindow(`localStorage.clear(); localStorage.setItem('spicyshelves.animation', 'off');`);
  // stub the metadata lookups: no network in tests
  window.lookupISBN = async () => null;
  window.searchBooks = async () => [{
    title: 'Missing Book', authors: ['Jane Doe'], cover: 'https://x/c.jpg',
    description: 'A thrilling tale of darkness.', pageCount: 320,
    publishedDate: '2021-05-01', publicRating: 4.2, ratingsCount: 1500,
    isbn: '9781234567890',
  }];

  // 1. the sheet renders immediately with what we know
  runInWindow(`openExternalDetail({ title: 'Missing Book', author: 'Jane Doe', cover: '', isbn: '', position: 2, seriesName: 'Saga' });`);
  ok('detail sheet opens', !!q('.collection-overlay .ext-detail'));
  ok('shows title + series position + author',
    q('.ext-detail h2').textContent === 'Missing Book' &&
    q('.ext-detail .note').textContent.includes('#2') &&
    q('.ext-detail .note').textContent.includes('Saga') &&
    q('.ext-detail .note').textContent.includes('Jane Doe'));
  ok('shows loading state first', q('#x-meta').textContent.includes('Looking up'));

  // 2. background enrichment fills in the details
  await tick(60);
  ok('enrichment shows description', (q('#x-desc') || {}).textContent.includes('thrilling tale'));
  ok('enrichment shows pages/year/rating',
    q('#x-meta').textContent.includes('320 pages') &&
    q('#x-meta').textContent.includes('2021') &&
    q('#x-meta').textContent.includes('4.2'));

  // 3. + Wishlist adds the enriched book
  q('#x-wish').click();
  const added = probe(`library.find(b => b.title === 'Missing Book')`);
  ok('wishlist adds the book as not-owned', !!added && added.owned === 'tobuy');
  ok('enriched fields are kept', !!added && added.pageCount === 320 &&
    added.description.includes('thrilling tale'));
  ok('button becomes a confirmation', !q('#x-wish') &&
    window.document.body.textContent.includes('In your wishlist'));

  // 4. close button removes the sheet
  q('#x-x').click();
  ok('sheet closes', !q('.collection-overlay .ext-detail'));

  // 5. author page: tapping a missing row opens details; the + Wishlist
  // button adds without opening the sheet
  window.fetch = async (url) => {
    if (String(url).includes('openlibrary.org/search.json?author=')) {
      return { json: async () => ({ docs: [
        { title: 'Missing Book Two', author_name: ['Jane Doe'], cover_i: 0, isbn: [] },
      ] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  runInWindow(`library.length = 0;
    library.push({ id: 'a1', isbn: '', title: 'Owned Book', authors: ['Jane Doe'], cover: '',
      description: '', pageCount: 200, publishedDate: '', categories: [], publicRating: null,
      ratingsCount: 0, status: 'read', owned: 'owned', ratings: {}, axes: [], myRating: 0,
      tropes: [], progress: 200, dateAdded: new Date().toISOString(), dateFinished: null,
      notes: '', favorite: false, log: [] });
    openAuthor('Jane Doe');`);
  await tick(60);
  const row = q('[data-miss]');
  ok('missing row rendered on author page', !!row);
  row.click();
  await tick(30);
  ok('tapping the row opens the detail sheet',
    !!q('.collection-overlay .ext-detail') &&
    q('.ext-detail h2').textContent === 'Missing Book Two');
  q('#x-x').click();
  q('[data-madd]').click();
  await tick(30);
  ok('wishlist button does not open the sheet', !q('.collection-overlay .ext-detail'));
  ok('wishlist button adds the book',
    probe(`library.some(b => b.title === 'Missing Book Two' && b.owned === 'tobuy')`));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
