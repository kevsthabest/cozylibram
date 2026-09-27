// Hardcover library import tests (v103): status mapping, entry → raw book
// conversion, ISBN selection, pagination, and the slim-query depth fallback.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in hcimport tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const entry = (over) => Object.assign({
  status_id: 3, rating: 4, date_added: '2024-01-15T00:00:00Z',
  book: {
    title: 'Fourth Wing', pages: 512,
    image: { url: 'https://img.example/fourthwing.jpg' },
    contributions: [{ author: { name: 'Rebecca Yarros' } }],
    editions: [{ isbn_13: '978-1-64352-830-4', isbn_10: '1643528305' }],
  },
  edition: { isbn_13: '9781643528304', isbn_10: '1643528305', pages: 528 },
  user_book_reads: [{ started_at: '2024-01-10T00:00:00Z', finished_at: '2024-01-20T00:00:00Z' }],
}, over);

// --- status mapping ---
ok('status 1 (Want to Read) → tbr',
  window.hcEntryToRaw(entry({ status_id: 1 })).status === 'tbr');
ok('status 2 (Currently Reading) → reading',
  window.hcEntryToRaw(entry({ status_id: 2 })).status === 'reading');
ok('status 3 (Read) → read',
  window.hcEntryToRaw(entry({ status_id: 3 })).status === 'read');
ok('status 4 (Paused) → reading',
  window.hcEntryToRaw(entry({ status_id: 4 })).status === 'reading');
ok('status 5 (DNF) → dnf',
  window.hcEntryToRaw(entry({ status_id: 5 })).status === 'dnf');
ok('status 6 (Ignored) → skipped (null)',
  window.hcEntryToRaw(entry({ status_id: 6 })) === null);
ok('unknown status → skipped (null)',
  window.hcEntryToRaw(entry({ status_id: 99 })) === null);

// --- field conversion ---
const r = window.hcEntryToRaw(entry({}));
ok('title carried over', r.title === 'Fourth Wing');
ok('authors extracted from contributions', r.authors.length === 1 && r.authors[0] === 'Rebecca Yarros');
ok('edition isbn_13 preferred, normalized', r.isbn === '9781643528304');
ok('cover from book image', r.cover === 'https://img.example/fourthwing.jpg');
ok('pageCount prefers user edition pages', r.pageCount === 528);
ok('rating passed through', r.myRating === 4);
ok('dateFinished from latest finished read', r.dateFinished === '2024-01-20T00:00:00Z');
ok('dateAdded carried over', r.dateAdded === '2024-01-15T00:00:00Z');
ok('hcImported flag set', r.hcImported === true);

ok('falls back to edition isbn_10',
  window.hcEntryToRaw(entry({ edition: { isbn_13: '', isbn_10: '1643528305', pages: 0 } })).isbn === '1643528305');
ok('falls back to book editions list when no user edition',
  window.hcEntryToRaw(entry({ edition: null })).isbn === '9781643528304');
ok('empty isbn when nothing available',
  window.hcEntryToRaw(entry({ edition: null, book: { title: 'X', editions: [] } })).isbn === '');
ok('pageCount falls back to book pages',
  window.hcEntryToRaw(entry({ edition: { isbn_13: '', isbn_10: '', pages: 0 } })).pageCount === 512);
ok('rating rounds halves', window.hcEntryToRaw(entry({ rating: 4.5 })).myRating === 5);
ok('rating clamps high', window.hcEntryToRaw(entry({ rating: 9 })).myRating === 5);
ok('rating clamps low / null', window.hcEntryToRaw(entry({ rating: null })).myRating === 0);
ok('no finished_at → null dateFinished',
  window.hcEntryToRaw(entry({ user_book_reads: [{ started_at: '2024-01-10T00:00:00Z', finished_at: null }] })).dateFinished === null);
ok('missing book → empty title (skipped later by importForeignBooks)',
  window.hcEntryToRaw(entry({ book: null })).title === '');

// --- query builder ---
const q0 = window.hcUserBooksQuery(0, false);
ok('query requests 100/page starting at offset 0',
  q0.includes('limit: 100') && q0.includes('offset: 0'));
ok('full query includes editions and user_book_reads',
  q0.includes('editions(') && q0.includes('user_book_reads'));
const q1 = window.hcUserBooksQuery(100, false);
ok('offset 100 in second page query', q1.includes('offset: 100'));
const qs = window.hcUserBooksQuery(0, true);
ok('slim query drops editions and reads',
  !qs.includes('editions(') && !qs.includes('user_book_reads'));

// --- pagination (async) ---
(async () => {
  const mkPage = (n, start) => Array.from({ length: n }, (_, i) => ({ status_id: 3, id: start + i }));
  const seen = [];
  const fake = async (query) => {
    seen.push(query);
    const m = /offset: (\d+)/.exec(query);
    const off = m ? parseInt(m[1], 10) : 0;
    const n = off === 0 ? 100 : 37; // first page full, second partial → stop
    return { me: { user_books: mkPage(n, off) } };
  };
  const books = await window.hcFetchUserBooks(fake, 'tok', null);
  ok('paginates until a short page (100 + 37)', books.length === 137);
  ok('offsets advance correctly', seen.length === 2 && /offset: 100/.test(seen[1]));

  let progCalls = [];
  await window.hcFetchUserBooks(fake, 'tok', (n) => progCalls.push(n));
  ok('onProgress reports cumulative counts', progCalls.join(',') === '100,137');

  // empty library → single call
  const empty = await window.hcFetchUserBooks(async () => ({ me: { user_books: [] } }), 'tok', null);
  ok('empty library returns empty array', empty.length === 0);

  // depth rejection → one slim retry
  let attempts = 0, lastQuery = '';
  const depthy = async (query) => {
    attempts++;
    lastQuery = query;
    if (query.includes('editions(')) throw new Error('Hardcover query too deep: blah');
    return { me: { user_books: [entry({})] } };
  };
  const slimmed = await window.hcFetchUserBooks(depthy, 'tok', null);
  ok('depth error triggers a slim retry', attempts === 2 && slimmed.length === 1);
  ok('retry used the slim query (no editions/read nesting)',
    !lastQuery.includes('editions(') && !lastQuery.includes('user_book_reads'));

  // non-depth errors propagate
  let threw = false;
  try { await window.hcFetchUserBooks(async () => { throw new Error('boom'); }, 'tok', null); }
  catch (e) { threw = e.message === 'boom'; }
  ok('non-depth errors propagate', threw);

  // token storage round-trip
  window.setHcUserToken('abc123');
  ok('token stored', window.getHcUserToken() === 'abc123');
  window.setHcUserToken('');
  ok('token cleared', window.getHcUserToken() === '');

  // hcValidateUserToken with a failing fetch surfaces a network error
  let vmsg = '';
  try { await window.hcValidateUserToken('x'); } catch (e) { vmsg = e.message; }
  ok('hcValidateUserToken surfaces fetch failure', /Network error/.test(vmsg));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
