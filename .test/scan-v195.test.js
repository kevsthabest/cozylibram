// v195: background refreshes must not kill an active scan session.
// addBook's Hardcover enrichment and page-count fill both render() a second
// or two after "Add to TBR" — right in the middle of the camera restart —
// which tore the scan panel down mid-getUserMedia and left a dead
// "Start camera" button. They now go through renderKeepScan(), which skips
// the render while the scan panel is open.
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

(async () => {
  // Stub out render() so we can count calls without touching the real view.
  runInWindow(`window.__renderCalls = 0; window.render = function(){ window.__renderCalls++; };`);

  // 1. Scan panel open -> render skipped (camera survives).
  runInWindow(`
    document.body.innerHTML = '<div id="add-scan-mount" data-open="1"></div>';
    window.__renderCalls = 0;
    renderKeepScan();
  `);
  ok('renderKeepScan skips render while scan panel is open',
    runInWindowRet(`window.__renderCalls`) === 0);

  // 2. Scan panel mounted but closed -> render proceeds.
  runInWindow(`
    document.body.innerHTML = '<div id="add-scan-mount"></div>';
    window.__renderCalls = 0;
    renderKeepScan();
  `);
  ok('renderKeepScan renders when scan panel is closed',
    runInWindowRet(`window.__renderCalls`) === 1);

  // 3. No scan mount at all (other tabs) -> render proceeds.
  runInWindow(`
    document.body.innerHTML = '<div id="other-view"></div>';
    window.__renderCalls = 0;
    renderKeepScan();
  `);
  ok('renderKeepScan renders when there is no scan mount',
    runInWindowRet(`window.__renderCalls`) === 1);

  // 4. Regression: addBook's background paths must not call bare render().
  const src = fs.readFileSync('/home/hatch/workspace/booktok/js/070-hardcover.js', 'utf8');
  const bgSection = src.slice(src.indexOf('Background page-count fill'));
  ok('page-count fill background path uses renderKeepScan',
    /fillPageCount\(book\)\.then[\s\S]*?else renderKeepScan\(\)/.test(bgSection));
  ok('hardcover enrichment background path uses renderKeepScan',
    /enrichHardcover\(book\)\.then[\s\S]*?else renderKeepScan\(\)/.test(bgSection));
  ok('no bare else-render remains in addBook background paths',
    !/else render\(\);/.test(bgSection));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
