// v530: "Recommended for you" — one edition per work, print preferred,
// editions respect the browser's language. Covers the catalog-signal
// mapping (hcBookToCandidate), the pure audio/language detection, the
// work-grouping key, the preference ordering (collapseRecoWorks), and the
// sweep itself with a stubbed Hardcover endpoint (extended query shape,
// per-author schema-drift fallback, and the pre-existing dismissal /
// in-library / merch filters still applying before the collapse).
//
// v533 additions: omnibus segment-match in releaseInLibrary, the drift
// fallback's AppLog trace, and the stopword language detector for
// records the catalog leaves unstated (fixtures include the real Dutch
// and Italian records observed headlining an English list, Oct 2026).
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

  // ---- v533: releaseInLibrary — omnibus segment match ----
  const henryLib = ['Beach Read', 'People We Meet On Vacation', 'Book Lovers', 'Happy Place']
    .map(t => ({ title: t, authors: ['Emily Henry'], isbn: '' }));
  const omniCand = {
    title: 'Beach Read / People We Meet On Vacation / Book Lovers / Happy Place',
    authors: ['Emily Henry'], isbns: ['9780593440875'], // the bundle's OWN isbn — matches nothing
  };
  runInWindow('library = ' + JSON.stringify(henryLib));
  ok('omnibus: all segments owned by same author → in library', getX('releaseInLibrary(X)', omniCand) === true);
  runInWindow('library = ' + JSON.stringify(henryLib.slice(0, 3)));
  ok('omnibus: one segment unowned → stays recommendable', getX('releaseInLibrary(X)', omniCand) === false);
  runInWindow('library = ' + JSON.stringify(henryLib.map(b => ({ title: b.title, authors: ['Someone Else'], isbn: '' }))));
  ok('omnibus: segments owned by a different author → stays', getX('releaseInLibrary(X)', omniCand) === false);
  runInWindow('library = ' + JSON.stringify(henryLib));
  ok('omnibus: two-segment bundle, all owned → in library',
    getX('releaseInLibrary(X)', { title: 'Beach Read / Book Lovers', authors: ['Emily Henry'], isbns: [] }) === true);
  ok('omnibus: direct single-title match unchanged',
    getX('releaseInLibrary(X)', { title: 'Beach Read', authors: ['Emily Henry'], isbns: [] }) === true);
  ok('omnibus: unowned single title unaffected',
    getX('releaseInLibrary(X)', { title: 'Funny Story', authors: ['Emily Henry'], isbns: [] }) === false);

  // ---- v533: language detection for unstated records ----
  const det = (title, desc) => getX('recoDetectLangCode(X)', { title: title, description: desc || '' });
  // The real records observed live (production probing, 2026-10-13).
  ok('detect: Dutch "Nog één week samen" → nl', det('Nog één week samen') === 'nl');
  ok('detect: Dutch "Zo was het niet bedoeld" → nl', det('Zo was het niet bedoeld') === 'nl');
  ok('detect: Italian Crescent City record title → it', det('Crescent City - La casa di cielo e aria') === 'it');
  // Other languages, via title + description evidence.
  ok('detect: German (Kafka) → de',
    det('Die Verwandlung', 'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheuren Ungeziefer verwandelt.') === 'de');
  ok('detect: French (Hugo) → fr',
    det('Les Misérables', "Jean Valjean est poursuivi par l'inspecteur Javert, qui le traque sans relâche dans les rues de Paris, où il rencontre une enfant que sa mère lui a confiée avant de mourir.") === 'fr');
  ok('detect: Spanish (Zafón) → es',
    det('La sombra del viento', 'Un amanecer de 1945, un muchacho es conducido por su padre a un misterioso lugar oculto en el corazón de la ciudad vieja: el Cementerio de los Libros Olvidados.') === 'es');
  ok('detect: Portuguese (Machado) → pt, not es',
    det('Dom Casmurro', 'Um romance sobre o ciúme: Bentinho conta a sua história, porque ele não sabe se Capitu o traiu, e com as lembranças de uma vida inteira ele ainda não conseguiu esquecer o que passou.') === 'pt');
  // English controls — never a confident foreign call.
  ok('detect: English title with invented words → en', det('The Priory of the Orange Tree') === 'en');
  ok('detect: English title only → en', det('A Court of Thorns and Roses') === 'en');
  ok('detect: English blurb → en',
    det('Mistborn: The Final Empire', 'In a world where ash falls from the sky and mists rule the night, a street urchin discovers she has the power to burn metals and change the fate of an empire that has stood for a thousand years.') === 'en');
  ok('detect: foreign-looking proper nouns, English text → en',
    det('The Shadow of the Wind', "A boy takes a mysterious book from a labyrinthine library and finds that someone is destroying every copy of the author's other works, one by one.") === 'en');
  // Below the bar → unknown (fail-open preserved).
  ok('detect: one-word title "It" → unknown', det('It') === null);
  ok('detect: one-word title "Dune" → unknown', det('Dune') === null);
  ok('detect: short English title below bar → unknown', det('Klara and the Sun') === null);
  ok('detect: lone foreign stopword → unknown', det('Het') === null);
  ok('detect: null candidate → null', get('recoDetectLangCode(null)') === null);

  // ---- v533: stated language always wins over detection ----
  ok('stated wins: mislabeled "Persian" stays fa (documented casualty)',
    getX('recoCandidateLangCode(X)', { langName: 'Persian', title: 'Crown of Midnight', description: 'An English blurb about an assassin and her prince, with the fate of the kingdom in her hands.' }) === 'fa');
  ok('stated wins: Persian-labeled record still excluded for en',
    getX('recoEditionRank(X, "en")', { langName: 'Persian', title: 'Crown of Midnight', description: '', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null }) === -1);
  ok('stated wins: English label beats a Dutch-looking title',
    getX('recoCandidateLangCode(X)', { langName: 'English', title: 'Nog één week samen', description: '' }) === 'en');

  // ---- v533: detected language drives rank + collapse like a stated one ----
  const dutchCand = { title: 'Nog één week samen', authors: ['Marijke Vos'], langName: '', description: '', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, hcId: 401 };
  const italCand = { title: 'Crescent City - La casa di cielo e aria', authors: ['Sarah J. Maas'], langName: '', description: '', audioSeconds: null, defAudioId: null, defPhysId: 1, defEbookId: null, hcId: 402 };
  ok('rank: detected-nl record excluded for en browser', getX('recoEditionRank(X, "en")', dutchCand) === -1);
  ok('rank: detected-nl record is browser-lang print for nl browser', getX('recoEditionRank(X, "nl")', dutchCand) === 0);
  ok('rank: detected-it record excluded for en browser', getX('recoEditionRank(X, "en")', italCand) === -1);
  ok('rank: undetectable record still fails open (unknown print = 2)',
    getX('recoEditionRank(X, "en")', Object.assign({}, dutchCand, { title: 'Dune' })) === 2);
  out = collapse([dutchCand, enPrint2], 'en');
  ok('collapse: detected-foreign work dropped for en browser', out.length === 1 && out[0].hcId === 101);
  out = collapse([dutchCand, enPrint2], 'nl');
  ok('collapse: same record kept for nl browser, en record dropped', out.length === 1 && out[0].hcId === 401);

  // Sweep end-to-end: an unstated Dutch record is filtered by detection.
  runInWindow('library = []');
  const rawDutch = hcBook({
    id: 7, title: 'Nog één week samen', description: '',
    default_physical_edition: { isbn_13: '9789000377931', language: null },
    default_cover_edition: { language: null },
  });
  runInWindow('hcGraphQL = async (q) => ({ books: ' + JSON.stringify([rawDutch, rawPrint]) + ' });');
  const sweptDet = await get('sweepRecoCandidates(["Rebecca Yarros"], new Set())');
  ok('sweep: unstated Dutch record excluded via detection', sweptDet.length === 1 && sweptDet[0].hcId === 1);

  // ---- v533: drift fallback leaves exactly one AppLog trace per sweep ----
  window.__queries = [];
  runInWindow('hcGraphQL = async (q) => { window.__queries.push(q);' +
    ' if (q.indexOf("audio_seconds") !== -1) throw new Error("field drift");' +
    ' return { books: [] }; };');
  runInWindow('AppLog.clear()');
  await get('sweepRecoCandidates(["Rebecca Yarros", "Sarah J. Maas"], new Set())');
  ok('fallback: one AppLog warn (tag "reco") per sweep, not per author',
    get('AppLog.entries("warn").filter(e => e.tag === "reco").length') === 1);
  runInWindow('AppLog.clear()');
  runInWindow('hcGraphQL = async (q) => ({ books: [] });');
  await get('sweepRecoCandidates(["Rebecca Yarros"], new Set())');
  ok('fallback: no AppLog warn on the happy path',
    get('AppLog.entries("warn").filter(e => e.tag === "reco").length') === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
