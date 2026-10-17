// Mocked Hardcover integration tests. Fake token only — never a real one.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

const fetchCalls = [];
let responseQueue = [];
window.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  const next = responseQueue.shift();
  if (next === undefined) throw new Error('fetch called with empty mock queue');
  return { json: async () => next };
};

require('./harness').loadApp(window);

const tsDoc = (doc) => ({ data: { search: { results: { found: 1, hits: [{ document: doc }] } } } });
const tsDocs = (docs) => ({ data: { search: { results: { found: docs.length, hits: docs.map(d => ({ document: d })) } } } });
const tsEmpty = { data: { search: { results: { found: 0, hits: [] } } } };

const onyxDoc = {
  title: 'Onyx Storm', author_names: ['Rebecca Yarros'],
  rating: 3.94, ratings_count: 1361,
  content_warnings: ['Sexual content', 'War', 'Violence'],
  moods: ['dark', 'tense', 'emotional'],
  genres: ['Fantasy', 'Romantasy', 'Romance'],
  series_names: ['The Empyrean'],
  featured_series: { position: 3.0, details: '3', series: { name: 'The Empyrean' } },
  isbns: ['0349437068', '9780349437064'],
  description: 'A dragon rider fantasy.',
  slug: 'onyx-storm', release_year: 2025, pages: 527,
};

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  // 1. No token -> no fetch, returns false
  delete window.SPICY_CONFIG;
  fetchCalls.length = 0;
  const r0 = await window.enrichHardcover({ title: 'X', authors: ['Y'], categories: [] });
  ok('no token: returns false without network', r0 === false && fetchCalls.length === 0);

  // 2. ISBN match path
  window.SPICY_CONFIG = { hardcover: true };
  responseQueue = [tsDoc(onyxDoc)];
  const book = { id: 'b1', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '9780349437064', categories: [], tropes: [], ratings: {}, axes: [] };
  const r1 = await window.enrichHardcover(book);
  ok('ISBN match: enriched', r1 === true);
  ok('series name + position', book.series && book.series.name === 'The Empyrean' && book.series.position === 3);
  ok('content warnings', Array.isArray(book.contentWarnings) && book.contentWarnings.includes('War') && book.contentWarnings.length === 3);
  ok('moods capped', book.moods.length === 3 && book.moods.includes('dark'));
  ok('genres merged into categories', book.categories.includes('Romantasy') && book.categories.includes('Fantasy'));
  ok('no duplicate categories on re-merge', book.categories.filter(c => c === 'Fantasy').length === 1);
  ok('rating set from Hardcover', book.publicRating === 3.9 && book.ratingsCount === 1361);
  ok('description filled when empty', book.description === 'A dragon rider fantasy.');
  ok('hcEnriched flag set', book.hcEnriched === true);
  ok('no token leaves the browser', !fetchCalls[0].opts.headers['Authorization']);
  ok('query sent in POST body', JSON.parse(fetchCalls[0].opts.body).query.indexOf('search') !== -1);
  ok('POST to same-origin proxy', fetchCalls[0].url === '/api/hardcover');

  // 3. Already enriched -> skipped
  fetchCalls.length = 0;
  const r2 = await window.enrichHardcover(book);
  ok('already enriched: skipped', r2 === false && fetchCalls.length === 0);

  // 4. Title fallback when no ISBN
  responseQueue = [tsDoc(Object.assign({}, onyxDoc, { isbns: ['999'] }))];
  const book2 = { id: 'b2', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const r3 = await window.enrichHardcover(book2);
  ok('title fallback: enriched', r3 === true && book2.series.name === 'The Empyrean');

  // 5. Wrong book in ISBN results -> falls through to title search, then no match
  responseQueue = [tsDoc(Object.assign({}, onyxDoc, { title: 'Iron Flame', isbns: ['111'] })), tsEmpty];
  const book3 = { id: 'b3', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '9780349437064', categories: [], tropes: [], ratings: {}, axes: [] };
  const r4 = await window.enrichHardcover(book3);
  ok('ISBN mismatch not blindly applied', r4 === false && !book3.hcEnriched && book3.series === undefined);

  // 6. GraphQL error -> false, no crash
  responseQueue = [{ errors: [{ message: 'bad token' }] }];
  const book4 = { id: 'b4', title: 'Dune', authors: ['Frank Herbert'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const r5 = await window.enrichHardcover(book4);
  ok('API error handled', r5 === false && !book4.hcEnriched);

  // 7. Rating merge with existing Google/OL rating
  responseQueue = [tsDoc(onyxDoc)];
  const book5 = { id: 'b5', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '9780349437064', categories: [], tropes: [], ratings: {}, axes: [], publicRating: 4.5, ratingsCount: 100 };
  await window.enrichHardcover(book5);
  const expected = Math.round(((4.5 * 100 + 3.94 * 1361) / 1461) * 10) / 10;
  ok('rating weighted-merged', book5.publicRating === expected && book5.ratingsCount === 1461);

  // 8. Existing description not clobbered
  responseQueue = [tsDoc(onyxDoc)];
  const book6 = { id: 'b6', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '9780349437064', categories: [], tropes: [], ratings: {}, axes: [], description: 'Original desc' };
  await window.enrichHardcover(book6);
  ok('existing description kept', book6.description === 'Original desc');

  // 9. migrateBook adds new fields to legacy books
  const legacy = window.migrateBook({ title: 'Old', ratings: {} });
  ok('migrateBook new fields', Array.isArray(legacy.contentWarnings) && Array.isArray(legacy.moods) && legacy.series === null);

  // 10. hcDetailHTML renders + escapes (v133: series lives outside this block;
  // Variant A movement: in the header-zone strip — seriesStripHTML carries it)
  const htmlOut = window.hcDetailHTML({ series: { name: 'The Empyrean', position: 3 }, moods: ['dark'], contentWarnings: ['War', '<img src=x onerror=alert(1)>'] });
  ok('detail html: series moved to the strip', !htmlOut.includes('The Empyrean') && !!window.seriesStripHTML({ series: { name: 'The Empyrean', position: 3 }, id: 'x' }, 'x').includes('The Empyrean'));
  ok('detail html: moods', htmlOut.includes('mood-chip') && htmlOut.includes('dark'));
  ok('detail html: warnings collapsible', htmlOut.includes('<details') && htmlOut.includes('Content warnings (2)'));
  ok('detail html: escaped', !htmlOut.includes('<img src=x') && htmlOut.includes('&lt;img'));
  ok('detail html: empty book -> empty', window.hcDetailHTML({}) === '');

  // ---- v516 (#132): title-fallback acceptance --------------------------------
  // The fallback used to accept any doc sharing the book's first 12 title
  // characters. These pin the tightened matcher: prefix collisions rejected,
  // genuine title/author/ISBN proofs accepted.
  const housemaidDoc = {
    title: 'The Housemaid', author_names: ['Freida McFadden'],
    content_warnings: ['Violence', 'Murder'], moods: ['tense', 'dark'],
    genres: ['Thriller'], series_names: ['The Housemaid'],
    featured_series: { position: 1, details: '1', series: { name: 'The Housemaid' } },
    isbns: ['9781538742573'], description: 'Book one.', pages: 336,
  };
  const secretDoc = Object.assign({}, housemaidDoc, {
    title: "The Housemaid's Secret",
    content_warnings: ['Gaslighting'],
    featured_series: { position: 2, details: '2', series: { name: 'The Housemaid' } },
    isbns: ['9781538742580'],
  });

  // 11. The #132 repro: same author, title is a 12-char prefix collision.
  responseQueue = [tsDoc(secretDoc)];
  const hm1 = { id: 'h1', title: 'The Housemaid', authors: ['Freida McFadden'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const rHm1 = await window.enrichHardcover(hm1);
  ok('#132: prefix-collision doc rejected', rHm1 === false && !hm1.hcEnriched);
  ok('#132: wrong book warnings not applied', hm1.contentWarnings === undefined && hm1.series === undefined);

  // 12. The colliding doc ranks first, the real one second -> real one wins.
  responseQueue = [tsDocs([secretDoc, housemaidDoc])];
  const hm2 = { id: 'h2', title: 'The Housemaid', authors: ['Freida McFadden'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const rHm2 = await window.enrichHardcover(hm2);
  ok('#132: exact doc picked over collision', rHm2 === true && hm2.series && hm2.series.position === 1);
  ok('#132: warnings come from the matched doc', Array.isArray(hm2.contentWarnings) && hm2.contentWarnings.includes('Murder') && !hm2.contentWarnings.includes('Gaslighting'));

  // 13. Reverse direction: the sequel must not pick up book one's data either.
  responseQueue = [tsDoc(housemaidDoc)];
  const hm3 = { id: 'h3', title: "The Housemaid's Secret", authors: ['Freida McFadden'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const rHm3 = await window.enrichHardcover(hm3);
  ok('#132: shorter prefix doc rejected for the sequel', rHm3 === false && !hm3.hcEnriched);

  // 14. Subtitle carried by the library title only -> main-title match accepted.
  responseQueue = [tsDoc(housemaidDoc)];
  const hm4 = { id: 'h4', title: 'The Housemaid: A Novel', authors: ['Freida McFadden'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const rHm4 = await window.enrichHardcover(hm4);
  ok('fallback: one-sided subtitle accepted', rHm4 === true && hm4.series && hm4.series.position === 1);

  // 15. Series parenthetical on the library title -> normalized match accepted.
  responseQueue = [tsDoc(onyxDoc)];
  const bk15 = { id: 'h5', title: 'Onyx Storm (The Empyrean, #3)', authors: ['Rebecca Yarros'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const r15 = await window.enrichHardcover(bk15);
  ok('fallback: series parenthetical accepted', r15 === true && bk15.series && bk15.series.name === 'The Empyrean');

  // 16. Full title matches but the author is a different person -> rejected.
  responseQueue = [tsDoc(onyxDoc)];
  const bk16 = { id: 'h6', title: 'Onyx Storm', authors: ['Somebody Else'], isbn: '', categories: [], tropes: [], ratings: {}, axes: [] };
  const r16 = await window.enrichHardcover(bk16);
  ok('fallback: author mismatch rejected', r16 === false && !bk16.hcEnriched);

  // 17. ISBN search missed; title doc's title form would NOT match, but its
  // isbns[] list the book's ISBN-10 (book carries the 13) -> ISBN proof wins.
  responseQueue = [tsEmpty, tsDoc(Object.assign({}, onyxDoc, { title: 'Onyx Storm — Special Edition', isbns: ['0349437068'] }))];
  const bk17 = { id: 'h7', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '9780349437064', categories: [], tropes: [], ratings: {}, axes: [] };
  const r17 = await window.enrichHardcover(bk17);
  ok('fallback: isbns[] proof accepted (10<->13)', r17 === true && bk17.series && bk17.series.name === 'The Empyrean');

  // 18. Edition variant: book ISBN not in the doc's isbns[] at all, but full
  // title + author agree -> accepted (an ISBN mismatch never vetoes).
  responseQueue = [tsEmpty, tsDoc(Object.assign({}, onyxDoc, { isbns: ['0000000000'] }))];
  const bk18 = { id: 'h8', title: 'Onyx Storm', authors: ['Rebecca Yarros'], isbn: '9780349437064', categories: [], tropes: [], ratings: {}, axes: [] };
  const r18 = await window.enrichHardcover(bk18);
  ok('fallback: different-edition ISBN does not veto title+author', r18 === true && bk18.hcEnriched === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
