// Year in Books tests (v70).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in yearinbooks tests'); };

// stub canvas 2d so drawYearImage runs without node-canvas
const gradStub = { addColorStop() {} };
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient') return () => gradStub;
    return () => {};
  },
  set() { return true; }
});
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx; };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s, root) => Array.from((root || window.document).querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

runInWindow(`(function(){
  localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  const Y = new Date().getFullYear();
  const fin = (m, day) => Y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0') + 'T12:00:00';
  const fday = (m, day) => Y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  const M = (id, title, author, cats, rating, pages, fm) => ({ id, isbn: '', title, authors: [author], cover: '',
    description: '', pageCount: pages, publishedDate: '', categories: cats, publicRating: null,
    ratingsCount: 0, status: 'read', ratings: {}, axes: [], myRating: rating, tropes: [],
    progress: pages, log: [{ d: fday(fm, 10), from: 0, to: pages }], dateAdded: fin(1, 5), dateFinished: fin(fm, 15), notes: '' });
  const R = ['Fiction / Romance / General'], F = ['Fiction / Fantasy / Epic'], T = ['Fiction / Thrillers / General'];
  library.push(M('y1', 'Romance One', 'Author A', R, 5, 400, 3));
  library.push(M('y2', 'Romance Two', 'Author A', R, 4.5, 300, 5));
  library.push(M('y3', 'Fantasy Epic', 'Author B', F, 4, 500, 7));
  library.push(M('y4', 'Thriller Night', 'Author C', T, 3.5, 250, 8));
  // last year's book must not leak in
  const old = M('old', 'Old Book', 'Author D', R, 5, 999, 3);
  old.dateFinished = (Y - 1) + '-06-15T12:00:00';
  old.log = [];
  library.push(old);
})();`);

// 1. data aggregation
runInWindow(`window.__d = yearInBooksData();`);
const d = window.__d;
ok('counts this-year books only', d.n === 4);
ok('pages total', d.pages === 1450);
ok('avg rating', Math.abs(d.avg - 4.25) < 1e-9);
ok('top genre is Romance x2', d.topGenres[0][0] === 'Romance' && d.topGenres[0][1] === 2);
ok('top book first', d.topBooks[0].id === 'y1' && d.topBooks.length === 4);
ok('longest book', d.longest.id === 'y3');
ok('top author', d.topAuthor[0] === 'Author A' && d.topAuthor[1] === 2);
ok('reading days counted', d.days >= 4);

// 2. view renders
runInWindow(`renderYearInBooks();`);
ok('hero renders', /Your \d{4}.*in Books/.test(q('.yib-hero').textContent));
ok('export buttons exist', !!q('#yib-share') && !!q('#yib-copy'));
ok('top book shown', q('.now-reading').textContent.includes('Romance One'));
ok('back button returns to stats', (() => { q('#yib-back').click(); return !!q('#st-yib'); })());

// 3. stats entry point
runInWindow(`renderStats();`);
ok('stats has the Year in Books button', !!q('#st-yib'));
q('#st-yib').click();
ok('button opens the summary', !!q('.yib-hero'));

// 4. canvas export draws a 1080x1920 image
const cv = window.drawYearImage(window.yearInBooksData());
ok('canvas is 1080x1920', cv && cv.width === 1080 && cv.height === 1920);

// 5. text summary
const txt = window.yearTextSummary(window.yearInBooksData());
ok('text summary has the essentials',
  txt.includes('4 books') && txt.includes('1450 pages') && txt.includes('Romance One'));

// 6. empty state
runInWindow(`library.length = 0; renderYearInBooks();`);
ok('empty year shows a friendly note', /No finished books/.test(window.document.body.textContent));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
