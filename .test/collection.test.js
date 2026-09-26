// Collection tests: tap author/series in the book modal -> other books list.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in collection tests'); };
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
const mk = (id, title, authors, series, status) =>
  `({ id: '${id}', isbn: '', title: '${title}', authors: ${JSON.stringify(authors)}, cover: '', ` +
  `description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, ` +
  `status: '${status}', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0, ` +
  `dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false, ` +
  `series: ${series ? `{ name: '${series[0]}', position: '${series[1]}' }` : 'null'} })`;

runInWindow(`localStorage.clear();
  library.push(${mk('c1', 'Alpha', ['Jane Doe', 'Co Writer'], ['The Saga', '2'], 'read')});
  library.push(${mk('c2', 'Beta', ['Jane Doe'], ['The Saga', '1'], 'tbr')});
  library.push(${mk('c3', 'Gamma', ['Jane Doe'], ['The Saga', '3'], 'reading')});
  library.push(${mk('c4', 'Delta', ['John Smith'], null, 'read')});
  openDetail('c1');`);

// 1. authors render as tappable buttons
ok('author buttons rendered', qa('#modal-root [data-author]').length === 2);
ok('first author is Jane Doe', qa('#modal-root [data-author]')[0].textContent === 'Jane Doe');

// 2. series renders as tappable button
ok('series button rendered', !!q('#modal-root [data-series]'));
ok('series button text', q('#modal-root [data-series]').textContent === 'The Saga');

// 3. tap author -> collection overlay with other books by her, current excluded
qa('#modal-root [data-author]')[0].click();
ok('collection overlay opens', !!q('.collection-overlay'));
ok('lists other books by author', qa('.collection-overlay [data-book]').length === 2);
ok('current book excluded', !q('.collection-overlay [data-book="c1"]'));
ok('unrelated author excluded', !q('.collection-overlay [data-book="c4"]'));

// 4. tap a book in the collection -> its detail opens
q('.collection-overlay [data-book="c2"]').click();
ok('overlay closes', !q('.collection-overlay'));
ok('book detail opens', q('#modal-root h2').textContent === 'Beta');

// 5. series collection sorted by position (current book = Beta, pos 1, excluded)
q('#modal-root [data-series]').click();
const order = qa('.collection-overlay [data-book]').map(el => el.dataset.book);
ok('series sorted by position', JSON.stringify(order) === JSON.stringify(['c1', 'c3']));

// 6. rows show series position info
ok('row shows position', q('.collection-overlay .crow small').textContent.includes('#2'));

// 7. close via X, book modal still underneath
q('#c-x').click();
ok('overlay closed via X', !q('.collection-overlay'));
ok('book modal intact', q('#modal-root h2').textContent === 'Beta');

// 8. empty collection state
runInWindow(`openCollection('author', 'Nobody Writes', 'c1');`);
ok('empty state shown', q('.collection-overlay').textContent.includes('only one'));
q('#c-x').click();

// 9. case-insensitive matching
runInWindow(`openCollection('author', 'jane doe', 'c4');`);
ok('case-insensitive match', qa('.collection-overlay [data-book]').length === 3);
q('#c-x').click();

// 10. book without series has no series button
runInWindow(`openDetail('c4');`);
ok('no series button without series', !q('#modal-root [data-series]'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
