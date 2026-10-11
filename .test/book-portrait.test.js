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
function loadJS(path, extra) {
  const src = fs.readFileSync(path, 'utf8');
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

ok('portraitScore exported', typeof portraitScore === 'function');

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

console.log('\n' + _pass + ' passed, ' + _fail + ' failed');
process.exit(_fail ? 1 : 0);
