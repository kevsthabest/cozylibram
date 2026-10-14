// Tests for v559 — Capacitor readiness, three items:
//   1. Fonts are vendored (no Google Fonts runtime dependency).
//   2. File hand-offs are share-first (js/050 shareOrDownloadFile), with the
//      plain anchor download as the fallback.
//   3. Service worker registration is gated off inside a native shell
//      (window.Capacitor present + native platform).
//
// Item 1 and the surface-conversion pins are source/disk pins in the style
// of the sticker registry disk-pin. Item 2's helper logic runs for real in
// the harness JSDOM window with the platform share boundary stubbed.
// Item 3 executes the inline registration snippet in a vm, the same way
// .test/boot-theme.test.js exercises the pre-paint boot script.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ================= Item 1: vendored fonts ================= */

const GOOGLE_FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

{
  const appFiles = ['index.html', 'styles.css'];
  for (const f of fs.readdirSync(path.join(ROOT, 'js'))) {
    if (f.endsWith('.js')) appFiles.push('js/' + f); // js/vendor/ excluded by path
  }
  for (const rel of appFiles) {
    const text = read(rel);
    for (const host of GOOGLE_FONT_HOSTS) {
      ok(`no ${host} reference in ${rel}`, !text.includes(host));
    }
  }
  ok('index.html carries no Google Fonts stylesheet link',
    !/<link[^>]+fonts\.googleapis/.test(read('index.html')));
}

const EXPECTED_FACES = [
  // family, weight, style — the exact set the old css2 link requested:
  // Playfair Display ital,wght@0,500;0,700;1,500 + Inter wght@400;500;600
  ['Playfair Display', '500', 'normal'],
  ['Playfair Display', '700', 'normal'],
  ['Playfair Display', '500', 'italic'],
  ['Inter', '400', 'normal'],
  ['Inter', '500', 'normal'],
  ['Inter', '600', 'normal'],
];
const SUBSETS = ['latin', 'latin-ext'];

{
  const css = read('styles.css');
  const blocks = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1]);
  ok('styles.css declares @font-face rules', blocks.length > 0);
  const faces = blocks.map(b => {
    const grab = (re) => { const m = b.match(re); return m ? m[1].trim() : null; };
    return {
      family: grab(/font-family:\s*'([^']+)'/),
      weight: grab(/font-weight:\s*(\d+)/),
      style: grab(/font-style:\s*(\w+)/) || 'normal',
      display: grab(/font-display:\s*(\w+)/),
      src: (grab(/src:\s*url\(([^)]+)\)/) || '').replace(/^['"]|['"]$/g, ''),
      range: grab(/unicode-range:\s*([^;]+);/) || '',
    };
  });
  for (const [family, weight, style] of EXPECTED_FACES) {
    const matching = faces.filter(f => f.family === family && f.weight === weight && f.style === style);
    ok(`@font-face present: ${family} ${weight} ${style} (one per subset: ${SUBSETS.join(' + ')})`,
      matching.length === SUBSETS.length);
    for (const f of matching) {
      ok(`${family} ${weight} ${style} subset uses font-display: swap`, f.display === 'swap');
      ok(`${family} ${weight} ${style} src is a vendored file under assets/fonts/`,
        !!f.src && f.src.includes('assets/fonts/') && f.src.endsWith('.woff2'));
    }
  }
  for (const f of faces) {
    if (!f.src) continue;
    const rel = f.src.replace(/^\.\//, '').replace(/^\//, '');
    ok(`@font-face src exists in the repo: ${rel}`, fs.existsSync(path.join(ROOT, rel)));
  }
  ok('latin and latin-ext subsets are both vendored (unicode-range split kept)',
    faces.some(f => /U\+0000-00FF/.test(f.range)) && faces.some(f => /U\+0100-/.test(f.range)));
  ok('sw.js precaches the vendored fonts for offline first paint',
    /FONTS/.test(read('sw.js')) && /assets\/fonts\//.test(read('sw.js')));
}

/* ================= Item 2: share-first hand-off ================= */

const helpers = read('js/050-helpers.js');
ok('js/050-helpers.js defines the shared shareOrDownloadFile helper',
  /function shareOrDownloadFile\(/.test(helpers) || /shareOrDownloadFile\s*=/.test(helpers));

{
  const stats = read('js/170-stats.js');
  const scf = stats.match(/function shareCanvasFile\(cv, name, title\) \{([\s\S]*?)\n\}/);
  ok('shareCanvasFile still exists in js/170-stats.js', !!scf);
  ok('shareCanvasFile routes through shareOrDownloadFile',
    !!scf && scf[1].includes('shareOrDownloadFile('));
  ok('shareCanvasFile no longer builds its own anchor download',
    !!scf && !scf[1].includes("createElement('a')"));
}

{
  const settings = read('js/180-settings.js');
  const bk = settings.match(/bk-export'\)\.addEventListener\('click',[\s\S]{0,700}/);
  ok('Settings backup export handler found', !!bk);
  ok('Settings backup export routes through shareOrDownloadFile',
    !!bk && bk[0].includes('shareOrDownloadFile('));
  ok('Settings backup export no longer hard-codes its own anchor download',
    !settings.includes("a.download = 'cozy-libram-backup-'"));
}

/* ---- helper branch logic, executed against stubs ---- */

async function helperScenarios() {
  const { JSDOM } = require('jsdom');
  const { loadApp } = require('./harness');
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://cozylibram.pages.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const w = dom.window;
  // Platform boundaries jsdom lacks: blob URLs.
  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => {};
  let anchorClicks = 0;
  w.HTMLAnchorElement.prototype.click = function () { anchorClicks++; };
  loadApp(w);
  ok('shareOrDownloadFile is defined after app load', typeof w.shareOrDownloadFile === 'function');
  if (typeof w.shareOrDownloadFile !== 'function') return;

  const setShare = (canShareFn, shareFn) => {
    if (canShareFn === null) delete w.navigator.canShare;
    else Object.defineProperty(w.navigator, 'canShare', { value: canShareFn, configurable: true });
    if (shareFn === null) delete w.navigator.share;
    else Object.defineProperty(w.navigator, 'share', { value: shareFn, configurable: true });
  };
  const blob = new w.Blob(['hello'], { type: 'text/plain' });

  // canShare true + share resolves -> shared, no anchor.
  let sharedWith = null;
  setShare(() => true, async (data) => { sharedWith = data; });
  anchorClicks = 0;
  let res = await w.shareOrDownloadFile({ blob, filename: 'a.txt', title: 'A' });
  ok('canShare + share resolves -> result "shared"', res === 'shared');
  ok('share received the file under the requested filename',
    !!sharedWith && !!sharedWith.files && sharedWith.files[0].name === 'a.txt');
  ok('share path creates no anchor download', anchorClicks === 0);

  // canShare false -> anchor download path.
  setShare(() => false, async () => {});
  anchorClicks = 0;
  res = await w.shareOrDownloadFile({ blob, filename: 'b.txt' });
  ok('canShare false -> result "downloaded"', res === 'downloaded');
  ok('canShare false -> anchor download clicked', anchorClicks === 1);

  // canShare absent entirely (desktop) -> anchor download path.
  setShare(null, null);
  anchorClicks = 0;
  res = await w.shareOrDownloadFile({ blob, filename: 'c.txt' });
  ok('no canShare (desktop) -> result "downloaded" via anchor', res === 'downloaded' && anchorClicks === 1);

  // Share sheet dismissed (AbortError) -> silent success, no anchor, no throw.
  const abort = new Error('dismissed'); abort.name = 'AbortError';
  setShare(() => true, async () => { throw abort; });
  anchorClicks = 0;
  res = await w.shareOrDownloadFile({ blob, filename: 'd.txt' });
  ok('AbortError from share -> result "aborted", silent (no anchor, no throw)',
    res === 'aborted' && anchorClicks === 0);

  // Share fails some other way -> fall back to the download.
  setShare(() => true, async () => { throw new Error('share exploded'); });
  anchorClicks = 0;
  res = await w.shareOrDownloadFile({ blob, filename: 'e.txt' });
  ok('non-Abort share failure -> falls back to anchor download',
    res === 'downloaded' && anchorClicks === 1);

  // A ready File passes through untouched.
  let fileSeen = null;
  setShare(() => true, async (data) => { fileSeen = data.files[0]; });
  const ready = new w.File(['x'], 'ready.png', { type: 'image/png' });
  res = await w.shareOrDownloadFile({ file: ready, filename: 'ready.png' });
  ok('a ready File is shared as-is', res === 'shared' && fileSeen === ready);
}

/* ================= Item 3: service worker native-shell gate ================= */

{
  const html = read('index.html');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const swBlock = blocks.find(b => b.includes('serviceWorker') && b.includes('register'));
  ok('inline service-worker registration script exists in index.html', !!swBlock);
  ok('registration snippet names the cozyInNativeShell predicate', !!swBlock && swBlock.includes('cozyInNativeShell'));
  ok("registration still targets 'sw.js' behind the http protocol guard",
    !!swBlock && swBlock.includes("register('sw.js')") && swBlock.includes("location.protocol.indexOf('http') === 0"));

  function runSnippet(capacitor) {
    let registered = 0;
    const sandbox = {
      navigator: { serviceWorker: { register: () => { registered++; return { catch() {} }; } } },
      location: { protocol: 'https:' },
      console,
    };
    sandbox.window = sandbox;
    if (capacitor !== undefined) sandbox.Capacitor = capacitor;
    if (capacitor !== undefined) sandbox.window.Capacitor = capacitor;
    vm.createContext(sandbox);
    let threw = false;
    try { vm.runInContext(swBlock, sandbox); } catch (e) { threw = true; }
    return { registered, threw, predicate: sandbox.window.cozyInNativeShell };
  }

  if (swBlock) {
    let r = runSnippet(undefined);
    ok('no Capacitor bridge -> predicate exposed on window and false',
      typeof r.predicate === 'function' && r.predicate() === false && !r.threw);
    ok('no Capacitor bridge -> service worker registers (today\'s behaviour)', r.registered === 1);

    r = runSnippet({ isNativePlatform: () => true });
    ok('Capacitor native platform -> predicate true', r.predicate() === true);
    ok('Capacitor native platform -> registration skipped', r.registered === 0 && !r.threw);

    r = runSnippet({}); // bridge object present, isNativePlatform missing
    ok('Capacitor bridge without isNativePlatform -> treated as native (registration skipped)',
      r.predicate() === true && r.registered === 0);

    r = runSnippet({ isNativePlatform: () => false });
    ok('Capacitor web platform -> predicate false, registration proceeds',
      r.predicate() === false && r.registered === 1);

    r = runSnippet({ isNativePlatform: () => { throw new Error('bridge exploded'); } });
    ok('throwing bridge -> doubt resolves to registering (today\'s behaviour)',
      r.predicate() === false && r.registered === 1 && !r.threw);
  }
}

(async () => {
  await helperScenarios();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
