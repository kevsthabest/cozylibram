// Tests for the Variant B modal save model (decided design, 2026-10-15;
// invoked by the User 2026-10-16): AUTOSAVE. Variant A (v569) shipped a
// sticky Save bar over the UI-free ModalFormState seam (js/150) precisely
// so this swap would be a behaviour change at the seam, not a restructure:
// the bar's manual commit trigger is replaced by a debounced
// commitDetailForm driven by the tracker's dirty notifications.
//
// Pinned here:
// - No save bar, no Discard, no dirty-close prompt — all retired.
// - Edits stage in the draft until the debounce (700ms) lands, then the
//   whole form commits together while the modal stays open.
// - The debounce resets on continued editing; blur commits promptly.
// - Every close path (×, backdrop, Escape, swipe) flushes first —
//   closing never loses an edit.
// - The only UI is a quiet header status text (Saving… / Saved) in the
//   top-actions cluster; instant actions (favourite, steppers, Save
//   note) stay instant and never dirty the form.
// - A commit that genuinely cannot apply (persistence throws) keeps the
//   modal open with the reason in the header status, and the pending
//   edit is never dropped — it commits once saving works again.
// - Carried over from the Variant A suite, unchanged: blurb exactly once
//   (header About row), Rating = stars + axes in one card first in the
//   form, Purchase inside "More details", series strip above the tabs,
//   "More like this" below the form, Book Portrait rendered directly
//   on the Extras tab (tab reorganization — the slim bar retired),
//   reading log collapsed by default, v563 format + trophy, v564 faceOut.

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
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));
const tick = () => new Promise(r => setTimeout(r, 30));
const st = () => { const el = q('#m-savestate'); return el ? el.textContent : '<missing>'; };
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};

// --- Controllable fake timers for the window (debounce cases) ---
// The app scripts resolve setTimeout through the window at call time,
// so swapping the window's pair drives the autosave debounce exactly.
const realST = window.setTimeout, realCT = window.clearTimeout;
let fakeNow = 0, fakeSeq = 1;
const fakeTimers = new Map();
function installFakeTimers() {
  fakeNow = 0; fakeSeq = 1; fakeTimers.clear();
  window.setTimeout = (cb, ms, ...a) => {
    const id = fakeSeq++;
    fakeTimers.set(id, { cb, at: fakeNow + (ms || 0), a });
    return id;
  };
  window.clearTimeout = (id) => { fakeTimers.delete(id); };
}
function uninstallFakeTimers() {
  window.setTimeout = realST; window.clearTimeout = realCT;
  fakeTimers.clear();
}
function advance(ms) {
  const target = fakeNow + ms;
  for (;;) {
    let nextId = null, nextAt = Infinity;
    fakeTimers.forEach((t, id) => { if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; } });
    if (nextId === null) break;
    const t = fakeTimers.get(nextId);
    fakeTimers.delete(nextId);
    fakeNow = Math.max(fakeNow, t.at);
    t.cb(...t.a);
  }
  fakeNow = target;
}

function seed() {
  run(`library = [
    { id: 'b1', title: 'Test Book', authors: ['Author'], status: 'reading',
      progress: 40, pageCount: 200, isbn: '9781250123456', publishedDate: '2021-05-01',
      cover: '', tropes: ['enemies to lovers'], publicRating: 4.2, ratingsCount: 100,
      categories: ['Fiction / Romance'], genres: [], myRating: 0, ratings: {}, axes: [],
      favorite: false, owned: 'owned', format: 'paperback', notes: 'old notes',
      description: 'A great book about many things.', quotes: [],
      purchaseSource: 'Indigo', purchaseDate: '2026-09-01',
      series: { name: 'The Great Saga', position: 1 },
      log: [{ d: '2026-09-20', from: 10, to: 40 }] },
    { id: 'b2', title: 'Second Book', authors: ['Author'], status: 'tbr',
      progress: 0, pageCount: 220, cover: '', tropes: [], myRating: 0, ratings: {},
      axes: [], favorite: false, owned: 'owned', notes: '', description: '',
      quotes: [], log: [], series: { name: 'The Great Saga', position: 2 } }
  ]; openDetail('b1');`);
}

(async () => {
seed();

// --- 1. The bar is retired; the header status is the only save UI ---
ok('no save bar renders under autosave',
  !q('#m-savebar') && !q('#m-save') && !q('#m-discard') && !q('#m-savecount'));
ok('header save status lives in the top actions', !!q('.d-topactions #m-savestate'));
ok('save status is quiet while clean', st() === '');

// --- 2. Rating: stars + axes reunited in one card, first in the form ---
ok('rating card holds stars and axes together',
  !!q('#f-myrating') && !!q('#f-axrows') &&
  q('#f-myrating').closest('.m-card') === q('#f-axrows').closest('.m-card'));
ok('stars carry accessible names',
  qa('#f-myrating button').length === 5 &&
  qa('#f-myrating button').every(b => /star/i.test(b.getAttribute('aria-label') || '')));
ok('stars are line-icon stars (not hearts)',
  qa('#f-myrating button').length === 5 &&
  qa('#f-myrating button').every(b => b.innerHTML.includes('M12 3.6')) &&
  qa('#f-myrating button').every(b => !b.innerHTML.includes('M12 20.3')));
// MOVEMENT (tab reorganization, named in its PR): the old single-panel
// order split across rooms — the rating opens the Details read view
// and Keep exploring closes it; the form sequence between them
// (status, progress, details card, more details) keeps its relative
// order on Manage.
ok('details order: rating opens, explore closes the read view', (() => {
  const h = q('#dtab-details').innerHTML;
  const order = ['id="f-myrating"', 'Keep exploring'];
  let last = -1;
  return order.every(s => { const i = h.indexOf(s); const good = i > last; last = i; return good; });
})());
ok('manage order: status, progress, details, more details', (() => {
  const h = q('#dtab-manage').innerHTML;
  const order = ['id="f-status"', 'id="m-progress"', 'id="m-hc"',
    'id="f-title"', 'id="f-purchase-source"', 'id="f-pagecount"'];
  let last = -1;
  return order.every(s => { const i = h.indexOf(s); const good = i > last; last = i; return good; });
})());

// --- 3. Debounce: edits stage, then commit together at 700ms ---
installFakeTimers();
seed();
type(q('#f-title'), 'Retitled');
qa('#f-myrating button')[4].click();
q('#f-status [data-s="read"]').click();
ok('edits stage first (book untouched)',
  run(`library[0].title`) === 'Test Book' && run(`library[0].status`) === 'reading' &&
  run(`library[0].myRating`) === 0);
ok('header status shows Saving…', st() === 'Saving…');
advance(699);
ok('nothing commits before the debounce elapses',
  run(`library[0].title`) === 'Test Book' && run(`library[0].myRating`) === 0);
advance(1);
ok('debounce commits title + rating + status together',
  run(`library[0].title`) === 'Retitled' && run(`library[0].myRating`) === 5 &&
  run(`library[0].status`) === 'read');
ok('header status shows Saved', st() === 'Saved');
ok('modal stays open after an autosave commit', !!q('#m-back'));
advance(2000);
ok('Saved acknowledgement fades back to quiet', st() === '');

// --- 4. The debounce resets on continued editing ---
type(q('#f-title'), 'A');
advance(500);
type(q('#f-title'), 'AB');
advance(500);
ok('continued typing resets the debounce', run(`library[0].title`) === 'Retitled');
advance(200);
ok('commit lands 700ms after the LAST change', run(`library[0].title`) === 'AB');

// --- 5. Blur commits promptly, without waiting out the debounce ---
type(q('#f-title'), 'Blurred');
q('#f-title').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
ok('blur commits without waiting for the debounce', run(`library[0].title`) === 'Blurred');
ok('modal stays open after a blur commit', !!q('#m-back'));
uninstallFakeTimers();

// --- 6. Close commits with zero loss — and never prompts ---
seed();
type(q('#f-title'), 'Closed');
q('#f-status [data-s="read"]').click();
q('#m-x').click();
await tick();
ok('close commits staged edits (zero loss)',
  run(`library[0].title`) === 'Closed' && run(`library[0].status`) === 'read');
ok('close shows no discard prompt', !q('.confirm-overlay'));
ok('modal closed', !q('#m-back'));
seed();
type(q('#f-title'), 'Escaped');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await tick();
ok('escape commits too (no prompt, edits kept)',
  run(`library[0].title`) === 'Escaped' && !q('#m-back') && !q('.confirm-overlay'));
seed();
type(q('#f-title'), 'Backdrop');
q('#m-back').click();
await tick();
ok('backdrop tap commits too',
  run(`library[0].title`) === 'Backdrop' && !q('#m-back') && !q('.confirm-overlay'));
seed();
q('#f-title').value = 'Direct write'; // no input event at all
q('#m-x').click();
await tick();
ok('close flush re-reads live values (a direct write still commits)',
  run(`library[0].title`) === 'Direct write');

// --- 7. A commit that cannot apply: reason visible, close blocked,
//        edit never dropped ---
installFakeTimers();
seed();
run(`window.__realSaveLibrary = saveLibrary;
     saveLibrary = function () { throw new Error('quota exceeded'); };`);
type(q('#f-title'), 'Unlucky');
advance(700);
ok('failed commit shows the reason in the header status',
  /Couldn’t save/.test(st()) &&
  /quota exceeded/.test(st()));
ok('failed commit leaves the modal open', !!q('#m-back'));
q('#m-x').click();
ok('close is blocked while the commit cannot apply', !!q('#m-back'));
ok('no discard prompt appears instead', !q('.confirm-overlay'));
run(`saveLibrary = window.__realSaveLibrary;`);
q('#m-x').click();
await tick();
ok('once saving works again, close commits and closes',
  !q('#m-back') && run(`library[0].title`) === 'Unlucky');
uninstallFakeTimers();

// --- 8. Instant actions stay instant and never dirty the form ---
seed();
q('#f-fav2').click();
ok('favourite persists immediately', run(`library[0].favorite`) === true);
ok('favourite does not dirty the form', st() === '');
q('#m-progress [data-step="+10"]').click();
ok('progress stepper persists immediately', run(`library[0].progress`) === 50);
ok('progress stepper does not dirty the form', st() === '');

// --- 9. Save note keeps its own action and blesses the notes field ---
q('[data-dtab="notes"]').click();
type(q('#f-notes'), 'a fresh note');
ok('typing a note starts the autosave', st() === 'Saving…');
q('#m-notesave').click();
ok('save note persists immediately', run(`library[0].notes`) === 'a fresh note');
ok('save note blesses the field (status quiet)', st() === '');
q('[data-dtab="details"]').click();

// --- 10. Blurb exactly once, in the Details About row ---
// MOVEMENT (tab reorganization, named in its PR): the About row moved
// from the header into the Details read view; still exactly one copy.
ok('blurb renders exactly once', qa('.m-desc').length === 1);
ok('blurb lives in the Details About row', !!q('#dtab-details .d-about #m-desc'));
ok('blurb is out of the header zone', !q('.d-hero .m-desc'));
ok('about row starts collapsed', q('#m-about-body').hidden === true);
q('#m-about-toggle').click();
ok('about row expands', q('#m-about-body').hidden === false);
ok('the single copy keeps its read-more toggle', !!q('#m-desc-toggle'));

// --- 11. Extras holds the portrait card; series strip above the tabs ---
// MOVEMENT (tab reorganization, named in its PR): the portrait slim
// bar retired — the card renders directly on Extras, no collapse.
ok('portrait card renders directly in Extras', !!q('#dtab-extras #portraitCard'));
ok('portrait slim bar is gone', !q('#m-portrait-toggle') && !q('#m-portrait-body') && !q('#ptSlimSum'));
ok('portrait card shows the mapped %', /% mapped/.test(q('#ptPct').textContent));
ok('series strip is above the tabs',
  !!q('#m-series') && !q('#dtab-details #m-series') &&
  q('#modal-root').innerHTML.indexOf('id="m-series"') < q('#modal-root').innerHTML.indexOf('d-tabs'));
ok('strip shows the owned sibling as a figure', !!q('#m-series [data-book="b2"]'));
ok('strip caption carries position + status',
  q('#m-series [data-book="b2"]').textContent.includes('#2'));

// --- 12. Purchase inside More details; log collapsed; edition tools in the overflow menu ---
ok('purchase fields live in More details',
  !!q('.m-more-details #f-purchase-source') && !!q('.m-more-details #f-purchase-date'));
ok('series editor lives in More details', !!q('.m-more-details #f-series'));
ok('reading log collapsed by default despite entries',
  q('#m-loglist').closest('details').open === false);
ok('primary row holds no cover pill', !q('#m-coverpill') && !q('.d-primary-row .more-wrap'));
ok('edition tools are items in the overflow menu',
  !!q('#m-moremenu #m-covermenu') && !!q('#m-moremenu #m-scanfaces') &&
  !!q('#m-moremenu #m-measurethick') && !!q('#m-moremenu #m-view3d') &&
  q('#m-moremenu').hidden === true);
q('#m-more').click();
ok('overflow button opens the menu', q('#m-moremenu').hidden === false);
// The moved entries still invoke their tools with the open book's id and
// close the menu behind them — the retired pill's menu was their only
// caller, so this is the check that keeps them reachable at all.
run(`window.__calls = [];
     window.ecStartScan = (x) => window.__calls.push(['scan', x]);
     window.editionMeasureThickness = (x) => window.__calls.push(['measure', x]);
     window.b3dOpenViewer = (x) => window.__calls.push(['3d', x]);`);
q('#m-scanfaces').click();
q('#m-measurethick').click();
q('#m-view3d').click();
const openId = run(`library[0].id`);
ok('moved entries invoke scan / measure / 3D with the book id',
  JSON.stringify(run(`window.__calls`)) ===
  JSON.stringify([['scan', openId], ['measure', openId], ['3d', openId]]));
ok('moved entries close the menu', q('#m-moremenu').hidden === true);

// --- 13. v563 format + trophy still work; close commits them ---
seed();
q('#f-format [data-f="ebook"]').click();
ok('format pick stages (book unchanged)', run(`library[0].format`) === 'paperback');
ok('format pick repaints the row', q('#f-format-val').textContent === 'Ebook');
ok('format pick starts the autosave', st() === 'Saving…');
ok('trophy chips offer the other formats', !!q('#f-want-opts [data-w="hardcover"]'));
q('#f-want-opts [data-w="hardcover"]').click();
q('#m-x').click();
await tick();
ok('close committed format + trophy want',
  run(`library[0].format`) === 'ebook' && run(`library[0].wantFormat`) === 'hardcover');

// --- 14. v564 faceOut is a form field; close commits it ---
seed();
ok('face-out checkline lives in the Status & Ownership card',
  !!q('#f-faceout') && q('#f-faceout').closest('.m-card') === q('#f-status').closest('.m-card'));
q('#f-faceout').click();
ok('face-out toggle stages (book unchanged)', run(`library[0].faceOut`) !== true);
q('#m-x').click();
await tick();
ok('close committed faceOut', run(`library[0].faceOut`) === true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
