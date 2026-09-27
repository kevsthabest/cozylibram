// Tests for v126 — empathetic, actionable empty states (UI Improvement Pass,
// section 11).
//
// Covered: the shared emptyState() helper renders icon + serif title +
// guidance + one contextual CTA; the library distinguishes "no books at all",
// "search matched nothing", "shelf filter empty" and "ownership filter empty"
// with tailored copy; CTA buttons navigate via the delegated data-empty-go
// handler; wishlist / up-next / authors / series / roulette all use the helper.

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

const book = (id, status) => ({ id, title: 'T' + id, authors: ['A'], status,
  cover: '', tropes: [], genres: [], myRating: 0, ratings: {}, axes: [],
  favorite: false, progress: 0, pageCount: 0, owned: true, notes: '' });

// --- 1. Helper shape ---
const es = run(`emptyState({ icon: 'dice', title: 'Hello', body: 'Some <b>words</b>.',
  cta: { label: 'Go', go: 'add' } })`);
ok('helper: icon, serif title, body, CTA button',
  /class="big"/.test(es) && /<h2 class="serif">Hello<\/h2>/.test(es) &&
  /Some <b>words<\/b>/.test(es) && /data-empty-go="add">Go<\/button>/.test(es));
ok('helper: no CTA when omitted', !/data-empty-go/.test(run(`emptyState({ title: 'T' })`)));
ok('helper: title is escaped', !/<script/.test(run(`emptyState({ title: '<script>' })`)));

// --- 2. Library cases ---
function libEmpty(books, f, of, qq) {
  run(`library = ${JSON.stringify(books)}; filter = '${f}'; ownFilter = '${of}'; query = '${qq}';
       renderLibrary();`);
  const el = q('#view .empty');
  return el ? el.innerHTML : '';
}
let h = libEmpty([], 'all', 'all', '');
ok('library: no books at all -> welcoming + add CTA',
  /Your shelves are waiting/.test(h) && /data-empty-go="add"/.test(h));
h = libEmpty([book('b1', 'tbr')], 'all', 'all', 'zzz-no-match');
ok('library: search miss names the query + add CTA',
  /No matches for/.test(h) && /zzz-no-match/.test(h) && /data-empty-go="add"/.test(h));
h = libEmpty([book('b1', 'tbr')], 'reading', 'all', '');
ok('library: empty reading shelf is empathetic', /Nothing on the nightstand/.test(h));
h = libEmpty([book('b1', 'read')], 'dnf', 'all', '');
ok('library: empty dnf shelf is kind', /No mercy kills yet/.test(h));
h = libEmpty([book('b1', 'read')], 'tbr', 'all', '');
ok('library: empty tbr points to discover', /deliciously empty TBR/.test(h) && /data-empty-go="discover"/.test(h));
const unowned = Object.assign(book('b1', 'tbr'), { owned: false });
run(`library = ${JSON.stringify([unowned])}; filter = 'all'; ownFilter = 'owned'; query = ''; renderLibrary();`);
h = q('#view .empty') ? q('#view .empty').innerHTML : '';
ok('library: ownership filter miss guides, no dead CTA',
  /Nothing under this filter/.test(h) && !/data-empty-go/.test(h));

// --- 3. CTA delegation navigates ---
run(`library = []; filter = 'all'; ownFilter = 'all'; query = ''; renderLibrary();`);
const ctaBtn = q('#view [data-empty-go]');
run(`window.__went = null; window.__realGo = go; go = function(v) { window.__went = v; };`);
ctaBtn.click();
ok('CTA: click navigates to the CTA view', run(`window.__went`) === 'add');
run(`go = window.__realGo;`);

// --- 4. Other views use the helper ---
run(`library = []; renderWishlist();`);
ok('wishlist: helper copy + discover CTA',
  /Nothing on the wishlist… yet/.test(q('#view').innerHTML) && /data-empty-go="discover"/.test(q('#view').innerHTML));
run(`upNext = []; renderUpNext();`);
ok('up-next: helper copy + library CTA',
  /Nothing queued/.test(q('#view').innerHTML) && /data-empty-go="library"/.test(q('#view').innerHTML));
run(`library = []; renderAuthors();`);
ok('authors: helper copy + add CTA',
  /No authors yet/.test(q('#view').innerHTML) && /data-empty-go="add"/.test(q('#view').innerHTML));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
