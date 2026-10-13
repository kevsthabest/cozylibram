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
/* v513: the stub also answers overflowX from the element's inline style —
   sheetDragStartsInHScroller (js/150) reads it to refuse dismiss gestures
   that start in a horizontal scroller, and a stub returning undefined
   silently disables that refusal in this suite. */
window.getComputedStyle = (el) => ({
  overflowX: (el && el.style && el.style.overflowX) || '',
  getPropertyValue: (n) => themeVars[n] || ''
});

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

/* ---------- v502 batch 1: share-sheet controls ---------- */
setLibrary(richBooks);
run('shareDnaImage()');
ok('sheet dots are real buttons', window.document.querySelectorAll('button.pshare-dot').length === 3);
ok('sheet has prev/next arrow buttons',
  !!window.document.querySelector('.pshare-nav.prev') && !!window.document.querySelector('.pshare-nav.next'));
const trackEl2 = window.document.querySelector('.pshare-track');
Object.defineProperty(trackEl2, 'clientWidth', { value: 300, configurable: true });
let scrollArg = null;
trackEl2.scrollTo = (o) => { scrollArg = o; };
const dotBtns = window.document.querySelectorAll('button.pshare-dot');
dotBtns[2].click();
ok('dot click scrolls the carousel to its slide', !!scrollArg && scrollArg.left === 600);
ok('dot click updates the style name + active dot',
  window.document.querySelector('.pshare-name').textContent === 'Sticker Pack' &&
  dotBtns[2].classList.contains('on'));
window.document.querySelector('.pshare-nav.prev').click();
ok('prev arrow steps back one slide', !!scrollArg && scrollArg.left === 300 &&
  window.document.querySelector('.pshare-name').textContent === 'Cover Story');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
ok('ArrowRight switches style while the sheet is open', !!scrollArg && scrollArg.left === 600 &&
  window.document.querySelector('.pshare-name').textContent === 'Sticker Pack');
window.document.querySelector('.pshare-close').click();

/* ---------- v511: carousel gesture contract ----------
   The track lives inside the sheet's vertical scroller; without
   touch-action: pan-x on the track/slides/cards/canvas, Android hands
   diagonal swipes to the sheet and the carousel never moves. jsdom
   can't perform the gesture — assert the CSS contract it relies on. */
const pshareCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const cssRule = (sel) => {
  const m = pshareCss.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
};
for (const sel of ['.pshare-track', '.pshare-slide', '.pshare-card', '.pshare-card canvas']) {
  ok(sel + ' claims horizontal gestures (touch-action: pan-x)',
    /touch-action:\s*pan-x/.test(cssRule(sel)));
}
ok('track keeps native scroll-snap (the swipe is still native scrolling)',
  /overflow-x:\s*auto/.test(cssRule('.pshare-track')) &&
  /scroll-snap-type:\s*x mandatory/.test(cssRule('.pshare-track')));

/* ---------- v512: JS gesture driver ----------
   v511's touch-action claims still lost the gesture on the User's
   Pixel, so js/228 now drives horizontal drags itself (wireSheetDrag
   shape). jsdom has no touch pipeline: dispatch synthetic touch
   events — the swipe-dismiss suite's pattern — and assert
   scrollLeft / preventDefault / dots / name. */
{
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const tev = (type, points, ts) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.touches = (type === 'touchend' || type === 'touchcancel') ? [] : points;
    ev.changedTouches = points;
    Object.defineProperty(ev, 'timeStamp', { value: ts });
    return ev;
  };
  const pt = (x, y) => ({ clientX: x, clientY: y });
  const fireT = (target, type, points, ts) => {
    const ev = tev(type, points, ts);
    target.dispatchEvent(ev);
    return ev;
  };

  window.document.querySelectorAll('.sheet-overlay').forEach(o => o.remove());
  run('localStorage.removeItem("pshareStyle")');
  setLibrary(richBooks);
  run('shareDnaImage()');
  const dTrack = window.document.querySelector('.pshare-track');
  ok('driver: share sheet track is mounted', !!dTrack);
  dTrack.style.overflowX = 'auto'; // jsdom loads no styles.css; mirror the real rule inline
  Object.defineProperty(dTrack, 'scrollWidth', { value: 900, configurable: true });
  Object.defineProperty(dTrack, 'clientWidth', { value: 300, configurable: true });
  let dScrollArg = null;
  dTrack.scrollTo = (o) => { dScrollArg = o; };
  dTrack.scrollLeft = 0;
  const dDots = window.document.querySelectorAll('button.pshare-dot');
  const dName = () => window.document.querySelector('.pshare-name').textContent;
  const activeDot = () => Array.from(dDots).findIndex(d => d.classList.contains('on'));

  ok('driver: .pshare-drag suspends snap in CSS',
    /scroll-snap-type:\s*none/.test(cssRule('.pshare-track.pshare-drag')));

  /* horizontal drag past the threshold: claims, drives, settles */
  fireT(dTrack, 'touchstart', [pt(200, 100)], 0);
  const claimMove = fireT(dTrack, 'touchmove', [pt(185, 102)], 16); // dx -15, dy 2
  ok('driver: a clearly-horizontal move claims the gesture (preventDefault)',
    claimMove.defaultPrevented === true);
  ok('driver: claiming suspends snap (.pshare-drag on the track)',
    dTrack.classList.contains('pshare-drag'));
  ok('driver: the claimed drag drives scrollLeft from total travel',
    dTrack.scrollLeft === 15);
  fireT(dTrack, 'touchmove', [pt(10, 104)], 32); // dx -190
  ok('driver: scrollLeft follows the finger', dTrack.scrollLeft === 190);
  fireT(dTrack, 'touchend', [pt(10, 104)], 48);
  ok('driver: touchend settles on the nearest slide via goTo',
    !!dScrollArg && dScrollArg.left === 300);
  ok('driver: settle syncs dots + name and restores snap',
    activeDot() === 1 && dName() === 'Cover Story' && !dTrack.classList.contains('pshare-drag'));

  /* a mostly-vertical drag never claims, even if it later turns horizontal */
  dTrack.scrollLeft = 0;
  fireT(dTrack, 'touchstart', [pt(100, 100)], 100);
  const vMove = fireT(dTrack, 'touchmove', [pt(102, 150)], 116); // dy 50, dx 2
  const vMove2 = fireT(dTrack, 'touchmove', [pt(30, 160)], 132); // dx now -70
  ok('driver: a vertical-first drag is never claimed (no preventDefault)',
    vMove.defaultPrevented === false && vMove2.defaultPrevented === false);
  ok('driver: a stood-down drag leaves scrollLeft + snap alone',
    dTrack.scrollLeft === 0 && !dTrack.classList.contains('pshare-drag'));
  fireT(dTrack, 'touchend', [pt(30, 160)], 148);

  /* a tap does nothing */
  const dotBefore = activeDot();
  fireT(dTrack, 'touchstart', [pt(100, 100)], 200);
  fireT(dTrack, 'touchend', [pt(100, 100)], 260);
  ok('driver: a tap changes no slide and never suspends snap',
    activeDot() === dotBefore && dTrack.scrollLeft === 0 && !dTrack.classList.contains('pshare-drag'));

  /* a second finger kills the gesture state; the next gesture starts clean */
  fireT(dTrack, 'touchstart', [pt(200, 100), pt(220, 120)], 300);
  const mtMove = fireT(dTrack, 'touchmove', [pt(150, 101)], 316);
  ok('driver: a multi-touch start leaves no gesture to claim',
    mtMove.defaultPrevented === false && dTrack.scrollLeft === 0 && !dTrack.classList.contains('pshare-drag'));
  fireT(dTrack, 'touchend', [pt(150, 101)], 332);
  fireT(dTrack, 'touchstart', [pt(200, 100)], 400);
  fireT(dTrack, 'touchmove', [pt(150, 101)], 416); // dx -50
  ok('driver: the next single-touch gesture claims and drives cleanly',
    dTrack.scrollLeft === 50 && dTrack.classList.contains('pshare-drag'));
  fireT(dTrack, 'touchend', [pt(150, 101)], 432);
  ok('driver: state reset after the clean gesture (snap restored)',
    !dTrack.classList.contains('pshare-drag') && activeDot() === 0);

  /* scroll-sync: guarded during a driven drag, live for plain scrolls */
  dTrack.scrollLeft = 600; // slide 2, not yet synced
  dTrack.dispatchEvent(new window.Event('scroll'));
  await sleep(100);
  ok('driver: scroll-sync still syncs dots for a plain scroll',
    activeDot() === 2 && dName() === 'Sticker Pack');
  fireT(dTrack, 'touchstart', [pt(100, 100)], 500);
  fireT(dTrack, 'touchmove', [pt(260, 102)], 516); // dx +160 -> scrollLeft 440 (slide-1 territory)
  ok('driver: rightward drag drives scrollLeft back', dTrack.scrollLeft === 440);
  dTrack.dispatchEvent(new window.Event('scroll'));
  await sleep(100);
  ok('driver: scroll-sync is guarded mid-drag (dots stay on slide 2)',
    activeDot() === 2);
  fireT(dTrack, 'touchend', [pt(260, 102)], 532);
  ok('driver: touchend settle syncs dots to the landed slide',
    activeDot() === 1 && dName() === 'Cover Story');

  const ov2 = window.document.querySelector('.sheet-overlay');
  if (ov2) ov2.remove();
}

/* ---------- v513: portrait sheet drag-to-dismiss ----------
   The sheet got the .sheet CSS foundation in v500 but never the
   wireSheetDrag half of the pattern, so a downward swipe could not
   close it (every other sheet dismisses that way). Synthetic touch
   events, same pattern as the driver block above. wireSheetDrag
   gates on touch support — opt this window in first. */
{
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const tev = (type, points, ts) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.touches = (type === 'touchend' || type === 'touchcancel') ? [] : points;
    ev.changedTouches = points;
    Object.defineProperty(ev, 'timeStamp', { value: ts });
    return ev;
  };
  const pt = (x, y) => ({ clientX: x, clientY: y });
  const fireT = (target, type, points, ts) => {
    const ev = tev(type, points, ts);
    target.dispatchEvent(ev);
    return ev;
  };

  window.ontouchstart = null; // wireSheetDrag's touch-support gate
  window.document.querySelectorAll('.sheet-overlay').forEach(o => o.remove());
  run('localStorage.removeItem("pshareStyle")');
  setLibrary(richBooks);
  run('shareDnaImage()');
  const gSheet = window.document.querySelector('.pshare-sheet');
  ok('dismiss: portrait sheet is mounted', !!gSheet);
  const gTitle = gSheet.querySelector('.pshare-title');

  /* downward drag from the top: claims, tracks, dismisses via close() */
  fireT(gTitle, 'touchstart', [pt(100, 100)], 0);
  fireT(gTitle, 'touchmove', [pt(100, 112)], 16); // crosses the 10px gate -> claim
  fireT(gTitle, 'touchmove', [pt(100, 200)], 32);
  ok('dismiss: downward drag tracks the finger', gSheet.style.transform === 'translateY(88px)');
  fireT(gTitle, 'touchend', [pt(100, 200)], 48);
  await sleep(260); // wireSheetDrag's 190ms dismiss delay -> close()
  const gOverlay = window.document.querySelector('.sheet-overlay');
  ok('dismiss: downward drag closes the sheet (open class removed)',
    !!gOverlay && !gOverlay.classList.contains('open'));
  await sleep(400); // close()'s own 300ms removal
  ok('dismiss: overlay is removed after close',
    !window.document.querySelector('.pshare-sheet'));

  /* downward drag that starts inside the carousel: refused, no dismiss */
  run('shareDnaImage()');
  const hSheet = window.document.querySelector('.pshare-sheet');
  const hTrack = hSheet.querySelector('.pshare-track');
  hTrack.style.overflowX = 'auto'; // jsdom loads no styles.css; mirror the real rule inline
  Object.defineProperty(hTrack, 'scrollWidth', { value: 900, configurable: true });
  Object.defineProperty(hTrack, 'clientWidth', { value: 300, configurable: true });
  fireT(hTrack, 'touchstart', [pt(100, 100)], 0);
  fireT(hTrack, 'touchmove', [pt(100, 112)], 16);
  fireT(hTrack, 'touchmove', [pt(100, 320)], 32); // long downward pull, still refused
  fireT(hTrack, 'touchend', [pt(100, 320)], 48);
  await sleep(260);
  ok('dismiss: a drag starting in the carousel never drags or closes the sheet',
    hSheet.style.transform === '' &&
    window.document.querySelector('.sheet-overlay').classList.contains('open'));
  hSheet.querySelector('.pshare-close').click();
  await sleep(350);
  ok('dismiss: carousel sheet still closes via its button',
    !window.document.querySelector('.pshare-sheet'));

  /* downward drag while the sheet is scrolled: the scrollTop veto holds */
  run('shareDnaImage()');
  const sSheet = window.document.querySelector('.pshare-sheet');
  const sTitle = sSheet.querySelector('.pshare-title');
  Object.defineProperty(sSheet, 'scrollTop', { value: 40, configurable: true });
  fireT(sTitle, 'touchstart', [pt(100, 100)], 0);
  fireT(sTitle, 'touchmove', [pt(100, 112)], 16);
  fireT(sTitle, 'touchmove', [pt(100, 320)], 32);
  fireT(sTitle, 'touchend', [pt(100, 320)], 48);
  await sleep(260);
  ok('dismiss: a scrolled sheet does not dismiss on a downward drag',
    sSheet.style.transform === '' &&
    window.document.querySelector('.sheet-overlay').classList.contains('open'));
  const sOverlay = window.document.querySelector('.sheet-overlay');
  if (sOverlay) sOverlay.remove();
}

/* ---------- v502 batch 1: sticker-pack geometry + density ----------
   A measuring context with realistic text widths (the shared fakeCtx
   measures everything as 10px, which proves nothing about layout). */
function geoCtx() {
  const rec = { texts: [], images: 0, arcs: [] };
  const grad = { addColorStop() {} };
  const ctx = {
    font: '10px sans-serif', fillStyle: '', strokeStyle: '', shadowColor: '',
    shadowBlur: 0, shadowOffsetY: 0, lineWidth: 1, textAlign: 'left',
    textBaseline: 'alphabetic', globalAlpha: 1,
    measureText(s) {
      const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
      const size = m ? parseFloat(m[1]) : 10;
      return { width: String(s).length * size * 0.52 };
    },
    fillText(s) { rec.texts.push(String(s)); },
    drawImage() { rec.images++; },
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    arc(x, y, r) { rec.arcs.push({ x, y, r }); },
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arcTo() {},
    quadraticCurveTo() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}
  };
  return { ctx, rec };
}
const geoImg = { width: 600, height: 900 };
const geoAssets = () => ({
  covers: [], polaroid: geoImg, icon: null,
  stickers: Array.from({ length: 40 }, () => geoImg)
});
const boxesHit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
function checkGeo(label, P) {
  const { ctx, rec } = geoCtx();
  window.__geoCtx = ctx; window.__geoP = P; window.__geoA = geoAssets();
  themeVars = darkVars;
  const layout = run('drawPortraitStickerPack(window.__geoCtx, 1080, 1920, window.__geoP, portraitTheme(), window.__geoA)');
  ok(label + ': layout returned with a cover-sticker box', !!layout && !!layout.coverSticker && !!layout.coverArt);
  ok(label + ': no pill intersects the cover art',
    layout.pills.every(b => !boxesHit(b, layout.coverArt)));
  const appPill = layout.pills.find(b => b.x0 < 540 && b.x1 > 540 && b.y0 < 512 && b.y1 > 512);
  ok(label + ': cover sticker top edge clears the appetite pill by >=24px',
    !!appPill && (layout.coverSticker.y0 - appPill.y1) >= 23.5);
  ok(label + ': collage places stickers by count when the set allows (got ' + layout.stickersDrawn + ')',
    layout.stickersDrawn >= 24 && layout.stickersDrawn <= 40);
  const maxDim = (b) => Math.max(b.x1 - b.x0, b.y1 - b.y0);
  ok(label + ': size variance — hero-class stickers present (>=300px boxes)',
    layout.stickerBoxes.some(b => maxDim(b) >= 300));
  ok(label + ': size variance — filler-class stickers present (<=200px boxes)',
    layout.stickerBoxes.filter(b => maxDim(b) <= 200).length >= 3);
  ok(label + ': stickers never cover a protected glyph zone',
    layout.stickerBoxes.every(sb => !layout.protectedZones.some(z => boxesHit(sb, z))));
  ok(label + ': collage coverage >=70% of canvas under full containment (got ' + Math.round((layout.coverage || 0) * 100) + '%)',
    layout.coverage >= 0.7);
  /* Batch 2: no fixed hero anchors — heroes scatter, so at least one
     hero-class sticker must sit beyond the legacy system's reach
     (anchor + max jitter displacement was ~134px). */
  const legacyAnchors = [[36, 36], [1044, 36], [36, 1884], [1044, 1884], [24, 760],
    [1056, 1180], [540, 16], [24, 1330], [1056, 560], [540, 1904]];
  const heroBoxes = layout.stickerBoxes.filter(b => maxDim(b) >= 300);
  ok(label + ': heroes are not anchor-slotted (one sits >150px from every legacy anchor)',
    heroBoxes.some(b => {
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      return legacyAnchors.every(a => Math.hypot(cx - a[0], cy - a[1]) > 150);
    }));
  ok(label + ': every sticker fully on-canvas (no clipped stickers, batch-2 amendment)',
    layout.stickerBoxes.every(sb => sb.x0 >= -0.5 && sb.y0 >= -0.5 && sb.x1 <= 1080.5 && sb.y1 <= 1920.5));
  ok(label + ': no camera dot on the device back',
    !rec.arcs.some(a => Math.abs(a.x - 540) < 2 && Math.abs(a.y - 152) < 2));
  ok(label + ': headline + appetite drawn in full (never ellipsized)',
    rec.texts.includes(P.headline) && rec.texts.includes(P.appetite.text) &&
    !rec.texts.some(s => s.includes('…')));
}
checkGeo('geo/rich', {
  v: 2, n: 27, headline: 'Dark Romance Midnight Romantic',
  archetype: 'Dark Romance Midnight Romantic', clusterKey: 'darkromance', softMode: false,
  genres: [{ name: 'Dark Romance', count: 12 }], dominantGenre: 'Dark Romance',
  tropes: [{ name: 'Morally Grey', quote: 'Here for the morally grey, every time.',
             attribution: '— 12 books and counting', count: 12, growing: true }],
  gentleTropes: [],
  appetite: { axis: 'genre', text: 'here for the sentences that stay with you' },
  spice: { avg: 0, rated: 0 }, pages: 9841, streak: 9,
  topAuthor: { name: 'Penelope Douglas' }, coverStrip: [],
  polaroid: { title: 'Credence', cover: 'https://x/c.jpg' },
  seed: 1234567, readerKey: 'reader-geo'
});
checkGeo('geo/soft', {
  v: 2, n: 11, headline: 'A story still being written', archetype: null,
  clusterKey: 'scifi', softMode: true,
  genres: [{ name: 'Science Fiction', count: 6 }], dominantGenre: 'Science Fiction',
  tropes: [], gentleTropes: [{ name: 'Lone Trope' }],
  appetite: { axis: 'genre', text: 'here for the stars and the strange' },
  spice: { avg: 0, rated: 0 }, pages: 5520, streak: 1,
  topAuthor: { name: 'Dan Brown' }, coverStrip: [],
  polaroid: { title: 'Rules of Prey', cover: 'https://x/p.jpg' },
  seed: 7654321, readerKey: 'reader-geo'
});

/* Batch 2: seeded scatter is deterministic per reader+month, and a
   different seed produces a genuinely different pile (no fixed layout). */
{
  const P = {
    v: 2, n: 27, headline: 'Dark Romance Midnight Romantic',
    archetype: 'Dark Romance Midnight Romantic', clusterKey: 'darkromance', softMode: false,
    genres: [{ name: 'Dark Romance', count: 12 }], dominantGenre: 'Dark Romance',
    tropes: [{ name: 'Morally Grey', quote: 'Here for the morally grey, every time.',
               attribution: '— 12 books and counting', count: 12, growing: true }],
    gentleTropes: [],
    appetite: { axis: 'genre', text: 'here for the sentences that stay with you' },
    spice: { avg: 0, rated: 0 }, pages: 9841, streak: 9,
    topAuthor: { name: 'Penelope Douglas' }, coverStrip: [],
    polaroid: { title: 'Credence', cover: 'https://x/c.jpg' },
    seed: 1234567, readerKey: 'reader-geo'
  };
  const runLayout = (seed) => {
    const { ctx } = geoCtx();
    window.__geoCtx = ctx; window.__geoP = Object.assign({}, P, { seed }); window.__geoA = geoAssets();
    themeVars = darkVars;
    return run('drawPortraitStickerPack(window.__geoCtx, 1080, 1920, window.__geoP, portraitTheme(), window.__geoA)');
  };
  const boxesKey = (L) => L.stickerBoxes.map(b => [b.x0, b.y0, b.x1, b.y1].map(Math.round).join(',')).join('|');
  const a1 = runLayout(1234567), a2 = runLayout(1234567), b = runLayout(7654321);
  ok('scatter: same seed reproduces the identical pile', boxesKey(a1) === boxesKey(a2));
  ok('scatter: a different seed scatters differently', boxesKey(a1) !== boxesKey(b));
}

/* density through the real render path (fake Image loads the full set) */
setLibrary(richBooks);
themeVars = darkVars;
texts = []; drawImages = 0;
await run("renderPortraitCanvas('stickers')");
ok('sticker render draws the full collage (16+ illustrated + cover + icon)', drawImages >= 18);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
