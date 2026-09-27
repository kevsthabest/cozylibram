// Quote capture tests (v75).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in quotes tests'); };

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
const mk = (id) => ({
  id, isbn: '', title: 'Book ' + id, authors: ['Author ' + id], cover: '',
  description: '', pageCount: 300, publishedDate: '', categories: ['romance'],
  publicRating: null, ratingsCount: 0, status: 'tbr',
  ratings: { spice: 3 }, axes: ['spice'], myRating: 0, tropes: [],
  progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
});

// 1. migration normalizes quotes
runInWindow('window.__mig = migrateBook({ id: "m", title: "T" });');
ok('migrateBook adds an empty quotes array', Array.isArray(window.__mig.quotes) && window.__mig.quotes.length === 0);

runInWindow(`(function(){
  localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  library.push(${JSON.stringify(mk('q1'))}, ${JSON.stringify(mk('q2'))});
  saveLibrary();
})();`);

// 2. add a quote from the modal
runInWindow(`openDetail('q1');`);
ok('modal has a quotes section', !!q('#m-quotes') && !!q('#m-qadd'));
q('#m-qadd').click();
ok('add form appears', !q('#m-qform').hidden);
q('#m-qtext').value = 'I love you <3 more than words';
q('#m-qpage').value = '42';
q('#m-qsave').click();
const b1 = runInWindow(`window.__b1 = library.find(b => b.id === 'q1');`) || window.__b1;
ok('quote saved on the book with page', window.__b1.quotes.length === 1 &&
  window.__b1.quotes[0].t === 'I love you <3 more than words' && window.__b1.quotes[0].p === 42);
ok('quote text is HTML-escaped', q('#m-quotes').innerHTML.includes('&lt;3'));
ok('quote persists to storage', window.localStorage.getItem('spicyshelves.library.v1').includes('I love you'));

// 3. delete a quote
qa('#m-quotes [data-qdel]')[0].click();
ok('quote deleted', window.__b1.quotes.length === 0);

// 4. Save must not clobber immediately-saved quotes
q('#m-qadd').click();
q('#m-qtext').value = 'Second quote';
q('#m-qpage').value = '';
q('#m-qsave').click();
q('#m-save').click(); // modal Save
ok('modal Save keeps the quote', window.__b1.quotes.length === 1 &&
  window.__b1.quotes[0].t === 'Second quote');
ok('page-less quote stores null page', window.__b1.quotes[0].p === null);

// 5. quotes browser
runInWindow(`(function(){
  const b2 = library.find(b => b.id === 'q2');
  b2.quotes = [{ t: 'Another one', p: 7, at: '2026-01-02T00:00:00.000Z' }];
  window.__b1.quotes[0].at = '2026-01-01T00:00:00.000Z';
  saveLibrary();
  go('quotes');
})();`);
ok('browser lists quotes newest-first', qa('#view .q-card').length === 2);
q('#q-random').click();
ok('random button spotlights a quote', !!q('#q-spot .q-card.feat'));
qa('#view .q-list .q-card')[0].click();
ok('tapping a quote card opens the book', !!q('#modal-root .modal'));

// 6. library toolbar entry point
runInWindow(`(function(){ const r = document.getElementById('modal-root'); if (r) r.innerHTML = ''; go('library'); })();`);
ok('library has a Quotes button', !!q('#lib-quotes'));
q('#lib-quotes').click();
ok('quotes button opens the browser', !!q('#view #q-random'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
