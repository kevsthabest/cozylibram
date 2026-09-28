// Tests for v130 — modal improvements (UI Improvement Pass, modal polish):
// description visible in the modal header next to the cover (with a
// read-more toggle); manual page entry in the quick tracker.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in modal tests'); };

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

const seed = (id, over) => {
  const base = { id, isbn: '', title: 'T' + id, authors: ['A'], cover: '', description: '',
    pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
    status: 'reading', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 40,
    log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '',
    favorite: false, owned: true, series: null, series2: null, quotes: [] };
  const book = Object.assign(base, over || {});
  runInWindow(`localStorage.clear(); library = []; library.push(${JSON.stringify(book)});
    saveLibrary(); openBookFromEl(null, '${id}');`);
};

const DESC = 'A tale of two cities. It was the best of times.\n\nIt was the worst of times.';

// --- description on the Details tab (v174: moved out of the header) ---
seed('d1', { description: DESC });
ok('description renders on the Details tab', !!q('#dtab-details #m-desc'));
ok('cover hero does not repeat the description',
  !q('.d-hero').textContent.includes('best of times'));
ok('description text present', q('#m-desc').textContent.includes('best of times'));
ok('description rendered exactly once', qa('#m-desc').length === 1);
ok('read-more toggle exists', !!q('#m-desc-toggle'));
q('#m-desc-toggle').click();
ok('toggle expands (open class)', q('#m-desc').classList.contains('open'));
ok('toggle label switches to Show less', q('#m-desc-toggle').textContent === 'Show less');
q('#m-desc-toggle').click();
ok('toggle collapses again', !q('#m-desc').classList.contains('open'));
ok('toggle label switches back', q('#m-desc-toggle').textContent === 'Read more');

seed('d2', { description: 'A <b>bold</b> tale<br>continues' });
ok('HTML tags stripped from description', !q('#m-desc p').innerHTML.includes('<b>'));
ok('stripped text still readable', q('#m-desc p').textContent.includes('bold tale'));

seed('d3', { description: '' });
ok('no description block when the book has none', !q('#m-desc'));

// --- manual page entry ---
seed('p1', {});
ok('quick tracker has manual page input', !!q('#pq-page'));
ok('quick tracker has Set button', !!q('#pq-set'));
ok('steppers still present', qa('#m-progress [data-step]').length === 4);

q('#pq-page').value = '500'; // above total of 300 → clamps
q('#pq-set').click();
ok('Set page clamps to total', q('#m-progress .pq-label').textContent.includes('300') &&
  q('#m-progress .pq-label').textContent.includes('100%'));

seed('p2', {});
const inp = q('#pq-page');
inp.value = '150';
inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
ok('Enter key applies page number', q('#m-progress .pq-label').textContent.includes('150'));

seed('p3', {});
q('#pq-page').value = '-20';
q('#pq-set').click();
ok('negative input ignored', q('#m-progress .pq-label').textContent.includes('40'));

seed('p4', {});
q('#m-progress [data-step="+10"]').click();
ok('steppers still adjust progress', q('#m-progress .pq-label').textContent.includes('50'));

seed('p5', { status: 'tbr' });
ok('no quick tracker for non-reading books', !q('#pq-page') && q('#m-progress').innerHTML === '');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
