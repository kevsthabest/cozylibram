/* v154 community-vote tests: tropeDisplayConfidence, TropeVotes
   aggregation/cast/toggle, and vote buttons in dbTropeChipsHTML.
   Run: node .test/trope-votes.test.js */
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
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SPICY_CONFIG: {},
    library: [],
    localUid: 'user-1',
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

  /* In-memory trope_votes fake. */
  function useFakeVotes(seedRows) {
    probe(`window.__voteRows = ${JSON.stringify(seedRows)}; window.__voteLog = []; window.__selects = 0;`);
    probe(`TropeVotes.configure({ getClient: async () => ({
      from: (table) => {
        if (table !== 'trope_votes') throw new Error('unexpected table ' + table);
        return {
          select: () => ({ eq: (col, val) => {
            window.__selects++;
            return Promise.resolve({ data: window.__voteRows.filter(r => r.book_key === val), error: null });
          }}),
          upsert: (row) => {
            window.__voteLog.push(['upsert', row]);
            const i = window.__voteRows.findIndex(r =>
              r.book_key === row.book_key && r.trope_id === row.trope_id && r.user_id === row.user_id);
            if (i >= 0) window.__voteRows[i] = row; else window.__voteRows.push(row);
            return Promise.resolve({ error: null });
          },
          delete: () => ({ eq: (c1, v1) => ({ eq: (c2, v2) => ({ eq: (c3, v3) => {
            window.__voteLog.push(['delete', v1, v2, v3]);
            window.__voteRows = window.__voteRows.filter(r =>
              !(r.book_key === v1 && r.trope_id === v2 && r.user_id === v3));
            return Promise.resolve({ error: null });
          }})})}),
        };
      },
    }) })`);
    probe('TropeVotes.invalidate()');
  }

  /* ---- 1. safe confidence recomputation ---- */
  {
    ok('no votes -> base unchanged', probe('tropeDisplayConfidence(0.8)') === 0.8);
    ok('net +3 nudges +0.12',
      Math.abs(probe('tropeDisplayConfidence(0.8, { up: 4, down: 1 })') - 0.92) < 1e-9);
    ok('clamps at the top', probe('tropeDisplayConfidence(0.95, { up: 10, down: 0 })') === 0.99);
    ok('clamps at the bottom', probe('tropeDisplayConfidence(0.1, { up: 0, down: 10 })') === 0.05);
    ok('bad base defaults to 0.5', probe('tropeDisplayConfidence("x", { up: 1, down: 0 })') === 0.54);
    ok('votes saturate: pile-on cannot flip',
      probe('tropeDisplayConfidence(0.9, { up: 0, down: 100 })') === 0.05 &&
      probe('tropeDisplayConfidence(0.9, { up: 0, down: 9 })') > 0.5);
  }

  /* ---- 2. aggregation ---- */
  {
    useFakeVotes([
      { book_key: 'k1', trope_id: 'dragons', user_id: 'user-1', vote: 1 },
      { book_key: 'k1', trope_id: 'dragons', user_id: 'user-2', vote: 1 },
      { book_key: 'k1', trope_id: 'dragons', user_id: 'user-3', vote: -1 },
      { book_key: 'k1', trope_id: 'quests', user_id: 'user-2', vote: -1 },
    ]);
    const agg = await probe(`TropeVotes.getVotes('k1')`);
    ok('up/down counted', agg.dragons.up === 2 && agg.dragons.down === 1);
    ok('mine detected', agg.dragons.mine === 1);
    ok('mine defaults to 0 for others', agg.quests.mine === 0 && agg.quests.down === 1);
    const selects = probe('window.__selects');
    await probe(`TropeVotes.getVotes('k1')`);
    ok('aggregates are cached', probe('window.__selects') === selects);
  }

  /* ---- 3. cast + retract ---- */
  {
    useFakeVotes([]);
    const e1 = await probe(`TropeVotes.vote('k2', 'dragons', 1)`);
    const log = probe('window.__voteLog');
    ok('upvote upserts own row',
      log.length === 1 && log[0][0] === 'upsert' &&
      log[0][1].book_key === 'k2' && log[0][1].trope_id === 'dragons' &&
      log[0][1].user_id === 'user-1' && log[0][1].vote === 1);
    ok('vote returns fresh aggregate', e1.mine === 1 && e1.up === 1);
    await probe(`TropeVotes.vote('k2', 'dragons', -1)`);
    ok('switching to down updates the row',
      probe('window.__voteRows')[0].vote === -1 &&
      probe('window.__voteRows').length === 1);
    await probe(`TropeVotes.vote('k2', 'dragons', 0)`);
    ok('retract deletes the row',
      probe('window.__voteLog').some(l => l[0] === 'delete') &&
      probe('window.__voteRows').length === 0);
    const agg = await probe(`TropeVotes.getVotes('k2')`);
    ok('cache invalidated after vote', !agg.dragons || (agg.dragons.up === 0 && agg.dragons.mine === 0));
  }

  /* ---- 4. toggle semantics ---- */
  {
    useFakeVotes([{ book_key: 'k3', trope_id: 'dragons', user_id: 'user-1', vote: 1 }]);
    await probe(`TropeVotes.toggleVote('k3', 'dragons', 1)`);
    ok('tap again retracts', probe('window.__voteRows').length === 0);
    await probe(`TropeVotes.toggleVote('k3', 'dragons', -1)`);
    ok('tap other side switches', probe('window.__voteRows')[0].vote === -1);
  }

  /* ---- 5. signed-out ---- */
  {
    useFakeVotes([]);
    probe('localUid = null');
    ok('canVote false when signed out', probe('TropeVotes.canVote()') === false);
    let threw = false;
    try { await probe(`TropeVotes.vote('k4', 'dragons', 1)`); }
    catch (e) { threw = true; }
    ok('vote throws when signed out', threw);
    const agg = await probe(`TropeVotes.getVotes('k4')`);
    ok('reads still work signed out', JSON.stringify(agg) === '{}');
    probe('localUid = "user-1"');
    ok('canVote true when signed in', probe('TropeVotes.canVote()') === true);
  }

  /* ---- 6. chip buttons ---- */
  {
    useFakeVotes([
      { book_key: 'k5', trope_id: 'dragons', user_id: 'user-1', vote: 1 },
      { book_key: 'k5', trope_id: 'dragons', user_id: 'user-2', vote: 1 },
      { book_key: 'k5', trope_id: 'dragons', user_id: 'user-3', vote: -1 },
    ]);
    const votes = await probe(`TropeVotes.getVotes('k5')`);
    const html = probe(`dbTropeChipsHTML(
      [{ id: 'dragons', name: 'Dragons', confidence: 0.8 }], 'db',
      ${JSON.stringify(votes)})`);
    ok('vote buttons render for signed-in users',
      html.includes('data-tv="1"') && html.includes('data-tv="-1"') &&
      html.includes('data-tid="dragons"'));
    ok('own vote highlighted', html.includes('tvbtn on') && html.includes('data-tv="1"'));
    ok('net score shown', html.includes('tvnet') && html.includes('+1'));
    ok('tooltip shows adjusted confidence + community',
      html.includes('84% confidence') && html.includes('community +1'));

    probe('localUid = null');
    const htmlOut = probe(`dbTropeChipsHTML(
      [{ id: 'dragons', name: 'Dragons', confidence: 0.8 }], 'db',
      ${JSON.stringify(votes)})`);
    ok('no buttons when signed out', !htmlOut.includes('data-tv='));
    probe('localUid = "user-1"');

    const heur = probe(`dbTropeChipsHTML(
      [{ id: null, name: 'slow burn' }], 'heuristics', {})`);
    ok('no buttons on heuristic chips', !heur.includes('data-tv='));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
