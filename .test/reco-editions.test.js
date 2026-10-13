// v530: "Recommended for you" — one edition per work, print preferred,
// editions respect the browser's language. Covers the catalog-signal
// mapping (hcBookToCandidate), the pure audio/language detection, the
// work-grouping key, the preference ordering (collapseRecoWorks), and the
// sweep itself with a stubbed Hardcover endpoint (extended query shape,
// per-author schema-drift fallback, and the pre-existing dismissal /
// in-library / merch filters still applying before the collapse).
//
// Fixture provenance: the raw book objects below mirror the field shapes
// of Hardcover's official GraphQL schema documentation
// (github.com/hardcoverapp/hardcover-docs — Books schema field table:
// audio_seconds, default_audio_edition_id, default_physical_edition_id,
// default_ebook_edition_id; Editions example queries: language { language }),
// verified 2026-10-13. Values are invented/sanitized, not copied responses.
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
// Evaluate an expression with a fixture object injected as `x`.
const getX = (expr, x) => { window.__x = x; return get(expr.replace(/\bX\b/g, '__x')); };

// A Hardcover books-table row, schema-shaped. Overrides per case.
const hcBook = (over) => Object.assign({
  id: 1,
  title: 'Iron Flame',
  description: 'Dragons at war.',
  pages: 623,
  release_date: '2023-11-07',
  audio_seconds: null,
  default_audio_edition_id: null,
  default_physical_edition_id: 555,
  default_ebook_edition_id: 556,
  image: { url: 'https://img.example/iron-flame.jpg' },
  contributions: [{ author: { name: 'Rebecca Yarros' } }],
  default_physical_edition: { isbn_13: '9781649374180', language: { language: 'English' } },
  default_cover_edition: { language: { language: 'English' } },
}, over || {});
// An audiobook record of the same work: no physical/ebook default, an
// audio default + duration, language only via the cover edition.
const hcAudio = (over) => hcBook(Object.assign({
  id: 2,
  audio_seconds: 91200,
  default_audio_edition_id: 777,
  default_physical_edition_id: null,
  default_ebook_edition_id: null,
  default_physical_edition: null,
  pages: null,
  contributions: [{ author: { name: 'Rebecca Yarros' } }, { author: { name: 'Teddy Hamilton' } }],
}, over || {}));

(async () => {
  // ---- hcBookToCandidate: signal mapping ----
  const cPrint = getX('hcBookToCandidate(X)', hcBook());
  ok('cand: audioSeconds null on print', cPrint.audioSeconds === null);
  ok('cand: def ids mapped', cPrint.defAudioId === null && cPrint.defPhysId === 555 && cPrint.defEbookId === 556);
  ok('cand: language from physical edition', cPrint.langName === 'English');
  ok('cand: isbn still from physical edition', cPrint.isbns[0] === '9781649374180');
  const cAudio = getX('hcBookToCandidate(X)', hcAudio());
  ok('cand: audioSeconds mapped', cAudio.audioSeconds === 91200);
  ok('cand: language falls back to cover edition', cAudio.langName === 'English');
  ok('cand: audio record has no isbn', cAudio.isbns.length === 0);
  const cBare = getX('hcBookToCandidate(X)', { id: 9, title: 'Bare' });
  ok('cand: absent signals read as null/empty',
    cBare.audioSeconds === null && cBare.defAudioId === null && cBare.defPhysId === null &&
    cBare.defEbookId === null && cBare.langName === '');

  // ---- recoLangCode ----
  ok('lang: English → en', get('recoLangCode("English")') === 'en');
  ok('lang: French → fr', get('recoLangCode("French")') === 'fr');
  ok('lang: German → de', get('recoLangCode("German")') === 'de');
  ok('lang: Japanese → ja', get('recoLangCode("Japanese")') === 'ja');
  ok('lang: endonym Deutsch → de', get('recoLangCode("Deutsch")') === 'de');
  ok('lang: code en → en', get('recoLangCode("en")') === 'en');
  ok('lang: code eng → en', get('recoLangCode("eng")') === 'en');
  ok('lang: code fra → fr', get('recoLangCode("fra")') === 'fr');
  ok('lang: empty → null (unknown)', get('recoLangCode("")') === null);
  ok('lang: null → null (unknown)', get('recoLangCode(null)') === null);
  const klingon = get('recoLangCode("Klingon")');
  ok('lang: unmapped name is KNOWN (not null, never en/fr)',
    klingon !== null && klingon !== 'en' && klingon !== 'fr');

  // ---- recoIsAudioRecord ----
  ok('audio: audio_seconds > 0', getX('recoIsAudioRecord(X)', cAudio) === true);
  ok('audio: audio-default-only (no duration)',
    getX('recoIsAudioRecord(X)', { audioSeconds: null, defAudioId: 5, defPhysId: null, defEbookId: null, title: 'T', authors: [] }) === true);
  ok('audio: main record with audio default is NOT audio',
    getX('recoIsAudioRecord(X)', { audioSeconds: null, defAudioId: 5, defPhysId: 6, defEbookId: null, title: 'T', authors: [] }) === false);
  ok('audio: plain print is not audio', getX('recoIsAudioRecord(X)', cPrint) === false);
  ok('audio: title "(Audiobook)" fallback',
    getX('recoIsAudioRecord(X)', { audioSeconds: null, defAudioId: null, defPhysId: 6, defEbookId: null, title: 'T (Audiobook)', authors: [] }) === true);
  ok('audio: title "Unabridged" fallback',
    getX('recoIsAudioRecord(X)', { audioSeconds: null, defAudioId: null, defPhysId: 6, defEbookId: null, title: 'T: Unabridged', authors: [] }) === true);
  ok('audio: Full Cast contributor fallback',
    getX('recoIsAudioRecord(X)', { audioSeconds: null, defAudioId: null, defPhysId: null, defEbookId: null, title: 'T', authors: ['Ann A', 'Full Cast'] }) === true);
  ok('audio: null → false', get('recoIsAudioRecord(null)') === false);

  // ---- recoEditionRank: the preference order ----
  const unkPrint = { langName: '', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, title: 'T', authors: [] };
  const unkAudio = { langName: '', audioSeconds: 60, defAudioId: 2, defPhysId: null, defEbookId: null, title: 'T', authors: [] };
  const frPrint = { langName: 'French', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, title: 'T', authors: [] };
  ok('rank: browser-lang print = 0', getX('recoEditionRank(X, "en")', cPrint) === 0);
  ok('rank: browser-lang audio = 1', getX('recoEditionRank(X, "en")', cAudio) === 1);
  ok('rank: unknown-lang print = 2', getX('recoEditionRank(X, "en")', unkPrint) === 2);
  ok('rank: unknown-lang audio = 3', getX('recoEditionRank(X, "en")', unkAudio) === 3);
  ok('rank: known mismatch excluded (-1)', getX('recoEditionRank(X, "en")', frPrint) === -1);
  ok('rank: fr record kept for an fr browser', getX('recoEditionRank(X, "fr")', frPrint) === 0);
  ok('rank: no browser language → nothing excluded', getX('recoEditionRank(X, "")', frPrint) === 2);

  // ---- recoWorkKey: grouping, incl. messy titles ----
  const key = (t, a) => getX('recoWorkKey(X)', { title: t, authors: [a || 'Rebecca Yarros'] });
  ok('key: "(Audiobook)" groups with plain title', key('Iron Flame (Audiobook)') === key('Iron Flame'));
  ok('key: "[Dramatized Adaptation]" groups', key('Iron Flame [Dramatized Adaptation]') === key('Iron Flame'));
  ok('key: trailing "- Audiobook" groups', key('Iron Flame - Audiobook') === key('Iron Flame'));
  ok('key: leading The dropped', key('The Name of the Wind', 'Patrick Rothfuss') === key('Name of the Wind', 'Patrick Rothfuss'));
  ok('key: series entries stay distinct',
    key('Mistborn - The Final Empire', 'Brandon Sanderson') !== key('Mistborn - The Well of Ascension', 'Brandon Sanderson'));
  ok('key: different author, different work', key('Iron Flame') !== key('Iron Flame', 'Someone Else'));
  ok('key: empty title → ""', key('') === '');

  // ---- collapseRecoWorks ----
  const collapse = (list, want) => getX('collapseRecoWorks(X, ' + JSON.stringify(want || 'en') + ')', list);
  const frAudio = { title: 'Iron Flame', authors: ['Rebecca Yarros'], langName: 'French', audioSeconds: 60, defAudioId: 3, defPhysId: null, defEbookId: null };
  const enPrint2 = Object.assign({}, cPrint, { hcId: 101 });
  const enAudio2 = Object.assign({}, cAudio, { hcId: 102 });
  let out = collapse([enAudio2, enPrint2], 'en');
  ok('collapse: print beats audio for the same work', out.length === 1 && out[0].hcId === 101);
  out = collapse([enAudio2, Object.assign({}, enAudio2, { hcId: 103 })], 'en');
  ok('collapse: audio-only work survives, once', out.length === 1 && out[0].hcId === 102);
  out = collapse([frAudio], 'en');
  ok('collapse: fr-only work excluded for en browser', out.length === 0);
  out = collapse([frAudio], 'fr');
  ok('collapse: same logic keeps it for an fr browser', out.length === 1);
  out = collapse([frAudio, enAudio2], 'en');
  ok('collapse: mismatch dropped, matching record of work kept', out.length === 1 && out[0].hcId === 102);
  const unkPrintT = { title: 'Other Book', authors: ['Ann A'], langName: '', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, hcId: 201 };
  const enAudioT = { title: 'Other Book', authors: ['Ann A'], langName: 'English', audioSeconds: 5, defAudioId: 2, defPhysId: null, defEbookId: null, hcId: 202 };
  out = collapse([unkPrintT, enAudioT], 'en');
  ok('collapse: browser-lang audio beats unknown-lang print', out.length === 1 && out[0].hcId === 202);
  const unkAudioT = Object.assign({}, enAudioT, { langName: '', hcId: 203 });
  out = collapse([unkAudioT, unkPrintT], 'en');
  ok('collapse: unknown-lang print beats unknown-lang audio', out.length === 1 && out[0].hcId === 201);
  out = collapse([
    { title: 'Zulu', authors: ['Ann A'], langName: 'English', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, hcId: 301 },
    enAudio2, enPrint2,
    { title: 'Alpha', authors: ['Bob B'], langName: 'English', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, hcId: 302 },
  ], 'en');
  ok('collapse: works keep first-appearance order', JSON.stringify(out.map(c => c.hcId)) === '[301,101,302]');
  ok('collapse: empty → []', get('collapseRecoWorks([], "en").length') === 0);
  ok('collapse: null → []', get('collapseRecoWorks(null, "en").length') === 0);

  // ---- recoBrowserLang ----
  ok('browser lang: primary subtag of navigator.language',
    get('recoBrowserLang()') === window.navigator.language.split('-')[0].toLowerCase());

  // ---- sweepRecoCandidates end-to-end (stubbed Hardcover) ----
  runInWindow('library = []');
  const rawPrint = hcBook();
  const rawAudio = hcAudio();
  const rawFr = hcBook({ id: 3, title: 'Alas de Hierro', default_physical_edition: { isbn_13: '9788408292528', language: { language: 'Spanish' } }, default_cover_edition: { language: { language: 'Spanish' } } });
  const rawMerch = hcBook({ id: 4, title: 'Iron Flame Tarot Deck' });
  const rawOwned = hcBook({ id: 5, title: 'Fourth Wing' });
  const rawDismissed = hcBook({ id: 6, title: 'Onyx Storm' });
  runInWindow('library = [{ title: "Fourth Wing", authors: ["Rebecca Yarros"], isbn: "" }]');
  window.__queries = [];
  runInWindow('hcGraphQL = async (q) => { window.__queries.push(q);' +
    ' return { books: ' + JSON.stringify([rawAudio, rawPrint, rawFr, rawMerch, rawOwned, rawDismissed]) + ' }; };');
  const swept = await get('sweepRecoCandidates(["Rebecca Yarros"], new Set(["hc:6"]))');
  ok('sweep: one edition per work (audio + print + translation collapse)',
    swept.length === 1 && swept[0].hcId === 1);
  ok('sweep: survivor is the print record', swept.length === 1 && swept[0].title === 'Iron Flame');
  ok('sweep: extended query requests the edition signals',
    window.__queries.length === 1 && window.__queries[0].indexOf('audio_seconds') !== -1 &&
    window.__queries[0].indexOf('language { language }') !== -1);
  ok('sweep: loveAuthor tagged', swept.length === 1 && swept[0].loveAuthor === 'Rebecca Yarros');

  // Schema drift: the extended query is rejected — the sweep must retry
  // with the legacy field set and still collapse (title signals only).
  window.__queries = [];
  runInWindow('hcGraphQL = async (q) => { window.__queries.push(q);' +
    ' if (q.indexOf("audio_seconds") !== -1) throw new Error("field drift");' +
    ' return { books: [' +
    '   { id: 2, title: "Iron Flame (Audiobook)", contributions: [{author:{name:"Rebecca Yarros"}}], image: {}, default_physical_edition: {} },' +
    '   { id: 1, title: "Iron Flame", contributions: [{author:{name:"Rebecca Yarros"}}], image: {}, default_physical_edition: {} }' +
    ' ] }; };');
  const sweptDrift = await get('sweepRecoCandidates(["Rebecca Yarros"], new Set())');
  ok('drift: legacy fallback used after extended query fails',
    window.__queries.length === 2 && window.__queries[1].indexOf('audio_seconds') === -1);
  ok('drift: fallback path still collapses to one edition',
    sweptDrift.length === 1 && sweptDrift[0].hcId === 1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
