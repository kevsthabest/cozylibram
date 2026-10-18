// Series-finale duplicate-edition regression tests — issue #367.
// finaleKindFor's 'complete' verdict counted book RECORDS against the
// listing total, so duplicate editions of one volume substituted for a
// missing volume: two copies of position 1 + position 3 (position 2
// never owned) against a total of 3 returned 'complete' and earned the
// wax seal. The verdict now counts DISTINCT positions. The seal's
// honesty rule (series-finale.test.js) is the spec: complete only when
// the reader owns everything the listing holds.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in finale-duplicates tests'); };
require('./harness').loadApp(window);
const run = (code) => window.eval(code);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const book = (id, position) => ({
  id, title: 'Saga ' + id, authors: ['Ann Author'], status: 'read',
  myRating: 5, pageCount: 300, dateFinished: '2025-01-10T00:00:00.000Z',
  series: { name: 'The Test Saga', position }
});
const kind = (books, finId, listing) => {
  run(`library = ${JSON.stringify(books)}`);
  return run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), '${finId}', ${JSON.stringify(listing)})`);
};

// The filed reproduction: positions 1, 1 (two editions), 3 — volume 2
// never owned — against a listing of 3.
ok('duplicate editions cannot substitute for a missing volume',
  kind([book('d1a', 1), book('d1b', 1), book('d3', 3)], 'd3', { total: 3, maxPos: 3 }) === 'caughtup');
ok('no wax seal for the duplicate-edition shelf',
  run(`finaleHasSeal({ kind: 'caughtup' })`) === false &&
  kind([book('d1a', 1), book('d1b', 1), book('d3', 3)], 'd3', { total: 3, maxPos: 3 }) !== 'complete');

// Controls: genuinely complete shelves still earn 'complete'.
ok('positions 1, 2, 3 owned -> complete (control)',
  kind([book('c1', 1), book('c2', 2), book('c3', 3)], 'c3', { total: 3, maxPos: 3 }) === 'complete');
ok('duplicates of every volume, all positions held -> complete',
  kind([book('e1a', 1), book('e1b', 1), book('e2', 2), book('e3', 3)], 'e3', { total: 3, maxPos: 3 }) === 'complete');
// Position-less records keep counting individually (positions are
// metadata garnish; nothing to dedupe them against).
ok('position-less series of 3 against total 3 -> complete (unchanged)',
  kind([book('n1', null), book('n2', null), book('n3', null)], 'n3', { total: 3, maxPos: null }) === 'complete');

console.log('finale-duplicates: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
