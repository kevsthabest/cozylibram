// Auto new-release checks (v149): weekly silent sweep, Discover badge, unseen semantics.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

const FUTURE = '2099-06-01';
const hcPayload = { data: { books: [
  { id: 42, title: 'Future Book One', description: '', release_date: FUTURE, pages: 300,
    image: { url: '' }, contributions: [{ author: { name: 'Jane Doe' } }],
    default_physical_edition: { isbn_13: null } }
] } };

let hcCalls = 0;
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/hardcover')) { hcCalls++; return { status: 200, json: async () => hcPayload }; }
  throw new Error('unexpected fetch: ' + u);
};

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = () => new Promise(r => setTimeout(r, 20));
const mk = (id, title) =>
  `({ id: '${id}', isbn: '', title: '${title}', authors: ['Jane Doe'], cover: '', ` +
  `description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, ` +
  `status: 'read', owned: 'owned', ratings: {}, axes: ['spice'], myRating: 5, tropes: [], progress: 0, ` +
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, ` +
  `series: null, log: [], _mtime: 0 })`;
const cand = (hcId, title) =>
  `({ hcId: ${hcId}, title: '${title}', authors: ['Jane Doe'], releaseDate: '2099-01-01', ` +
  `cover: '', description: '', pages: 300, isbns: [] })`;

(async () => {
  runInWindow(`localStorage.clear(); window.SPICY_CONFIG = { hardcover: true };
    library.push(${mk('d1', 'Owned Book')});`);

  // 1. save -> unseen -> badge shows
  runInWindow(`saveAutoReleases([${cand(7, 'Fresh Find')}]); updateReleaseBadge();`);
  await tick();
  ok('unseen list holds the cached find', runInWindowRet('unseenReleaseList().length') === 1);
  ok('badge visible with count', q('#nav-rel-badge').style.display !== 'none' && q('#nav-rel-badge').textContent === '1');

  // 2. markReleasesSeen clears
  runInWindow(`markReleasesSeen();`);
  await tick();
  ok('seen clears unseen list', runInWindowRet('unseenReleaseList().length') === 0);
  ok('badge hidden after seen', q('#nav-rel-badge').style.display === 'none');

  // 3. dismissed finds are filtered
  runInWindow(`saveAutoReleases([${cand(7, 'Fresh Find')}]); dismissRelease(7);`);
  await tick();
  ok('dismissed find excluded', runInWindowRet('unseenReleaseList().length') === 0);

  // 4. already-shelved finds are filtered
  runInWindow(`saveAutoReleases([${cand(8, 'Owned Book')}]);`);
  await tick();
  ok('shelved find excluded', runInWindowRet('unseenReleaseList().length') === 0);

  // 5. fresh cache -> no sweep
  hcCalls = 0;
  runInWindow(`saveAutoReleases([${cand(9, 'Another Find')}]);`);
  await runInWindow(`maybeAutoReleaseCheck()`);
  await tick(); await tick();
  ok('fresh cache skips the sweep', hcCalls === 0);

  // 6. stale cache -> silent sweep, cache saved, badge raised
  runInWindow(`localStorage.setItem('spicyshelves.auto_releases',
    JSON.stringify({ at: Date.now() - 8 * 864e5, list: [] }));
    localStorage.removeItem('spicyshelves.auto_releases_seen');`);
  hcCalls = 0;
  await runInWindow(`maybeAutoReleaseCheck()`);
  await new Promise(r => setTimeout(r, 1200)); // one author x 700ms pacing + margin
  ok('stale cache triggers one sweep', hcCalls === 1);
  ok('sweep caches the find', runInWindowRet(`(autoReleases() || {}).list.length`) === 1);
  ok('sweep raises the badge', q('#nav-rel-badge').style.display !== 'none' &&
    q('#nav-rel-badge').textContent === '1');

  // 7. renderUnseenReleases shows them and clears the badge
  runInWindow(`document.getElementById('view').innerHTML = '<div id="release-results"></div>';
    renderUnseenReleases();`);
  await tick();
  ok('cached finds render into #release-results', q('#release-results').textContent.includes('Future Book One'));
  ok('viewing clears the badge', q('#nav-rel-badge').style.display === 'none');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function runInWindowRet(js) {
  // synchronous read-back via a thrown-free eval in the window
  const s = window.document.createElement('script');
  s.textContent = `window.__ret = (function(){ return (${js}); })();`;
  window.document.body.appendChild(s);
  return window.__ret;
}
