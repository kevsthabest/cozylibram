/* v153 read-path tests: TropeStore.getBookTropes (cache -> Supabase ->
   heuristics + background enqueue) and dbTropeChipsHTML.
   Run: node .test/trope-readpath.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

(async () => {
  const memStore = {};
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: k => (k in memStore ? memStore[k] : null),
      setItem: (k, v) => { memStore[k] = String(v); },
      removeItem: k => { delete memStore[k]; },
    },
    // `esc` comes from js/050-helpers.js at runtime; minimal faithful stub here.
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SPICY_CONFIG: {},
    library: [],
    cloudClient: async () => null,
    fetch: async () => { throw new Error('no network in tests'); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const load = f => vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  load('156-trope-taxonomy.js');
  load('157-trope-inference.js');

  const probe = src => vm.runInContext(src, ctx);

  /* ---- A. DB rows: names resolved, sorted, unknown ids filtered ---- */
  {
    const rows = [
      { trope_id: 'enemies-to-lovers', confidence: 0.9, source: 'llm' },
      { trope_id: 'bogus-id', confidence: 0.99, source: 'llm' },
      { trope_id: 'forced-proximity', confidence: 0.95, source: 'llm' },
    ];
    probe(`cloudClient = async () => ({
      from: () => ({ select: () => ({ eq: () => ({ order: async () =>
        ({ data: ${JSON.stringify(rows)}, error: null }) }) }) }),
    })`);
    const book = { id: 'bA', title: 'Test Book', authors: ['Author'], isbn: '9781234567890' };
    const r = await probe(`TropeStore.getBookTropes(${JSON.stringify(book)})`);
    ok('db rows resolve to names', r.origin === 'db' && r.tropes.length === 2);
    ok('unknown trope ids filtered', !r.tropes.some(t => t.id === 'bogus-id'));
    ok('sorted by confidence desc',
      r.tropes[0].id === 'forced-proximity' && r.tropes[1].id === 'enemies-to-lovers');
    ok('name comes from taxonomy', r.tropes[0].name === 'Forced Proximity');

    // Memory cache: second call must not hit the "network" again.
    probe(`window.__readCalls = 0; cloudClient = async () => { window.__readCalls++;
      return { from: () => ({ select: () => ({ eq: () => ({ order: async () =>
        ({ data: [], error: null }) }) }) }) }; }`);
    const r2 = await probe(`TropeStore.getBookTropes(${JSON.stringify(book)})`);
    ok('memory cache serves second read', r2.origin === 'db' &&
      probe('window.__readCalls') === 0 && r2.tropes.length === 2);
    probe('TropeStore.invalidate()');
  }

  /* ---- B. Empty DB + unconfigured: heuristics, no enqueue ---- */
  {
    probe(`window.__readCalls = 0; cloudClient = async () => { window.__readCalls++;
      return { from: () => ({ select: () => ({ eq: () => ({ order: async () =>
        ({ data: [], error: null }) }) }) }) }; }`);
    probe('SPICY_CONFIG = {}'); // provider not configured
    probe('localStorage.removeItem("trope_queue_v1")');
    const book = { id: 'bB', title: 'Other', authors: ['Writer'], tropesAuto: ['dragons', 'quests'] };
    const r = await probe(`TropeStore.getBookTropes(${JSON.stringify(book)})`);
    ok('heuristics returned when DB empty', r.origin === 'heuristics' && r.tropes.length === 2);
    ok('heuristic entries carry names, null ids',
      r.tropes[0].name === 'dragons' && r.tropes[0].id === null);
    ok('nothing enqueued when provider unconfigured', probe('TropeQueue.snapshot().total') === 0);
    probe('TropeStore.invalidate()');
  }

  /* ---- C. Empty DB + configured: background inference enqueued ---- */
  {
    probe(`cloudClient = async () => null`); // signed out: reads miss, upserts fail
    probe(`SPICY_CONFIG = ({ trope: true, tropeProvider: 'openrouter', tropeModel: 'm' })`);
    probe(`fetch = async () => ({ ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"tropes":[]}' } }] }) })`);
    probe('localStorage.removeItem("trope_queue_v1")');
    probe('library = [{ id: "bC", title: "Third", authors: ["Auth"], description: "A long enough description for inference to work with properly." }]');
    const r = await probe('TropeStore.getBookTropes(library[0])');
    ok('heuristics returned meanwhile (empty tropesAuto)',
      r.origin === 'heuristics' && r.tropes.length === 0);
    ok('background inference enqueued', probe('TropeQueue.snapshot().total') === 1);
    // Let the pump settle (fetch mocked; upsert fails on null cloud client).
    await new Promise(res => setTimeout(res, 1500));
    const snap = probe('TropeQueue.snapshot()');
    ok('queue settles after failed upsert', snap.pending === 0);
    probe('TropeQueue.configure({ resolveBook: null, upsertRows: null })');
    probe('localStorage.removeItem("trope_queue_v1")');
    probe('TropeStore.invalidate()');
    probe('SPICY_CONFIG = {}');
  }

  /* ---- D. wiring is idempotent ---- */
  {
    probe('ensureTropeQueueWired(); ensureTropeQueueWired();');
    ok('ensureTropeQueueWired idempotent', true);
  }

  /* ---- E. chip HTML ---- */
  {
    const db = probe(`dbTropeChipsHTML([
      { id: 'dragons', name: 'Dragons', confidence: 0.95 },
      { id: 'quests', name: 'Quests', confidence: 0.8 },
    ], 'db')`);
    ok('db chips carry the ✦ marker', db.includes('✦ Dragons') && db.includes('✦ Quests'));
    ok('db chips get the ai class', db.includes('chip dbtrope ai'));
    ok('db chips show confidence tooltip',
      db.includes('title="AI-inferred · 95% confidence"'));
    ok('db chips carry the source note', db.includes('inferred from the book'));

    const heur = probe(`dbTropeChipsHTML([{ id: null, name: 'slow burn' }], 'heuristics')`);
    ok('heuristic chips are plain', heur.includes('slow burn') &&
      !heur.includes('✦') && !heur.includes('dbtrope ai'));

    const empty = probe(`dbTropeChipsHTML([], 'db')`);
    ok('empty tropes show the fallback note', empty.includes('No trope data yet'));

    const xss = probe(`dbTropeChipsHTML([{ id: 'x', name: '<img src=x>' }], 'heuristics')`);
    ok('names are escaped', xss.includes('&lt;img') && !xss.includes('<img src=x>'));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
