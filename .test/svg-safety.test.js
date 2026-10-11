// SVG safety gate: no executable or exfiltrating content in SVG assets.
// Scans every *.svg under Asset/ plus every inline <svg>...</svg> block in
// js/*.js. Fails on: <script> tags, event-handler attributes (onclick etc.),
// javascript: URIs, and external references (http/https hrefs outside the
// standard SVG namespaces). Runs in CI; blocks asset regressions.
const fs = require('fs');
const path = require('path');

const APP_DIR = '/home/hatch/workspace/booktok';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond && detail) failures.push('  ! ' + name + ': ' + detail);
};

function checkSvg(label, svg) {
  const issues = [];
  if (/<script[\s>]/i.test(svg)) issues.push('<script> tag');
  const ev = svg.match(/\son[a-zA-Z]+\s*=/);
  if (ev) issues.push('event handler attribute "' + ev[0].trim() + '"');
  if (/javascript\s*:/i.test(svg)) issues.push('javascript: URI');
  // External refs: http(s) URLs in href/src attributes that are not the
  // standard SVG namespaces (xmlns declarations are required, not exfil).
  const attrRe = /(?:href|xlink:href|src)\s*=\s*["']([^"']+)["']/gi;
  let am;
  while ((am = attrRe.exec(svg)) !== null) {
    const url = am[1];
    if (/^https?:\/\//i.test(url) && !/^https?:\/\/(www\.)?w3\.org\//i.test(url)) {
      issues.push('external reference "' + url.slice(0, 60) + '"');
    }
  }
  ok(label + ' is safe', issues.length === 0, issues.join('; '));
}

function walkSvg(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSvg(p, out);
    else if (e.name.endsWith('.svg')) out.push(p);
  }
}

// 1. Asset SVGs
const assetDir = path.join(APP_DIR, 'Asset');
const svgFiles = [];
if (fs.existsSync(assetDir)) walkSvg(assetDir, svgFiles);
ok('found SVG assets to scan', svgFiles.length > 0, 'Asset/ has no .svg files');
console.log('  (scanning ' + svgFiles.length + ' files under Asset/)');
svgFiles.forEach(f => {
  const rel = path.relative(APP_DIR, f);
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); }
  catch (e) { ok(rel + ' readable', false, String(e)); return; }
  checkSvg(rel, src);
});

// 2. Inline SVGs in js/
const jsDir = path.join(APP_DIR, 'js');
let inlineCount = 0;
fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).forEach(f => {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  const blocks = src.match(/<svg[\s\S]*?<\/svg>/gi) || [];
  blocks.forEach((b, i) => { inlineCount++; checkSvg('js/' + f + ' inline svg #' + (i + 1), b); });
});
ok('found inline SVGs to scan', inlineCount > 0, 'no <svg> blocks in js/');
console.log('  (scanning ' + inlineCount + ' inline blocks under js/)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (failures.length) console.log(failures.join('\n'));
process.exit(fail ? 1 : 0);
