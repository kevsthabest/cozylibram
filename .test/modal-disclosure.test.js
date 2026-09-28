// Tests for v174 — tabbed book detail (UI mockup, Book Details panel).
//
// Replaces the v124 progressive-disclosure test: the modal is now a hero
// (back button, big cover, title/author/stars/meta) plus Details | Tropes |
// Notes tabs. Covered: hero content, tab switching, every control keeps its
// ID on the right tab, Save persists edits made while another tab is active,
// the visible Remove button uses the existing delete flow.

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
    progress: 40, pageCount: 200, isbn: '9781250123456', publishedDate: '2021-05-01',
    cover: '', tropes: ['enemies to lovers'], publicRating: 4.2, ratingsCount: 100,
    genres: [], myRating: 0, ratings: {}, axes: [], favorite: false,
    notes: 'old notes', description: 'A great book.', quotes: [],
    log: [{ d: '2026-09-20', from: 10, to: 40 }] }
]; openDetail('b1');`);

// --- 1. Hero: back button, big cover, title, author, stars, meta row ---
ok('hero: back button keeps the close affordance',
  !!q('#m-x') && q('#m-x').getAttribute('aria-label') === 'Close');
ok('hero: title rendered', q('.d-hero h2').textContent === 'Test Book');
ok('hero: author rendered', q('.d-hero .author').textContent.includes('Author'));
ok('hero: big cover present', !!q('.d-hero .d-cover .cover-wrap'));
ok('hero: meta row shows pages + year + ISBN', (() => {
  const t = q('.d-hero .d-meta').textContent;
  return t.includes('200 pages') && t.includes('2021') && t.includes('9781250123456');
})());
ok('hero: public stars shown', q('.d-hero .pub-rating').textContent.includes('★★★★'));
// --- v179: desktop panel — hero text wrapped for the two-column layout ---
ok('hero text wrapped for the desktop two-column panel (v179)', !!q('.d-hero .d-hero-text h2'));
ok('desktop panel CSS present (v179)', (() => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  return css.includes('.modal.detail-v174') && css.includes('.d-hero-text') &&
    css.includes('padding: 26px 120px 26px 34px');
})());

// --- 2. Tabs exist; Details active, others hidden ---
const tabs = qa('.d-tab').map(t => t.textContent);
ok('tabs: Details | Tropes | Notes', JSON.stringify(tabs) === JSON.stringify(['Details', 'Tropes', 'Notes']));
ok('tabs: Details active by default',
  q('.d-tab[data-dtab="details"]').classList.contains('active') && !q('#dtab-details').hidden);
ok('tabs: Tropes + Notes start hidden', q('#dtab-tropes').hidden && q('#dtab-notes').hidden);

// --- 3. Priority content: hero + Details tab + action bar ---
['#f-myrating', '#m-progress', '#f-status'].forEach(id =>
  ok('details tab: ' + id + ' present', !!q('#dtab-details ' + id)));
ok('action bar intact with primary action', !!q('#m-primary'));
ok('details tab: reading log lists the session',
  q('#m-loglist').textContent.includes('30 pages'));
ok('details tab: visible Remove button', !!q('#m-del2'));

// --- 4. Tropes + Notes tabs hold their controls ---
q('[data-dtab="tropes"]').click();
ok('tab switch: Tropes shows, Details hides', !q('#dtab-tropes').hidden && q('#dtab-details').hidden);
['#f-tropes', '#f-tropesugg', '#m-tropedb', '#m-tropepropose'].forEach(id =>
  ok('tropes tab: ' + id + ' present', !!q('#dtab-tropes ' + id)));
q('[data-dtab="notes"]').click();
ok('tab switch: Notes shows, Tropes hides', !q('#dtab-notes').hidden && q('#dtab-tropes').hidden);
['#f-notes', '#m-quotes'].forEach(id =>
  ok('notes tab: ' + id + ' present', !!q('#dtab-notes ' + id)));

// --- 5. Every control survived the move ---
['#f-tropes', '#f-pagecount', '#f-progress', '#f-releasedate', '#f-notes',
 '#m-upnext', '#f-owned', '#m-hc', '#m-quotes', '#m-buywrap', '#m-changecover',
 '#m-desc', '#m-loglist', '#f-axrows'
].forEach(id => ok('control kept: ' + id, !!q(id)));

// --- 6. Save persists edits made while another tab is active ---
run(`document.getElementById('f-notes').value = 'new notes';`);
q('[data-dtab="tropes"]').click();
run(`document.getElementById('f-tropes').value = 'forced proximity';`);
q('[data-dtab="details"]').click();
run(`document.getElementById('m-save').click();`);
ok('save: notes persisted from the Notes tab', run(`library[0].notes`) === 'new notes');
ok('save: tropes persisted from the Tropes tab',
  JSON.stringify(run(`library[0].tropes`)) === JSON.stringify(['forced proximity']));

// --- 7. Visible Remove button triggers the delete flow ---
run(`openDetail('b1');`);
let confirmed = false;
window.confirm = () => { confirmed = true; return false; }; // cancel the confirm
q('#m-del2').click();
ok('remove button asks for confirmation', confirmed);
ok('cancel keeps the book', run(`library.length`) === 1 && !!q('#m-back'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
