// Ownership tests: owned vs to-buy badges, modal toggle, filters.
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
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, owned: ${owned} })`;

// 1. migration defaults old books to owned
runInWindow(`migrateBook(window.__old = { id: 'old1', title: 'Old' });`);
ok('migration defaults owned=true', window.__old.owned === true);
runInWindow(`migrateBook(window.__wl = { id: 'wl1', title: 'WL', owned: false });`);
ok('migration keeps owned=false', window.__wl.owned === false);

// 2. new-book factories default to owned
ok('google factory defaults owned', window.normalizeVolume({ volumeInfo: { title: 'T' } }).owned === true);
ok('openlibrary factory defaults owned', window.olDocToBook({ title: 'T', key: '/works/1' }).owned === true);

// 3. badges on list cards
runInWindow(`localStorage.clear(); library.push(${mk('o1', true)}); library.push(${mk('o2', false)}); renderLibrary();`);
ok('owned badge on card', q('.book-card[data-id="o1"] .badge.owned').textContent.includes('Owned'));
ok('to-buy badge on card', q('.book-card[data-id="o2"] .badge.tobuy').textContent.includes('To buy'));

// 4. grid tile shows cart for to-buy only
runInWindow(`layout = 'grid'; renderLibrary();`);
ok('tile cart on to-buy', !!q('.cover-tile[data-id="o2"] .tile-buy'));
ok('no tile cart on owned', !q('.cover-tile[data-id="o1"] .tile-buy'));
runInWindow(`layout = 'list'; renderLibrary();`);

// 5. modal toggle flips ownership, Save persists
runInWindow(`openDetail('o1');`);
ok('modal shows Owned active', q('#f-owned button[data-o="1"]').classList.contains('active'));
q('#f-owned button[data-o="0"]').click();
ok('clicking To buy flips active', q('#f-owned button[data-o="0"]').classList.contains('active'));
q('#m-save').click();
runInWindow(`window.__o1owned = library.find(b => b.id === 'o1').owned;`);
ok('save persists owned=false', window.__o1owned === false);
runInWindow(`renderLibrary();`);
ok('card badge updates after save', !!q('.book-card[data-id="o1"] .badge.tobuy'));

// 6. ownership filter chips
ok('ownership chips rendered', qa('[data-of]').length === 3);
q('[data-of="tobuy"]').click();
const shown = qa('.book-card').map(el => el.dataset.id);
ok('to-buy filter shows only unowned', shown.length === 2 && shown.includes('o1') && shown.includes('o2'));
q('[data-of="owned"]').click();
ok('owned filter shows none now', qa('.book-card').length === 0);
q('[data-of="all"]').click();
ok('all restores both', qa('.book-card').length === 2);

// 7. wishlist tab
ok('nav has wishlist button', !!q('.bottom-nav [data-nav="wishlist"]'));
q('.bottom-nav [data-nav="wishlist"]').click();
ok('wishlist view renders', !!q('.wish-head'));
ok('wishlist shows only to-buy', qa('#view .book-card').length === 2);
ok('wishlist cards have to-buy badges',
  qa('#view .book-card .badge.tobuy').length === 2);
q('#view .book-card').click();
ok('wishlist card opens detail', !!q('#f-owned'));
window.document.getElementById('m-x').click();

// 8. empty wishlist state
runInWindow(`library.forEach(b => b.owned = true); renderWishlist();`);
ok('empty wishlist message', q('#view .empty').textContent.includes('Nothing on the wishlist'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
