/* v208 auto-publishing tests: evidence cleaning, evidence penalty in
   validateTropeResults, confidence tiers + auto-publish rules, input-hash
   stability, isRegenerableClaim, and the evidence requirement in the
   system prompt.
   Run: node .test/auto-publish.test.js */
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

  const cleanEvidence = probe('cleanEvidence');
  const validate = probe('validateTropeResults');
  const tier = probe('tropeClaimTier');
  const autoPub = probe('tropeAutoPublish');
  const isRegen = probe('isRegenerableClaim');
  const inputHash = probe('tropeInputHash');

  /* ---- A. cleanEvidence ---- */
  ok('keeps up to 2 trimmed quotes',
    JSON.stringify(cleanEvidence(['  a quote here  ', 'second quote', 'third']))
    === JSON.stringify(['a quote here', 'second quote']));
  ok('drops too-short quotes', cleanEvidence(['abc', 'x']).length === 0);
  ok('collapses whitespace', cleanEvidence(['a  b\nc d'])[0] === 'a b c d');
  ok('caps at 200 chars', cleanEvidence(['q'.repeat(300)])[0].length === 200);
  ok('non-array -> []', cleanEvidence('nope').length === 0 &&
    cleanEvidence(null).length === 0);
  ok('non-string entries coerced or dropped',
    cleanEvidence([42, 'fine quote']).length === 1);

  /* ---- B. validateTropeResults evidence handling ---- */
  {
    const raw = [{ id: 'dragons', confidence: 0.9, evidence: ['dragons soar above'] }];
    const out = validate(raw);
    ok('evidence preserved on valid trope',
      out.length === 1 && out[0].id === 'dragons' &&
      out[0].evidence[0] === 'dragons soar above');
  }
  {
    // no evidence -> -0.15 penalty
    const out = validate([{ id: 'dragons', confidence: 0.9 }]);
    ok('missing evidence penalizes confidence',
      out.length === 1 && Math.abs(out[0].confidence - 0.75) < 1e-9);
  }
  {
    // 0.6 with no evidence -> 0.45 -> dropped
    const out = validate([{ id: 'dragons', confidence: 0.6 }]);
    ok('penalty drops trope below 0.5', out.length === 0);
  }
  {
    // 0.64 no evidence -> 0.49 dropped; with evidence kept
    ok('0.64 + evidence kept',
      validate([{ id: 'dragons', confidence: 0.64,
                   evidence: ['the dragons attack'] }]).length === 1);
    ok('0.64 without evidence dropped',
      validate([{ id: 'dragons', confidence: 0.64 }]).length === 0);
  }
  {
    // unknown id with evidence still dropped
    ok('unknown id dropped even with evidence',
      validate([{ id: 'not-a-trope', confidence: 0.99,
                   evidence: ['some quote here'] }]).length === 0);
  }
  {
    // alias resolution keeps evidence
    const out = validate([{ id: 'reverse harem', confidence: 0.9,
                             evidence: ['multiple love interests gather'] }]);
    ok('alias resolves with evidence intact',
      out.length === 1 && out[0].id === 'why-choose' && out[0].evidence.length === 1);
  }
  {
    // literal-substring verification against the description
    const desc = 'The dragon soars above the burning mountains at dawn.';
    const real = validate(
      [{ id: 'dragons', confidence: 0.9, evidence: ['SOARS ABOVE the burning mountains'] }], desc);
    ok('real quote kept (case/whitespace-insensitive match)',
      real.length === 1 && real[0].evidence.length === 1 &&
      Math.abs(real[0].confidence - 0.9) < 1e-9);
    const fake = validate(
      [{ id: 'dragons', confidence: 0.9, evidence: ['the dragon pilots a starship'] }], desc);
    ok('invented quote dropped, penalty applies',
      fake.length === 1 && fake[0].evidence.length === 0 &&
      Math.abs(fake[0].confidence - 0.75) < 1e-9);
    const boundary = validate(
      [{ id: 'dragons', confidence: 0.6, evidence: ['the dragon pilots a starship'] }], desc);
    ok('invented quote at boundary drops the trope', boundary.length === 0);
    const mixed = validate(
      [{ id: 'dragons', confidence: 0.9,
         evidence: ['the dragon pilots a starship', 'soars above the burning mountains'] }], desc);
    ok('mixed evidence keeps only the verified quote',
      mixed.length === 1 && mixed[0].evidence.length === 1 &&
      mixed[0].evidence[0] === 'soars above the burning mountains' &&
      Math.abs(mixed[0].confidence - 0.9) < 1e-9);
    const noDesc = validate(
      [{ id: 'dragons', confidence: 0.9, evidence: ['some quote here'] }]);
    ok('no description -> evidence kept as-is (fallback)',
      noDesc.length === 1 && noDesc[0].evidence.length === 1);
  }

  /* ---- C. tiers + auto-publish ---- */
  ok('tier high at 0.85', tier({ confidence: 0.85 }) === 'high');
  ok('tier medium at 0.84', tier({ confidence: 0.84 }) === 'medium');
  ok('tier medium at 0.60', tier({ confidence: 0.60 }) === 'medium');
  ok('tier low below 0.60', tier({ confidence: 0.59 }) === 'low');
  ok('auto-publish: high + evidence',
    autoPub({ confidence: 0.9, evidence: ['quoted support here'] }) === true);
  ok('no auto-publish: high without evidence',
    autoPub({ confidence: 0.95, evidence: [] }) === false);
  ok('no auto-publish: medium with evidence',
    autoPub({ confidence: 0.8, evidence: ['quoted support here'] }) === false);
  ok('no auto-publish: missing evidence field',
    autoPub({ confidence: 0.9 }) === false);

  /* ---- D. isRegenerableClaim ---- */
  ok('ai candidate regenerable',
    isRegen({ source_type: 'ai', status: 'candidate' }) === true);
  ok('ai auto-confirmed regenerable',
    isRegen({ source_type: 'ai', status: 'confirmed',
              evidence: { auto_confirmed: true } }) === true);
  ok('ai human-confirmed NOT regenerable',
    isRegen({ source_type: 'ai', status: 'confirmed', evidence: {} }) === false);
  ok('ai confirmed without evidence flag NOT regenerable',
    isRegen({ source_type: 'ai', status: 'confirmed' }) === false);
  ok('rejected never regenerable',
    isRegen({ source_type: 'ai', status: 'rejected' }) === false);
  ok('community rows never regenerable',
    isRegen({ source_type: 'community', status: 'candidate' }) === false);
  ok('null row -> false', isRegen(null) === false);

  /* ---- E. tropeInputHash ---- */
  {
    const b = { title: 'Fourth Wing', authors: ['Rebecca Yarros'],
                description: 'Dragons at a war college.', categories: ['romance'] };
    const h1 = inputHash(b), h2 = inputHash(b);
    ok('hash stable', h1 === h2 && /^[0-9a-f]{16}$/.test(h1));
    ok('hash changes with description',
      inputHash(Object.assign({}, b, { description: 'Something else.' })) !== h1);
    ok('hash changes with title',
      inputHash(Object.assign({}, b, { title: 'Iron Flame' })) !== h1);
    ok('hash ignores case/whitespace noise',
      inputHash(Object.assign({}, b,
        { description: '  dragons AT a war college. ' })) === h1);
    ok('hash changes with author',
      inputHash(Object.assign({}, b, { authors: ['Someone Else'] })) !== h1);
    ok('empty book hashes without throwing',
      typeof inputHash({}) === 'string');
  }

  /* ---- F. prompt requires evidence ---- */
  {
    const prompt = probe('TROPE_SYSTEM_PROMPT');
    ok('prompt demands evidence quotes',
      /evidence/i.test(prompt) && /quote/i.test(prompt));
    ok('prompt shows evidence in the JSON shape',
      prompt.indexOf('"evidence"') !== -1);
    ok('prompt forbids inventing quotes',
      /never invent/i.test(prompt));
  }

  /* ---- G. enqueue accepts force flag (shape check) ---- */
  {
    const q = probe('TropeQueue');
    q.enqueue(['x1'], { force: true });
    const s = q.snapshot();
    ok('forced job recorded', s.pending === 1);
    q.reset();
    ok('reset clears', q.snapshot().pending === 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
