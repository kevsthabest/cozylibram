// Regression pin for issue #326: the legacy (no-IndexedDB) boot must not
// load at parse time. js/040's tail ran loadLegacyAll() synchronously
// during parsing, but loadLegacyLibrary maps the stored rows through
// migrateBook — a js/020 bridge that, as a deferred ES module, only
// exists after the document has parsed. The map threw (caught inside
// loadLegacyLibrary), the library loaded EMPTY, and loadLegacyUpNext
// then filtered the stored Up Next queue against that empty library and
// persisted the result: the partition's queue was destroyed on every
// legacy boot. The IDB boot got its DOMContentLoaded gate in PR #323;
// this pin holds the legacy boot to the same discipline.
//
// Replay technique follows .test/idb-init-order.test.js: classic scripts
// execute in document order with readyState held at 'loading', module
// scripts absent, DOMContentLoaded registrations captured and fired by
// hand. The migrateBook bridge installed at the "modules have run"
// point is a stand-in carrying the one documented behavior asserted on
// (the wishlist→tbr status coercion) — migrateBook itself is pinned by
// the data suites; what is pinned here is WHEN the load runs relative
// to the bridge existing, and that the stored queue is never rewritten
// before then.
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

  // Legacy conditions: NO indexedDB (jsdom has none — js/040 selects
  // the legacy backend), document still parsing.
  ok('no indexedDB in this environment (legacy backend territory)',
    typeof window.indexedDB === 'undefined');
  Object.defineProperty(document, 'readyState', { get: () => 'loading', configurable: true });
  const dclHandlers = [];
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    if (type === 'DOMContentLoaded') { dclHandlers.push(fn); return; }
    return realAdd(type, fn, opts);
  };

  // Seed a legacy partition: one stored book (status 'wishlist', which
  // migrateBook coerces to 'tbr') and an Up Next queue naming it. The
  // one-time transform flags are pre-set so the load's transform blocks
  // stay out of this pin's way — ordering is what is being judged.
  window.localStorage.setItem('spicyshelves.library.v1',
    JSON.stringify([{ id: 'leg1', title: 'Legacy One', status: 'wishlist' }]));
  window.localStorage.setItem('spicyshelves.library.v1.wishlist529', '1');
  window.localStorage.setItem('spicyshelves.library.v1.wishlist559', '1');
  window.localStorage.setItem('spicyshelves.upnext.v1', JSON.stringify(['leg1']));

  const appendScript = (code) => {
    const el = document.createElement('script');
    el.textContent = code;
    document.body.appendChild(el);
  };

  const scriptTags = [...html.matchAll(/<script([^>]*)src="(js\/[^"]+)"([^>]*)>/g)]
    .map(m => ({ src: m[2], isModule: /type="module"/.test(m[1] + m[3]) }));
  const classics = [];
  for (const t of scriptTags) {
    if (t.isModule) continue;
    classics.push(t.src);
    if (t.src === 'js/041-idb.js') break;
  }
  ok('replay set ends at js/041-idb.js', classics[classics.length - 1] === 'js/041-idb.js');
  for (const src of classics) appendScript(fs.readFileSync(path.join(ROOT, src), 'utf8'));
  await tick();

  // Mid-parse state: the load must not have run yet.
  ok('library not loaded during parse',
    window.eval('library.length') === 0);
  ok('stored Up Next queue not rewritten during parse (pre-fix it is already [])',
    window.localStorage.getItem('spicyshelves.upnext.v1') === '["leg1"]');
  let readyResolved = false;
  window.eval('storageReady').then(() => { readyResolved = true; });
  await tick();
  ok('storageReady still pending during parse', readyResolved === false);

  // Deferred modules run (the js/020 bridge appears), then the gate opens.
  appendScript(`
    window.migrateBook = function (b) {
      if (b && b.status === 'wishlist') b.status = 'tbr';
      return b;
    };
  `);
  dclHandlers.forEach(fn => fn(new window.Event('DOMContentLoaded')));
  await window.eval('storageReady');
  await tick();

  ok('library loads after DOMContentLoaded, with migrateBook applied',
    window.eval('library.length') === 1 && window.eval('library[0].status') === 'tbr');
  ok('Up Next queue survives the load, in memory and in the store',
    window.eval('JSON.stringify(upNext)') === '["leg1"]' &&
    window.localStorage.getItem('spicyshelves.upnext.v1') === '["leg1"]');

  // js/200's boot kick: pinned by shape — the parse-time legacy branch
  // must be gone, and boot must ride storageReady for both backends.
  // (The live boot itself is covered by the QA browser gate for this PR.)
  const bootSrc = fs.readFileSync(path.join(ROOT, 'js/200-boot.js'), 'utf8');
  ok('js/200 has no parse-time legacy boot branch',
    !/if \(idbDisabled\) \{\s*boot\(\);/.test(bootSrc));
  ok('js/200 boots via storageReady',
    /storageReady\.then\(\(\) => \{ boot\(\); initCloud\(\); \}/.test(bootSrc));

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
