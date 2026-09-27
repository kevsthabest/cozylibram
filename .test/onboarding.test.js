// Tests for v127 — lightweight onboarding (UI Improvement Pass, section 10).
//
// Covered: maybeOnboard() shows the 3-step welcome only for brand-new empty
// libraries (never again once dismissed, never for non-empty libraries);
// step navigation works; Skip and each CTA dismiss the overlay and set the
// onboarded flag; CTAs route to the right add tab / settings import group;
// the new analytics events are allowlisted.

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
const clearFlag = () => run(`try { localStorage.removeItem('spicyshelves.onboarded'); } catch (e) {}`);

// --- 1. Shows for a brand-new empty library ---
clearFlag();
run(`library = []; maybeOnboard();`);
ok('onboarding: overlay appears for empty library', !!q('#onb-overlay'));
ok('onboarding: step 1 welcomes + offers three ways in',
  /Welcome to Cozy Libram/.test(q('#onb-overlay').innerHTML) &&
  !!q('#onb-search') && !!q('#onb-scan') && !!q('#onb-import'));
ok('onboarding: skippable from step 1', !!q('#onb-skip'));

// --- 2. Step navigation ---
q('#onb-next') || run(`showOnbStep(1);`);
ok('onboarding: step 2 explains the shelves',
  /Organize your reading/.test(q('#onb-overlay').innerHTML) && /DNF/.test(q('#onb-overlay').innerHTML));
run(`showOnbStep(2);`);
ok('onboarding: step 3 makes it yours + finishes',
  /Make it yours/.test(q('#onb-overlay').innerHTML) && !!q('#onb-done'));

// --- 3. Completing sets the flag and removes the overlay ---
q('#onb-done').click();
ok('onboarding: done dismisses overlay', !q('#onb-overlay'));
ok('onboarding: done sets the flag', run(`onboarded()`) === true);

// --- 4. Never again once dismissed ---
run(`library = []; maybeOnboard();`);
ok('onboarding: stays hidden after dismissal', !q('#onb-overlay'));

// --- 5. Never for non-empty libraries (and marks them onboarded) ---
clearFlag();
run(`library = [{ id: 'b1', title: 'T', authors: [], status: 'tbr' }]; maybeOnboard();`);
ok('onboarding: hidden for existing libraries', !q('#onb-overlay'));
ok('onboarding: existing libraries marked onboarded', run(`onboarded()`) === true);

// --- 6. Skip path ---
clearFlag();
run(`library = []; maybeOnboard();`);
q('#onb-skip').click();
ok('onboarding: skip dismisses + flags', !q('#onb-overlay') && run(`onboarded()`) === true);

// --- 7. CTA routing ---
clearFlag();
run(`library = []; maybeOnboard();`);
run(`window.__went = null; window.__realGo2 = go; go = function(v) { window.__went = v; };`);
q('#onb-search').click();
ok('onboarding: search CTA picks the search tab + goes to add',
  run(`addTab`) === 'search' && run(`window.__went`) === 'add');
ok('onboarding: CTA dismisses the tour', !q('#onb-overlay') && run(`onboarded()`) === true);
run(`go = window.__realGo2;`);

clearFlag();
run(`library = []; maybeOnboard();`);
run(`go = function(v) { window.__went = v; };`);
q('#onb-import').click();
ok('onboarding: import CTA opens settings at the Library group',
  run(`window.__went`) === 'settings' &&
  run(`localStorage.getItem('spicyshelves.setgroups')`) === '[1]');
run(`go = window.__realGo2;`);

// --- 8. Analytics events allowlisted ---
const allowed = run(`Object.keys(EVENT_DEFS)`);
['onboarding_started', 'onboarding_completed', 'onboarding_skipped']
  .forEach(e => ok('analytics: ' + e + ' allowlisted', allowed.includes(e)));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
