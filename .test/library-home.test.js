// Tests for v122 — Library as home (UI Improvement Pass, section 1).
//
// Covered: the unfiltered Library view leads with Currently Reading (hero
// cards with progress + continue), then Up Next, Can't Decide (roulette),
// shelf tiles with counts; the empty-reading state answers "what now?";
// home sections hide when filtering/searching; nothing from the old library
// view was removed.

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
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));

function seed() {
  run(`library = [
    { id: 'r1', title: 'Reading One', authors: ['A One'], status: 'reading', progress: 70, pageCount: 100, cover: '', tropes: [], genres: [] },
    { id: 't1', title: 'TBR One', authors: ['B Two'], status: 'tbr', tropes: [], genres: [] },
    { id: 't2', title: 'TBR Two', authors: ['C Three'], status: 'tbr', tropes: [], genres: [] },
    { id: 'd1', title: 'Read One', authors: ['D Four'], status: 'read', tropes: [], genres: [] }
  ]; filter = 'all'; ownFilter = 'all'; query = ''; view = 'library';`);
}

// --- 1. Home hierarchy on the unfiltered view ---
seed();
run('renderLibrary()');
const html1 = q('#view').innerHTML;
ok('home: currently reading section leads', html1.indexOf('Currently Reading') !== -1);
ok('home: hero shows progress + percentage', (() => {
  const h = q('.reading-hero');
  return h && h.textContent.includes('70%') && h.textContent.includes('Reading One');
})());
ok('home: hero shows author', q('.reading-hero').textContent.includes('A One'));
ok('home: can\'t decide strip present', !!q('#cd-pick'));
ok('home: can\'t decide mentions the TBR count', q('#cd-pick').textContent.includes('2 waiting'));
const tiles = {};
qa('.shelf-tile').forEach(t => { tiles[t.dataset.shelf] = t.querySelector('b').textContent; });
ok('home: shelf tiles show live counts',
  tiles.tbr === '2' && tiles.reading === '1' && tiles.read === '1' && tiles.dnf === '0');
ok('home: hierarchy order (reading -> up next -> decide -> tiles -> browser)',
  html1.indexOf('Currently Reading') < html1.indexOf('Up Next') &&
  html1.indexOf('Up Next') < html1.indexOf('Can\u2019t decide?') &&
  html1.indexOf('Can\u2019t decide?') < html1.indexOf('Your Library') &&
  html1.indexOf('Your Library') < html1.indexOf('id="q"'));
ok('home: full browser still present (search + shelf chips)',
  !!q('#q') && qa('.chip:not([data-of])').length >= 5);

// --- 2. Home actions navigate ---
q('#cd-pick').click();
ok('home: can\'t decide opens roulette', run('view') === 'pick');
seed(); run('renderLibrary()');
q('.shelf-tile[data-shelf="tbr"]').click();
ok('home: shelf tile filters to that shelf', run('filter') === 'tbr');

// --- 3. Empty-reading state answers "what now?" ---
run(`library = [
  { id: 't1', title: 'TBR One', authors: ['B Two'], status: 'tbr', tropes: [], genres: [] }
]; filter = 'all'; ownFilter = 'all'; query = ''; view = 'library'; renderLibrary();`);
ok('home: empty reading explains next steps',
  q('.home-empty').textContent.includes('Nothing you\u2019re reading right now'));
q('#he-tbr').click();
ok('home: Browse TBR filters to tbr', run('filter') === 'tbr');
run(`filter = 'all'; renderLibrary();`);
q('#he-disc').click();
ok('home: Discover something opens discover', run('view') === 'discover');

// --- 4. Home sections hide when filtering / searching ---
seed();
run(`filter = 'tbr'; renderLibrary();`);
ok('home: sections hidden when a shelf filter is active', !q('.home-sec'));
run(`filter = 'all'; query = 'one'; renderLibrary();`);
ok('home: sections hidden while searching', !q('.home-sec'));
run(`query = ''; renderLibrary();`);
ok('home: sections return on the unfiltered view', !!q('.home-sec'));

// --- 5. Empty library keeps the original empty state ---
run(`library = []; filter = 'all'; ownFilter = 'all'; query = ''; view = 'library'; renderLibrary();`);
ok('home: empty library shows the add-first-book state',
  q('#view .empty').textContent.includes('No books here yet') && !q('.home-sec'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
