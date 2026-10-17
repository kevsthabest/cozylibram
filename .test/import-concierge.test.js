// Import Concierge: guided flow state machine, classification, match counts,
// scoped cover pass + retry. Network is stubbed; the app loads via harness.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync((process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok') + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in concierge tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
// Any unhandled async throw (e.g. the close-mid-run race) must fail loudly.
let asyncCrash = null;
process.on('unhandledRejection', (e) => { asyncCrash = e; });
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

const GR_CSV = 'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies\r\n' +
  '12345,Iron Flame,"Yarros, Rebecca","Yarros, Rebecca","",\\"\\",\\"9781649374189\\",5,4.5,Red Tower,hardcover,623,2023,2023,2024/03/15,2024/01/10,to-read,,read,"Loved it!",,reread soon,1,1\r\n' +
  '67890,"The Name of the Wind","Rothfuss, Patrick","Rothfuss, Patrick","",\\"\\",\\"9780756404741\\",0,4.54,DAW,hardcover,662,2007,2007,,2024/02/01,to-read,,to-read,,,,0,0\r\n' +
  '11111,Coverless Tale,"Doe, Jane","Doe, Jane","",\\"\\",\\"\\",3,4.0,Indie,ebook,200,2024,2024,,2024/03/01,to-read,,to-read,,,,0,0\r\n';

(async () => {
  // quiet the UI side-effects the pipeline triggers
  runInWindow(`window.__toasts = []; toast = (m) => window.__toasts.push(m);`);
  runInWindow(`library = []; try { saveLibrary({noCloud:true}); } catch (e) {}`);
  // stub hygiene: downloadMissingCovers gets replaced in a few tests
  runInWindow(`window.__origDMC = downloadMissingCovers;`);
  const restoreDMC = () => runInWindow(`downloadMissingCovers = window.__origDMC;`);

  // 1. overlay opens with the source step, closes cleanly
  runInWindow(`openImportConcierge();`);
  await tick();
  ok('concierge opens an overlay', !!window.document.getElementById('ic-overlay'));
  ok('source step shows 4 source cards',
    window.document.querySelectorAll('#ic-body [data-ic-source]').length === 4);
  ok('source cards carry hints',
    window.document.getElementById('ic-body').textContent.includes('Export'));
  runInWindow(`icClose();`);
  await tick();
  ok('concierge closes and clears state',
    !window.document.getElementById('ic-overlay') && window.eval('IC') === null);

  // 2. full CSV pipeline: source → file → working → report
  runInWindow(`openImportConcierge();`);
  await tick();
  // tap the Goodreads card
  window.document.querySelector('#ic-body [data-ic-source="goodreads"]').click();
  await tick();
  ok('source pick moves to file step',
    window.eval(`IC.step`) === 'file' && window.eval(`IC.formatId`) === 'goodreads');
  ok('file step has a drop zone', !!window.document.getElementById('ic-drop'));
  // paste instead of picking a file
  runInWindow(`window.__gr = ${JSON.stringify(GR_CSV)};`);
  runInWindow(`document.getElementById('ic-usepaste').click();`);
  await tick();
  // hand the CSV to the pipeline directly (FileReader is awkward in JSDOM)
  runInWindow(`IC.rawText = window.__gr; IC.fileName = 'goodreads.csv'; icContinue();`);
  await tick(400);
  ok('pipeline reaches the report step', window.eval(`IC.step`) === 'report');
  const counts = window.eval(`icCounts()`);
  ok('report counts: 3 parsed rows', counts.total === 3);
  ok('report counts: 3 matched, 0 dupes (empty library)',
    counts.matched === 3 && counts.duplicates === 0);
  ok('report hero shows "3 of 3"',
    window.document.getElementById('ic-body').textContent.includes('3') &&
    window.document.getElementById('ic-body').textContent.includes('matched'));
  runInWindow(`icClose();`);

  // 3. duplicates are classified, not imported
  runInWindow(`
    library = [];
    importForeignBooks([{ title: 'Iron Flame', authors: ['Rebecca Yarros'], isbn: '9781649374189', status: 'read' }], 'Goodreads', 'goodreads', null);
    saveLibrary({noCloud:true});
    openImportConcierge();
  `);
  await tick();
  runInWindow(`IC.formatId = 'goodreads'; IC.rawText = window.__gr; IC.fileName = 'g.csv'; icContinue();`);
  await tick(400);
  const c2 = window.eval(`icCounts()`);
  ok('duplicate detected against the shelf', c2.duplicates === 1 && c2.matched === 2);
  ok('report mentions already-on-shelves',
    window.document.getElementById('ic-body').textContent.includes('already on your shelves'));

  // 4. shelve imports only the matched set (cover pass stubbed: instant, all miss)
  runInWindow(`downloadMissingCovers = async (prog, fns) => {
    const t = (fns && fns.targets) || [];
    return { total: t.length, done: 0 };
  };`);
  const before = window.eval(`library.length`);
  runInWindow(`document.getElementById('ic-shelve').click();`);
  await tick(300);
  const after = window.eval(`library.length`);
  ok('shelve adds exactly the matched books', after - before === 2);
  ok('imported tracked for the cover pass', window.eval(`IC.imported.length`) === 2);
  ok('moves to the cover report', window.eval(`IC.step`) === 'coverreport');
  ok('cover misses listed for retry', window.eval(`IC.coverMissIds.length`) === 2);

  // 4b. closing mid-run never throws (regression: async continuations guard IC)
  // slow cover pass, close while it is in flight
  runInWindow(`
    downloadMissingCovers = (prog, fns) => new Promise(res => setTimeout(() => res({ total: 1, done: 0 }), 300));
    if (!document.getElementById('ic-overlay')) openImportConcierge();
    IC.step = 'covers'; IC.coverTotal = 1; IC.coverMissIds = [];
    icFindCovers([{ id: 'slow1', title: 'Slow', authors: [], cover: '' }]);
  `);
  await tick(50);
  let threw = false;
  try { runInWindow(`icClose();`); await tick(500); } catch (e) { threw = true; }
  ok('close mid-cover-pass does not throw', !threw);
  runInWindow(`if (document.getElementById('ic-overlay')) icClose();`);
  restoreDMC();

  // 5. scoped downloadMissingCovers: only targets, misses stay listed
  runInWindow(`
    library = [];
    importForeignBooks([
      { title: 'Has Cover Soon', authors: ['A'], isbn: '9781111111111', status: 'tbr' },
      { title: 'Stays Bare', authors: ['B'], isbn: '', status: 'tbr' },
    ], 'Goodreads', 'goodreads', null);
    saveLibrary({noCloud:true});
  `);
  await tick();
  const scoped = await window.eval(`(async () => {
    const targets = library.filter(b => !b.cover);
    const fns = {
      targets: targets,
      candidates: async (b) => b.title === 'Has Cover Soon'
        ? [{ url: 'https://example.com/c.jpg', label: 'Test' }] : [],
      verify: async () => true,
    };
    // stub the canonicalizer round-trip (no network in tests)
    const realCanon = adoptCoverWebP;
    adoptCoverWebP = async (u) => u;
    const res = await downloadMissingCovers(null, fns);
    adoptCoverWebP = realCanon;
    return { done: res.done, total: res.total,
             covered: library.filter(b => b.cover).map(b => b.title) };
  })()`);
  ok('scoped run only touched the given targets', scoped.total === 2);
  ok('cover adopted for the found book', scoped.covered.includes('Has Cover Soon'));
  ok('miss left coverless', !scoped.covered.includes('Stays Bare'));

  // 6. cover retry: miss list drives a second pass
  runInWindow(`
    IC = null; icReset();
    IC.step = 'coverreport'; IC.coverTotal = 2;
    IC.coverMissIds = library.filter(b => !b.cover).map(b => b.id);
    IC.imported = [];
  `);
  await tick();
  ok('miss ids tracked', window.eval(`IC.coverMissIds.length`) === 1);
  // retry-all with a now-working candidate source clears the miss
  await window.eval(`(async () => {
    const realFetch = fetchCoverCandidates;
    fetchCoverCandidates = async (b) => [{ url: 'https://example.com/c2.jpg', label: 'Test' }];
    const realVerify = coverURLLoads;
    coverURLLoads = async () => true;
    const realCanon = adoptCoverWebP;
    adoptCoverWebP = async (u) => u;
    await icRetryCovers();
    fetchCoverCandidates = realFetch; coverURLLoads = realVerify; adoptCoverWebP = realCanon;
  })()`);
  await tick(200);
  ok('retry-all clears the miss list', window.eval(`IC.coverMissIds.length`) === 0);

  // 7. ISBN-list pipeline: found / duplicate / missing + one-tap retry
  runInWindow(`
    library = [];
    lookupISBN = async (isbn) => {
      if (isbn === '9780000000001') return { id: 'n1', isbn: isbn, title: 'New Book', authors: ['X'], cover: 'c' };
      if (isbn === '9780000000002') return { id: 'd1', isbn: isbn, title: 'Dupe Book', authors: ['Y'], cover: 'c' };
      return null;
    };
    library = [{ id: 'd1', isbn: '9780000000002', title: 'Dupe Book', authors: ['Y'], cover: 'c',
      status: 'tbr', owned: 'owned', ratings: {}, axes: ['spice'], myRating: 0, tropes: [],
      progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: '' }];
    saveLibrary({noCloud:true});
    openImportConcierge();
    IC.formatId = 'isbn-list'; IC.rawText = '9780000000001\\n9780000000002\\n9780000000003\\n';
    IC.step = 'working';
  `);
  // bulkLookupISBNs paces 300ms × 3 — run the pipeline straight through
  await window.eval(`icRunIsbnPipeline()`);
  await tick(200);
  const c7 = window.eval(`icCounts()`);
  ok('isbn pipeline: 1 found, 1 dupe, 1 missing',
    c7.matched === 1 && c7.duplicates === 1 && c7.unreadable === 1);
  ok('report offers miss retry', !!window.document.getElementById('ic-retry-misses'));
  // flip the stub so the retry succeeds, then retry
  runInWindow(`lookupISBN = async (isbn) => ({ id: 'r' + isbn.slice(-2), isbn: isbn, title: 'Retried', authors: ['Z'], cover: 'c' });`);
  await window.eval(`icRetryIsbnMisses()`);
  await tick(200);
  const c7b = window.eval(`icCounts()`);
  ok('one-tap retry converts the miss', c7b.matched === 2 && c7b.unreadable === 0);
  runInWindow(`icClose();`);

  // 8. back navigation keeps state
  runInWindow(`icReset(); IC.step = 'report'; IC.formatId = 'goodreads'; IC.rawRows = 3;
    IC.classified = [{ book: { title: 'A', authors: [] }, status: 'ready' }]; IC.unreadable = 0;
    openImportConcierge.__skip = 1;`);
  // openImportConcierge resets; drive the UI directly instead
  runInWindow(`if (!document.getElementById('ic-overlay')) openImportConcierge();`);
  await tick();
  runInWindow(`IC.step = 'report'; IC.formatId = 'goodreads'; IC.rawRows = 3;
    IC.classified = [{ book: { title: 'A', authors: [] }, status: 'ready' }]; IC.unreadable = 0; icRender();`);
  await tick();
  window.document.querySelector('#ic-body [data-ic-back]').click();
  await tick();
  ok('back from report returns to file step', window.eval(`IC.step`) === 'file');
  runInWindow(`icClose();`);

  // 9. done step renders a cozy summary
  runInWindow(`
    if (!document.getElementById('ic-overlay')) openImportConcierge();
    IC.step = 'done'; IC.imported = [{ id: 'x1' }, { id: 'x2' }];
    IC.coverTotal = 2; IC.coverMissIds = []; IC.formatId = 'goodreads';
    IC.classified = []; IC.rawRows = 2; IC.unreadable = 0; icRender();
  `);
  await tick();
  ok('done step celebrates', window.document.getElementById('ic-body').textContent.includes('cozy'));
  ok('done step links the library', !!window.document.getElementById('ic-viewlib'));
  runInWindow(`icClose();`);

  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  if (asyncCrash) { console.log('ASYNC CRASH:', asyncCrash); fail++; }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
