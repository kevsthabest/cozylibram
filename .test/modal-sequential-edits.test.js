// Regression pin: sequential title edits across two books that share a
// title must never trade titles (issue #346).
//
// #346 reported that editing one book's title in the book modal wrote
// the previously edited book's title into it, persisted to the server.
// Exhaustive diagnosis (2026-10-19) could not reproduce the cross-write
// anywhere reachable: the filed sequences replayed clean on the current
// tree and on the v618 incident tree, under both storage backends, and
// every commit path in the modal is guarded the way the v616 fix left
// it. The User's decision was to land the filed sequences as green pins
// anyway and close #346 as cannot-reproduce — the shape matters more
// than the verdict: if a cross-write ever becomes reachable, this suite
// fires in CI instead of in a user's library.
//
// Coverage split with the sibling pins: modal-form-zombie covers the
// no-close book-to-book path (a superseded render committing late).
// This suite covers the close-separated shape — each modal fully
// closes before the next book opens — plus the variant where the next
// open itself flushes the previous book's pending edit. It runs under
// the standard harness like its sibling modal suites; the diagnosis's
// IDB-backend arm is not included here (it lives with the #347
// save-honesty work).
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const q = (sel) => window.document.querySelector(sel);
const tick = () => new Promise(r => setTimeout(r, 30));

const realST = window.setTimeout, realCT = window.clearTimeout;
let fakeNow = 0, fakeSeq = 1;
const fakeTimers = new Map();
window.setTimeout = (cb, ms, ...a) => { const id = fakeSeq++; fakeTimers.set(id, { cb, at: fakeNow + (ms || 0), a }); return id; };
window.clearTimeout = (id) => { fakeTimers.delete(id); };
function advance(ms) {
  const target = fakeNow + ms;
  for (;;) {
    let nextId = null, nextAt = Infinity;
    fakeTimers.forEach((t, id) => { if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; } });
    if (nextId === null) break;
    const t = fakeTimers.get(nextId);
    fakeTimers.delete(nextId);
    fakeNow = Math.max(fakeNow, t.at);
    t.cb(...t.a);
  }
  fakeNow = target;
}

function seedBook(id, title, authors, status, pageCount) {
  return {
    id, title, authors, status, isbn: '978000000000' + id.slice(-1),
    progress: 0, pageCount, cover: '', tropes: [], myRating: 0, ratings: {},
    axes: [], favorite: false, owned: 'owned', format: 'paperback', notes: '',
    description: 'Desc ' + id, quotes: [], log: [],
    publishedDate: '2020-01-01', publicRating: 4.0, ratingsCount: 10,
    categories: [], genres: [],
  };
}
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const snap = () => run(`JSON.stringify(library.map(b => ({id:b.id,title:b.title,authors:b.authors,status:b.status,progress:b.progress,pageCount:b.pageCount})))`);
const get = (id) => JSON.parse(snap()).find(b => b.id === id);
const stored = (id) => JSON.parse(window.localStorage.getItem('spicyshelves.library.v1')).find(b => b.id === id);

(async () => {
  run(`library = [
    migrateBook(${JSON.stringify(seedBook('bkA', 'The Only Good Indians', ['Stephen Graham Jones'], 'reading', 300))}),
    migrateBook(${JSON.stringify(seedBook('bkB', 'The Only Good Indians', ['Stephen Graham Jones'], 'tbr', 300))}),
    migrateBook(${JSON.stringify(seedBook('bkC', 'The Real Jones Book', ['Stephen Graham Jones'], 'read', 300))})
  ]; saveLibrary(); library.forEach(b => unmarkDirty(b));`);
  await tick();

  // Step 1: open A, retitle to "Fourth Wing", autosave settles, close.
  run(`openDetail('bkA');`);
  ok('A open', q('#f-title') && q('#f-title').value === 'The Only Good Indians');
  type(q('#f-title'), 'Fourth Wing');
  advance(1500); await tick();
  ok('A renamed by its own edit', get('bkA').title === 'Fourth Wing');
  ok('B unchanged after A edit', get('bkB').title === 'The Only Good Indians');
  q('#m-x').click(); await tick();
  ok('modal closed', !q('#f-title'));

  // Step 2: open B, retitle to "Modern Classic", autosave settles.
  run(`openDetail('bkB');`);
  ok('B open with its own title', q('#f-title') && q('#f-title').value === 'The Only Good Indians');
  type(q('#f-title'), 'Modern Classic');
  advance(1500); await tick();
  ok('B renamed by its own edit', get('bkB').title === 'Modern Classic');
  ok('A NOT cross-written by B edit', get('bkA').title === 'Fourth Wing');
  ok('C untouched throughout', get('bkC').title === 'The Real Jones Book');
  q('#m-x').click(); await tick();
  ok('A title in the persisted store', stored('bkA').title === 'Fourth Wing');
  ok('B title in the persisted store', stored('bkB').title === 'Modern Classic');

  // Variant: book-to-book navigation (no close) with edits on both.
  run(`openDetail('bkA');`);
  type(q('#f-title'), 'Fourth Wing II');
  advance(1500); await tick();
  run(`openDetail('bkB');`);
  ok('B open (nav)', q('#f-title') && q('#f-title').value === 'Modern Classic');
  type(q('#f-title'), 'Modern Classic II');
  advance(1500); await tick();
  ok('B renamed (nav variant)', get('bkB').title === 'Modern Classic II');
  ok('A NOT cross-written (nav variant)', get('bkA').title === 'Fourth Wing II');
  q('#m-x').click(); await tick();
  ok('A title in the persisted store (nav variant)', stored('bkA').title === 'Fourth Wing II');
  ok('B title in the persisted store (nav variant)', stored('bkB').title === 'Modern Classic II');

  // Variant: A's edit flushed by the hop itself (no debounce wait).
  run(`openDetail('bkA');`);
  type(q('#f-title'), 'Fourth Wing III');
  run(`openDetail('bkB');`); // hop flushes A's pending form
  await tick();
  ok('A edit landed via hop flush', get('bkA').title === 'Fourth Wing III');
  ok('B untouched by A hop flush', get('bkB').title === 'Modern Classic II');
  type(q('#f-title'), 'Modern Classic III');
  advance(1500); await tick();
  ok('A NOT cross-written after hop-flush variant', get('bkA').title === 'Fourth Wing III');
  ok('B renamed after hop-flush variant', get('bkB').title === 'Modern Classic III');
  q('#m-x').click(); await tick();
  ok('A title in the persisted store (hop-flush variant)', stored('bkA').title === 'Fourth Wing III');
  ok('B title in the persisted store (hop-flush variant)', stored('bkB').title === 'Modern Classic III');

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
