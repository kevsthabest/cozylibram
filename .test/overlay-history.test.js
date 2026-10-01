// v220: Android system back-gesture closes the topmost overlay via history.
// Manager unit tests use a stubbed window.history (record pushState/back);
// integration tests drive openPreviewModal in jsdom. The popstate listener
// registered at script load is invoked directly as __overlayOnPopState().
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in overlay tests'); };
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const probe = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);

// Stub window.history with push/back recorders. The manager reads
// window.history at call time, so patching post-load works.
const realHistory = window.history;
function stubHistory() {
  const calls = { push: 0, back: 0 };
  const h = Object.create(realHistory);
  h.pushState = () => { calls.push++; };
  h.back = () => { calls.back++; };
  try {
    Object.defineProperty(window, 'history', { value: h, configurable: true, writable: true });
  } catch (e) { window.history.pushState = h.pushState; window.history.back = h.back; }
  return calls;
}
function restoreHistory() {
  try {
    Object.defineProperty(window, 'history', { value: realHistory, configurable: true, writable: true });
  } catch (e) { /* best effort */ }
}
const reset = () => probe('__overlayHistoryReset()');
const depth = () => probe('__overlayStackDepth()');
const pop = () => probe('__overlayOnPopState()');

(async () => {
  // ---- 1. opening pushes exactly one entry
  reset();
  let calls = stubHistory();
  const t1 = probe(`overlayOpened('modal-root', () => {})`);
  ok('open pushes one history entry', calls.push === 1 && depth() === 1 && typeof t1 === 'string');

  // ---- 2+4. stacked overlays unwind LIFO on popstate; gesture swallows
  reset(); calls = stubHistory();
  let closedA = 0, closedB = 0;
  const tA = probe(`overlayOpened('collection', () => { window.__closedA = (window.__closedA || 0) + 1; })`);
  probe(`overlayOpened('picker', () => { window.__closedB = (window.__closedB || 0) + 1; })`);
  pop(); // back-gesture: topmost (picker) closes, collection stays
  ok('popstate closes topmost only', (window.__closedB || 0) === 1 && (window.__closedA || 0) === 0 && depth() === 1);
  ok('gesture popstate does not call history.back', calls.back === 0);
  pop(); // next gesture closes the collection overlay
  ok('second popstate unwinds the next overlay', (window.__closedA || 0) === 1 && depth() === 0);

  // ---- 3. programmatic close consumes its entry (no phantoms)
  reset(); calls = stubHistory();
  let domClosed = 0;
  const tC = probe(`overlayOpened('modal-root', () => { window.__domClosed = (window.__domClosed || 0) + 1; })`);
  probe(`overlayClosed(${JSON.stringify(tC)})`);
  ok('programmatic close calls history.back once', calls.back === 1 && depth() === 0);
  pop(); // the suppressed popstate from our own back()
  ok('suppressed popstate does not double-close', (window.__domClosed || 0) === 0 && depth() === 0);

  // ---- 5. popstate with no overlay is a no-op (route back untouched)
  reset(); calls = stubHistory();
  let threw = false;
  try { pop(); } catch (e) { threw = true; }
  ok('popstate with no overlay does nothing', !threw && calls.back === 0 && depth() === 0);

  // ---- 6. overlayReplace handoff leaves exactly one entry
  reset(); calls = stubHistory();
  const tP = probe(`overlayOpened('modal-root', () => {})`);
  probe(`overlayReplace(${JSON.stringify(tP)}, () => overlayOpened('modal-root', () => { window.__newCloser = 1; }))`);
  ok('handoff adopts the entry: one push, one overlay', calls.push === 1 && depth() === 1);
  pop();
  ok('handoff entry closes the NEW overlay', (window.__newCloser || 0) === 1 && depth() === 0);

  // ---- 7. same-slot re-render does not push
  reset(); calls = stubHistory();
  const tR1 = probe(`overlayOpened('modal-root', () => {})`);
  const tR2 = probe(`overlayOpened('modal-root', () => {})`);
  ok('same-slot re-render reuses the entry', tR1 === tR2 && calls.push === 1 && depth() === 1);

  // ---- 8. missing pushState degrades silently (no-op safe)
  reset();
  const hNoPush = Object.create(realHistory);
  hNoPush.back = () => {};
  try { Object.defineProperty(window, 'history', { value: hNoPush, configurable: true, writable: true }); } catch (e) {}
  let crashed = false, closerRan = false;
  try {
    probe(`overlayOpened('modal-root', () => { window.__crashedCloser = 1; })`);
    pop();
  } catch (e) { crashed = true; }
  ok('no pushState: opens fine, gesture still closes via stack',
    !crashed && (window.__crashedCloser || 0) === 1);
  restoreHistory();

  // ---- 9. overlayIsTop: only the topmost answers
  reset(); stubHistory();
  const tT1 = probe(`overlayOpened('modal-root', () => {})`);
  const tT2 = probe(`overlayOpened('sheet', () => {})`);
  ok('isTop distinguishes stack order',
    probe(`overlayIsTop(${JSON.stringify(tT1)})`) === false &&
    probe(`overlayIsTop(${JSON.stringify(tT2)})`) === true);
  probe(`overlayClosed(${JSON.stringify(tT2)})`);
  ok('after top closes, the next one is top', probe(`overlayIsTop(${JSON.stringify(tT1)})`) === true);
  restoreHistory();

  // ---- 10. integration: preview modal pushes; X consumes; gesture closes
  reset(); calls = stubHistory();
  const src = { title: 'Iron Flame', authors: ['Rebecca Yarros'], cover: '', description: 'Dragons.' };
  probe(`openPreviewModal(previewTransient(${JSON.stringify(src)}, 'reco'), { source: 'test' })`);
  ok('preview open pushes one entry and renders', calls.push === 1 && !!q('#p-back'));
  q('#p-x').click();
  ok('preview X consumes the entry and tears down', calls.back === 1 && !q('#p-back') && depth() === 0);
  pop(); // suppressed popstate
  ok('no double-close after X', depth() === 0);
  // reopen, then close via the gesture path
  probe(`openPreviewModal(previewTransient(${JSON.stringify(src)}, 'reco'), { source: 'test' })`);
  pop();
  ok('back-gesture closes the preview', !q('#p-back') && depth() === 0 && calls.back === 1);
  restoreHistory();

  // ---- 11. integration: preview +TBR hands one entry to the real modal
  reset(); calls = stubHistory();
  probe(`library.push({ id: 'ovhandoff1', title: 'Handoff Book', authors: ['A. Uthor'], status: 'tbr',
    tropes: [], categories: [], ratings: {}, axes: [], myRating: 0, progress: 0 })`);
  probe(`openPreviewModal(previewTransient(${JSON.stringify(src)}, 'reco'), {
    source: 'test', onAddTBR: () => library.find(b => b.id === 'ovhandoff1')
  })`);
  const pushBefore = calls.push;
  q('#p-tbr').click();
  await new Promise(r => setTimeout(r, 50));
  ok('handoff: exactly one entry for the real modal',
    calls.push === pushBefore && depth() === 1 && !!q('#m-back') && !q('#p-back'));
  pop(); // gesture closes the real modal
  ok('gesture closes the handed-off modal', !q('#m-back') && depth() === 0);
  // cleanup the scratch book
  probe(`library.splice(library.findIndex(b => b.id === 'ovhandoff1'), 1)`);
  restoreHistory();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
