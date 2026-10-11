// Tests for v455 — Trigger check on Start Reading: one-time gentle heads-up
// for TBR books with content warnings. Never a gate.

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

/* triggerCheckNeeded: pure gating logic */
{
  ok('false when no warnings',
    run(`triggerCheckNeeded({ id: 'a', contentWarnings: [] })`) === false);
  ok('false when warnings missing entirely',
    run(`triggerCheckNeeded({ id: 'b' })`) === false);
  ok('false when already seen',
    run(`triggerCheckNeeded({ id: 'c', contentWarnings: ['Violence'], triggerCheckSeen: true })`) === false);
  ok('true when warnings present and not seen',
    run(`triggerCheckNeeded({ id: 'd', contentWarnings: ['Violence', 'Death'] })`) === true);
  ok('false for null book', run(`triggerCheckNeeded(null)`) === false);
  ok('false for undefined book', run(`triggerCheckNeeded(undefined)`) === false);
}

/* Sheet rendering + one-time behavior */
{
  // silence saveLibrary side effects if any; keep the flag write itself
  run(`if (typeof saveLibrary !== 'function') { saveLibrary = function(){}; }`);

  const opened = run(`(function () {
    const b = { id: 'e', title: 'Test Book', contentWarnings: ['Violence', 'Gore'] };
    openTriggerCheckSheet(b, function () {});
    return {
      sheet: !!document.querySelector('.tc-sheet'),
      tags: document.querySelectorAll('.tc-sheet .warn-tag').length,
      seen: !!b.triggerCheckSeen,
      title: document.querySelector('.tc-sheet .tc-sub').textContent,
    };
  })()`);
  ok('sheet opens in DOM', opened.sheet === true);
  ok('warning tags rendered', opened.tags === 2);
  ok('seen flag set on open (one-time)', opened.seen === true);
  ok('book title mentioned', opened.title.indexOf('Test Book') !== -1);

  // "Start anyway" fires the callback
  const started = run(`(function () {
    let fired = false;
    document.getElementById('tcStart').click();
    // sheet closes async; check the callback fired synchronously on click
    return (function () { return window.__tcFired === true || document.querySelector('.tc-sheet') !== null; })();
  })()`);
  // simpler: re-open fresh and click Start anyway with a flag
  run(`document.querySelectorAll('.tc-sheet').forEach(function (el) { el.remove(); });
       document.querySelectorAll('#tcScrim').forEach(function (el) { el.remove(); });`);
  const startFired = run(`(function () {
    const b = { id: 'f', title: 'Start Me', contentWarnings: ['Death'] };
    let fired = false;
    openTriggerCheckSheet(b, function () { fired = true; });
    document.getElementById('tcStart').click();
    return fired;
  })()`);
  ok('"Start anyway" runs onStart', startFired === true);

  // "Not now" dismisses without firing onStart — and the book stays put
  run(`document.querySelectorAll('.tc-sheet').forEach(function (el) { el.remove(); });
       document.querySelectorAll('#tcScrim').forEach(function (el) { el.remove(); });`);
  const laterResult = run(`(function () {
    const b = { id: 'g', title: 'Later Book', status: 'tbr', contentWarnings: ['Violence'] };
    let fired = false;
    openTriggerCheckSheet(b, function () { fired = true; });
    document.getElementById('tcLater').click();
    return { fired: fired, status: b.status, seen: !!b.triggerCheckSeen };
  })()`);
  ok('"Not now" does not start reading', laterResult.fired === false && laterResult.status === 'tbr');
  ok('"Not now" still marks seen (respects dismissal)', laterResult.seen === true);

  // Dedup: no stacked sheets
  run(`document.querySelectorAll('.tc-sheet').forEach(function (el) { el.remove(); });
       document.querySelectorAll('#tcScrim').forEach(function (el) { el.remove(); });`);
  const dedup = run(`(function () {
    const b = { id: 'h', title: 'Dedup', contentWarnings: ['Violence'] };
    openTriggerCheckSheet(b, function () {});
    openTriggerCheckSheet(b, function () {});
    return document.querySelectorAll('.tc-sheet').length;
  })()`);
  ok('no stacked sheets on double-open', dedup === 1);
  run(`document.querySelectorAll('.tc-sheet').forEach(function (el) { el.remove(); });
       document.querySelectorAll('#tcScrim').forEach(function (el) { el.remove(); });`);
}

/* Wiring: new file is in the load order */
{
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('index.html loads 221-trigger-check.js', idx.indexOf('js/221-trigger-check.js') !== -1);
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok('sw.js precaches 221-trigger-check.js', sw.indexOf('221-trigger-check.js') !== -1);
  ok('functions are global', run(`typeof triggerCheckNeeded === 'function' && typeof openTriggerCheckSheet === 'function'`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
