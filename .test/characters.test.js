/* Character wiki unit tests (v335) — avatar, role ranking, title normalization.
   Run: node .test/characters.test.js */
'use strict';
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

// Mirror of charPrimaryRole from js/159-characters.js (keep in sync)
function charPrimaryRole(instances) {
  const order = { protagonist: 0, antagonist: 1, supporting: 2, minor: 3 };
  let best = 'minor', bestRank = 4;
  (instances || []).forEach(inst => {
    const r = order[inst.role];
    if (r != null && r < bestRank) { bestRank = r; best = inst.role; }
  });
  return best;
}

// Mirror of normTitle from renderCharacterPage (keep in sync)
const normTitle = t => String(t || '').toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();

/* ---- charPrimaryRole ---- */
ok('protagonist wins over antagonist',
  charPrimaryRole([{role:'antagonist'},{role:'protagonist'}]) === 'protagonist');
ok('antagonist wins over supporting',
  charPrimaryRole([{role:'supporting'},{role:'antagonist'}]) === 'antagonist');
ok('single minor', charPrimaryRole([{role:'minor'}]) === 'minor');
ok('empty defaults to minor', charPrimaryRole([]) === 'minor');
ok('unknown role ignored', charPrimaryRole([{role:'weird'}]) === 'minor');

/* ---- normTitle (cover matching) ---- */
ok('strips parenthetical', normTitle('Fourth Wing (Part 1 of 2)') === 'fourth wing');
ok('lowercases', normTitle('IRON FLAME') === 'iron flame');
ok('trims whitespace', normTitle('  Onyx Storm  ') === 'onyx storm');
ok('empty stays empty', normTitle('') === '');
ok('null stays empty', normTitle(null) === '');
ok('exact match works', normTitle('Fourth Wing') === normTitle('fourth wing'));
ok('parenthetical variants match', normTitle('Dune (Movie Tie-in)') === normTitle('Dune'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
