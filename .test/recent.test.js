// Recently-read strip + book-opening transition (v36).
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
const dayK = (offset) => {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

(async () => {
  runInWindow(`localStorage.clear();
    const mk = (id, o) => Object.assign({ id, isbn: '', title: 'Book ' + id, authors: ['A U Thor'],
      cover: '', description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null,
      ratingsCount: 0, status: 'tbr', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 0,
      dateAdded: new Date().toISOString(), dateFinished: null, notes: '', log: [] }, o);
    window.__r1 = mk('r1', { status: 'reading', progress: 100, log: [{ d: '${dayK(0)}', from: 90, to: 100 }] });
    window.__r2 = mk('r2', { status: 'reading', progress: 50, log: [{ d: '${dayK(1)}', from: 40, to: 50 }] });
    window.__r3 = mk('r3', { status: 'read', dateFinished: '${isoDaysAgo(3)}', progress: 300 });
    window.__r4 = mk('r4', { status: 'tbr' }); // no activity -> excluded
    window.__r5 = mk('r5', { status: 'reading' }); // reading but no log yet -> included, sorts last
    for (let i = 6; i <= 12; i++) library.push(mk('r' + i, { status: 'tbr', log: [{ d: '${dayK(10 + 0)}', from: 1, to: 5 }] }));
    library.push(window.__r1, window.__r2, window.__r3, window.__r4, window.__r5);`);

  // 1. activity + ordering
  ok('lastReadActivity picks newest log day', probe(`lastReadActivity(library.find(b=>b.id==='r1'))`) === dayK(0));
  ok('lastReadActivity uses finish date', probe(`lastReadActivity(library.find(b=>b.id==='r3'))`) === dayK(3));
  ok('lastReadActivity empty without activity', probe(`lastReadActivity(library.find(b=>b.id==='r4'))`) === '');
  const order = probe(`recentBooks(20).map(b=>b.id).join(',')`);
  ok('recent order: today > yesterday > finished > stale > reading-no-log',
    order.indexOf('r1') < order.indexOf('r2') && order.indexOf('r2') < order.indexOf('r3') &&
    order.indexOf('r3') < order.indexOf('r6') && order.indexOf('r6') < order.indexOf('r5'));
  ok('inactive tbr excluded', !probe(`recentBooks(20).some(b=>b.id==='r4')`));
  ok('reading without log still included', probe(`recentBooks(20).some(b=>b.id==='r5')`));
  ok('default limit is 8', probe(`recentBooks().length`) === 8);

  // 1b. v59: page updates stamp lastPagedAt; the just-touched book jumps first
  // even when several books were read on the same day.
  ok('logPages stamps lastPagedAt on a real change', probe(
    `const tb = {}; logPages(tb, 50, 60); !!tb.lastPagedAt`));
  ok('logPages no-op does not stamp', probe(
    `const b2 = { progress: 10 }; logPages(b2, 10, 10); !b2.lastPagedAt`));
  probe(`const ra = library.find(x=>x.id==='r1'), rb = library.find(x=>x.id==='r2');
    rb.log.push({ d: '${dayK(0)}', from: 50, to: 55 }); // temp: force a same-day tie
    ra.lastPagedAt = new Date(Date.now() - 3600000).toISOString(); // touched an hour ago
    rb.lastPagedAt = new Date().toISOString(); // touched just now`);
  const sameDayOrder = probe(`recentBooks(20).map(b=>b.id).join(',')`);
  ok('same-day tie broken by most recent page touch',
    sameDayOrder.indexOf('r2') < sameDayOrder.indexOf('r1'));
  probe(`renderLibrary();`);
  ok('strip reflects the new order', qa('.recent-card')[0].dataset.id === 'r2');
  // restore r1/r2 to their original state for the sections below
  probe(`const ra2 = library.find(x=>x.id==='r1'), rb2 = library.find(x=>x.id==='r2');
    rb2.log.pop(); delete ra2.lastPagedAt; delete rb2.lastPagedAt;`);

  // 2. strip renders above the favorites shelf
  probe(`localStorage.setItem('spicyshelves.animation','off'); renderLibrary();`);
  const strip = q('.recent-strip');
  ok('recent strip rendered', !!strip);
  ok('strip sits above favorites shelf',
    !!(strip && q('.fav-shelf') && (strip.compareDocumentPosition(q('.fav-shelf')) & 4)));
  ok('strip shows 8 cards', qa('.recent-card').length === 8);
  ok('first card is the most recently read', qa('.recent-card')[0].dataset.id === 'r1');
  ok('progress bar reflects pages', qa('.recent-card')[0].querySelector('.fill').style.width === '33%');
  ok('finished book shows Finished', qa('.recent-card').some(c => c.dataset.id === 'r3' && c.textContent.includes('Finished')));

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
  ok('no strip when nothing was read', !q('.recent-strip'));

  // 6. transition path: overlay appears, modal arrives with the from-book entrance
  probe(`localStorage.setItem('spicyshelves.animation','on');
    library.push(window.__r1);
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
