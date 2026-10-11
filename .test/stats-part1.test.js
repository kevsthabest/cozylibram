// Tests for v454 — Stats Part 1 bug fixes.
//
// Covered:
// - pagesInRange(start, end) sums logged pages only, within date range
// - Library value: purchasePrice wins over listPrice, never both, no invented defaults

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

// ---- pagesInRange ----
run(`library = [
  { id: 'b1', title: 'Book 1', status: 'read',
    log: [{ d: '2026-01-15', from: 0, to: 100 }, { d: '2026-02-20', from: 100, to: 250 }] },
  { id: 'b2', title: 'Book 2', status: 'read',
    log: [{ d: '2026-03-10', from: 0, to: 50 }] },
  { id: 'b3', title: 'Book 3', status: 'read', log: [] },
];`);

ok('pagesInRange sums all logs in range',
  run(`pagesInRange('2026-01-01', '2026-12-31')`) === 300);

ok('pagesInRange respects start bound',
  run(`pagesInRange('2026-02-01', '2026-12-31')`) === 200);

ok('pagesInRange respects end bound',
  run(`pagesInRange('2026-01-01', '2026-01-31')`) === 100);

ok('pagesInRange returns 0 for empty range',
  run(`pagesInRange('2025-01-01', '2025-12-31')`) === 0);

ok('pagesInYear delegates to pagesInRange',
  run(`pagesInYear(2026)`) === 300);

// ---- Library value: bookValue logic ----
// We test the value accumulation by checking renderStats output.
// bookValue is scoped inside renderStats, so we verify via the DOM.

run(`library = [
  { id: 'b1', title: 'Both prices', status: 'read', purchasePrice: 15.99, listPrice: 29.99 },
  { id: 'b2', title: 'List only', status: 'read', listPrice: 24.99 },
  { id: 'b3', title: 'No price', status: 'read' },
];`);
run(`try { localStorage.setItem('cozylibram.showLibraryValue', '1'); } catch (e) {}`);
run(`statsMode = 'dash'; renderStats();`);
const dashHTML = window.document.querySelector('#view').innerHTML;

// Both prices: 15.99 (purchase wins). List only: 24.99. No price: 0.
// Total est = 15.99 + 24.99 = 40.98 → ≈ $41
ok('value uses purchasePrice when both set (not double-counted)',
  dashHTML.includes('≈ $41') || dashHTML.includes('$40.98'));

ok('no invented default inflates the total',
  !dashHTML.includes('≈ $116') && !dashHTML.includes('≈ $91')); // would be 40.98 + 24.99*3 or *2

// Opt-in: toggle off hides the section
run(`try { localStorage.setItem('cozylibram.showLibraryValue', '0'); } catch (e) {}`);
run(`renderStats();`);
const hiddenHTML = window.document.querySelector('#view').innerHTML;
ok('library value hidden when opt-in is off',
  !hiddenHTML.includes('Library value'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
