// Share-card branding standard (decided): EVERY share card's footer is
// the app mark + wordmark ONLY — icon.svg + 'Cozy Libram'. No emoji
// taglines ('Tracked with Cozy Libram 🌶️🖤' and its variants), no URL/QR
// (that rule stands until a custom domain exists). One shared path:
// cardFooter() in js/050-helpers.js; js/228's psFooter delegates to it.
// This suite pins the standard behaviourally (a recording 2d context,
// the sharecard.test.js seam) over every card renderer, plus source
// pins that no renderer keeps a bespoke footer.
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { loadApp, APP_DIR } = require('./harness');

const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in branding tests'); };

// recording 2d context: fillText -> {s, y}; drawImage -> the image's src tag
let texts, images;
const gradStub = { addColorStop() {} };
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'fillText') return (s, x, y) => { texts.push({ s: String(s), y }); };
    if (p === 'drawImage') return (img) => { images.push(img && img.__src); };
    if (p === 'measureText') return () => ({ width: 120 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradStub;
    if (p === 'canvas') return {};
    return () => {};
  },
  set() { return true; }
});
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx; };

// Image stub: loads synchronously, tagged with its src so the footer
// assertions can tell the app mark (icon.svg) from content images.
window.Image = class {
  constructor() { this.width = 46; this.height = 46; }
  set src(v) { this.__src = v; if (this.onload) this.onload(); }
  get src() { return this.__src; }
};

// theme stub for js/212's portraitTheme() (reader-portrait.test.js seam)
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

loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);

function footerOk(label) {
  // '' join: js/212's dnaSpaced draws per-character, so spaced joins
  // would hide multi-word strings there. Content emoji on a card (a
  // book's spice peppers, Wrapped's section icons) are content, not
  // branding — the pins target the tagline text and the black heart,
  // which only ever existed in the old footer line.
  const joined = texts.map(t => t.s).join('');
  ok(label + ': no old tagline text anywhere on the card', !/tracked with/i.test(joined));
  ok(label + ': no black-heart tagline glyph', !joined.includes('\u{1F5A4}'));
  const foot = texts.filter(t => t.s === 'Cozy Libram');
  ok(label + ': footer text is exactly the wordmark, once', foot.length === 1);
  ok(label + ': footer sits in the bottom band', foot.length === 1 && foot[0].y > 1700);
  ok(label + ': app mark (icon.svg) drawn with the wordmark', images.includes('icon.svg'));
}

(async () => {
  /* ---- source pins: the tagline is gone, one shared footer path ---- */
  const jsDir = path.join(APP_DIR, 'js');
  const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
  const allSrc = files.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
  const srcOf = (f) => fs.readFileSync(path.join(jsDir, f), 'utf8');
  ok('source: no js file carries the old tagline (any case)', !/tracked with/i.test(allSrc));
  ok('source: no js file carries the black-heart tagline glyph', !allSrc.includes('🖤'));
  ok('source: cardFooter draws the plain wordmark',
    /function cardFooter/.test(srcOf('050-helpers.js')) && srcOf('050-helpers.js').includes("'Cozy Libram'"));
  ok('source: js/170 cards route through cardFooter',
    (srcOf('170-stats.js').match(/cardFooter\(/g) || []).length >= 2);
  ok('source: js/212 portrait cards route through cardFooter',
    (srcOf('212-dna.js').match(/cardFooter\(/g) || []).length >= 2);
  ok('source: js/228 psFooter delegates to cardFooter',
    /function psFooter[\s\S]{0,600}?cardFooter\(/.test(srcOf('228-portrait-share.js')));

  /* ---- js/170 per-book card ---- */
  const book = {
    id: 'b1', title: 'A Court of Thorns and Roses', authors: ['Sarah J. Maas'],
    cover: 'https://x/cover.jpg', pageCount: 448, status: 'read',
    ratings: { spice: 4 }, myRating: 4.5, tropes: [], progress: 448, log: [],
    dateFinished: '2026-01-15T00:00:00.000Z', series: null
  };
  texts = []; images = [];
  await window.drawBookCard(book);
  footerOk('book card');

  /* ---- js/170 Year in Books card + text summary ---- */
  const yd = {
    yr: 2026, n: 3, pages: 900, avg: 4.5, streak: 5,
    topGenres: [['Fantasy', 2]], topBooks: [{ title: 'T1', authors: ['A One'], myRating: 5 }]
  };
  texts = []; images = [];
  window.drawYearImage(yd);
  footerOk('year-in-books card');
  const summary = window.yearTextSummary(yd);
  const lines = summary.split('\n');
  ok('year text summary: no old tagline', !/tracked with/i.test(summary) && !summary.includes('🖤'));
  ok('year text summary: closes with the plain wordmark', lines[lines.length - 1] === 'Cozy Libram');

  /* ---- js/220 milestone card ---- */
  run(`localStorage.clear();
    localStorage.setItem('cozylibram.milestones', JSON.stringify({
      'books-finished-10': { achievedAt: '2026-10-01T00:00:00.000Z', seen: true }
    }));
    library.length = 0;`);
  texts = []; images = [];
  await window.drawMilestoneCard('books-finished-10');
  footerOk('milestone card');

  /* ---- js/220 shelfie card ---- */
  texts = []; images = [];
  await window.drawShelfieCard('data:image/png;base64,AAA', { books: 21, theme: 'dark' });
  footerOk('shelfie card');

  /* ---- js/214 Wrapped card ---- */
  const wd = {
    yr: 2026, n: 12, pages: 4200, hours: 60, yearTropes: [['Enemies to Lovers', 4]],
    avgSpice: 3.5, topGenres: [['Fantasy', 5]], streak: 9, five: 2,
    topAuthor: ['Sarah J. Maas', 3], dnfs: 1
  };
  texts = []; images = [];
  window.drawWrappedImage(wd);
  footerOk('wrapped card');

  /* ---- js/238 candle card ---- */
  const candleBook = {
    id: 'bk1', title: 'Tinted', authors: ['C. Writer'], cover: '',
    tropes: ['Enemies to Lovers', 'Small Town'], tropesAI: [],
    categories: ['Fantasy'], moods: []
  };
  texts = []; images = [];
  window.drawCandleCard(candleBook);
  footerOk('candle card');

  /* ---- js/239 finale card ---- */
  run(`localStorage.setItem('cozylibram.finale.v1', JSON.stringify({
    'the test saga': { kind: 'complete', at: 1, name: 'The Test Saga', count: 3,
      pages: 960, first: '2025-01-10T00:00:00.000Z', last: '2025-06-10T00:00:00.000Z',
      ratings: [5, 4, 0], favChar: null }
  }));`);
  texts = []; images = [];
  window.drawFinaleCard('The Test Saga');
  footerOk('finale card');

  /* ---- js/212 portrait v1 cards: Midnight (dark) + Hearthside (light) ---- */
  run(`library = [
    { id:'p1', title:'T1', authors:['Author X'], status:'read', pageCount:300,
      tropes:['DarkRomance'], ratings:{spice:4}, log:[
        {d:'2026-08-01', from:0, to:50}, {d:'2026-08-02', from:50, to:100}] },
    { id:'p2', title:'T2', authors:['Author X'], status:'read', pageCount:200,
      tropes:['DarkRomance'], ratings:{spice:2}, log:[] }
  ];`);
  themeVars = darkVars;
  texts = []; images = [];
  run(`drawDnaImage(readingDnaData())`);
  footerOk('portrait v1 midnight');
  themeVars = lightVars;
  texts = []; images = [];
  run(`drawDnaImage(readingDnaData())`);
  footerOk('portrait v1 hearthside');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
