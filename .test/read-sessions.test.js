// readSessions counter-drift regression tests — issue #369.
// The counter's own definition (js/040) is "a day with a log", but it
// drifted in both directions:
//  1. logProgress incremented per newly created ENTRY, and entries are
//     keyed per (day, unit) — logging pages then percent on the same
//     day counted 2 sessions for 1 day.
//  2. The "Remove today's entry" flow (js/150) deleted the entry but
//     never decremented — a day whose only entry was removed counted
//     as a session forever.
// The counter feeds the portrait nudges (js/227), so the drift fired
// nudges earlier than the stated session evidence justifies.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in read-sessions tests'); };
require('./harness').loadApp(window);
window.confirmModal = () => Promise.resolve(true); // auto-accept the removal confirm

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const M = (id, extra) => Object.assign({
  id, isbn: '', title: 'Book ' + id, authors: ['A'], cover: '', description: '',
  pageCount: 300, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'reading', ratings: {}, axes: [], myRating: 0,
  tropes: [], progress: 0, log: [], dateAdded: new Date().toISOString(),
  dateFinished: null, notes: ''
}, extra);

(async () => {
  runInWindow(`localStorage.clear();
    localStorage.setItem('spicyshelves.animation', 'off');
    library.length = 0;
    window.__rs1 = ${JSON.stringify(M('rs1', {}))};
    library.push(window.__rs1);
    const tk = dayKey(new Date());
    window.__rs2 = ${JSON.stringify(M('rs2', { progress: 50, readSessions: 1 }))};
    window.__rs2.log = [{ d: tk, from: 40, to: 50 }];
    library.push(window.__rs2);
    window.__rs3 = ${JSON.stringify(M('rs3', { progress: 20, progressUnit: 'pct', readSessions: 1 }))};
    window.__rs3.log = [{ d: tk, from: 40, to: 50 }, { d: tk, from: 0, to: 20, u: 'pct' }];
    library.push(window.__rs3);
    saveLibrary();`);

  // --- (1) increments: a day counts once, however many units it holds ---
  runInWindow(`logProgress(window.__rs1, 0, 50, 'page');`);
  ok('first log of the day counts one session', window.__rs1.readSessions === 1);
  runInWindow(`logProgress(window.__rs1, 50, 80, 'page');`);
  ok('folding into the same-day entry adds nothing', window.__rs1.readSessions === 1);
  runInWindow(`logProgress(window.__rs1, 0, 40, 'pct');`);
  ok('a second unit the same day still counts one session', window.__rs1.readSessions === 1);
  ok('the mixed-unit day still holds both entries',
    window.__rs1.log.length === 2 && window.__rs1.log.some(e => e.u === 'pct'));

  // --- (2) removal of the day's only entry: the counter falls ---
  runInWindow(`openDetail('rs2');`);
  ok('remove-entry button present for rs2', !!q('#m-rmlog'));
  q('#m-rmlog').click();
  await sleep(30);
  ok('entry removed for rs2', (window.__rs2.log || []).length === 0);
  ok('readSessions falls when the day loses its last entry', window.__rs2.readSessions === 0);
  if (q('#m-x')) q('#m-x').click();

  // --- (3) removal of one unit's entry: the day still counts ---
  runInWindow(`openDetail('rs3');`);
  ok('remove-entry button present for rs3', !!q('#m-rmlog'));
  q('#m-rmlog').click();
  await sleep(30);
  ok('only the current-unit (pct) entry was removed',
    window.__rs3.log.length === 1 && window.__rs3.log[0].u !== 'pct');
  ok('readSessions holds while the day still has an entry', window.__rs3.readSessions === 1);
  if (q('#m-x')) q('#m-x').click();

  console.log('read-sessions: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
