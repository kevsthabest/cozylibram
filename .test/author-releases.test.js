// Author releases card on the Library home (v483).
// Covered: per-author grouping (case-insensitive, co-author dedupe), the
// 3-authors x 3-releases cap, card hidden with no finds, placement below
// Currently Reading, cache-only (no Hardcover sweep on render), dismiss
// collapses rows/cards, releaseAuthorStats counts + averages.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

let hcCalls = 0;
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/hardcover')) { hcCalls++; throw new Error('no sweep on card render'); }
  throw new Error('unexpected fetch: ' + u);
};

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; if (!cond) console.log('FAIL - ' + name); };
const run = (code) => window.eval(code);
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));

const seedLibrary = () => run(`localStorage.clear(); library = [
  { id: 'b1', title: 'R1', authors: ['Rebecca Yarros'], status: 'read', myRating: 5, tropes: [], genres: [] },
  { id: 'b2', title: 'R2', authors: ['Rebecca Yarros'], status: 'read', myRating: 4, tropes: [], genres: [] },
  { id: 'b3', title: 'S1', authors: ['Sarah J. Maas'], status: 'read', myRating: 5, tropes: [], genres: [] },
  { id: 'b4', title: 'N1', authors: ['No Rating'], status: 'read', myRating: 0, tropes: [], genres: [] },
  { id: 'b5', title: 'C1', authors: ['reading', 'x'], status: 'reading', myRating: 0, progress: 10, pageCount: 100, tropes: [], genres: [] },
  { id: 'b6', title: 'T1', authors: ['Rebecca Yarros'], status: 'tbr', myRating: 0, tropes: [], genres: [] },
  { id: 'b7', title: 'T2', authors: ['TBR Only'], status: 'tbr', myRating: 0, tropes: [], genres: [] }
]; filter = 'all'; ownFilter = 'all'; query = ''; view = 'library';`);

const cand = (hcId, title, authors, date) =>
  `({ hcId: ${hcId}, title: '${title}', authors: ${JSON.stringify(authors)}, releaseDate: '${date}', cover: '', description: '', pages: 300, isbns: [] })`;
const seedCache = (cands) => run(`saveAutoReleases([${cands.join(',')}]);`);

// --- 1. releaseAuthorStats: counts, averages, ranking ---
seedLibrary();
const stats = run(`releaseAuthorStats()`);
ok('stats ranked by read count', stats[0].name === 'Rebecca Yarros' && stats[0].n === 2);
ok('stats carry rating sums', stats[0].stars === 9 && stats[0].sn === 2);
ok('TBR books do not inflate the read count (b6 is tbr)', stats[0].n === 2);
ok('TBR-only authors excluded from stats', !stats.some(s => s.name === 'TBR Only'));

// --- 2. authorReleaseGroups: grouping, case-insensitivity, dedupe, caps ---
const groups = run(`authorReleaseGroups([
  ${cand(1, 'Onyx Storm', ['rebecca yarros'], '2027-01-21')},
  ${cand(2, 'Iron Flame', ['Rebecca Yarros'], '2027-03-04')},
  ${cand(3, 'Coauthored', ['Rebecca Yarros', 'Sarah J. Maas'], '2027-05-01')},
  ${cand(4, 'ACOTAR 6', ['Sarah J. Maas'], '2027-02-01')}
], releaseAuthorStats())`);
ok('two author groups', groups.length === 2);
ok('case-insensitive match', groups[0].name === 'Rebecca Yarros' && groups[0].releases.length === 3);
ok('co-authored release deduped under top author',
  groups[1].releases.length === 1 && groups[1].releases[0].title === 'ACOTAR 6');
ok('releases sorted by date', groups[0].releases[0].title === 'Onyx Storm');
ok('avg formatted', groups[0].avg === 4.5);

const capped = run(`authorReleaseGroups([
  ${cand(11, 'A1', ['Rebecca Yarros'], '2027-01-01')}, ${cand(12, 'A2', ['Rebecca Yarros'], '2027-01-02')},
  ${cand(13, 'A3', ['Rebecca Yarros'], '2027-01-03')}, ${cand(14, 'A4', ['Rebecca Yarros'], '2027-01-04')},
  ${cand(21, 'B1', ['Sarah J. Maas'], '2027-01-01')}, ${cand(22, 'B2', ['No Rating'], '2027-01-01')},
  ${cand(23, 'B3', ['Nobody'], '2027-01-01')}
], releaseAuthorStats())`);
ok('max 3 releases per author', capped[0].releases.length === 3);
ok('max 3 authors', capped.length === 3);
ok('unknown authors dropped', !capped.some(g => g.name === 'Nobody'));

// --- 3. card HTML: empty -> '', meta lines, extra count ---
ok('empty groups render nothing', run(`authorReleasesCardHTML([], [], 0)`) === '');
const html2 = run(`(function(){
  var g = [{ name: 'Solo', n: 1, avg: null, releases: [{ hcId: 99, title: 'Only', authors: ['Solo'], releaseDate: '2027-06-01', cover: '', description: '', pages: 0, isbns: [] }] }];
  var flat = []; g.forEach(function(x){ x.releases.forEach(function(c){ flat.push(c); }); });
  return authorReleasesCardHTML(g, flat, 0);
})()`);
ok('singular book read', html2.indexOf('1 book read') >= 0);
ok('no average when unrated', html2.indexOf('average') < 0);
const html3 = run(`(function(){
  var g = [{ name: 'Rebecca Yarros', n: 2, avg: 4.5, releases: [{ hcId: 98, title: 'X', authors: ['Rebecca Yarros'], releaseDate: '2027-06-01', cover: '', description: '', pages: 0, isbns: [] }] }];
  var flat = []; g.forEach(function(x){ x.releases.forEach(function(c){ flat.push(c); }); });
  return authorReleasesCardHTML(g, flat, 4);
})()`);
ok('meta line', html3.indexOf('2 books read · 4.5 average') >= 0);
ok('extra count link', html3.indexOf('4 more in Discover') >= 0);
const html4 = run(`(function(){
  var g = [{ name: 'Rebecca Yarros', n: 2, avg: 4.5, releases: [{ hcId: 98, title: 'X', authors: ['Rebecca Yarros'], releaseDate: '2027-06-01', cover: '', description: '', pages: 0, isbns: [] }] }];
  var flat = []; g.forEach(function(x){ x.releases.forEach(function(c){ flat.push(c); }); });
  return authorReleasesCardHTML(g, flat, 0);
})()`);
ok('no more-link when nothing extra', html4.indexOf('more in Discover') < 0);
ok('section title', html4.indexOf('New from authors you love') >= 0);

// --- 4. authorReleasesCard: cache-only, hidden when empty ---
seedLibrary();
seedCache([cand(1, 'Onyx Storm', ['Rebecca Yarros'], '2027-01-21')]);
hcCalls = 0;
const card = run(`authorReleasesCard()`);
ok('card renders from cache', card.indexOf('Onyx Storm') >= 0 && card.indexOf('Rebecca Yarros') >= 0);
ok('no Hardcover sweep on card render', hcCalls === 0);
run(`localStorage.clear();`);
seedLibrary();
ok('no card when cache empty', run(`authorReleasesCard()`) === '');

// --- 5. placement: below Currently Reading in libraryHomeHTML ---
seedLibrary();
seedCache([cand(1, 'Onyx Storm', ['Rebecca Yarros'], '2027-01-21')]);
const home = run(`libraryHomeHTML({ tbr: 0, reading: 1, read: 3, dnf: 0 })`);
const crIdx = home.indexOf('Currently Reading');
const arIdx = home.indexOf('id="author-releases"');
ok('card present on home', arIdx >= 0);
ok('card below Currently Reading', crIdx >= 0 && arIdx > crIdx);

// --- 6. wiring: dismiss collapses, add marks ---
// render the card into the DOM and wire it
run(`(function(){
  var box = document.createElement('div');
  box.innerHTML = authorReleasesCard();
  document.body.appendChild(box.firstChild);
  wireAuthorReleases();
})()`);
ok('card in DOM', !!q('#author-releases'));
const disBtn = q('[data-ar-dis]');
disBtn.click();
ok('dismiss removes the row', !q('.ar-rel'));
ok('empty card removed entirely', !q('#author-releases'));

// re-render for the add test (clean slate: drop the dismissed card)
run(`(function(){ var old = document.getElementById('author-releases'); if (old) old.remove(); })()`);
seedLibrary();
seedCache([cand(5, 'Addable', ['Sarah J. Maas'], '2027-04-01')]);
run(`(function(){
  var box = document.createElement('div');
  box.innerHTML = authorReleasesCard();
  document.body.appendChild(box.firstChild);
  wireAuthorReleases();
})()`);
const addBtn = q('[data-ar-add]');
const before = run(`library.length`);
addBtn.click();
ok('add puts the book on the shelf', run(`library.length`) === before + 1);
ok('add button shows added state', addBtn.textContent.indexOf('Added') >= 0 && addBtn.disabled);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
