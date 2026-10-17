// v215: swipe-down-to-close on the book modal — unit tests for the pure
// decision logic (shouldDismissDrag) and the idempotent body scroll lock.
// Touch/DOM gesture feel can't run in node; the User QAs that on his phone.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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

// ---- wireSheetDrag gesture behavior (v511) ----
// jsdom has no touch pipeline; dispatch synthetic touch events (touches +
// timeStamp attached) and assert the sheet transform / dismiss calls.
window.ontouchstart = null; // wireSheetDrag gates on touch support
ok('wireSheetDrag is defined', get('typeof wireSheetDrag') === 'function');
ok('sheetDragStartsInHScroller is defined', get('typeof sheetDragStartsInHScroller') === 'function');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tev = (type, x, y, ts) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  const t = { clientX: x, clientY: y };
  ev.touches = (type === 'touchend' || type === 'touchcancel') ? [] : [t];
  ev.changedTouches = [t];
  Object.defineProperty(ev, 'timeStamp', { value: ts });
  return ev;
};
const fire = (target, type, x, y, ts) => target.dispatchEvent(tev(type, x, y, ts));
const mkSheet = (inner) => {
  const host = window.document.createElement('div');
  host.innerHTML = '<div class="fx-sheet">' + inner + '</div>';
  window.document.body.appendChild(host);
  return host.firstChild;
};
const PLAIN = '<div class="fx-plain"><span class="fx-t">content</span></div>';
const RAIL = '<div class="fx-rail" style="overflow-x:auto"><span class="fx-t">chip</span></div>';
const wire = (sheet) => {
  const state = { dismissed: 0 };
  window.wireSheetDrag(sheet, () => { state.dismissed++; });
  return state;
};
// a rail whose content overflows horizontally (jsdom has no layout)
const railSheet = mkSheet(RAIL);
const railEl = railSheet.querySelector('.fx-rail');
Object.defineProperty(railEl, 'scrollWidth', { value: 480, configurable: true });
Object.defineProperty(railEl, 'clientWidth', { value: 140, configurable: true });

// ---- the h-scroller detector itself ----
ok('detector: touch inside an overflowing rail is detected',
  window.sheetDragStartsInHScroller(railSheet, railSheet.querySelector('.fx-t')) === true);
const plainSheet0 = mkSheet(PLAIN);
ok('detector: touch on plain content is not',
  window.sheetDragStartsInHScroller(plainSheet0, plainSheet0.querySelector('.fx-t')) === false);
const snugSheet = mkSheet(RAIL);
const snugRail = snugSheet.querySelector('.fx-rail');
Object.defineProperty(snugRail, 'scrollWidth', { value: 100, configurable: true });
Object.defineProperty(snugRail, 'clientWidth', { value: 140, configurable: true });
ok('detector: a non-overflowing rail is not a scroller',
  window.sheetDragStartsInHScroller(snugSheet, snugSheet.querySelector('.fx-t')) === false);

(async () => {
  // ---- genuine downward drag at the top: claims, tracks, dismisses ----
  const sA = mkSheet(PLAIN); const dA = wire(sA); const tA = sA.querySelector('.fx-t');
  fire(tA, 'touchstart', 100, 100, 0);
  fire(tA, 'touchmove', 100, 112, 16); // crosses the 10px gate -> claim + re-anchor
  ok('downward drag claims the sheet (transition off)', sA.style.transition === 'none');
  fire(tA, 'touchmove', 100, 200, 32);
  ok('claimed sheet tracks the finger', sA.style.transform === 'translateY(88px)');
  fire(tA, 'touchend', 100, 200, 48); // fast + far enough
  await sleep(280);
  ok('downward drag dismisses', dA.dismissed === 1);

  // ---- short slow drag springs back ----
  const sB = mkSheet(PLAIN); const dB = wire(sB); const tB = sB.querySelector('.fx-t');
  fire(tB, 'touchstart', 100, 100, 0);
  fire(tB, 'touchmove', 100, 112, 100);
  fire(tB, 'touchmove', 100, 150, 400); // dy = 38
  fire(tB, 'touchend', 100, 150, 700);  // too slow, too short
  ok('short slow drag springs back', dB.dismissed === 0 && sB.style.transform === '');

  // ---- sheet scrolled: no claim ----
  const sC = mkSheet(PLAIN); const dC = wire(sC); const tC = sC.querySelector('.fx-t');
  Object.defineProperty(sC, 'scrollTop', { value: 40, configurable: true });
  fire(tC, 'touchstart', 100, 100, 0);
  fire(tC, 'touchmove', 100, 180, 16);
  ok('drag while content is scrolled never claims', sC.style.transform === '' && dC.dismissed === 0);

  // ---- gesture starting inside a horizontal rail: refused outright ----
  const dD = wire(railSheet); const tD = railSheet.querySelector('.fx-t');
  fire(tD, 'touchstart', 60, 100, 0);
  fire(tD, 'touchmove', 120, 114, 16); // d = 14 would have claimed before v511
  fire(tD, 'touchmove', 120, 300, 32);
  fire(tD, 'touchend', 120, 300, 48);
  ok('gesture starting in a horizontal rail never drags the sheet',
    railSheet.style.transform === '' && dD.dismissed === 0);

  // ---- mostly-horizontal diagonal: refused for this touch only ----
  const sE = mkSheet(PLAIN); const dE = wire(sE); const tE = sE.querySelector('.fx-t');
  fire(tE, 'touchstart', 100, 100, 0);
  fire(tE, 'touchmove', 150, 114, 16); // d = 14 but dx = 50: horizontal-born
  fire(tE, 'touchmove', 150, 300, 32); // even a later downward arc stays refused
  ok('mostly-horizontal diagonal does not drag the sheet', sE.style.transform === '');
  fire(tE, 'touchend', 150, 300, 48);
  fire(tE, 'touchstart', 100, 100, 1000);
  fire(tE, 'touchmove', 104, 114, 1016); // d = 14, dx = 4: vertical-born -> claims
  fire(tE, 'touchmove', 104, 260, 1032);
  ok('refusal is per-gesture: a later vertical drag still tracks',
    sE.style.transform === 'translateY(146px)');
  fire(tE, 'touchend', 104, 260, 1048); // dy = 146 >= 120
  await sleep(280);
  ok('... and still dismisses', dE.dismissed === 1);

  // ---- DNF reason sheet: the other .sheet-foundation consumer (v513) ----
  // It built the same .sheet-overlay/.sheet pair as the portrait sheet
  // and was missing the same wireSheetDrag wiring. openDnfReasonSheet
  // only touches the book object on a reason tap, so a stub is fine.
  runInWindow('openDnfReasonSheet({ id: "dnfT1", status: "dnf" })');
  const dnfSheet = window.document.querySelector('.dnf-bottom-sheet');
  ok('dnf sheet opens', !!dnfSheet);
  const dnfOverlay = dnfSheet.parentElement;
  const dnfTitle = dnfSheet.querySelector('.dnf-title');
  fire(dnfTitle, 'touchstart', 100, 100, 0);
  fire(dnfTitle, 'touchmove', 100, 112, 16);
  fire(dnfTitle, 'touchmove', 100, 200, 32);
  ok('dnf sheet tracks a downward drag', dnfSheet.style.transform === 'translateY(88px)');
  fire(dnfTitle, 'touchend', 100, 200, 48);
  await sleep(280); // 190ms dismiss delay -> close()
  ok('dnf sheet closes on a downward drag', !dnfOverlay.classList.contains('open'));
  await sleep(400); // close()'s own 300ms removal
  ok('dnf overlay is removed after the drag-dismiss', !window.document.querySelector('.dnf-bottom-sheet'));

  // ---- v513 (standing rule): every .sv-sheet / .coven-sheet surface ----
  // Swipe-to-dismiss is an app rule, not a per-sheet option: the sheets
  // that predate wireSheetDrag (custom .sv-sheet / .coven-sheet shells)
  // wire the same helper to their existing close(). One shell-level wire
  // per family covers every sheet built on it. Same drag recipe as DNF:
  // claim at +12px, track to +100px, release, wait out the dismiss.
  const dragDismiss = async (name, sheet, target, goneCheck) => {
    ok(name + ' opens', !!sheet);
    if (!sheet) return;
    fire(target, 'touchstart', 100, 100, 0);
    fire(target, 'touchmove', 100, 112, 16);
    fire(target, 'touchmove', 100, 200, 32);
    ok(name + ' tracks a downward drag', sheet.style.transform === 'translateY(88px)');
    fire(target, 'touchend', 100, 200, 48);
    await sleep(600); // 190ms dismiss delay + the close()'s own removal
    ok(name + ' closes on a downward drag', goneCheck());
  };

  // trigger-check sheet (js/221)
  runInWindow('openTriggerCheckSheet({ id: "tcT1", title: "T", contentWarnings: ["x"] }, null)');
  const tcSheet = window.document.querySelector('#tcSheet');
  await dragDismiss('trigger-check sheet', tcSheet,
    tcSheet && tcSheet.querySelector('.tc-title'),
    () => !window.document.querySelector('#tcSheet'));

  // community-corpus sheet shell (js/223) — covers every corpus sheet
  runInWindow('ccSheet("T", "<p>body</p>")');
  const ccEl = window.document.querySelector('#ccSheet');
  await dragDismiss('corpus sheet', ccEl,
    ccEl && ccEl.querySelector('.tc-title'),
    () => !window.document.querySelector('#ccSheet'));

  // shelf sheet shell (js/205) — covers the photo / decor / layout /
  // viewfinder sheets; the shell close also stops the camera.
  runInWindow('shelfSheetShell("T", "<p>body</p>")');
  const svEl = window.document.querySelector('#svSheet');
  await dragDismiss('shelf sheet', svEl,
    svEl && svEl.querySelector('.sv-sheet-title'),
    () => !window.document.querySelector('#svSheet'));

  // coven sheet shell (js/195)
  runInWindow('covenOpenSheet("T", "<p>body</p>")');
  const cvEl = window.document.querySelector('#covenSheet');
  await dragDismiss('coven sheet', cvEl,
    cvEl && cvEl.querySelector('h3'),
    () => !window.document.querySelector('#covenSheet'));

  // DNA survey sheet (js/226)
  runInWindow('openDnaSurvey({ id: "svT1", title: "T" })');
  const dnaEl = window.document.querySelector('#dnaSurveySheet');
  await dragDismiss('dna survey sheet', dnaEl,
    dnaEl && dnaEl.querySelector('.survey-title'),
    () => !window.document.querySelector('#dnaSurveySheet'));

  // warning-preferences sheet (js/226)
  runInWindow('openWarningPrefs()');
  const wpEl = window.document.querySelector('#warnPrefSheet');
  await dragDismiss('warn-prefs sheet', wpEl,
    wpEl && wpEl.querySelector('.survey-title, .portrait-label'),
    () => !window.document.querySelector('#warnPrefSheet'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
