// Server-shared Hardcover token tests: precedence + settings UI.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in token tests'); };

const scriptEl = window.document.createElement('script');
scriptEl.textContent = fs.readFileSync('/home/hatch/workspace/booktok/app.js', 'utf8');
window.document.body.appendChild(scriptEl);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);

// 1. Nothing configured
delete window.SPICY_CONFIG;
window.localStorage.removeItem('hc_token');
ok('no token when nothing configured', window.hcToken() === '');
ok('status says none set', window.hcStatusText() === 'No token set.');

// 2. Server token only
window.SPICY_CONFIG = { hardcoverToken: 'srv_token_123' };
ok('server token used when no manual entry', window.hcToken() === 'srv_token_123');
ok('status mentions home server', window.hcStatusText().includes('home-server'));

// 3. Manual entry wins over server token
window.localStorage.setItem('hc_token', 'manual_token_456');
ok('manual token takes precedence', window.hcToken() === 'manual_token_456');
ok('status mentions manual entry', window.hcStatusText().includes('manual'));
window.localStorage.removeItem('hc_token');

// 4. Settings UI with server token: shows note, input stays empty (no leak into field)
window.renderSettings();
const bodyText = window.document.getElementById('view').textContent;
ok('settings shows home-server note', bodyText.includes('home server'));
ok('server token not prefilled into input', q('#hc-token').value === '');

// 5. Settings UI with manual token: note hidden, input prefilled with manual only
window.localStorage.setItem('hc_token', 'manual_token_456');
window.renderSettings();
ok('manual token prefilled', q('#hc-token').value === 'manual_token_456');
ok('home-server note hidden when manual set',
  !window.document.getElementById('view').textContent.includes('no need to enter anything'));
window.localStorage.removeItem('hc_token');

// 6. Empty server payload behaves like no server
window.SPICY_CONFIG = {};
ok('empty server config means no token', window.hcToken() === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
