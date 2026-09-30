// v215: swipe-down-to-close on the book modal — unit tests for the pure
// decision logic (shouldDismissDrag) and the idempotent body scroll lock.
// Touch/DOM gesture feel can't run in node; Kevin QAs that on his phone.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const get = (js) => { runInWindow('window.__v = (' + js + ');'); return window.__v; };
const bodyOverflow = () => window.document.body.style.overflow;

// ---- constants ----
ok('SHEET_DISMISS_PX is 120', get('SHEET_DISMISS_PX') === 120);
ok('SHEET_FLICK_V is 0.55', get('SHEET_FLICK_V') === 0.55);
ok('shouldDismissDrag is defined', get('typeof shouldDismissDrag') === 'function');

// ---- distance threshold (slow drags) ----
ok('slow drag past 120px dismisses', get('shouldDismissDrag(130, 0.1, 0)') === true);
ok('drag of exactly 120px dismisses', get('shouldDismissDrag(120, 0, 0)') === true);
ok('slow drag under 120px does not dismiss', get('shouldDismissDrag(60, 0.1, 0)') === false);
ok('tiny drag does not dismiss', get('shouldDismissDrag(15, 0.05, 0)') === false);

// ---- flick velocity (short but fast) ----
ok('fast flick dismisses even when short', get('shouldDismissDrag(60, 0.8, 0)') === true);
ok('flick at exactly the threshold dismisses', get('shouldDismissDrag(40, 0.55, 0)') === true);
ok('just under flick velocity does not dismiss', get('shouldDismissDrag(40, 0.5, 0)') === false);

// ---- vetoes ----
ok('upward swipe never dismisses', get('shouldDismissDrag(-50, 0.8, 0)') === false);
ok('zero distance never dismisses', get('shouldDismissDrag(0, 0.8, 0)') === false);
ok('scrollTop > 0 vetoes a long drag', get('shouldDismissDrag(200, 0.9, 10)') === false);
ok('scrollTop > 0 vetoes a flick', get('shouldDismissDrag(60, 0.9, 5)') === false);
ok('scrollTop exactly 0 does not veto', get('shouldDismissDrag(150, 0, 0)') === true);

// ---- body scroll lock ----
ok('lockBodyScroll is defined', get('typeof lockBodyScroll') === 'function');
ok('unlockBodyScroll is defined', get('typeof unlockBodyScroll') === 'function');
runInWindow('lockBodyScroll()');
ok('lock sets body overflow hidden', bodyOverflow() === 'hidden');
runInWindow('lockBodyScroll(); lockBodyScroll();');
ok('double lock is idempotent (still hidden)', bodyOverflow() === 'hidden');
runInWindow('unlockBodyScroll();');
ok('one unlock releases after two locks (re-render safe)', bodyOverflow() === '');
runInWindow('unlockBodyScroll();');
ok('unlock when not locked is a no-op', bodyOverflow() === '');
runInWindow('document.body.style.overflow = "auto"; lockBodyScroll();');
ok('lock preserves a pre-existing overflow value', get('document.body.style.overflow') === 'hidden');
runInWindow('unlockBodyScroll();');
ok('unlock restores the pre-existing value', bodyOverflow() === 'auto');
runInWindow('document.body.style.overflow = "";');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
