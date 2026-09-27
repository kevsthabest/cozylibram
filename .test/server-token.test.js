// Server-side key tests: the browser only learns capability flags (v89) —
// the Hardcover token and Google Books key never reach the client.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in token tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);

// 1. Nothing configured
delete window.SPICY_CONFIG;
ok('not ready when nothing configured', window.hcReady() === false);
ok('gbooks not ready when nothing configured', window.gbReady() === false);
ok('status says none set', window.hcStatusText().indexOf('No key') === 0);

// 2. Server flags set — ready, but no secret is exposed to the client
window.SPICY_CONFIG = { hardcover: true, gbooks: true };
ok('hcReady true from flag', window.hcReady() === true);
ok('gbReady true from flag', window.gbReady() === true);
ok('status mentions server-side', window.hcStatusText().includes('server-side'));
ok('no secret anywhere on the client config',
  JSON.stringify(window.SPICY_CONFIG).indexOf('srv_token') === -1);

// 3. Legacy secret fields (old cached /config.js) expose nothing usable
window.SPICY_CONFIG = { hardcoverToken: 'srv_token_123', googleBooksKey: 'AIzaOLD' };
ok('legacy token field does not enable calls', window.hcReady() === false);
ok('legacy gbooks field does not enable calls', window.gbReady() === false);

// 4. Settings UI: no manual entry fields anymore
window.SPICY_CONFIG = { hardcover: true };
window.renderSettings();
const view = window.document.getElementById('view');
ok('no token input in settings', !q('#hc-token'));
ok('no save button in settings', !q('#hc-save'));
ok('test + enrich buttons still present', !!q('#hc-test') && !!q('#hc-bulk'));

// 5. Empty server payload behaves like no server
window.SPICY_CONFIG = {};
ok('empty server config means not ready', window.hcReady() === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
