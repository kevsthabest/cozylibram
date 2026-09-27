// Layout toggle (v57): the Library toolbar's grid/list switch renders, flips
// the book list between Bookmory-style tiles and book cards, and persists the
// choice. Grid is the default.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in layout tests'); };
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

runInWindow(`localStorage.setItem('spicyshelves.animation', 'off');
  library.push({ id: 'l1', title: 'L1', authors: ['A'], cover: '', status: 'read', owned: true,
    tropes: [], ratings: {}, myRating: 0, progress: 0 });
  renderLibrary();`);

// default is grid
ok('toggle renders both buttons', !!q('.view-toggle button[data-l="list"]') && !!q('.view-toggle button[data-l="grid"]'));
ok('grid is the default view', !!q('.book-grid .book-tile'));
ok('grid button marked active', q('.view-toggle button[data-l="grid"]').classList.contains('active'));

// flip to list
q('.view-toggle button[data-l="list"]').click();
ok('list click swaps to book cards', !!q('.grid .book-card') && !q('.book-grid'));
ok('list button marked active', q('.view-toggle button[data-l="list"]').classList.contains('active'));
ok('choice persisted', window.localStorage.getItem('spicyshelves.layout') === 'list');

// flip back to grid
q('.view-toggle button[data-l="grid"]').click();
ok('grid click swaps back to tiles', !!q('.book-grid .book-tile') && !q('.grid'));
ok('grid choice persisted', window.localStorage.getItem('spicyshelves.layout') === 'grid');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
