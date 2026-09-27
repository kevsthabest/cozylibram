// "More like this" (v110): similarBooks ranks owned books by shared tropes,
// genres, author, and spice closeness; the detail modal shows the strip.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in more-like-this tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

runInWindow(`library = [
  { id: 'base', title: 'Base Book', authors: ['Ann Author'], status: 'read', cover: '',
    tropes: ['enemies to lovers', 'forced proximity'], categories: ['Dark Romance'],
    ratings: { spice: 4 }, myRating: 5 },
  { id: 's1', title: 'Two Tropes', authors: ['Other Writer'], status: 'tbr', cover: '',
    tropes: ['enemies to lovers', 'forced proximity'], categories: ['Thriller'],
    ratings: { spice: 1 }, myRating: 0 },
  { id: 's2', title: 'Same Author', authors: ['Ann Author'], status: 'tbr', cover: '',
    tropes: ['second chance'], categories: ['Thriller'], ratings: {}, myRating: 0 },
  { id: 's3', title: 'One Trope Close Spice', authors: ['Third Writer'], status: 'tbr', cover: '',
    tropes: ['forced proximity'], categories: ['Thriller'], ratings: { spice: 4 }, myRating: 0 },
  { id: 's4', title: 'Unrelated', authors: ['Fourth'], status: 'tbr', cover: '',
    tropes: ['cozy mystery'], categories: ['Mystery'], ratings: {}, myRating: 0 },
];`);
runInWindow(`window.__sims = similarBooks(library[0], 6).map(b => b.id);`);
// s1: 2 tropes = 6 pts. s2: same author = 4 pts. s3: 1 trope (3) + spice closeness
// (3 - |4-4| = 3) = 6 pts — ties s1, alphabetical tiebreak puts s3 first.
ok('ranks by signal strength (tropes > author > nothing)',
  JSON.stringify(window.__sims) === JSON.stringify(['s3', 's1', 's2']));
ok('the book itself is excluded', !window.__sims.includes('base'));
ok('unrelated books are excluded', !window.__sims.includes('s4'));

runInWindow(`window.__none = similarBooks(
  { id: 'x', title: 'X', authors: ['Nobody'], tropes: [], categories: [], ratings: {} }, 6);`);
ok('no signals -> no matches', window.__none.length === 0);

runInWindow(`window.__lim = similarBooks(library[0], 2).length;`);
ok('limit is honored', window.__lim === 2);

// the detail modal renders the strip with tappable covers
runInWindow(`openDetail('base');`);
const simBtns = window.document.querySelectorAll('[data-sim]');
ok('detail modal shows the similar-books strip',
  simBtns.length === 3 && simBtns[0].dataset.sim === 's3');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
