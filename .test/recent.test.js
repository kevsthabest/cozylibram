// Recently Added strip + book-opening transition (v36, v173).
//
// v173: the "Recently read" strip became "Recently Added" (newest arrivals
// first) per the home mockup; the recentBooks/lastReadActivity helpers went
// away with it. logPages/lastPagedAt coverage stays here.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in recent tests'); };

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
const probe = (js) => window.eval(js);
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

(async () => {
  const addedDates = [];
  for (let i = 1; i <= 12; i++) addedDates.push(isoDaysAgo(i)); // r1 newest … r12 oldest
  runInWindow(`localStorage.clear();
    const mk = (id, o) => Object.assign({ id, isbn: '', title: 'Book ' + id, authors: ['A U Thor'],
      cover: '', description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
      ratingsCount: 0, status: 'tbr', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 0,
      dateAdded: new Date().toISOString(), dateFinished: null, notes: '', log: [] }, o);
    window.__books = [];
    const dates = ${JSON.stringify(addedDates)};
    for (let i = 1; i <= 12; i++) window.__books.push(mk('r' + i, { dateAdded: dates[i - 1] }));
    window.__books.forEach(b => library.push(b));`);

  // 1. page updates still stamp lastPagedAt (used by stats/sync ordering)
  ok('logPages stamps lastPagedAt on a real change', probe(
    `const tb = {}; logPages(tb, 50, 60); !!tb.lastPagedAt`));
  ok('logPages no-op does not stamp', probe(
    `const b2 = { progress: 10 }; logPages(b2, 10, 10); !b2.lastPagedAt`));

  // 2. Recently Added strip: newest arrivals first, capped at 10
  probe(`localStorage.setItem('spicyshelves.animation','off'); renderLibrary();`);
  const strip = q('.recent-strip');
  ok('recently-added strip rendered', !!strip);
  ok('strip heading says Recently Added', strip && strip.textContent.includes('Recently Added'));
  ok('strip sits above favorites shelf',
    !!(strip && q('.fav-shelf') && (strip.compareDocumentPosition(q('.fav-shelf')) & 4)));
  ok('strip shows 10 cards (capped)', qa('.recent-card').length === 10);
  ok('first card is the newest arrival', qa('.recent-card')[0].dataset.id === 'r1');
  ok('last card is the 10th newest', qa('.recent-card')[9].dataset.id === 'r10');
  ok('cards show titles without progress bars',
    qa('.recent-card')[0].textContent.includes('Book r1') && !q('.recent-card .recent-prog'));
  ok('View All button present', !!q('#ra-all'));

  // 3. tapping a recent card opens the detail modal (motion off -> instant)
  qa('.recent-card')[0].click();
  ok('recent card opens the book modal', !!q('#m-back') && q('#m-back').textContent.includes('Book r1'));
  q('#m-x').click();

  // 4. animation gate: motion off + fromEl still renders directly, no overlay
  probe(`openDetail('r2', { fromEl: document.querySelector('.recent-card') });`);
  ok('motion-off path renders modal without overlay', !!q('#m-back') && !q('.bookopen-overlay'));
  q('#m-x').click();

  // 5. empty library -> no strip
  probe(`library.length = 0; renderLibrary();`);
  ok('no strip when the library is empty', !q('.recent-strip'));

  // 6. transition path: overlay appears, modal arrives with the from-book entrance
  probe(`localStorage.setItem('spicyshelves.animation','on');
    library.push(window.__books[0]);
    renderLibrary();
    openDetail('r1', { fromEl: document.querySelector('.recent-card') });`);
  ok('book-open overlay created', !!q('.bookopen-overlay'));
  ok('cover starts the flip', await new Promise(res =>
    setTimeout(() => res(q('.bookopen-book') && q('.bookopen-book').classList.contains('open')), 600)));
  ok('modal arrives via the book-open entrance', await new Promise(res =>
    setTimeout(() => res(!!q('#m-back.from-book')), 1400)));
  ok('overlay cleaned up afterwards', await new Promise(res =>
    setTimeout(() => res(!q('.bookopen-overlay')), 2100)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
