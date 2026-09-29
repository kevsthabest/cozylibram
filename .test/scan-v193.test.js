// v193: barcode scanner reliability —
// (1) misread rejection: ISBN check-digit validation + two-in-a-row consensus
//     before a detected code is accepted, so a garbled first frame can never
//     trigger a failed lookup;
// (2) the scan panel + camera state survive addBook's render() — after a
//     barcode "Add to TBR" the camera restarts automatically for the next book.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const runInWindowRet = (js) => {
  const s = window.document.createElement('script');
  s.textContent = 'window.__ret = (function(){ return (' + js + '); })();';
  window.document.body.appendChild(s);
  return window.__ret;
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

(async () => {
  // ---- 1. isbnCheckOk: check-digit validation ----
  ok('valid ISBN-13 passes', runInWindowRet(`isbnCheckOk('9780439023528')`) === true);
  ok('valid ISBN-13 passes (2)', runInWindowRet(`isbnCheckOk('9780140328721')`) === true);
  ok('ISBN-13 with wrong check digit fails', runInWindowRet(`isbnCheckOk('9780439023529')`) === false);
  ok('valid ISBN-10 passes', runInWindowRet(`isbnCheckOk('0439023521')`) === true);
  ok('ISBN-10 with wrong check digit fails', runInWindowRet(`isbnCheckOk('0439023522')`) === false);
  ok('valid ISBN-10 with X passes', runInWindowRet(`isbnCheckOk('080442957X')`) === true);
  ok('valid 12-digit UPC-A passes', runInWindowRet(`isbnCheckOk('036000291452')`) === true);
  ok('12-digit with wrong check digit fails', runInWindowRet(`isbnCheckOk('036000291453')`) === false);
  ok('partial read fails', runInWindowRet(`isbnCheckOk('9780439')`) === false);
  ok('empty fails', runInWindowRet(`isbnCheckOk('')`) === false);
  ok('non-numeric fails', runInWindowRet(`isbnCheckOk('abcdefghij')`) === false);

  // ---- 2. onBarcode: consensus + misread rejection ----
  runInWindow([
    'window.__seen = [];',
    'window.__realStopScan = stopScan;',
    'window.__realIsbnLookupUI = isbnLookupUI;',
    'stopScan = function() {};', // no camera in JSDOM; keep the test hermetic
    'isbnLookupUI = function(isbn) { window.__seen.push(isbn); };',
    'scanState.lastCode = null; scanState.hits = 0;',
  ].join('\n'));
  ok('first valid read is not accepted (no consensus yet)',
    runInWindowRet(`onBarcode('9780439023528')`) === false && runInWindowRet(`window.__seen.length`) === 0);
  ok('second identical read is accepted',
    runInWindowRet(`onBarcode('9780439023528')`) === true && runInWindowRet(`window.__seen.length`) === 1);
  ok('accepted ISBN is the clean value', runInWindowRet(`window.__seen[0]`) === '9780439023528');
  ok('consensus resets after accept', runInWindowRet(`scanState.lastCode === null && scanState.hits === 0`) === true);

  runInWindow(`window.__seen = []; scanState.lastCode = null; scanState.hits = 0;`);
  runInWindowRet(`onBarcode('9780439023528')`);
  runInWindowRet(`onBarcode('9780140328721')`);
  runInWindowRet(`onBarcode('9780439023528')`);
  ok('alternating reads never reach consensus', runInWindowRet(`window.__seen.length`) === 0);

  runInWindow(`window.__seen = []; scanState.lastCode = null; scanState.hits = 0;`);
  for (let i = 0; i < 5; i++) runInWindowRet(`onBarcode('9780439023529')`);
  ok('misread (bad check digit) never accepted, even after 5 repeats', runInWindowRet(`window.__seen.length`) === 0);

  runInWindow(`window.__seen = []; scanState.lastCode = null; scanState.hits = 0;`);
  ok('instant photo read accepted on first try',
    runInWindowRet(`onBarcode('9780439023528', true)`) === true && runInWindowRet(`window.__seen.length`) === 1);
  runInWindow(`window.__seen = [];`);
  ok('instant garbled photo read rejected',
    runInWindowRet(`onBarcode('9780439023529', true)`) === false && runInWindowRet(`window.__seen.length`) === 0);

  runInWindow(`window.__seen = []; scanState.lastCode = null; scanState.hits = 0;`);
  runInWindowRet(`onBarcode('978-0-439-02352-8')`);
  ok('dashed read accepted on second sighting as clean ISBN',
    runInWindowRet(`onBarcode('978-0-439-02352-8')`) === true && runInWindowRet(`window.__seen[0]`) === '9780439023528');

  runInWindow(`stopScan = window.__realStopScan; isbnLookupUI = window.__realIsbnLookupUI;`); // restore

  // ---- 3. scan panel open/collapsed state survives re-renders ----
  runInWindow(`localStorage.clear(); go('add');`);
  await tick();
  ok('add view renders scan button', !!q('#add-scan-btn'));
  q('#add-scan-btn').click(); // expand
  await tick();
  ok('panel expands on click', !!q('#add-scan-mount .scan-box') && q('#add-scan-mount').dataset.open === '1');
  ok('panelOpen tracked in state', runInWindowRet(`scanState.panelOpen`) === true);
  runInWindow(`renderAdd();`); // simulate addBook's render()
  await tick();
  ok('panel still expanded after re-render', !!q('#add-scan-mount .scan-box') && q('#add-scan-mount').dataset.open === '1');
  ok('scan button stays hidden while panel open', q('#add-scan-btn').style.display === 'none');
  q('#add-scan-btn').click(); // collapse via the real toggle
  await tick();
  ok('panel collapses on second click', !q('#add-scan-mount .scan-box'));
  ok('panelOpen cleared in state', runInWindowRet(`scanState.panelOpen`) === false);
  runInWindow(`renderAdd();`);
  await tick();
  ok('collapsed panel stays collapsed after re-render', !q('#add-scan-mount .scan-box'));

  // ---- 4. barcode "Add to TBR" restores the panel and restarts the camera ----
  runInWindow([
    'window.__added = [];',
    'window.__realLookupISBN = lookupISBN;',
    'lookupISBN = async function(isbn) {',
    '  return { id: "b1", isbn: isbn, title: "Test Book", authors: ["Jane Doe"] };',
    '};',
    'window.__realAddBook = addBook;',
    // stub addBook: keep the real one's render() behavior, skip the library writes
    'addBook = function(b, openEditor, src) { window.__added.push(src); render(); return b; };',
    'scanState.panelOpen = true; scanState.resume = false;',
    'scanState.lastCode = null; scanState.hits = 0;',
    'renderAdd();',
  ].join('\n'));
  await tick();
  ok('panel expanded for barcode flow', !!q('#add-scan-mount .scan-box'));
  runInWindowRet(`onBarcode('9780439023528')`);
  runInWindowRet(`onBarcode('9780439023528')`); // consensus on the second sighting
  await tick(80);
  ok('result card painted after consensus', !!q('#rc-add'));
  q('#rc-add').click();
  await tick();
  ok('add went through as barcode source', runInWindowRet(`window.__added[0]`) === 'barcode');
  ok('panel restored after add-triggered re-render', !!q('#add-scan-mount .scan-box'));
  ok('resume flag consumed by the re-render', runInWindowRet(`scanState.resume`) === false);
  ok('panelOpen still true after add', runInWindowRet(`scanState.panelOpen`) === true);
  runInWindow(`lookupISBN = window.__realLookupISBN; addBook = window.__realAddBook;`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
