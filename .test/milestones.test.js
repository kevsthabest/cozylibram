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
  ok('all have categories', cat.every(m => ['journey','rhythm','discovery','taste'].includes(m.cat)));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
