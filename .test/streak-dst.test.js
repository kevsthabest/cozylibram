// Longest-streak DST regression tests — issue #361.
// Both longest-streak implementations (js/040 longestStreak, js/219
// longestStreakFor) mapped each day key to LOCAL noon and required the
// exact 864e5 ms gap to call days consecutive. Noon-to-noon across a
// DST transition is 23h (spring) or 25h (fall), so any streak spanning
// a clock change was cut short — and the js/219 copy gates the
// streak-days-7 / streak-days-30 milestones, making a genuine 30-day
// streak across fall-back unearnable. The fix measures the gap in UTC
// (the pattern js/170's year streak already used).
// This suite forces TZ=America/Halifax (the primary user's zone, with
// both 2026 transitions) before anything reads a Date.
process.env.TZ = 'America/Halifax';

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in streak-dst tests'); };
require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

// Sanity: the forced zone really is in effect (otherwise the DST cases
// below would pass vacuously on a UTC host).
const gapSpring = new Date('2026-03-08T12:00:00').getTime() - new Date('2026-03-07T12:00:00').getTime();
ok('TZ is America/Halifax (spring noon gap is 23h)', gapSpring === 82800000);

// N consecutive local day keys starting at (y, m, d), formatted the way
// dayKey formats them.
const dayKeys = (y, m, d, n) => {
  const out = [];
  const dt = new Date(y, m - 1, d);
  for (let i = 0; i < n; i++) {
    out.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'));
    dt.setDate(dt.getDate() + 1);
  }
  return out;
};
const libWithDays = (keys) => [{
  id: 'sd1', title: 'Streak Book', authors: ['A'], status: 'reading',
  log: keys.map(k => ({ d: k, from: 0, to: 5 })),
}];

const springLib = libWithDays(dayKeys(2026, 3, 4, 10));   // spans Mar 8 spring-forward
const fallLib = libWithDays(dayKeys(2026, 10, 18, 30));   // spans Nov 1 fall-back
const plainLib = libWithDays(dayKeys(2026, 6, 1, 10));    // no transition (control)
const gappedLib = libWithDays(dayKeys(2026, 3, 4, 5).concat(dayKeys(2026, 3, 10, 5))); // a missing day

// js/219 pure copy.
ok('longestStreakFor: 10 days across spring-forward counts 10', window.longestStreakFor(springLib) === 10);
ok('longestStreakFor: 30 days across fall-back counts 30', window.longestStreakFor(fallLib) === 30);
ok('longestStreakFor: 10 plain days counts 10 (control)', window.longestStreakFor(plainLib) === 10);
ok('longestStreakFor: a missing day still breaks the run', window.longestStreakFor(gappedLib) === 5);

// js/040 global copy, over the seeded library.
runInWindow(`(function(){
  library.length = 0;
  ${JSON.stringify(springLib)}.forEach(b => library.push(b));
})();`);
ok('longestStreak (js/040): 10 days across spring-forward counts 10', window.eval('longestStreak()') === 10);
runInWindow(`(function(){
  library.length = 0;
  ${JSON.stringify(fallLib)}.forEach(b => library.push(b));
})();`);
ok('longestStreak (js/040): 30 days across fall-back counts 30', window.eval('longestStreak()') === 30);

console.log('streak-dst: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
