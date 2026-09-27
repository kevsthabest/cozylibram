// App version tests: parseSwVersion extracts the running version from sw.js text.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in appversion tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const parse = window.parseSwVersion;
ok('parseSwVersion is defined', typeof parse === 'function');
ok('parses v54 from sw.js text',
  parse("const CACHE = 'cozy-libram-v54';") === 'v54');
ok('parses other versions', parse('x cozy-libram-v9 y') === 'v9');
ok('returns null when absent', parse('no version here') === null);
ok('handles empty string', parse('') === null);
ok('handles null/undefined', parse(null) === null && parse(undefined) === null);

// The real sw.js parses to the same version the service worker cache uses.
const swText = fs.readFileSync('/home/hatch/workspace/booktok/sw.js', 'utf8');
const cacheName = (/const CACHE = '([^']+)'/.exec(swText) || [])[1];
ok('sw.js CACHE name matches parsed version',
  cacheName === 'cozy-libram-' + parse(swText));

// Settings view renders the App section with version + update controls.
window.renderSettings();
const doc = window.document;
ok('App section shows version element', !!doc.getElementById('ap-ver'));
ok('update button exists', !!doc.getElementById('ap-update'));
ok('update status element exists', !!doc.getElementById('ap-status'));
ok('cached CSS diagnostic element exists', !!doc.getElementById('ap-css'));
ok('server CSS diagnostic element exists', !!doc.getElementById('ap-css-srv'));

// Every classic script in index.html must be in the SW precache list
// (an omission silently breaks offline use and update atomicity).
const htmlScripts = [...html.matchAll(/<script src="js\/([^"]+\.js)"><\/script>/g)].map(m => m[1]);
const jsArray = (swText.match(/const JS = \[([^\]]*)\]/) || ['', ''])[1];
const precached = [...jsArray.matchAll(/'([^']+\.js)'/g)].map(m => m[1]);
const missing = htmlScripts.filter(s => !precached.includes(s));
ok('all index.html scripts are precached in sw.js', missing.length === 0);
if (missing.length) console.log('  missing from sw.js: ' + missing.join(', '));

// Reverse check (v106): every precached script must exist on disk. A stale
// entry 404s, cache.addAll rejects, and the service worker never installs —
// the device silently stays on the old version.
const stale = precached.filter(f => !fs.existsSync('/home/hatch/workspace/booktok/js/' + f));
ok('every precached script exists on disk', stale.length === 0);
if (stale.length) console.log('  stale in sw.js: ' + stale.join(', '));

// v118: APP_VERSION (stamped on analytics events) is paired with the
// service-worker cache name — bump both on release or events mislabel.
// (const doesn't attach to window; resolve it through the global scope.)
ok('APP_VERSION matches sw.js cache version', window.eval('APP_VERSION') === parse(swText));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
