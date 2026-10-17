// v564: Blind Date with a Book — a wrapped mode inside Surprise Me
// (js/160 roulette). Spec: docs/blind-date-spec.md.
//
// Pinned here:
//  - the blind pool is the reader's TBR only (via the untouched
//    pickCandidates), minus this session's passes;
//  - the wrapped card leaks NOTHING identifying: no title, author,
//    cover URL, description, or series anywhere in its HTML;
//  - clues come only from existing fields (tropes with pipeline-first
//    precedence, spice as displayed elsewhere, page count, genre);
//  - a first line renders ONLY when the record carries one verbatim —
//    description and saved quotes are never substituted for it;
//  - Pass writes nothing to the book (presentational state only) and
//    the passed book leaves the session pool; exhausting the pool
//    resets the passes;
//  - Unwrap reveals without a status change; Start reading unwraps
//    and marks the book reading through the existing flow;
//  - the mode toggle lives in the roulette view, and Discover's stage
//    carries a secondary "blind date" action (not a tile).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in blind-date tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

const BD1 = {
  id: 'bd1', title: 'Zephyr Title One', authors: ['Secret Author'],
  cover: 'https://covers.example/zephyr.jpg',
  description: 'A zephyr description that must never leak.',
  series: { name: 'Zephyr Saga', index: 1 },
  status: 'tbr', pageCount: 416, categories: ['Fiction / Fantasy / Epic'],
  tropesAI: ['Dragons'], tropes: ['Enemies to Lovers', 'Found Family', 'Slow Burn'],
  ratings: { spice: 4 }, axes: ['spice'],
};
const BD2 = {
  id: 'bd2', title: 'Second Secret', authors: ['Hidden Writer'], status: 'tbr',
  firstLine: 'The lighthouse blinked twice before it went dark.',
};
const BD5 = {
  id: 'bd5', title: 'Quoted Book', authors: ['Some One'], status: 'tbr',
  description: 'A synopsis opening that is not a first line.',
  quotes: [{ t: 'A reader-saved quote line.', p: 12, at: 1 }],
};
const READ1 = { id: 'bdr', title: 'Already Read', authors: ['A'], status: 'read', tropes: ['Dragons'] };
const READING1 = { id: 'bdg', title: 'In Progress', authors: ['A'], status: 'reading', tropes: [] };

(async () => {
  run('library = ' + JSON.stringify([BD1, BD2, BD5, READ1, READING1]) + ';');
  run('pickState = { genres: [], trope: "", minIntensity: 0, upNextOnly: false };');
  run('setBlindDate(true);');

  /* ---- 1. pool is TBR-only ---- */
  const poolIds = run('blindPool().map(b => b.id)');
  ok('pool contains only TBR books', JSON.stringify(poolIds.slice().sort()) === JSON.stringify(['bd1', 'bd2', 'bd5']));
  ok('read book never in the blind pool', !poolIds.includes('bdr'));
  ok('currently-reading book never in the blind pool', !poolIds.includes('bdg'));

  /* ---- 2. wrapped card leaks nothing ---- */
  const w1 = run('blindDateHTML(library.find(b => b.id === "bd1"))');
  ok('wrapped card is produced', typeof w1 === 'string' && w1.indexOf('bd-wrapped') !== -1);
  ok('no title in wrapped card', w1.indexOf('Zephyr Title One') === -1);
  ok('no author in wrapped card', w1.indexOf('Secret Author') === -1);
  ok('no cover URL in wrapped card', w1.indexOf('covers.example') === -1 && w1.indexOf('<img') === -1);
  ok('no description in wrapped card', w1.indexOf('zephyr description') === -1);
  ok('no series name in wrapped card', w1.indexOf('Zephyr Saga') === -1);

  /* ---- 3. clues from existing fields only ---- */
  const chipNames = run('blindDateClues(library.find(b => b.id === "bd1")).tropes');
  ok('clue tropes: pipeline first, then reader tropes, capped at 3',
    JSON.stringify(chipNames) === JSON.stringify(['Dragons', 'Enemies to Lovers', 'Found Family']));
  ok('clue tropes render as chips', (w1.match(/bd-chip/g) || []).length === 3);
  ok('page count clue renders when present', w1.indexOf('416 pages') !== -1);
  ok('genre clue renders', w1.indexOf('Fantasy') !== -1);
  ok('spice clue renders as the app displays it (badge)', w1.indexOf('badge spice') !== -1);
  const sparse = run('blindDateHTML(library.find(b => b.id === "bd2"))');
  ok('no page-count clue when the book has none', sparse.indexOf('pages') === -1);
  ok('no trope chips when the book has none', sparse.indexOf('bd-chip') === -1);

  /* ---- 4. first line: verbatim or absent, never fabricated ---- */
  ok('first line renders verbatim when the record carries one',
    sparse.indexOf('The lighthouse blinked twice before it went dark.') !== -1 && sparse.indexOf('bd-firstline') !== -1);
  const w5 = run('blindDateHTML(library.find(b => b.id === "bd5"))');
  ok('no first-line block when the record lacks one', w5.indexOf('bd-firstline') === -1);
  ok('description is never passed off as a first line', w5.indexOf('synopsis opening') === -1);
  ok('a saved quote is never passed off as a first line', w5.indexOf('reader-saved quote') === -1);
  ok('clue builder reports firstLine null when absent',
    run('blindDateClues(library.find(b => b.id === "bd5")).firstLine') === null);

  /* ---- 5. mode toggle + wrapped spin in the roulette view ---- */
  run('renderPick();');
  await tick(3);
  ok('roulette view carries the mode toggle', !!q('[data-bdmode="blind"]') && !!q('[data-bdmode="open"]'));
  ok('blind mode is active after setBlindDate(true)', q('[data-bdmode="blind"]').classList.contains('active'));
  const prevHTML = q('#pk-preview') ? q('#pk-preview').innerHTML : '';
  ok('candidate preview strip leaks nothing in blind mode',
    prevHTML.indexOf('<img') === -1 && prevHTML.indexOf('Zephyr') === -1 && prevHTML.indexOf('Second Secret') === -1);
  ok('spin button invites a blind date in blind mode', q('#pk-spin').textContent.indexOf('Blind date') !== -1 || q('#pk-spin').textContent.indexOf('blind date') !== -1);

  /* ---- 6. pass: no writes, leaves the pool, pool resets when spent ---- */
  run('library = ' + JSON.stringify([BD2]) + ';');
  const before = run('JSON.stringify(library)');
  run('renderPick();');
  await tick(2);
  q('#pk-spin').click();
  await tick(2);
  ok('spin deals a wrapped card', !!q('.bd-wrapped') && !!q('#bd-pass'));
  ok('dealt card is the wrapped fixture, still hidden', q('#roulette-result').innerHTML.indexOf('Second Secret') === -1);
  q('#bd-pass').click();
  await tick(2);
  ok('passing writes nothing to any book', run('JSON.stringify(library)') === before);
  ok('after passing the only book, a fresh wrap is dealt (passes reset)',
    !!q('.bd-wrapped'));

  /* ---- 7. pass excludes the book while others remain ---- */
  run('blindPassed = {};');
  run('library = ' + JSON.stringify([BD1, BD2]) + ';');
  run('blindPassed["bd1"] = true;');
  const pool2 = run('blindPool().map(b => b.id)');
  ok('passed book leaves the session pool', JSON.stringify(pool2) === JSON.stringify(['bd2']));
  ok('passed book stays on the TBR untouched',
    run('library.find(b => b.id === "bd1").status') === 'tbr');

  /* ---- 8. unwrap reveals, status untouched ---- */
  run('blindPassed = {};');
  run('library = ' + JSON.stringify([BD1]) + ';');
  run('renderPick();');
  await tick(2);
  q('#pk-spin').click();
  await tick(2);
  q('#bd-unwrap').click();
  await tick(2);
  const resHTML = q('#roulette-result').innerHTML;
  ok('unwrap reveals the title', resHTML.indexOf('Zephyr Title One') !== -1);
  ok('unwrap leaves the status alone', run('library[0].status') === 'tbr');

  /* ---- 9. start reading from wrapped: unwraps + marks reading ---- */
  q('#pk-spin').click();
  await tick(2);
  ok('a fresh wrapped card is dealt for the start test', !!q('#bd-start'));
  q('#bd-start').click();
  await tick(4);
  ok('start reading marks the book reading', run('library[0].status') === 'reading');

  /* ---- 10. Discover stage secondary action ---- */
  run('library = ' + JSON.stringify([BD1, BD2]) + ';');
  run('setBlindDate(false);');
  run('renderDiscover();');
  await tick(3);
  ok('Discover stage carries a blind-date secondary action', !!q('#disc-blind-date'));
  ok('it is not a doorway tile', !q('[data-dtile="blind"]'));
  q('#disc-blind-date').click();
  await tick(3);
  ok('the action lands on the roulette in blind mode',
    !!q('[data-bdmode="blind"]') && q('[data-bdmode="blind"]').classList.contains('active'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
