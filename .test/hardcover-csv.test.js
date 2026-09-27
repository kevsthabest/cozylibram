// Hardcover CSV import (v105): format detection + parseHardcoverCSV mapping.
// Hardcover export: hardcover.app → Settings → Export Your Data → CSV.
// Columns: Title, Author, Series ("Name (#1.0)"), Status, ISBN 10/13, Pages,
// Publisher, Publish Date, Genres, Moods, Tags, Content Warnings,
// Date Added/Started/Finished, Rating, Review, Private Notes, Owned.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in hardcover-csv tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const HEADER = 'Title,Author,Series,Status,Privacy,Hardcover Book ID,Hardcover Edition ID,ISBN 10,ISBN 13,ASIN,Media,Country Code,Language Code,Binding,Pages,Duration in Seconds,Publish Date,Publisher,Genres,Moods,Tags,Content Warnings,Lists,Date Added,Date Started,Date Finished,Rating,Review,Review Contains Spoilers,Sponsored Review,Review Date,Review URL,Review Media URL,Private Notes,Owned,Compilation,Review Slate\n';
const row = (vals) => {
  const cells = new Array(38).fill('');
  const put = (name, v) => { cells[HEADER.split(',').indexOf(name)] = v; };
  for (const [k, v] of Object.entries(vals)) put(k, v);
  return cells.map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',') + '\n';
};
const HC_CSV = HEADER +
  row({ Title: 'Rules Of Prey', Author: 'John Sandford', Series: 'Lucas Davenport (#1.0)', Status: 'Read', 'Hardcover Book ID': '440262', 'ISBN 10': '0786508531', 'ISBN 13': '9780786508532', Media: 'Ebook', Pages: '370', 'Publish Date': '1989-07-24', Publisher: 'Berkley Books', 'Date Added': '2026-02-23', 'Date Finished': '2026-07-17', Rating: '4', Review: 'Gripping.', 'Private Notes': 'reread?', Owned: 'false' }) +
  row({ Title: 'The Girl with the Dragon Tattoo', Author: 'Reg Keeland, Stieg Larsson', Series: 'Millennium (#1.0)', Status: 'Want to Read', 'Hardcover Book ID': '9', 'ISBN 13': '9780307269751', Pages: '656', Moods: 'dark, tense', Tags: 'mystery; nordic-noir', 'Content Warnings': 'violence', 'Date Added': '2026-07-17', Owned: 'true' }) +
  row({ Title: 'The Chase', Author: 'Clive Cussler', Status: 'Currently Reading', 'Hardcover Book ID': '10', 'ISBN 10': '0399152458', Pages: '434', 'Date Added': '2026-07-20', 'Date Finished': '2026-07-20' }) +
  row({ Title: 'Unfinished Tales', Author: 'J.R.R. Tolkien', Status: 'Did Not Finish', 'Hardcover Book ID': '11', 'ISBN 13': '9780618126983', 'Date Added': '2026-01-01' }) +
  row({ Title: 'Paused Book', Author: 'Some Author', Status: 'Paused', 'Hardcover Book ID': '12', 'ISBN 13': '9780000000002', 'Date Added': '2026-01-02' }) +
  row({ Title: 'Ignored Book', Author: 'Some Author', Status: 'Ignored', 'Hardcover Book ID': '13', 'ISBN 13': '9780000000003', 'Date Added': '2026-01-03' });

const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

(async () => {
  // 1. detection
  ok('detects Hardcover CSV', window.detectImportFormat(HC_CSV, 'hardcover-export.csv').id === 'hardcover');
  runInWindow('window.__hcRegistered = IMPORT_FORMATS.some(f => f.id === "hardcover");');
  ok('Hardcover registered in IMPORT_FORMATS', window.__hcRegistered === true);

  // 2. parsing
  const books = window.parseHardcoverCSV(HC_CSV);
  ok('Ignored rows are dropped', books.length === 5 && !books.some(b => b.title === 'Ignored Book'));

  const byTitle = {};
  books.forEach(b => { byTitle[b.title] = b; });

  const rules = byTitle['Rules Of Prey'];
  ok('status Read → read', rules.status === 'read');
  ok('ISBN 13 preferred over ISBN 10', rules.isbn === '9780786508532');
  ok('series parsed: name + position', rules.series && rules.series.name === 'Lucas Davenport' && rules.series.position === 1);
  ok('rating kept', rules.myRating === 4);
  ok('pages → pageCount', rules.pageCount === 370);
  ok('read book gets progress = pages', rules.progress === 370);
  ok('dateFinished parsed', String(rules.dateFinished).startsWith('2026-07-17'));
  ok('publisher + publishDate kept', rules.publisher === 'Berkley Books' && String(rules.publishedDate).startsWith('1989-07-24'));
  ok('review + private notes joined', rules.notes === 'Gripping.\n\nreread?');
  ok('Owned=false → tobuy', rules.owned === 'tobuy');

  const dragon = byTitle['The Girl with the Dragon Tattoo'];
  ok('status Want to Read → tbr', dragon.status === 'tbr');
  ok('authors split on comma', JSON.stringify(dragon.authors) === JSON.stringify(['Reg Keeland', 'Stieg Larsson']));
  ok('moods + tags merge into tropes', JSON.stringify(dragon.tropes.slice().sort()) === JSON.stringify(['dark', 'mystery', 'nordic-noir', 'tense']));
  ok('content warnings kept', JSON.stringify(dragon.contentWarnings) === JSON.stringify(['violence']));
  ok('Owned=true → owned', dragon.owned === 'owned');
  ok('unread book has no progress', dragon.progress === 0);

  const chase = byTitle['The Chase'];
  ok('status Currently Reading → reading', chase.status === 'reading');
  ok('ISBN 10 fallback', chase.isbn === '0399152458');
  ok('no series → null', chase.series === null);

  ok('status Did Not Finish → dnf', byTitle['Unfinished Tales'].status === 'dnf');
  ok('status Paused → reading', byTitle['Paused Book'].status === 'reading');

  // 3. unknown status defaults to tbr, rating clamps
  const weird = window.parseHardcoverCSV(HEADER + row({ Title: 'Weird', Author: 'A', Status: 'Something Else', 'Hardcover Book ID': '99', Rating: '99', 'ISBN 13': '9780000000099' }));
  ok('unknown status → tbr', weird[0].status === 'tbr');
  ok('rating clamps to 5', weird[0].myRating === 5);

  // 4. validate against Kevin's real export (if present — never committed to the repo)
  const realPath = '/home/hatch/workspace/user/files/hardcover-export-3327_14_9uu1.csv';
  if (fs.existsSync(realPath)) {
    const realText = fs.readFileSync(realPath, 'utf8');
    ok('real export detected as hardcover', window.detectImportFormat(realText, 'hardcover-export.csv').id === 'hardcover');
    const real = window.parseHardcoverCSV(realText);
    ok('real export: all 12 rows parse', real.length === 12);
    ok('real export: statuses map cleanly',
      real.every(b => ['tbr', 'reading', 'read', 'dnf'].includes(b.status)));
    ok('real export: ISBN-less rows still parse (dedup falls back to title+author)',
      real.every(b => b.title && (b.isbn || b.authors.length)));
    ok('real export: series parsed where present',
      real.filter(b => b.series).every(b => b.series.name && b.series.position != null));
    ok('real export: multi-author row splits',
      real.some(b => b.authors.length > 1));
    ok('real export: dates parse',
      real.every(b => !b.dateFinished || !isNaN(Date.parse(b.dateFinished))));
  } else {
    console.log('(skip) real Hardcover export not present — synthetic fixture covers the format');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
