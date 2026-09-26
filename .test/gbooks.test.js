// Google Books API key tests: key appended to requests when set, omitted when not.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
let lastUrl = null;
const seenUrls = [];
window.fetch = async (url) => {
  lastUrl = String(url);
  seenUrls.push(lastUrl);
  return { ok: true, json: async () => ({ items: [] }) };
};
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

(async () => {
  // 1. no key: URL untouched
  runInWindow(`localStorage.removeItem('gbooks_key');`);
  ok('gbUrl without key leaves URL alone',
    window.gbUrl('https://www.googleapis.com/books/v1/volumes?q=test') ===
    'https://www.googleapis.com/books/v1/volumes?q=test');
  ok('status text with no key', window.gbKeyStatusText().indexOf('No key set') === 0);

  // 2. manual key: appended
  runInWindow(`localStorage.setItem('gbooks_key', 'AIzaTEST123');`);
  ok('gbUrl appends key',
    window.gbUrl('https://www.googleapis.com/books/v1/volumes?q=test') ===
    'https://www.googleapis.com/books/v1/volumes?q=test&key=AIzaTEST123');
  ok('status text with manual key', window.gbKeyStatusText().indexOf('API key saved') === 0);

  // 3. searchBooks sends the key (GB returns no items here, so it falls through to OL)
  seenUrls.length = 0;
  await window.searchBooks('iron flame');
  ok('searchBooks includes key',
    seenUrls.some(u => u.indexOf('googleapis.com') !== -1 && u.indexOf('key=AIzaTEST123') !== -1));

  // 4. lookupISBN sends the key on the Google Books call (then falls back to OL)
  seenUrls.length = 0;
  runInWindow(`localStorage.setItem('gbooks_key', 'AIzaTEST123');`);
  await window.lookupISBN('9780123456789');
  ok('lookupISBN Google Books call includes key',
    seenUrls.some(u => u.indexOf('googleapis.com') !== -1 && u.indexOf('key=AIzaTEST123') !== -1));
  runInWindow(`localStorage.removeItem('gbooks_key');`);
  await window.searchBooks('iron flame');
  ok('searchBooks omits key when unset', lastUrl.indexOf('key=') === -1);

  // 5. server-shared key via SPICY_CONFIG
  runInWindow(`window.SPICY_CONFIG = { googleBooksKey: 'AIzaSERVER' };`);
  ok('server key picked up', window.gbKey() === 'AIzaSERVER');
  ok('gbUrl uses server key',
    window.gbUrl('https://x/?a=1').indexOf('key=AIzaSERVER') !== -1);
  ok('status text with server key', window.gbKeyStatusText().indexOf('home-server') !== -1);
  runInWindow(`localStorage.setItem('gbooks_key', 'AIzaMANUAL');`);
  ok('manual key wins over server key', window.gbKey() === 'AIzaMANUAL');
  runInWindow(`localStorage.removeItem('gbooks_key'); window.SPICY_CONFIG = {};`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
