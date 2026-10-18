// Work quotes (v337 'Memorable quotes') regression tests — issue #354.
// loadQuotesForBook looks up #m-quotes-wrap and returns early when it is
// absent; the detail-modal template must emit that wrap (with its own
// work-quotes box) or the v337 feature can never render.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in work-quotes tests'); };

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mk = (id) => ({
  id, isbn: '9780000000001', title: 'Book ' + id, authors: ['Author ' + id], cover: '',
  description: '', pageCount: 300, publishedDate: '', categories: ['romance'],
  publicRating: null, ratingsCount: 0, status: 'read',
  ratings: { spice: 3 }, axes: ['spice'], myRating: 0, tropes: [],
  progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
});

(async () => {
  runInWindow(`(function(){
    localStorage.clear();
    localStorage.setItem('spicyshelves.animation', 'off');
    library.length = 0;
    library.push(${JSON.stringify(mk('wq1'))});
    saveLibrary();
    // Stub the data path: the book resolves to a work, the work has quotes.
    window.__seenWorkId = null;
    resolveWork = async () => 'work-1';
    CharacterWiki.getQuotesForWork = async (wid) => {
      window.__seenWorkId = wid;
      return [
        { quote: 'We are the music makers', speaker: 'Willy Wonka', context: 'ch. 3' },
        { quote: 'Second <memorable> line', speaker: '', context: '' }
      ];
    };
  })();`);

  runInWindow(`openDetail('wq1');`);
  await sleep(150); // loadQuotesForBook is fire-and-forget from the wiring

  // 1. The template emits the wrap loadQuotesForBook looks up.
  ok('detail modal emits #m-quotes-wrap', !!q('#m-quotes-wrap'));

  // 2. The quotes for the resolved work actually render, and the wrap unhides.
  const wrap = q('#m-quotes-wrap');
  ok('work resolved before fetch', window.__seenWorkId === 'work-1');
  ok('wrap is unhidden once quotes land', !!wrap && wrap.style.display !== 'none');
  const wbox = q('#m-wquotes');
  ok('work quotes render into their own box', !!wbox &&
    wbox.innerHTML.includes('We are the music makers') &&
    wbox.innerHTML.includes('Willy Wonka'));
  ok('work quote text is HTML-escaped', !!wbox && wbox.innerHTML.includes('&lt;memorable&gt;'));

  // 3. The Notes-tab saved-quotes editor (#m-quotes) is a different element
  //    and is not clobbered by the work quotes.
  ok('exactly one #m-quotes element exists', qa('#m-quotes').length === 1);
  ok('saved-quotes editor intact (add button present)', !!q('#m-quotes #m-qadd'));
  ok('saved-quotes box holds no work quotes', !!q('#m-quotes') &&
    !q('#m-quotes').innerHTML.includes('music makers'));

  console.log('work-quotes: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
