// Tests for v131 — Option B ratings rework (UI Improvement Pass, modal polish):
// your rating lives in the modal header with a live word label;
// mood axes are segmented bars with numeric readouts, × to remove,
// + chips to add back.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in rating tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

const seed = (id, over) => {
  const base = { id, isbn: '', title: 'T' + id, authors: ['A'], cover: '', description: '',
    pageCount: 300, publishedDate: '', categories: ['Fiction / Romance'], publicRating: null,
    ratingsCount: 0, status: 'read', ratings: { spice: 4 }, axes: ['spice', 'adventure'],
    myRating: 4, tropes: [], progress: 300, log: [], dateAdded: new Date().toISOString(),
    dateFinished: null, notes: '', favorite: false, owned: true, series: null, series2: null, quotes: [] };
  const book = Object.assign(base, over || {});
  runInWindow(`localStorage.clear(); library = []; library.push(${JSON.stringify(book)});
    saveLibrary(); openBookFromEl(null, '${id}');`);
};

// --- your rating in the header ---
seed('r1', {});
ok('rating picker lives in the modal head', !!q('.modal-head #f-myrating'));
ok('header hearts reflect saved rating', qa('#f-myrating button.on').length === 4);
ok('word label shows for saved rating', q('#f-myrating-word').textContent === 'Really liked it');
ok('no duplicate rating picker below', qa('#f-myrating').length === 1);
ok('old My rating field removed', !Array.from(qa('.field > label')).some(l => l.textContent === 'My rating'));

qa('#f-myrating button')[4].click(); // 5th heart
ok('tapping 5th heart fills all five', qa('#f-myrating button.on').length === 5);
ok('word label updates to Loved it', q('#f-myrating-word').textContent === 'Loved it');
qa('#f-myrating button')[4].click(); // tap again clears
ok('tap again clears rating', qa('#f-myrating button.on').length === 0);
ok('word label resets', q('#f-myrating-word').textContent === 'Tap to rate');

// --- segmented mood bars ---
seed('r2', {});
const rows = qa('#f-axrows .axrow');
ok('one row per applied axis', rows.length === 2);
ok('rows show icon + label', rows.every(r => r.querySelector('.axlab .ticon') && r.querySelector('.axlab').textContent.trim().length > 2));
ok('rows use segmented bars, not icon buttons', qa('#f-axrows .segbar i').length === 10 && !q('#f-axrows .picker'));
ok('spice bar shows 4 filled segments', qa('#f-axrows [data-ax="spice"] .segbar i.f').length === 4);
ok('numeric readout shown', q('#f-axrows [data-ax="spice"] .segnum').textContent === '4');
ok('unrated axis shows dash', q('#f-axrows [data-ax="adventure"] .segnum').textContent === '–');
ok('unapplied axes offered as + chips', qa('#f-axadd [data-axadd]').length === 9); // 11 - 2 applied

const advBar = q('#f-axrows [data-ax="adventure"] .segbar');
advBar.querySelectorAll('i')[2].click(); // 3rd segment
ok('tapping segment sets rating', qa('#f-axrows [data-ax="adventure"] .segbar i.f').length === 3);
ok('readout updates', q('#f-axrows [data-ax="adventure"] .segnum').textContent === '3');
advBar.querySelectorAll('i')[2].click(); // tap again clears
ok('tap again clears axis rating', qa('#f-axrows [data-ax="adventure"] .segbar i.f').length === 0);
ok('readout resets to dash', q('#f-axrows [data-ax="adventure"] .segnum').textContent === '–');

q('#f-axrows [data-ax="spice"] [data-axrm]').click();
ok('× removes the axis row', qa('#f-axrows .axrow').length === 1 && !q('#f-axrows [data-ax="spice"]'));
ok('removed axis returns to + chips', qa('#f-axadd [data-axadd]').length === 10);
q('#f-axadd [data-axadd="spice"]').click();
ok('+ chip re-adds the axis', qa('#f-axrows .axrow').length === 2 && !!q('#f-axrows [data-ax="spice"]'));

// --- save persists header + axis edits ---
seed('r3', { myRating: 0, ratings: {}, axes: ['spice'] });
qa('#f-myrating button')[2].click();
q('#f-axrows [data-ax="spice"] .segbar').querySelectorAll('i')[1].click();
runInWindow(`document.getElementById('m-save').click();`);
ok('save persists header rating', runInWindow2('library[0].myRating') === 3);
ok('save persists axis rating', runInWindow2('library[0].ratings.spice') === 2);

function runInWindow2(js) { return window.eval(js); }

// --- v132: expanded catalog, colors, level words, fit-to-book axes ---
ok('catalog has 11 axes', runInWindow2('RATING_AXES.length') === 11);
ok('every axis has color + 5 level words',
  runInWindow2(`RATING_AXES.every(a => /^#[0-9a-f]{6}$/i.test(a.color) && Array.isArray(a.levels) && a.levels.length === 5)`));
ok('every axis icon resolves to line-art svg',
  runInWindow2(`RATING_AXES.every(a => icon(a.icon).includes('</svg>'))`));

const axesFor = (book) => runInWindow2(`autoDetectAxes(${JSON.stringify(book)})`);
ok('dark romance gets Darkness (trope match)',
  axesFor({ title: 'T', categories: [], tropes: ['dark romance', 'morally grey'], }).includes('darkness'));
ok('romance gets Spice + Feels, not Depth',
  (() => { const h = axesFor({ title: 'T', categories: ['Fiction / Romance'], tropes: [] });
    return h.includes('spice') && h.includes('feels') && !h.includes('depth'); })());
ok('history book gets Insight + Readability + Depth, not Spice',
  (() => { const h = axesFor({ title: 'The Guns of August', categories: ['History / Military'], tropes: [] });
    return h.includes('insight') && h.includes('readability') && h.includes('depth') && !h.includes('spice'); })());
ok('tech book gets Insight + Practical',
  (() => { const h = axesFor({ title: 'T', categories: ['Computers / Programming'], tropes: [] });
    return h.includes('insight') && h.includes('practical'); })());
ok('romcom gets Humor', axesFor({ title: 'T', categories: [], tropes: ['witty banter'] }).includes('humor'));
ok('unknown book falls back to spice', axesFor({ title: 'Xyzzy', categories: [], tropes: [] }).join() === 'spice');

// modal: color + word rendering, fit-to-book display
seed('r4', { categories: ['History / Military'], tropes: [], axes: [], ratings: {} });
ok('history modal shows nonfiction axes only',
  (() => { const keys = qa('#f-axrows .axrow').map(r => r.dataset.ax);
    return keys.includes('insight') && keys.includes('depth') && !keys.includes('spice'); })());
ok('row carries the axis color var',
  q('#f-axrows [data-ax="insight"]').getAttribute('style').includes('#4dd0e1'));
ok('unrated row word is Tap to rate',
  q('#f-axrows [data-ax="insight"] .axword').textContent === 'Tap to rate');

seed('r5', {});
ok('spice 4 shows level word Explicit',
  q('#f-axrows [data-ax="spice"] .axword').textContent === 'Explicit');
ok('spice row uses spice color',
  q('#f-axrows [data-ax="spice"]').getAttribute('style').includes('#ff5d6d'));
const spiceBar = q('#f-axrows [data-ax="spice"] .segbar');
spiceBar.querySelectorAll('i')[4].click();
ok('word updates with new value (Filthy)',
  q('#f-axrows [data-ax="spice"] .axword').textContent === 'Filthy');
spiceBar.querySelectorAll('i')[4].click();
ok('word resets when cleared',
  q('#f-axrows [data-ax="spice"] .axword').textContent === 'Tap to rate');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
