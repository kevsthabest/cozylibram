// Reading-activity heatmap + pace tests (v62): 22-week GitHub-style grid,
// intensity levels, day-tap detail, pace hero/kv rows, longestStreak.
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
ok('longest book row', q('.kv').textContent.includes('Longest Read') && q('.kv').textContent.includes('1.2k pages'));
ok('shortest book row', q('.kv').textContent.includes('Shortest Read') && q('.kv').textContent.includes('96 pages'));

// 6. record row tap opens the book
qa('.kv-row.tap')[0].click();
ok('record tap opens modal', !!q('#m-back') && q('#m-back').textContent.includes('Longest Read'));
window.document.getElementById('m-x').click();

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
