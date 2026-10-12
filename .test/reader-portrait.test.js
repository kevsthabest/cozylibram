/* Reader Portrait share card tests (v487): Variant B (Midnight) / Variant A
   (Hearthside) canvas redesign — theme-aware colors, ghost numerals, ember
   dots (no glow), spice hidden when unrated, trope dedup, longest streak.
   Run: node .test/reader-portrait.test.js */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in reader-portrait tests'); };

// recording 2d context: captures drawn text + property sets
const gradStub = { addColorStop() {} };
let texts, sets;
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'fillText') return (s) => { texts.push(String(s)); };
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradStub;
    if (p === 'canvas') return {};
    return () => {};
  },
  set(t, p, v) { sets.push([p, v]); return true; }
});
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx; };

// theme stub: portraitTheme() reads CSS vars via getComputedStyle
const darkVars = {
  '--bg': '#14101a', '--bg2': '#1d1526', '--card2': '#2c2040',
  '--ink': '#f3e9f5', '--muted': '#b9a8c4', '--line': '#3a2b4d',
  '--gold': '#d4a24e', '--accent': '#8b5cf6', '--accent-deep': '#6d3fd4'
};
const lightVars = {
  '--bg': '#faf5ec', '--bg2': '#f0e7d5', '--card2': '#f6eedd',
  '--ink': '#2c2333', '--muted': '#6f5f78', '--line': '#e2d4bd',
  '--gold': '#a87b24', '--accent': '#e5488f', '--accent-deep': '#c2377a'
};
let themeVars = darkVars;
window.getComputedStyle = () => ({ getPropertyValue: (n) => themeVars[n] || '' });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const run = (js) => window.eval(js);
const todayKey = () => {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
};

/* ---- dedupeTropes: pure unit tests ---- */
ok('dedupe drops subset names (Romance/Dark yield to DarkRomance)',
  run(`JSON.stringify(Object.keys(dedupeTropes({Romance:33, Dark:26, DarkRomance:26, Fiction:26})).sort())`) ===
  JSON.stringify(['DarkRomance', 'Fiction']));
ok('dedupe is case-insensitive',
  run(`JSON.stringify(Object.keys(dedupeTropes({darkromance:5, DARK:3})))`) === JSON.stringify(['darkromance']));
ok('dedupe keeps equal-length distinct names',
  run(`JSON.stringify(Object.keys(dedupeTropes({abc:1, def:2})).sort())`) === JSON.stringify(['abc', 'def']));
ok('dedupe keeps non-overlapping names',
  run(`JSON.stringify(Object.keys(dedupeTropes({'enemies-to-lovers':2, 'forced proximity':1})))`) ===
  JSON.stringify(['enemies-to-lovers', 'forced proximity']));

/* ---- readingDnaData: dedup + longest streak ---- */
run(`library = [
  { id:'p1', title:'T1', authors:['Author X'], status:'read', pageCount:300,
    tropes:['Romance','Dark','DarkRomance'], ratings:{spice:4}, log:[
      {d:'2026-08-01', from:0, to:50}, {d:'2026-08-02', from:50, to:100},
      {d:'2026-08-03', from:100, to:150}, {d:'2026-08-04', from:150, to:200},
      {d:'2026-08-05', from:200, to:250}] },
  { id:'p2', title:'T2', authors:['Author X'], status:'read', pageCount:200,
    tropes:['DarkRomance','Contemporary'], ratings:{spice:2},
    log:[{d:'${todayKey()}', from:0, to:10}] },
];`);
const dna = run(`readingDnaData()`);
ok('dna top tropes deduped (no bare Romance/Dark)',
  !dna.topTropes.some(([t]) => t === 'Romance' || t === 'Dark') &&
  dna.topTropes.some(([t]) => t === 'DarkRomance'));
ok('dna streak is the LONGEST streak (5), not current (1)', dna.streak === 5);

/* ---- drawDnaImage: dark theme → Variant B (Midnight) ---- */
themeVars = darkVars;
texts = []; sets = [];
const cvB = run(`drawDnaImage(readingDnaData())`);
ok('midnight card is 1080x1920', cvB && cvB.width === 1080 && cvB.height === 1920);
ok('midnight shows ghost numerals', texts.some(t => t === '01'));
ok('midnight shows italic display title', texts.some(t => t === 'My Reader') && texts.some(t => t === 'Portrait'));
ok('midnight shows spice caption when rated', texts.some(t => t.includes('of 5')));
ok('midnight uses theme gold for title', sets.some(([p, v]) => p === 'fillStyle' && v === '#d4a24e'));
ok('midnight uses theme accent in dots', sets.some(([p, v]) => p === 'fillStyle' && v && typeof v === 'object'));
ok('midnight keeps BookTok footer', texts.join('').toLowerCase().includes('cozy libram'));
ok('midnight: NO glow on spice dots (no shadowBlur/shadowColor sets)',
  !sets.some(([p, v]) => (p === 'shadowBlur' && v) || (p === 'shadowColor' && v)));

/* ---- spice hidden when unrated ---- */
run(`library.forEach(b => { b.ratings = {}; });`);
texts = []; sets = [];
run(`drawDnaImage(readingDnaData())`);
ok('spice section hidden when unrated (no SPICE label)',
  !texts.some(t => t === 'SPICE' || t === 'SPICE LEVEL'));

/* ---- light theme → Variant A (Hearthside) ---- */
themeVars = lightVars;
run(`library = [
  { id:'p1', title:'T1', authors:['Author X'], status:'read', pageCount:300,
    tropes:['enemies-to-lovers'], ratings:{spice:3}, log:[] },
];`);
texts = []; sets = [];
const cvA = run(`drawDnaImage(readingDnaData())`);
ok('hearthside card is 1080x1920', cvA && cvA.width === 1080 && cvA.height === 1920);
ok('hearthside shows fleuron + kicker',
  texts.some(t => t === '❦') && texts.join('').includes('MY READER PORTRAIT'));
ok('hearthside shows numbered tropes (not ghost numerals)', texts.some(t => t === '1') && !texts.some(t => t === '01'));
ok('hearthside uses light-theme gold', sets.some(([p, v]) => p === 'fillStyle' && v === '#a87b24'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
