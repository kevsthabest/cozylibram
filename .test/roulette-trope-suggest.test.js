// v236/v247: trope autocomplete on the roulette "Trope or tag" filter.
//
// Covered: the pure tropeSuggestions() ranking (TBR tropes first by book
// count, then the canonical catalog; query filtering; limit), and the
// suggestion dropdown behavior (shows on input/focus, click fills the
// input, Escape hides).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in roulette tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

const BOOKS = [
  { id: 'b1', title: 'One', status: 'tbr', tropes: ['Enemies to Lovers', 'Forced Proximity'] },
  { id: 'b2', title: 'Two', status: 'tbr', tropes: ['Enemies to Lovers', 'Dragons'] },
  { id: 'b3', title: 'Three', status: 'read', tropes: ['Enemies to Lovers'] }, // not TBR: ignored
  { id: 'b4', title: 'Four', status: 'tbr', tropes: [] },
];

(async () => {
  run('library = ' + JSON.stringify(BOOKS) + ';');

  /* ---- 1. pure ranking ---- */
  const top = run('tropeSuggestions("", 8)');
  ok('TBR tropes come first, ranked by book count',
    top[0].name === 'Enemies to Lovers' && top[0].count === 2);
  ok('second TBR trope follows', top[1].count === 1);
  ok('read-shelf books do not count', top[0].count === 2);
  const names = top.map(t => t.name);
  ok('canonical catalog fills the rest', names.length === 8 && names.slice(3).every(n => typeof n === 'string'));

  /* ---- 2. query filtering ---- */
  const drag = run('tropeSuggestions("drag", 8)');
  ok('query filters to matches', drag.length >= 1 && drag.every(t =>
    t.name.toLowerCase().indexOf('drag') !== -1));
  ok('TBR match outranks catalog matches', drag[0].name === 'Dragons' && drag[0].count === 1);
  const none = run('tropeSuggestions("zzz-no-such-trope", 8)');
  ok('no matches -> empty list', Array.isArray(none) && none.length === 0);

  /* ---- 3. limit ---- */
  ok('limit is honored', run('tropeSuggestions("", 3)').length === 3);

  /* ---- 4. dropdown behavior ---- */
  await run('renderPick()'); await tick(3);
  ok('trope input is wrapped for the dropdown', !!q('.pk-trope-wrap #pk-trope'));
  const input = q('#pk-trope'), box = q('#pk-suggest');
  ok('suggestions hidden initially', box.hidden === true);
  input.value = 'enem';
  input.dispatchEvent(new window.Event('input', { bubbles: true })); await tick(2);
  ok('typing shows matching suggestions',
    box.hidden === false && box.textContent.indexOf('Enemies to Lovers') !== -1);
  ok('suggestion shows the book count', box.textContent.indexOf('2 books') !== -1);
  const btn = box.querySelector('[data-ts]');
  btn.click(); await tick(2);
  ok('clicking a suggestion fills the input', input.value === 'Enemies to Lovers');
  ok('dropdown hides after picking', box.hidden === true);
  // Reopen, then Escape.
  input.dispatchEvent(new window.Event('input', { bubbles: true })); await tick(2);
  ok('dropdown reopens on input', box.hidden === false);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(1);
  ok('Escape hides the dropdown', box.hidden === true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
