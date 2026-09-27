// Tests for v129 — accessibility pass (UI Improvement Pass, section 15).
//
// Covered: book modal is a labelled dialog (role/aria-modal/aria-label);
// the close button has an accessible name; Escape closes the book modal;
// Escape skips the onboarding tour; the onboarding overlay is a labelled
// dialog; global :focus-visible styling and a global reduced-motion rule
// exist in the stylesheet.

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
const escKey = () => window.document.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

// --- book modal ---
run(`library = [
  { id: 'b1', title: 'Test Book', authors: ['A'], status: 'tbr', progress: 0,
    pageCount: 200, cover: '', tropes: [], genres: [], myRating: 0,
    ratings: {}, axes: [], favorite: false, notes: '' }
];
openDetail('b1');`);
const dlg = q('#m-back .modal');
ok('modal: role=dialog', dlg && dlg.getAttribute('role') === 'dialog');
ok('modal: aria-modal + accessible label',
  dlg.getAttribute('aria-modal') === 'true' && !!dlg.getAttribute('aria-label'));
ok('modal: close button named', q('#m-x').getAttribute('aria-label') === 'Close');

escKey();
ok('modal: Escape closes it', !q('#m-back .modal'));

// --- onboarding ---
run(`try { localStorage.removeItem('spicyshelves.onboarded'); } catch (e) {}
library = []; maybeOnboard();`);
const ov = q('#onb-overlay');
ok('onboarding: role=dialog', ov.getAttribute('role') === 'dialog');
ok('onboarding: aria-modal + label',
  ov.getAttribute('aria-modal') === 'true' && !!ov.getAttribute('aria-label'));
escKey();
ok('onboarding: Escape skips the tour',
  !q('#onb-overlay') && run(`onboarded()`) === true);

// --- stylesheet ---
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
ok('css: :focus-visible rule', /:focus-visible\s*\{[^}]*outline/.test(css));
ok('css: global reduced-motion kill-switch',
  /prefers-reduced-motion:\s*reduce[\s\S]*?\*\s*,\s*\*::before/.test(css));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
