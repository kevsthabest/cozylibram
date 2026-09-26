// Home-server Hardcover token tests: server-only config + settings UI.
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
ok('no token when nothing configured', window.hcToken() === '');
ok('status says none set', window.hcStatusText().indexOf('No token set') === 0);

// 2. Server token
window.SPICY_CONFIG = { hardcoverToken: 'srv_token_123' };
ok('server token used', window.hcToken() === 'srv_token_123');
ok('status mentions home server', window.hcStatusText().includes('home-server'));

// 3. Stale device keys are ignored (and were cleaned up at boot)
window.localStorage.setItem('hc_token', 'stale_token_999');
ok('stale hc_token ignored', window.hcToken() === 'srv_token_123');
window.localStorage.removeItem('hc_token');

// 4. Settings UI: no manual entry fields anymore
window.renderSettings();
const view = window.document.getElementById('view');
ok('no token input in settings', !q('#hc-token'));
ok('no save button in settings', !q('#hc-save'));
ok('test + enrich buttons still present', !!q('#hc-test') && !!q('#hc-bulk'));
ok('settings mentions server-config.json', view.textContent.includes('server-config.json'));

// 5. Empty server payload behaves like no server
window.SPICY_CONFIG = {};
ok('empty server config means no token', window.hcToken() === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
