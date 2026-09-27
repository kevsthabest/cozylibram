// Tests for v128 — stats dashboard (UI Improvement Pass, section 12).
//
// Covered: the stats tab opens on a dashboard (this month's hero cards,
// streak, currently-reading, shelf distribution) with an "Explore detailed
// stats" entry point; detailed sections (heatmap, calendar, rating
// distribution, records…) are NOT on the dashboard; tapping through shows
// the full explorer with a back-to-dashboard button; nothing was removed.

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
const viewHTML = () => q('#view').innerHTML;

const now = new Date();
const iso = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
run(`library = [
  { id: 'b1', title: 'Done', authors: ['A'], status: 'read', cover: '',
    tropes: [], genres: [], myRating: 4, ratings: {}, axes: [], favorite: false,
    progress: 300, pageCount: 300, dateFinished: '${iso}', notes: '' },
  { id: 'b2', title: 'Reading', authors: ['A'], status: 'reading', cover: '',
    tropes: [], genres: [], myRating: 0, ratings: {}, axes: [], favorite: false,
    progress: 50, pageCount: 200, notes: '' },
  { id: 'b3', title: 'TBR', authors: ['A'], status: 'tbr', cover: '',
    tropes: [], genres: [], myRating: 0, ratings: {}, axes: [], favorite: false,
    progress: 0, pageCount: 0, notes: '' }
];
statsMode = 'dash';
renderStats();`);

// --- 1. Dashboard content ---
const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
ok('dash: month header', viewHTML().includes(monthName));
ok('dash: hero cards (books, pages, rating, time)',
  /Books finished/.test(viewHTML()) && /Avg rating/.test(viewHTML()) &&
  /Reading time/.test(viewHTML()) && /stat hero/.test(viewHTML()));
ok('dash: monthly numbers (1 book, 300 pages, 4.0, ~5h)',
  / 1<\/div>/.test(viewHTML()) && / 300<\/div>/.test(viewHTML()) &&
  /♥ 4\.0/.test(viewHTML()) && /~5h/.test(viewHTML()));
ok('dash: currently-reading strip kept', /Currently reading/.test(viewHTML()));
ok('dash: shelf distribution kept', /Shelves/.test(viewHTML()));
ok('dash: explore entry point', !!q('#st-explore'));

// --- 2. Detail sections NOT on the dashboard ---
ok('dash: heatmap hidden', !q('#heatmap'));
ok('dash: reading calendar hidden', !q('#readcal'));
ok('dash: rating distribution hidden', !/Rating distribution/i.test(viewHTML()));

// --- 3. Explore -> detail ---
q('#st-explore').click();
ok('detail: full explorer renders', !!q('#heatmap') && !!q('#readcal'));
ok('detail: yearly overview kept', /Read in /.test(viewHTML()));
ok('detail: back-to-dashboard button', !!q('#st-backdash'));

// --- 4. Back -> dashboard ---
q('#st-backdash').click();
ok('dash: back returns to dashboard', !!q('#st-explore') && !q('#heatmap'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
