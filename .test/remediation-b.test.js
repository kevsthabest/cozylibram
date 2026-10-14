// Remediation Batch B (v534) pins:
//  1. Settings JSON import keeps exported book ids (collision = restore
//     in place; Up Next queue + manual shelf order survive; re-import
//     does not duplicate).
//  2. Book-modal shelf picker stages until Save — an unsaved pick
//     changes nothing (record, reopened modal, grid tag); the DNF
//     reason prompt fires on Save, not on pick.
//  4. Shelves tab models all five statuses (chips + groups, 2D here;
//     the Room builds from the same SHELF_GROUPS constants) and the
//     long-press move sheet offers all five destinations.
//  6. Settings hide-chips render for every status, even empty+hidden.
//  7. STATUS_BADGE covers 'wishlist' with a real bmwishlist glyph.
//  8. Purchase Ledger always renders the TOTAL SPENT line.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in remediation-b tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const run = (js) => window.eval(js);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));
const waitFor = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await tick(40); }
  return fn();
};

const mk = (id, title, status, extra) => Object.assign({
  id, isbn: '978' + String([...id].reduce((a, c) => a + c.charCodeAt(0), 0)).padStart(10, '0'), title,
  authors: ['Au ' + id], cover: '', description: '', pageCount: 200, publishedDate: '',
  categories: [], publicRating: null, ratingsCount: 0, status: status || 'tbr',
  owned: 'owned', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0,
  dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false,
  series: null, log: [], _mtime: 0,
}, extra || {});
const setLib = (books) => runInWindow(`library = ${JSON.stringify(books)}; saveLibrary({ noCloud: true });`);

(async () => {
  /* ---------- 7. STATUS_BADGE wishlist ---------- */
  ok('STATUS_BADGE covers every status',
    run(`Object.keys(STATUS).every(s => !!STATUS_BADGE[s])`));
  ok('wishlist badge uses the bmwishlist glyph', run(`STATUS_BADGE.wishlist[0]`) === 'bmwishlist');
  ok('bmwishlist is a real icon (not the covers fallback)',
    run(`icon('bmwishlist')`) !== run(`icon('covers')`) && run(`icon('bmwishlist')`).includes('M12 7.3'));
  setLib([mk('w1', 'Wished', 'wishlist')]);
  const wishCard = run(`bookTile(library[0], 0)`);
  ok('wishlist tile renders the badge chip with label',
    wishCard.includes('tile-badge st-wishlist') && wishCard.includes('aria-label="Wishlist"'));

  /* ---------- 2. modal shelf picker stages until Save ---------- */
  runInWindow(`window.__dnf = []; openDnfReasonSheet = function (b) { window.__dnf.push(b.id); };`);
  setLib([mk('b1', 'Staged Book', 'read', { progress: 200 })]);
  runInWindow(`openDetail('b1')`);
  ok('modal opens on the saved status', q('#f-status [data-s="read"]').classList.contains('active'));
  q('#f-status [data-s="tbr"]').click();
  ok('unsaved pick does not touch the book', run(`library[0].status`) === 'read');
  ok('unsaved pick marks no DNF prompt', run(`window.__dnf.length`) === 0);
  q('#m-x').click(); // close without Save
  runInWindow(`openDetail('b1')`);
  ok('reopened modal shows the saved status, not the unsaved pick',
    q('#f-status [data-s="read"]').classList.contains('active') &&
    !q('#f-status [data-s="tbr"]').classList.contains('active'));
  q('#m-x').click();
  runInWindow(`view = 'library'; render();`);
  const tileBadge = q('.book-tile .tile-badge');
  ok('grid tag still shows the saved status after a discarded pick',
    !!tileBadge && tileBadge.getAttribute('aria-label') === 'Read');
  // Save commits the staged pick
  runInWindow(`openDetail('b1')`);
  q('#f-status [data-s="tbr"]').click();
  q('#m-save').click();
  await tick(30);
  ok('Save commits the staged pick', run(`library[0].status`) === 'tbr');
  // DNF prompt fires on Save, not on pick
  runInWindow(`openDetail('b1')`);
  q('#f-status [data-s="dnf"]').click();
  ok('DNF pick alone does not prompt', run(`window.__dnf.length`) === 0);
  q('#m-save').click();
  await tick(30);
  ok('DNF prompt fires on Save', JSON.stringify(run(`window.__dnf`)) === '["b1"]' &&
    run(`library[0].status`) === 'dnf');
  // ...and an unsaved DNF pick prompts nothing and changes nothing
  setLib([mk('b2', 'Second Book', 'read', { progress: 200 })]);
  runInWindow(`openDetail('b2')`);
  q('#f-status [data-s="dnf"]').click();
  q('#m-x').click();
  ok('discarded DNF pick: no prompt, no change',
    run(`window.__dnf.length`) === 1 && run(`library[0].status`) === 'read');

  /* ---------- 4. Shelves tab: five statuses ---------- */
  setLib([mk('t1', 'TBR One', 'tbr'), mk('r1', 'Reading One', 'reading'),
    mk('d1', 'Read One', 'read'), mk('w1', 'Wishlist One', 'wishlist'), mk('f1', 'DNF One', 'dnf')]);
  runInWindow(`shelfSetViewMode('2d'); shelfGroup = 'tbr'; renderShelf();`);
  ok('SHELF_GROUPS models all five statuses',
    JSON.stringify(run(`SHELF_GROUPS.slice()`)) === '["tbr","reading","read","wishlist","dnf"]');
  const chipGroups = qa('#view .sv-chip').map(c => c.dataset.g);
  ok('shelf chips render for all five groups',
    ['tbr', 'reading', 'read', 'wishlist', 'dnf'].every(g => chipGroups.includes(g)));
  const wishChip = qa('#view .sv-chip').find(c => c.dataset.g === 'wishlist');
  ok('wishlist chip carries its count', !!wishChip && wishChip.textContent.includes('1'));
  wishChip.click();
  ok('wishlist group renders its book', !!q('#view [data-id="w1"]'));
  qa('#view .sv-chip').find(c => c.dataset.g === 'dnf').click();
  ok('dnf group renders its book', !!q('#view [data-id="f1"]'));
  // move-to sheet offers every destination
  runInWindow(`shelfOpenPhotoSheet('t1')`);
  const dests = qa('#svSheet [data-shelf]').map(b => b.dataset.shelf);
  ok('move-to sheet offers all five destinations',
    ['tbr', 'reading', 'read', 'wishlist', 'dnf'].every(g => dests.includes(g)));
  qa('#svSheet [data-shelf]').find(b => b.dataset.shelf === 'wishlist').click();
  ok('move-to moves the book to the wishlist shelf', run(`library.find(b => b.id === 't1').status`) === 'wishlist');
  runInWindow(`shelfCloseSheet();`);

  /* ---------- 6 + 8. Settings: unhide chips + ledger total ---------- */
  setLib([mk('s1', 'Priced One', 'read'), mk('s2', 'Priced Two', 'read')]);
  runInWindow(`cloudUser = { id: 'u1', email: 'u@example.com' };
    circlePrivacy = async () => ({ share: true, hidden: ['wishlist'], bio: true, activity: false, recos: true, buddy: true });`);
  runInWindow(`view = 'settings'; renderSettings();`);
  await waitFor(() => !!q('#st-hide'));
  const hideChips = qa('#st-hide [data-shelf]').map(c => c.dataset.shelf);
  ok('hide chips render for every status (incl. empty shelves)',
    ['tbr', 'reading', 'read', 'dnf', 'wishlist'].every(s => hideChips.includes(s)));
  const wishHide = qa('#st-hide [data-shelf]').find(c => c.dataset.shelf === 'wishlist');
  ok('hidden + empty shelf shows its (active) unhide chip', !!wishHide && wishHide.classList.contains('active'));
  const spentStat = () => qa('.stat').find(el => el.querySelector('.l') && el.querySelector('.l').textContent === 'Total spent');
  ok('ledger renders TOTAL SPENT with no priced books', !!spentStat() &&
    spentStat().querySelector('.n').textContent === run(`formatMoney(0)`));
  runInWindow(`library[0].purchasePrice = 12.5; library[0].purchaseSource = 'Indigo';
    library[1].purchasePrice = 7.5; library[1].purchaseSource = 'Amazon'; renderSettings();`);
  await tick(60);
  ok('ledger TOTAL SPENT equals the sum of its entries', !!spentStat() &&
    spentStat().querySelector('.n').textContent === run(`formatMoney(20)`));
  const rowSum = qa('.ledger-row').reduce((acc, r) => {
    const m = r.textContent.match(/([\d.]+)\s*$/);
    return acc + (m ? parseFloat(m[1]) : 0);
  }, 0);
  ok('by-source rows sum to the same total', Math.abs(rowSum - 20) < 0.001);

  /* ---------- 1. import keeps ids ---------- */
  runInWindow(`localStorage.clear(); library = []; tombstones = [{ id: 'x3', at: 1 }];
    upNext = ['x2', 'x1']; shelfOrder().tbr = ['x2', 'x1']; saveShelfOrder(shelfOrder()); shelfGroup = 'tbr';
    library = [${JSON.stringify(mk('x1', 'Old Title', 'tbr'))}]; saveLibrary({ noCloud: true });`);
  runInWindow(`view = 'settings'; renderSettings();`);
  await tick(80);
  const backup = JSON.stringify({ books: [
    mk('x1', 'Restored Title', 'tbr'),
    mk('x2', 'Second Book', 'tbr'),
    mk('x3', 'Zombie Book', 'read'),
    mk('zz', 'Second Book', 'tbr', { authors: ['Au x2'] }), // same title+author as x2, new id → dupe skip
    (() => { const b = mk('n1', 'No Id Book', 'tbr'); delete b.id; return b; })(),
    { authors: ['Nobody'] }, // no title → skipped
  ] });
  const fileInput = q('#bk-file');
  ok('settings backup file input exists', !!fileInput);
  const file = new window.File([backup], 'backup.json', { type: 'application/json' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change'));
  await waitFor(() => run(`library.length`) === 4);
  ok('import lands new + restored books, skips dupes/titleless', run(`library.length`) === 4);
  ok('existing id overwritten in place (restore), not duplicated',
    run(`library.filter(b => b.id === 'x1').length`) === 1 && run(`library.find(b => b.id === 'x1').title`) === 'Restored Title');
  ok('new books keep their exported ids', run(`library.some(b => b.id === 'x2')`));
  ok('tombstoned book restores and lifts its tombstone',
    run(`library.some(b => b.id === 'x3')`) && run(`tombstones.some(t => t.id === 'x3')`) === false);
  ok('id-less record mints a fresh id', run(`library.some(b => b.title === 'No Id Book' && b.id)`));
  ok('Up Next queue survives the restore (ids still resolve)',
    JSON.stringify(run(`upNext.slice()`)) === '["x2","x1"]' &&
    run(`upNext.every(id => library.some(b => b.id === id))`));
  ok('manual shelf order survives the restore (saved order first, new books append)',
    JSON.stringify(run(`shelfBooks().map(b => b.id).slice(0, 2)`)) === '["x2","x1"]');
  // re-import: no duplicates
  fileInput.dispatchEvent(new window.Event('change'));
  await waitFor(() => run(`library.filter(b => b.id === 'x1').length`) === 1 && run(`library.length`) === 4, 1500);
  await tick(120);
  ok('re-importing the same backup does not duplicate', run(`library.length`) === 4);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
