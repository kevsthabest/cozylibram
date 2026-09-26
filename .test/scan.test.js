// Scan-tab tests: insecure-context handling + photo barcode fallback.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in scan tests'); };

const scriptEl = window.document.createElement('script');
scriptEl.textContent = fs.readFileSync('/home/hatch/workspace/booktok/app.js', 'utf8');
window.document.body.appendChild(scriptEl);

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
  ok('photo button rendered', !!q('#scan-photo'));
  ok('file input captures environment camera', q('#scan-file') && q('#scan-file').getAttribute('capture') === 'environment');
  ok('https warning shown when insecure', window.document.getElementById('add-body').textContent.includes('HTTPS'));

  // 2. Secure context: no warning
  setSecure(true);
  window.renderAdd();
  ok('no https warning when secure', !window.document.getElementById('add-body').textContent.includes('plain http'));

  // 3. startScan refuses cleanly when insecure
  setSecure(false);
  q('#toast-root').innerHTML = '';
  await window.startScan();
  ok('startScan warns instead of throwing', lastToast().includes('HTTPS'));

  // 4. Photo decode via native BarcodeDetector
  setSecure(false);
  window.renderAdd();
  lookedUp = null;
  window.BarcodeDetector = class { constructor() {} async detect() { return [{ rawValue: '9780349437064' }]; } };
  const file = new window.File(['fake'], 'barcode.jpg', { type: 'image/jpeg' });
  await window.decodePhotoFile(file);
  ok('photo barcode detected via BarcodeDetector', lookedUp === '9780349437064');

  // 5. Photo decode falls back to Quagga when no BarcodeDetector
  delete window.BarcodeDetector;
  let quaggaCfg = null;
  window.Quagga = { decodeSingle: (cfg, cb) => { quaggaCfg = cfg; cb({ codeResult: { code: '9781234567890' } }); } };
  lookedUp = null;
  await window.decodePhotoFile(file);
  ok('photo barcode detected via Quagga fallback', lookedUp === '9781234567890');
  ok('quagga uses EAN readers', quaggaCfg.decoder.readers.includes('ean_reader'));

  // 6. Unreadable photo -> friendly message, no crash
  window.Quagga = { decodeSingle: (cfg, cb) => cb({}) };
  lookedUp = null;
  q('#toast-root').innerHTML = '';
  await window.decodePhotoFile(file);
  ok('unreadable photo toasts helpfully', lastToast().includes('No barcode found'));
  ok('no lookup on unreadable photo', lookedUp === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
