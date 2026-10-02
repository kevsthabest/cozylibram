// Inventaire (inventaire.io) metadata source tests (v244): proxy URL shape,
// entity→book normalization, work→author resolution, and the ISBN-lookup
// waterfall placement (Google Books → Inventaire → Open Library).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

// Fixtures shaped like the live API responses (verified 2026-10-02).
const EDITION_URI = 'inv:d59e3e64f92c6340fbb10c5dcf0b45d3';
const EDITION = {
  uri: EDITION_URI,
  type: 'edition',
  labels: { fromclaims: "Les aventures d'Alice au pays des merveilles" },
  claims: {
    'wdt:P212': ['978-2-07-038916-2'],
    'wdt:P957': ['2-07-038916-2'],
    'wdt:P1476': ["Les aventures d'Alice au pays des merveilles"],
    'wdt:P629': ['wd:Q92640'],
    'wdt:P577': ['1994'],
    'wdt:P1104': [374],
    'wdt:P648': ['OL8838818M'],
  },
  originalLang: 'fr',
  image: { url: '/img/entities/c43ece814fae7d9da8c97293a182d1dfcd24baa2' },
};
const WORK = {
  uri: 'wd:Q92640',
  type: 'work',
  labels: { en: "Alice's Adventures in Wonderland", fr: "Les Aventures d'Alice au pays des merveilles" },
  claims: { 'wdt:P50': ['wd:Q38082'] },
};
const AUTHOR = {
  uri: 'wd:Q38082',
  type: 'human',
  labels: { en: 'Lewis Carroll', fr: 'Lewis Carroll' },
  claims: {},
};
const GB_ITEM = {
  id: 'gb1',
  volumeInfo: {
    title: 'GB Book', authors: ['GB Author'],
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780123456789' }],
  },
};

const seenUrls = [];
const seenEvents = [];
let gbMode = 'miss'; // 'miss' | 'hit'
window.fetch = async (url) => {
  const u = String(url);
  seenUrls.push(u);
  if (u.indexOf('/api/gbooks/') !== -1) {
    return { ok: true, json: async () => (gbMode === 'hit' ? { items: [GB_ITEM] } : { items: [] }) };
  }
  if (u.indexOf('/api/inventaire/entities') !== -1) {
    const uris = decodeURIComponent((u.split('uris=')[1] || '').split('&')[0]);
    const entities = {}, redirects = {};
    if (uris.indexOf('isbn:9782070389162') !== -1) {
      entities[EDITION_URI] = EDITION;
      redirects['isbn:9782070389162'] = EDITION_URI;
    }
    if (uris.indexOf('wd:Q92640') !== -1) entities['wd:Q92640'] = WORK;
    if (uris.indexOf('wd:Q38082') !== -1) entities['wd:Q38082'] = AUTHOR;
    return { ok: true, json: async () => ({ entities, redirects }) };
  }
  if (u.indexOf('openlibrary.org') !== -1) {
    return { ok: true, json: async () => ({ docs: [] }) };
  }
  return { ok: true, json: async () => ({}) };
};

require('./harness').loadApp(window);
// Spy on analytics without touching the pipeline.
window.track = (name, props) => { seenEvents.push([name, props]); };

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  // 1. Proxy URL shape: same-origin, entities endpoint, by-uris action.
  ok('invProxyUrl targets the same-origin proxy',
    window.invProxyUrl('action=by-uris&uris=isbn%3A978') ===
    '/api/inventaire/entities?action=by-uris&uris=isbn%3A978');

  // 2. Normalizer: edition entity → book shell.
  const b = window.invEditionToBook(EDITION, ['Lewis Carroll']);
  ok('title from P1476', b.title === "Les aventures d'Alice au pays des merveilles");
  ok('ISBN-13 dashes stripped', b.isbn === '9782070389162');
  ok('authors carried over', JSON.stringify(b.authors) === '["Lewis Carroll"]');
  ok('page count numeric', b.pageCount === 374);
  ok('published date kept', b.publishedDate === '1994');
  ok('cover made absolute', b.cover === 'https://inventaire.io/img/entities/c43ece814fae7d9da8c97293a182d1dfcd24baa2');
  ok('shelf defaults', b.status === 'tbr' && b.owned === 'owned' && !!b.id);

  // 3. Label preference: French first (the project's strong suit).
  ok('invLabel prefers French',
    window.invLabel({ labels: { en: 'X', fr: 'Y' } }) === 'Y');
  ok('invLabel falls back to English',
    window.invLabel({ labels: { en: 'X' } }) === 'X');

  // 4. Full ISBN lookup: edition → work → authors.
  seenUrls.length = 0;
  const found = await window.invLookupISBN('9782070389162');
  ok('invLookupISBN resolves the edition', !!found && found.isbn === '9782070389162');
  ok('authors resolved via the work', JSON.stringify(found.authors) === '["Lewis Carroll"]');
  ok('three proxy calls (edition, work, authors)',
    seenUrls.filter(u => u.indexOf('/api/inventaire/entities') !== -1).length === 3);

  // 5. Unknown ISBN → null (falls through to Open Library in the waterfall).
  ok('unknown ISBN returns null', await window.invLookupISBN('9780000000000') === null);

  // 6. Edition without a work link → authors empty, still a book.
  const noWork = Object.assign({}, EDITION, { claims: Object.assign({}, EDITION.claims) });
  delete noWork.claims['wdt:P629'];
  const b2 = window.invEditionToBook(noWork, []);
  ok('edition without work still normalizes', b2.title.indexOf('Alice') !== -1 && b2.authors.length === 0);

  // 7. Waterfall: GB miss → Inventaire serves, provider tracked.
  gbMode = 'miss';
  seenUrls.length = 0; seenEvents.length = 0;
  const w1 = await window.lookupISBNFromAPIs('9782070389162');
  ok('waterfall falls through GB to Inventaire', !!w1 && w1.title.indexOf('Alice') !== -1);
  ok('no openlibrary provider event when Inventaire answers',
    !seenEvents.some(e => e[0] === 'provider_used' && e[1].provider === 'openlibrary'));
  const pv = seenEvents.find(e => e[0] === 'provider_used');
  ok('provider_used tracked as inventaire/isbn',
    !!pv && pv[1].provider === 'inventaire' && pv[1].context === 'isbn');

  // 8. Waterfall: GB hit → Inventaire never called.
  gbMode = 'hit';
  seenUrls.length = 0;
  const w2 = await window.lookupISBNFromAPIs('9780123456789');
  ok('GB hit short-circuits the waterfall', !!w2 && w2.title === 'GB Book');
  ok('Inventaire not called on GB hit',
    !seenUrls.some(u => u.indexOf('/api/inventaire/') !== -1));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
