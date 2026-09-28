// v150: adding books no longer resets the page — the Add -> Search query,
// results, and added-state survive re-renders, and the new-release lists
// survive adding one of their books.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

const olDocs = [
  { title: 'Author Book One', author_name: ['Jane Doe'], isbn: ['9781111111111'], cover_i: 111 },
  { title: 'Author Book Two', author_name: ['Jane Doe'], isbn: ['9782222222222'] },
];
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('openlibrary.org/search.json')) return { json: async () => ({ docs: olDocs }) };
  if (u.includes('openlibrary.org')) return { json: async () => ({}) }; // work/edition lookups
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
const runInWindowRet = (js) => {
  const s = window.document.createElement('script');
  s.textContent = `window.__ret = (function(){ return (${js}); })();`;
  window.document.body.appendChild(s);
  return window.__ret;
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

(async () => {
  runInWindow(`localStorage.clear(); searchSource = 'openlibrary'; addTab = 'search'; go('add');`);
  await tick();

  // search for the author
  runInWindow(`document.getElementById('s-q').value = 'jane doe'; document.getElementById('s-go').click();`);
  await tick(120);
  ok('search paints two results', qa('#s-results .book-card').length === 2);

  // add the first book — the page must not reset
  qa('#s-results .book-card')[0].click();
  await tick(150);
  ok('query survives the add', q('#s-q') && q('#s-q').value === 'jane doe');
  ok('results survive the add', qa('#s-results .book-card').length === 2);
  ok('added book shows a check', qa('#s-results .book-card')[0].textContent.includes('✓'));
  ok('book landed in the library',
    runInWindowRet(`library.filter(b => b.title === 'Author Book One').length`) === 1);

  // add the second book with no re-search
  qa('#s-results .book-card')[1].click();
  await tick(150);
  ok('second add keeps both results', qa('#s-results .book-card').length === 2);
  ok('both show a check', qa('#s-results .book-card').every(c => c.textContent.includes('✓')));
  ok('no duplicate library entries',
    runInWindowRet(`library.filter(b => b.title === 'Author Book Two').length`) === 1);

  // switching tabs and back restores the search
  runInWindow(`addTab = 'isbn'; renderAdd(); addTab = 'search'; renderAdd();`);
  await tick();
  ok('query restored after tab switch', q('#s-q').value === 'jane doe');
  ok('results restored after tab switch', qa('#s-results .book-card').length === 2);
  ok('added state restored after tab switch',
    qa('#s-results .book-card').every(c => c.textContent.includes('✓')));

  // new-release list survives adding one of its books
  runInWindow(`visibleReleases = [
    { hcId: 51, title: 'Rel One', authors: ['Jane Doe'], releaseDate: '2099-02-01',
      cover: '', description: '', pages: 200, isbns: [] },
    { hcId: 52, title: 'Rel Two', authors: ['Jane Doe'], releaseDate: '2099-03-01',
      cover: '', description: '', pages: 200, isbns: [] }
  ]; go('discover');`);
  await tick();
  ok('release finds render', qa('#release-results .rel-card').length === 2);
  qa('#release-results [data-add]')[0].click();
  await tick(150);
  ok('release list survives the add', qa('#release-results .rel-card').length === 1);
  ok('the remaining find is the other book', q('#release-results').textContent.includes('Rel Two'));
  ok('added release is in the library',
    runInWindowRet(`library.filter(b => b.title === 'Rel One').length`) === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
