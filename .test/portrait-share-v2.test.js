/* Reader Portrait share v2 tests (v500): portrait honesty rules (floor,
   distinct works, and-counting window, appetite ladder, soft mode,
   archetype variant pools), sticker rotation, and renderer smoke tests
   for A Editorial / B Cover Story / C Sticker Pack in dark + light themes.
   Spec: docs/reader-portrait-share-v2-spec.md (incl. amendment 7c5044b).
   Run: node .test/portrait-share-v2.test.js */
'use strict';
const path = require('path');
if (!process.env.BOOKTOK_DIR) process.env.BOOKTOK_DIR = path.join(__dirname, '..');
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in portrait-share-v2 tests'); };

// recording 2d context: captures drawn text + drawImage usage
const gradStub = { addColorStop() {} };
let texts, drawImages;
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'fillText') return (s) => { texts.push(String(s)); };
    if (p === 'drawImage') return () => { drawImages++; };
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradStub;
    if (p === 'canvas') return {};
    return () => {};
  },
  set() { return true; }
});
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx; };

// fake Image: every load succeeds instantly
window.Image = class {
  constructor() { this.width = 600; this.height = 900; }
  set src(v) { setTimeout(() => { if (this.onload) this.onload(); }, 0); }
};

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
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

let seq = 0;
function mkBook(o) {
  seq++;
  return Object.assign({
    id: 'bk' + seq, title: 'Book ' + seq, authors: ['Author A'], status: 'read',
    pageCount: 300, tropes: [], categories: [], ratings: {}, log: [],
    cover: '', dateFinished: null, myRating: 0, favorite: false
  }, o || {});
}
function setLibrary(books) {
  run('library = ' + JSON.stringify(books));
  return run('buildReaderPortrait()');
}

(async () => {

/* ---------- portrait object: basics ---------- */
ok('null portrait when nothing read', setLibrary([mkBook({ status: 'tbr' })]) === null);

const basic = setLibrary([
  mkBook({ title: 'One', pageCount: 100 }),
  mkBook({ title: 'Two', pageCount: 250 })
]);
ok('pages are the hero stat (summed)', basic.pages === 350);
ok('n counts read books', basic.n === 2);
ok('no spice evidence -> rated 0, avg 0, no spice appetite',
  basic.spice.rated === 0 && basic.spice.avg === 0 && (!basic.appetite || basic.appetite.axis !== 'spice'));

/* ---------- trope floor + distinct works (rule 3) ---------- */
const floored = setLibrary([
  mkBook({ title: 'A1', tropes: ['Slow Burn', 'One Hit'] }),
  mkBook({ title: 'A2', tropes: ['Slow Burn'] })
]);
const sb = floored.tropes.find(t => t.name === 'Slow Burn');
ok('trope in 2 distinct books qualifies with count 2', !!sb && sb.count === 2);
ok('trope in 1 book is below the floor', !floored.tropes.some(t => t.name === 'One Hit'));

const editions = setLibrary([
  mkBook({ title: 'Same Work', authors: ['Auth'], tropes: ['Fated Mates'] }),
  mkBook({ title: 'Same Work', authors: ['Auth'], tropes: ['Fated Mates'] }) // second edition, different id
]);
ok('duplicate editions of one work count once (below floor)',
  !editions.tropes.some(t => t.name === 'Fated Mates'));

/* ---------- "and counting" window (rule 3) ---------- */
const growing = setLibrary([
  mkBook({ title: 'G1', tropes: ['Morally Grey'], dateFinished: daysAgo(10) }),
  mkBook({ title: 'G2', tropes: ['Morally Grey'], dateFinished: daysAgo(300) }),
  mkBook({ title: 'G3', tropes: ['Found Family'], dateFinished: daysAgo(200) }),
  mkBook({ title: 'G4', tropes: ['Found Family'], dateFinished: daysAgo(250) })
]);
const mg = growing.tropes.find(t => t.name === 'Morally Grey');
const ff = growing.tropes.find(t => t.name === 'Found Family');
ok('trope in a book finished <=90 days ago is "and counting"',
  !!mg && mg.growing === true && mg.attribution.indexOf('books and counting') >= 0);
ok('stale trope gets a static attribution',
  !!ff && ff.growing === false && ff.attribution.indexOf('and counting') < 0 &&
  (ff.attribution.indexOf("books' worth of evidence") >= 0 || ff.attribution.indexOf('books deep') >= 0));

/* ---------- appetite ladder (rule 4) ---------- */
const spicyBooks = [];
for (let i = 0; i < 10; i++) spicyBooks.push(mkBook({ title: 'S' + i, ratings: { spice: 5 }, tropes: ['Possessive'] }));
const spicy = setLibrary(spicyBooks);
ok('spice axis fires at 10+ rated books', spicy.appetite && spicy.appetite.axis === 'spice');
ok('avg 5.0 -> dragonfire palate', spicy.appetite.text === 'a dragonfire palate — no regrets');

const nineBooks = spicyBooks.slice(0, 9);
const nine = setLibrary(nineBooks);
ok('9 rated books stays off the spice axis', nine.appetite && nine.appetite.axis !== 'spice');

const teethBooks = [];
for (let i = 0; i < 10; i++) {
  teethBooks.push(mkBook({
    title: 'T' + i, ratings: { spice: i % 2 ? 3 : 4 },
    tropes: i < 2 ? ['Slow Burn'] : []
  }));
}
const teeth = setLibrary(teethBooks);
ok('avg 3.5 + qualifying Slow Burn -> "a slow burn with teeth"',
  teeth.appetite && teeth.appetite.text === 'a slow burn with teeth');
const noTeethBooks = teethBooks.map(b => Object.assign({}, b, { tropes: [] }));
const noTeeth = setLibrary(noTeethBooks);
ok('avg 3.5 without Slow Burn -> "brings the heat, keeps the heart"',
  noTeeth.appetite && noTeeth.appetite.text === 'brings the heat, keeps the heart');

const tropeAxis = setLibrary([
  mkBook({ title: 'M1', tropes: ['Morally Grey'], ratings: { spice: 3 } }),
  mkBook({ title: 'M2', tropes: ['Morally Grey'] }),
  mkBook({ title: 'M3', tropes: ['Morally Grey'] })
]);
ok('trope axis falls back to the top trope quote',
  tropeAxis.appetite && tropeAxis.appetite.axis === 'trope' &&
  tropeAxis.appetite.text === 'Here for the morally grey, every time.' &&
  tropeAxis.appetite.trope === 'Morally Grey');

/* ---------- soft mode (rule 5) ---------- */
const soft = setLibrary([
  mkBook({ title: 'F1', categories: ['Romantasy'], tropes: ['Lone Trope'] }),
  mkBook({ title: 'F2', categories: ['Romantasy'] }),
  mkBook({ title: 'F3', categories: ['Romantasy'] })
]);
ok('fewer than 3 qualifying tropes -> soft mode', soft.softMode === true);
ok('soft mode claims no archetype', soft.archetype === null);
ok('soft headline is the soft-mode line', soft.headline === 'A story still being written');
ok('genre axis still fires in soft mode (bank tagline)',
  soft.appetite && soft.appetite.axis === 'genre' && soft.appetite.text === 'here for the courts and the chaos');
ok('soft mode keeps gentle tropes for presentation',
  soft.gentleTropes.some(t => t.name === 'Lone Trope'));

/* ---------- archetype pools (spec amendment 7c5044b) ---------- */
ok('every cluster exposes a titles pool',
  run('PORTRAIT_CLUSTERS.every(c => Array.isArray(c.titles) && c.titles.length >= 1)') === true);
ok('dark romance pool is the full five titles',
  JSON.stringify(run("PORTRAIT_CLUSTERS.find(c => c.key === 'darkromance').titles")) ===
  JSON.stringify(['Dark Romance Darling', 'Dark Romance Devotee', 'Dark Romance Romantic',
                  'Dark Romance Shadow Romantic', 'Dark Romance Midnight Romantic']));
ok('pool picker returns pool members; single-entry pool is stable',
  run("['a','b','c'].every(k => ['X','Y'].includes(portraitPickFromPool(['X','Y'], k, 's')))") === true &&
  run("portraitPickFromPool(['Only'], 'anyone', 's')") === 'Only');

const DR_POOL = ['Dark Romance Darling', 'Dark Romance Devotee', 'Dark Romance Romantic',
                 'Dark Romance Shadow Romantic', 'Dark Romance Midnight Romantic'];
const darkBooks = [];
for (let i = 0; i < 6; i++) {
  darkBooks.push(mkBook({
    title: 'D' + i, categories: ['Dark Romance'],
    tropes: ['Morally Grey', 'Possessive', 'Touch Her and Die']
  }));
}
const dark1 = setLibrary(darkBooks);
ok('dark romance archetype comes from the pool', DR_POOL.includes(dark1.archetype));
ok('archetype is the headline when not soft', dark1.headline === dark1.archetype && dark1.softMode === false);
const dark2 = setLibrary(darkBooks);
ok('archetype selection is deterministic for a reader + month', dark2.archetype === dark1.archetype);

const romBooks = [];
for (let i = 0; i < 5; i++) {
  romBooks.push(mkBook({
    title: 'R' + i, categories: ['Romantasy'],
    tropes: ['Fated Mates', 'Enemies to Lovers', 'Slow Burn']
  }));
}
const rom = setLibrary(romBooks);
ok('romantasy archetype is Romantasy Royalty', rom.archetype === 'Romantasy Royalty');

/* ---------- covers (rule 7) ---------- */
const coverBooks = setLibrary([
  mkBook({ title: 'Old Fav', cover: 'https://x/old.jpg', dateFinished: daysAgo(200), favorite: true, myRating: 5 }),
  mkBook({ title: 'Recent One', cover: 'https://x/r1.jpg', dateFinished: daysAgo(5) }),
  mkBook({ title: 'Recent Two', cover: 'https://x/r2.jpg', dateFinished: daysAgo(20) }),
  mkBook({ title: 'Other Fav', cover: 'https://x/f2.jpg', dateFinished: daysAgo(300), myRating: 4.5 })
]);
ok('cover strip is most-recent-first', coverBooks.coverStrip[0].title === 'Recent One' &&
  coverBooks.coverStrip[1].title === 'Recent Two');
ok('favourites fill the remaining strip slots', coverBooks.coverStrip.length === 4 &&
  coverBooks.coverStrip[2].title === 'Old Fav' && coverBooks.coverStrip[3].title === 'Other Fav');
ok('polaroid is the most recent read', coverBooks.polaroid && coverBooks.polaroid.title === 'Recent One');

/* ---------- streak as data (rule 6) ---------- */
const streakP = setLibrary([
  mkBook({ title: 'L1', log: [
    { d: '2026-09-01', from: 0, to: 40 }, { d: '2026-09-02', from: 0, to: 40 },
    { d: '2026-09-03', from: 0, to: 40 }, { d: '2026-09-04', from: 0, to: 40 }
  ] })
]);
ok('longest streak computed from log days', streakP.streak === 4);
ok('top author surfaced as a personal fact', streakP.topAuthor && streakP.topAuthor.name === 'Author A');

/* ---------- sticker rotation (MANIFEST freshness rule) ---------- */
const paths1 = run("psStickerPaths('velvet', 'reader-1', '2026-10')");
const paths2 = run("psStickerPaths('velvet', 'reader-1', '2026-10')");
ok('sticker rotation is deterministic per reader + month', JSON.stringify(paths1) === JSON.stringify(paths2));
ok('velvet set has all 24 stickers', paths1.length === 24);
ok('sticker paths point at cut-webp only',
  paths1.every(p => /^assets\/stickers\/cut-webp\/velvet\/velvet-[ab]-\d{2}\.webp$/.test(p)));
ok('wisp-night maps to the wispnight asset dir',
  run("psStickerPaths('wisp-night', 'r', '2026-10')").every(p => p.indexOf('/wispnight/') >= 0));
ok('seasonal theme has one sheet (12)', run("psStickerPaths('haunt', 'r', '2026-10')").length === 12);
ok('unknown theme yields no stickers', run("psStickerPaths('nope', 'r', '2026-10')").length === 0);
const readerOrders = ['r1', 'r2', 'r3', 'r4', 'r5'].map(k =>
  JSON.stringify(run("psStickerPaths('velvet', '" + k + "', '2026-10')")));
ok('different readers get different rotations', new Set(readerOrders).size > 1);

/* ---------- renderer smoke tests: 3 styles x 2 theme classes ---------- */
const richBooks = [];
for (let i = 0; i < 12; i++) {
  richBooks.push(mkBook({
    title: 'Rich ' + i, authors: ['Sarah J. Maas'], categories: ['Romantasy'],
    tropes: ['Enemies to Lovers', 'Morally Grey', 'Slow Burn'],
    ratings: { spice: 4 }, pageCount: 400,
    cover: 'https://example.com/c' + i + '.jpg',
    dateFinished: daysAgo(i * 3 + 1), myRating: 5
  }));
}
setLibrary(richBooks);

for (const style of ['editorial', 'cover', 'stickers']) {
  for (const [label, vars] of [['dark', darkVars], ['light', lightVars]]) {
    themeVars = vars;
    texts = []; drawImages = 0;
    const cv = await run("renderPortraitCanvas('" + style + "')");
    const joined = texts.join(' | ');
    ok(style + '/' + label + ' renders a 1080x1920 canvas', !!cv && cv.width === 1080 && cv.height === 1920);
    ok(style + '/' + label + ' draws the archetype',
      style === 'cover'
        ? joined.includes('Romantasy') && joined.includes('Royalty') // cover splits the title across two lines
        : joined.includes('Romantasy Royalty'));
    ok(style + '/' + label + ' draws the pages hero', joined.includes('4,800'));
    ok(style + '/' + label + ' footer is icon + wordmark (no emoji tagline)',
      joined.includes('Cozy Libram') && !joined.includes('🌶') && !joined.includes('🖤'));
    ok(style + '/' + label + ' has no counted trope badges',
      !texts.some(t => /^Trope\s*[×x]\s*\d/.test(t)));
  }
}
themeVars = darkVars;
texts = []; drawImages = 0;
await run("renderPortraitCanvas('stickers')");
ok('sticker pack draws illustrated art (drawImage used)', drawImages >= 3);
texts = []; drawImages = 0;
await run("renderPortraitCanvas('cover')");
ok('cover story draws the shelves strip covers', drawImages >= 4);

/* ---------- soft-mode render ---------- */
setLibrary([mkBook({ title: 'Only', categories: ['Fantasy'], tropes: ['Lone'] })]);
texts = []; drawImages = 0;
const softCv = await run("renderPortraitCanvas('editorial')");
ok('soft-mode editorial renders with the soft headline',
  !!softCv && texts.join(' ').includes('A story still being written'));

/* ---------- share routing flag ---------- */
setLibrary(richBooks);
run('localStorage.removeItem("portraitShareV1")');
run('shareDnaImage()');
ok('share opens the v2 sheet by default', !!window.document.querySelector('.pshare-sheet'));
ok('sheet offers all three styles',
  window.document.querySelectorAll('.pshare-card').length === 3);
const ov = window.document.querySelector('.sheet-overlay');
if (ov) ov.remove();
run('localStorage.setItem("portraitShareV1", "1")');
run('shareDnaImage()');
ok('v1 flag keeps the old card path (no sheet)', !window.document.querySelector('.pshare-sheet'));
run('localStorage.removeItem("portraitShareV1")');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
