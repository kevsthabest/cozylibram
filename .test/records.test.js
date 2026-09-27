// Phase-3 stats tests (v66): personal records cards (+ biggest-day jump)
// and series statistics with next-up from TBR.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in records tests'); };

require('./harness').loadApp(window);

// v128: these tests exercise the stats explorer, which now lives behind
// the dashboard - opt into detail mode.
window.eval(`statsMode = 'detail';`);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.toISOString(); };

runInWindow(`localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  const dk3 = (() => { const d = new Date(); d.setDate(d.getDate() - 3);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  window.__dk3 = dk3;
  const M = (id, title, extra) => Object.assign({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: 'read', ratings: {}, axes: [], myRating: 0, tropes: [],
    progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '',
    series: null }, extra);
  library.push(M('b1', 'Long Haul', { pageCount: 600, myRating: 5, ratings: { spice: 5 },
    series: { name: 'The Broken Saga', position: 1 }, dateFinished: '${isoDaysAgo(10)}',
    log: [{ d: dk3, from: 0, to: 300 }] }));
  library.push(M('b2', 'Quickie', { pageCount: 120, myRating: 2, ratings: { spice: 2 },
    series: { name: 'The Broken Saga', position: 2 }, dateFinished: '${isoDaysAgo(20)}' }));
  library.push(M('b3', 'Saga Three', { status: 'tbr', series: { name: 'The Broken Saga', position: 3 } }));
  library.push(M('b4', 'Standalone Gem', { pageCount: 250, myRating: 5, ratings: { spice: 1 },
    dateFinished: '${isoDaysAgo(5)}' }));
  library.push(M('b5', 'Otherworld One', { pageCount: 200, myRating: 3,
    series: { name: 'Otherworld', position: 1 }, dateFinished: '${isoDaysAgo(30)}' }));
  renderStats();`);

const dk3 = window.__dk3;

// 1. records
const cards = qa('.record-card');
const cardFor = (lbl) => cards.find(c => c.textContent.includes(lbl));
ok('6 record cards', cards.length === 6);
ok('longest record', !!cardFor('Longest') && cardFor('Longest').textContent.includes('Long Haul'));
ok('shortest record', !!cardFor('Shortest') && cardFor('Shortest').textContent.includes('Quickie'));
ok('highest rated (tie goes to latest finish)', !!cardFor('Highest rated') && cardFor('Highest rated').textContent.includes('Standalone Gem'));
ok('lowest rated', !!cardFor('Lowest rated') && cardFor('Lowest rated').textContent.includes('Quickie'));
ok('spiciest', !!cardFor('Spiciest') && cardFor('Spiciest').textContent.includes('Long Haul'));
ok('biggest day shows 300 pages', !!cardFor('Biggest day') && cardFor('Biggest day').textContent.includes('300 pages'));
cardFor('Longest').click();
ok('record tap opens modal', !!q('#m-back') && q('#m-back').textContent.includes('Long Haul'));
window.document.getElementById('m-x').click();

// 2. biggest day jumps to the calendar
cardFor('Biggest day').click();
runInWindow(`window.__calSel = calSel; window.__calYM = calY + '-' + calM;`);
ok('big day sets calendar selection', window.__calSel === dk3);
ok('calendar highlights that day', !!q('#readcal [data-day="' + dk3 + '"].sel'));

// 3. series
const srows = qa('.series-row');
ok('2 series listed', srows.length === 2);
ok('biggest series first', srows[0].textContent.includes('The Broken Saga'));
const saga = srows.find(r => r.textContent.includes('The Broken Saga'));
ok('saga shows 2 read', saga.textContent.includes('2 read'));
ok('saga next up from TBR', saga.textContent.includes('Saga Three'));
saga.querySelector('[data-id]').click();
ok('next-up tap opens modal', !!q('#m-back') && q('#m-back').textContent.includes('Saga Three'));
window.document.getElementById('m-x').click();
const other = srows.find(r => r.textContent.includes('Otherworld'));
ok('otherworld: 1 read, no next up', other.textContent.includes('1 read') && !other.textContent.includes('Next up'));

// 4. empty states stay graceful
runInWindow(`library.length = 0; renderStats();`);
const bodyTxt = window.document.body.textContent;
ok('empty records note', bodyTxt.includes('Personal records') && bodyTxt.includes('Finish some books'));
ok('empty series note', bodyTxt.includes('Books with series info'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
