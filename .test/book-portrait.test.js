// Tests for v468/v469 — Book Portrait v1.
// Pure-logic units: completeness scoring, local trope merging, survey guards.
'use strict';

// ---- minimal harness (matches repo test style) ----
let _pass = 0, _fail = 0;
function ok(name, cond) {
  if (cond) { _pass++; }
  else { _fail++; console.log('FAIL - ' + name); }
}
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

// ---- load modules in a sandbox ----
const fs = require('fs');
const vm = require('vm');
const { classicize } = require('./harness');
function loadJS(path, extra) {
  // R3 repoint (migration plan §9.3): js/225 is a real ES module since
  // phase 2 batch 4. classicize restores the classic body before
  // evaluation (identity on classic files). Loading plumbing only —
  // assertions untouched.
  const src = classicize(fs.readFileSync(path, 'utf8'), path);
  const sandbox = {
    console: console,
    document: undefined,
    window: {},
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } },
    module: { exports: {} },
  };
  Object.assign(sandbox, extra || {});
  // stub globals the modules touch at load time
  sandbox.window = sandbox.window || {};
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { filename: path }); } catch (e) { /* document-dependent parts may throw */ }
  return sandbox;
}

// portraitScore is exported via module.exports in 225
const p225 = loadJS('/home/hatch/workspace/booktok/js/225-book-portrait.js', {
  esc: s => String(s), icon: () => '',
  bookGenres: () => ['romantasy'],
  library: [],
});
const portraitScore = (p225.module.exports && p225.module.exports.portraitScore) ||
  (p225.window && p225.window.portraitScore);
const localTropes = (p225.module.exports && p225.module.exports.localTropes) ||
  (p225.window && p225.window.portraitLocalTropes);
const warningsState = (p225.module.exports && p225.module.exports.warningsState) ||
  (p225.window && p225.window.warningsState);

ok('portraitScore exported', typeof portraitScore === 'function');
ok('warningsState exported', typeof warningsState === 'function');

// v473: warningsState — three cases (Part 2, item 5)
eq('warningsState: has warnings', warningsState(['violence'], {}), 'has-warnings');
eq('warningsState: reviewed, none -> none-confirmed', warningsState([], { warningsReviewed: true }), 'none-confirmed');
eq('warningsState: not reviewed', warningsState([], {}), 'unreviewed');
eq('warningsState: null warns', warningsState(null, {}), 'unreviewed');

// empty book → 0 (genre stub returns romantasy though; override via book without stub)
const p225b = loadJS('/home/hatch/workspace/booktok/js/225-book-portrait.js', {
  esc: s => String(s), icon: () => '', bookGenres: () => [], library: [],
});
const score0 = p225b.module.exports.portraitScore({}, 0);
eq('empty book scores 0', score0, 0);

// full book → 100
const full = {
  tropes: ['enemies to lovers'], tropesAI: ['slow burn'],
  contentWarnings: ['violence'], ratings: { spice: 3 }, moods: ['dark'], id: 'x1',
};
eq('full book scores 100', p225b.module.exports.portraitScore(full, 5), 100);

// tropes only → 30 (+10 genre stub? no — p225b stub returns [])
eq('tropes only scores 30', p225b.module.exports.portraitScore({ tropes: ['x'] }, 0), 30);

// warningsReviewed counts as warnings mapped → 25
eq('warningsReviewed scores 25', p225b.module.exports.portraitScore({ warningsReviewed: true }, 0), 25);

// spice only → 10
eq('spice only scores 10', p225b.module.exports.portraitScore({ ratings: { spice: 2 } }, 0), 10);

// localTropes: user first, AI deduped
const lt = p225b.module.exports.localTropes({ tropes: ['Enemies to Lovers'], tropesAI: ['enemies to lovers', 'forced proximity'] });
eq('localTropes dedupes case-insensitively', lt.length, 2);
eq('localTropes user first', lt[0].source, 'you');
eq('localTropes AI second', lt[1].source, 'auto');

// ---- survey guards (226) ----
const p226 = loadJS('/home/hatch/workspace/booktok/js/226-dna-survey.js', {
  esc: s => String(s), toast: () => {}, saveLibrary: () => {},
});
const eligible = (p226.module.exports && p226.module.exports.dnaSurveyEligible) ||
  (p226.window && p226.window.dnaSurveyEligible);
ok('dnaSurveyEligible exported', typeof eligible === 'function');

const readBook = { id: 'b1', status: 'read', tropes: [], contentWarnings: [] };
ok('eligible: fresh read book', eligible(readBook) === true);
ok('not eligible: tbr book', eligible({ status: 'tbr' }) === false);
ok('not eligible: seen', eligible(Object.assign({ dnaSurveySeen: true }, readBook)) === false);
ok('not eligible: never', eligible(Object.assign({ dnaSurveyNever: true }, readBook)) === false);
// NOTE: the >=90% guard can't fire synchronously — char count is async, so
// sync scoring caps at 75 (30+25+10+10). A rich-but-charless book stays
// eligible, which is correct: the survey's character section is valuable.

// completeness >= 90 guard: tropes(30) + warnings(25) + chars(25, passed as arg? no — eligible uses portraitScore(b,0))
// eligible() calls portraitScore(b, 0) → chars unknown → max 75. So the 90 guard needs a rich book;
// verify a rich-but-charless book is still eligible (chars async, can't know)
const richNoChars = { id: 'b2', status: 'read', tropes: ['a'], contentWarnings: ['b'], ratings: { spice: 1 }, moods: ['x'] };
ok('eligible: rich but charless (chars unknown sync)', eligible(richNoChars) === true);

// global off
p226.localStorage.setItem('cozylibram.dnaSurveyOff', '1');
ok('not eligible: global off', eligible(readBook) === false);
p226.localStorage.setItem('cozylibram.dnaSurveyOff', '0');

// re-read with prior survey + thin portrait → eligible
ok('eligible: re-read thin portrait', eligible(Object.assign({ readCount: 2, dnaSurveyCompletedOnce: true }, readBook)) === true);

// ---- v547: portraitEnhance — decided merge precedence + async char path ----
// Precedence (User's call, 2026-10-14): community-accepted first, pipeline
// second, user's own third; the first source to claim a trope owns its slot
// AND its provenance label. Drives the real portraitEnhance through its
// window export with cloud / CharacterStore / document stubbed.
const ROOT547 = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
function jeq(name, a, b) {
  ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')',
    JSON.stringify(a) === JSON.stringify(b));
}

function runEnhance547(book, opts) {
  opts = opts || {};
  const els = {};
  ['portraitCard', 'ptChars', 'ptTropes', 'ptPct', 'ptWarns'].forEach(function (id) {
    els[id] = { innerHTML: '', textContent: '', dataset: {}, isConnected: true };
  });
  els.portraitCard.dataset.book = book.id || '';
  const taxNames = opts.taxNames || {};
  const sb = {
    from: function () {
      return { select: function () { return { eq: function () { return { eq: function () {
        return Promise.resolve({ data: opts.communityRows || [] });
      } }; } }; } };
    },
  };
  const sbx = loadJS(ROOT547 + '/js/225-book-portrait.js', {
    esc: s => String(s == null ? '' : s), icon: () => '', bookGenres: () => [],
    library: [book],
    document: {
      getElementById: id => els[id] || null,
      addEventListener: () => {},
      querySelector: () => null,
    },
    cloudClient: async () => sb,
    bookKeyFor: b => 'key-' + (b.id || ''),
    TropeTaxonomy: {
      byId: id => (taxNames[id] ? { name: taxNames[id] } : null),
      resolveId: name => {
        for (const k in taxNames) if (taxNames[k] === name) return k;
        return undefined;
      },
    },
    resolveWork: async b => 'w-' + (b.id || ''),
    CharacterStore: { listForWork: async wid => (opts.charRows || {})[wid] || [] },
  });
  return sbx.window.portraitEnhance(book).then(() => ({ card: els.portraitCard, els }));
}

(async function () {
  // -- merge precedence: overlaps across all three sources --
  // 'Shared Trope': community + user (case variant). 'Dual Source':
  // pipeline + user (case variant). Community rows include a duplicate.
  const book1 = {
    id: 'pm1', status: 'read',
    tropes: ['shared trope', 'dual source', 'User Only'],
    tropesAI: ['Dual Source', 'Pipeline Pick'],
  };
  const r1 = await runEnhance547(book1, {
    communityRows: [{ trope_id: 't-shared' }, { trope_id: 't-gem' }, { trope_id: 't-gem' }],
    taxNames: { 't-shared': 'Shared Trope', 't-gem': 'Community Gem' },
  });
  const merged = r1.card._ptTropes || [];
  jeq('merge: exact order (community -> pipeline -> user)',
    merged.map(t => t.name),
    ['Shared Trope', 'Community Gem', 'Dual Source', 'Pipeline Pick', 'User Only']);
  jeq('merge: provenance follows precedence',
    merged.map(t => t.source),
    ['community', 'community', 'auto', 'auto', 'you']);
  eq('merge: deduped to 5', merged.length, 5);

  // -- async character path: 0 characters --
  const bookC0 = { id: 'pc0', status: 'read', tropes: ['x'], tropesAI: [] };
  const r0 = await runEnhance547(bookC0, { charRows: { 'w-pc0': [] } });
  ok('chars 0: invite shown', r0.els.ptChars.innerHTML.indexOf('No characters recorded') !== -1);
  eq('chars 0: _ptChars.count', r0.card._ptChars.count, 0);
  eq('chars 0: pct gets no char credit', r0.els.ptPct.textContent, '30% mapped');

  // -- async character path: 2 characters, role weight orders the top --
  const bookC2 = { id: 'pc2', status: 'read', tropes: ['x'], tropesAI: [] };
  const r2 = await runEnhance547(bookC2, { charRows: { 'w-pc2': [
    { name: 'Ana', role: 'supporting' }, { name: 'Zed', role: 'protagonist' },
  ] } });
  eq('chars 2: count', r2.card._ptChars.count, 2);
  jeq('chars 2: top by role weight', r2.card._ptChars.top.map(c => c.name), ['Zed', 'Ana']);
  ok('chars 2: chips rendered, no overflow', r2.els.ptChars.innerHTML.indexOf('Zed') !== -1 &&
    !/>\+\d</.test(r2.els.ptChars.innerHTML));
  eq('chars 2: pct gets +25 char credit', r2.els.ptPct.textContent, '55% mapped');

  // -- async character path: 5 characters, +N overflow --
  const bookC5 = { id: 'pc5', status: 'read', tropes: ['x'], tropesAI: [] };
  const r5 = await runEnhance547(bookC5, { charRows: { 'w-pc5': [
    { name: 'M1', role: 'minor' }, { name: 'P1', role: 'protagonist' },
    { name: 'S1', role: 'supporting' }, { name: 'M2', role: 'minor' },
    { name: 'S2', role: 'supporting' },
  ] } });
  eq('chars 5: count', r5.card._ptChars.count, 5);
  jeq('chars 5: top 2 by role weight', r5.card._ptChars.top.map(c => c.name), ['P1', 'S1']);
  ok('chars 5: overflow +3 chip', r5.els.ptChars.innerHTML.indexOf('+3') !== -1);
  eq('chars 5: pct gets +25 char credit', r5.els.ptPct.textContent, '55% mapped');
})().then(function () {
  console.log('\n' + _pass + ' passed, ' + _fail + ' failed');
  process.exit(_fail ? 1 : 0);
}, function (e) {
  console.log('FAIL - v547 async section threw: ' + (e && e.stack || e));
  console.log('\n' + _pass + ' passed, ' + (_fail + 1) + ' failed');
  process.exit(1);
});
