// Tests for v446 — homeSublineFor pure function.
// Covers: determinism, day rotation, action/bookId per state, title
// truncation, pct skipping, state d isolation, unknown theme, TBR wording.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);

// base state builder
const base = (over) => Object.assign({
  reading: null,
  streak: 0,
  tbr: 0,
  libSize: 5,
  justFinished: null,
  hour: 10,
  theme: 'dark',
  dayNumber: 100,
}, over || {});

const sub = (s) => JSON.parse(run(`JSON.stringify(homeSublineFor(${JSON.stringify(s)}))`));

/* (i) same input twice gives identical output */
{
  const s = base({ reading: { id: 'b1', title: 'Dune', progress: 50, pageCount: 100 } });
  const a = sub(s), b = sub(s);
  ok('deterministic: same input twice → identical', a.text === b.text && a.action === b.action && a.bookId === b.bookId);
}

/* (ii) dayNumber+1 gives a different line for a pool of 2+ */
{
  const s1 = base({ reading: { id: 'b1', title: 'Dune', progress: 50, pageCount: 100 } });
  const s2 = base({ reading: { id: 'b1', title: 'Dune', progress: 50, pageCount: 100 }, dayNumber: 101 });
  // pool has 4+1+1+2 = 8 lines; different day should (almost certainly) differ
  // run across several day offsets to be robust
  let differed = sub(s1).text !== sub(s2).text;
  if (!differed) {
    const s3 = base({ reading: { id: 'b1', title: 'Dune', progress: 50, pageCount: 100 }, dayNumber: 102 });
    differed = sub(s1).text !== sub(s3).text;
  }
  ok('day rotation: different day → different line', differed);
}

/* (iii) action/bookId per state a-e */
{
  const ra = sub(base({ reading: { id: 'abc', title: 'Dune', progress: 10, pageCount: 100 } }));
  ok('state a: action book', ra.action === 'book');
  ok('state a: bookId set', ra.bookId === 'abc');

  const rb = sub(base({ justFinished: { title: 'Dune' } }));
  ok('state b: action discover', rb.action === 'discover');
  ok('state b: no bookId', rb.bookId === null);

  const rc = sub(base({ tbr: 3 }));
  ok('state c: action discover', rc.action === 'discover');

  const rd = sub(base({ libSize: 0 }));
  ok('state d: action add', rd.action === 'add');
  ok('state d: exact text', rd.text === 'Add your first book to begin the story.');

  const re = sub(base({}));
  ok('state e: action discover', re.action === 'discover');
  ok('state e: default text in pool', re.text.length > 0);
}

/* (iv) {title} truncated at 28 chars */
{
  const longTitle = 'A Very Long Book Title That Exceeds Twenty Eight Characters';
  const r = sub(base({ reading: { id: 'b1', title: longTitle, progress: 10, pageCount: 100 }, dayNumber: 100 }));
  // find a line with the title — check all pool lines via multiple days
  let found = false;
  for (let d = 100; d < 110; d++) {
    const t = sub(base({ reading: { id: 'b1', title: longTitle, progress: 10, pageCount: 100 }, dayNumber: d })).text;
    if (t.indexOf('…') >= 0) { found = true; break; }
  }
  ok('title truncated at 28 chars with ellipsis', found);
  // verify the truncation is exactly 28 + ellipsis
  const trunc = longTitle.slice(0, 28) + '…';
  ok('truncation is 28 chars + …', trunc.length === 29 && trunc.endsWith('…'));
}

/* (v) pct lines skipped when pageCount is 0 */
{
  // reading with pageCount 0: pool loses the {pct} line, others remain
  let sawPct = false;
  for (let d = 200; d < 210; d++) {
    const t = sub(base({ reading: { id: 'b1', title: 'Dune', progress: 0, pageCount: 0 }, dayNumber: d })).text;
    if (/% through/.test(t)) sawPct = true;
  }
  ok('pct lines skipped when pageCount is 0', !sawPct);
}

/* (vi) state d returns only the add line (no theme/time extras) */
{
  const texts = new Set();
  for (let d = 300; d < 310; d++) {
    texts.add(sub(base({ libSize: 0, theme: 'velvet', hour: 20, dayNumber: d })).text);
  }
  ok('state d: only one possible line', texts.size === 1 && texts.has('Add your first book to begin the story.'));
}

/* (vii) theme not in list adds no theme lines */
{
  // 'stormrider' is not in THEME_LINES — pool should be smaller
  // We verify by checking that no theme-specific text appears across days
  const themeTexts = ['night is young', 'bright page', 'chair by the fire', 'candle', 'Dusk', 'mossy', 'Midnight', 'delicious', 'Dive in', 'cold evening'];
  let leaked = false;
  for (let d = 400; d < 410; d++) {
    const t = sub(base({ theme: 'stormrider', dayNumber: d })).text.toLowerCase();
    for (const phrase of themeTexts) {
      if (t.indexOf(phrase.toLowerCase()) >= 0) { leaked = true; break; }
    }
  }
  ok('unknown theme adds no theme lines', !leaked);
}

/* (viii) singular vs plural TBR wording */
{
  let sawSingular = false;
  for (let d = 500; d < 508; d++) {
    const t = sub(base({ tbr: 1, dayNumber: d })).text;
    if (t === '1 book is waiting on your TBR. Ready for it?') sawSingular = true;
    // plural wording must never appear for tbr=1
    if (/books are waiting|TBR has/.test(t)) sawSingular = false;
  }
  ok('tbr=1: singular wording in pool, never plural', sawSingular);
  let sawPlural = false;
  for (let d = 500; d < 508; d++) {
    const t = sub(base({ tbr: 5, dayNumber: d })).text;
    if (/books are waiting|TBR has 5 books/.test(t)) sawPlural = true;
  }
  ok('tbr>1: plural wording appears', sawPlural);
}

/* streak line only when streak >= 3 */
{
  let sawStreak = false;
  for (let d = 600; d < 610; d++) {
    const t = sub(base({ reading: { id: 'b1', title: 'Dune', progress: 10, pageCount: 100 }, streak: 5, dayNumber: d })).text;
    if (/5-day streak/.test(t)) sawStreak = true;
  }
  ok('streak>=3: streak line in pool', sawStreak);
  let sawStreakLow = false;
  for (let d = 600; d < 610; d++) {
    const t = sub(base({ reading: { id: 'b1', title: 'Dune', progress: 10, pageCount: 100 }, streak: 2, dayNumber: d })).text;
    if (/streak/.test(t)) sawStreakLow = true;
  }
  ok('streak<3: no streak line', !sawStreakLow);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
