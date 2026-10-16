// Regression pin: a title edit in the book modal applies to the EDITED
// record only, end to end (bug lane, 2026-10-16 — production incident on
// the UX Tester account: three records sharing one title value all ended
// up carrying an edited title; two of them wrong).
//
// Diagnosis outcome (recorded with the work order): the fan-out does NOT
// reproduce on the current tree — every layer of the write path is
// id-keyed (modal commit assigns the id-resolved object; persist selects
// by dirty-flagged book; push upserts onConflict user_id,book_id; the
// merge assigns by book_id). This suite pins that property so any future
// regression to title-value keying fails loudly. The seed is shaped like
// the incident set: three records sharing ONE title value, otherwise
// distinct (a real book, a same-title other work, an ISBN-less record).
//
// The edit goes through the real modal autosave path (openDetail → type
// into #f-title → debounce commit). Assertions run against all three
// sinks a title write can reach:
//   1. the in-memory library,
//   2. the persist write set (the dirty set captured inside the commit's
//      own persistBooks call — exactly what the IDB differential plan
//      writes) plus the persisted store bytes (legacy backend under
//      jsdom),
//   3. the cloud push payload (captured from a fake Supabase client,
//      after a baseline push establishes the high-water mark).
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

const SHARED = 'Shared Title Value';
function seedBook(id, authors, isbn, status) {
  return {
    id, title: SHARED, authors, status, isbn,
    progress: 0, pageCount: 300, cover: '', tropes: [], myRating: 0, ratings: {},
    axes: [], favorite: false, owned: 'owned', format: 'paperback', notes: '',
    description: 'A description for ' + id + '.', quotes: [], log: [],
    publishedDate: '2020-01-01', publicRating: 4.0, ratingsCount: 10,
    categories: [], genres: [],
  };
}

(async () => {
  // Seed through the real load path (migrateBook ends in trackBook:
  // the records are proxy-tracked exactly as production holds them).
  run(`window.__pushes = []; window.__persistWrites = [];`);
  run(`library = [
    migrateBook(${JSON.stringify(seedBook('bkA', ['Real Author'], '9781789095302', 'tbr'))}),
    migrateBook(${JSON.stringify(seedBook('bkB', ['Other Author'], '9780349440194', 'reading'))}),
    migrateBook(${JSON.stringify(seedBook('bkC', ['Third Author'], '', 'tbr'))})
  ];`);
  ok('seed: three distinct records share one title value',
    run(`library.length`) === 3 && run(`library.every(b => b.title === ${JSON.stringify(SHARED)})`));

  // Steady state: a completed initial persist clears the dirty flags
  // (trackBook marks fresh proxies dirty by construction).
  run(`saveLibrary();`);
  run(`library.forEach(b => unmarkDirty(b));`);
  await tick();

  // Fake cloud: capture book-row upserts only.
  run(`
    cloudUser = { id: 'u-repro' };
    cloudClient = async () => ({
      from: (t) => ({
        upsert: (rows) => { if (t === 'books') window.__pushes.push(...[].concat(rows)); return Promise.resolve({ error: null }); },
        select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      }),
      rpc: () => Promise.resolve({ data: null, error: null }),
    });
  `);
  // Baseline push: establishes the high-water mark over the seeded shelf,
  // so the post-edit push payload contains only what the edit changed.
  await run(`cloudPushNow()`);
  await tick();
  run(`window.__pushes = [];`);

  // Recorder inside the persist seam: the dirty set at the moment the
  // commit's saveLibrary reaches persistBooks IS the IDB write set.
  run(`
    window.__realPersistBooks = persistBooks;
    persistBooks = function () {
      window.__persistWrites.push(library.filter(b => dirtyBooks.has(b)).map(b => b.id + '=' + b.title));
      return window.__realPersistBooks();
    };
  `);

  // Edit the MIDDLE record's title through the modal autosave path.
  run(`openDetail('bkB');`);
  const titleInput = q('#f-title');
  ok('modal opened on bkB with the shared title staged', !!titleInput && titleInput.value === SHARED);
  titleInput.value = 'The Only Correct Title';
  titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  advance(700); // debounce commit
  await tick();

  // Sink 1: the in-memory library.
  const titles = run(`library.map(b => b.id + '=' + b.title)`);
  ok('sink 1 (library): only bkB carries the new title',
    titles.join('|') === 'bkA=' + SHARED + '|bkB=The Only Correct Title|bkC=' + SHARED);

  // Sink 2a: the persist write set captured during the edit's commit.
  const writes = run(`window.__persistWrites`);
  const editWrite = writes[writes.length - 1] || [];
  ok('sink 2 (persist write set): only bkB is written, with the new title',
    editWrite.join('|') === 'bkB=The Only Correct Title');

  // Sink 2b: the persisted store bytes (legacy backend under jsdom).
  const storedRaw = run(`Object.keys(localStorage).map(k => localStorage.getItem(k)).join(' ')`);
  ok('sink 2 (persisted store): the shared title survives for bkA/bkC in storage',
    (storedRaw.match(/Shared Title Value/g) || []).length >= 2 &&
    (storedRaw.match(/The Only Correct Title/g) || []).length === 1);

  // Sink 3: the cloud push payload for the edit.
  await run(`cloudPushNow()`);
  await tick();
  const pushed = run(`window.__pushes.map(r => r.book_id + '=' + (r.data && r.data.title))`);
  ok('sink 3 (push payload): only bkB is pushed, with the new title',
    pushed.join('|') === 'bkB=The Only Correct Title');

  run(`persistBooks = window.__realPersistBooks;`);
  window.setTimeout = realST; window.clearTimeout = realCT;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('REPRO ERROR', e); process.exit(2); });
