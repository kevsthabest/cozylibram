// Scan-tab tests: insecure-context handling + photo barcode fallback.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in scan tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const setSecure = (v) => Object.defineProperty(window, 'isSecureContext', { value: v, configurable: true });

// stubs used by decodePhotoFile
window.createImageBitmap = async () => ({ width: 800, height: 600 });
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
let lookedUp = null;
window.isbnLookupUI = (isbn) => { lookedUp = isbn; };
const lastToast = () => { const t = q('#toast-root').lastChild; return t ? t.textContent : ''; };

(async () => {
  // 1. Insecure context: photo button + warning, no camera attempt
  setSecure(false);
  window.renderAdd();
  ok('unified add view: scan button present', !!q('#add-scan-btn'));
  ok('scanner collapsed until opened', !q('#scan-photo'));
  q('#add-scan-btn').click();
  ok('scanner expands below the button', !!q('#add-scan-mount #scan-photo'));
  ok('scan button hides while scanner open', q('#add-scan-btn').style.display === 'none');
  ok('photo button rendered', !!q('#scan-photo'));
  ok('file input captures environment camera', q('#scan-file') && q('#scan-file').getAttribute('capture') === 'environment');
  ok('https warning shown when insecure', q('#add-scan-mount').textContent.includes('HTTPS'));

  // 2. Secure context: no warning
  setSecure(true);
  window.renderAdd(); q('#add-scan-btn').click();
  ok('no https warning when secure', !q('#add-scan-mount').textContent.includes('plain http'));

  // 3. startScan refuses cleanly when insecure
  setSecure(false);
  window.renderAdd(); q('#add-scan-btn').click();
  q('#toast-root').innerHTML = '';
  await window.startScan();
  ok('startScan warns instead of throwing', lastToast().includes('HTTPS'));

  // 4. Photo decode via native BarcodeDetector
  setSecure(false);
  window.renderAdd(); q('#add-scan-btn').click();
  lookedUp = null;
  window.BarcodeDetector = class { constructor() {} async detect() { return [{ rawValue: '9780349437064' }]; } };
  const file = new window.File(['fake'], 'barcode.jpg', { type: 'image/jpeg' });
  await window.decodePhotoFile(file);
  ok('photo barcode detected via BarcodeDetector', lookedUp === '9780349437064');

  // 5. Photo decode falls back to Quagga when no BarcodeDetector
  delete window.BarcodeDetector;
  let quaggaCfg = null;
  window.Quagga = { decodeSingle: (cfg, cb) => { quaggaCfg = cfg; cb({ codeResult: { code: '9781234567897' } }); } };
  lookedUp = null;
  await window.decodePhotoFile(file);
  ok('photo barcode detected via Quagga fallback', lookedUp === '9781234567897');
  ok('quagga uses EAN readers', quaggaCfg.decoder.readers.includes('ean_reader'));

  // 6. Unreadable photo -> friendly message, no crash
  window.Quagga = { decodeSingle: (cfg, cb) => cb({}) };
  lookedUp = null;
  q('#toast-root').innerHTML = '';
  await window.decodePhotoFile(file);
  ok('unreadable photo toasts helpfully', lastToast().includes('No barcode found'));
  ok('no lookup on unreadable photo', lookedUp === null);

  // 7. Viewfinder overlay: present, hidden until camera goes live
  setSecure(true);
  window.renderAdd(); q('#add-scan-btn').click();
  let box = q('.scan-box');
  ok('viewfinder frame rendered', !!q('.scan-frame'));
  ok('frame has 4 corner brackets', q('.scan-frame') ? q('.scan-frame').querySelectorAll('i').length === 4 : false);
  ok('sweep line rendered', !!q('.scan-line'));
  ok('frame hidden before camera starts', !box.classList.contains('live'));
  Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [] }) }, configurable: true });
  window.HTMLVideoElement.prototype.play = async () => {};
  window.BarcodeDetector = class { constructor() {} async detect() { return []; } };
  await window.startScan();
  box = q('.scan-box');
  ok('frame shows while camera live', box.classList.contains('live'));
  window.stopScan();
  ok('frame hides after stop', !box.classList.contains('live'));

  // 8. v172: unified smart field — ISBN-looking input skips catalog search
  setSecure(true);
  window.renderAdd();
  window.__isbnSeen = null;
  window.isbnLookupUI = (isbn, mount, src) => { window.__isbnSeen = { isbn, src }; };
  q('#s-q').value = '9780349437064';
  q('#s-go').click();
  await new Promise(r => setTimeout(r, 30));
  ok('isbn input dispatches to isbn lookup', window.__isbnSeen && window.__isbnSeen.isbn === '9780349437064');
  ok('isbn dispatch tagged as isbn source', window.__isbnSeen && window.__isbnSeen.src === 'isbn');
  window.__isbnSeen = null;
  q('#s-q').value = 'jane doe';
  q('#s-go').click();
  await new Promise(r => setTimeout(r, 30));
  ok('title input does not hit isbn lookup', window.__isbnSeen === null);
  ok('title input runs catalog search (fails without network here)',
    q('#s-results').textContent.includes('Search failed'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
