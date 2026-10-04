// Metadata check (v46): ISBN lookup, comparison, and fix application.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

// Mock network: Open Library ISBN search. Hardcover is stubbed per-test.
let olDocs = [];
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('openlibrary.org/search.json?isbn=')) return { ok: true, json: async () => ({ docs: olDocs }) };
  throw new Error('unexpected fetch: ' + u);
};

require('./harness').loadApp(window);
// Hardcover off by default — stubbed per test below.
window.hcSearchDocs = async () => [];

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const mk = (id, fields) =>
  `Object.assign({ id: '${id}', isbn: '', title: 'Unknown title', authors: [], cover: '', ` +
  `pageCount: null, publishedDate: '', owned: true, status: 'read', _mtime: 0 }, ${JSON.stringify(fields)})`;

(async () => {
  // --- normalization helpers
  ok('normTitle ignores series suffix', window.eval(`normTitle('Dune (Dune, #1)')`) === 'dune');
  ok('normTitle ignores case and punctuation', window.eval(`normTitle("The Hitchhiker's Guide")`) === 'the hitchhiker s guide');
  ok('parseYear pulls the year', window.eval(`parseYear('2021-03-04')`) === 2021);
  ok('parseYear handles year-only', window.eval(`parseYear('1997')`) === 1997);
  ok('parseYear returns null when absent', window.eval(`parseYear('')`) === null);
  ok('cleanISBN strips dashes', window.eval(`cleanISBN('978-0-06-112008-4')`) === '9780061120084');

  // --- comparison
  runInWindow(`var vb1 = ${mk('v1', { title: 'Dune', authors: ['Frank Herbert'], pageCount: 412, publishedDate: '1965', cover: 'c1' })};
    var vm1 = { title: 'Dune', authors: ['Frank Herbert'], pageCount: 412, year: 1965, cover: 'c1' };`);
  ok('identical metadata has no flags', window.eval(`compareBookMeta(vb1, vm1).length`) === 0);

  runInWindow(`var vb2 = ${mk('v2', { title: 'Dune (Dune, #1)', authors: ['H. D. Carlton'], pageCount: 0, publishedDate: '', cover: '' })};
    var vm2 = { title: 'Dune', authors: ['H D Carlton'], pageCount: 412, year: 1965, cover: 'http://x/y.jpg' };
    var vf2 = compareBookMeta(vb2, vm2);`);
  ok('series suffix and author punctuation do not flag', window.eval(`vf2.filter(f => f.field === 'title' || f.field === 'authors').length`) === 0);
  ok('missing page count is flagged as a fill', window.eval(`vf2.find(f => f.field === 'pageCount').to`) === '412');
  ok('missing cover is flagged', window.eval(`vf2.find(f => f.field === 'cover').to`) === 'Cover found');

  runInWindow(`var vb3 = ${mk('v3', { title: 'Dune Messiah', authors: ['Frank Herbert'], pageCount: 412, publishedDate: '1969' })};
    var vm3 = { title: 'Dune', authors: ['Brian Herbert'], pageCount: 300, year: 1965, cover: '' };
    var vf3 = compareBookMeta(vb3, vm3).map(f => f.field).join(',');`);
  ok('real differences are all flagged', window.eval(`vf3`) === 'title,authors,pageCount,year');

  // --- fetchMetaByISBN: Hardcover first (v270), then Open Library
  window.hcSearchDocs = async () => [{
    title: 'HC Title', author_names: ['HC Author'], pages: 250,
    release_date: '2020-05-01', image: { url: 'https://example.com/hc.jpg' },
    isbns: ['9781234567890']
  }];
  const m0 = await window.eval(`fetchMetaByISBN('9781234567890')`);
  ok('HC hit maps all fields', m0 && m0.title === 'HC Title' && m0.authors[0] === 'HC Author' &&
    m0.pageCount === 250 && m0.year === 2020 && m0.cover === 'https://example.com/hc.jpg');
  window.hcSearchDocs = async () => [];

  // HC doc that doesn't list the ISBN is skipped; Open Library is used
  window.hcSearchDocs = async () => [{ title: 'Wrong Book', isbns: ['9780000000000'] }];
  olDocs = [{
    title: 'OL Title', author_name: ['OL Author'], isbn: ['9781234567890'],
    number_of_pages_median: 100, first_publish_year: 2001, cover_i: 5
  }];
  const m0b = await window.eval(`fetchMetaByISBN('9781234567890')`);
  ok('HC near-miss ISBN falls through to OL', m0b && m0b.title === 'OL Title');
  window.hcSearchDocs = async () => [];

  // --- fetchMetaByISBN: Open Library exact-ISBN match
  olDocs = [{
    title: 'To Kill a Mockingbird', author_name: ['Harper Lee'],
    isbn: ['9780061120084', '0061120084'], number_of_pages_median: 320,
    first_publish_year: 1960, cover_i: 14351077
  }];
  gbItems = [];
  const m1 = await window.eval(`fetchMetaByISBN('978-0-06-112008-4')`);
  ok('OL hit maps all fields', m1 && m1.title === 'To Kill a Mockingbird' &&
    m1.authors[0] === 'Harper Lee' && m1.pageCount === 320 && m1.year === 1960 &&
    m1.cover === 'https://covers.openlibrary.org/b/id/14351077-L.jpg');

  // OL docs that don't list the ISBN are skipped; nothing else to try → null
  olDocs = [{ title: 'Wrong Edition', author_name: ['Someone'], isbn: ['9780000000000'] }];
  const m2 = await window.eval(`fetchMetaByISBN('9781234567890')`);
  ok('OL miss with no other source returns null', m2 === null);

  // nothing anywhere → null
  olDocs = [];
  ok('no match returns null', await window.eval(`fetchMetaByISBN('9789999999999')`) === null);

  // --- end-to-end: checkLibraryMetadata + applyVerifyFix
  olDocs = [{
    title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441172719'],
    number_of_pages_median: 412, first_publish_year: 1965, cover_i: 99
  }];
  runInWindow(`localStorage.clear(); library.length = 0;
    library.push(${mk('e1', { isbn: '9780441172719', title: 'Dune (Dune, #1)', authors: ['Frank Herbert'], pageCount: 412, publishedDate: '1965', cover: 'c' })});
    library.push(${mk('e2', { isbn: '9780441172719', title: 'Dune Messed Up', authors: ['Frank Herbert'], pageCount: 100, publishedDate: '1999', cover: '' })});
    library.push(${mk('e3', { isbn: '', title: 'No ISBN Book', authors: ['Anon'] })});`);
  const out = await window.eval(`checkLibraryMetadata(0)`);
  ok('check skips books without ISBN', out.checked === 2);
  ok('only differing books are reported', out.results.length === 1 && out.results[0].book.id === 'e2');
  ok('e2 flags title, pages, year, cover',
    out.results[0].flags.map(f => f.field).sort().join(',') === 'cover,pageCount,title,year');

  // v216: applyVerifyFix is async (adopted covers go through the canonical
  // bucket, falling back to the remote URL when the function is unreachable)
  await window.eval(`applyVerifyFix(library[1], ${JSON.stringify(out.results[0].meta)}, ${JSON.stringify(out.results[0].flags)})`);
  const fixed = window.eval(`({ title: library[1].title, pageCount: library[1].pageCount, publishedDate: library[1].publishedDate, cover: library[1].cover })`);
  ok('applyVerifyFix writes every flagged field',
    fixed.title === 'Dune' && fixed.pageCount === 412 && fixed.publishedDate === '1965' &&
    fixed.cover === 'https://covers.openlibrary.org/b/id/99-L.jpg');
  ok('fix persists to localStorage',
    window.eval(`JSON.parse(localStorage.getItem(libKey())).find(b => b.id === 'e2').title`) === 'Dune');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
