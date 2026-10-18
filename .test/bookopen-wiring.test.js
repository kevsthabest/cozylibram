// Book-opening transition, everywhere (User's work order): every cover tap
// hands its cover element to openBookFromEl so the tapped cover flies to
// centre and swings open; text-only and programmatic opens stay plain; and
// a second open while a transition is in flight skips straight to the
// modal — no stacked animation, no lost open, no stale landing.
//
// The surfaces pinned here are the ones wired by this change. The Library
// grid / spines / wishlist / stats cards were already wired and stay
// covered by their own suites (recent.test.js pins the transition itself).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in bookopen tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, what) => {
  for (let i = 0; i < 40; i++) { if (fn()) return true; await sleep(100); }
  console.log('  (timed out waiting for: ' + what + ')');
  return false;
};
const modalShows = (title) => { const m = q('#m-back'); return !!m && m.textContent.includes(title); };
const closeModal = () => { const x = q('#m-x'); if (x) x.click(); };
/* A landed transition's overlay fades for ~450ms after the modal arrives.
   Steps that assert "no overlay" (plain opens) or read the staged pages
   must wait out that fade, or they'd sample the previous step's overlay. */
const settle = async () => { await waitFor(() => qa('.bookopen-overlay').length === 0, 'overlay cleanup'); };

const book = (id, over) => Object.assign({
  id, isbn: '', title: 'Title ' + id, authors: ['A U Thor'], cover: 'cover-' + id + '.jpg',
  description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 0,
  log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false,
  owned: true, series: null, series2: null, quotes: [], _mtime: 0
}, over);

const books = [
  book('g1', { title: 'Guard One' }),
  book('g2', { title: 'Guard Two' }),
  book('u1', { title: 'Up Next One' }),
  book('u2', { title: 'Up Next Two' }),
  book('sA', { title: 'Series Alpha', status: 'read', series: { name: 'The Saga', position: 1 } }),
  book('sB', { title: 'Series Beta', series: { name: 'The Saga', position: 2 } }),
  book('a1', { title: 'Authored One' }),
  book('q1', { title: 'Quoted One', quotes: [{ t: 'A line worth keeping', p: 42, at: '2026-01-01' }] }),
  book('r1', { title: 'Reading One', status: 'reading', progress: 40, pageCount: 200, _mtime: 2000 }),
  book('r2', { title: 'Reading Two', status: 'reading', progress: 10, pageCount: 100, _mtime: 1000 }),
  book('base', { title: 'Base Book', tropes: ['alpha trope'] }),
  book('sim', { title: 'Sim Book', tropes: ['alpha trope'] })
];

(async () => {
  runInWindow(`localStorage.clear(); localStorage.setItem('spicyshelves.animation', 'on'); library = [];
    library.push(${books.map(b => JSON.stringify(b)).join(',')});
    saveLibrary();
    window.__el1 = document.createElement('div'); document.body.appendChild(window.__el1);
    window.__el2 = document.createElement('div'); document.body.appendChild(window.__el2);`);

  /* ---- 1. the in-flight guard ---- */
  probe(`openDetail('g1', { fromEl: window.__el1 });`);
  ok('guard: first open stages a transition', !!q('.bookopen-overlay'));
  ok('guard: modal not yet open mid-flight', !q('#m-back'));
  probe(`openDetail('g2', { fromEl: window.__el2 });`);
  ok('guard: second open lands its modal immediately', modalShows('Guard Two'));
  ok('guard: staged cover torn down, no stacked overlay', qa('.bookopen-overlay').length === 0);
  ok('guard: exactly one modal stands', qa('#m-back').length === 1);
  await sleep(1800); // past the first transition's landing + cleanup timers
  ok('guard: stale landing never stomps the newer open', modalShows('Guard Two') && qa('#m-back').length === 1);
  ok('guard: no overlay resurrects afterwards', qa('.bookopen-overlay').length === 0);
  closeModal();
  probe(`openDetail('g1', { fromEl: window.__el1 });`);
  ok('guard: released after supersede — a fresh open animates again', !!q('.bookopen-overlay'));
  ok('guard: the fresh transition lands its book',
    await waitFor(() => modalShows('Guard One') && q('#m-back').classList.contains('from-book'), 'g1 landing'));
  await settle();
  closeModal();

  /* ---- 2. Up Next rows ---- */
  runInWindow(`upNextAdd('u1'); upNextAdd('u2'); renderUpNext();`);
  q('.un-row [data-open]').click();
  ok('up next: tapping a queue row stages the transition', !!q('.bookopen-overlay'));
  ok('up next: the staged pages carry the tapped book',
    !!q('.bop-title') && q('.bop-title').textContent.includes('Up Next One'));
  ok('up next: the modal lands via the book-open entrance',
    await waitFor(() => modalShows('Up Next One') && q('#m-back').classList.contains('from-book'), 'up-next landing'));
  await settle();
  closeModal();

  /* ---- 3. Series overview: covers wired, the Next text button plain ---- */
  runInWindow(`renderSeries();`);
  q('.sr-cover').click();
  ok('series: tapping a series cover stages the transition', !!q('.bookopen-overlay'));
  ok('series: the modal lands via the book-open entrance',
    await waitFor(() => modalShows('Series Alpha') && q('#m-back').classList.contains('from-book'), 'series landing'));
  await settle();
  closeModal();
  q('.sr-next').click();
  ok('series: the Next text button opens plainly (no cover element)',
    modalShows('Series Beta') && qa('.bookopen-overlay').length === 0);
  closeModal();

  /* ---- 4. Author page collection rows ---- */
  runInWindow(`authorView = 'A U Thor'; renderAuthorDetail();`);
  q('#view [data-book]').click();
  ok('author page: tapping a shelf row stages the transition', !!q('.bookopen-overlay'));
  ok('author page: the modal lands on the tapped book',
    await waitFor(() => modalShows('Authored One') && q('#m-back').classList.contains('from-book'), 'author landing'));
  await settle();
  closeModal();

  /* ---- 5. Quotes cards ---- */
  runInWindow(`renderQuotes();`);
  q('.q-list .q-card').click();
  ok('quotes: tapping a quote card stages the transition from its cover', !!q('.bookopen-overlay'));
  ok('quotes: the modal lands on the quoted book',
    await waitFor(() => modalShows('Quoted One') && q('#m-back').classList.contains('from-book'), 'quotes landing'));
  await settle();
  closeModal();

  /* ---- 6. Currently Reading hero: covers wired, Update Progress plain ---- */
  runInWindow(`filter = 'all'; ownFilter = 'all'; query = ''; renderLibrary();`);
  q('.cr-cover').click();
  ok('hero: tapping the hero cover stages the transition', !!q('.bookopen-overlay'));
  ok('hero: the modal lands on the hero book',
    await waitFor(() => modalShows('Reading One') && q('#m-back').classList.contains('from-book'), 'hero landing'));
  await settle();
  closeModal();
  runInWindow(`renderLibrary();`);
  q('.cr-mini').click();
  ok('hero: tapping an also-reading mini stages the transition', !!q('.bookopen-overlay'));
  ok('hero: the modal lands on the mini book',
    await waitFor(() => modalShows('Reading Two') && q('#m-back').classList.contains('from-book'), 'mini landing'));
  await settle();
  closeModal();
  runInWindow(`renderLibrary();`);
  q('.cr-info [data-cr]').click();
  ok('hero: Update Progress (a text button) opens plainly',
    modalShows('Reading One') && qa('.bookopen-overlay').length === 0);
  closeModal();

  /* ---- 7. In-modal series strip figures ---- */
  probe(`openBookFromEl(null, 'sA');`);
  ok('strip: series book opens plainly without an element', modalShows('Series Alpha'));
  q('#m-series [data-book="sB"]').click();
  ok('strip: tapping a sibling cover stages the transition', !!q('.bookopen-overlay'));
  ok('strip: the modal hops to the sibling via the book-open entrance',
    await waitFor(() => modalShows('Series Beta') && q('#m-back').classList.contains('from-book'), 'strip landing'));
  await settle();
  closeModal();

  /* ---- 8. In-modal similar-book covers ---- */
  probe(`openBookFromEl(null, 'base');`);
  const simBtn = q('[data-sim="sim"]');
  ok('similar: the similar-books strip renders cover buttons', !!simBtn);
  simBtn.click();
  ok('similar: tapping a similar cover stages the transition', !!q('.bookopen-overlay'));
  ok('similar: the modal hops to the similar book',
    await waitFor(() => modalShows('Sim Book') && q('#m-back').classList.contains('from-book'), 'sim landing'));
  await settle();
  closeModal();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
