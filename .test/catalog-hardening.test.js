/* v207 catalog-hardening tests: tropeNormTerm, tropeResolveId (exact,
   alias, normalization variants, exclusion vetoes, row-level overrides),
   TropeTaxonomy.resolveId over the merged live list, validateTropeResults
   alias mapping, prompt tightening, and alias/exclusion map sanity.
   Run: node .test/catalog-hardening.test.js */
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
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    },
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

  /* ---- A. tropeNormTerm ---- */
  {
    const n = probe('tropeNormTerm');
    ok('spaces/underscores/case collapse to slug',
      n('Enemies To Lovers') === 'enemies-to-lovers' &&
      n('enemies_to_lovers') === 'enemies-to-lovers');
    ok('diacritics stripped', n('Café') === 'cafe');
    ok('punctuation trimmed', n('  Grumpy/Sunshine!! ') === 'grumpy-sunshine');
    ok('empty -> empty', n('') === '' && n(null) === '');
  }

  /* ---- B. tropeResolveId over the bundled catalog ---- */
  {
    const r = probe('tropeResolveId');
    ok('exact id resolves', r('dragons') === 'dragons');
    ok('alias resolves to canonical', r('reverse harem') === 'why-choose');
    ok('multi-word alias with punctuation',
      r("dead man's switch") === 'dead-mans-switch');
    ok('normalization variant resolves', r('Morally_Gray') === 'morally-grey');
    ok('betrayal is now a legitimate trope (v314)', r('betrayal') === 'betrayal');
    ok('excluded term vetoed (prince != royalty)', r('prince') === null);
    ok('unknown -> null', r('not-a-trope') === null);
    ok('empty -> null', r('') === null && r(null) === null);
    // Row-level aliases override the bundled map (live DB rows).
    const custom = [{ id: 'x', name: 'X', aliases: ['my alias'], exclusions: [] }];
    ok('row-level alias honored', r('my alias', custom) === 'x');
    const veto = [{ id: 'dragons', name: 'D', aliases: ['dragon'],
                    exclusions: ['dragon'] }];
    ok('row-level exclusion vetoes its own alias', r('dragon', veto) === null);
  }

  /* ---- C. TropeTaxonomy.resolveId over the merged live list ---- */
  {
    probe(`TropeTaxonomy._db = [
      { id: 'custom-x', name: 'Custom', description: '', genres: ['romance'],
        aliases: ['my alias'], exclusions: [] }
    ];`);
    ok('db-row alias resolves', probe(`TropeTaxonomy.resolveId('my alias')`) === 'custom-x');
    ok('bundled alias still resolves with db present',
      probe(`TropeTaxonomy.resolveId('reverse harem')`) === 'why-choose');
    probe('TropeTaxonomy._db = null;');
  }

  /* ---- D. validateTropeResults: aliases in, canonical out ---- */
  {
    const out = probe(`validateTropeResults([
      { id: 'reverse harem', confidence: 0.8 },
      { id: 'why-choose', confidence: 0.6 },
      { id: 'dragons', confidence: 0.9 },
      { id: 'not-a-trope', confidence: 0.95 },
      { id: 'not-a-trope', confidence: 0.7 },
      { id: 'slow burn', confidence: 1.5 },
      { id: null, confidence: 0.5 },
    ])`);
    const ids = out.map(o => o.id).sort();
    ok('alias mapped to canonical id', ids.includes('why-choose'));
    ok('canonical+alias deduped to one row',
      out.filter(o => o.id === 'why-choose').length === 1);
    ok('unknown and excluded terms dropped',
      !ids.includes('not-a-trope'));
    ok('no alias ids leak into output',
      out.every(o => probe(`TropeTaxonomy.byId(${JSON.stringify(o.id)})`) !== null));
    const slow = out.find(o => o.id === 'slow-burn');
    ok('confidence still clamped', slow && slow.confidence === 1);
  }

  /* ---- E. prompt tightening ---- */
  {
    const p = probe('TROPE_SYSTEM_PROMPT');
    ok('prompt demands character-for-character ids',
      p.includes('character-for-character'));
    ok('prompt names the display-name failure mode',
      p.includes('enemies to lovers') && p.includes('enemies-to-lovers'));
  }

  /* ---- F. map sanity: no alias collides with another trope ---- */
  {
    const res = probe(`(() => {
      const bad = [];
      for (const [id, als] of Object.entries(TROPE_ALIASES)) {
        for (const a of als) {
          const got = tropeResolveId(a);
          if (got !== id) bad.push(a + ' -> ' + got + ' (want ' + id + ')');
          const ex = (TROPE_EXCLUSIONS[id] || []);
          for (const x of ex) {
            if (tropeResolveId(x) === id) bad.push('exclusion leak: ' + x + ' -> ' + id);
          }
        }
      }
      return bad;
    })()`);
    ok('every alias resolves to its own trope, no exclusion leaks',
      res.length === 0 || (console.log('   collisions: ' + res.join('; ')), false));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
