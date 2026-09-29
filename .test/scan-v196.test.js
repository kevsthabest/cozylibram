// v196: Hardcover as the third ISBN/scan source, + a plain-spoken message
// when a scan turns out to be a retail UPC (no catalog maps those old
// 12-digit UPCs to a book — they can't be converted to ISBNs).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
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
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));

(async () => {
  // ---- 1. isbn13of ----
  ok('isbn13of converts ISBN-10 0425189864 -> 9780425189863',
    runInWindowRet(`isbn13of('0425189864')`) === '9780425189863');
  ok('isbn13of passes ISBN-13 through',
    runInWindowRet(`isbn13of('9780425189863')`) === '9780425189863');
  ok('isbn13of handles ISBN-10 with X check digit (valid ISBN-13 out)',
    runInWindowRet(`isbnCheckOk(isbn13of('080442957X'))`) === true);
  ok('isbn13of leaves non-ISBNs alone',
    runInWindowRet(`isbn13of('071831007995')`) === '071831007995');

  // ---- 2. Hardcover fallback in lookupISBNFromAPIs ----
  // Take Google Books + Open Library offline so the waterfall reaches HC.
  runInWindow(`window.fetch = () => Promise.reject(new Error('offline'));`);
  const realHcReady = runInWindowRet(`typeof hcReady === 'function' ? 'fn' : 'missing'`);
  ok('hcReady exists', realHcReady === 'fn');
  runInWindow(`
    window.__hcDocs = [];
    window.__hcCalls = 0;
    window.hcReady = () => true;
    window.hcSearchDocs = async (q) => { window.__hcCalls++; return window.__hcDocs; };
  `);
  const hcDoc = (isbns) => ({ title: 'HC Test Book', author_names: ['Jane Doe'], isbns, image: {}, genres: [] });

  // A. HC knows the ISBN-13 -> book returned.
  runInWindow(`window.__hcDocs = [(${JSON.stringify(hcDoc(['9781234567897']))})]; window.__hcCalls = 0;`);
  let b = await runInWindowRet(`lookupISBNFromAPIs('9781234567897')`);
  ok('HC fallback returns the book when isbns[] contains the scanned ISBN',
    b && b.title === 'HC Test Book');
  ok('HC fallback was consulted', runInWindowRet(`window.__hcCalls`) === 1);

  // B. Scanned ISBN-10 matches doc ISBN-13 via conversion.
  runInWindow(`window.__hcDocs = [(${JSON.stringify(hcDoc(['9780425189863']))})];`);
  b = await runInWindowRet(`lookupISBNFromAPIs('0425189864')`);
  ok('HC fallback matches ISBN-10 scan against doc ISBN-13',
    b && b.title === 'HC Test Book');

  // C. Fuzzy guard: HC returns docs, none with the ISBN -> null (no near-miss).
  runInWindow(`window.__hcDocs = [(${JSON.stringify(hcDoc(['9789999999999']))})]; window.__hcCalls = 0;`);
  b = await runInWindowRet(`lookupISBNFromAPIs('9781234567897')`);
  ok('HC near-miss (ISBN not in doc) is rejected, not accepted',
    b === null && runInWindowRet(`window.__hcCalls`) === 1);

  // D. hcReady false -> HC skipped entirely.
  runInWindow(`window.hcReady = () => false; window.__hcCalls = 0;`);
  b = await runInWindowRet(`lookupISBNFromAPIs('9781234567897')`);
  ok('HC fallback skipped when Hardcover not configured',
    b === null && runInWindowRet(`window.__hcCalls`) === 0);

  // E. 12-digit UPC -> HC not consulted (UPCs aren't ISBNs).
  runInWindow(`window.hcReady = () => true; window.__hcCalls = 0;`);
  b = await runInWindowRet(`lookupISBNFromAPIs('071831007995')`);
  ok('12-digit UPC never reaches Hardcover', b === null && runInWindowRet(`window.__hcCalls`) === 0);

  // ---- 3. UPC failure message in isbnLookupUI ----
  runInWindow(`
    window.lookupISBN = async () => null; // force the no-match card
    document.body.innerHTML = '<div id="t-mount"></div>';
  `);
  runInWindow(`isbnLookupUI('071831007995', document.getElementById('t-mount'), 'barcode');`);
  await tick(60);
  let cardHtml = runInWindowRet(`document.getElementById('t-mount').innerHTML`);
  ok('UPC scan failure explains it is a retail UPC, not an ISBN',
    /retail UPC, not an ISBN/.test(cardHtml));
  ok('UPC failure points at the printed ISBN',
    /ISBN printed above the barcode/.test(cardHtml));

  runInWindow(`isbnLookupUI('9781234567897', document.getElementById('t-mount'), 'barcode');`);
  await tick(60);
  cardHtml = runInWindowRet(`document.getElementById('t-mount').innerHTML`);
  ok('ISBN-13 miss names the three catalogs',
    /Google Books, Open Library, Hardcover/.test(cardHtml));
  ok('ISBN-13 miss does not show the UPC message',
    !/retail UPC/.test(cardHtml));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
