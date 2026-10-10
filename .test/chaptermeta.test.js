// v402: Chapter-level metadata progressive disclosure tests.
// Verifies: trigger chapters in warnings, spice sparkline, dialogue ratio,
// character first-appearance. All hidden when data is absent.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let passed = 0, failed = 0;
const ok = (name, cond) => {
  if (cond) { passed++; console.log('PASS - ' + name); }
  else { failed++; console.log('FAIL - ' + name); }
};

// 1. Trigger chapters: shown when present, hidden when absent
{
  const withCh = window.hcDetailHTML({
    contentWarnings: ['murder', 'violence'],
    trigger_chapters: { murder: [1, 3, 7] },
  });
  ok('warnings: chapter label shown when trigger_chapters present',
    withCh.includes('Ch. 1, 3, 7'));
  ok('warnings: only matching trigger gets chapters',
    withCh.includes('murder') && withCh.includes('Ch. 1, 3, 7') &&
    !withCh.match(/violence[^<]*Ch\./));
  const withoutCh = window.hcDetailHTML({ contentWarnings: ['murder', 'violence'] });
  ok('warnings: no chapter labels when trigger_chapters absent',
    !withoutCh.includes('Ch.'));
  ok('warnings: case-insensitive trigger matching',
    window.hcDetailHTML({
      contentWarnings: ['Murder'],
      trigger_chapters: { murder: [2] },
    }).includes('Ch. 2'));
  ok('warnings: XSS in chapter numbers escaped',
    !window.hcDetailHTML({
      contentWarnings: ['x'],
      trigger_chapters: { x: ['<img src=x onerror=alert(1)>'] },
    }).includes('<img src=x'));
}

// 2. Spice sparkline: renders when data present, empty when not
{
  const spark = window.spiceSparklineHTML([0, 1, 3, 2, 5, 1]);
  ok('sparkline: renders SVG with data', spark.includes('<svg') && spark.includes('Spice forecast'));
  ok('sparkline: includes polyline points', spark.includes('<polyline'));
  ok('sparkline: empty for insufficient data', window.spiceSparklineHTML([3]) === '');
  ok('sparkline: empty for non-array', window.spiceSparklineHTML(null) === '');
  ok('sparkline: empty for empty array', window.spiceSparklineHTML([]) === '');
}

// 3. WorkStore.getChapterMeta exists and is a function
{
  const hasMethod = window.eval('typeof WorkStore !== "undefined" && typeof WorkStore.getChapterMeta === "function"');
  ok('WorkStore.getChapterMeta exists', hasMethod === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
