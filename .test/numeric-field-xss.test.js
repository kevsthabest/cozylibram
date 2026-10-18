// Tests for the #355 fix — stored XSS via 'numeric' book fields.
//
// Book records are free-form JSON: pageCount, progress and ratingsCount are
// interpolated into innerHTML raw by several renderers, so a string value in
// any of them renders as markup — including in a Circle friend's session,
// because friend libraries cross the trust boundary as raw books.data.
// migrateBook (js/020) is the choke point every one of those paths passes
// through (cloud merge, imports, friend libraries, reco copies), and it
// already neutralizes id/status there (v194). These tests pin the same
// treatment for the three numeric fields: a value that is not a finite
// number in range normalizes to absent; a numeric string coerces to the
// number it names (imports carry those), so legitimate data survives.

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

const PAYLOAD = '<img src=x onerror=alert(1)>';

/* ---- 1. migrateBook: payload strings in numeric fields do not survive ---- */

for (const field of ['pageCount', 'progress', 'ratingsCount']) {
  const b = run(`migrateBook({ id: 'victim1', status: 'reading', ${field}: ${JSON.stringify(PAYLOAD)} })`);
  ok('xss355: payload in ' + field + ' is not a string after migrate',
    typeof b[field] !== 'string');
  ok('xss355: payload in ' + field + ' leaves no markup behind',
    b[field] === undefined || (typeof b[field] === 'number' && isFinite(b[field])));
}

const allBad = run(`migrateBook({ id: 'victim2', status: 'reading',
  pageCount: ${JSON.stringify(PAYLOAD)}, progress: ${JSON.stringify(PAYLOAD)},
  ratingsCount: ${JSON.stringify(PAYLOAD)} })`);
ok('xss355: combined payload record carries no payload text anywhere',
  !JSON.stringify(allBad).includes('onerror'));

/* ---- 2. migrateBook: out-of-range numbers normalize to absent ---- */

ok('xss355: negative pageCount dropped',
  run(`migrateBook({ id: 'n1', pageCount: -12 }).pageCount`) === undefined);
ok('xss355: zero pageCount dropped (unknown is absent, as with audioSecs)',
  run(`migrateBook({ id: 'n2', pageCount: 0 }).pageCount`) === undefined);
ok('xss355: NaN pageCount dropped',
  run(`migrateBook({ id: 'n3', pageCount: NaN }).pageCount`) === undefined);
ok('xss355: infinite pageCount dropped',
  run(`migrateBook({ id: 'n4', pageCount: Infinity }).pageCount`) === undefined);
ok('xss355: negative progress dropped',
  run(`migrateBook({ id: 'n5', progress: -3 }).progress`) === undefined);
ok('xss355: negative ratingsCount dropped',
  run(`migrateBook({ id: 'n6', ratingsCount: -1 }).ratingsCount`) === undefined);
ok('xss355: object pageCount dropped',
  run(`migrateBook({ id: 'n7', pageCount: { pages: 12 } }).pageCount`) === undefined);

/* ---- 3. migrateBook: legitimate values survive, typed ---- */

const legit = run(`migrateBook({ id: 'ok1', status: 'reading', pageCount: 416, progress: 120, ratingsCount: 1234 })`);
ok('xss355: numeric pageCount preserved', legit.pageCount === 416);
ok('xss355: numeric progress preserved', legit.progress === 120);
ok('xss355: numeric ratingsCount preserved', legit.ratingsCount === 1234);

const imported = run(`migrateBook({ id: 'ok2', status: 'reading', pageCount: '416', progress: '120', ratingsCount: '1234' })`);
ok('xss355: numeric-string pageCount coerces to the number', imported.pageCount === 416);
ok('xss355: numeric-string progress coerces to the number', imported.progress === 120);
ok('xss355: numeric-string ratingsCount coerces to the number', imported.ratingsCount === 1234);

ok('xss355: zero ratingsCount is a real count and is kept',
  run(`migrateBook({ id: 'ok3', ratingsCount: 0 }).ratingsCount`) === 0);
ok('xss355: zero progress is a real position and is kept',
  run(`migrateBook({ id: 'ok4', progress: 0 }).progress`) === 0);
ok('xss355: fractional progress (percent logging) preserved',
  run(`migrateBook({ id: 'ok5', progressUnit: 'pct', progress: 45.5 }).progress`) === 45.5);
ok('xss355: fractional pageCount rounds to whole pages',
  run(`migrateBook({ id: 'ok6', pageCount: 416.4 }).pageCount`) === 416);

/* ---- 4. end-to-end: the demonstrated grid sink (friend shelf -> bookCard) ---- */

// Mirrors js/195 circleFriendBooks: a friend's books.data rows pass through
// migrateBook only, then renderCovenFriendMain renders them with bookCard.
// Composition note (probed on the pre-fix tree): the card's progress line
// renders only when progressPctOf is non-null, which a payload pageCount
// suppresses (the string fails its `> 0` gate) — so the grid sink fires
// through progress, with a legitimate pageCount beside it. pageCount's own
// raw sinks are the preview/detail/editions surfaces (js/150, js/138), whose
// records reach them through this same choke point; the field-level pins
// above cover those.
const friendRow = { id: 'friendbook1', title: 'Shared Shelf Book', authors: ['Mallory'],
  status: 'reading', cover: '', tropes: [], genres: [], ratings: {}, axes: [],
  pageCount: 300, progress: PAYLOAD, ratingsCount: PAYLOAD };
const migratedFriend = run(`migrateBook(${JSON.stringify(friendRow)})`);
const cardHTML = run(`bookCard(${JSON.stringify(migratedFriend)}, 0)`);
ok('xss355: bookCard of a migrated payload record contains no onerror',
  !cardHTML.includes('onerror'));
const holder = window.document.createElement('div');
holder.innerHTML = cardHTML;
ok('xss355: parsed card has no element carrying an onerror handler',
  holder.querySelector('[onerror]') === null);
ok('xss355: parsed card has no injected img element',
  holder.querySelector('img[src="x"]') === null);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
