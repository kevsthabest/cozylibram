// Trope taxonomy tests (v151): validity of the canonical list, the pure
// helpers, and the generated SQL seed staying in sync with the JS file.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const APP = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(APP + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in trope-taxonomy tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const probe = (js) => window.eval(js);

const TROPES = probe('TROPES');
const GENRES = probe('TROPE_GENRES');
const VERSION = probe('TROPE_TAXONOMY_VERSION');

ok('TROPE_TAXONOMY_VERSION is a positive int', Number.isInteger(VERSION) && VERSION >= 1);
ok('taxonomy has 60-90 tropes', TROPES.length >= 60 && TROPES.length <= 90);
ok('TROPE_GENRES covers the required genres',
  ['romance', 'fantasy', 'sci-fi', 'mystery-thriller', 'horror', 'historical', 'contemporary', 'non-fiction']
    .every(g => GENRES.includes(g)));

const ids = TROPES.map(t => t.id);
ok('ids are unique', new Set(ids).size === ids.length);
ok('ids are slugs', ids.every(id => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)));
ok('every trope has a name and description',
  TROPES.every(t => t.name && t.name.trim() && t.description && t.description.trim()));
ok('every trope has >= 1 valid genre',
  TROPES.every(t => Array.isArray(t.genres) && t.genres.length > 0 &&
    t.genres.every(g => GENRES.includes(g))));
ok('every genre has at least one trope', GENRES.every(g => TROPES.some(t => t.genres.includes(g))));

// tropeById
ok('tropeById finds enemies-to-lovers',
  probe("tropeById('enemies-to-lovers').name") === 'Enemies to Lovers');
ok('tropeById returns null for unknown id', probe("tropeById('nope')") === null);
ok('tropeById handles empty input', probe('tropeById("")') === null);

// tropesForGenres: genre filtering keeps prompts small and relevant
const sciFi = probe("tropesForGenres(['sci-fi']).map(t => t.id)");
ok('sci-fi filter includes ai-uprising', sciFi.includes('ai-uprising'));
ok('sci-fi filter excludes romance-only tropes', !sciFi.includes('billionaire'));
ok('sci-fi filter excludes fantasy-only tropes', !sciFi.includes('dragons'));
ok('cross-genre tropes appear in both filters',
  probe("tropesForGenres(['romance']).map(t => t.id)").includes('forced-proximity') &&
  probe("tropesForGenres(['fantasy']).map(t => t.id)").includes('forced-proximity'));
ok('empty genres returns the whole taxonomy',
  probe('tropesForGenres([]).length') === TROPES.length);
ok('genre matching is case-insensitive',
  probe("tropesForGenres(['Sci-Fi']).length") === sciFi.length);
ok('unknown genres are ignored', probe("tropesForGenres(['western']).length") === 0);

// tropeNameKey normalization (proposal dedup)
ok('name_key strips case/punct/space',
  probe("tropeNameKey('Forced Proximity!')") === 'forcedproximity');
ok('name_key folds diacritics', probe("tropeNameKey('Café Mafia')") === 'cafemafia');
ok('name_key handles empty', probe("tropeNameKey('')") === '');

// findSimilarTrope: near-duplicate redirect
const sim = probe("findSimilarTrope('forced closeness')");
ok('finds near-duplicate for "forced closeness"',
  sim && sim.trope.id === 'forced-proximity' && sim.score >= 0.5);
const exact = probe("findSimilarTrope('Enemies to Lovers')");
ok('exact name match scores 1', exact && exact.trope.id === 'enemies-to-lovers' && exact.score === 1);
ok('gibberish matches nothing', probe("findSimilarTrope('xyzzy qqq')") === null);
ok('empty matches nothing', probe("findSimilarTrope('')") === null);

// tropeSlugFor: collision-safe slug generation
ok('basic slug', probe("tropeSlugFor('Forced Proximity', new Set())") === 'forced-proximity');
ok('collision appends -2',
  probe("tropeSlugFor('Forced Proximity', new Set(['forced-proximity']))") === 'forced-proximity-2');
ok('double collision appends -3',
  probe("tropeSlugFor('Forced Proximity', new Set(['forced-proximity','forced-proximity-2']))") === 'forced-proximity-3');
ok('empty name falls back to trope', probe("tropeSlugFor('', new Set())") === 'trope');

// SQL seed drift guard: the generated seed in supabase/tropes.sql must list
// exactly the taxonomy's ids.
const sql = fs.readFileSync(APP + '/supabase/tropes.sql', 'utf8');
const seedBlock = /BEGIN GENERATED SEED[\s\S]*?insert into tropes[\s\S]*?values([\s\S]*?)on conflict/.exec(sql);
ok('tropes.sql contains the generated seed block', !!seedBlock);
if (seedBlock) {
  const seedIds = [...seedBlock[1].matchAll(/\('([a-z0-9-]+)',/g)].map(m => m[1]);
  ok('seed has one row per trope', seedIds.length === TROPES.length);
  ok('seed ids match taxonomy ids',
    seedIds.length === ids.length && ids.every(id => seedIds.includes(id)));
  ok('seed carries the taxonomy version',
    // v207: rows now end with `, <version>, ARRAY[...aliases...], ARRAY[...exclusions...])`.
    new RegExp(`, ${VERSION}, ARRAY\\[`, 'g').test(seedBlock[1]));
}
ok('tropes.sql defines all four tables',
  ['create table if not exists tropes', 'create table if not exists book_tropes',
   'create table if not exists trope_votes', 'create table if not exists trope_proposals']
    .every(s => sql.includes(s)));
ok('tropes.sql enables RLS on all four tables',
  (sql.match(/alter table \w+ enable row level security/g) || []).length >= 4);

// index.html loads the taxonomy file, and the SW precaches it.
ok('index.html includes 156-trope-taxonomy.js', html.includes('js/156-trope-taxonomy.js'));
const sw = fs.readFileSync(APP + '/sw.js', 'utf8');
ok('sw.js precaches 156-trope-taxonomy.js', sw.includes('156-trope-taxonomy.js'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
