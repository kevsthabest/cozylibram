// Author missing-list cleanup (v116): loose dedupe, foreign-only drop,
// junk filter, mashed-title filter, Hardcover foreign resolution, cover backfill.
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
  { key: '/works/OL1', title: 'Hallowed Ground - Flight & Glory #4', author_name: ['Rebecca Yarros'], isbn: ['9780000000001'], cover_i: 11, language: ['eng'] },
  { key: '/works/OL2', title: 'Hallowed ground', author_name: ['Rebecca Yarros'], isbn: ['9780000000002'], language: ['eng'] },
  { key: '/works/OL3', title: 'The Reality of Everything', author_name: ['Rebecca Yarros'], isbn: ['9780000000003'], cover_i: 13, language: ['eng'] },
  { key: '/works/OL4', title: 'Reality of Everything - Flight & Glory #5', author_name: ['Rebecca Yarros'], isbn: ['9780000000004'], language: ['eng'] },
  { key: '/works/OL5', title: 'Alas de ónix (Empíreo 3)', author_name: ['Rebecca Yarros'], isbn: ['9780000000005'], cover_i: 15, language: ['spa'] },
  { key: '/works/OL6', title: 'Untitled Empyrean (Not Book Four)', author_name: ['Rebecca Yarros'], language: ['eng'] },
  { key: '/works/OL7', title: 'Empyrean Series, 3 Books Collection Set', author_name: ['Rebecca Yarros'], language: ['eng'] },
  { key: '/works/OL8', title: 'Fourth Wing Tarot', author_name: ['Rebecca Yarros'], language: ['eng'] },
  { key: '/works/OL9', title: 'Great and Precious Things', author_name: ['Rebecca Yarros'], cover_i: 19, language: ['eng'] },
  { key: '/works/OL10', title: 'The Last Letter', author_name: ['Rebecca Yarros'], cover_i: 20, language: ['eng'] },
  { key: '/works/OL11', title: 'Great and Precious Things The Last Letter', author_name: ['Rebecca Yarros'], language: ['eng'] },
  { key: '/works/OL12', title: 'Alas de sangre (Empíreo 1)', author_name: ['Rebecca Yarros'], isbn: ['9788408279990'], language: null },
  { key: '/works/OL13', title: 'Threshing Day', author_name: ['Rebecca Yarros'], isbn: ['9780000000013'], language: null },
];
const editionCovers = { '/works/OL13': { entries: [{ title: 'Threshing Day', covers: [4242] }] } };
let editionFetches = 0;
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/editions.json')) {
    editionFetches++;
    const wk = u.replace('https://openlibrary.org', '').split('/editions.json')[0];
    return { json: async () => editionCovers[wk] || { entries: [] } };
  }
  return { json: async () => ({ docs: olDocs }) };
};
window.hcReady = () => true;
window.hcGraphQL = async () => ({
  books: [{ title: 'Fourth Wing', image: { url: 'https://hc/cover.jpg' },
            editions: [{ isbn_13: '9788408279990' }] }],
});

(async () => {
  runInWindow(`library = []; authorCache.clear();`);
  const rows = await window.fetchMoreByAuthor('Rebecca Yarros');
  const titles = rows.map(r => r.title);

  ok('subtitle variants collapse (one Hallowed Ground)',
    titles.filter(t => /hallowed ground/i.test(t)).length === 1);
  ok('leading-The variants collapse (one Reality of Everything)',
    titles.filter(t => /reality of everything/i.test(t)).length === 1);
  ok('foreign-only work dropped', !titles.some(t => /Empíreo 3/.test(t)));
  ok('junk titles dropped (untitled / box set / tarot)',
    !titles.some(t => /untitled|collection set|tarot/i.test(t)));
  ok('mashed title dropped', !titles.some(t => /Things The Last Letter/.test(t)));
  ok('its component books survive', titles.includes('Great and Precious Things') && titles.includes('The Last Letter'));
  ok('foreign work resolved via Hardcover ISBN', titles.includes('Fourth Wing'));
  const fw = rows.find(r => r.title === 'Fourth Wing');
  ok('resolved row takes the Hardcover cover', fw && fw.cover === 'https://hc/cover.jpg');
  const td = rows.find(r => r.title === 'Threshing Day');
  ok('coverless row backfilled from its editions',
    !!td && td.cover === 'https://covers.openlibrary.org/b/id/4242-M.jpg');
  ok('editions endpoint hit only for the coverless survivor', editionFetches === 1);

  // Resolved foreign title matches her shelf -> not "missing"
  runInWindow(`
    library = [{ id: 'f1', title: 'Fourth Wing', authors: ['Rebecca Yarros'], status: 'read', owned: true, cover: '', tropes: [] }];
    authorCache.clear();
  `);
  const rows2 = await window.fetchMoreByAuthor('Rebecca Yarros');
  ok('translated duplicate of an owned book is not listed as missing',
    !rows2.map(r => r.title).includes('Fourth Wing'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
