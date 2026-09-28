// Tests for v125 — glanceable book cards (UI Improvement Pass, section 4).
//
// Covered: book cards show a favorite heart overlay on the cover when the
// book is a favorite (and none when it isn't); tiles carry a status-colored
// strip along the cover's bottom edge; currently-reading tiles show the
// progress fill inside that strip; the strip keeps the status name as a
// title for accessibility.

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

const mk = (over) => Object.assign(
  { id: 'x', title: 'T', authors: ['A'], status: 'tbr', cover: '',
    tropes: [], genres: [], myRating: 0, ratings: {}, axes: [],
    favorite: false, progress: 0, pageCount: 0 }, over);

const favCard = run(`bookCard(${JSON.stringify(mk({ favorite: true }))}, 0)`);
const plainCard = run(`bookCard(${JSON.stringify(mk({}))}, 0)`);
ok('card: favorite heart overlay present', /class="card-fav"/.test(favCard));
ok('card: no heart overlay when not favorite', !/card-fav/.test(plainCard));

const tileTbr = run(`bookTile(${JSON.stringify(mk({ status: 'tbr' }))}, 0)`);
const tileRead = run(`bookTile(${JSON.stringify(mk({ status: 'read' }))}, 0)`);
ok('tile: tbr status strip', /bt-statusbar status-tbr/.test(tileTbr));
ok('tile: read status strip', /bt-statusbar status-read/.test(tileRead));
ok('tile: strip carries the status name', /title="TBR"/.test(tileTbr) || /title="To Be Read"/.test(tileTbr));

const tileProg = run(`bookTile(${JSON.stringify(mk({ status: 'reading', progress: 50, pageCount: 200 }))}, 0)`);
ok('tile: reading strip shows progress fill', /bt-fill" style="width:25%"/.test(tileProg));
ok('tile: favorite heart on tile too',
  /card-fav/.test(run(`bookTile(${JSON.stringify(mk({ favorite: true }))}, 0)`)));

// v188: read badge — gold seal on finished books' tiles only
ok('tile: read seal on read tile', /class="tile-read"/.test(tileRead));
ok('tile: no read seal on tbr tile', !/tile-read/.test(tileTbr));
ok('tile: no read seal on reading tile', !/tile-read/.test(tileProg));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
