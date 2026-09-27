// Phase-2 stats tests (v65): reading profile, rating distribution,
// calculated reading patterns, and their empty states.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in patterns tests'); };

require('./harness').loadApp(window);

// v128: these tests exercise the stats explorer, which now lives behind
// the dashboard - opt into detail mode.
window.eval(`statsMode = 'detail';`);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.toISOString(); };

runInWindow(`localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  const M = (id, title, extra) => Object.assign({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: 'read', ratings: {}, axes: [], myRating: 0, tropes: [],
    progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '' }, extra);
  library.push(M('s1', 'Spicy One',   { categories: ['Fiction / Romance'], ratings: { spice: 5 }, myRating: 5, pageCount: 400, tropes: ['Enemies to Lovers'], dateFinished: '${isoDaysAgo(10)}' }));
  library.push(M('s2', 'Spicy Two',   { categories: ['Fiction / Romance'], ratings: { spice: 5 }, myRating: 5, pageCount: 420, tropes: ['Enemies to Lovers'], dateFinished: '${isoDaysAgo(20)}' }));
  library.push(M('s3', 'Spicy Three', { categories: ['Fiction / Romance'], ratings: { spice: 4 }, myRating: 4, pageCount: 380, tropes: ['Forced Proximity'],  dateFinished: '${isoDaysAgo(30)}' }));
  library.push(M('s4', 'Spicy Four',  { categories: ['Fiction / Romance'], ratings: { spice: 5 }, myRating: 5, pageCount: 380, tropes: ['Enemies to Lovers'], dateFinished: '${isoDaysAgo(5)}' }));
  library.push(M('h1', 'Scary One',   { categories: ['Fiction / Horror'], ratings: { scare: 2 }, myRating: 3, pageCount: 300, dateFinished: '${isoDaysAgo(40)}' }));
  library.push(M('h2', 'Scary Two',   { categories: ['Fiction / Horror'], ratings: { scare: 3 }, myRating: 2, pageCount: 320, dateFinished: '${isoDaysAgo(200)}' }));
  library.push(M('h3', 'Scary Three', { categories: ['Fiction / Horror'], ratings: { scare: 4 }, myRating: 3, pageCount: 310, dateFinished: '${isoDaysAgo(50)}' }));
  library.push(M('f1', 'Epic One',    { categories: ['Fiction / Fantasy'], ratings: { adventure: 4 }, myRating: 4, pageCount: 500, tropes: ['Enemies to Lovers'], dateFinished: '${isoDaysAgo(210)}' }));
  library.push(M('r2', 'Long Read',   { myRating: 4, pageCount: 700, dateFinished: '${isoDaysAgo(60)}' }));
  library.push(M('r3', 'Longer Read', { myRating: 4, pageCount: 720, dateFinished: '${isoDaysAgo(70)}' }));
  library.push(M('d1', 'DNF One',     { status: 'dnf', pageCount: 700 }));
  renderStats();`);

// 1. reading profile (v102: axis rows use theme-aware line-art icons, not emoji)
const spiceRow = qa('.kv-row').find(r => r.textContent.includes('Spice'));
ok('spice row shows 4.8 avg', !!spiceRow && spiceRow.textContent.includes('4.8'));
ok('spice meter is full (10 blocks)', !!spiceRow && spiceRow.querySelector('.mfill').textContent.length === 10);
ok('spice book count shown', !!spiceRow && spiceRow.textContent.includes('4'));
ok('spice row uses line-art icon, not emoji', !!spiceRow && !!spiceRow.querySelector('svg.ticon') && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(spiceRow.textContent));
const scareRow = qa('.kv-row').find(r => r.textContent.includes('Scare'));
ok('scare row shows 3.0 avg', !!scareRow && scareRow.textContent.includes('3.0'));
ok('profile line is descriptive', window.document.body.textContent.includes('You tend to reach for high-spice books.'));

// 2. rating distribution
const fiveRow = qa('.dist-row').find(r => r.textContent.indexOf('5 ⭐') === 0);
ok('5-star bin counts 3', !!fiveRow && fiveRow.querySelector('.num').textContent === '3');
const oneRow = qa('.dist-row').find(r => r.textContent.indexOf('1 ⭐') === 0);
ok('1-star bin counts 0', !!oneRow && oneRow.querySelector('.num').textContent === '0');
ok('distribution take line', window.document.body.textContent.includes('5-star reads make up 30%'));

// 3. reading patterns
const pats = qa('.pattern p').map(p => p.textContent);
ok('5 patterns found', pats.length === 5);
ok('genre rating gap', pats.some(t => t.includes('Romance') && t.includes('Horror') && t.includes('2.1')));
ok('top-rated length', pats.some(t => t.includes('highest-rated') && t.includes('400 pages')));
ok('finish likelihood bucket', pats.some(t => t.includes('most likely to finish') && t.includes('250–450 pages')));
ok('trope rating', pats.some(t => t.includes('Enemies to Lovers') && t.includes('4.8')));
ok('rating trend', pats.some(t => t.includes('risen') && t.includes('3.0') && t.includes('4.1')));

// 4. empty states stay graceful
runInWindow(`library.length = 0; renderStats();`);
const bodyTxt = window.document.body.textContent;
ok('empty profile note', bodyTxt.includes('Reading profile') && bodyTxt.includes('Rate the intensity axes'));
ok('empty distribution note', bodyTxt.includes('Rate your finished books'));
ok('empty patterns note', bodyTxt.includes('Finish and rate a few more books'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
