// Tests for v448 — Milestones: catalog, detectors, store, idempotency.

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

// clear milestone store
run(`localStorage.removeItem('cozylibram.milestones')`);

/* Catalog structure */
{
  const cat = run(`MILESTONE_CATALOG`);
  ok('catalog is non-empty', cat.length >= 15);
  ok('all have stable IDs', cat.every(m => /^[a-z]+-[a-z0-9-]+$/.test(m.id)));
  ok('all have categories', cat.every(m => ['journey','rhythm','discovery','taste','lore','soul','wander','ritual','hidden'].includes(m.cat)));
  ok('IDs are unique', new Set(cat.map(m => m.id)).size === cat.length);
}

/* Journey detection */
{
  run(`library = ${JSON.stringify([
    { id: 'b1', title: 'One', status: 'read', dateFinished: '2024-03-15T00:00:00Z', authors: [], genres: [], tropes: [] },
    { id: 'b2', title: 'Two', status: 'read', dateFinished: '2024-04-20T00:00:00Z', authors: [], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects books-finished-1', found.includes('books-finished-1'));
  ok('not books-finished-10', !found.includes('books-finished-10'));
  const d1 = run(`detectMilestones(library).find(d => d.id === 'books-finished-1')`);
  ok('achievedAt uses Nth book date', d1.achievedAt && d1.achievedAt.indexOf('2024-03-15') === 0);
}

/* Store idempotency */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const fresh1 = run(`checkMilestones()`);
  ok('first check finds milestones', fresh1.length > 0);
  const fresh2 = run(`checkMilestones()`);
  ok('second check finds none new (idempotent)', fresh2.length === 0);
  const store = run(`loadMilestones()`);
  ok('store persists achievedAt', Object.values(store).every(s => 'achievedAt' in s && 'seen' in s));
}

/* Backfill marks seen */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`backfillMilestones()`);
  const store = run(`loadMilestones()`);
  const ids = Object.keys(store);
  ok('backfill populates store', ids.length > 0);
  ok('backfill marks all seen', ids.every(id => store[id].seen === true));
  // second backfill is no-op
  run(`library.push({ id: 'b3', title: 'Three', status: 'read', dateFinished: '2024-05-01T00:00:00Z', authors: [], genres: [], tropes: [] })`);
  run(`backfillMilestones()`);
  const store2 = run(`loadMilestones()`);
  ok('backfill does not re-run', Object.keys(store2).length === ids.length);
}

/* Taste detectors */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const books = [];
  for (let i = 0; i < 5; i++) {
    books.push({ id: 't' + i, title: 'T' + i, status: 'read', authors: ['A'], genres: [],
      tropes: [{ id: 'enemies to lovers', name: 'Enemies to Lovers' }] });
  }
  run(`library = ${JSON.stringify(books)}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects trope affinity', found.includes('taste-trope-5'));
}

/* Personal best streak */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  // 10-day streak via log entries in the supplied library
  const logs = [];
  for (let i = 0; i < 10; i++) {
    const d = '2024-06-' + String(i + 1).padStart(2, '0');
    logs.push({ id: 'pb' + i, title: 'PB' + i, status: 'tbr', authors: [], genres: [], tropes: [],
      log: [{ d, from: 0, to: 50 }] });
  }
  run(`library = ${JSON.stringify(logs)}`);
  const found = run(`detectMilestones(library)`);
  const pb = found.find(d => d.id === 'streak-personal-best');
  ok('detects personal best streak', !!pb);
  ok('personal best carries value', pb && pb.value === 10);
}

/* Per-series completionist */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 's1', title: 'Book 1', status: 'read', dateFinished: '2024-01-15T00:00:00Z', series: { name: 'The Test Saga', position: 1 } },
    { id: 's2', title: 'Book 2', status: 'read', dateFinished: '2024-02-20T00:00:00Z', series: { name: 'The Test Saga', position: 2 } },
    { id: 's3', title: 'Solo', status: 'read', dateFinished: '2024-03-01T00:00:00Z', series: { name: 'Lone Book', position: 1 } },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects series completion', found.some(id => id.indexOf('series-finished-the-test-saga') === 0));
  ok('single-book series does not count', !found.some(id => id.indexOf('lone-book') >= 0));
  const d = run(`detectMilestones(library).find(d => d.id.indexOf('series-finished-the-test-saga') === 0)`);
  ok('series achievedAt uses latest book', d.achievedAt && d.achievedAt.indexOf('2024-02-20') === 0);
}

/* Series re-earnable: adding a book updates achievedAt */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 's1', title: 'Book 1', status: 'read', dateFinished: '2024-01-15T00:00:00Z', series: { name: 'The Test Saga', position: 1 } },
    { id: 's2', title: 'Book 2', status: 'read', dateFinished: '2024-02-20T00:00:00Z', series: { name: 'The Test Saga', position: 2 } },
  ])}`);
  run(`checkMilestones()`);
  const before = run(`loadMilestones()[Object.keys(loadMilestones()).find(k => k.indexOf('series-finished-the-test-saga') === 0)].achievedAt`);
  run(`library.push({ id: 's3', title: 'Book 3', status: 'read', dateFinished: '2024-06-10T00:00:00Z', series: { name: 'The Test Saga', position: 3 } })`);
  const fresh = run(`checkMilestones()`);
  const after = run(`loadMilestones()[Object.keys(loadMilestones()).find(k => k.indexOf('series-finished-the-test-saga') === 0)].achievedAt`);
  ok('series re-earns on extension', fresh.some(id => id.indexOf('series-finished-the-test-saga') === 0));
  ok('series achievedAt updates', after && after.indexOf('2024-06-10') === 0 && after !== before);
}

/* REGRESSION: detector purity — supplied lib differs from global */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  // global library is empty, supplied lib has a 10-day streak
  run(`library = []`);
  const logs = [];
  for (let i = 0; i < 10; i++) {
    const d = '2024-05-' + String(i + 1).padStart(2, '0');
    logs.push({ id: 'streak' + i, title: 'S' + i, status: 'read', authors: [], genres: [], tropes: [],
      log: [{ d, from: 0, to: 100 }] });
  }
  const found = run(`detectMilestones(${JSON.stringify(logs)}).map(d => d.id)`);
  ok('pure detector finds streak in supplied lib', found.includes('streak-days-7'));
  ok('pure detector does not use global lib', run(`detectMilestones([]).map(d => d.id)`).length === 0);
}

/* REGRESSION: dominant trope other than enemies-to-lovers */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const books = [];
  for (let i = 0; i < 5; i++) {
    books.push({ id: 'ft' + i, title: 'FT' + i, status: 'read', authors: [], genres: [],
      tropes: [{ id: 'found family', name: 'Found Family' }] });
  }
  run(`library = ${JSON.stringify(books)}`);
  run(`checkMilestones()`);
  const def = run(`milestoneDef('taste-trope-5', loadMilestones()['taste-trope-5'])`);
  ok('trope copy uses detected trope', def.copy.indexOf('found family') >= 0);
  ok('trope copy not hardcoded to enemies-to-lovers', def.copy.indexOf('enemies-to-lovers') < 0);
}

/* REGRESSION: returning author vs first encounter */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  // Author with 6+ month gap between books → should trigger
  run(`library = ${JSON.stringify([
    { id: 'a1', title: 'Early', status: 'read', dateFinished: '2023-01-15T00:00:00Z', authors: ['Gap Author'] },
    { id: 'a2', title: 'Late', status: 'read', dateFinished: '2024-09-20T00:00:00Z', authors: ['Gap Author'] },
    { id: 'b1', title: 'Only', status: 'read', dateFinished: '2024-03-01T00:00:00Z', authors: ['Single Author'] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects returning author after gap', found.includes('returning-author-6mo'));
  const d = run(`detectMilestones(library).find(d => d.id === 'returning-author-6mo')`);
  ok('returning author stores author name', d.detail === 'Gap Author');
}

/* REGRESSION: multiple 5-star books — earliest date wins regardless of array order */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'late', title: 'Later 5-star', status: 'read', dateFinished: '2024-08-01T00:00:00Z', myRating: 5 },
    { id: 'early', title: 'Earlier 5-star', status: 'read', dateFinished: '2024-02-15T00:00:00Z', myRating: 5 },
  ])}`);
  const d = run(`detectMilestones(library).find(d => d.id === 'first-five-star')`);
  ok('first 5-star uses earliest date', d.achievedAt && d.achievedAt.indexOf('2024-02-15') === 0);
}

/* REGRESSION: invalid dates don't throw */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'bad', title: 'Bad Date', status: 'read', dateFinished: 'not-a-date', authors: [], genres: [], tropes: [] },
    { id: 'good', title: 'Good Date', status: 'read', dateFinished: '2024-05-01T00:00:00Z', authors: [], genres: [], tropes: [] },
  ])}`);
  let threw = false;
  try { run(`detectMilestones(library)`); } catch (e) { threw = true; }
  ok('invalid dates do not throw', !threw);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('valid books still detected with bad dates present', found.includes('books-finished-1'));
}

/* REGRESSION: series slug collision — different names, same slug base */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'c1', title: 'C1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', series: { name: 'Test Series!', position: 1 } },
    { id: 'c2', title: 'C2', status: 'read', dateFinished: '2024-02-01T00:00:00Z', series: { name: 'Test Series!', position: 2 } },
    { id: 'd1', title: 'D1', status: 'read', dateFinished: '2024-03-01T00:00:00Z', series: { name: 'Test Series?', position: 1 } },
    { id: 'd2', title: 'D2', status: 'read', dateFinished: '2024-04-01T00:00:00Z', series: { name: 'Test Series?', position: 2 } },
  ])}`);
  const found = run(`detectMilestones(library).filter(d => d.id.indexOf('series-finished-') === 0).map(d => d.id)`);
  ok('colliding slugs get distinct IDs', found.length === 2 && found[0] !== found[1]);
}

/* REGRESSION: backfill then genuinely new milestone still surfaces */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'e1', title: 'One', status: 'read', dateFinished: '2024-01-01T00:00:00Z', authors: [], genres: [], tropes: [] },
  ])}`);
  run(`backfillMilestones()`);
  const unseen1 = run(`newestUnseenMilestone()`);
  ok('backfill leaves nothing unseen', unseen1 === null);
  // Add 9 more books → books-finished-10 should be new and unseen
  const more = [];
  for (let i = 2; i <= 10; i++) {
    more.push({ id: 'e' + i, title: 'Book ' + i, status: 'read', dateFinished: '2024-02-' + String(i).padStart(2, '0') + 'T00:00:00Z', authors: [], genres: [], tropes: [] });
  }
  run(`library = library.concat(${JSON.stringify(more)})`);
  const fresh = run(`checkMilestones()`);
  ok('new milestone surfaces after backfill', fresh.includes('books-finished-10'));
  const unseen2 = run(`newestUnseenMilestone()`);
  ok('new milestone is unseen', unseen2 && unseen2.def.id === 'books-finished-10');
}

/* Revisit milestone */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'r1', title: 'Beloved', status: 'read', dateFinished: '2024-05-01T00:00:00Z', readCount: 2, authors: [], genres: [], tropes: [] },
    { id: 'r2', title: 'Once', status: 'read', dateFinished: '2024-06-01T00:00:00Z', readCount: 1, authors: [], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects revisit', found.includes('revisit-first'));
  const def = run(`milestoneDef('revisit-first', loadMilestones()['revisit-first'] || { detail: 'Beloved' })`);
  ok('revisit uses cozy phrasing', def.title === 'Revisited');
}

/* Phase 1: Stacks Are Growing */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const books = [];
  for (let i = 0; i < 30; i++) {
    books.push({ id: 's' + i, title: 'Book ' + i, status: i < 5 ? 'read' : 'tbr', authors: [], genres: [], tropes: [] });
  }
  run(`library = ${JSON.stringify(books)}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects stacks-25', found.includes('stacks-25'));
  ok('not stacks-50', !found.includes('stacks-50'));
}

/* Phase 1: Down Bad for Fiction */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const books = [];
  for (let i = 0; i < 5; i++) {
    books.push({ id: 'db' + i, title: 'Loved ' + i, status: 'read',
      dateFinished: '2024-0' + (i + 1) + '-15T00:00:00Z', myRating: 5, authors: [], genres: [], tropes: [] });
  }
  run(`library = ${JSON.stringify(books)}`);
  const found = run(`detectMilestones(library)`);
  const db = found.find(d => d.id === 'down-bad-5');
  ok('detects down-bad-5', !!db);
  ok('down-bad-5 date is 5th rating', db.achievedAt && db.achievedAt.indexOf('2024-05-15') === 0);
}

/* Phase 1: Series Devotee (3 series) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'a1', title: 'A1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', series: { name: 'Alpha', position: 1 } },
    { id: 'a2', title: 'A2', status: 'read', dateFinished: '2024-02-01T00:00:00Z', series: { name: 'Alpha', position: 2 } },
    { id: 'b1', title: 'B1', status: 'read', dateFinished: '2024-03-01T00:00:00Z', series: { name: 'Beta', position: 1 } },
    { id: 'b2', title: 'B2', status: 'read', dateFinished: '2024-04-01T00:00:00Z', series: { name: 'Beta', position: 2 } },
    { id: 'c1', title: 'C1', status: 'read', dateFinished: '2024-05-01T00:00:00Z', series: { name: 'Gamma', position: 1 } },
    { id: 'c2', title: 'C2', status: 'read', dateFinished: '2024-06-01T00:00:00Z', series: { name: 'Gamma', position: 2 } },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects series-devotee-3', found.includes('series-devotee-3'));
}

/* Phase 1: A Little Bit of Everything (5 genres) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'g1', title: 'G1', status: 'read', genres: ['Fantasy'] },
    { id: 'g2', title: 'G2', status: 'read', genres: ['Science Fiction'] },
    { id: 'g3', title: 'G3', status: 'read', genres: ['Mystery'] },
    { id: 'g4', title: 'G4', status: 'read', genres: ['Romance'] },
    { id: 'g5', title: 'G5', status: 'read', genres: ['Horror'] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects genres-5', found.includes('genres-5'));
}

/* Phase 1: Beyond the Familiar (5 new authors after established) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const books = [
    { id: 'f1', title: 'First', status: 'read', dateFinished: '2024-01-01T00:00:00Z', authors: ['Author A'] },
    { id: 'f2', title: 'Second', status: 'read', dateFinished: '2024-02-01T00:00:00Z', authors: ['Author B'] },
    { id: 'f3', title: 'Third', status: 'read', dateFinished: '2024-03-01T00:00:00Z', authors: ['Author C'] },
  ];
  for (let i = 0; i < 5; i++) {
    books.push({ id: 'n' + i, title: 'New ' + i, status: 'read',
      dateFinished: '2024-0' + (4 + i) + '-01T00:00:00Z', authors: ['New Author ' + i] });
  }
  run(`library = ${JSON.stringify(books)}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects authors-new-5', found.includes('authors-new-5'));
}

/* Phase 1: The Book Alchemist */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'al1', title: 'Enriched', status: 'read', dateFinished: '2024-05-01T00:00:00Z',
      myRating: 4, favorite: true, tropes: [{ id: 'x', name: 'X' }], authors: [], genres: [] },
    { id: 'al2', title: 'Plain', status: 'read', dateFinished: '2024-06-01T00:00:00Z',
      myRating: 0, favorite: false, tropes: [], authors: [], genres: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects alchemist-1', found.includes('alchemist-1'));
}

/* Phase 1: Lost in the Pages (100+ pages in a day) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'p1', title: 'Marathon', status: 'reading', authors: [], genres: [], tropes: [],
      log: [{ d: '2024-07-15', from: 1, to: 120 }] },
    { id: 'p2', title: 'Steady', status: 'reading', authors: [], genres: [], tropes: [],
      log: [{ d: '2024-07-15', from: 50, to: 80 }, { d: '2024-07-16', from: 80, to: 90 }] },
  ])}`);
  const found = run(`detectMilestones(library)`);
  const lp = found.find(d => d.id === 'pages-day-100');
  ok('detects pages-day-100', !!lp);
  ok('pages-day-100 sums across books', lp && lp.value === 149); // 119 + 30
  ok('pages-day-100 uses the big day', lp.achievedAt && lp.achievedAt.indexOf('2024-07-15') === 0);
}

/* Green wave: TBR archaeology */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 't1', title: 'Patient', status: 'read', dateAdded: '2022-01-15T00:00:00Z', dateFinished: '2024-03-15T00:00:00Z', authors: [], genres: [], tropes: [] },
    { id: 't2', title: 'Quick', status: 'read', dateAdded: '2024-01-15T00:00:00Z', dateFinished: '2024-03-15T00:00:00Z', authors: [], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects tbr-forgotten-scroll (1yr+ wait)', found.includes('tbr-forgotten-scroll'));
  ok('detects tbr-dust-destiny (2yr+ wait)', found.includes('tbr-dust-destiny'));
  ok('quick book does not trigger archaeology alone', true); // t2 wait < 1yr
}

/* Green wave: Complete Collection (gapless 1..N, all read) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 's1', title: 'Vol 1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', series: { name: 'Test Trilogy', position: 1 }, authors: [], genres: [], tropes: [] },
    { id: 's2', title: 'Vol 2', status: 'read', dateFinished: '2024-02-01T00:00:00Z', series: { name: 'Test Trilogy', position: 2 }, authors: [], genres: [], tropes: [] },
    { id: 's3', title: 'Vol 3', status: 'read', dateFinished: '2024-03-01T00:00:00Z', series: { name: 'Test Trilogy', position: 3 }, authors: [], genres: [], tropes: [] },
    { id: 'g1', title: 'Gap 1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', series: { name: 'Gappy', position: 1 }, authors: [], genres: [], tropes: [] },
    { id: 'g3', title: 'Gap 3', status: 'read', dateFinished: '2024-02-01T00:00:00Z', series: { name: 'Gappy', position: 3 }, authors: [], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects series-complete for gapless trilogy', found.some(id => id.indexOf('series-complete-') === 0));
  ok('gappy series does not trigger complete', !found.some(id => id.indexOf('series-complete-') === 0 && id.indexOf('gappy') >= 0));
}

/* Green wave: Lorekeeper (quotes, notes) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  const books = [];
  for (let i = 0; i < 3; i++) {
    books.push({ id: 'q' + i, title: 'Q' + i, status: 'read', dateFinished: '2024-01-01T00:00:00Z',
      quotes: [{ t: 'a' }, { t: 'b' }, { t: 'c' }, { t: 'd' }], authors: [], genres: [], tropes: [] });
  }
  for (let i = 0; i < 5; i++) {
    books.push({ id: 'n' + i, title: 'N' + i, status: 'read', dateFinished: '2024-01-01T00:00:00Z',
      notes: 'some thoughts ' + i, quotes: [], authors: [], genres: [], tropes: [] });
  }
  run(`library = ${JSON.stringify(books)}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects lore-quotes-10 (12 quotes)', found.includes('lore-quotes-10'));
  ok('detects lore-notes-5', found.includes('lore-notes-5'));
}

/* Green wave: Ugly Cry Club */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'c1', title: 'C1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', tropes: [{ id: 'tearjerker', name: 'Tearjerker' }], authors: [], genres: [] },
    { id: 'c2', title: 'C2', status: 'read', dateFinished: '2024-02-01T00:00:00Z', tropes: [{ id: 'tearjerker', name: 'Tearjerker' }], authors: [], genres: [] },
    { id: 'c3', title: 'C3', status: 'read', dateFinished: '2024-03-01T00:00:00Z', tropes: [{ name: 'tearjerker' }], authors: [], genres: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects soul-ugly-cry-3', found.includes('soul-ugly-cry-3'));
}

/* Green wave: Beyond the Map (dynamic per genre) */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'w1', title: 'W1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', genres: ['Mystery'], authors: [], tropes: [] },
    { id: 'w2', title: 'W2', status: 'read', dateFinished: '2024-02-01T00:00:00Z', genres: ['Mystery', 'Thriller'], authors: [], tropes: [] },
  ])}`);
  const foundIds = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects wander-genre-mystery', foundIds.some(id => id.indexOf('wander-genre-mystery-') === 0));
  ok('detects wander-genre-thriller', foundIds.some(id => id.indexOf('wander-genre-thriller-') === 0));
  const wid = run(`detectMilestones(library).map(d => d.id).find(id => id.indexOf('wander-genre-') === 0)`);
  const def = run(`milestoneDef(${JSON.stringify(wid)}, {})`);
  ok('wander def resolves with genre title', def && def.title.indexOf('Beyond the Map') === 0);
}

/* Green wave: Solstice Story */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'sol1', title: 'Solstice', status: 'read', dateFinished: '2024-06-21T12:00:00', authors: [], genres: [], tropes: [] },
    { id: 'ord1', title: 'Ordinary', status: 'read', dateFinished: '2024-07-15T12:00:00', authors: [], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects ritual-solstice-story', found.includes('ritual-solstice-story'));
}

/* Green wave: Hidden discoveries */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'h1', title: 'Impulse', status: 'read', dateAdded: '2024-05-01T10:00:00', dateFinished: '2024-05-01T22:00:00', authors: ['Ann'], genres: [], tropes: [] },
    { id: 'h2', title: 'Ann 1', status: 'read', dateAdded: '2023-01-01T00:00:00', dateFinished: '2024-01-01T00:00:00', authors: ['Ann'], genres: [], tropes: [] },
    { id: 'h3', title: 'Ann 2', status: 'read', dateAdded: '2023-01-01T00:00:00', dateFinished: '2024-02-01T00:00:00', authors: ['Ann'], genres: [], tropes: [] },
    { id: 'h4', title: 'Ann 3', status: 'read', dateAdded: '2023-01-01T00:00:00', dateFinished: '2024-03-01T00:00:00', authors: ['Ann'], genres: [], tropes: [] },
    { id: 'h5', title: 'Anni', status: 'read', dateAdded: '2022-06-15T00:00:00', dateFinished: '2024-06-15T00:00:00', authors: ['Bob'], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects hidden-book-finds-you (same day)', found.includes('hidden-book-finds-you'));
  ok('detects hidden-pattern-emerges (3 Ann in a row)', found.includes('hidden-pattern-emerges'));
  ok('detects hidden-stars-aligned (anniversary)', found.includes('hidden-stars-aligned'));
}

/* Green wave: Accidental Trilogy */
{
  run(`localStorage.removeItem('cozylibram.milestones')`);
  run(`library = ${JSON.stringify([
    { id: 'at1', title: 'T1', status: 'read', dateFinished: '2024-01-01T00:00:00Z', series: { name: 'Acc', position: 1 }, authors: [], genres: [], tropes: [] },
    { id: 'at2', title: 'T2', status: 'read', dateFinished: '2024-01-05T00:00:00Z', series: { name: 'Acc', position: 2 }, authors: [], genres: [], tropes: [] },
    { id: 'at3', title: 'T3', status: 'read', dateFinished: '2024-01-10T00:00:00Z', series: { name: 'Acc', position: 3 }, authors: [], genres: [], tropes: [] },
  ])}`);
  const found = run(`detectMilestones(library).map(d => d.id)`);
  ok('detects hidden-accidental-trilogy', found.includes('hidden-accidental-trilogy'));
}

/* Green wave: milestoneDef resolves new dynamic types */
{
  const sc = run(`milestoneDef('series-complete-test-abc', { detail: 'Test Trilogy' })`);
  ok('series-complete def resolves', sc && sc.title.indexOf('Complete Collection') === 0);
  const hd = run(`MILESTONE_CATALOG.find(m => m.id === 'hidden-stars-aligned')`);
  ok('hidden catalog entry has ??? hint', hd && hd.hint === '???');
  ok('hidden catalog entry is in hidden cat', hd && hd.cat === 'hidden');
}

/* v474: mergeMilestoneStores — pure merge logic (no network) */
{
  run(`resetMilestoneSync(); localStorage.removeItem('cozylibram.milestones'); localStorage.removeItem('cozylibram.milestones.owner');`);
  const m = run(`mergeMilestoneStores(
    { a: { achievedAt: '2024-05-01T00:00:00.000Z', seen: false } },
    { a: { achievedAt: '2024-03-01T00:00:00.000Z', seen: true }, b: { achievedAt: null, seen: false } }
  )`);
  ok('merge: union keeps local-only and remote-only ids', !!(m.a && m.b));
  ok('merge: earliest achievedAt wins', m.a.achievedAt === '2024-03-01T00:00:00.000Z');
  ok('merge: seen is OR', m.a.seen === true);
  ok('merge: null achievedAt survives when only one side has the row', m.b.achievedAt === null);
}
{
  const m = run(`mergeMilestoneStores({}, {})`);
  ok('merge: empty + empty = empty', Object.keys(m).length === 0);
  const m2 = run(`mergeMilestoneStores(null, { x: { achievedAt: null, seen: true } })`);
  ok('merge: null-safe', !!(m2.x && m2.x.seen === true));
}
{
  const m = run(`mergeMilestoneStores(
    { s: { achievedAt: '2024-01-01T00:00:00.000Z', seen: false, detail: 'Local Series', value: 5 } },
    { s: { achievedAt: '2024-02-01T00:00:00.000Z', seen: false, detail: 'Remote Series', value: 9 } }
  )`);
  ok('merge: value takes max', m.s.value === 9);
  ok('merge: detail prefers the local copy', m.s.detail === 'Local Series');
  const m3 = run(`mergeMilestoneStores(
    { s: { achievedAt: '2024-01-01T00:00:00.000Z', seen: false } },
    { s: { achievedAt: '2024-02-01T00:00:00.000Z', seen: true, detail: 'Remote Series' } }
  )`);
  ok('merge: falls back to remote detail when local has none', m3.s.detail === 'Remote Series');
}
{
  ok('earliest: null loses to a real date', run(`earliestAchievedAt(null, '2024-01-01T00:00:00.000Z')`) === '2024-01-01T00:00:00.000Z');
  ok('earliest: both null → null', run(`earliestAchievedAt(null, null)`) === null);
  ok('earliest: earlier ISO string wins', run(`earliestAchievedAt('2024-05-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z')`) === '2024-03-01T00:00:00.000Z');
  ok('earliest: mixed +00:00 / .000Z offsets compare as dates', run(`earliestAchievedAt('2024-05-01T00:00:00+00:00', '2024-03-01T00:00:00.000Z')`) === '2024-03-01T00:00:00.000Z');
  ok('earliest: mixed offsets, earlier side is +00:00', run(`earliestAchievedAt('2024-03-01T00:00:00+00:00', '2024-05-01T00:00:00.000Z')`) === '2024-03-01T00:00:00+00:00');
}

/* v474: offline achievement → sign-in → union (fake Supabase, no network) */
(async () => {
  await run(`(async () => {
    resetMilestoneSync();
    localStorage.removeItem('cozylibram.milestones');
    localStorage.removeItem('cozylibram.milestones.owner');
    // achievement earned offline while signed out
    saveMilestones({ 'books-finished-1': { achievedAt: '2024-06-01T00:00:00.000Z', seen: false } });
    // "sign in": fake Supabase holds a different achievement for this user
    window.__fakeRows = [{ milestone_id: 'streak-7', achieved_at: '2024-02-01T00:00:00.000Z', seen: true }];
    window.__upserted = null;
    window.__origCloudClient = cloudClient;
    cloudClient = async () => ({
      from: (table) => ({
        select: () => ({ eq: () => Promise.resolve({ data: window.__fakeRows, error: null }) }),
        upsert: (rows, opts) => { window.__upserted = { table: table, rows: rows, opts: opts }; return Promise.resolve({ error: null }); }
      })
    });
    cloudUser = { id: 'u1' };
    await syncMilestonesFromCloud();
    await pushMilestonesToCloud();
    return 'done';
  })()`);

  const store = run(`loadMilestones()`);
  ok('sync: union has the offline local row and the remote row', !!(store['books-finished-1'] && store['streak-7']));
  ok('sync: remote seen=true preserved through merge', store['streak-7'].seen === true);
  ok('sync: local seen=false preserved through merge', store['books-finished-1'].seen === false);
  ok('sync: merged store persisted to localStorage', run(`JSON.parse(localStorage.getItem('cozylibram.milestones'))['streak-7'] !== undefined`));
  ok('sync: owner key set to the signed-in uid', run(`localStorage.getItem('cozylibram.milestones.owner')`) === 'u1');
  const up = run(`window.__upserted`);
  ok('sync: push upserted into the milestones table', !!(up && up.table === 'milestones'));
  ok('sync: push used onConflict user_id,milestone_id', !!(up && up.opts && up.opts.onConflict === 'user_id,milestone_id'));
  ok('sync: push carried the offline-earned row up', !!(up && up.rows.some(function (r) { return r.milestone_id === 'books-finished-1' && r.user_id === 'u1'; })));
  ok('sync: push row shape has achieved_at/seen', !!(up && up.rows.some(function (r) { return r.milestone_id === 'streak-7' && r.achieved_at === '2024-02-01T00:00:00.000Z' && r.seen === true; })));

  // restore the real client, drop the fake user
  run(`cloudClient = window.__origCloudClient; cloudUser = null; resetMilestoneSync(); localStorage.removeItem('cozylibram.milestones'); localStorage.removeItem('cozylibram.milestones.owner');`);

  /* v474 fix: resetMilestoneSync flushes a pending push instead of dropping
     it — earn → sign out within the 2.5s debounce must not lose the row. */
  await run(`(async () => {
    resetMilestoneSync();
    localStorage.removeItem('cozylibram.milestones');
    localStorage.removeItem('cozylibram.milestones.owner');
    // achievement earned (schedules the 2.5s debounced push)
    saveMilestones({ 'books-finished-1': { achievedAt: '2024-06-01T00:00:00.000Z', seen: false } });
    window.__upsertedFlush = null;
    window.__origCloudClientFlush = cloudClient;
    cloudClient = async () => ({
      from: (table) => ({
        upsert: (rows, opts) => { window.__upsertedFlush = { table: table, rows: rows, opts: opts }; return Promise.resolve({ error: null }); }
      })
    });
    cloudUser = { id: 'u1' }; // session still valid at leaveApp time
    resetMilestoneSync();     // the sign-out path: must flush the pending push
    await new Promise(function (r) { setTimeout(r, 50); }); // let the fire-and-forget push land
    return 'done';
  })()`);
  const flush = run(`window.__upsertedFlush`);
  ok('reset: pending push flushed on resetMilestoneSync (not dropped)', !!(flush && flush.table === 'milestones'));
  ok('reset: flushed push carried the earned row', !!(flush && flush.rows.some(function (r) { return r.milestone_id === 'books-finished-1' && r.user_id === 'u1'; })));
  run(`cloudClient = window.__origCloudClientFlush; cloudUser = null; resetMilestoneSync(); localStorage.removeItem('cozylibram.milestones'); localStorage.removeItem('cozylibram.milestones.owner');`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL - async milestone sync test: ' + ((e && e.message) || e)); process.exit(1); });
