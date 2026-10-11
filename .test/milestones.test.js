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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
