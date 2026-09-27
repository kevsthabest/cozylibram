// Reading-activity tests (v62/v63): 22-week heatmap, month calendar with
// covers + heat tint, shared day detail, pace section, longestStreak.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in heatmap tests'); };

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
const dk = (offset) => {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const isoDaysAgo = (n, h) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h || 12, 0, 0, 0); return d.toISOString(); };
const lvlOf = (k) => {
  const c = q('#heatmap [data-day="' + k + '"]').className;
  const m = /l([0-4])/.exec(c);
  return m ? parseInt(m[1], 10) : -1;
};

runInWindow(`localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  const mk = (id, title, extra) => Object.assign({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: 'reading', ratings: {}, axes: [], myRating: 0, tropes: [],
    progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '' }, extra);
  // logs: today 210, yesterday 60, 10 days ago 30
  library.push(mk('h1', 'Heavy Day', { log: [{ d: '${dk(0)}', from: 0, to: 210 }] }));
  library.push(mk('h2', 'Light Day', { log: [{ d: '${dk(10)}', from: 0, to: 30 }] }));
  library.push(mk('h4', 'Streak Day', { log: [{ d: '${dk(1)}', from: 0, to: 60 }] }));
  // finish-only day (5 days ago), no log
  library.push(mk('h3', 'Finished Solo', { status: 'read', dateFinished: '${isoDaysAgo(5)}' }));
  // finished books for pace records (avg finish time: (10 + 2) / 2 = 6 days;
  // finishes placed 20/21 days back so they form their own 2-day run)
  library.push(mk('h5', 'Longest Read', { status: 'read', pageCount: 1200, myRating: 4,
    dateAdded: '${isoDaysAgo(30)}', dateFinished: '${isoDaysAgo(20)}', progress: 1200 }));
  library.push(mk('h6', 'Shortest Read', { status: 'read', pageCount: 96, myRating: 5,
    dateAdded: '${isoDaysAgo(23)}', dateFinished: '${isoDaysAgo(21)}', progress: 96 }));
  heatSel = null;
  renderStats();`);

// 1. heatmap structure
ok('heatmap renders', !!q('#heatmap'));
ok('22 week columns + day-label column', qa('#heatmap .heat-col').length === 23);
ok('each week column has 7 day cells',
  qa('#heatmap .heat-col').slice(1).every(c => c.querySelectorAll('[data-day]').length === 7));
ok('legend shows less/more scale', q('.heat-legend').textContent.includes('Less') &&
  q('.heat-legend').textContent.includes('More'));

// 2. intensity ordering: heavy day > light day; finish-only day still lit
ok('heavy day brighter than light day', lvlOf(dk(0)) > lvlOf(dk(10)));
ok('light day is l1', lvlOf(dk(10)) === 1);
ok('finish-only day is lit', lvlOf(dk(5)) === 1);
ok('empty day is l0', lvlOf(dk(3)) === 0);
ok('today cell marked', q('#heatmap [data-day="' + dk(0) + '"]').classList.contains('today'));

// 3. tap a day -> detail with books + pages
q('#heatmap [data-day="' + dk(0) + '"]').click();
let dtxt = q('#heat-books').textContent;
ok('day detail shows book + page count', dtxt.includes('1 book') && dtxt.includes('210 pages'));
ok('day detail lists the book', dtxt.includes('Heavy Day'));
ok('selected cell highlighted', q('#heatmap [data-day="' + dk(0) + '"]').classList.contains('sel'));
// tap again deselects
q('#heatmap [data-day="' + dk(0) + '"]').click();
ok('deselect shows tap hint', q('#heat-books').textContent.includes('Tap a day'));
// empty day
q('#heatmap [data-day="' + dk(3) + '"]').click();
ok('empty day shows nothing-read note', q('#heat-books').textContent.includes('Nothing read'));
q('#heatmap [data-day="' + dk(3) + '"]').click();

// 4. tapping a listed book opens its detail modal
q('#heatmap [data-day="' + dk(0) + '"]').click();
q('#heat-books .cal-book').click();
ok('book tap opens modal', !!q('#m-back') && q('#m-back').textContent.includes('Heavy Day'));
window.document.getElementById('m-x').click();
q('#heatmap [data-day="' + dk(0) + '"]').click(); // deselect

// 5. pace section
const paceTxt = window.document.body.textContent;
ok('pace hero states pages/day', q('.pace-hero').textContent.includes('Your average pace is 10 pages/day'));
ok('pace grid has day/week/month', qa('.pace').length === 3 &&
  qa('.pace')[1].textContent.includes('70') && qa('.pace')[2].textContent.includes('304'));
ok('average book length shown', q('.kv').textContent.includes('532 pages')); // (300 + 1200 + 96) / 3
ok('average time to finish shown', q('.kv').textContent.includes('6 days'));
// longest/shortest now live in Personal records (v66), not in pace

// 6. (removed: pace no longer has tappable record rows; see records.test.js)

// 7. overview cards
const cards = qa('.stat-row .stat');
ok('4 overview cards', cards.length === 4);
ok('books read this year = 3', cards[0].textContent.includes('3'));
ok('pages this year = 1.6k', cards[1].textContent.includes('1.6k'));
ok('avg rating 4.5', cards[2].textContent.includes('4.5'));
ok('streak card shows current streak', cards[3].textContent.includes('🔥'));

// 8. longestStreak: today + yesterday = 2-day run; lone days don't extend it
runInWindow(`window.__best = longestStreak();`);
ok('longest streak is 2', window.__best === 2);

// 9. month calendar: covers + heat tint + nav (v63). Fixed fixtures so the
// assertions hold whatever day the suite runs.
runInWindow(`library.length = 0; heatSel = null;
  const F = (id, title, log, df) => ({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: df ? 'read' : 'reading', ratings: {}, axes: [], myRating: 0,
    tropes: [], progress: 0, log: log || [], dateAdded: new Date().toISOString(),
    dateFinished: df || null, notes: '' });
  library.push(F('c1', 'Cal One', [{ d: '2026-09-15', from: 0, to: 200 }]));
  library.push(F('c2', 'Cal Two', [{ d: '2026-09-15', from: 200, to: 260 }]));
  library.push(F('c3', 'Cal Light', [{ d: '2026-09-16', from: 0, to: 20 }]));
  library.push(F('c4', 'Cal Finished', null, new Date(2026, 8, 10, 12).toISOString()));
  const nd = F('c5', 'No Date', null, null); nd.status = 'read'; library.push(nd);
  calY = 2026; calM = 8; calSel = null;
  renderStats();`);
const cc = (k) => q('#readcal [data-day="' + k + '"]');
const clvl = (k) => { const m = /l([0-4])/.exec(cc(k).className); return m ? parseInt(m[1], 10) : -1; };
ok('calendar renders with month header', !!q('#readcal') && q('.cal-head h3').textContent === 'September 2026');
ok('2-book day shows cover + count badge',
  !!cc('2026-09-15').querySelector('.ccover') && cc('2026-09-15').querySelector('.cdot').textContent === '2');
ok('1-book day shows cover, no badge',
  !!cc('2026-09-16').querySelector('.ccover') && !cc('2026-09-16').querySelector('.cdot'));
ok('empty day has no cover', !cc('2026-09-17').querySelector('.ccover'));
ok('day cell shows pages read', cc('2026-09-15').querySelector('.cday-pages').textContent.includes('260'));
ok('light day cell shows its pages', cc('2026-09-16').querySelector('.cday-pages').textContent.includes('20'));
ok('empty day shows no page count', !cc('2026-09-17').querySelector('.cday-pages'));
ok('heavy day tinted brighter than light day', clvl('2026-09-15') > clvl('2026-09-16'));
ok('finish-only day is lit', clvl('2026-09-10') === 1);
ok('empty day has no tint', clvl('2026-09-17') === 0);
ok('no-date note shown', q('#view').textContent.includes('1 finished book has no finish date'));
cc('2026-09-15').click();
ok('calendar tap lists both books', qa('#cal-books .cal-book').length === 2);
ok('calendar detail shows pages', q('#cal-books').textContent.includes('260 pages'));
qa('#cal-books .cal-book')[0].click();
ok('calendar book tap opens modal', !!q('#m-back') && q('#m-back').textContent.includes('Cal One'));
window.document.getElementById('m-x').click();
q('#readcal [data-day="2026-09-15"]').click();
ok('calendar deselect clears list', qa('#cal-books .cal-book').length === 0);
q('#cal-prev').click();
ok('prev goes to August 2026', q('.cal-head h3').textContent === 'August 2026');
q('#cal-next').click(); q('#cal-next').click();
ok('next twice goes to October 2026', q('.cal-head h3').textContent === 'October 2026');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
