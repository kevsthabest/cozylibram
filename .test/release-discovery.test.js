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

const gb = (id, title, author, relIn, extra) => Object.assign({
  id, title, contributions: [{ author: { name: author } }],
  release_date: isoIn(relIn), description: '', pages: 300,
  image: { url: '' }, default_physical_edition: { isbn_13: null },
}, extra || {});
const DOCS = {
  'Ann Author': [
    gb(1, 'Future Book', 'Ann Author', 30, { default_physical_edition: { isbn_13: '9780000000001' } }),
    gb(2, 'Old Book', 'Ann Author', -10), // server-side _gt filter drops this
    gb(4, 'Already Have', 'Ann Author', 50, { default_physical_edition: { isbn_13: '9781111111111' } }),
    gb(5, 'Dismissed', 'Ann Author', 60),
  ],
  'Zed': [
    gb(6, 'Zed Future', 'Zed', 5),
  ],
};
window.fetch = async (url, opts) => {
  const q = JSON.parse(opts.body).query;
  window.__lastQuery = q;
  const name = (q.match(/name: \{_eq: "([^"]+)"\}/) || [])[1];
  const today = isoIn(0);
  // mimic the server: only future-dated books come back
  const books = (DOCS[name] || []).filter(b => b.release_date > today);
  return { status: 200, json: async () => ({ data: { books } }) };
};

runInWindow(`
  window.SPICY_CONFIG = { hardcover: 'test-token' };
  localStorage.removeItem('spicyshelves.dismissed_releases');
  library = [
    { id: 'a1', title: 'Ann One', authors: ['Ann Author'], status: 'read', owned: 'owned', cover: '', tropes: [], myRating: 5, isbn: '9781111111111' },
    { id: 'a2', title: 'Already Have', authors: ['Ann Author'], status: 'tbr', owned: 'tobuy', cover: '', tropes: [], myRating: 4 },
    { id: 'z1', title: 'Zed One', authors: ['Zed'], status: 'read', owned: 'owned', cover: '', tropes: [], myRating: 0 },
  ];
  dismissRelease(5);
`);

ok('authors ranked by shelf count then rating',
  JSON.stringify(window.topReleaseAuthors(8)) === JSON.stringify(['Ann Author', 'Zed']));

(async () => {
  const res = await window.checkNewReleases();
  const list = res.list;
  ok('only genuine future releases from her authors survive',
    list.length === 2 && list[0].title === 'Zed Future' && list[1].title === 'Future Book');
  ok('results sorted by release date', list[0].releaseDate === isoIn(5));
  ok('query asks Hardcover for future-dated books by the author',
    /release_date/.test(window.__lastQuery) && /_gt/.test(window.__lastQuery) &&
    /contributions/.test(window.__lastQuery) && /order_by: \{release_date: asc\}/.test(window.__lastQuery));
  ok('no author lookups failed', res.failed === 0 && res.total === 2);
  ok('candidates carry authors from contributions and the physical ISBN',
    list[1].authors[0] === 'Ann Author' && list[1].isbns[0] === '9780000000001');

  // one-tap add
  runInWindow(`view = 'library';`);
  const added = window.addReleaseBook(list[1]);
  runInWindow(`window.__inLib = library.find(b => b.title === 'Future Book') || null;`);
  const inLib = window.__inLib;
  ok('add lands an unowned TBR book with the release date',
    !!added && !!inLib && inLib.owned === 'tobuy' && inLib.status === 'tbr' && inLib.releaseDate === isoIn(30));
  ok('added book carries the Hardcover id and skips re-enrichment',
    inLib.hcId === 1 && inLib.hcEnriched === true);

  // dismissals
  ok('dismiss round-trips', window.isReleaseDismissed(5) === true && window.isReleaseDismissed(6) === false);

  // wishlist: check button + today-release fix
  runInWindow(`
    library.push({ id: 't1', title: 'Today Book', authors: ['Ann Author'], status: 'tbr',
      owned: 'tobuy', cover: '', tropes: [], releaseDate: '${isoIn(0)}', dateAdded: '2026-01-01T00:00:00.000Z' });
    view = 'wishlist'; renderWishlist();
  `);
  ok('check-for-new-releases button rendered', !!window.document.getElementById('rel-check'));
  const pills = [...window.document.querySelectorAll('.up-pill')].map(p => p.textContent);
  ok('a book releasing today counts as upcoming', pills.some(p => /today/.test(p)));

  // v134/v175: the New Releases tile itself runs the check (it used to be a dead div)
  runInWindow(`
    view = 'discover'; renderDiscover();
    window.__realCheck = checkNewReleases;
    checkNewReleases = async () => ({ list: [{ hcId: 99, title: 'Card Book', authors: ['Ann Author'],
      releaseDate: '${isoIn(20)}', cover: '', description: '', pages: 100, isbns: [] }], failed: 0, total: 1 });
  `);
  const relCard = window.document.querySelector('[data-dtile="releases"]');
  ok('New Releases is a real tappable card', !!relCard && relCard.tagName === 'BUTTON');
  relCard.click();
  await new Promise(r => setTimeout(r, 300));
  ok('card click runs the check and renders results',
    !!window.document.querySelector('#release-results .rel-card') &&
    window.document.getElementById('release-results').textContent.includes('Card Book'));
  runInWindow(`checkNewReleases = window.__realCheck;`);
  // v135: when every author lookup fails, the sweep reports it honestly
  const realFetch = window.fetch;
  window.fetch = async () => { throw new Error('boom'); };
  const bad = await window.checkNewReleases();
  ok('total failure is counted, not mistaken for "caught up"',
    bad.list.length === 0 && bad.failed === bad.total && bad.total === 2);
  runInWindow(`view = 'discover'; renderDiscover();`);
  window.document.querySelector('[data-dtile="releases"]').click();
  await new Promise(r => setTimeout(r, 2500));
  ok('card shows an honest error when Hardcover is unreachable',
    /Couldn't reach Hardcover/.test(window.document.getElementById('release-results').textContent));
  window.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
