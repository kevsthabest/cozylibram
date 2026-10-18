// Regression pin: a superseded modal form must never commit.
// (Bug lane, 2026-10-18 — production incident: library records kept
// acquiring the title/authors/tropes/pageCount of a different book the
// user had opened in the same session. Mechanism: renderDetailModal
// registers delegated input/change/focusout listeners on the persistent
// #modal-root element and nothing deregisters them when the render is
// superseded or closed. A previous book's form controller stays alive,
// reads the CURRENT modal's inputs through getElementById, finds its own
// baseline "dirty", and its debounced commit writes those values into
// ITS book via Object.assign(b, draft).)
//
// The scenario is the incident shape: open book A, navigate book-to-book
// to B (no close — the path that bypasses close()), then merely touch
// B's form (an input event with no value change in B). A's record must
// remain byte-identical; B's own autosave must still work afterwards.
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

// Fake timers (the autosave suite's pattern) to drive the 700ms debounce.
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

function seedBook(id, title, authors, pageCount, tropes) {
  return {
    id, title, authors, status: 'tbr', isbn: '9780000000000',
    progress: 0, pageCount, cover: '', tropes, myRating: 0, ratings: {},
    axes: [], favorite: false, owned: 'owned', format: 'paperback', notes: '',
    description: 'A description for ' + id + '.', quotes: [], log: [],
    publishedDate: '2020-01-01', publicRating: 4.0, ratingsCount: 10,
    categories: [], genres: [],
  };
}

(async () => {
  run(`library = [
    migrateBook(${JSON.stringify(seedBook('bkA', 'Alpha Title', ['Ann Alpha'], 111, ['alpha trope']))}),
    migrateBook(${JSON.stringify(seedBook('bkB', 'Beta Title', ['Bob Beta'], 222, ['beta trope']))})
  ];`);
  run(`saveLibrary();`);
  run(`library.forEach(b => unmarkDirty(b));`);
  await tick();

  // Open A, then navigate book-to-book to B (no close in between — the
  // in-modal navigation path). A's form controller is now superseded.
  run(`openDetail('bkA');`);
  ok('modal opened on bkA', !!q('#f-title') && q('#f-title').value === 'Alpha Title');
  run(`openDetail('bkB');`);
  await tick();
  ok('modal now shows bkB', !!q('#f-title') && q('#f-title').value === 'Beta Title');

  // Merely touch B's form: an input event with NO value change in B.
  // B's own controller sees a clean form; nothing may be written anywhere.
  const tropesInput = q('#f-tropes');
  ok('bkB tropes input present', !!tropesInput);
  tropesInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  advance(1500); // well past the 700ms autosave debounce
  await tick();

  const aTitle = run(`library.find(b => b.id === 'bkA').title`);
  const aAuthors = run(`JSON.stringify(library.find(b => b.id === 'bkA').authors)`);
  const aPages = run(`library.find(b => b.id === 'bkA').pageCount`);
  const aTropes = run(`JSON.stringify(library.find(b => b.id === 'bkA').tropes)`);
  ok('bkA title untouched by bkB form touch', aTitle === 'Alpha Title');
  ok('bkA authors untouched', aAuthors === JSON.stringify(['Ann Alpha']));
  ok('bkA pageCount untouched', aPages === 111);
  ok('bkA tropes untouched', aTropes === JSON.stringify(['alpha trope']));

  // Positive control: B's own autosave still commits B's edits to B.
  const titleInput = q('#f-title');
  titleInput.value = 'Beta Title II';
  titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  advance(1500);
  await tick();
  ok('bkB autosave commits its own edit', run(`library.find(b => b.id === 'bkB').title`) === 'Beta Title II');
  ok('bkA still untouched after bkB commit', run(`library.find(b => b.id === 'bkA').title`) === 'Alpha Title');

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
