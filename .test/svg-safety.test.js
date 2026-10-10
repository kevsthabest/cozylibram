// v432: SVG safety gate — no executable content in shipped SVGs.
// Greps Asset/**/*.svg for <script, on*= handlers, foreignObject, javascript:
// URIs. All current SVGs are verified clean; this test stops a future SVG
// with embedded scripts from shipping. Runs in CI.
const fs = require('fs');
const path = require('path');

const ASSET_DIR = (process.env.APP_ROOT || '/home/hatch/workspace/booktok') + '/Asset';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

function walkSvg(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSvg(p, out);
    else if (e.name.endsWith('.svg')) out.push(p);
  }
  return out;
}

const files = walkSvg(ASSET_DIR, []);
ok('found SVG files to scan', files.length > 0);
console.log('  (scanning ' + files.length + ' SVGs)');

const DANGEROUS = [
  /<script[\s>]/i,           // script tags
  /\son\w+\s*=/i,            // on* event handlers (onclick=, onload=, ...)
  /<foreignObject[\s>]/i,    // foreignObject (can embed HTML)
  /javascript:/i,            // javascript: URIs
];

let bad = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const re of DANGEROUS) {
    if (re.test(src)) { bad.push(f + ' matches ' + re); break; }
  }
}
ok('no SVGs contain executable content', bad.length === 0);
if (bad.length) bad.forEach(b => console.log('  BAD: ' + b));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
