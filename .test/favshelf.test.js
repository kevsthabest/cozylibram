// Favorites bookshelf tests: migration, shelf rendering, spine clicks,
// heart toggle, expand/collapse, empty state, persistence.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in favshelf tests'); };

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
const mk = (id, fav, pages) => `({ id: '${id}', isbn: '', title: 'Fav Book ${id}', authors: ['Jane Doe'], cover: '',
  description: '', pageCount: ${pages}, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
  status: 'read', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0,
  dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: ${fav} })`;

// 1. migration normalizes favorite
runInWindow(`window.__m1 = migrateBook({ title: 'x' }); window.__m2 = migrateBook({ title: 'y', favorite: 1 });`);
ok('migrateBook defaults favorite to false', window.__m1.favorite === false);
ok('migrateBook keeps truthy favorite', window.__m2.favorite === true);

// 2. shelf renders spines for favorites only
runInWindow(`localStorage.clear(); favExpanded = false;
  library.push(${mk('fa', true, 400)}, ${mk('fb', true, 200)}, ${mk('fc', false, 300)});
  renderLibrary();`);
ok('shelf section renders', !!q('.fav-shelf'));
ok('2 spines for 2 favorites', qa('.fav-shelf .spine').length === 2);
ok('spine shows title', qa('.fav-shelf .spine-title')[0].textContent.includes('Fav Book fa'));
ok('thicker spine for more pages',
  parseInt(qa('.fav-shelf .spine')[0].style.width) > parseInt(qa('.fav-shelf .spine')[1].style.width));

// 3-6 need async (spine pull animation). Books here have no covers -> short pull.
(async () => {
const tick = (ms) => new Promise(r => setTimeout(r, ms));

// 3. spine click pulls out, then opens the book modal
qa('.fav-shelf .spine')[0].click();
ok('spine gets pulling class', qa('.fav-shelf .spine')[0].classList.contains('pulling'));
await tick(600);
ok('spine click opens modal', !!q('#f-fav'));

// 4. heart toggle pins/unpins immediately
runInWindow(`window.document.getElementById('m-x').click(); openDetail('fc');`);
ok('heart starts empty', q('#f-fav').textContent === '🤍');
q('#f-fav').click();
ok('heart fills on tap', q('#f-fav').textContent === '❤️');
runInWindow(`window.__fc = library.find(b => b.id === 'fc');`);
ok('favorite saved on book', window.__fc.favorite === true);
ok('shelf gains a spine', qa('.fav-shelf .spine').length === 3);
ok('favorite persisted', JSON.parse(window.localStorage.getItem('spicyshelves.library.v1')).find(b => b.id === 'fc').favorite === true);
q('#f-fav').click();
ok('heart untoggles', q('#f-fav').textContent === '🤍' && qa('.fav-shelf .spine').length === 2);
window.document.getElementById('m-x').click();

// 5. expand/collapse with many favorites (jsdom width -> 360px -> 6 per row)
runInWindow(`favExpanded = false;
  for (let i = 0; i < 6; i++) { const nb = ${mk('fxbase', true, 300)}; nb.id = 'fx' + i; nb.title = 'Extra ' + i; library.push(nb); }
  renderLibrary();`);
ok('collapsed shows 6 spines', qa('.fav-shelf .spine').length === 6);
ok('toggle offers show-all', q('#fav-toggle').textContent.includes('Show all 8'));
q('#fav-toggle').click();
ok('expanded shows all 8', qa('.fav-shelf .spine').length === 8);
ok('toggle offers show-less', q('#fav-toggle').textContent.includes('Show less'));
q('#fav-toggle').click();
ok('collapsed again', qa('.fav-shelf .spine').length === 6);

// 6. empty state
runInWindow(`library.forEach(b => b.favorite = false); favExpanded = false; renderLibrary();`);
ok('empty shelf hint shown', q('.fav-shelf').textContent.includes('Tap 🤍'));
ok('no spines when empty', qa('.fav-shelf .spine').length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
