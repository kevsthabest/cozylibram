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
// v186 foil: double hairline rules top and bottom of every spine
ok('foil spines carry two hairline rules',
  qa('.fav-shelf .spine').every(s => s.querySelectorAll('.spine-rule').length === 2));
ok('no legacy single band remains', qa('.fav-shelf .spine-band').length === 0);
// v187 read badge: gold seal on finished books' spines only
ok('read spines carry the read seal', qa('.fav-shelf .spine-read').length === 2);
runInWindow(`window.__tbrSpine = spineHTML({ id: 'tbr1', title: 'TBR Book', authors: ['Jane Doe'],
  pageCount: 300, status: 'tbr' });`);
ok('unread spine has no read seal', !String(window.__tbrSpine).includes('spine-read'));

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
ok('heart starts empty', !q('#f-fav').classList.contains('on') && !!q('#f-fav .ticon'));
q('#f-fav').click();
ok('heart fills on tap', q('#f-fav').classList.contains('on') && !!q('#f-fav .ticon'));
runInWindow(`window.__fc = library.find(b => b.id === 'fc');`);
ok('favorite saved on book', window.__fc.favorite === true);
ok('shelf gains a spine', qa('.fav-shelf .spine').length === 3);
ok('favorite persisted', JSON.parse(window.localStorage.getItem('spicyshelves.library.v1')).find(b => b.id === 'fc').favorite === true);
q('#f-fav').click();
ok('heart untoggles', !q('#f-fav').classList.contains('on') && qa('.fav-shelf .spine').length === 2);
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
ok('empty shelf hint shown', q('.fav-shelf').textContent.includes('on any book to pin it to this shelf'));
ok('no spines when empty', qa('.fav-shelf .spine').length === 0);

// 7. cover CORS allowlist: only request CORS where the host sends ACAO,
// so Google Books covers don't spam CORS errors in the console (v51)
runInWindow(`window.__cors = [
  coverCorsOK('https://covers.openlibrary.org/b/id/1-L.jpg'),
  coverCorsOK('https://is1-ssl.mzstatic.com/image/thumb/x.jpg'),
  coverCorsOK('http://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api'),
  coverCorsOK('data:image/jpeg;base64,AAAA'),
  coverCorsOK('')
];`);
ok('Open Library covers allow CORS pixel reads', window.__cors[0] === true);
ok('Apple artwork allows CORS pixel reads', window.__cors[1] === true);
ok('Google Books covers skip CORS (no console errors)', window.__cors[2] === false);
ok('data: URLs need no CORS', window.__cors[3] === true);
ok('empty url is safe', window.__cors[4] === true);

// 8. cover proxy: http(s) covers route through the same-origin proxy so
// pixels are readable from any host; data:/blob: URLs pass through (v52)
runInWindow(`window.__proxy = [
  coverProxyURL('http://books.google.com/books/content?id=X&img=1'),
  coverProxyURL('https://covers.openlibrary.org/b/id/1-L.jpg'),
  coverProxyURL('data:image/jpeg;base64,AAAA'),
  coverColorSources('http://books.google.com/books/content?id=X&img=1'),
  coverColorSources('data:image/jpeg;base64,AAAA')
];`);
ok('google cover goes through proxy',
  window.__proxy[0] === '/cover-proxy?url=' + encodeURIComponent('http://books.google.com/books/content?id=X&img=1'));
ok('open library cover goes through proxy',
  window.__proxy[1].indexOf('/cover-proxy?url=') === 0);
ok('data: URL skips proxy', window.__proxy[2] === 'data:image/jpeg;base64,AAAA');
ok('google sources: proxy first, then direct without CORS',
  window.__proxy[3].length === 2 && window.__proxy[3][0][0].indexOf('/cover-proxy') === 0 &&
  window.__proxy[3][1][1] === false);
ok('data: sources: direct with CORS ok',
  window.__proxy[4].length === 1 && window.__proxy[4][0][1] === true);

// 9. shelf style toggle: spines or covers (v61)
runInWindow(`localStorage.setItem('spicyshelves.animation', 'off');
  favExpanded = false; favStyle = 'spines';
  library.forEach(b => b.favorite = false);
  library.find(b => b.id === 'fa').favorite = true;
  library.find(b => b.id === 'fb').favorite = true;
  renderLibrary();`);
ok('style toggle rendered', !!q('#fav-style'));
ok('style toggle uses a line-art icon', !!q('#fav-style .ticon'));
ok('spines shown by default', qa('.fav-shelf .spine').length === 2 && qa('.fav-shelf .book-tile').length === 0);
ok('toggle offers covers', q('#fav-style').textContent.includes('Covers'));
q('#fav-style').click();
ok('covers shown after toggle', qa('.fav-shelf .book-tile').length === 2 && qa('.fav-shelf .spine').length === 0);
ok('toggle label flips to spines', q('#fav-style').textContent.includes('Spines'));
ok('toggle still line-art after flip', !!q('#fav-style .ticon'));
ok('style persisted', window.localStorage.getItem('spicyshelves.favstyle') === 'covers');
ok('cover tile shows the book title', qa('.fav-shelf .bt-title')[0].textContent.includes('Fav Book fa'));
qa('.fav-shelf .book-tile')[0].click();
ok('cover tap opens the book modal', !!q('#m-back') && q('#m-back').textContent.includes('Fav Book fa'));
window.document.getElementById('m-x').click();
q('#fav-style').click();
ok('toggle back to spines', qa('.fav-shelf .spine').length === 2 &&
  window.localStorage.getItem('spicyshelves.favstyle') === 'spines');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
