// Ambience sheet keydown-listener leak regression tests — issue #359.
// Every ambience-sheet open registers a document keydown listener; it
// must come off on EVERY close path (scrim tap, swipe/programmatic,
// Escape). Before the fix, only the Escape branch removed it, so each
// non-Escape close leaked one live listener holding the dead sheet's
// closure. This suite tracks live keydown handlers through patched
// add/removeEventListener and asserts the count returns to baseline
// after each close style, across repeated cycles.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in ambience-keydown tests'); };

// Track live document keydown handlers (installed before the app loads
// so every add/remove flows through the tracker).
const liveKeys = new Set();
const doc = window.document;
const origAdd = doc.addEventListener.bind(doc);
const origRemove = doc.removeEventListener.bind(doc);
doc.addEventListener = (type, fn, opts) => { if (type === 'keydown') liveKeys.add(fn); return origAdd(type, fn, opts); };
doc.removeEventListener = (type, fn, opts) => { if (type === 'keydown') liveKeys.delete(fn); return origRemove(type, fn, opts); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mk = (id) => ({
  id, isbn: '', title: 'Book ' + id, authors: ['Author ' + id], cover: '',
  description: '', pageCount: 300, publishedDate: '', categories: ['romance'],
  publicRating: null, ratingsCount: 0, status: 'reading',
  ratings: { spice: 3 }, axes: ['spice'], myRating: 0, tropes: ['coastal'],
  progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
});

(async () => {
  runInWindow(`(function(){
    localStorage.clear();
    library.length = 0;
    library.push(${JSON.stringify(mk('amb1'))});
    saveLibrary();
  })();`);
  await sleep(30);
  const baseline = liveKeys.size;

  const openSheet = async () => { runInWindow(`openAmbienceSheet('amb1');`); await sleep(30); };

  // Cycle 1: scrim-tap close.
  await openSheet();
  ok('open registers exactly one keydown listener', liveKeys.size === baseline + 1);
  ok('sheet is in the DOM while open', !!window.document.getElementById('ambSheet'));
  window.document.getElementById('ambScrim').click();
  await sleep(30);
  ok('scrim close removes the keydown listener', liveKeys.size === baseline);
  ok('sheet is gone after scrim close', !window.document.getElementById('ambSheet'));

  // Cycle 2: programmatic close (the closeAmbienceSheet path: _ambClose).
  await openSheet();
  runInWindow(`document.getElementById('ambSheet')._ambClose();`);
  await sleep(30);
  ok('programmatic close removes the keydown listener', liveKeys.size === baseline);

  // Cycle 3: Escape close (the path that already worked — control).
  await openSheet();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(30);
  ok('Escape close removes the keydown listener', liveKeys.size === baseline);
  ok('sheet is gone after Escape', !window.document.getElementById('ambSheet'));

  // Cycles 4-6: repeated non-Escape closes must not accumulate.
  for (let i = 0; i < 3; i++) {
    await openSheet();
    window.document.getElementById('ambScrim').click();
    await sleep(10);
  }
  ok('no accumulation across repeated scrim closes', liveKeys.size === baseline);

  console.log('ambience-keydown: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
