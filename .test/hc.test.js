// Mocked Hardcover integration tests. Fake token only — never a real one.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
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

  // 10. hcDetailHTML renders + escapes (v133: series lives in the inline block now)
  const htmlOut = window.hcDetailHTML({ series: { name: 'The Empyrean', position: 3 }, moods: ['dark'], contentWarnings: ['War', '<img src=x onerror=alert(1)>'] });
  ok('detail html: series moved inline', !htmlOut.includes('The Empyrean') && !!window.seriesInlineHTML({ series: { name: 'The Empyrean', position: 3 }, id: 'x' }, 'x').includes('The Empyrean'));
  ok('detail html: moods', htmlOut.includes('mood-chip') && htmlOut.includes('dark'));
  ok('detail html: warnings collapsible', htmlOut.includes('<details') && htmlOut.includes('Content warnings (2)'));
  ok('detail html: escaped', !htmlOut.includes('<img src=x') && htmlOut.includes('&lt;img'));
  ok('detail html: empty book -> empty', window.hcDetailHTML({}) === '');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
