// Reading-calendar tests: finish-day markers, day selection, month nav.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in calendar tests'); };

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
// local-noon ISO avoids TZ date shifts
const iso = (y, m, d) => new Date(y, m - 1, d, 12).toISOString();

runInWindow(`localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off'); // these tests assert instant modal opens
  const mk = (id, title, status, df) => ({ id, isbn: '', title, authors: ['A'], cover: '', description: '',
    pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, status,
    ratings: {}, axes: [], myRating: 0, tropes: [], progress: 0,
    dateAdded: new Date().toISOString(), dateFinished: df, notes: '' });
  library.push(mk('c1', 'Finished One', 'read', '${iso(2026, 9, 15)}'));
  library.push(mk('c2', 'Finished Two', 'read', '${iso(2026, 9, 15)}'));
  library.push(mk('c3', 'Finished Solo', 'read', '${iso(2026, 9, 3)}'));
  library.push(mk('c4', 'No Date', 'read', null));
  library.push(mk('c5', 'Still Reading', 'reading', null));
  calY = 2026; calM = 8; calSel = null;
  renderStats();`);

const dot = (day) => {
  const cell = q('#readcal [data-day="2026-09-' + day + '"] .cdot');
  return cell ? cell.textContent : null;
};
const hasCover = (day) => !!q('#readcal [data-day="2026-09-' + day + '"] .ccover');

// 1. markers on finish days
ok('calendar renders', !!q('#readcal'));
ok('2-book day shows cover + count 2', hasCover('15') && dot('15') === '2');
ok('1-book day shows cover, no count badge', hasCover('03') && dot('03') === null);
ok('empty day has no marker', dot('16') === null && !hasCover('16'));
ok('header shows month + year', q('.cal-head h3').textContent === 'September 2026');

// 2. selecting a day lists its books
q('#readcal [data-day="2026-09-15"]').click();
let books = qa('#cal-books .cal-book');
ok('day list shows 2 books', books.length === 2);
ok('day list has right titles',
  books.some(b => b.textContent.includes('Finished One')) &&
  books.some(b => b.textContent.includes('Finished Two')));
ok('selected day highlighted', !!q('#readcal [data-day="2026-09-15"].sel'));

// 3. clicking again deselects
q('#readcal [data-day="2026-09-15"]').click();
ok('deselect clears list', qa('#cal-books .cal-book').length === 0);

// 4. empty day selection shows note
q('#readcal [data-day="2026-09-16"]').click();
ok('empty day shows nothing-read note', q('#cal-books').textContent.includes('Nothing read'));

// 5. month navigation
q('#cal-prev').click();
ok('prev goes to August 2026', q('.cal-head h3').textContent === 'August 2026');
q('#cal-next').click(); q('#cal-next').click();
ok('next twice goes to October 2026', q('.cal-head h3').textContent === 'October 2026');
ok('no markers in empty month', qa('#readcal .cdot').length === 0);

// 6. books without finish date noted, non-read books excluded
runInWindow(`calY = 2026; calM = 8; calSel = null; renderStats();`);
ok('no-date note shown', q('#stats, #view').textContent.includes('1 finished book has no finish date'));
ok('reading book never gets a marker', dot('15') === '2' && hasCover('15')); // c5 not counted

// 7. tapping a listed book opens its detail modal
q('#readcal [data-day="2026-09-03"]').click();
q('#cal-books .cal-book').click();
ok('book tap opens modal', !!q('#modal-root .modal') && q('#modal-root').textContent.includes('Finished Solo'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
