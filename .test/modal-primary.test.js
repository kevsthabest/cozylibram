// Tests for v123 — contextual primary action + ⋮ overflow menu in the book
// modal (UI Improvement Pass, section 5).
//
// Covered: the sticky bar leads with one primary action matching the book's
// shelf (TBR→Start Reading, Reading→Log Pages, Read→Rate & Review,
// DNF→Give it another go); status primaries apply immediately and repaint;
// the primary follows manual shelf changes; Share/Remove live behind the ⋮
// menu but keep their IDs and behavior.

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
const tick = () => new Promise(r => setTimeout(r, 20));

function seed(status) {
  // v559: the seed carries owned: 'owned' — every real book does (the
  // facet is backfilled by migrateBook at load). Without it the modal
  // draft defaults a missing facet to 'tobuy' (js/150), which under
  // the unified model makes a plain TBR seed a wishlist book and its
  // primary the acquisition action instead of the status primary.
  run(`library = [
    { id: 'b1', title: 'Test Book', authors: ['Author'], status: '${status}', owned: 'owned',
      progress: 0, pageCount: 200, cover: '', tropes: [], genres: [],
      myRating: 0, ratings: {}, axes: [], favorite: false, notes: '' }
  ]; openDetail('b1');`);
}
const primaryLabel = () => (q('#m-primary') || { textContent: '' }).textContent.trim();

// --- 1. Primary matches the shelf ---
seed('tbr');
ok('tbr: primary is Start Reading', primaryLabel().includes('Start Reading'));
seed('reading');
ok('reading: primary is Log Pages', primaryLabel().includes('Log Pages'));
seed('read');
ok('read: primary is Rate & Review', primaryLabel().includes('Rate & Review'));
seed('dnf');
ok('dnf: primary is Give it another go', primaryLabel().includes('Give it another go'));

// --- 2. Start Reading applies immediately (v455: async trigger check) ---
(async () => {
seed('tbr');
q('#m-primary').click();
await tick();
ok('primary: tbr -> reading applied to the book', run(`library[0].status`) === 'reading');
ok('primary: repainted to Log Pages', primaryLabel().includes('Log Pages'));
ok('primary: shelf seg follows', q('#f-status [data-s="reading"]').classList.contains('active'));

// --- 3. Give it another go applies immediately ---
seed('dnf');
q('#m-primary').click();
await tick();
ok('primary: dnf -> tbr applied to the book', run(`library[0].status`) === 'tbr');
ok('primary: repainted to Start Reading', primaryLabel().includes('Start Reading'));

// --- 4. Primary follows manual shelf changes ---
seed('tbr');
q('#f-status [data-s="read"]').click();
ok('primary: follows manual shelf change', primaryLabel().includes('Rate & Review'));

// --- 5. Overflow menu ---
seed('tbr');
ok('menu: hidden by default', q('#m-moremenu').hidden === true);
q('#m-more').click();
ok('menu: opens on ⋮ tap', q('#m-moremenu').hidden === false);
ok('menu: share keeps its id', !!q('#m-moremenu #m-share'));
ok('menu: remove keeps its id', !!q('#m-moremenu #m-del'));
q('#m-more').click();
ok('menu: toggles closed', q('#m-moremenu').hidden === true);

// --- 6. Primary lives in the hero, not the bottom bar (v180); ⋮ moved to the
// top-right cluster in v182 ---
ok('primary: in the hero before the tabs',
  !!q('.d-hero #m-primary') && !q('.modal-actions #m-primary'));
ok('bar: save remains alone; ⋮ lives in the top-right cluster',
  !!q('.d-topactions #m-more') && !!q('.modal-actions #m-save') && !q('.modal-actions #m-more'));

// --- 7. v559: a wishlist book's primary is the acquisition action ---
run(`library = [
  { id: 'b1', title: 'Test Book', authors: ['Author'], status: 'tbr', owned: 'tobuy',
    progress: 0, pageCount: 200, cover: '', tropes: [], genres: [],
    myRating: 0, ratings: {}, axes: [], favorite: false, notes: '' }
]; openDetail('b1');`);
await tick();
ok('wishlist book: primary is Mark owned', primaryLabel().includes('Mark owned'));
q('#m-primary').click();
await tick();
ok('wishlist book: primary marks owned, status stays tbr',
  run(`library[0].owned`) === 'owned' && run(`library[0].status`) === 'tbr');
ok('wishlist book: primary repaints to Start Reading', primaryLabel().includes('Start Reading'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
