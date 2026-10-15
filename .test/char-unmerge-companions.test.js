/* Character Unmerge COMPANIONS tests (v578) — the preview + history
   surfaces over PR #248's shipped restore core. Unit-tests the pure
   derivations from js/162-charlab.js (charUnmergePreview /
   charUnmergeListWindow / charUnmergeOutcome / charMergeHistoryLine /
   charUnmergeResultModel) against fixture snapshots, then drives the
   real card -> preview sheet -> commit -> result flow in jsdom against
   an in-memory book_characters fake. charUnmerge's own semantics are
   covered by char-unmerge.test.js and are NOT re-tested here.
   Run: node .test/char-unmerge-companions.test.js */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { loadApp, APP_DIR } = require('./harness');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in companions tests'); };
loadApp(window);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const run = (js) => window.eval(js);
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rel = (to, type, extra) => Object.assign({ to, type }, extra || {});

/* Fixture: the post-merge Lab list for work w1, exactly as charMerge
   (v577) leaves it. Willa (winner) absorbed Liam (loser); Thea's 'enemy'
   pointer was repointed Liam -> Willa; snapshot recorded pre-merge. */
function fixtureChars() {
  const snap = {
    v: 1, at: '2026-10-15T17:06:49.000Z', by: 'curator-1',
    winnerId: 'cW', loserId: 'cL', loserStatus: 'candidate',
    winnerRels: [rel('Liam Locke', 'friend'), rel('Thea Thorn', 'mentor')],
    repoints: [{ id: 'cT', rels: [rel('Liam Locke', 'enemy', { note: 'duel at dawn' }), rel('Willa Wynn', 'friend')] }],
  };
  return [
    { id: 'cW', name: 'Willa Wynn', role: 'protagonist', description: 'lead',
      confidence: 0.9, status: 'confirmed', suggestedCharacterId: null,
      duplicateOf: null, mergeSnapshot: null, characterId: null,
      relationships: [rel('Willa Wynn', 'friend'), rel('Thea Thorn', 'mentor'),
        rel('Willa Wynn', 'spouse'), rel('Thea Thorn', 'friend')] },
    { id: 'cL', name: 'Liam Locke', role: 'supporting', description: 'the double',
      confidence: 0.8, status: 'merged', suggestedCharacterId: null,
      duplicateOf: 'cW', mergeSnapshot: snap, characterId: null,
      relationships: [rel('Willa Wynn', 'spouse'), rel('Thea Thorn', 'friend')] },
    { id: 'cT', name: 'Thea Thorn', role: 'antagonist', description: 'rival',
      confidence: 0.7, status: 'confirmed', suggestedCharacterId: null,
      duplicateOf: null, mergeSnapshot: null, characterId: null,
      relationships: [rel('Willa Wynn', 'enemy', { note: 'duel at dawn' }), rel('Willa Wynn', 'friend')] },
    { id: 'cU', name: 'Uma Unrelated', role: 'minor', description: '',
      confidence: 0.5, status: 'candidate', suggestedCharacterId: null,
      duplicateOf: null, mergeSnapshot: null, characterId: null,
      relationships: [rel('Thea Thorn', 'neighbor')] },
    { id: 'cO', name: 'Old Merge', role: 'minor', description: '',
      confidence: 0.4, status: 'merged', suggestedCharacterId: null,
      duplicateOf: 'cW', mergeSnapshot: null, characterId: null,
      relationships: [] },
  ];
}
const callPreview = (chars) => {
  window.__fxChars = chars;
  return JSON.parse(run(`JSON.stringify((() => {
    const loser = __fxChars.find(c => c.id === 'cL');
    const winner = __fxChars.find(c => c.id === 'cW');
    return charUnmergePreview(loser, winner, __fxChars);
  })())`));
};

(async () => {
  /* ================= 1. preview derivation ================= */
  const chars = fixtureChars();
  const p = callPreview(chars);
  ok('preview: identifies loser, winner, and the status it returns to',
    p.loserName === 'Liam Locke' && p.winnerName === 'Willa Wynn' && p.returnsAs === 'candidate');
  ok('preview: links back = the repointed third-party entries, named with landing place',
    deepEq(p.linksBack, [{ name: 'Thea Thorn', type: 'enemy' }]));
  ok('preview: relationships back = winner pointers at the loser + folded-in loser entries',
    deepEq(p.relsBack, [
      { name: 'Willa Wynn', type: 'friend' },
      { name: 'Willa Wynn', type: 'spouse' },
      { name: 'Thea Thorn', type: 'friend' },
    ]));
  ok('preview: stays = the winner\'s own relationships that never involved the loser',
    deepEq(p.staysList, [{ name: 'Thea Thorn', type: 'mentor' }]));
  ok('preview: nothing rewound in the untouched post-merge state',
    deepEq(p.rewound, []));
  ok('preview: counts mirror the sections',
    p.counts.links === 1 && p.counts.relationships === 3 && p.counts.stays === 1 &&
    p.movesBack.length === 4);

  /* ============ 2. post-merge addition to the winner = rewound ============ */
  // (types render through charNormRelType, the Lab's canonical grouping —
  // an unlisted type would surface as 'other'; 'enemy' is a listed type.)
  const chars2 = fixtureChars();
  chars2.find(c => c.id === 'cW').relationships.push(rel('Uma Unrelated', 'enemy'));
  const p2 = callPreview(chars2);
  ok('preview: a post-merge addition to the winner is classified rewound, not stayed',
    deepEq(p2.rewound, [{ name: 'Uma Unrelated', type: 'enemy' }]) &&
    p2.counts.stays === 1);

  /* ================= 3. list window (8 / +N more) ================= */
  const items12 = Array.from({ length: 12 }, (_, i) => ({ name: 'C' + i, type: 'friend' }));
  const wClosed = JSON.parse(run(`JSON.stringify(charUnmergeListWindow(${JSON.stringify(items12)}, false))`));
  const wOpen = JSON.parse(run(`JSON.stringify(charUnmergeListWindow(${JSON.stringify(items12)}, true))`));
  const w8 = JSON.parse(run(`JSON.stringify(charUnmergeListWindow(${JSON.stringify(items12.slice(0, 8))}, false))`));
  ok('window: first 8 shown, +4 more counted',
    wClosed.shown.length === 8 && wClosed.moreCount === 4);
  ok('window: expanded shows all, no remainder',
    wOpen.shown.length === 12 && wOpen.moreCount === 0);
  ok('window: exactly 8 has no remainder',
    w8.shown.length === 8 && w8.moreCount === 0);

  /* ================= 4. history line ================= */
  const loserFx = fixtureChars().find(c => c.id === 'cL');
  window.__fxLoser = loserFx;
  const line = run(`charMergeHistoryLine(__fxLoser)`);
  ok('history: "Merged from {loser} · by {by} · {when}" from the snapshot',
    typeof line === 'string' &&
    line.indexOf('Merged from Liam Locke · by curator-1 · ') === 0 &&
    line.indexOf('date not recorded') === -1);
  const noAt = JSON.parse(JSON.stringify(loserFx));
  delete noAt.mergeSnapshot.at;
  window.__fxLoser2 = noAt;
  ok('history: a snapshot without a timestamp reads "date not recorded", never an invented date',
    run(`charMergeHistoryLine(__fxLoser2)`).endsWith('· date not recorded'));
  window.__fxLoser3 = fixtureChars().find(c => c.id === 'cO');
  ok('history: no snapshot, no line',
    run(`charMergeHistoryLine(__fxLoser3)`) === null);

  /* ================= 5. outcome counts (incl. partial shapes) ================= */
  const callOutcome = (after) => {
    window.__fxAfter = after;
    window.__fxPrev = p;
    return JSON.parse(run(`JSON.stringify(charUnmergeOutcome(__fxPrev, __fxAfter))`));
  };
  // fully restored (pre-merge arrays verbatim, loser active again)
  const restored = fixtureChars();
  restored.find(c => c.id === 'cW').relationships =
    [rel('Liam Locke', 'friend'), rel('Thea Thorn', 'mentor')];
  restored.find(c => c.id === 'cT').relationships =
    [rel('Liam Locke', 'enemy', { note: 'duel at dawn' }), rel('Willa Wynn', 'friend')];
  const rl = restored.find(c => c.id === 'cL');
  rl.status = 'candidate'; rl.duplicateOf = null; rl.mergeSnapshot = null;
  const oFull = callOutcome(restored);
  ok('outcome: full restore counts everything moved and finished',
    oFull.finished === true && oFull.linksMoved === 1 && oFull.relsMoved === 3);

  // winner write failed: repoints landed, winner + loser untouched
  const partWinner = fixtureChars();
  partWinner.find(c => c.id === 'cT').relationships =
    [rel('Liam Locke', 'enemy', { note: 'duel at dawn' }), rel('Willa Wynn', 'friend')];
  const oPartW = callOutcome(partWinner);
  ok('outcome: winner-write failure — links moved, relationships not, unfinished',
    oPartW.finished === false && oPartW.linksMoved === 1 && oPartW.relsMoved === 0);

  // first repoint failed: nothing landed
  const oNone = callOutcome(fixtureChars());
  ok('outcome: nothing landed — zero counts, unfinished',
    oNone.finished === false && oNone.linksMoved === 0 && oNone.relsMoved === 0);

  // loser write failed: everything moved except the final restore
  const partLoser = fixtureChars();
  partLoser.find(c => c.id === 'cW').relationships =
    [rel('Liam Locke', 'friend'), rel('Thea Thorn', 'mentor')];
  partLoser.find(c => c.id === 'cT').relationships =
    [rel('Liam Locke', 'enemy', { note: 'duel at dawn' }), rel('Willa Wynn', 'friend')];
  const oPartL = callOutcome(partLoser);
  ok('outcome: loser-write failure — all movement counted, still unfinished',
    oPartL.finished === false && oPartL.linksMoved === 1 && oPartL.relsMoved === 3);

  /* ===== 5B. mutual same-type winner<->loser pair (Advisor finding) =====
     Both rows carry 'spouse' toward each other pre-merge. charMerge
     repoints the winner's spouse entry at the winner's own name BEFORE
     building its fold set (`seen`), so the loser's spouse entry keys
     INTO that set and is never folded — the loser's own relationships
     array is untouched by merge and unmerge alike. The preview/result
     derivation must therefore not list or count that entry as moving
     back: exactly 2 entries change state in this shape, not 3. */
  function mutualChars() {
    const snap = {
      v: 1, at: '2026-10-15T18:22:00.000Z', by: 'curator-1',
      winnerId: 'cW', loserId: 'cL', loserStatus: 'confirmed',
      winnerRels: [rel('Liam Locke', 'spouse'), rel('Thea Thorn', 'mentor')],
      repoints: [],
    };
    return [
      { id: 'cW', name: 'Willa Wynn', role: 'protagonist', description: 'lead',
        confidence: 0.9, status: 'confirmed', suggestedCharacterId: null,
        duplicateOf: null, mergeSnapshot: null, characterId: null,
        relationships: [rel('Willa Wynn', 'spouse'), rel('Thea Thorn', 'mentor'),
          rel('Thea Thorn', 'friend')] },
      { id: 'cL', name: 'Liam Locke', role: 'supporting', description: 'the double',
        confidence: 0.8, status: 'merged', suggestedCharacterId: null,
        duplicateOf: 'cW', mergeSnapshot: snap, characterId: null,
        relationships: [rel('Willa Wynn', 'spouse'), rel('Thea Thorn', 'friend')] },
      { id: 'cT', name: 'Thea Thorn', role: 'antagonist', description: 'rival',
        confidence: 0.7, status: 'confirmed', suggestedCharacterId: null,
        duplicateOf: null, mergeSnapshot: null, characterId: null,
        relationships: [] },
    ];
  }
  const mp = callPreview(mutualChars());
  ok('mutual pair: relationships back lists each moving entry once — no duplicate winner-side line',
    deepEq(mp.relsBack, [
      { name: 'Willa Wynn', type: 'spouse' },
      { name: 'Thea Thorn', type: 'friend' },
    ]));
  ok('mutual pair: the loser\'s own mutual entry is not listed as moving — it never folded',
    mp.relsBack.filter(x => x.type === 'spouse').length === 1);
  ok('mutual pair: counts say 2 relationships move back, not 3',
    mp.counts.relationships === 2 && mp.counts.links === 0 && mp.movesBack.length === 2);
  ok('mutual pair: stays still names the winner\'s uninvolved entries',
    deepEq(mp.staysList, [{ name: 'Thea Thorn', type: 'mentor' }]) && mp.counts.stays === 1);
  // fully restored state for the mutual shape (winner array verbatim
  // from the snapshot, loser active again, its own array as it always was)
  const mAfter = mutualChars();
  mAfter.find(c => c.id === 'cW').relationships =
    [rel('Liam Locke', 'spouse'), rel('Thea Thorn', 'mentor')];
  const mLoser = mAfter.find(c => c.id === 'cL');
  mLoser.status = 'confirmed'; mLoser.duplicateOf = null; mLoser.mergeSnapshot = null;
  window.__fxAfterM = mAfter;
  window.__fxPrevM = mp;
  const oMutual = JSON.parse(run(`JSON.stringify(charUnmergeOutcome(__fxPrevM, __fxAfterM))`));
  ok('mutual pair: outcome counts exactly the 2 entries that changed state',
    oMutual.finished === true && oMutual.linksMoved === 0 && oMutual.relsMoved === 2);

  /* ================= 6. result model ================= */
  const mOk = JSON.parse(run(`JSON.stringify(charUnmergeResultModel(${JSON.stringify(p)}, null))`));
  ok('result: success heading + counted lines + stays + status',
    mOk.done === true && mOk.heading === 'Liam Locke is back.' &&
    mOk.countsLine === '1 link moved back · 3 relationships restored' &&
    mOk.staysLine === '1 item stayed with Willa Wynn' &&
    mOk.statusLine === 'Liam Locke returns as candidate.');
  window.__fxPrev2 = p; window.__fxOut2 = oPartW;
  const mPart = JSON.parse(run(`JSON.stringify(charUnmergeResultModel(__fxPrev2, __fxOut2))`));
  ok('result: partial failure gets its own heading and of-total counts',
    mPart.done === false && mPart.heading === "Restore didn't finish" &&
    mPart.countsLine === '1 of 1 link moved back · 0 of 3 relationships restored');

  /* ================= 7. DOM: card -> sheet -> commit -> result ================= */
  run(`
  window.__domsb = {
    rows: [],
    reset() {
      const R = (to, type, extra) => Object.assign({ to, type }, extra || {});
      this.rows = [
        { id: 'cW', work_id: 'w1', name: 'Willa Wynn', role: 'protagonist', description: 'lead',
          confidence: 0.9, status: 'confirmed', suggested_character_id: null, duplicate_of: null,
          merge_snapshot: null, first_appearance_chapter: 1,
          relationships: [R('Willa Wynn', 'friend'), R('Thea Thorn', 'mentor'), R('Willa Wynn', 'spouse'), R('Thea Thorn', 'friend')] },
        { id: 'cL', work_id: 'w1', name: 'Liam Locke', role: 'supporting', description: 'the double',
          confidence: 0.8, status: 'merged', suggested_character_id: null, duplicate_of: 'cW',
          merge_snapshot: { v: 1, at: '2026-10-15T17:06:49.000Z', by: 'curator-1', winnerId: 'cW', loserId: 'cL',
            loserStatus: 'candidate',
            winnerRels: [R('Liam Locke', 'friend'), R('Thea Thorn', 'mentor')],
            repoints: [{ id: 'cT', rels: [R('Liam Locke', 'enemy', { note: 'duel at dawn' }), R('Willa Wynn', 'friend')] }] },
          first_appearance_chapter: 2,
          relationships: [R('Willa Wynn', 'spouse'), R('Thea Thorn', 'friend')] },
        { id: 'cT', work_id: 'w1', name: 'Thea Thorn', role: 'antagonist', description: 'rival',
          confidence: 0.7, status: 'confirmed', suggested_character_id: null, duplicate_of: null,
          merge_snapshot: null, first_appearance_chapter: 3,
          relationships: [R('Willa Wynn', 'enemy', { note: 'duel at dawn' }), R('Willa Wynn', 'friend')] },
        { id: 'cO', work_id: 'w1', name: 'Old Merge', role: 'minor', description: '',
          confidence: 0.4, status: 'merged', suggested_character_id: null, duplicate_of: 'cW',
          merge_snapshot: null, first_appearance_chapter: null, relationships: [] },
      ];
    },
  };
  __domsb.reset();
  (function () {
    const F = window.__domsb;
    const project = (row, cols) => {
      const out = {};
      for (const rawPart of String(cols).split(',')) {
        const part = rawPart.trim();
        if (!part) continue;
        if (part.indexOf('character_links(') === 0) out.character_links = [];
        else out[part] = row[part] === undefined ? null : JSON.parse(JSON.stringify(row[part]));
      }
      return out;
    };
    const selectBuilder = (rows, cols) => {
      const b = {
        _rows: rows.slice(),
        eq(col, val) { b._rows = b._rows.filter(r => r[col] === val); return b; },
        order() { b._rows.sort((x, y) => String(x.name).localeCompare(String(y.name))); return b; },
        maybeSingle() { return Promise.resolve({ data: b._rows.length ? project(b._rows[0], cols) : null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: b._rows.map(r => project(r, cols)), error: null }).then(res, rej); },
      };
      return b;
    };
    window.__domSb = {
      auth: { getUser: async () => ({ data: { user: { id: 'curator-1' } } }) },
      from(table) {
        if (table !== 'book_characters') {
          return { select: (cols) => selectBuilder([], cols),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        }
        return {
          select: (cols) => selectBuilder(F.rows, cols),
          update: (obj) => ({
            eq: (col, val) => {
              const row = F.rows.find(r => r[col] === val);
              if (row) Object.assign(row, JSON.parse(JSON.stringify(obj)));
              return Promise.resolve({ error: null });
            },
          }),
        };
      },
    };
    cloudClient = async () => window.__domSb;
  })();
  `);
  const works = [{ workId: 'w1', title: 'Some Work', count: 4 }];
  const loadDomChars = async () => JSON.parse(run(`JSON.stringify(__domChars)`));
  await run(`(async () => { __domChars = await CharacterStore.listForWork('w1'); })()`);
  const domChars = await loadDomChars();
  window.__domWorks = works;
  window.__domCharsLive = domChars;
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  window.__domBody = container;
  run(`charLabWorkId = 'w1'; charLabSelectedId = null; charLabRender(__domBody, __domWorks, __domCharsLive);`);

  const cardHtml = container.innerHTML;
  ok('card: header counts restorable merges only ("1 can be restored")',
    cardHtml.includes('Merged characters') && cardHtml.includes('1 can be restored'));
  ok('card: restorable row offers "Review restore…" and carries the history line',
    !!container.querySelector('[data-chrestore="cL"]') &&
    container.querySelector('[data-chrestore="cL"]').textContent.includes('Review restore') &&
    cardHtml.includes('Merged from Liam Locke · by curator-1 ·'));
  ok('card: legacy row carries "No snapshot — can\'t be restored" and no action',
    cardHtml.includes("No snapshot — can't be restored") &&
    !container.querySelector('[data-chrestore="cO"]'));
  ok('card: no bare Unmerge button remains (the preview is always in the path)',
    !container.querySelector('[data-chunmerge]'));

  // Winner detail carries the merge-history line
  run(`charLabSelectedId = 'cW'; charLabDetail(__domCharsLive);`);
  ok('detail: winner curation view shows the merge-history line',
    window.document.getElementById('ch-detail').innerHTML
      .includes('Merged from Liam Locke · by curator-1 ·'));
  run(`charLabSelectedId = null; charLabRender(__domBody, __domWorks, __domCharsLive);`);

  // Open the preview sheet
  run(`openCharRestoreSheet('cL', { body: __domBody, works: __domWorks, chars: __domCharsLive });`);
  const sheet = window.document.getElementById('ch-restore-sheet');
  ok('sheet: opens with the "Restore {loser}?" title', !!sheet &&
    sheet.textContent.includes('Restore Liam Locke?'));
  const sheetText = sheet ? sheet.textContent : '';
  ok('sheet: section A names who comes back and the status returned to',
    sheetText.includes('Returns as: candidate'));
  ok('sheet: section B names each move with its landing place',
    sheetText.includes('Thea Thorn — enemy returns to Liam Locke') &&
    sheetText.includes('Willa Wynn — spouse returns to Liam Locke'));
  ok('sheet: section C is present, names what stays with the winner',
    sheetText.includes('Stays with Willa Wynn') &&
    sheetText.includes('Thea Thorn — mentor stays with Willa Wynn'));
  ok('sheet: commit is labelled with the action, secondary is "Keep merged"',
    !!window.document.getElementById('ch-restore-commit') &&
    window.document.getElementById('ch-restore-commit').textContent.includes('Restore Liam Locke') &&
    !!window.document.getElementById('ch-restore-keep'));

  // Commit the restore through the real charUnmerge
  window.document.getElementById('ch-restore-commit').click();
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < (tries || 60); i++) {
      if (fn()) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return fn();
  };
  const gotResult = await waitFor(() =>
    (window.document.getElementById('ch-restore-body') || {}).textContent &&
    window.document.getElementById('ch-restore-body').textContent.includes('is back'));
  ok('sheet: commit replaces the preview with the counted result state', !!gotResult);
  const resultText = window.document.getElementById('ch-restore-body').textContent;
  ok('sheet: result reports counts + status, offers a View jump',
    resultText.includes('1 link moved back · 3 relationships restored') &&
    resultText.includes('Liam Locke returns as candidate.') &&
    !!window.document.getElementById('ch-restore-view'));
  ok('sheet: stored row restored verbatim (status + snapshot cleared)',
    (() => { const r = window.__domsb.rows.find(x => x.id === 'cL');
      return r.status === 'candidate' && r.duplicate_of === null && r.merge_snapshot === null; })());
  run(`closeCharRestoreSheet();`);
  ok('sheet: closes cleanly; card count decremented to 0 restorable',
    !window.document.getElementById('ch-restore-back') &&
    container.innerHTML.includes('0 can be restored'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
