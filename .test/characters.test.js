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

/* ---- charQuotesHTML escaping (mirror — keep in sync) ---- */
// Minimal esc() mirror for testing
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function charQuotesHTML(quotes) {
  if (!quotes || !quotes.length) return '';
  let h = '<h3 class="serif">Memorable quotes</h3><div class="ch-quotes">';
  quotes.slice(0, 5).forEach(q => {
    h += '<blockquote class="ch-quote"><p>"' + esc(q.quote) + '"</p>' +
      (q.context ? '<cite>' + esc(q.context) + '</cite>' : '') +
      (q.workTitle ? '<span class="note"> — ' + esc(q.workTitle) + '</span>' : '') +
      '</blockquote>';
  });
  h += '</div>';
  return h;
}

ok('quotes HTML escapes script tags',
  !charQuotesHTML([{quote: '<script>alert(1)</script>'}]).includes('<script>'));
ok('quotes HTML escapes quotes in text',
  charQuotesHTML([{quote: 'He said "hi"'}]).includes('&quot;hi&quot;'));
ok('empty quotes returns empty string', charQuotesHTML([]) === '');
ok('null quotes returns empty string', charQuotesHTML(null) === '');
ok('caps at 5 quotes',
  (charQuotesHTML([1,2,3,4,5,6].map(i => ({quote: 'q'+i}))).match(/<blockquote/g) || []).length === 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
