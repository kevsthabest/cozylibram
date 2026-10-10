/* Character wiki unit tests (v335, rewritten v399) — tests the real
   js/159-characters.js module instead of in-test mirrors.
   Run: node .test/characters.test.js */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in characters tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const run = (js) => window.eval(js);

/* ---- charPrimaryRole (real function from js/159-characters.js) ---- */
ok('protagonist wins over antagonist',
  run(`charPrimaryRole([{role:'antagonist'},{role:'protagonist'}])`) === 'protagonist');
ok('antagonist wins over supporting',
  run(`charPrimaryRole([{role:'supporting'},{role:'antagonist'}])`) === 'antagonist');
ok('single minor', run(`charPrimaryRole([{role:'minor'}])`) === 'minor');
ok('empty defaults to minor', run(`charPrimaryRole([])`) === 'minor');
ok('unknown role ignored', run(`charPrimaryRole([{role:'weird'}])`) === 'minor');
ok('null defaults to minor', run(`charPrimaryRole(null)`) === 'minor');

/* ---- charQuotesHTML (real function, tests escaping) ---- */
ok('quotes HTML escapes script tags',
  run(`charQuotesHTML([{quote:'<script>alert(1)</script>'}])`).includes('&lt;script&gt;'));
ok('quotes HTML escapes quotes',
  run(`charQuotesHTML([{quote:'He said "hi"'}])`).includes('&quot;'));
ok('empty quotes returns empty', run(`charQuotesHTML([])`) === '');
ok('null quotes returns empty', run(`charQuotesHTML(null)`) === '');

/* ---- findCharByName (real function, uses norm) ---- */
ok('findCharByName finds exact match',
  run(`findCharByName([{name:'Peter Sebeck'}], 'Peter Sebeck')`) !== null);
ok('findCharByName is case-insensitive',
  run(`findCharByName([{name:'Peter Sebeck'}], 'peter sebeck')`) !== null);
ok('findCharByName returns null for unknown',
  run(`findCharByName([{name:'Peter Sebeck'}], 'Nobody Here')`) === null);
// v399: strong normalization (strips punctuation/articles like CharacterStore.normName)
ok('findCharByName strips punctuation',
  run(`findCharByName([{name:'Peter Sebeck'}], 'Peter Sebeck!')`) !== null);
ok('findCharByName strips leading articles',
  run(`findCharByName([{name:'Dark Tower'}], 'The Dark Tower')`) !== null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
