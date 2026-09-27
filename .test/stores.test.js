// Storefront link tests: region detection, URL builders, modal buy row, settings.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in stores tests'); };
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
const setRegion = r => runInWindow(`localStorage.setItem('spicyshelves.storeRegion', '${r}');`);
const mk = (id, owned) =>
  `({ id: '${id}', isbn: '9780123456789', title: 'Store ${id}', authors: ['Jane Doe'], cover: '', ` +
  `description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, ` +
  `status: 'tbr', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0, ` +
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, owned: ${owned} })`;

// 1. region setting
runInWindow(`localStorage.removeItem('spicyshelves.storeRegion');`);
ok('region defaults to auto', window.storeRegionSetting() === 'auto');
setRegion('CA'); ok('explicit CA honored', window.detectStoreRegion() === 'CA');
setRegion('UK'); ok('explicit UK honored', window.detectStoreRegion() === 'UK');
setRegion('AU'); ok('explicit AU honored', window.detectStoreRegion() === 'AU');

// 2. auto-detect from device language
runInWindow(`localStorage.removeItem('spicyshelves.storeRegion');
  Object.defineProperty(navigator, 'language', { value: 'en-CA', configurable: true });`);
ok('auto en-CA -> CA', window.detectStoreRegion() === 'CA');
runInWindow(`Object.defineProperty(navigator, 'language', { value: 'en-GB', configurable: true });`);
ok('auto en-GB -> UK', window.detectStoreRegion() === 'UK');
runInWindow(`Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });`);
ok('auto fr-FR -> valid region fallback',
  ['CA', 'US', 'UK', 'AU'].includes(window.detectStoreRegion()));

// 3. store query prefers ISBN
ok('query prefers isbn', window.storeQuery({ isbn: '978-0-123456-78-9', title: 'T', authors: ['A'] }) === '9780123456789');
ok('query falls back to title+author',
  window.storeQuery({ isbn: '', title: 'Iron Flame', authors: ['Rebecca Yarros'] }) === 'Iron Flame Rebecca Yarros');

// 4. per-region URLs
setRegion('CA');
const ca = window.storeLinks({ isbn: '9780123456789', title: 'T', authors: [] });
ok('CA has 2 stores (v146: Kobo dropped)', ca.length === 2 && ca[0].name === 'Amazon' && ca[1].name === 'Indigo');
ok('CA amazon link', ca[0].url === 'https://www.amazon.ca/s?k=9780123456789');
ok('CA indigo link uses title+author (ISBN unreliable there)',
  ca[1].url === 'https://www.indigo.ca/search?q=' + encodeURIComponent('T'));
// title+author mode with a real title/author pair
const ca2 = window.storeLinks({ isbn: '9780123456789', title: 'Iron Flame', authors: ['Rebecca Yarros'] });
ok('indigo title+author query', ca2[1].url ===
  'https://www.indigo.ca/search?q=' + encodeURIComponent('Iron Flame Rebecca Yarros'));
ok('amazon still prefers ISBN', ca2[0].url === 'https://www.amazon.ca/s?k=9780123456789');
setRegion('US');
const us = window.storeLinks({ isbn: '', title: 'Iron Flame', authors: ['Rebecca Yarros'] });
ok('US b&n link (v145 pattern)', us[1].url === 'https://www.barnesandnoble.com/search?q=Iron%20Flame%20Rebecca%20Yarros');
ok('US bookshop link (v145 beta-search)', us[2].url === 'https://bookshop.org/beta-search?keywords=Iron%20Flame%20Rebecca%20Yarros');
// v145: only Amazon searches by ISBN now — every other store uses title+author,
// which proved far more reliable when verified live.
const usIsbn = window.storeLinks({ isbn: '9780123456789', title: 'Iron Flame', authors: ['Rebecca Yarros'] });
ok('b&n uses title+author even with ISBN', usIsbn[1].url === 'https://www.barnesandnoble.com/search?q=Iron%20Flame%20Rebecca%20Yarros');
ok('bookshop uses title+author even with ISBN', usIsbn[2].url === 'https://bookshop.org/beta-search?keywords=Iron%20Flame%20Rebecca%20Yarros');
ok('amazon still uses ISBN', usIsbn[0].url === 'https://www.amazon.com/s?k=9780123456789');
setRegion('UK');
const uk = window.storeLinks({ isbn: '', title: 'Iron Flame', authors: ['Rebecca Yarros'] });
ok('UK waterstones link', uk[1].url === 'https://www.waterstones.com/books/search/term/Iron+Flame+Rebecca+Yarros');
ok('waterstones uses title+author even with ISBN',
  window.storeLinks({ isbn: '9780123456789', title: 'Iron Flame', authors: ['Rebecca Yarros'] })[1].url ===
  'https://www.waterstones.com/books/search/term/Iron+Flame+Rebecca+Yarros');
setRegion('AU');
ok('AU booktopia link (v145 pattern, title query)',
  window.storeLinks({ isbn: '9780123456789', title: 'T', authors: [] })[1].url ===
  'https://www.booktopia.com.au/search?keywords=T&productType=917504&pn=1');

// 5. modal buy row: wishlist only
runInWindow(`localStorage.clear(); localStorage.setItem('spicyshelves.storeRegion', 'CA');
  library.push(${mk('s1', false)}); library.push(${mk('s2', true)});`);
runInWindow(`openDetail('s1');`);
ok('buy row visible for wishlist book', q('#m-buywrap').style.display !== 'none');
ok('buy row has 2 retailer links', qa('#m-buywrap a').length === 2);
ok('buy links open in new tab', qa('#m-buywrap a').every(a => a.target === '_blank' && a.rel.includes('noopener')));
ok('region label shown', q('#m-buywrap').textContent.includes('Canada'));
ok('isbn used in link', q('#m-buywrap a').href.includes('9780123456789'));
q('#f-owned button[data-o="1"]').click();
ok('flipping to owned hides buy row', q('#m-buywrap').style.display === 'none');
window.document.getElementById('m-x').click();
runInWindow(`openDetail('s2');`);
ok('buy row hidden for owned book', q('#m-buywrap').style.display === 'none');
window.document.getElementById('m-x').click();

// 6. settings region picker
runInWindow(`localStorage.removeItem('spicyshelves.storeRegion'); go('settings');`);
ok('region seg has 5 options', qa('#th-region button').length === 5);
ok('auto active by default', q('#th-region button[data-r="auto"]').classList.contains('active'));
q('#th-region button[data-r="US"]').click();
ok('clicking US persists region', window.storeRegionSetting() === 'US');
ok('US becomes active', q('#th-region button[data-r="US"]').classList.contains('active'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
