// v137: Search falls back to Hardcover when Google Books and Open Library
// both come up empty (the indie/KU romance coverage gap — e.g. "Run Little
// Killer" by Darma Day, which is in neither catalog).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

const HC_DOC = {
  id: 987654,
  title: 'Run Little Killer',
  author_names: ['Darma Day'],
  release_date: '2025-08-26',
  isbns: ['9798283841234'],
  description: 'Justice failed me, karma turned a blind eye…',
  pages: 322,
  genres: ['Dark Romance'],
  moods: ['Dark'],
  content_warnings: ['Violence'],
  image: { url: 'https://example.com/rlk.jpg' },
  rating: 4.2,
  ratings_count: 150
};

let gbItems = [], olDocs = [], hcDocs = [], hcCalls = 0;
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/gbooks')) return { status: 200, json: async () => ({ items: gbItems }) };
  if (u.includes('openlibrary')) return { status: 200, json: async () => ({ docs: olDocs }) };
  if (u.includes('/api/hardcover')) {
    hcCalls++;
    return { status: 200, json: async () => ({ data: { search: { results: { hits: hcDocs.map(d => ({ document: d })) } } } }) };
  }
  throw new Error('unexpected fetch: ' + u);
};

async function search(q) {
  runInWindow('window.__res = null; window.__err = null; searchBooks(' + JSON.stringify(q) +
    ').then(r => { window.__res = r; }).catch(e => { window.__err = String(e && e.message); });');
  await new Promise(r => setTimeout(r, 50));
  return { res: window.__res, err: window.__err };
}

(async () => {
  // Hardcover configured: GB + OL empty → Hardcover finds the indie book.
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  gbItems = []; olDocs = []; hcDocs = [HC_DOC]; hcCalls = 0;
  let { res, err } = await search('run little killer darma day');
  ok('no error', err === null);
  ok('hardcover fallback returns the book', Array.isArray(res) && res.length === 1);
  const b = res[0];
  ok('title mapped', b.title === 'Run Little Killer');
  ok('authors mapped', JSON.stringify(b.authors) === '["Darma Day"]');
  ok('isbn mapped', b.isbn === '9798283841234');
  ok('cover mapped', b.cover === 'https://example.com/rlk.jpg');
  ok('pages mapped', b.pageCount === 322);
  ok('blurb mapped', b.description.indexOf('Justice failed me') === 0);
  ok('published date mapped', b.publishedDate === '2025-08-26');
  ok('hardcover rating adopted', b.publicRating === 4.2 && b.ratingsCount === 150);
  ok('content warnings adopted', Array.isArray(b.contentWarnings) && b.contentWarnings.includes('Violence'));
  ok('moods adopted', Array.isArray(b.moods) && b.moods.includes('Dark'));
  ok('marked enriched (skips later re-enrichment)', b.hcEnriched === true);
  ok('hardcover id stashed', b.hcId === 987654);
  ok('hardcover was actually queried', hcCalls === 1);

  // Hardcover not configured → clean empty result, no throw.
  runInWindow('window.SPICY_CONFIG = {};');
  gbItems = []; olDocs = []; hcDocs = [HC_DOC]; hcCalls = 0;
  ({ res, err } = await search('run little killer darma day'));
  ok('no error without hardcover configured', err === null);
  ok('empty when nothing configured and catalogs miss', Array.isArray(res) && res.length === 0);
  ok('hardcover not queried when unconfigured', hcCalls === 0);

  // Google Books hit → Hardcover never asked.
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  gbItems = [{ volumeInfo: { title: 'Run Little Killer', authors: ['Darma Day'] } }];
  olDocs = []; hcDocs = [HC_DOC]; hcCalls = 0;
  ({ res, err } = await search('run little killer'));
  ok('google books hit wins', Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover skipped on google hit', hcCalls === 0);

  // Open Library hit → Hardcover never asked.
  gbItems = [];
  olDocs = [{ key: '/works/OL1W', title: 'Run Little Killer', author_name: ['Darma Day'], first_publish_year: 2025 }];
  hcCalls = 0;
  ({ res, err } = await search('run little killer'));
  ok('open library hit wins', Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover skipped on OL hit', hcCalls === 0);

  // hcDocToBook tolerates a sparse doc.
  runInWindow('window.__sparse = hcDocToBook({ title: "Mystery Book" });');
  const s = window.__sparse;
  ok('sparse doc: title kept', s.title === 'Mystery Book');
  ok('sparse doc: safe defaults', s.authors.length === 0 && s.isbn === '' && s.cover === '' && s.id);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
