// v538 — Discover remake: The Stage & The Shelves (Variant B).
//
// Pins the new landing structure: the stage (single centred cover, no
// fan), the three rails (Recommended with the seed lens absorbed, New
// releases inline, From Your Hearth), the retired tiles, the honest
// empty states, and the design critique cuts (no magazine numbering,
// no fan side-covers, no friend-initial badges on Hearth covers).
// Mechanics underneath (roulette, sweeps, ranking) are pinned by their
// own suites; this file pins presentation + wiring only.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
require('./harness').loadApp(window);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log('FAIL - ' + name); }
}
const run = (code) => window.eval(code);
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));
const tick = () => new Promise(r => setTimeout(r, 30));

const book = (over) => Object.assign({
  id: 'b' + Math.random().toString(36).slice(2, 8), title: 'T', authors: ['A'],
  status: 'read', progress: 100, pageCount: 200, isbn: '', publishedDate: '',
  cover: '', tropes: [], publicRating: null, ratingsCount: 0, genres: [],
  myRating: 0, ratings: {}, axes: [], favorite: false, notes: '',
  description: '', quotes: [], log: [],
  dateAdded: '2026-01-01T00:00:00.000Z', dateFinished: null,
}, over || {});

(async () => {
  // ---------- empty library: structure + honest empty states ----------
  run(`library = []; go('discover');`);
  const html0 = q('#view').innerHTML;
  ok('stage: present with the TONIGHT\u2019S READ job label',
    !!q('.disc-stage') && /Tonight/.test(html0));
  ok('stage: headline is "Let the shelf decide."',
    html0.indexOf('Let the shelf decide.') !== -1);
  ok('copy: the old mood question is gone',
    html0.indexOf('What are you in the mood for?') === -1);
  ok('copy: header frames the two jobs',
    html0.indexOf('Two ways in') !== -1 && html0.indexOf('Find new books') !== -1);
  ok('stage: empty TBR gets honest wording, no fake cover',
    !q('.stage-cover') && /TBR is empty/.test(q('.stage-sub').textContent));
  ok('tiles retired: no favorites / search / similar / recommended doorways',
    !q('[data-dtile="favorites"]') && !q('[data-dtile="search"]') &&
    !q('[data-dtile="similar"]') && !q('[data-dtile="recommended"]'));
  ok('tiles retired: the landing itself carries no Add-a-book control',
    ![...qa('#view button')].some(b => /add a book/i.test(b.textContent)));
  ok('releases inline: section + results box + Check now, no doorway tile',
    !!q('#release-results') && !!q('#disc-rel-check') && !q('[data-dtile="releases"]'));
  ok('releases inline: All authors row lives under the section',
    !!q('.authors-row[data-dtile="authors"]') && /All authors/.test(q('.authors-row').textContent));
  ok('releases empty state: quiet landing note, no heading over nothing',
    /land here/.test(q('#release-results').textContent));
  ok('recommended empty state: taste-profile guidance note',
    /taste profile/.test(q('#disc-reco').textContent));
  ok('hearth section: heading from the bare coven name + Open link',
    /From Your/.test(html0) && !!q('#disc-coven-all'));
  await tick(); // loadRecos resolves [] signed out
  ok('hearth empty state: quiet note about circle picks',
    /circle rates/.test(q('#disc-hearth').textContent));
  ok('critique cut: no magazine numbering in any section head',
    !qa('.disc-sec-head h3').some(h => /No\.\s*\d/.test(h.textContent)));
  ok('critique cut: no numbered section markup anywhere on the landing',
    !/\bNo\.\s*[123]\b/.test(html0));

  // ---------- the stage with a TBR ----------
  run(`library = [
    ${JSON.stringify(book({ id: 'tbr1', title: 'Waiting One', authors: ['Ann Author'], status: 'tbr', cover: 'https://x.test/one.jpg', myRating: 0 }))},
    ${JSON.stringify(book({ id: 'tbr2', title: 'Waiting Two', authors: ['Zed'], status: 'tbr', cover: '' }))},
  ]; go('discover');`);
  ok('stage: exactly ONE centred cover (fan side-covers cut)',
    qa('.stage-cover').length === 1 && qa('.disc-stage [class*="fan"]').length === 0 &&
    qa('.disc-stage [class*="side"]').length === 0);
  ok('stage: the cover shown is a real TBR cover',
    q('.stage-cover img') && q('.stage-cover img').getAttribute('src') === 'https://x.test/one.jpg');
  ok('stage: sub-line counts the real TBR',
    /One of the 2 books waiting on your TBR/.test(q('.stage-sub').textContent));
  ok('stage: Surprise Me button routes to the roulette',
    !!q('.stage-btn[data-dtile="pick"]'));
  run(`library = [${JSON.stringify(book({ id: 'tbr3', title: 'Lone Wait', authors: ['Solo'], status: 'tbr', cover: '' }))}]; go('discover');`);
  ok('stage: coverless TBR book gets the title treatment, singular count',
    !!q('.stage-cover-ph') && /One of the 1 book waiting/.test(q('.stage-sub').textContent));

  // ---------- seed lens presence ----------
  run(`library.push(${JSON.stringify(book({ id: 'seed1', title: 'Beloved Book', authors: ['Ann Author'], status: 'read', myRating: 5, favorite: true }))}); go('discover');`);
  ok('seed lens: "More like:" chips render inside Recommended',
    !!q('.seed-lens') && !!q('.seed-chip[data-seed="seed1"]') &&
    q('.seed-chip[data-seed="seed1"]').textContent === 'Beloved Book');
  ok('seed lens: no standalone Similar destination remains',
    !q('#disc-sim') && !/Similar Books/.test(q('#view').innerHTML));

  // ---------- Recommended rail + shield ----------
  run(`setShield(true);`);
  run(`renderRecoResults([
    { c: { hcId: 'h1', title: 'Hot Book', authors: ['A One'], cover: 'https://x.test/h.jpg', ratings: { spice: 5 } }, sim: 0.91 },
    { c: { hcId: 'h2', title: 'Calm Book', authors: ['B Two'], cover: 'https://x.test/c.jpg' }, sim: 0.82 }
  ], [], true, {});`);
  const recoCards = qa('#disc-reco .rail-card');
  ok('recommended rail: ranked list renders as rail cards',
    recoCards.length === 2 && !!q('#disc-reco .rail.reco-rail'));
  ok('recommended rail: card carries cover, title, author, one why line',
    recoCards[1].querySelector('.rail-title').textContent === 'Calm Book' &&
    recoCards[1].querySelector('.rail-author').textContent === 'B Two' &&
    /82% match/.test(recoCards[1].querySelector('.rail-why').textContent));
  ok('shield: high-spice rail cover is blurred for a shielded viewer',
    recoCards[0].querySelector('.reco-cover').classList.contains('shield-blur') &&
    /Shielded/.test(recoCards[0].querySelector('.rail-why').textContent));
  ok('shield: unknown-spice rail cover stays visible (unknown rule)',
    !recoCards[1].querySelector('.reco-cover').classList.contains('shield-blur'));
  ok('recommended rail: ＋TBR and dismiss hooks intact',
    !!recoCards[0].querySelector('[data-add]') && !!recoCards[0].querySelector('[data-dis]'));
  run(`setShield(false);`);

  // ---------- Hearth rail ----------
  run(`window.__hearthClick = null;
    openCovenRecoPreview = (r, i) => { window.__hearthClick = { title: r.book.title, i }; };
    loadRecos = async () => ([
      { book: { id: 'hb1', title: 'Friend Pick', authors: ['Pal Author'], cover: 'https://x.test/f.jpg', coverColor: '' },
        ratings: [{ friendId: 'f1', name: 'Alyssa', rating: 5 }], count: 1, avg: 5 }
    ]);
    refreshDiscoverHearth();`);
  await tick();
  const hearthCards = qa('#disc-hearth .hearth-card');
  ok('hearth rail: friend picks render as a cover rail',
    hearthCards.length === 1 && !!q('#disc-hearth .rail.hearth-rail'));
  ok('hearth rail: who loved it is a text line, not a cover badge',
    /Loved by Alyssa/.test(hearthCards[0].textContent));
  ok('critique cut: no friend-initial badge elements on Hearth covers',
    qa('#disc-hearth .av').length === 0 && !hearthCards[0].querySelector('[class*="badge-av"]'));
  hearthCards[0].click();
  ok('hearth rail: tap opens the coven reco preview at the recoCache index',
    run('window.__hearthClick && window.__hearthClick.title') === 'Friend Pick' &&
    run('window.__hearthClick.i') === 0);

  // ---------- releases rail shape (Discover) vs grid (elsewhere) ----------
  const relList = [{ hcId: 7, title: 'Soon Book', authors: ['Ann Author'], releaseDate: '2027-01-05', cover: '', description: '', isbns: [] }];
  run(`view = 'discover';`);
  ok('releases: Discover renders the rail shape',
    run(`releaseListHTML(${JSON.stringify(relList)})`).indexOf('rail rel-rail') !== -1);
  ok('releases rail: date tag rides the cover',
    run(`releaseRailHTML(${JSON.stringify(relList)})`).indexOf('JAN 5') !== -1);
  run(`view = 'wishlist';`);
  ok('releases: the Wishlist keeps the grid shape',
    run(`releaseListHTML(${JSON.stringify(relList)})`).indexOf('wish-section') !== -1);
  run(`view = 'discover';`);

  console.log(`\ndiscover-remake: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
