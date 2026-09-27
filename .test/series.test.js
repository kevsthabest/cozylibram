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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
