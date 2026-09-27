// Translated-title repair (v115): Open Library work records created from a
// translated edition carry the foreign title ("Alas de ónix"); the lookup
// must prefer the English edition's title.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

const olDocs = [
  { key: '/works/OL41943074W', title: 'Alas de ónix', author_name: ['Rebecca Yarros'], isbn: ['9788408278848'], cover_i: 1, language: ['spa', 'ger', 'eng', 'dut'] },
  { key: '/works/OL44311526W', title: 'Onyx Storm', author_name: ['Rebecca Yarros'], isbn: ['9781649374189'], cover_i: 2, language: ['tur'] },
  { key: '/works/OL999', title: 'The Last Letter', author_name: ['Rebecca Yarros'], isbn: ['9781635764333'], cover_i: 3, language: ['eng'] },
  { key: '/works/OL1000', title: 'Cien años', author_name: ['Rebecca Yarros'], isbn: ['9788408000000'], cover_i: 4, language: ['spa'] },
];
const editions = {
  '/works/OL41943074W': { entries: [
    { title: 'Alas de ónix', languages: [{ key: '/languages/spa' }] },
    { title: 'Onyx Storm', languages: [{ key: '/languages/eng' }] },
  ] },
};
let editionFetches = 0;
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/editions.json')) {
    editionFetches++;
    const wk = u.replace('https://openlibrary.org', '').split('/editions.json')[0];
    return { json: async () => editions[wk] || { entries: [] } };
  }
  return { json: async () => ({ docs: olDocs }) };
};

(async () => {
  runInWindow(`library = []; authorCache.clear();`);
  const rows = await window.fetchMoreByAuthor('Rebecca Yarros');
  const titles = rows.map(r => r.title);
  ok('Spanish work title repaired to the English edition title',
    titles.includes('Onyx Storm') && !titles.includes('Alas de ónix'));
  ok('duplicate works collapse after repair (one Onyx Storm)',
    titles.filter(t => t === 'Onyx Storm').length === 1);
  ok('plain-English titles untouched', titles.includes('The Last Letter'));
  ok('non-ASCII title with no English edition keeps its title', titles.includes('Cien años'));
  ok('editions fetched only for the repairable suspect', editionFetches === 1);

  // inLibrary now matches on the repaired title
  runInWindow(`
    library = [{ id: 'o1', title: 'Onyx Storm', authors: ['Rebecca Yarros'], status: 'tbr', owned: false, cover: '', tropes: [] }];
    authorCache.clear();
  `);
  const rows2 = await window.fetchMoreByAuthor('Rebecca Yarros');
  ok('repaired title matches her shelf (no phantom missing row)',
    !rows2.map(r => r.title).includes('Onyx Storm'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
