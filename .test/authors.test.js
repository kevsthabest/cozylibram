// Authors tab (v43): author index, list view, and author detail with
// owned / wishlist / shaded-missing sections.
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
];
window.fetch = async (url) => {
  if (String(url).includes('openlibrary.org/search.json?author=')) return { json: async () => ({ docs: olDocs }) };
  throw new Error('unexpected fetch: ' + url);
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
const mk = (id, title, author, owned) =>
  `({ id: '${id}', isbn: '9780000000000', title: '${title}', authors: ${JSON.stringify(author)}, cover: '', ` +
  `description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, ` +
  `status: '${owned ? 'read' : 'tbr'}', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0, ` +
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, owned: ${owned}, ` +
  `series: null, log: [], _mtime: 0 })`;
const tick = (n = 2) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

(async () => {
  runInWindow(`localStorage.clear();
    library.push(${mk('a1', 'Owned Book', ['Jane Doe'], true)});
    library.push(${mk('a2', 'Wanted Book', ['Jane Doe'], false)});
    library.push(${mk('a3', 'Smith Book', ['John Smith'], true)});
    library.push(${mk('a4', 'Co-written', ['Jane Doe', 'John Smith'], true)});`);

  // index: dedupes, counts, only authors with >= 1 owned book, sorted A-Z
  const idx = window.eval(`authorIndex().map(e => e.name + ':' + e.owned.length + ':' + e.wanted.length).join('|')`);
  ok('authorIndex dedupes and counts', idx === 'Jane Doe:2:1|John Smith:2:0');

  // authors live under the Discover tab now (v121)
  runInWindow(`go('discover')`);
  ok('authors reachable from the Discover landing', !!q('#view [data-disc="authors"]'));

  // list view renders one row per author
  runInWindow(`renderAuthors()`);
  const rows = qa('[data-author]');
  ok('authors list renders one row per author', rows.length === 2);
  ok('author row shows owned count', rows[0].textContent.includes('2 owned'));

  // detail view: owned + wishlist sections
  runInWindow(`openAuthor('Jane Doe')`);
  await tick(4);
  ok('detail shows author name', q('#view').textContent.includes('Jane Doe'));
  ok('detail lists owned books', q('#view').textContent.includes('Owned Book') && q('#view').textContent.includes('Co-written'));
  ok('detail has wishlist section', q('#view').textContent.includes('On your wishlist') && q('#view').textContent.includes('Wanted Book'));

  // missing section: shaded rows for books not in the library
  const missing = qa('#a-missing .crow.missing');
  const missTitles = missing.map(m => m.querySelector('.ctext b').textContent);
  ok('missing books load shaded out', missing.length === 2 &&
    missTitles.includes('Missing Book One') && missTitles.includes('Missing Book Two'));
  ok('owned book excluded from missing', !missTitles.includes('Owned Book'));
  ok('missing rows carry a Not owned chip', qa('#a-missing .m-chip').length === 2);

  // + Wishlist adds the missing book as to-buy
  const before = window.eval(`library.length`);
  qa('#a-missing [data-madd]')[0].click();
  ok('wishlist button adds the missing book', window.eval(`library.length`) === before + 1 &&
    window.eval(`library[0].owned`) === false && window.eval(`library[0].status`) === 'tbr');
  ok('row marked as in wishlist after add', q('#a-missing .c-added') && q('#a-missing .c-added').textContent.includes('In wishlist'));

  // back button returns to the authors list
  q('#a-back').click();
  ok('back returns to authors list', qa('#view [data-author]').length === 2);

  // spelling variants merge: "H. D. Carlton" / "H D Carlton" / "H.D. Carlton"
  // and stray whitespace ("James Patterson " vs "James Patterson") are one author
  runInWindow(`localStorage.clear(); library.length = 0;
    library.push(${mk('c1', 'B1', ['H. D. Carlton'], true)});
    library.push(${mk('c2', 'B2', ['H D Carlton'], true)});
    library.push(${mk('c3', 'B3', ['H.D. Carlton'], true)});
    library.push(${mk('c4', 'B4', ['H. D. Carlton'], true)});
    library.push(${mk('c5', 'B5', ['James Patterson'], true)});
    library.push(${mk('c6', 'B6', ['James Patterson '], true)});`);
  const idx2 = window.eval(`authorIndex().map(e => e.name + ':' + e.owned.length).join('|')`);
  ok('punctuation variants merge into one author', idx2 === 'H. D. Carlton:4|James Patterson:2');
  runInWindow(`openAuthor('H D Carlton')`); // any variant opens the merged detail
  await tick(4);
  const detailText = q('#view').textContent;
  ok('merged detail lists every variant spelling\'s books',
    ['B1', 'B2', 'B3', 'B4'].every(t => detailText.includes(t)));
  ok('merged detail shows the most common spelling', detailText.includes('H. D. Carlton'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
