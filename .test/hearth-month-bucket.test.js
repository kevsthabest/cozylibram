// Hearth month-bucket regression tests — issue #368.
// In pagesInRangeFor's no-page-logs fallback (js/197), a finished book
// was bucketed by its UTC calendar date (slicing the ISO string), while
// every sibling aggregate uses LOCAL days (monthBooks via statMonthKey,
// streaks via statDayKey). A book finished Sep 30 23:30 local in
// America/Halifax is 2026-10-01T02:30Z: monthBooks counted it in
// September, the fallback added its pages to October. The fallback now
// buckets by statDayKey (local), so a book and its pages land in the
// same month. TZ is forced before anything reads a Date.
process.env.TZ = 'America/Halifax';

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in hearth-month tests'); };
require('./harness').loadApp(window);
const run = (code) => window.eval(code);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

// Sanity: the forced zone really applies (elsewhere this suite would
// pass vacuously on a UTC host).
ok('TZ is America/Halifax (UTC instant maps to the previous local day)',
  run(`statDayKey(new Date('2026-10-01T02:30:00.000Z'))`) === '2026-09-30');

// No page logs anywhere -> the estimated fallback is the path under test.
const books = [{
  id: 'h1', title: 'Late Finish', status: 'read', pageCount: 300, log: [],
  dateFinished: '2026-10-01T02:30:00.000Z' // Sep 30, 23:30 in Halifax
}];
run(`window.__hb = ${JSON.stringify(books)};`);

const sep = run(`pagesInRangeFor(window.__hb, '2026-09-01', '2026-09-30')`);
const oct = run(`pagesInRangeFor(window.__hb, '2026-10-01', '2026-10-31')`);
ok('fallback is the estimated path', sep.estimated === true);
ok('pages land in September, the local finish month', sep.pages === 300);
ok('no pages leak into October', oct.pages === 0);

// Mirror edge: a finish just after local midnight on the 1st
// (Sep 30 21:30 UTC = Oct 1 00:30... in Halifax UTC-3: 2026-10-01T03:30Z
// is Oct 1 00:30 local) belongs to October on both sides.
const books2 = [{
  id: 'h2', title: 'Early Finish', status: 'read', pageCount: 200, log: [],
  dateFinished: '2026-10-01T03:30:00.000Z' // Oct 1, 00:30 in Halifax
}];
run(`window.__hb2 = ${JSON.stringify(books2)};`);
const sep2 = run(`pagesInRangeFor(window.__hb2, '2026-09-01', '2026-09-30')`);
const oct2 = run(`pagesInRangeFor(window.__hb2, '2026-10-01', '2026-10-31')`);
ok('post-midnight local finish stays out of September', sep2.pages === 0);
ok('post-midnight local finish lands in October', oct2.pages === 200);

console.log('hearth-month-bucket: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
