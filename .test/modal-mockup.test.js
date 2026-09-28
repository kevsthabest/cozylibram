// Tests for v182 — full book-detail mockup alignment.
//
// Covered: top-right favorite + ⋮ cluster with the floating-card menu
// (Share, Add to Favorites, Add to Up Next, Change Cover, separated Remove);
// hero favorite beside the primary action (all three stay in sync); icon
// metadata row; labeled Change Cover; icon tabs; tappable shelf/ownership
// rows; "More details" expander; reading-log summary; trope chips with
// + Add / × remove / View more; immediate note saving.

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

function seed(over) {
  const base = {
    id: 'b1', title: 'Test Book', authors: ['Author'], status: 'reading',
    progress: 40, pageCount: 200, isbn: '9781250123456', publishedDate: '2021-05-01',
    cover: '', tropes: ['enemies to lovers'], tropesAuto: ['forced proximity', 'found family',
      'grumpy sunshine', 'slow burn', 'fake dating', 'soulmates', 'age gap', 'only one bed'],
    publicRating: 4.2, ratingsCount: 100, genres: [], myRating: 0, ratings: {},
    axes: [], favorite: false, owned: 'owned', notes: 'old notes',
    description: 'A great book.', quotes: [],
    log: [{ d: '2026-09-20', from: 10, to: 40 }]
  };
  run(`library = [${JSON.stringify(Object.assign(base, over || {}))}]; openDetail('b1');`);
}

seed();

// --- 1. Top-right cluster + floating menu ---
ok('top cluster holds favorite + overflow', !!q('.d-topactions #f-fav') && !!q('.d-topactions #m-more'));
ok('menu hidden by default', q('#m-moremenu').hidden === true);
q('#m-more').click();
ok('menu opens on ⋮ tap', q('#m-moremenu').hidden === false);
['#m-share', '#m-favmenu', '#m-upnext', '#m-covermenu', '#m-del'].forEach(id =>
  ok('menu item present: ' + id, !!q('#m-moremenu ' + id)));
ok('remove is visually separated', !!q('#m-moremenu .more-sep + #m-del'));
ok('remove labeled per mockup', q('#m-del').textContent.includes('Remove from Library'));
q('#m-more').click();

// --- 2. Hero: favorite beside the primary, single primary, icon meta ---
ok('primary row holds primary + hero favorite',
  !!q('.d-primary-row #m-primary') && !!q('.d-primary-row #f-fav2'));
ok('primary still singular', qa('#m-primary').length === 1);
ok('metadata row uses icons', qa('.d-meta svg').length === 3);
ok('change cover is a labeled button', q('#m-changecover').textContent.includes('Change Cover'));

// --- 3. Favorite sync across all three controls ---
ok('hero favorite starts off', !q('#f-fav2').classList.contains('on'));
q('#f-fav2').click();
ok('hero tap lights both hearts',
  q('#f-fav2').classList.contains('on') && q('#f-fav').classList.contains('on'));
ok('menu favorite label flips', q('#m-favmenu').textContent.includes('Remove from Favorites'));
ok('favorite persists immediately', run(`library[0].favorite`) === true);
q('#m-favmenu').click();
ok('menu favorite toggles back off',
  !q('#f-fav').classList.contains('on') && !q('#f-fav2').classList.contains('on'));
ok('menu favorite label flips back', q('#m-favmenu').textContent.includes('Add to Favorites'));

// --- 4. Tabs carry icons ---
ok('tabs have icons', qa('.d-tab svg').length === 3);

// --- 5. Details: about heading, tappable rows, more-details, log summary ---
ok('about-this-book heading', q('#dtab-details .field label').textContent === 'About this book');
ok('shelf row shows the current status', q('#f-status-val').textContent === 'Currently Reading');
ok('shelf options start collapsed', q('#f-status .mrow-opts').hidden === true);
q('#f-status [data-mrow]').click();
ok('shelf row expands', q('#f-status .mrow-opts').hidden === false);
q('#f-status [data-s="read"]').click();
ok('shelf pick repaints the row', q('#f-status-val').textContent === 'Read');
ok('shelf pick collapses the options', q('#f-status .mrow-opts').hidden === true);
ok('primary follows the shelf pick', q('#m-primary').textContent.includes('Rate & Review'));
ok('ownership row shows the current value', q('#f-owned-val').textContent === 'Owned');
q('#f-owned [data-mrow]').click();
q('#f-owned [data-o="borrowed"]').click();
ok('ownership pick repaints the row', q('#f-owned-val').textContent === 'Borrowed');
ok('buy links appear when not owned', q('#m-buywrap').style.display !== 'none');
ok('more-details holds the quiet fields',
  !!q('.m-more-details #f-pagecount') && !!q('.m-more-details #f-progress') && !!q('.m-more-details #f-releasedate'));
ok('reading log summary card', q('.log-summary').textContent.includes('Started') &&
  q('.log-summary').textContent.includes('Last read'));

// --- 6. Tropes: chips, add, remove, suggestions, view more ---
q('[data-dtab="tropes"]').click();
ok('your tropes render as chips', q('#f-tropechips').textContent.includes('enemies to lovers'));
ok('hidden input stays the save source', q('#f-tropes').value === 'enemies to lovers');
q('#f-tropeaddtoggle').click();
ok('add row reveals', q('#f-tropeaddwrap').hidden === false);
run(`document.getElementById('f-tropeadd').value = 'slow burn';`);
q('#f-tropeaddbtn').click();
ok('added trope appears as a chip', q('#f-tropechips').textContent.includes('slow burn'));
ok('added trope syncs the hidden input', q('#f-tropes').value.includes('slow burn'));
q('#f-tropechips [data-trm]').click();
ok('chip remove syncs the hidden input', !q('#f-tropes').value.includes('enemies to lovers'));
ok('suggestion chips render', qa('#f-tropesugg [data-tsugg]').length === 6);
ok('view more appears past six suggestions', q('#m-tropemore').hidden === false);
q('#m-tropemore').click();
// 7 left: 'slow burn' was added to her tropes, so it's no longer suggested
ok('view more expands the list', qa('#f-tropesugg [data-tsugg]').length === 7);
q('#f-tropesugg [data-tsugg]').click();
ok('suggestion tap adds a chip', q('#f-tropechips').textContent.includes('forced proximity'));
ok('trope intelligence card present', !!q('.tcard #m-tropedb') && !!q('#m-tropepropose'));

// --- 7. Notes: immediate save ---
q('[data-dtab="notes"]').click();
run(`document.getElementById('f-notes').value = 'my note';`);
q('#m-notesave').click();
ok('note saves immediately', run(`library[0].notes`) === 'my note');

// --- 8. Save still persists everything through the hidden trope input ---
q('[data-dtab="details"]').click();
run(`document.getElementById('m-save').click();`);
ok('save: tropes persisted', JSON.stringify(run(`library[0].tropes`)) === JSON.stringify(['slow burn', 'forced proximity']));
ok('save: shelf persisted', run(`library[0].status`) === 'read');
ok('save: ownership persisted', run(`library[0].owned`) === 'borrowed');
ok('save: notes persisted', run(`library[0].notes`) === 'my note');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
