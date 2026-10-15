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
const ROOT = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';

function loadJS(rel, extra) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

console.log('\n' + _pass + ' passed, ' + _fail + ' failed');
process.exit(_fail ? 1 : 0);
