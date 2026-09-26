// Bulk ISBN import + unified import hub: ISBN parsing, CSV parsing,
// Goodreads/StoryGraph mapping, format detection, bulk lookup + add.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in import tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const mk = (id) => `({ id: '${id}', isbn: '978${id}', title: 'Book ${id}', authors: ['A'], cover: '',
  description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', owned: true, ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: '' })`;

const GR_CSV = 'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies\r\n' +
  '12345,Iron Flame,"Yarros, Rebecca","Yarros, Rebecca","",\"\",\"9781649374189\",5,4.5,Red Tower,hardcover,623,2023,2023,2024/03/15,2024/01/10,to-read,,read,"Loved it!",,reread soon,1,1\r\n' +
  '67890,"The Name of the Wind","Rothfuss, Patrick","Rothfuss, Patrick","",\"\",\"9780756404741\",0,4.54,DAW,hardcover,662,2007,2007,,2024/02/01,to-read,,to-read,,,,0,0\r\n';

const SG_CSV = 'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Character- or Plot-Driven?,Strong Character Development?,Loveable Characters?,Diverse Characters?,Flawed Characters?,Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?\n' +
  'Fourth Wing,Rebecca Yarros,,9781649374045,hardcover,read,2024/01/10,2024/02/01,"2024/01/10-2024/02/01",1,"adventurous, emotional",fast,,,,,,4.5,Great read!,Violence,,dragons,yes\n' +
  'Some Book,Some Author,,12345,ebook,to-read,2024/05/01,,,,,,,,,,,,,0,,,"",no\n';

(async () => {
  // 1. parseISBNList
  const p = window.parseISBNList('978-1-4028-9462-6\n9780756404741, 9780756404741\n12345\n9781649374045;bad');
  ok('parseISBNList cleans + dedupes',
    JSON.stringify(p) === JSON.stringify(['9781402894626', '9780756404741', '9781649374045']));
  ok('parseISBNList rejects short codes', window.parseISBNList('12345 abc').length === 0);
  ok('parseISBNList handles ISBN-10', window.parseISBNList('0-306-40615-2').join(',') === '0306406152');

  // 2. parseCSV edge cases
  const rows = window.parseCSV('﻿a,b,c\r\n"1, x","say ""hi""",3\r\n4,5,6');
  ok('CSV strips BOM', rows[0][0] === 'a');
  ok('CSV handles quoted commas', rows[1][0] === '1, x');
  ok('CSV handles escaped quotes', rows[1][1] === 'say "hi"');
  ok('CSV handles CRLF', rows.length === 3);

  // 3. Goodreads mapping
  const gr = window.parseGoodreadsCSV(GR_CSV);
  ok('Goodreads parses 2 rows', gr.length === 2);
  ok('GR title + ISBN13', gr[0].title === 'Iron Flame' && gr[0].isbn === '9781649374189');
  ok('GR author Last, First → First Last', gr[0].authors.join(',') === 'Rebecca Yarros');
  ok('GR shelf read → read + progress filled', gr[0].status === 'read' && gr[0].progress === 623);
  ok('GR shelf to-read → tbr', gr[1].status === 'tbr' && gr[1].progress === 0);
  ok('GR rating + pages + owned', gr[0].myRating === 5 && gr[0].pageCount === 623 && gr[0].owned === true);
  ok('GR dates parsed', gr[0].dateFinished.startsWith('2024-03-15') && gr[0].dateAdded.startsWith('2024-01-10'));
  ok('GR review + private notes joined', gr[0].notes === 'Loved it!\n\nreread soon');
  ok('GR unrated → 0', gr[1].myRating === 0);

  // 4. StoryGraph mapping
  const sg = window.parseStoryGraphCSV(SG_CSV);
  ok('StoryGraph parses 2 rows', sg.length === 2);
  ok('SG status + rating + owned', sg[0].status === 'read' && sg[0].myRating === 5 && sg[0].owned === true);
  ok('SG moods+tags → tropes', sg[0].tropes.includes('adventurous') && sg[0].tropes.includes('dragons'));
  ok('SG review → notes', sg[0].notes === 'Great read!');
  ok('SG non-ISBN UID dropped', sg[1].isbn === '');
  ok('SG to-read → tbr', sg[1].status === 'tbr');

  // 5. format detection
  ok('detects Goodreads', window.detectImportFormat(GR_CSV, 'goodreads.csv').id === 'goodreads');
  ok('detects StoryGraph', window.detectImportFormat(SG_CSV, 'export.csv').id === 'storygraph');
  ok('detects ISBN list', window.detectImportFormat('9781649374189\n9780756404741\n9781649374045\n', 'isbns.txt').id === 'isbn-list');
  ok('Bookmory skips text detection (routed by filename in handleImportFile)',
    window.detectImportFormat('???', 'bookmory_backup.db') === null);
  ok('unknown file → null', window.detectImportFormat('hello world', 'notes.txt') === null);

  // 6. bulkLookupISBNs classification (stubbed lookupISBN)
  runInWindow(`
    window.__seen = [];
    lookupISBN = async (isbn) => {
      window.__seen.push(isbn);
      if (isbn === '9780000000001') return { id: 'n1', isbn: isbn, title: 'New Book', authors: ['X'] };
      if (isbn === '9780000000002') return { id: 'd1', isbn: isbn, title: 'Dupe Book', authors: ['Y'] };
      return null;
    };
    library = [${mk('d1').replace(/978d1/, '9780000000002')}];
    library[0].isbn = '9780000000002'; library[0].title = 'Dupe Book'; library[0].authors = ['Y'];
    saveLibrary({noCloud:true});
  `);
  // speed up: bulkLookupISBNs paces 300ms — 3 isbns = 600ms, acceptable
  const res = await window.bulkLookupISBNs(['9780000000001', '9780000000002', '9780000000003']);
  ok('bulk: found classified', res[0].status === 'found' && res[0].book.title === 'New Book');
  ok('bulk: duplicate classified', res[1].status === 'duplicate');
  ok('bulk: missing classified', res[2].status === 'missing');

  // 7. bulkAddBooks: adds new, skips dupes, one toast
  runInWindow(`window.__toasts = []; toast = (m) => window.__toasts.push(m);`);
  runInWindow(`bulkAddBooks([{ id: 'n1', isbn: '9780000000001', title: 'New Book', authors: ['X'] },
    { id: 'd1', isbn: '9780000000002', title: 'Dupe Book', authors: ['Y'] }]);`);
  ok('bulkAddBooks adds only new', window.eval(`library.filter(b => b.id === 'n1').length`) === 1);
  ok('bulkAddBooks skips duplicates', window.eval(`library.filter(b => b.id === 'd1').length`) === 1);
  ok('bulkAddBooks single toast', window.eval(`window.__toasts`).join('|').includes('Added 1 book'));

  // 8. importForeignBooks: dedupe, normalize, order (library was cleared above)
  runInWindow(`library = []; saveLibrary({noCloud:true});`);
  const imp = window.importForeignBooks([
    { title: 'Imported One', authors: ['A One'], isbn: '9781111111111', status: 'read', myRating: 4 },
    { title: 'Book d1', authors: ['Y'], isbn: '9780000000002', status: 'tbr' },
    { title: '', authors: [], isbn: '' },
  ], 'Goodreads');
  ok('importForeignBooks counts', imp.added === 2 && imp.skipped === 1);
  ok('importForeignBooks normalizes', window.eval(`library[0].title`) === 'Imported One' &&
    window.eval(`Array.isArray(library[0].tropes)`) && window.eval(`!!library[0].id`));
  ok('importForeignBooks keeps rating/status', window.eval(`library[0].myRating`) === 4 &&
    window.eval(`library[0].status`) === 'read');

  // 9. handleImportFile end-to-end (Goodreads CSV via FileReader)
  window.document.body.insertAdjacentHTML('beforeend', '<div id="im-result"></div>');
  const file = new window.File([GR_CSV], 'goodreads_library_export.csv', { type: 'text/csv' });
  runInWindow(`library = []; saveLibrary({noCloud:true});`);
  window.handleImportFile(file);
  await tick(120);
  const mountHTML = window.document.getElementById('im-result').innerHTML;
  ok('hub detects + previews Goodreads', mountHTML.includes('Goodreads') && mountHTML.includes('Iron Flame'));
  window.document.getElementById('im-go').click();
  await tick(60);
  ok('hub imports from preview', window.eval(`library.length`) === 2);

  // 10. unrecognized file → friendly message
  const bad = new window.File(['just some notes'], 'notes.txt', { type: 'text/plain' });
  window.handleImportFile(bad);
  await tick(120);
  ok('hub rejects unknown format kindly',
    window.document.getElementById('im-result').innerHTML.includes("Couldn't recognize"));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
