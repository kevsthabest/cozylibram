// Tests for the Variant A modal restructure (decided design, 2026-10-15):
// one save model for the whole Details form behind a sticky Save bar.
//
// The seam under test is ModalFormState (js/150): dirty-state tracking
// decoupled from the bar UI — the bar is a pure view of the tracker's
// count, Save commits through the same path the old bottom button used,
// and closing with a dirty form prompts instead of silently discarding.
// Instant actions stay instant and never dirty the form: favourite,
// progress steppers, "Save note" (which blesses the notes field),
// tropes/notes contribution surfaces keep their own behaviour.
//
// Also pinned: blurb renders exactly once (header "About this book"
// row — the Details-tab duplicate is gone), Rating = stars + axes in
// one card at the top of the form, Purchase inside "More details",
// series strip above the tabs, "More like this" below the form under
// "Keep exploring", Book Portrait as a slim bar, reading log collapsed
// by default.

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
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};

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

// --- 1. The bar: present, hidden while the form is clean ---
ok('save bar exists with Save + Discard + count',
  !!q('#m-savebar') && !!q('#m-savebar #m-save') && !!q('#m-savebar #m-discard') && !!q('#m-savecount'));
ok('bar hidden while clean', q('#m-savebar').hidden === true);

// --- 2. Rating: stars + axes reunited in one card, first in the form ---
ok('rating card holds stars and axes together',
  !!q('#f-myrating') && !!q('#f-axrows') &&
  q('#f-myrating').closest('.m-card') === q('#f-axrows').closest('.m-card'));
ok('stars carry accessible names',
  qa('#f-myrating button').length === 5 &&
  qa('#f-myrating button').every(b => /star/i.test(b.getAttribute('aria-label') || '')));
ok('stars are line-icon stars (not hearts)',
  qa('#f-myrating button .ticon').length === 5 &&
  qa('#f-myrating button').every(b => b.innerHTML.includes('M12 3.6')) &&
  qa('#f-myrating button').every(b => !b.innerHTML.includes('M12 20.3')));
ok('form order: rating, status, progress, details, more details, explore', (() => {
  const h = q('#dtab-details').innerHTML;
  const order = ['id="f-myrating"', 'id="f-status"', 'id="m-progress"', 'id="m-hc"',
    'id="f-title"', 'id="f-purchase-source"', 'id="f-pagecount"', 'Keep exploring'];
  let last = -1;
  return order.every(s => { const i = h.indexOf(s); const good = i > last; last = i; return good; });
})());

// --- 3. One save model: stars stage into the draft like everything else ---
qa('#f-myrating button')[3].click();
ok('star tap raises the bar', q('#m-savebar').hidden === false);
ok('bar counts the change', q('#m-savecount').textContent.includes('1 unsaved'));
ok('star tap does NOT write the book before Save', run(`library[0].myRating`) === 0);
const spiceSeg = q('#f-axrows [data-ax="spice"] .segbar');
ok('axes live in the rating card', !!spiceSeg);
spiceSeg.querySelectorAll('i')[2].click();
ok('axis tap adds to the count', q('#m-savecount').textContent.includes('2 unsaved'));
ok('axis tap does NOT write the book before Save',
  !run(`library[0].ratings.spice`));

// --- 4. Discard resets the staged form, modal stays open ---
q('#m-discard').click();
ok('discard hides the bar', q('#m-savebar').hidden === true);
ok('discard keeps the modal open', !!q('#m-back'));
ok('discard restores the star display', qa('#f-myrating button.on').length === 0);

// --- 5. Dirty count accuracy across field kinds ---
type(q('#f-title'), 'Retitled');
ok('typing a title dirties one field', q('#m-savecount').textContent.includes('1 unsaved'));
q('#f-status [data-s="read"]').click();
ok('a staged status makes two', q('#m-savecount').textContent.includes('2 unsaved'));
ok('staged status not yet on the book', run(`library[0].status`) === 'reading');

// --- 6. Dirty close prompts; Keep editing preserves everything ---
q('#m-x').click();
await tick();
ok('dirty close opens the discard prompt', !!q('.confirm-overlay'));
q('.confirm-overlay [data-ca="cancel"]').click();
await tick();
ok('keep editing: modal still open', !!q('#m-back'));
ok('keep editing: edits intact', q('#f-title').value === 'Retitled' && run(`library[0].status`) === 'reading');
q('#m-x').click();
await tick();
q('.confirm-overlay [data-ca="ok"]').click();
await tick();
ok('discard close: modal closed', !q('#m-back'));
ok('discard close: book untouched', run(`library[0].title`) === 'Test Book' && run(`library[0].status`) === 'reading');

// --- 7. Save commits the whole form through the bar ---
seed();
type(q('#f-title'), 'Retitled');
qa('#f-myrating button')[4].click();
q('#f-status [data-s="read"]').click();
q('#m-save').click();
await tick();
ok('save closes the modal (established behaviour)', !q('#m-back'));
ok('save persisted title + rating + status together',
  run(`library[0].title`) === 'Retitled' && run(`library[0].myRating`) === 5 &&
  run(`library[0].status`) === 'read');

// --- 8. Escape is a guarded close too ---
seed();
type(q('#f-title'), 'Escaped');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await tick();
ok('escape on a dirty form prompts', !!q('.confirm-overlay'));
q('.confirm-overlay [data-ca="cancel"]').click();
await tick();
ok('escape prompt dismissed, modal open', !!q('#m-back'));
run(`document.getElementById('m-x').click();`);
await tick();
if (q('.confirm-overlay [data-ca="ok"]')) q('.confirm-overlay [data-ca="ok"]').click();
await tick();

// --- 9. Instant actions stay instant and never dirty the form ---
seed();
q('#f-fav2').click();
ok('favourite persists immediately', run(`library[0].favorite`) === true);
ok('favourite does not dirty the form', q('#m-savebar').hidden === true);
q('#m-progress [data-step="+10"]').click();
ok('progress stepper persists immediately', run(`library[0].progress`) === 50);
ok('progress stepper does not dirty the form', q('#m-savebar').hidden === true);

// --- 10. Save note keeps its own action and blesses the notes field ---
q('[data-dtab="notes"]').click();
type(q('#f-notes'), 'a fresh note');
ok('typing a note dirties the form', q('#m-savebar').hidden === false);
q('#m-notesave').click();
ok('save note persists immediately', run(`library[0].notes`) === 'a fresh note');
ok('save note blesses the field (bar hides)', q('#m-savebar').hidden === true);
q('[data-dtab="details"]').click();

// --- 11. Blurb exactly once, in the header About row ---
ok('blurb renders exactly once', qa('.m-desc').length === 1);
ok('blurb is out of the Details form', !q('#dtab-details .m-desc'));
ok('blurb lives in the header About row', !!q('.d-about #m-desc'));
ok('about row starts collapsed', q('#m-about-body').hidden === true);
q('#m-about-toggle').click();
ok('about row expands', q('#m-about-body').hidden === false);
ok('the single copy keeps its read-more toggle', !!q('#m-desc-toggle'));

// --- 12. Header zone: portrait slim bar + series strip above the tabs ---
ok('portrait card sits inside the slim bar body', !!q('#m-portrait-body #portraitCard'));
ok('portrait body starts collapsed', q('#m-portrait-body').hidden === true);
ok('slim summary line shows the mapped %', /% mapped/.test(q('#ptSlimSum').textContent));
q('#m-portrait-toggle').click();
ok('portrait bar expands', q('#m-portrait-body').hidden === false);
ok('series strip is above the tabs',
  !!q('#m-series') && !q('#dtab-details #m-series') &&
  q('#modal-root').innerHTML.indexOf('id="m-series"') < q('#modal-root').innerHTML.indexOf('d-tabs'));
ok('strip shows the owned sibling as a figure', !!q('#m-series [data-book="b2"]'));
ok('strip caption carries position + status',
  q('#m-series [data-book="b2"]').textContent.includes('#2'));

// --- 13. Purchase inside More details; log collapsed; cover tools behind the pill ---
ok('purchase fields live in More details',
  !!q('.m-more-details #f-purchase-source') && !!q('.m-more-details #f-purchase-date'));
ok('series editor lives in More details', !!q('.m-more-details #f-series'));
ok('reading log collapsed by default despite entries',
  q('#m-loglist').closest('details').open === false);
ok('cover tools are menu items behind the Cover pill',
  !!q('#m-covertools #m-changecover') && !!q('#m-covertools #m-view3d') && q('#m-covertools').hidden === true);
q('#m-coverpill').click();
ok('cover pill opens the tools menu', q('#m-covertools').hidden === false);

// --- 14. v563 format + trophy still work in their new home ---
seed();
q('#f-format [data-f="ebook"]').click();
ok('format pick stages (book unchanged)', run(`library[0].format`) === 'paperback');
ok('format pick repaints the row', q('#f-format-val').textContent === 'Ebook');
ok('format pick dirties the form', q('#m-savebar').hidden === false);
ok('trophy chips offer the other formats', !!q('#f-want-opts [data-w="hardcover"]'));
q('#f-want-opts [data-w="hardcover"]').click();
q('#m-save').click();
await tick();
ok('save persisted format + trophy want',
  run(`library[0].format`) === 'ebook' && run(`library[0].wantFormat`) === 'hardcover');

// --- 15. v564 faceOut (composed at the Variant A rebase) is a form field ---
seed();
ok('face-out checkline lives in the Status & Ownership card',
  !!q('#f-faceout') && q('#f-faceout').closest('.m-card') === q('#f-status').closest('.m-card'));
q('#f-faceout').click();
ok('face-out toggle dirties the form', q('#m-savebar').hidden === false);
q('#m-save').click();
await tick();
ok('save persisted faceOut', run(`library[0].faceOut`) === true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
