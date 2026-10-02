// v219: read-only book preview modal for unowned/discovered books.
// Pure (no DOM): previewTransient normalizes every source shape (Discovery
// candidate, New-Release candidate, external missing-by-author row, Coven
// friend book), the transient id is synthetic and never a library id,
// previewSections reports which sections render, the builder never mutates
// its input, and covenCleanCopy drops the friend's personal data.
// jsdom: openPreviewModal renders the read-only chrome (+TBR + Wishlist
// present; every library-only control absent), keeps the v215 sheet chrome,
// closes via X / backdrop / Escape, enriches sparse rows, and the preview's
// +TBR hands off to the real modal while Wishlist adds a clean copy.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in preview tests'); };
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const probe = (js) => window.eval(js);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

const recoSrc = () => ({
  hcId: 4242, title: 'Iron Flame', authors: ['Rebecca Yarros'],
  cover: 'https://x/cover.jpg', description: 'Dragons return.',
  pages: 498, isbns: ['9781649374189'], sim: 0.87, loveAuthor: 'Rebecca Yarros',
  categories: ['Fantasy', 'Romance']
});

(async () => {
  // ---- 1. previewTransient: discovery candidate shape
  const t1 = probe(`previewTransient(${JSON.stringify(recoSrc())}, 'reco')`);
  ok('transient maps title/authors/cover/description', t1.title === 'Iron Flame' &&
    t1.authors.join(',') === 'Rebecca Yarros' && t1.cover === 'https://x/cover.jpg' &&
    t1.description === 'Dragons return.');
  ok('transient maps pages->pageCount, isbns->isbn, hcId', t1.pageCount === 498 &&
    t1.isbn === '9781649374189' && t1.hcId === 4242);
  ok('transient maps categories', t1.categories.join(',') === 'Fantasy,Romance');
  ok('transient id is synthetic', /^preview-/.test(t1.id) && t1.preview === true);
  ok('transient id is not in the library', !probe(`library.some(b => b.id === ${JSON.stringify(t1.id)})`));
  ok('candidate keeps its loveAuthor/sim (untouched by builder)',
    probe(`(() => { const c = ${JSON.stringify(recoSrc())}; previewTransient(c, 'reco'); return c.sim === 0.87 && c.loveAuthor === 'Rebecca Yarros'; })()`));

  // ---- 2. previewTransient: external missing-by-author row shape
  const t2 = probe(`previewTransient({ title: 'Onyx Storm', author: 'Rebecca Yarros', cover: '', isbn: '9781649374189', position: 3, seriesName: 'Empyrean' }, 'external')`);
  ok('external row: singular author -> authors[]', t2.authors.join(',') === 'Rebecca Yarros');
  ok('external row: seriesName+position normalized', t2.series.name === 'Empyrean' && t2.series.position === 3);
  ok('external row: _ext carries the wishlist shape',
    t2._ext.author === 'Rebecca Yarros' && t2._ext.seriesName === 'Empyrean' && t2._ext.position === 3);

  // ---- 3. previewTransient: coven friend book (series as string)
  const t3 = probe(`previewTransient({ title: 'ACOTAR', authors: ['Sarah J. Maas'], series: 'ACOTAR', seriesPos: 1, tropes: ['enemies to lovers'], myRating: 5, progress: 200 }, 'friend')`);
  ok('friend book: string series normalized', t3.series.name === 'ACOTAR' && t3.series.position === 1);
  ok('friend book: tropes carried over', t3.tropes.join(',') === 'enemies to lovers');
  ok('transient drops nothing the modal needs, keeps preview flag', t3.preview === true && t3.kind === 'friend');

  // ---- 4. previewTransient never mutates its input
  ok('builder does not mutate the source object',
    probe(`(() => { const s = ${JSON.stringify(recoSrc())}; const b4 = JSON.stringify(s); previewTransient(s, 'reco'); return JSON.stringify(s) === b4; })()`));

  // ---- 5. previewSections: pure section flags
  const sec = probe(`previewSections(${JSON.stringify(t1)})`);
  ok('sections on for a rich transient',
    sec.description && sec.tropes === false && sec.genres && sec.series === false && sec.actions);
  const secSparse = probe(`previewSections(${JSON.stringify(t2)})`);
  ok('sections off for a sparse transient', !secSparse.description && !secSparse.tropes && !secSparse.genres);
  // v237: format tags are not genres
  ok('bookGenres strips format tags', probe(`bookGenres({categories:['Audiobook','Fiction / Romance']}).join(',')`) === 'Romance');
  const secJunk = probe(`previewSections({categories:['Audiobook','Ebook']})`);
  ok('genres section off when only format tags remain', secJunk.genres === false);

  // ---- 6. covenCleanCopy: friend's personal data never comes along
  const cc = probe(`covenCleanCopy({ title: 'T', authors: ['A'], myRating: 5, progress: 120, dateFinished: '2026-01-01', notes: 'mine', isbn: '1' })`);
  ok('clean copy has no rating/progress/dates/notes',
    !('myRating' in cc) && !('progress' in cc) && !('dateFinished' in cc) && !('notes' in cc));
  ok('clean copy lands on the TBR shelf', cc.status === 'tbr' && cc.title === 'T' && cc.isbn === '1');

  // ---- 7. the modal renders read-only chrome (jsdom)
  probe(`openPreviewModal(previewTransient(${JSON.stringify(recoSrc())}, 'reco'), { source: 'test', why: ['<span class="why-chip">x</span>'], onAddTBR: () => null })`);
  ok('preview opens in #modal-root', !!q('#p-back') && !!q('#p-back .modal'));
  ok('preview shows title + author + description',
    q('#p-back h2').textContent === 'Iron Flame' &&
    q('#p-back .author').textContent.includes('Rebecca Yarros') &&
    q('#p-desc').textContent.includes('Dragons return.'));
  ok('preview has the v215 sheet chrome (grabber pill)', !!q('#p-back .sheet-grabber'));
  ok('preview has +TBR and Wishlist actions', !!q('#p-tbr') && !!q('#p-wish'));
  const LIB_IDS = ['#m-save', '#f-myrating', '#f-notes', '#m-del', '#f-status', '#f-owned',
    '#f-tropes', '#f-tropeadd', '#m-quotes', '#m-primary', '#m-edition', '#m-changecover',
    '#m-progress', '#f-myrating-word', '.modal-actions'];
  ok('no library-only controls render', LIB_IDS.every(s => !q('#p-back ' + s)));
  ok('no status/ownership option buttons render',
    !q('#p-back [data-s]') && !q('#p-back [data-o]') && !q('#p-back [data-ax]'));
  ok('why-chips carried over', q('#p-back .why-chips').textContent === 'x');

  // ---- 8. close paths: X, backdrop, Escape
  q('#p-x').click();
  ok('X closes the preview', !q('#p-back'));
  probe(`openPreviewModal(previewTransient(${JSON.stringify(recoSrc())}, 'reco'), {})`);
  q('#p-back').click(); // the backdrop element itself
  await tick(10);
  ok('backdrop tap closes the preview', !q('#p-back'));
  probe(`openPreviewModal(previewTransient(${JSON.stringify(recoSrc())}, 'reco'), {})`);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick(10);
  ok('Escape closes the preview', !q('#p-back'));

  // ---- 9. +TBR hands off to the real modal via onAddTBR
  let captured = null;
  const realOpenDetail = window.openDetail;
  window.openDetail = (id) => { captured = id; };
  probe(`openPreviewModal(previewTransient(${JSON.stringify(recoSrc())}, 'reco'), { onAddTBR: () => ({ id: 'nb-1' }) })`);
  q('#p-tbr').click();
  await tick(10);
  ok('+TBR closes the preview', !q('#p-back'));
  ok('+TBR opens the real modal for the new book id', captured === 'nb-1');
  window.openDetail = realOpenDetail;
  // a null add (already on shelves) keeps the preview open
  probe(`openPreviewModal(previewTransient(${JSON.stringify(recoSrc())}, 'reco'), { onAddTBR: () => null })`);
  q('#p-tbr').click();
  await tick(10);
  ok('failed add keeps the preview open', !!q('#p-back'));
  q('#p-x').click();

  // ---- 10. Wishlist adds a clean copy and becomes a confirmation
  probe(`library.length = 0; openPreviewModal(previewTransient({ title: 'Wish Me', author: 'Jane Doe', cover: '', isbn: '', position: null, seriesName: null }, 'external'), { source: 'test' })`);
  q('#p-wish').click();
  await tick(10);
  const added = probe(`library.find(b => b.title === 'Wish Me')`);
  ok('wishlist adds the book as not-owned', !!added && added.owned === 'tobuy' && added.status === 'tbr');
  ok('wishlist button becomes a confirmation', !q('#p-wish') &&
    window.document.body.textContent.includes('In your wishlist'));
  q('#p-x').click();

  // ---- 11. sparse rows enrich in the background (stubbed network)
  window.lookupISBN = async () => ({
    title: 'Onyx Storm', authors: ['Rebecca Yarros'], cover: 'https://x/onyx.jpg',
    description: 'A storm of onyx wings.', pageCount: 527, publishedDate: '2025-01-21',
    categories: ['Fantasy'], isbn: '9781649374189', publicRating: 4.6, ratingsCount: 9000,
  });
  probe(`openPreviewModal(previewTransient({ title: 'Onyx Storm', author: 'Rebecca Yarros', cover: '', isbn: '9781649374189', position: 3, seriesName: 'Empyrean' }, 'external'), { source: 'test' })`);
  ok('sparse preview renders before enrichment lands', !q('#p-desc'));
  await tick(60);
  ok('enrichment fills the description', (q('#p-desc') || {}).textContent.includes('onyx wings'));
  ok('enrichment fills pages + year', q('#p-meta').textContent.includes('527') && q('#p-meta').textContent.includes('2025'));
  q('#p-x').click();

  // ---- 12. author page: tapping a missing row opens the preview; the
  // +Wishlist row button still adds without opening anything
  window.fetch = async (url) => {
    if (String(url).includes('openlibrary.org/search.json?author=')) {
      return { json: async () => ({ docs: [
        { title: 'Missing Book Two', author_name: ['Jane Doe'], cover_i: 0, isbn: [] },
      ] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  probe(`library.length = 0;
    library.push({ id: 'a1', isbn: '', title: 'Owned Book', authors: ['Jane Doe'], cover: '',
      description: '', pageCount: 200, publishedDate: '', categories: [], publicRating: null,
      ratingsCount: 0, status: 'read', owned: 'owned', ratings: {}, axes: [], myRating: 0,
      tropes: [], progress: 200, dateAdded: new Date().toISOString(), dateFinished: null,
      notes: '', favorite: false, log: [] });
    openAuthor('Jane Doe');`);
  await tick(60);
  const row = q('[data-miss]');
  ok('missing row rendered on author page', !!row);
  row.click();
  await tick(30);
  ok('tapping the row opens the preview modal',
    !!q('#p-back') && q('#p-back h2').textContent === 'Missing Book Two');
  q('#p-x').click();
  q('[data-madd]').click();
  await tick(30);
  ok('wishlist row button does not open the preview', !q('#p-back'));
  ok('wishlist row button adds the book',
    probe(`library.some(b => b.title === 'Missing Book Two' && b.owned === 'tobuy')`));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
