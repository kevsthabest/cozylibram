// Review batch 4 (issues #142–#150): release sweep cap + priority, gate Enter
// key, SW theme precache, pace pagesInRange, genre-gap threshold, similar-book
// genre scoring, WorkStore invalidation, search debounce.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';

const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in batch4 tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; if (!cond) console.log('FAIL - ' + name); };
const run = (code) => window.eval(code);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- #142: auto sweep cap + priority ordering ----------
run(`localStorage.clear(); library = [
  { id: 'a1', title: 'A1', authors: ['Prolific'], status: 'read', myRating: 3, categories: [] },
  { id: 'a2', title: 'A2', authors: ['Prolific'], status: 'read', myRating: 3, categories: [] },
  { id: 'a3', title: 'A3', authors: ['Prolific'], status: 'read', myRating: 3, categories: [] },
  { id: 'b1', title: 'B1', authors: ['Loved'], status: 'read', myRating: 5, categories: [], favorite: true },
  { id: 'c1', title: 'C1', authors: ['Recent'], status: 'read', myRating: 4, categories: [], dateFinished: new Date().toISOString() },
  { id: 'd1', title: 'D1', authors: ['Stale'], status: 'read', myRating: 4, categories: [], dateFinished: '2020-01-01T00:00:00.000Z' }
];`);
const prio = run(`priorityReleaseAuthors()`);
ok('#142 favorited author first', prio[0] === 'Loved');
ok('#142 recently-finished author boosted above plain prolific', prio.indexOf('Recent') < prio.indexOf('Prolific'));
ok('#142 old finish gets no recency boost', prio.indexOf('Stale') > prio.indexOf('Recent'));
// Cap: 45 distinct authors -> capped at 40
run(`library = []; for (let i = 0; i < 45; i++) library.push({ id: 'x' + i, title: 'T' + i, authors: ['Author' + i], status: 'read', myRating: 4, categories: [] });`);
const capped = run(`priorityReleaseAuthors()`);
ok('#142 auto list capped at 40', capped.length === 40);
ok('#142 cap constant is 40', run(`AUTO_RELEASE_AUTHOR_CAP`) === 40);
// Manual path keeps full coverage
const full = run(`topReleaseAuthors()`);
ok('#142 manual path still covers all authors', full.length === 45);
// checkNewReleases honors an explicit author list (auto) vs default (manual)
ok('#142 checkNewReleases accepts authorList param',
  run(`checkNewReleases.toString()`).includes('authorList'));

// ---------- #143: Enter submits gate forms ----------
run(`localStorage.clear();`);
let signedIn = null;
window.cloudSignIn = (em, pw) => { signedIn = [em, pw]; };
window.cloudConfigured = () => true; // test env has no server config
run(`renderGate()`);
{
  const em = window.document.getElementById('gate-email');
  const pw = window.document.getElementById('gate-pass');
  ok('#143 gate renders email+password', !!em && !!pw);
  em.value = 'a@b.c'; pw.value = 'secret1';
  const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  pw.dispatchEvent(ev);
  ok('#143 Enter in password field submits sign-in', signedIn && signedIn[0] === 'a@b.c' && signedIn[1] === 'secret1');
}
let signedUp = null;
window.cloudSignUp = (em, pw, f, l) => { signedUp = [em, pw, f, l]; };
run(`renderGateSignup()`);
{
  window.document.getElementById('gs-first').value = 'A';
  window.document.getElementById('gs-last').value = 'B';
  window.document.getElementById('gs-email').value = 'n@e.w';
  window.document.getElementById('gs-pass').value = 'secret1';
  window.document.getElementById('gs-pass2').value = 'secret1';
  const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  window.document.getElementById('gs-pass2').dispatchEvent(ev);
  ok('#143 Enter in signup submits', signedUp && signedUp[0] === 'n@e.w');
}
run(`renderGateReset()`);
{
  const sent = [];
  window.cloudResetPassword = async (em) => { sent.push(em); return true; };
  window.document.getElementById('gr-email').value = 'r@e.set';
  const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  window.document.getElementById('gr-email').dispatchEvent(ev);
  ok('#143 Enter in reset sends link', sent.length === 1 && sent[0] === 'r@e.set');
}

// ---------- #144: SW precache matches the CSS theme refs ----------
{
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  const css = fs.readFileSync(path.join(APP_DIR, 'styles.css'), 'utf8');
  const cssRefs = new Set();
  const re = /Asset\/themes\/[a-z-]+\.svg/g;
  let m; while ((m = re.exec(css))) cssRefs.add('./' + m[0]);
  // THEME_ART is built by a flatMap expression — evaluate the real thing.
  const themeArt = eval(sw.match(/const THEME_ART = (.*?);/s)[1]);
  const missing = [...cssRefs].filter(r => !themeArt.includes(r));
  ok('#144 every CSS theme SVG is precached (' + cssRefs.size + ' refs)', missing.length === 0);
  if (missing.length) console.log('   missing: ' + missing.join(', '));
  ok('#144 no vine-*.svg dead entries', !themeArt.some(e => /vine-/.test(e)));
  ok('#144 no floral-right.svg in precache list', !/'\.\/Asset\/floral-right\.svg'/.test(sw));
  // every precached theme file exists on disk
  const gone = themeArt.filter(p => !fs.existsSync(path.join(APP_DIR, p.slice(2))));
  ok('#144 all precached theme files exist on disk (' + themeArt.length + ')', gone.length === 0);
}

// ---------- #145: pagesInRange equivalence with the old loops ----------
run(`localStorage.clear(); library = [
  { id: 'p1', title: 'P1', authors: ['A'], status: 'reading', myRating: 0, categories: [],
    log: [{ d: '2026-10-10', from: 0, to: 40 }, { d: '2026-10-11', from: 40, to: 90 }, { d: '', from: 0, to: 10 }] },
  { id: 'p2', title: 'P2', authors: ['B'], status: 'reading', myRating: 0, categories: [],
    log: [{ d: '2026-10-10', from: 5, to: 5 }, { d: '2026-10-12', from: 0, to: 25 }] }
];`);
// old paceHTML loop, replicated literally:
const oldP30 = run(`(() => {
  let p30 = 0;
  const days = ['2026-10-12','2026-10-11','2026-10-10'];
  // emulate: 3-day window version of the old 30-day loop
  days.forEach(k => library.forEach(b => { p30 += pagesOnDay(b, k); }));
  return p30;
})()`);
const newP30 = run(`pagesInRange('2026-10-10', '2026-10-12')`);
ok('#145 pagesInRange matches old loop sum (' + oldP30 + ')', oldP30 === newP30 && newP30 === 40 + 50 + 25);
ok('#145 paceHTML runs on fixture', run(`typeof paceHTML()`) === 'string');

// ---------- #146: genre-gap threshold ----------
const genreGapObs = (books) => run(`library = ${JSON.stringify(books)}; patternObservations().filter(s => /higher than/.test(s));`);
const gbook = (id, genre, rating) => ({ id, title: id, authors: ['A'], status: 'read', myRating: rating, categories: [genre] });
// 0.3 gap (below 0.5): Romance avg 5.0 vs Mystery avg 4.7
let obs = genreGapObs([
  gbook('g1', 'Romance', 5), gbook('g2', 'Romance', 5), gbook('g3', 'Romance', 5),
  gbook('m1', 'Mystery', 4.7), gbook('m2', 'Mystery', 4.7), gbook('m3', 'Mystery', 4.7),
]);
ok('#146 0.3★ gap no longer fires', obs.length === 0);
// 1.0 gap (>= 0.5): fires
obs = genreGapObs([
  gbook('g1', 'Romance', 5), gbook('g2', 'Romance', 5), gbook('g3', 'Romance', 5),
  gbook('m1', 'Mystery', 4), gbook('m2', 'Mystery', 4), gbook('m3', 'Mystery', 4),
]);
ok('#146 1.0★ gap still fires', obs.length === 1 && /Romance/.test(obs[0]));
ok('#146 threshold is a named constant at 0.5', run(`GENRE_GAP_MIN`) === 0.5);

// ---------- #147: dead genre-overlap term removed (ranking = author + tropes) ----------
// Candidates in production are hcBookToCandidate-shaped (no genres/categories),
// so the old +2 genre term never scored. Assert real behavior: a genre-only
// match is excluded, and author overlap (+3) outranks trope overlap (+1).
run(`visibleRecos = [
  { c: { hcId: '1', title: 'TropeOnly', authors: ['X'], tropes: ['enemies-to-lovers'] }, sim: 0.5 },
  { c: { hcId: '2', title: 'AuthorMatch', authors: ['Y'], tropes: [] }, sim: 0.5 },
  { c: { hcId: '3', title: 'GenreOnly', authors: ['Z'], categories: ['Romance'], tropes: [] }, sim: 0.5 }
];`);
{
  const box = window.document.createElement('div');
  box.id = 'disc-reco';
  window.document.body.appendChild(box);
  run(`showSimilarToSeed({ title: 'Seed', authors: ['Y'], categories: ['Romance'], tropes: ['enemies-to-lovers'] })`);
  const titles = Array.from(box.querySelectorAll('.rel-card h3')).map(h => h.textContent);
  ok('#147 author overlap (+3) outranks trope overlap (+1)', titles[0] === 'AuthorMatch' && titles[1] === 'TropeOnly');
  ok('#147 genre-only candidate is excluded (dead term removed)', !titles.includes('GenreOnly'));
  box.remove();
}
run(`visibleRecos = [];`);

// ---------- #148: WorkStore.invalidate clears the cached work ----------
{
  const cleared = run(`(() => {
    const b = { id: 'w1', title: 'T', authors: ['A'] };
    const key = WorkStore._cacheKey(b, workKeysFor(b));
    WorkStore._cache[key] = { workId: 'old-work' };
    WorkStore.invalidate(b);
    return !(key in WorkStore._cache);
  })()`);
  ok('#148 invalidate() busts the cached work', cleared === true);
}

// ---------- #149: search input debounced ----------
(async () => {
  run(`localStorage.clear(); library = []; filter = 'all'; ownFilter = 'all'; query = ''; view = 'library'; renderLibrary();`);
  const q1 = window.document.getElementById('q');
  ok('#149 search box renders', !!q1);
  if (q1) {
    q1.value = 'ab';
    q1.dispatchEvent(new window.Event('input', { bubbles: true }));
    ok('#149 query updates immediately', run(`query`) === 'ab');
    const stillQ1 = window.document.getElementById('q') === q1;
    ok('#149 no synchronous re-render per keystroke', stillQ1);
    await sleep(300);
    const q2 = window.document.getElementById('q');
    ok('#149 debounced re-render fires (~150ms)', q2 && q2 !== q1 && q2.value === 'ab');
    ok('#149 focus + caret restored after debounce', window.document.activeElement === q2);
  }
  console.log(`\nbatch4: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
