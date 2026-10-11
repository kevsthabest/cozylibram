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

// ---- Library value: automated estimates (v476) ----
// estimateBookValue() is global: purchasePrice wins when present, otherwise
// the flat estimate default. No opt-in gate — always shown, labeled estimate.

ok('estimateBookValue prefers purchasePrice',
  run(`estimateBookValue({ purchasePrice: 15.99 }).value`) === 15.99 &&
  run(`estimateBookValue({ purchasePrice: 15.99 }).actual`) === true);

ok('estimateBookValue falls back to default estimate',
  run(`estimateBookValue({}).value`) === 24.99 &&
  run(`estimateBookValue({}).actual`) === false);

ok('estimateBookValue respects stored defaultPrice',
  run(`try { localStorage.setItem('cozylibram.defaultPrice', '19.99'); } catch (e) {};
        estimateBookValue({}).value`) === 19.99);
run(`try { localStorage.removeItem('cozylibram.defaultPrice'); } catch (e) {}`);

run(`library = [
  { id: 'b1', title: 'Priced', status: 'read', purchasePrice: 15.99 },
  { id: 'b2', title: 'Unpriced', status: 'read' },
  { id: 'b3', title: 'Unpriced 2', status: 'read' },
];`);
run(`statsMode = 'dash'; renderStats();`);
const dashHTML = window.document.querySelector('#view').innerHTML;

// 15.99 + 24.99 + 24.99 = 65.97 → ≈ $66
ok('stats shows estimate total (purchase + defaults)',
  dashHTML.includes('≈ $66'));

ok('stats labels it an estimate',
  dashHTML.includes('Estimated collection value'));

ok('stats shows value without opt-in (no gate)',
  dashHTML.includes('Library value'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
