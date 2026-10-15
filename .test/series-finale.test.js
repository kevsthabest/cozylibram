// The Finale (series-finish ceremony + keepsake + wax seal).
// The honesty rule is the feature: "Series complete" + the wax seal ONLY
// when the series total is known (Hardcover listing found) and met;
// otherwise "All caught up" and never a seal. A manual override produces
// caught-up cards, never the seal.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in finale tests'); };

require('./harness').loadApp(window);
const run = (code) => window.eval(code);

const SAGA = [
  { id: 'f1', title: 'Saga One', authors: ['Ann Author'], status: 'read', myRating: 5, pageCount: 300, dateFinished: '2025-01-10T00:00:00.000Z', series: { name: 'The Test Saga', position: 1 } },
  { id: 'f2', title: 'Saga Two', authors: ['Ann Author'], status: 'read', myRating: 4, pageCount: 320, dateFinished: '2025-03-10T00:00:00.000Z', series: { name: 'The Test Saga', position: 2 } },
  { id: 'f3', title: 'Saga Three', authors: ['Ann Author'], status: 'read', myRating: 0, pageCount: 340, dateFinished: '2025-06-10T00:00:00.000Z', series: { name: 'The Test Saga', position: 3 } },
];
const setLib = (books) => run(`library = ${JSON.stringify(books)}`);
const clearFinales = () => run(`localStorage.removeItem('cozylibram.finale.v1')`);

/* ---------- pure evaluation: the honesty rule ---------- */
{
  setLib(SAGA);
  const books = run(`finaleSeriesBooks(library, 'The Test Saga')`);
  ok('series books grouped by name', books.length === 3);

  ok('total known + met -> complete',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f3', { total: 3, maxPos: 3 })`) === 'complete');
  ok('total unknown -> caught up',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f3', null)`) === 'caughtup');
  ok('total unmet (a 4th book exists) -> caught up',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f3', { total: 4, maxPos: 4 })`) === 'caughtup');
  ok('listing continues past the finished book -> caught up',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f3', { total: 3, maxPos: 4 })`) === 'caughtup');

  // not library-complete: one book still reading -> no finale at all
  const partial = SAGA.map(b => b.id === 'f2' ? { ...b, status: 'reading' } : b);
  setLib(partial);
  ok('a book still unread -> no finale',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f3', { total: 3, maxPos: 3 })`) === null);

  // out-of-order finish: a middle/earlier book finished last -> no auto finale
  setLib(SAGA);
  ok('earlier book finished last (out of order) -> no auto finale',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f1', { total: 3, maxPos: 3 })`) === null);

  // single-book "series" never finales
  setLib([SAGA[0]]);
  ok('single-book series -> no finale',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f1', { total: 1, maxPos: 1 })`) === null);

  // finished book is the highest in the library but the series goes on -> caught up
  setLib(SAGA.slice(0, 2));
  ok('library-complete but series continues -> caught up',
    run(`finaleKindFor(finaleSeriesBooks(library, 'The Test Saga'), 'f2', { total: 3, maxPos: 3 })`) === 'caughtup');
}

/* ---------- record building ---------- */
{
  setLib(SAGA);
  const rec = run(`finaleBuildRecord(finaleSeriesBooks(library, 'The Test Saga'),
    library.find(b => b.id === 'f3'), 'complete', {})`);
  ok('record keeps the series name', rec.name === 'The Test Saga');
  ok('record counts the books', rec.count === 3);
  ok('record sums the pages', rec.pages === 960);
  ok('ratings arc is in series order', JSON.stringify(rec.ratings) === '[5,4,0]');
  ok('span opens at the first finish', String(rec.first).indexOf('2025-01-10') === 0);
  ok('span closes at the finale finish', String(rec.last).indexOf('2025-06-10') === 0);
  ok('complete record carries the seal', finaleSealApplies(rec) === true);
  const rec2 = run(`finaleBuildRecord(finaleSeriesBooks(library, 'The Test Saga'),
    library.find(b => b.id === 'f3'), 'caughtup', {})`);
  ok('caught-up record never carries the seal', finaleSealApplies(rec2) === false);
  function finaleSealApplies(r) { return run(`finaleHasSeal(${JSON.stringify(r)})`); }
}

/* ---------- store: normalize + round-trip ---------- */
{
  clearFinales();
  run(`saveFinales({ 'the test saga': finaleBuildRecord(finaleSeriesBooks(library, 'The Test Saga'),
    library.find(b => b.id === 'f3'), 'complete', {}) })`);
  const back = run(`loadFinales()`);
  ok('store round-trips a record', !!back['the test saga'] && back['the test saga'].kind === 'complete');
  const norm = run(`finaleNormalize({ good: { kind: 'complete', at: 5 }, bad: { kind: 'everything' }, junk: 42 })`);
  ok('normalize keeps valid records', !!norm.good);
  ok('normalize drops unknown kinds', !('bad' in norm));
  ok('normalize drops non-records', !('junk' in norm));
}

/* ---------- share-card model: labels + seal discipline ---------- */
{
  const recC = run(`finaleBuildRecord(finaleSeriesBooks(library, 'The Test Saga'),
    library.find(b => b.id === 'f3'), 'complete', {})`);
  const mC = run(`finaleCardModel(${JSON.stringify(recC)})`);
  ok('share model: complete eyebrow', mC.eyebrow === 'SERIES COMPLETE');
  ok('share model: complete draws the seal', mC.seal === true);
  const recU = run(`finaleBuildRecord(finaleSeriesBooks(library, 'The Test Saga'),
    library.find(b => b.id === 'f3'), 'caughtup', {})`);
  const mU = run(`finaleCardModel(${JSON.stringify(recU)})`);
  ok('share model: caught-up eyebrow', mU.eyebrow === 'ALL CAUGHT UP');
  ok('share model: caught-up draws NO seal', mU.seal === false);
}

/* ---------- orchestration: detection, once-only, upgrade ---------- */
(async () => {
  setLib(SAGA);
  clearFinales();
  // Hardcover listing found, series total = exactly what she owns.
  run(`hcReady = () => true`);
  run(`fetchSeriesBooks = async () => ({ rows: [], found: true })`);
  const fin = run(`library.find(b => b.id === 'f3')`);
  await run(`maybeFinaleCeremony(library.find(b => b.id === 'f3'))`);
  let store = run(`loadFinales()`);
  ok('detection records the finale', !!store['the test saga']);
  ok('detection with total known + met records complete', store['the test saga'] && store['the test saga'].kind === 'complete');
  ok('ceremony sheet presented', !!window.document.querySelector('.finale-sheet'));
  ok('ceremony shows Series complete', /SERIES COMPLETE/.test(window.document.querySelector('.finale-sheet').textContent));
  ok('ceremony shows the seal for complete', !!window.document.querySelector('.finale-sheet .finale-seal'));
  run(`closeFinaleCeremony()`);

  // once per series: a second detection changes nothing and does not re-present
  await run(`maybeFinaleCeremony(library.find(b => b.id === 'f3'))`);
  ok('second detection does not re-present', !window.document.querySelector('.finale-sheet'));

  // total unknown -> caught up, no seal anywhere
  clearFinales();
  run(`fetchSeriesBooks = async () => ({ rows: [], found: false })`);
  await run(`maybeFinaleCeremony(library.find(b => b.id === 'f3'))`);
  store = run(`loadFinales()`);
  ok('total unknown records caught up', store['the test saga'] && store['the test saga'].kind === 'caughtup');
  ok('caught-up ceremony has NO seal element', !!window.document.querySelector('.finale-sheet') &&
    !window.document.querySelector('.finale-sheet .finale-seal'));
  run(`closeFinaleCeremony()`);

  // upgrade: a caught-up record becomes complete when the total is later
  // known and met — the seal is earned then, and only then.
  run(`fetchSeriesBooks = async () => ({ rows: [], found: true })`);
  await run(`maybeFinaleCeremony(library.find(b => b.id === 'f3'))`);
  store = run(`loadFinales()`);
  ok('caught-up upgrades to complete when the total checks out', store['the test saga'] && store['the test saga'].kind === 'complete');
  run(`closeFinaleCeremony()`);

  /* ---------- manual override: caught up, never the seal ---------- */
  clearFinales();
  const midLib = SAGA.map(b => b.id === 'f3' ? { ...b, status: 'reading' } : b);
  setLib(midLib);
  run(`fetchSeriesBooks = async () => ({ rows: [], found: true })`); // total known + met, on purpose
  await run(`finaleMarkFinished('the test saga')`);
  store = run(`loadFinales()`);
  ok('override records a finale', !!store['the test saga']);
  ok('override is caught up even when the total is known + met', store['the test saga'] && store['the test saga'].kind === 'caughtup');
  ok('override is marked as an override', store['the test saga'] && store['the test saga'].override === true);
  ok('override record has no seal', run(`finaleHasSeal(loadFinales()['the test saga'])`) === false);
  run(`closeFinaleCeremony()`);

  /* ---------- series view: keepsake, seal, override button ---------- */
  setLib(SAGA);
  clearFinales();
  run(`saveFinales({ 'the test saga': finaleBuildRecord(finaleSeriesBooks(library, 'The Test Saga'),
    library.find(b => b.id === 'f3'), 'complete', {}) })`);
  run(`seriesReturn = 'library'; renderSeries()`);
  const card = window.document.querySelector('.sr-card');
  ok('series card renders the keepsake', !!card && !!card.querySelector('.finale-keep'));
  ok('keepsake names the honour honestly', !!card && /Series complete/.test(card.textContent));
  ok('complete series header carries the seal', !!card && !!card.querySelector('.sr-head .finale-seal'));
  run(`saveFinales({})`);
  run(`renderSeries()`);
  const card2 = window.document.querySelector('.sr-card');
  ok('series without a finale offers Mark as finished', !!card2 && !!card2.querySelector('[data-finale-mark]'));
  ok('no keepsake without a record', !!card2 && !card2.querySelector('.finale-keep'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e); process.exit(1); });
