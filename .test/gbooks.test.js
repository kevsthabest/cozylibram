// Google Books proxy tests: requests go to the same-origin /api/gbooks proxy,
// the key never appears in client-built URLs (v89).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
const seenUrls = [];
window.fetch = async (url) => {
  seenUrls.push(String(url));
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
  // 1. not configured: flag false, status text explains
  runInWindow(`delete window.SPICY_CONFIG;`);
  ok('gbReady false with no config', window.gbReady() === false);
  ok('status text with no key', window.gbKeyStatusText().indexOf('No key set') === 0);

  // 2. gbProxyUrl rewrites Google URLs to the same-origin proxy
  ok('gbProxyUrl rewrites to /api/gbooks',
    window.gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=test') ===
    '/api/gbooks/books/v1/volumes?q=test');
  ok('gbProxyUrl strips a client-supplied key',
    window.gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=test&key=ABC').indexOf('key=') === -1);

  // 3. configured: flag true, status text says server-side
  runInWindow(`window.SPICY_CONFIG = { gbooks: true };`);
  ok('gbReady true when configured', window.gbReady() === true);
  ok('status text mentions server-side', window.gbKeyStatusText().indexOf('server-side') !== -1);

  // 4. searchBooks goes through the proxy, key never in the URL
  seenUrls.length = 0;
  await window.searchBooks('iron flame');
  ok('searchBooks uses /api/gbooks',
    seenUrls.some(u => u.indexOf('/api/gbooks/books/v1/volumes') !== -1));
  ok('searchBooks URL carries no key',
    seenUrls.every(u => u.indexOf('key=') === -1));
  ok('searchBooks requests English volumes',
    seenUrls.some(u => u.indexOf('langRestrict=en') !== -1));

  // 5. lookupISBN goes through the proxy too (then falls back to OL)
  seenUrls.length = 0;
  await window.lookupISBN('9780123456789');
  ok('lookupISBN uses /api/gbooks',
    seenUrls.some(u => u.indexOf('/api/gbooks/books/v1/volumes') !== -1 && u.indexOf('q=isbn%3A') !== -1));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
