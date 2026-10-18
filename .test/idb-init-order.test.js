// Regression pin: the IndexedDB storage init must not start before
// DOMContentLoaded. (Bug lane, 2026-10-18 — live production error:
// "IndexedDB init failed, using localStorage fallback: migrateBook is
// not defined". storageInit's load path maps migrateBook, which lives
// in js/020 — an ES module whose window bridge runs only after the
// document parses. js/041 kicked storageInit off synchronously during
// parsing, so on a fast/warm IndexedDB the load chain could reach the
// migrateBook map before the bridge existed, and the whole session
// fell back to localStorage.)
//
// This suite replays the production hazard faithfully: the classic
// scripts up to js/041 execute in document order with the module
// scripts absent (not yet executed — the exact mid-parse state, with
// readyState held at 'loading'), a spy stands at the storageInit
// boundary, and the init must not start until DOMContentLoaded.
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

const tick = () => new Promise(r => setTimeout(r, 30));

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost:8000/', runScripts: 'dangerously',
  });
  const window = dom.window;
  const document = window.document;

  // Production mid-parse conditions: an IndexedDB exists (so the IDB
  // backend is selected), and the document is still loading.
  window.indexedDB = {};
  Object.defineProperty(document, 'readyState', { get: () => 'loading', configurable: true });
  // Capture DOMContentLoaded registrations instead of letting jsdom's
  // own lifecycle fire them — jsdom dispatches its DCL on its own
  // schedule, which would open the gate mid-assertion and make the
  // pin a coin flip. The test fires the captured handlers itself.
  const dclHandlers = [];
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    if (type === 'DOMContentLoaded') { dclHandlers.push(fn); return; }
    return realAdd(type, fn, opts);
  };

  const appendScript = (code) => {
    const el = document.createElement('script');
    el.textContent = code;
    document.body.appendChild(el);
  };

  // The classic scripts in document order, stopping after js/041 —
  // module scripts (incl. js/020, migrateBook's home) are skipped,
  // simulating that they have not executed yet.
  const scriptTags = [...html.matchAll(/<script([^>]*)src="(js\/[^"]+)"([^>]*)>/g)]
    .map(m => ({ src: m[2], isModule: /type="module"/.test(m[1] + m[3]) }));
  const classics = [];
  for (const t of scriptTags) {
    if (t.isModule) continue;
    classics.push(t.src);
    if (t.src === 'js/041-idb.js') break;
  }
  ok('replay set ends at js/041-idb.js', classics[classics.length - 1] === 'js/041-idb.js');

  for (const src of classics) {
    appendScript(fs.readFileSync(path.join(ROOT, src), 'utf8'));
    if (src === 'js/040-storage.js') {
      // Spy at the boundary: storageInit exists (js/040 defined it)
      // but must not be CALLED until the gate opens.
      appendScript(`
        window.__initCalls = 0;
        window.__realStorageInit = storageInit;
        storageInit = function () { window.__initCalls++; return Promise.resolve(); };
      `);
    }
  }
  await tick();
  // storageReady is a top-level let in js/040 — a lexical binding, not
  // a window property — so it is read through eval, as other scripts do.
  const readyType = () => window.eval('typeof storageReady !== "undefined" && storageReady && typeof storageReady.then === "function"');
  ok('storageInit not started during parse', window.__initCalls === 0);
  ok('storageReady is already a promise (boot can await it)', readyType());

  // The gate opens: deferred modules have run by DOMContentLoaded in
  // production; here the captured handlers are fired by hand.
  dclHandlers.forEach(fn => fn(new window.Event('DOMContentLoaded')));
  await tick();
  ok('storageInit started exactly once after DOMContentLoaded', window.__initCalls === 1);
  let resolved = false;
  window.eval('storageReady').then(() => { resolved = true; });
  await tick();
  ok('storageReady resolves', resolved);

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
