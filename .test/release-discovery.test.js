// New-release discovery (v114): author ranking, Hardcover sweep filtering,
// dedup, dismissals, one-tap add, and the today-release fix.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const isoIn = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const DOCS = {
  'Ann Author': [
    { id: 1, title: 'Future Book', author_names: ['Ann Author'], release_date: isoIn(30), isbns: ['9780000000001'], image: { url: '' }, description: '', pages: 300 },
    { id: 2, title: 'Old Book', author_names: ['Ann Author'], release_date: isoIn(-10), isbns: [] },
    { id: 3, title: 'Wrong Author Book', author_names: ['Somebody Else'], release_date: isoIn(40), isbns: [] },
    { id: 4, title: 'Already Have', author_names: ['Ann Author'], release_date: isoIn(50), isbns: ['9781111111111'] },
    { id: 5, title: 'Dismissed', author_names: ['Ann Author'], release_date: isoIn(60), isbns: [] },
  ],
  'Zed': [
    { id: 6, title: 'Zed Future', author_names: ['Zed'], release_date: isoIn(5), isbns: [] },
  ],
};
window.fetch = async (url, opts) => {
  const q = JSON.parse(opts.body).query;
  const name = (q.match(/search\(query: "([^"]+)"/) || [])[1];
  const docs = DOCS[name] || [];
  return { status: 200, json: async () => ({ data: { search: { results: { hits: docs.map(d => ({ document: d })) } } } }) };
};

runInWindow(`
  window.SPICY_CONFIG = { hardcover: 'test-token' };
  localStorage.removeItem('spicyshelves.dismissed_releases');
  library = [
    { id: 'a1', title: 'Ann One', authors: ['Ann Author'], status: 'read', owned: true, cover: '', tropes: [], myRating: 5, isbn: '9781111111111' },
    { id: 'a2', title: 'Already Have', authors: ['Ann Author'], status: 'tbr', owned: false, cover: '', tropes: [], myRating: 4 },
    { id: 'z1', title: 'Zed One', authors: ['Zed'], status: 'read', owned: true, cover: '', tropes: [], myRating: 0 },
  ];
  dismissRelease(5);
`);

ok('authors ranked by shelf count then rating',
  JSON.stringify(window.topReleaseAuthors(8)) === JSON.stringify(['Ann Author', 'Zed']));

(async () => {
  const list = await window.checkNewReleases();
  ok('only genuine future releases from her authors survive',
    list.length === 2 && list[0].title === 'Zed Future' && list[1].title === 'Future Book');
  ok('results sorted by release date', list[0].releaseDate === isoIn(5));

  // one-tap add
  runInWindow(`view = 'library';`);
  const added = window.addReleaseBook(list[1]);
  runInWindow(`window.__inLib = library.find(b => b.title === 'Future Book') || null;`);
  const inLib = window.__inLib;
  ok('add lands an unowned TBR book with the release date',
    !!added && !!inLib && inLib.owned === false && inLib.status === 'tbr' && inLib.releaseDate === isoIn(30));
  ok('added book carries the Hardcover id and skips re-enrichment',
    inLib.hcId === 1 && inLib.hcEnriched === true);

  // dismissals
  ok('dismiss round-trips', window.isReleaseDismissed(5) === true && window.isReleaseDismissed(6) === false);

  // wishlist: check button + today-release fix
  runInWindow(`
    library.push({ id: 't1', title: 'Today Book', authors: ['Ann Author'], status: 'tbr',
      owned: false, cover: '', tropes: [], releaseDate: '${isoIn(0)}', dateAdded: '2026-01-01T00:00:00.000Z' });
    view = 'wishlist'; renderWishlist();
  `);
  ok('check-for-new-releases button rendered', !!window.document.getElementById('rel-check'));
  const pills = [...window.document.querySelectorAll('.up-pill')].map(p => p.textContent);
  ok('a book releasing today counts as upcoming', pills.some(p => /today/.test(p)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
