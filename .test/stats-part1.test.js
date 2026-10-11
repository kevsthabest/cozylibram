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

// v480: regional currency. Pin the test locale to en-CA so the CAD default
// (24.99) holds for the estimates below; the mapping tests further down
// exercise other locales explicitly.
const setLang = (l) => window.eval(`Object.defineProperty(navigator, 'language', { value: '${l}', configurable: true });`);
setLang('en-CA');

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

// ---- Regional currency (v480) ----
// locale -> currency mapping; per-market defaults; formatting.
ok('userCurrency maps en-US to USD', (setLang('en-US'), run(`userCurrency()`)) === 'USD');
ok('userCurrency maps en-CA to CAD', (setLang('en-CA'), run(`userCurrency()`)) === 'CAD');
ok('userCurrency maps fr-CA to CAD', (setLang('fr-CA'), run(`userCurrency()`)) === 'CAD');
ok('userCurrency maps en-GB to GBP', (setLang('en-GB'), run(`userCurrency()`)) === 'GBP');
ok('userCurrency maps de-DE to EUR', (setLang('de-DE'), run(`userCurrency()`)) === 'EUR');
ok('userCurrency maps bare fr to EUR', (setLang('fr'), run(`userCurrency()`)) === 'EUR');
ok('userCurrency maps es-MX to MXN', (setLang('es-MX'), run(`userCurrency()`)) === 'MXN');
ok('userCurrency maps ja-JP to JPY', (setLang('ja-JP'), run(`userCurrency()`)) === 'JPY');
ok('userCurrency maps en-AU to AUD', (setLang('en-AU'), run(`userCurrency()`)) === 'AUD');
ok('userCurrency defaults unknown locales to CAD', (setLang('xx-YY'), run(`userCurrency()`)) === 'CAD');

ok('estimateBookValue uses the USD default for en-US',
  (setLang('en-US'), run(`estimateBookValue({}).value`)) === 19.99);
ok('estimateBookValue uses the EUR default for de-DE',
  (setLang('de-DE'), run(`estimateBookValue({}).value`)) === 17.99);
ok('purchasePrice is never converted, only the default is regional',
  (setLang('de-DE'), run(`estimateBookValue({ purchasePrice: 15.99 }).value`)) === 15.99);

ok('formatMoney formats USD with $', (setLang('en-US'), run(`formatMoney(19.99)`)) === '$19.99');
ok('formatMoney formats EUR with €', (setLang('de-DE'), run(`formatMoney(19.99)`)).includes('€'));
ok('formatMoney formats GBP with £', (setLang('en-GB'), run(`formatMoney(14.99)`)) === '£14.99');
ok('formatMoney honors digits: 0', (setLang('en-US'), run(`formatMoney(65.97, { digits: 0 })`)) === '$66');
ok('formatMoney handles zero safely', (setLang('en-US'), run(`formatMoney(0)`)) === '$0.00');

// restore the pinned locale for the render test below
setLang('en-CA');

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
