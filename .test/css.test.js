// CSS sanity (v42): guards against edit mishaps in styles.css — balanced braces,
// no orphaned declarations outside rule blocks, and the #view centering contract.
const fs = require('fs');
const css = fs.readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

// strip comments and strings
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, "''");

// 1. balanced braces
let depth = 0, balanced = true;
for (const ch of clean) {
  if (ch === '{') depth++;
  if (ch === '}') { depth--; if (depth < 0) { balanced = false; break; } }
}
ok('styles.css braces are balanced', balanced && depth === 0);

// 2. no orphaned top-level declarations (a "prop: value;" at depth 0)
let d2 = 0, orphan = false, stmt = '';
for (const ch of clean) {
  if (ch === '{') { d2++; stmt = ''; }
  else if (ch === '}') { d2 = Math.max(0, d2 - 1); stmt = ''; }
  else if (d2 === 0) {
    stmt += ch;
    if (ch === ';' && /:/.test(stmt) && !/^@(media|supports|keyframes|import|charset)/.test(stmt.trim())) orphan = true;
  }
}
ok('no orphaned declarations outside rule blocks', !orphan);

// 3. #view centering contract: auto side margins in the base rule
const base = clean.match(/#view\s*\{[^}]*\}/);
ok('#view centers with auto margins', !!base && /margin\s*:\s*0\s+auto/.test(base[0]));

// 4. grid normalization (v57): the cover box is forced to 2:3 by aspect-ratio
// alone — the cover img must be absolutely positioned so a tall phone
// photo of a physical book can never stretch its tile.
const tileBox = clean.match(/\.book-tile\s+\.bt-cover\s*\{[^}]*\}/);
ok('tile box forces 2:3 via aspect-ratio',
  !!tileBox && /aspect-ratio\s*:\s*2\s*\/\s*3/.test(tileBox[0]));
ok('tile box carries the v57-tile marker (for on-device CSS checks)',
  /v57-tile/.test(css));
const tileImg = clean.match(/\.book-tile\s+\.bt-cover\s+img\s*\{[^}]*\}/);
ok('tile img is absolutely positioned (cannot stretch tile)',
  !!tileImg && /position\s*:\s*absolute/.test(tileImg[0]));
ok('tile img still covers the box',
  !!tileImg && /object-fit\s*:\s*cover/.test(tileImg[0]));
ok('tile no-cover fallback centers over the box',
  /\.book-tile\s+\.bt-fallback\s*\{[^}]*\}/.test(clean));

// 5. responsive grid (v58): fluid auto-fill columns so tiles keep a sensible
// size on any viewport, instead of a fixed 3-column layout.
const bookGrid = clean.match(/\.book-grid\s*\{[^}]*\}/);
ok('book grid uses fluid auto-fill columns',
  !!bookGrid && /repeat\s*\(\s*auto-fill\s*,\s*minmax/.test(bookGrid[0]));
ok('no dead .covers rules left behind',
  !/\.covers/.test(clean));

// 5. rating pickers (v103): .picker button must set an explicit theme-aware
// color — without it, currentColor falls back to the UA default (black), so
// selected glyphs (.picker button.on .ticon { fill: currentColor }) render as
// black blobs on dark themes.
const pickerBtn = clean.match(/\.picker button\s*\{[^}]*\}/);
ok('.picker button sets a theme-aware text color',
  !!pickerBtn && /color\s*:\s*var\(--(ink|muted|text)\)/.test(pickerBtn[0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
