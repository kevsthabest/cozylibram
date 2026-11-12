// Regression pins for the legacy (no-IndexedDB) backend's persist and
// one-time-migration flag discipline:
//
//   #373 — persistBooks' legacy branch unmarked every dirty flag after
//     saveLegacyLibrary even when the write had failed on quota
//     (saveLegacyLibrary swallowed the error), so the edit survived
//     only in memory and no retry was ever recorded.
//   #331 (legacy flavors) — the v529/v559 done-flags were written
//     BEFORE the transformed data was durable (at legacy boot in
//     loadLegacyAll, and on legacy slot switch in setLocalUserLegacy),
//     so one failed persist lost the migration for that partition
//     while the flag claimed it ran.
//
// Runs the real app through .test/harness.js on the legacy backend
// (jsdom has no indexedDB), with Storage.prototype.setItem patched per
// scenario to fail exactly one key — the quota condition.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const { loadApp } = require(path.join(APP_DIR, '.test', 'harness'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

function makeWindow() {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const w = dom.window;
  w.fetch = async () => { throw new Error('no network in tests'); };
  return w;
}
// Fail setItem for exactly one key (the quota condition), pass the rest.
function failKey(w, key) {
  w.eval(`
    window.__origSetItem = Storage.prototype.setItem;
    window.__failKey = ${JSON.stringify(key)};
    Storage.prototype.setItem = function (k, v) {
      if (k === window.__failKey) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      return window.__origSetItem.call(this, k, v);
    };
  `);
}
function unfail(w) {
  w.eval(`Storage.prototype.setItem = window.__origSetItem;`);
}

(async () => {
  // ---------- B1: #373 — a quota-failed save keeps the dirty flags ----------
  {
    const w = makeWindow();
    w.localStorage.setItem('spicyshelves.library.v1',
      JSON.stringify([{ id: 'b1', title: 'Before', authors: ['A'], status: 'tbr' }]));
    loadApp(w);
    await w.eval('storageReady');
    await tick();
    failKey(w, 'spicyshelves.library.v1');
    w.eval(`library[0].title = 'After'; saveLibrary();`);
    ok('#373 quota-failed legacy save keeps the book dirty for a retry',
      w.eval(`dirtyBooks.has(library[0])`) === true);
    unfail(w);
    w.eval(`saveLibrary();`);
    ok('#373 the retry persists and clears the flag',
      w.eval(`dirtyBooks.has(library[0])`) === false &&
      JSON.parse(w.localStorage.getItem('spicyshelves.library.v1'))[0].title === 'After');
  }

  // ---------- B2: #331 — legacy boot writes flags only after the data ----------
  {
    const w = makeWindow();
    w.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([
      { id: 'w1', title: 'Wish', authors: ['A'], status: 'read', owned: 'tobuy' },
    ]));
    failKey(w, 'spicyshelves.library.v1'); // the transform's data write will fail
    loadApp(w);
    await w.eval('storageReady');
    await tick();
    ok('#331 boot: v529 flag NOT set when the transformed data failed to persist',
      w.localStorage.getItem('spicyshelves.library.v1.wishlist529') === null);
    ok('#331 boot: v559 flag NOT set either',
      w.localStorage.getItem('spicyshelves.library.v1.wishlist559') === null);
    ok('#331 boot: the stored rows keep their pre-transform state',
      JSON.parse(w.localStorage.getItem('spicyshelves.library.v1'))[0].owned === 'tobuy');
  }

  // ---------- B3: #331 — legacy slot switch writes flags after the data ----------
  {
    const w = makeWindow();
    w.localStorage.setItem('spicyshelves.library.v1',
      JSON.stringify([{ id: 'o1', title: 'Offline', authors: ['A'], status: 'tbr' }]));
    w.localStorage.setItem('spicyshelves.library.v2.uL', JSON.stringify([
      { id: 'w2', title: 'Wish Two', authors: ['A'], status: 'read', owned: 'tobuy' },
    ]));
    loadApp(w);
    await w.eval('storageReady');
    await tick();
    failKey(w, 'spicyshelves.library.v2.uL'); // the incoming partition's data write fails
    w.eval(`setLocalUser('uL')`);
    await tick();
    ok('#331 switch: incoming partition v529 flag NOT set when its save failed',
      w.localStorage.getItem('spicyshelves.library.v2.uL.wishlist529') === null);
    unfail(w);
  }

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
