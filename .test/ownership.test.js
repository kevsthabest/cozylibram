// Ownership tests: owned vs to-buy vs borrowed badges, modal toggle, filters.
// v148: ownership is 'owned' | 'tobuy' | 'borrowed' (legacy booleans migrate).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in ownership tests'); };
window.matchMedia = () => ({ matches: false });

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
const mk = (id, owned) =>
  `({ id: '${id}', isbn: '', title: 'Own ${id}', authors: ['Jane Doe'], cover: '', ` +
  `description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, ` +
  `status: 'tbr', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0, ` +
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, owned: '${owned}' })`;

// 1. migration: legacy booleans become the enum, strings pass through
runInWindow(`migrateBook(window.__old = { id: 'old1', title: 'Old' });`);
ok('migration defaults missing to owned', window.__old.owned === 'owned');
runInWindow(`migrateBook(window.__t = { id: 't1', title: 'T', owned: true });`);
ok('migration true -> owned', window.__t.owned === 'owned');
runInWindow(`migrateBook(window.__wl = { id: 'wl1', title: 'WL', owned: false });`);
ok('migration false -> tobuy', window.__wl.owned === 'tobuy');
runInWindow(`migrateBook(window.__b = { id: 'b1', title: 'B', owned: 'borrowed' });`);
ok('migration keeps borrowed', window.__b.owned === 'borrowed');

// 2. new-book factories default to owned
ok('google factory defaults owned', window.normalizeVolume({ volumeInfo: { title: 'T' } }).owned === 'owned');
ok('openlibrary factory defaults owned', window.olDocToBook({ title: 'T', key: '/works/1' }).owned === 'owned');

// 3. badges on list cards
runInWindow(`localStorage.clear(); localStorage.setItem('spicyshelves.animation', 'off');
  layout = 'list'; library.push(${mk('o1', 'owned')}); library.push(${mk('o2', 'tobuy')});
  library.push(${mk('o3', 'borrowed')}); renderLibrary();`);
ok('owned badge on card', q('.book-card[data-id="o1"] .badge.owned').textContent.includes('Owned'));
ok('to-buy badge on card', q('.book-card[data-id="o2"] .badge.tobuy').textContent.includes('To buy'));
ok('borrowed badge on card', q('.book-card[data-id="o3"] .badge.borrowed').textContent.includes('Borrowed'));

// 4. v57: Bookmory-style grid tiles render (cover box + title)
runInWindow(`layout = 'grid'; renderLibrary();`);
ok('grid renders book tiles', !!q('.book-grid .book-tile[data-id="o2"] .bt-cover'));
ok('tile shows the title', q('.book-tile[data-id="o2"] .bt-title').textContent === 'Own o2');
ok('no old cover tiles', !q('.cover-tile'));
runInWindow(`layout = 'list'; renderLibrary();`);

// 5. modal toggle flips ownership, Save persists (incl. borrowed)
runInWindow(`openDetail('o1');`);
ok('modal shows Owned active', q('#f-owned button[data-o="owned"]').classList.contains('active'));
q('#f-owned button[data-o="tobuy"]').click();
ok('clicking To buy flips active', q('#f-owned button[data-o="tobuy"]').classList.contains('active'));
q('#m-save').click();
runInWindow(`window.__o1owned = library.find(b => b.id === 'o1').owned;`);
ok('save persists tobuy', window.__o1owned === 'tobuy');
runInWindow(`openDetail('o1');`);
q('#f-owned button[data-o="borrowed"]').click();
q('#m-save').click();
runInWindow(`window.__o1b = library.find(b => b.id === 'o1').owned; renderLibrary();`);
ok('save persists borrowed', window.__o1b === 'borrowed');
ok('card badge updates after save', !!q('.book-card[data-id="o1"] .badge.borrowed'));

// 6. ownership filter chips
ok('ownership chips rendered (4)', qa('[data-of]').length === 4);
q('[data-of="tobuy"]').click();
const shown = qa('.book-card').map(el => el.dataset.id);
ok('to-buy filter shows only tobuy', shown.length === 1 && shown[0] === 'o2');
q('[data-of="borrowed"]').click();
const shownB = qa('.book-card').map(el => el.dataset.id);
ok('borrowed filter shows only borrowed', shownB.length === 2 && shownB.includes('o1') && shownB.includes('o3'));
q('[data-of="owned"]').click();
ok('owned filter shows none now', qa('.book-card').length === 0);
q('[data-of="all"]').click();
ok('all restores all three', qa('.book-card').length === 3);

// 7. wishlist (reached from the Library toolbar): only to-buy, never borrowed
runInWindow(`go('library')`);
ok('library toolbar links to wishlist', !!q('#lib-wishlist'));
q('#lib-wishlist').click();
ok('wishlist view renders', !!q('.wish-head'));
ok('wishlist shows only to-buy', qa('#view .book-card').length === 1);
ok('wishlist cards have to-buy badges',
  qa('#view .book-card .badge.tobuy').length === 1);
q('#view .book-card').click();
ok('wishlist card opens detail', !!q('#f-owned'));
window.document.getElementById('m-x').click();

// 8. empty wishlist state
runInWindow(`library.forEach(b => b.owned = 'owned'); renderWishlist();`);
ok('empty wishlist message', q('#view .empty').textContent.includes('Nothing on the wishlist'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
