// Offline covers (v109): the service worker keeps a version-proof runtime
// image cache, and Settings offers a one-tap pre-cache of every cover.
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
ok('fetch handler cache-first branches on image destinations',
  /destination === 'image'/.test(sw));
ok('activate preserves the image cache across version bumps',
  /k !== CACHE && k !== IMG_CACHE/.test(sw));
ok('image cache is bounded (oldest evicted first)',
  /IMG_CACHE_MAX/.test(sw) && /trimImageCache/.test(sw));
ok('opaque cross-origin covers are storable',
  /res\.type === 'opaque'/.test(sw));

// settings exposes the pre-cache button
runInWindow(`library = [
  { id: 'a', title: 'Has Cover', authors: ['A'], status: 'read', cover: 'https://x/cover.jpg' },
  { id: 'b', title: 'No Cover', authors: ['B'], status: 'tbr', cover: '' },
];`);
runInWindow(`view = 'settings'; renderSettings();`);
ok('settings has the Cache covers for offline button',
  !!window.document.getElementById('cover-offline'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
