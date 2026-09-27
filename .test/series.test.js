// Series overview tests (v76; filters + tappable covers + single-book hiding v78).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in series tests'); };

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
const mk = (id, series, status) => ({
  id, isbn: '', title: 'Book ' + id, authors: ['Sarah J. Maas'], cover: '',
  description: '', pageCount: 300, publishedDate: '', categories: ['romance'],
  publicRating: null, ratingsCount: 0, status: status || 'tbr',
  ratings: { spice: 3 }, axes: ['spice'], myRating: 0, tropes: [],
  progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null,
  notes: '', series: series || null
});

runInWindow(`(function(){
  localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  library.push(
    ${JSON.stringify(mk('a1', { name: 'ACOTAR', position: 1 }, 'read'))},
    ${JSON.stringify(mk('a2', { name: 'ACOTAR', position: 2 }, 'reading'))},
    ${JSON.stringify(mk('a3', { name: 'acotar', position: 3 }, 'tbr'))},
    ${JSON.stringify(mk('t1', { name: 'Throne of Glass', position: 1 }, 'read'))},
    ${JSON.stringify(mk('t2', { name: 'Throne of Glass', position: 2 }, 'read'))},
    ${JSON.stringify(mk('f1', { name: 'From Blood and Ash', position: 1 }, 'dnf'))},
    ${JSON.stringify(mk('f2', { name: 'From Blood and Ash', position: 2 }, 'dnf'))},
    ${JSON.stringify(mk('s1', { name: 'Solo Finished', position: 1 }, 'read'))},
    ${JSON.stringify(mk('u1', { name: 'Solo Upcoming', position: 1 }, 'tbr'))},
    ${JSON.stringify(mk('n1', null, 'tbr'))}
  );
  saveLibrary();
})();`);

// 1. grouping is case-insensitive, positions order the books
const data = window.seriesData();
ok('series grouped case-insensitively', data.length === 5);
const acotar = data.find(s => s.name === 'ACOTAR');
ok('books sorted by position', acotar.books.map(b => b.id).join(',') === 'a1,a2,a3');
ok('read count + next unread', acotar.read === 1 && acotar.next.id === 'a2');
ok('author line collected', acotar.authorLine === 'Sarah J. Maas');
ok('started flag (read+reading, not all read)', acotar.started === true && acotar.completed === false);
const tog = data.find(s => s.name === 'Throne of Glass');
ok('completed flag (all read)', tog.started === false && tog.completed === true);

// 2. single-book hiding: finished solo hidden, upcoming solo shown
const vis = window.visibleSeries().map(s => s.name);
ok('single finished book hidden', !vis.includes('Solo Finished'));
ok('single upcoming book shown', vis.includes('Solo Upcoming'));
ok('visible count', vis.length === 4);

// 3. render + states
runInWindow(`seriesReturn = 'library'; seriesFilter = 'all'; go('series');`);
ok('four series cards', qa('#view .sr-card').length === 4);
const cards = qa('#view .sr-card');
const byName = {};
cards.forEach(c => { byName[c.querySelector('.sr-name').textContent] = c; });
ok('progress stated as owned/read', byName['ACOTAR'].querySelector('.sr-count').textContent === '1 / 3 read');
ok('next-unread button present', !!byName['ACOTAR'].querySelector('.sr-next') &&
  byName['ACOTAR'].querySelector('.sr-next').textContent.includes('Book a2'));
ok('all-read series celebrates honestly', byName['Throne of Glass'].textContent.includes('Everything you own is read'));
ok('dnf-only remainder is honest', byName['From Blood and Ash'].textContent.includes('The rest are DNF'));
ok('upcoming solo shows its next book', byName['Solo Upcoming'].querySelector('.sr-next').textContent.includes('Book u1'));

// 4. tappable covers open the book like the grid
ok('covers are buttons', qa('#view .sr-cover').length > 0);
byName['ACOTAR'].querySelector('.sr-cover').click();
ok('tapping a cover opens the detail modal', !!q('#modal-root .modal'));
runInWindow(`document.getElementById('modal-root').innerHTML = '';`);

// 5. filter pills
const chipFor = (label) => qa('#view .chips .chip').find(c => c.textContent.startsWith(label));
ok('filter pills present', !!chipFor('All') && !!chipFor('Started') && !!chipFor('Completed'));
chipFor('Started').click();
ok('started filter shows only in-progress series', qa('#view .sr-card').length === 1 &&
  q('#view .sr-name').textContent === 'ACOTAR');
ok('filter persists', window.localStorage.getItem('spicyshelves.seriesfilter') === 'started');
chipFor('Completed').click();
ok('completed filter shows only finished series', qa('#view .sr-card').length === 1 &&
  q('#view .sr-name').textContent === 'Throne of Glass');
chipFor('All').click();
ok('all filter restores every visible series', qa('#view .sr-card').length === 4);

// 6. entry points + back navigation
runInWindow(`(function(){ go('library'); })();`);
ok('library has a Series button', !!q('#lib-series'));
q('#lib-series').click();
ok('library entry opens the series view', !!q('#view .sr-list'));
q('#sr-back').click();
ok('back returns to the library', !!q('#lib-series'));
runInWindow(`go('stats');`);
ok('stats has a view-all series button', !!q('#sr-all'));
q('#sr-all').click();
ok('stats entry opens the series view', !!q('#view .sr-list'));
q('#sr-back').click();
ok('back returns to stats', !!q('#sr-all'));

// 7. empty state
runInWindow(`(function(){
  library.forEach(b => { b.series = null; });
  saveLibrary(); go('series');
})();`);
ok('empty state without series', q('#view .empty') && q('#view').textContent.includes('No series yet'));

// 8. v83: Hardcover series discovery — no _ilike (blocked server-side, HTTP
// 403). Exact name lookup uses _eq; on a miss the Typesense search endpoint
// resolves the series id, then detail is fetched by id. A depth rejection
// retries with the slim field set.
(async () => {
  runInWindow('window.SPICY_CONFIG = { hardcoverToken: "tok" };');
  runInWindow(`window.__queries = [];
    window.__fullDetail = { id: 7, name: 'ACOTAR', author: { name: 'Sarah J. Maas' },
      book_series: [
        { position: 1, details: null, book: { id: 11, title: 'A Court of Thorns and Roses',
          image: { url: 'http://img/1.jpg' }, default_physical_edition: { isbn_13: '9781619634442' } } },
        { position: 2, details: null, book: { id: 12, title: 'A Court of Mist and Fury',
          image: null, default_physical_edition: null } },
      ] };
    window.__slimDetail = { id: 7, name: 'Deep Cut', author: { name: 'Sarah J. Maas' },
      book_series: [ { position: 1, details: null, book: { id: 21, title: 'Deep Cut One' } } ] };
    window.hcGraphQL = async (qq) => {
      window.__queries.push(qq);
      if (window.__depthBlock && qq.indexOf('image { url }') !== -1)
        throw new Error('Hardcover error: query exceeds max depth');
      if (qq.indexOf('query_type: "Series"') !== -1)
        return { search: { results: { hits: [
          { document: { id: 7, name: 'ACOTAR', author_name: 'Sarah J. Maas' } },
          { document: { id: 9, name: 'ACOTAR-ish', author_name: 'Someone Else' } },
        ] } } };
      if (/id:\\s*\\{_eq:\\s*7\\}/.test(qq)) return { series: [window.__fullDetail] };
      if (window.__depthBlock) return { series: [window.__slimDetail] };
      return { series: [] }; // exact-name miss -> search fallback
    };`);
  runInWindow('fetchSeriesBooks("ACOTAR Test", "Sarah J. Maas").then(r => { window.__sr = r; });');
  await new Promise(r => setTimeout(r, 50));
  const qs = window.__queries;
  ok('name miss -> search -> id detail (3 queries)', qs.length === 3);
  ok('no _ilike anywhere (blocked by Hardcover)', !qs.some(qq => /_ilike|_like/.test(qq)));
  ok('exact name lookup uses _eq', /name:\s*\{_eq:/.test(qs[0]));
  ok('filters still live inside where',
    /where:\s*\{name:\s*\{_eq:[^}]*\},\s*books_count:\s*\{_gt:\s*0\},\s*canonical_id:\s*\{_is_null:\s*true\}\}/.test(qs[0]));
  ok('id detail targets the author-matched hit', /id:\s*\{_eq:\s*7\}/.test(qs[2]));
  const sr = window.__sr;
  ok('discovery returns rows', sr && sr.rows.length === 2);
  ok('row maps position/title/isbn/cover', sr.rows[0].position === 1 &&
    sr.rows[0].title === 'A Court of Thorns and Roses' &&
    sr.rows[0].isbn === '9781619634442' && sr.rows[0].cover === 'http://img/1.jpg');
  ok('row without edition data still maps', sr.rows[1].position === 2 && sr.rows[1].isbn === '');
  runInWindow('fetchSeriesBooks("ACOTAR Test", "Sarah J. Maas").then(r => { window.__sr2 = r; });');
  await new Promise(r => setTimeout(r, 30));
  ok('discovery result cached', qs.length === 3 && window.__sr2.rows.length === 2);

  // depth rejection -> slim retry, rows come back cover-less
  runInWindow('window.__depthBlock = true; window.__queries = [];');
  runInWindow('fetchSeriesBooks("Deep Cut", "Sarah J. Maas").then(r => { window.__sr3 = r; });');
  await new Promise(r => setTimeout(r, 50));
  const qd = window.__queries;
  ok('depth error retried with slim fields', qd.length === 2 &&
    qd[0].indexOf('image { url }') !== -1 && qd[1].indexOf('image { url }') === -1);
  const sr3 = window.__sr3;
  ok('slim rows map without cover/isbn', sr3 && sr3.rows.length === 1 &&
    sr3.rows[0].title === 'Deep Cut One' && sr3.rows[0].cover === '' && sr3.rows[0].isbn === '');
  runInWindow('window.__depthBlock = false;');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
