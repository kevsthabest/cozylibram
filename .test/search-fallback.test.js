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

async function search(q, source) {
  runInWindow('window.__res = null; window.__err = null; searchBooks(' + JSON.stringify(q) +
    (source === undefined ? '' : ', ' + JSON.stringify(source)) +
    ').then(r => { window.__res = r; }).catch(e => { window.__err = String(e && e.message); });');
  await new Promise(r => setTimeout(r, 50));
  return { res: window.__res, err: window.__err };
}

(async () => {
  // Hardcover configured: asked first, finds the indie book.
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  gbItems = []; olDocs = []; hcDocs = [HC_DOC]; hcCalls = 0;
  let { res, err } = await search('run little killer darma day');
  ok('no error', err === null);
  ok('hardcover first returns the book', Array.isArray(res) && res.length === 1);
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

  // Google Books hit → returned when Hardcover misses (HC asked first now).
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  gbItems = [{ volumeInfo: { title: 'Run Little Killer', authors: ['Darma Day'] } }];
  olDocs = []; hcDocs = []; hcCalls = 0;
  ({ res, err } = await search('run little killer'));
  ok('google books hit wins when hardcover misses', Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover was asked first', hcCalls === 1);

  // Open Library hit → returned when Hardcover and GB miss.
  gbItems = []; hcDocs = [];
  olDocs = [{ key: '/works/OL1W', title: 'Run Little Killer', author_name: ['Darma Day'], first_publish_year: 2025 }];
  hcCalls = 0;
  ({ res, err } = await search('run little killer'));
  ok('open library hit wins when HC and GB miss', Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover asked before OL', hcCalls === 1);

  // hcDocToBook tolerates a sparse doc.
  runInWindow('window.__sparse = hcDocToBook({ title: "Mystery Book" });');
  const s = window.__sparse;
  ok('sparse doc: title kept', s.title === 'Mystery Book');
  ok('sparse doc: safe defaults', s.authors.length === 0 && s.isbn === '' && s.cover === '' && s.id);

  // --- v138: Open Library junk must not block the Hardcover fallback ---
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  gbItems = [];
  // The real OL full-text response for "run little killer": 34 junk hits.
  olDocs = [
    { key: '/works/OL1W', title: 'Run for your life', author_name: ['James Patterson', 'Michael Ledwidge'] },
    { key: '/works/OL2W', title: 'The little book of safe money', author_name: ['Jason Zweig'] },
    { key: '/works/OL3W', title: 'Tick Tock', author_name: ['James Patterson'] }
  ];
  hcDocs = [HC_DOC]; hcCalls = 0;
  ({ res, err } = await search('run little killer darma day'));
  ok('no error on OL junk', err === null);
  ok('hardcover asked first, finds the book despite OL junk',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover was asked first', hcCalls === 1);

  // A genuinely relevant OL hit still wins when Hardcover and GB miss.
  gbItems = []; hcDocs = [];
  olDocs = [{ key: '/works/OL9W', title: 'Run Little Killer', author_name: ['Darma Day'], first_publish_year: 2025 }];
  hcCalls = 0;
  ({ res } = await search('run little killer'));
  ok('relevant OL hit returned', Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover asked before OL', hcCalls === 1);

  // Relevance helper edge cases.
  runInWindow('window.__t1 = queryTokens("Run Little Killer");');
  ok('tokens drop short words', JSON.stringify(window.__t1) === '["run","little","killer"]');
  runInWindow('window.__t2 = queryTokens("the art of war");');
  ok('tokens drop stopwords', JSON.stringify(window.__t2) === '["art","war"]');
  runInWindow('window.__m = resultMatchesQuery({ title: "Run for your life", authors: ["James Patterson"] }, ["run","little","killer"]);');
  ok('one-word overlap is not a match', window.__m === false);
  runInWindow('window.__m2 = resultMatchesQuery({ title: "Little Killer", authors: ["Darma Day"] }, ["run","little","killer"]);');
  ok('two-word overlap is a match', window.__m2 === true);

  // --- v139: source filter ---
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  // 'hardcover' skips Google Books entirely, even when it has hits.
  gbItems = [{ volumeInfo: { title: 'Google Book', authors: ['G Author'] } }];
  olDocs = []; hcDocs = [HC_DOC]; hcCalls = 0;
  ({ res, err } = await search('run little killer', 'hardcover'));
  ok('hardcover source: no error', err === null);
  ok('hardcover source: returns the HC book, not the GB hit',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');
  ok('hardcover source: HC queried', hcCalls === 1);

  // 'gbooks' never touches Hardcover or Open Library.
  gbItems = [{ volumeInfo: { title: 'Google Book', authors: ['G Author'] } }];
  hcCalls = 0;
  let olCalls = 0;
  const prevFetch = window.fetch;
  window.fetch = async (url) => { if (String(url).includes('openlibrary')) olCalls++; return prevFetch(url); };
  ({ res } = await search('something', 'gbooks'));
  ok('gbooks source: GB hit returned', Array.isArray(res) && res.length === 1 && res[0].title === 'Google Book');
  ok('gbooks source: HC untouched', hcCalls === 0);
  ok('gbooks source: OL untouched', olCalls === 0);
  // 'gbooks' with no GB hits → clean empty, no waterfall.
  gbItems = [];
  ({ res } = await search('something', 'gbooks'));
  ok('gbooks source: empty when GB misses', Array.isArray(res) && res.length === 0);
  ok('gbooks source: still no HC/OL on miss', hcCalls === 0 && olCalls === 0);
  window.fetch = prevFetch;

  // 'openlibrary' shows what OL returns, unfiltered (explicit choice).
  gbItems = [];
  olDocs = [{ key: '/works/OL1W', title: 'Run for your life', author_name: ['James Patterson'] }];
  hcCalls = 0;
  ({ res } = await search('run little killer', 'openlibrary'));
  ok('openlibrary source: OL results shown unfiltered',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Run for your life');
  ok('openlibrary source: HC untouched', hcCalls === 0);

  // No source → the v140 waterfall (hardcover first).
  gbItems = []; olDocs = []; hcDocs = [HC_DOC]; hcCalls = 0;
  ({ res } = await search('run little killer darma day'));
  ok('default: hardcover first',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');

  // --- v140: hardcover-first ordering ---
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  // Hardcover junk (irrelevant to the query) doesn't block Google Books.
  gbItems = [{ volumeInfo: { title: 'Google Book', authors: ['G Author'] } }];
  olDocs = []; hcCalls = 0;
  hcDocs = [{ id: 1, title: 'Completely Unrelated', author_names: ['Nobody Else'],
    image: {}, description: '', pages: 0, release_date: '', rating: 0, ratings_count: 0,
    genres: [], cached_tags: [], content_warnings: [] }];
  ({ res, err } = await search('run little killer darma day'));
  ok('no error on HC junk', err === null);
  ok('HC junk filtered, google books hit returned',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Google Book');

  // Hardcover unconfigured → old GB → OL order, no throw.
  runInWindow('window.SPICY_CONFIG = {};');
  gbItems = [{ volumeInfo: { title: 'Google Book', authors: ['G Author'] } }];
  olDocs = [{ key: '/works/OL1W', title: 'OL Book', author_name: ['O Author'] }];
  hcCalls = 0;
  ({ res, err } = await search('run little killer'));
  ok('unconfigured: google books still first',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Google Book');
  ok('unconfigured: hardcover never queried', hcCalls === 0);
  gbItems = [];
  olDocs = [{ key: '/works/OL1W', title: 'Run Little Killer', author_name: ['Darma Day'] }];
  ({ res } = await search('run little killer'));
  ok('unconfigured: falls through to open library',
    Array.isArray(res) && res.length === 1 && res[0].title === 'Run Little Killer');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
