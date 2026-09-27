// v56: grid view temporarily removed — the Library always renders the list
// view (book cards); there is no grid/list toggle.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in layout tests'); };
window.matchMedia = () => ({ matches: false });
// Stale grid preference from before v56 — must be ignored.
window.localStorage.setItem('spicyshelves.layout', 'grid');

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
    tropes: [], ratings: {}, myRating: 0, progress: 0 });`);

ok('layout forced to list even with a stale grid preference',
  (() => { runInWindow(`window.__layoutCheck = layout;`); return window.__layoutCheck === 'list'; })());
window.renderLibrary();
ok('no view toggle rendered', !q('.view-toggle'));
ok('renders book cards, not cover tiles', !!q('.grid .book-card') && !q('.covers'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
