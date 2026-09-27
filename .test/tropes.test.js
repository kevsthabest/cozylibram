// v81: automatic trope suggestions — keyword scan + Hardcover community tags,
// with a Settings source switch. Suggestions must never overwrite book.tropes.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const get = (js) => { runInWindow('window.__v = (' + js + ');'); return window.__v; };

const BLURB = 'A mafia prince falls for his enemy — forced proximity in a world of stalkers, ' +
  'kidnapping plots and arranged marriages. She wants revenge; he is her captive bodyguard.';

(async () => {
  // source setting
  runInWindow('localStorage.removeItem("spicyshelves.tropesrc");');
  ok('default source is both', get('tropeSource()') === 'both');
  runInWindow('setTropeSource("keywords");');
  ok('setting persists', window.localStorage.getItem('spicyshelves.tropesrc') === 'keywords' && get('tropeSource()') === 'keywords');
  runInWindow('setTropeSource("bogus");');
  ok('invalid source ignored', get('tropeSource()') === 'keywords');
  runInWindow('setTropeSource("both");');

  // keyword scan
  const hits = get('scanTropesFromText(' + JSON.stringify(BLURB) + ')');
  ok('scan finds mafia romance', hits.includes('mafia romance'));
  ok('scan finds forced proximity', hits.includes('forced proximity'));
  ok('scan finds stalker', hits.includes('stalker'));
  ok('scan finds kidnapping', hits.includes('kidnapping'));
  ok('scan finds arranged marriage', hits.includes('arranged marriage'));
  ok('scan finds revenge', hits.includes('revenge'));
  ok('scan finds captive', hits.includes('captive'));
  ok('scan finds bodyguard', hits.includes('bodyguard'));
  ok('scan is case-insensitive', get('scanTropesFromText("ENEMIES TO LOVERS story")').includes('enemies to lovers'));
  ok('scan finds nothing in plain text', get('scanTropesFromText("A quiet story about a garden and a train.")').length === 0);
  ok('scan returns no duplicates', (() => {
    const h = get('scanTropesFromText("mafia mafia MAFIA prince")');
    return h.filter(x => x === 'mafia romance').length === 1;
  })());
  ok('scan caps at 8', get('scanTropesFromText(' + JSON.stringify(BLURB + ' enemies to lovers, billionaire biker vampire werewolf fated mates academy amnesia pregnancy royalty secret baby second chance') + ')').length === 8);
  ok('empty text -> empty', get('scanTropesFromText("")').length === 0 && get('scanTropesFromText(null)').length === 0);

  // tag cleaning
  ok('genre words filtered', get('cleanTag("romance")') === null && get('cleanTag("Dark Romance")') === null);
  ok('hash stripped', get('cleanTag("#mafia")') === 'mafia');
  ok('long tags rejected', get('cleanTag("a".repeat(40))') === null);
  ok('trope-ish tag kept', get('cleanTag("Enemies to Lovers")') === 'enemies to lovers');
  ok('cached_tags array of objects normalized',
    JSON.stringify(get('normalizeCachedTags([{tag:"mafia"},{name:"stalker"},"plain"])')) === JSON.stringify(['mafia', 'stalker', 'plain']));
  ok('cached_tags object shape uses keys',
    JSON.stringify(get('normalizeCachedTags({mafia: 12, stalker: 3})')) === JSON.stringify(['mafia', 'stalker']));

  // refresh: off
  runInWindow('setTropeSource("off"); window.__b = { tropes: ["my pick"], description: ' + JSON.stringify(BLURB) + ' };');
  runInWindow('refreshTropeSuggestions(window.__b).then(r => { window.__r = r; });');
  await new Promise(r => setTimeout(r, 30));
  ok('source off -> no suggestions', window.__r.length === 0 && window.__b.tropesAuto.length === 0);
  ok('manual tropes untouched when off', JSON.stringify(window.__b.tropes) === JSON.stringify(['my pick']));

  // refresh: keywords
  runInWindow('setTropeSource("keywords"); window.__b2 = { tropes: ["my pick"], description: ' + JSON.stringify(BLURB) + ', title: "Test" };');
  runInWindow('refreshTropeSuggestions(window.__b2).then(r => { window.__r2 = r; });');
  await new Promise(r => setTimeout(r, 30));
  ok('keywords source scans the blurb', window.__r2.includes('mafia romance') && window.__r2.includes('forced proximity'));
  ok('tropeSrc stamped', window.__b2.tropeSrc === 'keywords');
  ok('manual tropes never clobbered', JSON.stringify(window.__b2.tropes) === JSON.stringify(['my pick']));

  // refresh: hardcover via cached_tags (mocked), no token needed for doc tags
  runInWindow('window.SPICY_CONFIG = {};'); // no token
  runInWindow('window.__b3 = { tropes: [], description: "nothing here", _hcDocTags: ["mafia", "Romance", "enemies to lovers"] };');
  runInWindow('setTropeSource("hardcover"); refreshTropeSuggestions(window.__b3).then(r => { window.__r3 = r; });');
  await new Promise(r => setTimeout(r, 30));
  ok('doc tags suggested without token', window.__r3.includes('mafia') && window.__r3.includes('enemies to lovers'));
  ok('genre tag filtered from doc tags', !window.__r3.includes('romance'));
  ok('transient doc tags cleaned up', !('_hcDocTags' in window.__b3));

  // hardcover books query via hcId (mocked hcGraphQL)
  runInWindow('window.SPICY_CONFIG = { hardcover: true };');
  runInWindow('window.hcGraphQL = async () => ({ books: [{ cached_tags: ["forced proximity", "Fiction", "#stalker"] }] });');
  runInWindow('window.__b4 = { tropes: [], description: "", hcId: 123 };');
  runInWindow('refreshTropeSuggestions(window.__b4).then(r => { window.__r4 = r; });');
  await new Promise(r => setTimeout(r, 50));
  ok('cached_tags pulled via hcId', window.__r4.includes('forced proximity') && window.__r4.includes('stalker'));
  ok('junk cached_tags filtered', !window.__r4.includes('fiction'));

  // hardcover failure degrades gracefully, keywords still work under "both"
  runInWindow('window.hcGraphQL = async () => { throw new Error("nope"); };');
  runInWindow('setTropeSource("both"); window.__b5 = { tropes: [], description: ' + JSON.stringify(BLURB) + ', hcId: 123 };');
  runInWindow('refreshTropeSuggestions(window.__b5).then(r => { window.__r5 = r; });');
  await new Promise(r => setTimeout(r, 50));
  ok('hardcover failure does not kill keyword suggestions', window.__r5.includes('mafia romance'));

  // migration
  runInWindow('window.__m = {}; migrateBook(window.__m);');
  ok('migrateBook adds tropesAuto', Array.isArray(window.__m.tropesAuto));

  // settings UI renders the four-way switch
  runInWindow('go("settings");');
  await new Promise(r => setTimeout(r, 30));
  const seg = window.document.getElementById('trope-srcseg');
  ok('settings shows the trope source switch', !!seg && seg.querySelectorAll('button').length === 4);
  ok('switch reflects the active source', !!seg.querySelector('button[data-t="both"].active'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
