/* Character Unmerge tests (v577) — tests the real charMerge / charUnmerge
   from js/162-charlab.js against an in-memory book_characters fake, with
   FULL-SUBGRAPH diffs (every stored row of the work + character_links)
   before merge vs after unmerge. Legacy merges (no snapshot) must refuse.
   Run: node .test/char-unmerge.test.js */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { loadApp, APP_DIR } = require('./harness');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in char-unmerge tests'); };
loadApp(window);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const run = (js) => window.eval(js);
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortRows = (rows) => rows.slice().sort((x, y) => String(x.id).localeCompare(String(y.id)));

(async () => {
  /* ---- fake Supabase: in-memory book_characters + character_links ---- */
  run(`
  window.__charFake = {
    bcRows: [], linkRows: [],
    failUpdate: null, // (row, obj) => true to inject an error for that write
    reset() {
      const rel = (to, type, extra) => Object.assign({ to, type }, extra || {});
      this.bcRows = [
        { id: 'cW', work_id: 'w1', name: 'Willa Wynn', role: 'protagonist',
          description: 'lead', confidence: 0.9, status: 'confirmed',
          suggested_character_id: null, duplicate_of: null, merge_snapshot: null,
          first_appearance_chapter: 1,
          relationships: [rel('Liam Locke', 'friend'), rel('Thea Thorn', 'mentor')] },
        { id: 'cL', work_id: 'w1', name: 'Liam Locke', role: 'supporting',
          description: 'the double', confidence: 0.8, status: 'candidate',
          suggested_character_id: null, duplicate_of: null, merge_snapshot: null,
          first_appearance_chapter: 2,
          relationships: [rel('Willa Wynn', 'spouse'), rel('Thea Thorn', 'friend')] },
        { id: 'cT', work_id: 'w1', name: 'Thea Thorn', role: 'antagonist',
          description: 'rival', confidence: 0.7, status: 'confirmed',
          suggested_character_id: null, duplicate_of: null, merge_snapshot: null,
          first_appearance_chapter: 3,
          relationships: [rel('Liam Locke', 'enemy', { note: 'duel at dawn' }), rel('Willa Wynn', 'friend')] },
        { id: 'cU', work_id: 'w1', name: 'Uma Unrelated', role: 'minor',
          description: '', confidence: 0.5, status: 'candidate',
          suggested_character_id: null, duplicate_of: null, merge_snapshot: null,
          first_appearance_chapter: null,
          relationships: [rel('Thea Thorn', 'neighbor')] },
      ];
      this.linkRows = [
        { book_character_id: 'cW', character_id: 'canon-1', linked_by: 'curator-1', note: null },
      ];
      this.failUpdate = null;
    },
  };
  window.__charFake.reset();
  const F = window.__charFake;
  const project = (row, cols) => {
    const out = {};
    for (const rawPart of String(cols).split(',')) {
      const part = rawPart.trim();
      if (!part) continue;
      if (part.indexOf('character_links(') === 0) {
        out.character_links = F.linkRows
          .filter(l => l.book_character_id === row.id)
          .map(l => ({ character_id: l.character_id }));
      } else {
        out[part] = row[part] === undefined ? null : JSON.parse(JSON.stringify(row[part]));
      }
    }
    return out;
  };
  const selectBuilder = (rows, cols) => {
    const b = {
      _rows: rows.slice(),
      eq(col, val) { b._rows = b._rows.filter(r => r[col] === val); return b; },
      neq(col, val) { b._rows = b._rows.filter(r => r[col] !== val); return b; },
      is(col, val) { b._rows = b._rows.filter(r => r[col] === val); return b; },
      order() { b._rows.sort((x, y) => String(x.name).localeCompare(String(y.name))); return b; },
      limit() { return b; },
      maybeSingle() {
        return Promise.resolve({ data: b._rows.length ? project(b._rows[0], cols) : null, error: null });
      },
      then(res, rej) {
        return Promise.resolve({ data: b._rows.map(r => project(r, cols)), error: null }).then(res, rej);
      },
    };
    return b;
  };
  window.__charSb = {
    auth: { getUser: async () => ({ data: { user: { id: 'curator-1' } } }) },
    from(table) {
      if (table !== 'book_characters') {
        return { select: (cols) => selectBuilder([], cols),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      }
      return {
        select: (cols) => selectBuilder(F.bcRows, cols),
        update: (obj) => ({
          eq: (col, val) => {
            const row = F.bcRows.find(r => r[col] === val);
            if (row && F.failUpdate && F.failUpdate(row, obj)) {
              return Promise.resolve({ error: { message: 'injected failure' } });
            }
            if (row) Object.assign(row, JSON.parse(JSON.stringify(obj)));
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
  cloudClient = async () => window.__charSb;
  `);

  const subgraph = () => {
    const s = JSON.parse(run(`JSON.stringify({ bc: __charFake.bcRows, links: __charFake.linkRows })`));
    return { bc: sortRows(s.bc), links: s.links };
  };
  const memGraph = async () => {
    const chars = JSON.parse(run(`JSON.stringify(__chars)`));
    return sortRows(chars);
  };
  const loadChars = async () => {
    await run(`(async () => { __chars = await CharacterStore.listForWork('w1'); })()`);
  };
  const callMerge = (w, l) => run(`(async () => {
    try { return await charMerge('${w}', '${l}', __chars); }
    catch (e) { return 'THREW: ' + ((e && e.message) || e); } })()`);
  const callUnmerge = (l) => run(`(async () => {
    try { return await charUnmerge('${l}', __chars); }
    catch (e) { return 'THREW: ' + ((e && e.message) || e); } })()`);

  /* ================= 1. round-trip: full subgraph diff ================= */
  run(`__charFake.reset()`);
  await loadChars();
  const s0 = subgraph();
  const m0 = await memGraph();
  ok('loader: mergeSnapshot exposed (null pre-merge)',
    m0.every(c => c.mergeSnapshot === null));

  const mergeErr = await callMerge('cW', 'cL');
  ok('merge: succeeds', mergeErr === null);
  const afterMerge = subgraph();
  const loserRow = afterMerge.bc.find(r => r.id === 'cL');
  ok('merge: loser soft-merged', loserRow.status === 'merged' && loserRow.duplicate_of === 'cW');
  const snap = loserRow.merge_snapshot;
  ok('merge: snapshot recorded on the loser row', !!snap && snap.v === 1 &&
    snap.winnerId === 'cW' && snap.loserId === 'cL' && snap.loserStatus === 'candidate');
  ok('merge: snapshot carries curator provenance', !!snap && snap.by === 'curator-1' && !!snap.at);
  const w0 = s0.bc.find(r => r.id === 'cW');
  const t0 = s0.bc.find(r => r.id === 'cT');
  ok('merge: snapshot winner rels are the pre-merge array',
    !!snap && deepEq(snap.winnerRels, w0.relationships));
  ok('merge: snapshot repoints cover exactly the changed third parties',
    !!snap && Array.isArray(snap.repoints) && snap.repoints.length === 1 &&
    snap.repoints[0].id === 'cT' && deepEq(snap.repoints[0].rels, t0.relationships));
  const tAfter = afterMerge.bc.find(r => r.id === 'cT');
  ok('merge: third-party rel actually repointed at the winner',
    tAfter.relationships[0].to === 'Willa Wynn' && tAfter.relationships[0].note === 'duel at dawn');

  const unmergeErr = await callUnmerge('cL');
  ok('unmerge: succeeds', unmergeErr === null);
  ok('round-trip: stored subgraph identical to pre-merge', deepEq(subgraph(), s0));
  await loadChars();
  ok('round-trip: reloaded character list identical to pre-merge',
    deepEq(await memGraph(), m0));

  /* ================= 2. double unmerge: clean refusal, no dup ================= */
  const dbl = await callUnmerge('cL');
  ok('double unmerge: refused as not merged',
    typeof dbl === 'string' && /not merged/i.test(dbl));
  ok('double unmerge: subgraph untouched, no duplicate character',
    deepEq(subgraph(), s0) && subgraph().bc.length === 4);

  /* ============ 3. re-merge after unmerge takes a FRESH snapshot ============ */
  run(`__charFake.bcRows.find(r => r.id === 'cT').relationships.push({ to: 'Uma Unrelated', type: 'colleague' })`);
  await loadChars();
  const s1 = subgraph();
  ok('re-merge: succeeds', (await callMerge('cW', 'cL')) === null);
  const snap2 = subgraph().bc.find(r => r.id === 'cL').merge_snapshot;
  ok('re-merge: fresh snapshot reflects the edited pre-state',
    !!snap2 && snap2.repoints.length === 1 &&
    snap2.repoints[0].rels.length === 3 && snap2.at >= (snap ? snap.at : ''));
  ok('re-unmerge: succeeds', (await callUnmerge('cL')) === null);
  ok('re-unmerge: subgraph identical to the edited pre-state', deepEq(subgraph(), s1));

  /* ================= 4. legacy merge (no snapshot) refuses ================= */
  run(`__charFake.reset();
    const L = __charFake.bcRows.find(r => r.id === 'cL');
    L.status = 'merged'; L.duplicate_of = 'cW'; L.merge_snapshot = null;`);
  await loadChars();
  const sLegacy = subgraph();
  const legacy = await callUnmerge('cL');
  ok('legacy unmerge: refused — no snapshot',
    typeof legacy === 'string' && /no merge snapshot/i.test(legacy));
  ok('legacy unmerge: nothing reconstructed, subgraph untouched',
    deepEq(subgraph(), sLegacy));

  /* ============ 5. snapshot-write failure aborts the merge cleanly ============ */
  run(`__charFake.reset();
    __charFake.failUpdate = (row, obj) => row.id === 'cL' && ('merge_snapshot' in obj);`);
  await loadChars();
  const sFail = subgraph();
  const failErr = await callMerge('cW', 'cL');
  ok('snapshot failure: merge returns an error naming the snapshot',
    typeof failErr === 'string' && /snapshot/i.test(failErr));
  ok('snapshot failure: no repoint, no merge mark — subgraph untouched',
    deepEq(subgraph(), sFail));

  /* ============ 6. unmerge write failure: retryable, then succeeds ============ */
  run(`__charFake.reset()`);
  await loadChars();
  const s6 = subgraph();
  ok('retry setup: merge succeeds', (await callMerge('cW', 'cL')) === null);
  run(`__charFake.__failedOnce = false;
    __charFake.failUpdate = (row, obj) => {
      if (!__charFake.__failedOnce && row.id === 'cW' && ('relationships' in obj)) {
        __charFake.__failedOnce = true; return true;
      }
      return false;
    };`);
  const uFail = await callUnmerge('cL');
  ok('unmerge failure: error returned', typeof uFail === 'string' && uFail.length > 0);
  const midState = subgraph().bc.find(r => r.id === 'cL');
  ok('unmerge failure: loser still merged, snapshot intact for retry',
    midState.status === 'merged' && !!midState.merge_snapshot);
  run(`__charFake.failUpdate = null`);
  ok('unmerge retry: succeeds', (await callUnmerge('cL')) === null);
  ok('unmerge retry: subgraph identical to pre-merge', deepEq(subgraph(), s6));

  /* ================= 7. winner gone: clean refusal ================= */
  run(`__charFake.reset()`);
  await loadChars();
  ok('winner-missing setup: merge succeeds', (await callMerge('cW', 'cL')) === null);
  run(`__charFake.bcRows = __charFake.bcRows.filter(r => r.id !== 'cW')`);
  await loadChars();
  const sGone = subgraph();
  const gone = await callUnmerge('cL');
  ok('winner missing: unmerge refuses',
    typeof gone === 'string' && /winner/i.test(gone));
  ok('winner missing: loser stays merged, subgraph untouched',
    deepEq(subgraph(), sGone));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
