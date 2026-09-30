// Offline covers (v216): the service worker keeps a version-proof runtime
// image cache scoped to canonical bucket covers only — the old catch-all
// that cached every image the device ever rendered is gone — and Settings
// shows live cover-storage usage plus a clear-cached-covers button.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in offline-covers tests'); };

require('./harness').loadApp(window);

const sw = fs.readFileSync('/home/hatch/workspace/booktok/sw.js', 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

ok('image cache has a version-proof name', /const IMG_CACHE = 'cozy-libram-covers'/.test(sw));
ok('only canonical bucket covers are cached (path-scoped)',
  /\/storage\/v1\/object\/public\/covers\//.test(sw) &&
  /destination === 'image' && url\.pathname\.indexOf\(COVERS_PATH\) === 0/.test(sw));
ok('the old catch-all image branch is gone',
  !/if \(e\.request\.destination === 'image'\) \{/.test(sw));
ok('opaque cross-origin responses are no longer special-cased',
  !/res\.type === 'opaque'/.test(sw));
ok('activate preserves the image cache across version bumps',
  /k !== CACHE && k !== IMG_CACHE/.test(sw));
ok('image cache is size-bounded (150 MB LRU, oldest evicted first)',
  /IMG_CACHE_MAX_BYTES = 150 \* 1024 \* 1024/.test(sw) && /trimImageCache/.test(sw));

// settings exposes the pre-cache button, the usage readout and the clear button
runInWindow(`library = [
  { id: 'a', title: 'Has Cover', authors: ['A'], status: 'read', cover: 'https://x/cover.jpg' },
  { id: 'b', title: 'No Cover', authors: ['B'], status: 'tbr', cover: '' },
];`);
runInWindow(`view = 'settings'; renderSettings();`);
ok('settings has the Cache covers for offline button',
  !!window.document.getElementById('cover-offline'));
ok('settings shows live cover-cache usage',
  !!window.document.getElementById('cover-cache-usage'));
ok('settings has the Clear cached covers button',
  !!window.document.getElementById('cover-cache-clear'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
