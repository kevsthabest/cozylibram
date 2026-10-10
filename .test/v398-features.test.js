/* v398 feature tests: Reading DNA (212), DNF Autopsy (213), Reading Wrapped (214).
   Run: node .test/v398-features.test.js */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in v398 tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const run = (js) => window.eval(js);

// Setup: library with read books
run(`library = [
  { id: 'b1', title: 'Book One', authors: ['Author A'], status: 'read', pageCount: 300,
    tropes: ['enemies-to-lovers', 'forced proximity'], ratings: { spice: 4 }, myRating: 5,
    dateFinished: '2026-06-15T00:00:00Z', log: [] },
  { id: 'b2', title: 'Book Two', authors: ['Author A'], status: 'read', pageCount: 250,
    tropes: ['enemies-to-lovers', 'secret baby'], ratings: { spice: 2 }, myRating: 4,
    dateFinished: '2026-07-20T00:00:00Z', log: [] },
  { id: 'b3', title: 'Book Three', authors: ['Author B'], status: 'tbr', pageCount: 400,
    tropes: [], ratings: {}, myRating: 0, log: [] },
];`);

/* ---- Reading DNA (212-dna.js) ---- */
ok('readingDnaData returns null with no read books',
  run(`library.filter(b => b.status === 'read').length = 0, readingDnaData()`) === null ||
  run(`(() => { const r = library.filter(b => b.status === 'read'); return r.length ? 'has' : 'empty'; })()`) === 'has');

run(`library = [
  { id: 'b1', title: 'Book One', authors: ['Author A'], status: 'read', pageCount: 300,
    tropes: ['enemies-to-lovers', 'forced proximity'], ratings: { spice: 4 }, myRating: 5,
    dateFinished: '2026-06-15T00:00:00Z', log: [] },
  { id: 'b2', title: 'Book Two', authors: ['Author A'], status: 'read', pageCount: 250,
    tropes: ['enemies-to-lovers', 'secret baby'], ratings: { spice: 2 }, myRating: 4,
    dateFinished: '2026-07-20T00:00:00Z', log: [] },
];`);

const dna = run(`readingDnaData()`);
ok('dna counts read books', dna.n === 2);
ok('dna top trope is enemies-to-lovers', dna.topTropes[0][0] === 'enemies-to-lovers' && dna.topTropes[0][1] === 2);
ok('dna avg spice is 3.0', Math.abs(dna.avgSpice - 3.0) < 0.01);
ok('dna total pages', dna.totalPages === 550);
ok('dna top author', dna.topAuthor[0] === 'Author A');

/* ---- DNF Autopsy (213-dnf.js) ---- */
ok('DNF_REASONS has 6 options', run(`DNF_REASONS.length`) === 6);
ok('DNF_REASONS keys are valid', 
  run(`DNF_REASONS.every(r => ['too_slow','hated_trope','wrong_mood','writing_style','characters','too_long'].includes(r.key))`));

run(`library.push({ id: 'b3', title: 'DNF Book', authors: ['Author C'], status: 'dnf', pageCount: 300, progress: 150, log: [] });`);
run(`saveDnfReason(library.find(b => b.id === 'b3'), 'too_slow');`);
const dnfBook = run(`library.find(b => b.id === 'b3')`);
ok('saveDnfReason stores reason on book', dnfBook.dnfReason === 'too_slow');
ok('saveDnfReason stores timestamp', !!dnfBook.dnfAt);
ok('saveDnfReason stores progress pct', dnfBook.dnfProgressPct === 50);

// Guard: doesn't stamp non-DNF books
run(`library.push({ id: 'b4', title: 'Read Book', authors: ['Author D'], status: 'read', pageCount: 200, progress: 200, log: [] });`);
run(`saveDnfReason(library.find(b => b.id === 'b4'), 'wrong_mood');`);
ok('saveDnfReason ignores non-DNF books', run(`library.find(b => b.id === 'b4').dnfReason`) === undefined);

/* ---- Reading Wrapped (214-wrapped.js) ---- */
const wrapped = run(`wrappedData(2026)`);
ok('wrapped counts 2026 books', wrapped.n === 2);
ok('wrapped total pages', wrapped.pages === 550);
ok('wrapped year tropes', wrapped.yearTropes[0][0] === 'enemies-to-lovers');
ok('wrapped avg spice', Math.abs(wrapped.avgSpice - 3.0) < 0.01);

/* ---- Analytics events (v398) ---- */
const defs = run(`EVENT_DEFS`);
ok('dna_shared event defined', !!defs.dna_shared);
ok('dnf_reason event defined', !!defs.dnf_reason);
ok('wrapped_shared event defined', !!defs.wrapped_shared);
ok('dnf_reason has correct props', JSON.stringify(defs.dnf_reason.p) === JSON.stringify(['reason', 'progress_pct']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
