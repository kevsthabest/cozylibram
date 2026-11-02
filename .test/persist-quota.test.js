// Regression pin for issue #373: on the legacy (localStorage) backend,
// persistBooks cleared every dirty flag after saveLegacyLibrary even
// when the write had failed on quota — saveLegacyLibrary swallowed the
// throw, toasted, and returned void, so the caller could not tell. The
// flags are the only record that a book still needs persisting (and the
// differential cloud push keys off the _mtime stamps they drive), so a
// full-storage failure read as a successful save and the edits were
// silently lost on the next load. The comment on the legacy arm even
// promised the flags "stay set for a retry" — they did not.
//
// Pin: with setItem throwing for the library key, the dirty flags must
// survive persistBooks; with storage healthy again, the next
// persistBooks clears them (the retry the comment promised).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in persist-quota tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);

(async () => {
  ok('legacy backend is active in this harness (no IndexedDB in jsdom)',
    probe(`idbDisabled`) === true);

  runInWindow(`
    var __b = migrateBook({ id: 'q1', title: 'Quota Victim', _mtime: 10 });
    library = [__b];
    markDirty(__b);
    // Stub on the Storage prototype: on a Web Storage object, neither
    // assignment nor defineProperty on the instance shadows the method
    // (both are treated as stored items) — the prototype is the seam
    // that actually intercepts the app's calls in this harness.
    window.__storageProto = Object.getPrototypeOf(localStorage);
    window.__realSetItem = window.__storageProto.setItem;
    window.__storageProto.setItem = function (k, v) {
      if (String(k).indexOf('spicyshelves.library') === 0) {
        const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e;
      }
      return window.__realSetItem.call(this, k, v);
    };
  `);
  ok('setup: the book starts dirty', probe(`dirtyBooks.has(__b)`) === true);

  runInWindow(`persistBooks();`);
  ok('#373 dirty flag survives a quota-failed persistBooks',
    probe(`dirtyBooks.has(__b)`) === true);
  ok('#373 the failure is logged, not just toasted',
    probe(`AppLog.entries('error').some(e => /saveLegacyLibrary|library/i.test(e.msg))`) === true);

  // Storage healthy again: the retry lands and only then do flags clear.
  runInWindow(`window.__storageProto.setItem = window.__realSetItem; persistBooks();`);
  ok('#373 the next successful persist clears the flag (the promised retry)',
    probe(`dirtyBooks.has(__b)`) === false);
  ok('#373 the book actually reached localStorage on the retry',
    probe(`(JSON.parse(localStorage.getItem(libKey())) || []).some(b => b.id === 'q1')`) === true);

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
