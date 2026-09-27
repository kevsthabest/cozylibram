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

function seed(status) {
  run(`library = [
    { id: 'b1', title: 'Test Book', authors: ['Author'], status: '${status}',
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

// --- 2. Start Reading applies immediately ---
seed('tbr');
q('#m-primary').click();
ok('primary: tbr -> reading applied to the book', run(`library[0].status`) === 'reading');
ok('primary: repainted to Log Pages', primaryLabel().includes('Log Pages'));
ok('primary: shelf seg follows', q('#f-status [data-s="reading"]').classList.contains('active'));

// --- 3. Give it another go applies immediately ---
seed('dnf');
q('#m-primary').click();
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

// --- 6. Sticky bar order: primary first, save last ---
const barBtns = Array.from(q('.modal-actions').querySelectorAll(':scope > button, :scope > .more-wrap'));
ok('bar: primary leads, save stays last',
  q('.modal-actions #m-primary') && q('.modal-actions #m-save') &&
  q('.modal-actions').innerHTML.indexOf('m-primary') < q('.modal-actions').innerHTML.indexOf('m-save'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
