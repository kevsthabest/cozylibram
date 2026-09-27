// Tests for v124 — progressive disclosure in the book modal (UI Improvement
// Pass, section 6).
//
// Covered: priority content (cover/title/author, progress, shelf, ratings,
// primary action) stays visible; Details / Series & Discovery / Personal /
// Ownership collapse behind labeled sections; every control keeps its ID and
// Save still persists edits made while sections are collapsed.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));

run(`library = [
  { id: 'b1', title: 'Test Book', authors: ['Author'], status: 'reading',
    progress: 40, pageCount: 200, cover: '', tropes: ['enemies to lovers'],
    genres: [], myRating: 0, ratings: {}, axes: [], favorite: false,
    notes: 'old notes', description: 'A great book.', quotes: [] }
]; openDetail('b1');`);

// --- 1. Priority content is visible (not inside a collapsed details) ---
function inClosedDetails(el) {
  let d = el.closest('details');
  while (d) { if (!d.open) return true; d = d.parentElement.closest('details'); }
  return false;
}
ok('priority: progress section visible', !!q('#m-progress') && !inClosedDetails(q('#m-progress')));
ok('priority: shelf seg visible', !!q('#f-status') && !inClosedDetails(q('#f-status')));
ok('priority: my rating visible', !!q('#f-myrating') && !inClosedDetails(q('#f-myrating')));
ok('priority: primary action visible', !!q('#m-primary') && !inClosedDetails(q('#m-primary')));

// --- 2. Collapsible sections exist, labeled, closed by default ---
const secs = ['m-sec-details', 'm-sec-discovery', 'm-sec-personal', 'm-sec-owned'];
ok('disclosure: four labeled sections',
  secs.every(id => { const s = q('#' + id); return s && s.tagName === 'DETAILS' && s.querySelector('summary').textContent.trim().length > 3; }));
ok('disclosure: sections start closed', secs.every(id => !q('#' + id).open));
ok('disclosure: priority precedes collapsed sections in the DOM', (() => {
  const html = q('#modal-root').innerHTML;
  return html.indexOf('f-myrating') < html.indexOf('m-sec-details');
})());

// --- 3. Every control survived the move ---
['#f-tropes', '#f-pagecount', '#f-progress', '#f-releasedate', '#f-notes',
 '#m-upnext', '#f-owned', '#m-hc', '#m-quotes', '#m-buywrap', '#m-changecover'
].forEach(id => ok('control kept: ' + id, !!q(id)));

// --- 4. Save persists edits made while sections stay collapsed ---
run(`document.getElementById('f-notes').value = 'new notes';
     document.getElementById('f-tropes').value = 'forced proximity';
     document.getElementById('m-save').click();`);
ok('save: notes persisted from collapsed section', run(`library[0].notes`) === 'new notes');
ok('save: tropes persisted from collapsed section',
  JSON.stringify(run(`library[0].tropes`)) === JSON.stringify(['forced proximity']));

// --- 5. Quotes collapsible still works alongside the new sections ---
run(`openDetail('b1');`);
ok('quotes: still its own collapsible', (() => {
  const s = Array.from(qa('#modal-root details')).find(d =>
    d.querySelector('summary').textContent.includes('Quotes'));
  return !!s;
})());

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
