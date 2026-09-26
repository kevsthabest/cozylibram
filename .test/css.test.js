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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
