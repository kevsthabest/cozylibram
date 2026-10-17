// Tests for "Your Book as a Candle" (spec: docs/book-candle-spec.md).
// Pins: determinism (same book -> same candle, every render), field-keying
// honesty (a layer's note comes ONLY from that layer's field — a book
// without tropes gets no heart note), thin-data honesty (fewer notes,
// framed, never invented), the curated table's integrity + canonical
// coverage, and the swappable candle-name patterns (1 built, 3 listed).
'use strict';

let _pass = 0, _fail = 0;
function ok(name, cond) {
  if (cond) { _pass++; }
  else { _fail++; console.log('FAIL - ' + name); }
}
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classicize } = require('./harness');
const ROOT = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';

function loadJS(rel, extra) {
  // R3 repoint (migration plan §9.3): js/238 is a real ES module since
  // phase 1b; classicize restores the classic body before vm evaluation.
  // Loading plumbing only — assertions untouched; identity on classic files.
  const src = classicize(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
  const sandbox = {
    console: console,
    document: undefined,
    window: {},
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } },
    module: { exports: {} },
  };
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { filename: rel }); } catch (e) { /* document-dependent parts may throw */ }
  return sandbox;
}

// taxonomy first (tropeResolveId), then the candle module
const tax = loadJS('js/156-trope-taxonomy.js', {});
const TROPES = vm.runInContext('TROPES', tax);
const tropeResolveId = tax.tropeResolveId || vm.runInContext('tropeResolveId', tax);

const sbx = loadJS('js/238-book-candle.js', {
  esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  icon: () => '<svg></svg>',
  bookGenres: b => (b.categories || []).slice(),
  tropeResolveId: tropeResolveId,
});
const M = sbx.module.exports;
ok('module exports present', !!M && typeof M.bookCandle === 'function');
const { bookCandle, candleName, candleCardHTML, CANDLE_TABLE, CANDLE_TABLE_VERSION, CANDLE_NAME_PATTERN } = M;

// ---------- fixtures ----------
const fullBook = {
  id: 'bk1', title: 'A Court of Tests', authors: ['A. Writer'],
  tropes: ['Enemies to Lovers', 'Small Town'], tropesAI: ['Slow Burn'],
  categories: ['Fantasy'], moods: ['dark'],
};
const noTropeBook = {
  id: 'bk2', title: 'Quiet Book', authors: ['B. Writer'],
  tropes: [], tropesAI: [], categories: ['Fantasy'], moods: ['dark'],
};
const emptyBook = { id: 'bk3', title: 'Blank', authors: [], tropes: [], tropesAI: [], categories: [], moods: [] };

// ---------- table integrity ----------
eq('table version is 1', CANDLE_TABLE_VERSION, 1);
ok('name pattern built is #1', CANDLE_NAME_PATTERN === 1);
const baseKeys = Object.keys(CANDLE_TABLE.base);
const heartKeys = Object.keys(CANDLE_TABLE.heart);
const genreKeys = Object.keys(CANDLE_TABLE.topGenre);
const moodKeys = Object.keys(CANDLE_TABLE.topMood);
ok('base (setting) coverage >= 14', baseKeys.length >= 14);
ok('heart (trope) coverage >= 40', heartKeys.length >= 40);
ok('top genre coverage >= 14', genreKeys.length >= 14);
ok('top mood coverage >= 10', moodKeys.length >= 10);
ok('every entry has note + spark',
  baseKeys.concat(heartKeys, genreKeys, moodKeys).every(k =>
    [CANDLE_TABLE.base[k], CANDLE_TABLE.heart[k], CANDLE_TABLE.topGenre[k], CANDLE_TABLE.topMood[k]]
      .filter(Boolean).every(e => e.note && e.spark)));
ok('every base entry has a scene pair',
  baseKeys.every(k => Array.isArray(CANDLE_TABLE.base[k].scene) &&
    CANDLE_TABLE.base[k].scene.length === 2 && CANDLE_TABLE.base[k].scene.every(Boolean)));
ok('base and heart key sets are disjoint',
  baseKeys.every(k => !CANDLE_TABLE.heart[k]) && heartKeys.every(k => !CANDLE_TABLE.base[k]));
const canonIds = new Set(TROPES.map(t => t.id));
ok('every base key is a canonical trope id', baseKeys.every(k => canonIds.has(k)));
ok('every heart key is a canonical trope id', heartKeys.every(k => canonIds.has(k)));
// the spec's three named heart notes are literal
eq('spec: enemies-to-lovers note', CANDLE_TABLE.heart['enemies-to-lovers'].note, 'smoke & rose');
eq('spec: found-family note', CANDLE_TABLE.heart['found-family'].note, 'honey & warm bread');
eq('spec: morally-grey note', CANDLE_TABLE.heart['morally-grey'].note, 'leather & ash');

// ---------- derivation: field-keying ----------
const full = bookCandle(fullBook);
eq('full: top from genre Fantasy', full.notes.top && full.notes.top.note, 'bergamot & wild mint');
eq('full: top source kind is genre', full.notes.top && full.notes.top.source.kind, 'genre');
eq('full: heart from first keyed trope', full.notes.heart && full.notes.heart.note, 'smoke & rose');
eq('full: heart source id', full.notes.heart && full.notes.heart.source.id, 'enemies-to-lovers');
eq('full: base from setting trope', full.notes.base && full.notes.base.note, 'porch rain & honeysuckle');
eq('full: base source id', full.notes.base && full.notes.base.source.id, 'small-town');
eq('full: mapped count', full.mapped, 3);
eq('full: not thin', full.thin, false);

// genre beats mood for top when both are keyed
const gm = bookCandle({ id: 'g1', tropes: [], tropesAI: [], categories: ['Mystery'], moods: ['dark'] });
eq('genre wins over mood', gm.notes.top && gm.notes.top.source.kind, 'genre');
eq('genre wins: note', gm.notes.top && gm.notes.top.note, 'black tea & lemon peel');
// mood keys top when no genre matches
const mo = bookCandle({ id: 'g2', tropes: [], tropesAI: [], categories: ['Obscure Studies'], moods: ['dark'] });
eq('mood fallback kind', mo.notes.top && mo.notes.top.source.kind, 'mood');
eq('mood fallback note', mo.notes.top && mo.notes.top.note, 'clove & candle-smoke');

// ---------- field-keying honesty ----------
const nt = bookCandle(noTropeBook);
eq('no tropes -> no heart note', nt.notes.heart, null);
eq('no tropes -> no base note (setting lives in tropes)', nt.notes.base, null);
ok('no tropes -> top still keyed from genre', !!nt.notes.top);
eq('no tropes: mapped', nt.mapped, 1);
eq('no tropes: thin', nt.thin, true);
// tropes present but none keyed -> still no heart note (never invented)
const alien = bookCandle({ id: 'g3', tropes: ['Some Unmapped Tag'], tropesAI: [], categories: [], moods: [] });
eq('unmapped trope -> no heart note', alien.notes.heart, null);
eq('unmapped trope -> mapped 0', alien.mapped, 0);
// setting trope alone keys base but not heart
const so = bookCandle({ id: 'g4', tropes: ['Haunted House'], tropesAI: [], categories: [], moods: [] });
eq('setting-only: base keyed', so.notes.base && so.notes.base.note, 'cold ash & damp plaster');
eq('setting-only: heart stays null', so.notes.heart, null);
// AI tropes key too (portrait local merge: user first, then AI)
const ai = bookCandle({ id: 'g5', tropes: [], tropesAI: ['Found Family'], categories: [], moods: [] });
eq('AI trope keys heart', ai.notes.heart && ai.notes.heart.note, 'honey & warm bread');

// ---------- determinism ----------
let det = true;
const first = JSON.stringify(bookCandle(fullBook));
for (let i = 0; i < 50; i++) if (JSON.stringify(bookCandle(fullBook)) !== first) det = false;
ok('determinism: 50 renders identical', det);
const h1 = candleCardHTML(fullBook), h2 = candleCardHTML(fullBook);
eq('determinism: card HTML identical across renders', h1, h2);
// input book is not mutated
const frozen = JSON.stringify(fullBook);
bookCandle(fullBook); candleCardHTML(fullBook);
eq('book object not mutated', JSON.stringify(fullBook), frozen);

// ---------- thin-data honesty in the card ----------
const empty = bookCandle(emptyBook);
eq('empty: all notes null', [empty.notes.top, empty.notes.heart, empty.notes.base].every(n => n === null), true);
eq('empty: mapped 0', empty.mapped, 0);
eq('empty: thin', empty.thin, true);
const emptyHTML = candleCardHTML(emptyBook);
ok('empty card: pours line present', /pours/.test(emptyHTML));
ok('empty card: no note rows', (emptyHTML.match(/candle-row/g) || []).length === 0);
ok('empty card: no table note leaks in',
  !/sea salt|bergamot|smoke &amp; rose|honey/.test(emptyHTML.replace(/&amp;/g, '&')));
const fullHTML = candleCardHTML(fullBook);
eq('full card: 3 note rows', (fullHTML.match(/candle-row/g) || []).length, 3);
ok('full card: no pours line', !/pours/.test(fullHTML));
const partialHTML = candleCardHTML(noTropeBook);
eq('partial card: 1 note row', (partialHTML.match(/candle-row/g) || []).length, 1);
ok('partial card: pours line present', /pours/.test(partialHTML));

// ---------- escaping: book-side strings in source labels are escaped ----------
const escBook = { id: 'e1', tropes: ['Enemies to Lovers &'], tropesAI: [], categories: [], moods: [] };
const escC = bookCandle(escBook);
eq('punctuated trope still keys via resolver', escC.notes.heart && escC.notes.heart.note, 'smoke & rose');
const escHTML = candleCardHTML(escBook);
ok('source label escapes &', escHTML.indexOf('Enemies to Lovers &amp;') !== -1);
ok('no raw & label', !/Enemies to Lovers &(?!amp;)/.test(escHTML));

// ---------- name patterns (1 built; 2 + 3 swappable in the same function) ----------
eq('pattern 1 (blend) is the default name', full.name, 'Bergamot & Smoke');
eq('pattern 1 via fn', candleName(full, 1), 'Bergamot & Smoke');
eq('pattern 2 (The ___ Candle)', candleName(full, 2), 'The Porch Rain Candle');
eq('pattern 3 (scene)', candleName(full, 3), 'Rain on the Porch');
eq('single-note name is that note head', candleName(bookCandle(noTropeBook), 1), 'Bergamot');
eq('empty book name falls back honestly', candleName(empty, 1), 'The Unlit Candle');
eq('empty book name, pattern 2', candleName(empty, 2), 'The Unlit Candle');
eq('empty book name, pattern 3', candleName(empty, 3), 'The Unlit Candle');
ok('pattern fn tolerates junk pattern', candleName(full, 99) === full.name);

// ---------- wiring pins (source) ----------
const modalSrc = fs.readFileSync(path.join(ROOT, 'js/150-modal-discovery.js'), 'utf8');
ok('modal renders portrait before candle',
  modalSrc.indexOf('portraitCardHTML') !== -1 &&
  modalSrc.indexOf('candleCardHTML') > modalSrc.indexOf('portraitCardHTML'));
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('index.html loads 238-book-candle.js', indexSrc.indexOf('js/238-book-candle.js') !== -1);
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
ok('sw.js precaches 238-book-candle.js', swSrc.indexOf('238-book-candle.js') !== -1);
ok('spec doc committed in repo', fs.existsSync(path.join(ROOT, 'docs/book-candle-spec.md')));

// ---------- cover tint (v567): wax colour follows the book's cover ----------
// The tint reads ONLY the spine sampler's cache (spicyshelves.spinecolors,
// global spineColorCache) with the same validity guard the 3D spines use
// (entry's cover must equal the book's current cover). No cache -> the
// house default wax. Scent derivation must not notice the tint at all.
function lumOf(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function makeCtx(rec) {
  const grad = kind => {
    const g = { kind, stops: [], addColorStop(s, c) { this.stops.push([s, c]); } };
    rec.gradients.push(g); return g;
  };
  return {
    textAlign: '', fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    createRadialGradient: () => grad('radial'),
    createLinearGradient: () => grad('linear'),
    fillRect() {}, save() {}, restore() {}, clip() {}, fill() {}, stroke() {},
    beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {},
    fillText() {},
  };
}
const cacheStub = { bkT: { hex: '#7a1f1f', cover: 'https://x/cover-a.jpg' } };
const ccRec = { gradients: [] };
const tintSbx = loadJS('js/238-book-candle.js', {
  esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  icon: () => '<svg></svg>',
  bookGenres: b => (b.categories || []).slice(),
  tropeResolveId: tropeResolveId,
  spineColorCache: cacheStub,
  cardCanvas: () => ({ cv: {}, x: makeCtx(ccRec), W: 1080, H: 1920, C: { ink: '#f6eff8', mut: '#b8a8c8', gold: '#e5b86a' } }),
});
const TM = tintSbx.module.exports;
ok('candleTint exported', !!TM && typeof TM.candleTint === 'function');
const tintBook = {
  id: 'bkT', title: 'Tinted', authors: ['C. Writer'], cover: 'https://x/cover-a.jpg',
  tropes: ['Enemies to Lovers', 'Small Town'], tropesAI: [], categories: ['Fantasy'], moods: [],
};
const tint = TM.candleTint(tintBook);
ok('tint: derived from cached palette', !!tint);
ok('tint: hex shape', !!tint && /^#[0-9a-f]{6}$/.test(tint.hex) && /^#[0-9a-f]{6}$/.test(tint.top) && /^#[0-9a-f]{6}$/.test(tint.base));
ok('tint: top lighter than base', !!tint && lumOf(tint.top) > lumOf(tint.base));
ok('tint: hue follows the cover (red-dominant stays red-dominant)',
  !!tint && parseInt(tint.hex.slice(1, 3), 16) > parseInt(tint.hex.slice(5, 7), 16));
// determinism with a palette present
let tdet = true;
const tFirst = JSON.stringify(TM.candleTint(tintBook));
for (let i = 0; i < 50; i++) if (JSON.stringify(TM.candleTint(tintBook)) !== tFirst) tdet = false;
ok('tint: deterministic across 50 calls', tdet);
const th1 = TM.candleCardHTML(tintBook), th2 = TM.candleCardHTML(tintBook);
eq('tint: card HTML identical across renders', th1, th2);
ok('tint: modal wax carries the tint gradient',
  th1.indexOf('candle-fig-wax') !== -1 && th1.indexOf(tint.top) !== -1 && th1.indexOf(tint.base) !== -1);
ok('tint: no text sits on the tint (name carries no background)',
  !/candle-name[^>]*style=/.test(th1));
// scent output identical with and without a palette/cover
const scentFields = { id: 'bkT', title: 'Tinted', authors: ['C. Writer'], tropes: tintBook.tropes, tropesAI: [], categories: ['Fantasy'], moods: [] };
eq('tint: scent derivation unchanged by palette',
  JSON.stringify(TM.bookCandle(tintBook)), JSON.stringify(bookCandle(scentFields)));
// stale cache entry (cover changed since sampling) -> no tint
eq('tint: cache for a previous cover is ignored',
  TM.candleTint({ ...tintBook, cover: 'https://x/cover-b.jpg' }), null);
// ...and once the sampler caches the new cover, the tint follows the edition
cacheStub.bkT = { hex: '#1f3a7a', cover: 'https://x/cover-b.jpg' };
const tintB = TM.candleTint({ ...tintBook, cover: 'https://x/cover-b.jpg' });
ok('tint: follows the new cover once sampled', !!tintB && tintB.hex !== tint.hex &&
  parseInt(tintB.hex.slice(5, 7), 16) > parseInt(tintB.hex.slice(1, 3), 16));
cacheStub.bkT = { hex: '#7a1f1f', cover: 'https://x/cover-a.jpg' };
// absent palette shapes -> null (house default takes over)
eq('tint: unknown book -> null', TM.candleTint({ id: 'nope', cover: 'https://x/c.jpg' }), null);
eq('tint: book without cover -> null', TM.candleTint({ id: 'bkT' }), null);
cacheStub.bkBad = { hex: 'not-a-color', cover: 'https://x/bad.jpg' };
eq('tint: malformed cached hex -> null', TM.candleTint({ id: 'bkBad', cover: 'https://x/bad.jpg' }), null);
// no palette at all (main sandbox has no cache) -> house default wax in the card
ok('tint: default wax gradient in modal card when no palette',
  fullHTML.indexOf('candle-fig-wax') !== -1 && fullHTML.indexOf('#e5b86a') !== -1 && fullHTML.indexOf('#9a6224') !== -1);
// extreme luminance palettes are pulled into the wax band
cacheStub.bkW = { hex: '#f7f3ea', cover: 'https://x/w.jpg' };
const tintW = TM.candleTint({ id: 'bkW', cover: 'https://x/w.jpg' });
ok('tint: near-white cover pulled down (base not washed out)', !!tintW && lumOf(tintW.base) <= 0.5);
cacheStub.bkK = { hex: '#07070a', cover: 'https://x/k.jpg' };
const tintK = TM.candleTint({ id: 'bkK', cover: 'https://x/k.jpg' });
ok('tint: near-black cover lifted (top still reads as wax)', !!tintK && lumOf(tintK.top) >= 0.25);
// share card: wax gradient takes the tint; flame stays the constant gold
ccRec.gradients = [];
TM.drawCandleCard(tintBook);
const waxGrad = ccRec.gradients.find(g => g.kind === 'linear');
ok('share: wax gradient uses the tint stops',
  !!waxGrad && JSON.stringify(waxGrad.stops) === JSON.stringify([[0, tint.top], [1, tint.base]]));
const flameGrad = ccRec.gradients.filter(g => g.kind === 'radial').pop();
ok('share: flame gradient unchanged (constant)',
  !!flameGrad && flameGrad.stops.some(s => s[1] === 'rgba(255,244,204,.95)'));
ccRec.gradients = [];
TM.drawCandleCard({ id: 'nope', title: 'Plain', authors: [], cover: 'https://x/c.jpg', tropes: [], tropesAI: [], categories: [], moods: [] });
const waxDef = ccRec.gradients.find(g => g.kind === 'linear');
ok('share: no palette -> house default wax stops',
  !!waxDef && JSON.stringify(waxDef.stops) === JSON.stringify([[0, '#e5b86a'], [1, '#9a6224']]));

console.log('\n' + _pass + ' passed, ' + _fail + ' failed');
process.exit(_fail ? 1 : 0);
