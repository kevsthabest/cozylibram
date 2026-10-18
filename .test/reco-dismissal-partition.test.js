// Regression pins for issue #374: the reco dismissal set's primary
// store is the per-slot IDB kv, but its localStorage fallback was ONE
// device-global key ('spicyshelves.reco_dismissed'). On the legacy
// backend (this suite: jsdom has no IndexedDB, so the fallback IS the
// store) every account shared it, and js/229's sync snapshot
// (recoDismissedKeys) could union one account's dismissals into
// another account's cloud reco_state. The fallback is now partitioned
// per local user, like every other legacy store.
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
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  loadApp(window);
  const probe = (js) => window.eval(js);
  const run = (js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
  await probe('storageReady');
  await tick();

  // Account A dismisses a recommendation on the legacy backend.
  run(`setLocalUser('uA')`);
  await tick();
  await probe(`recoDismiss('hc:aaa')`);
  ok('#374 A\'s dismissal is stored under A\'s own fallback key',
    JSON.stringify(JSON.parse(window.localStorage.getItem('spicyshelves.reco_dismissed.uA') || '[]')) === '["hc:aaa"]');
  ok('#374 A\'s dismissal is NOT written to the shared global key',
    window.localStorage.getItem('spicyshelves.reco_dismissed') === null);

  // Account B on the same device must not see A's dismissals — neither
  // in the loaded set nor in the sync snapshot js/229 collects.
  run(`setLocalUser('uB')`);
  await tick();
  const bSet = await probe(`recoDismissedSet().then(s => [...s].join(','))`);
  ok('#374 B\'s dismissal set does not contain A\'s dismissal', bSet === '');
  ok('#374 the sync snapshot for B carries none of A\'s keys',
    JSON.stringify(probe(`recoDismissedKeys()`)) === '[]');

  // B's own dismissal lands under B's key; A's set is intact back home.
  await probe(`recoDismiss('hc:bbb')`);
  ok('#374 B\'s dismissal is stored under B\'s own key',
    JSON.stringify(JSON.parse(window.localStorage.getItem('spicyshelves.reco_dismissed.uB') || '[]')) === '["hc:bbb"]');
  run(`setLocalUser('uA')`);
  await tick();
  const aSet = await probe(`recoDismissedSet().then(s => [...s].join(','))`);
  ok('#374 A\'s set still holds exactly A\'s dismissal', aSet === 'hc:aaa');

  // The signed-out partition keeps the base key, as before.
  run(`setLocalUser(null)`);
  await tick();
  await probe(`recoDismiss('hc:off')`);
  ok('#374 signed-out dismissals use the shared base key',
    JSON.stringify(JSON.parse(window.localStorage.getItem('spicyshelves.reco_dismissed') || '[]')) === '["hc:off"]');

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
