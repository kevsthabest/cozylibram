// Social stats (v100): soulmate scores, superlatives, leaderboards, buddy reads.
// Pure-function tests — no cloud needed.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in socialstats tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const probe = (js) => window.eval(js);

// Build a book with the fields the stats engine reads.
function bk(o) {
  return Object.assign({
    title: 'T', authors: ['A'], isbn: '', status: 'read', myRating: 0,
    categories: [], pages: 300, log: [], ratings: {},
    dateStarted: null, dateFinished: null,
  }, o);
}
const G = (...cats) => ({ categories: cats });

// statStreak: consecutive reading days ending today/yesterday
const today = new Date();
const dk = d => window.statDayKey(d);
const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return dk(d); };
ok('streak of 3 from logs', window.statStreak([bk({ log: [{ d: daysAgo(0), from: 1, to: 20 }, { d: daysAgo(1), from: 1, to: 20 }, { d: daysAgo(2), from: 1, to: 20 }] })]) === 3);
ok('streak alive if yesterday logged', window.statStreak([bk({ log: [{ d: daysAgo(1), from: 1, to: 20 }] })]) === 1);
ok('gap breaks streak', window.statStreak([bk({ log: [{ d: daysAgo(0), from: 1, to: 20 }, { d: daysAgo(2), from: 1, to: 20 }] })]) === 1);
ok('dateFinished counts as a reading day', window.statStreak([bk({ dateFinished: new Date().toISOString() })]) >= 1);
ok('empty books, empty streak', window.statStreak([]) === 0);

// statPersonBooks aggregates
const agg = window.statPersonBooks([
  bk(Object.assign({ status: 'read', myRating: 5, dateFinished: new Date().toISOString(), pages: 400 }, G('Fiction / Romance'))),
  bk(Object.assign({ status: 'read', myRating: 4, dateStarted: '2026-09-01', dateFinished: '2026-09-06', pages: 300 }, G('Fiction / Fantasy'))),
  bk({ status: 'tbr', title: 'Buddy', authors: ['Zed'], isbn: '111' }),
  bk({ status: 'dnf', title: 'Nope' }),
  bk(Object.assign({ status: 'read', ratings: { spice: 4 } }, G('Fiction / Romance'))),
]);
ok('finished count', agg.finished === 3);
ok('month books counted', agg.monthBooks === 2 && agg.monthPages === 700);
ok('avg days per book', Math.abs(agg.avgDays - 5) < 0.01 && agg.avgDaysN === 1);
ok('dnf counted', agg.dnf === 1);
ok('tbr tracked', agg.tbrKeys.size === 1 && agg.tbrBooks.length === 1);
ok('genre counts', agg.genreCounts['Romance'] === 2 && agg.genreCounts['Fantasy'] === 1);
ok('spice average', agg.spiceAvg === 4 && agg.spiceN === 1);

// soulmateScore: needs 3+ shared rated books
function ratedBooks(ratings) {
  return ratings.map((r, i) => bk({ title: 'Shared' + i, authors: ['Same'], isbn: '9' + i, status: 'read', myRating: r, categories: ['Fiction / Romance'] }));
}
const myS = window.statPersonBooks(ratedBooks([5, 5, 4, 3]));
const twinS = window.statPersonBooks(ratedBooks([5, 5, 4, 3]));
const foeS = window.statPersonBooks(ratedBooks([1, 1, 2, 1]));
const smTwin = window.soulmateScore(myS, twinS);
const smFoe = window.soulmateScore(myS, foeS);
ok('identical taste scores near 100', smTwin && smTwin.score >= 95);
ok('opposite taste scores lower', smFoe && smFoe.score < smTwin.score);
ok('shared count reported', smTwin.shared === 4);
ok('shared genres surfaced', smTwin.genres.indexOf('Romance') !== -1);
ok('needs 3 shared books', window.soulmateScore(myS, window.statPersonBooks(ratedBooks([5, 5]))) === null);

// buddyReads: shared TBR keys
const me = window.statPersonBooks([bk({ status: 'tbr', title: 'Dragon Heist', authors: ['Zed'], isbn: '222' }), bk({ status: 'tbr', title: 'Only Mine', isbn: '333' })]);
const fr = window.statPersonBooks([bk({ status: 'tbr', title: 'Dragon Heist', authors: ['Zed'], isbn: '222' }), bk({ status: 'tbr', title: 'Only Theirs', isbn: '444' })]);
const buddies = window.buddyReads(me, fr);
ok('buddy read found', buddies.length === 1 && buddies[0].title === 'Dragon Heist');

// covenStatsHTML: empty states
ok('no friends -> empty section', window.covenStatsHTML({ people: [{ id: 'me' }] }) === '');
ok('null -> empty section', window.covenStatsHTML(null) === '');

// covenStatsHTML: full render with crafted people
const mkPerson = (id, name, books) => ({ id: id, name: name, profile: null, stats: window.statPersonBooks(books) });
const pMe = mkPerson('me', 'You', ratedBooks([5, 5, 4, 3]).concat([bk({ status: 'reading', title: 'Current Thing' })]));
const pFr = mkPerson('f1', 'Ann', ratedBooks([5, 4, 4, 3]).concat([
  bk(Object.assign({ status: 'read', dateFinished: new Date().toISOString(), pages: 350, dateStarted: '2026-09-20' }, G('Fiction / Fantasy'))),
  bk({ status: 'tbr', title: 'Dragon Heist', authors: ['Zed'], isbn: '222' }),
  bk({ status: 'reading', title: 'Ann Book' }),
]));
// give me the same TBR for a buddy read
pMe.stats = window.statPersonBooks(pMe.stats.books.concat([bk({ status: 'tbr', title: 'Dragon Heist', authors: ['Zed'], isbn: '222' })]));
const d = {
  people: [pMe, pFr],
  board: [{ p: pFr, books: 1, pages: 350 }, { p: pMe, books: 0, pages: 0 }],
  awards: [{ label: 'Fastest Finisher', person: pFr, detail: 'avg 7.0 days a book' }],
  soulmates: [{ p: pFr, sm: window.soulmateScore(pMe.stats, pFr.stats) }],
  buddies: [{ p: pFr, books: window.buddyReads(pMe.stats, pFr.stats) }],
  nowReading: [{ p: pFr, book: pFr.stats.reading[0] }],
  trending: ['Romance', 'Fantasy'],
};
const out = window.covenStatsHTML(d);
ok('soulmates block renders', out.indexOf('Book soulmates') !== -1 && out.indexOf('%') !== -1);
ok('leaderboard renders', out.indexOf('This month') !== -1);
ok('superlatives render', out.indexOf('Fastest Finisher') !== -1);
ok('buddy reads render', out.indexOf('Buddy reads') !== -1 && out.indexOf('Dragon Heist') !== -1);
ok('now reading renders', out.indexOf('Ann Book') !== -1);
ok('trending renders', out.indexOf('Trending:') !== -1);
ok('theme name in headings', out.indexOf('stats</h2>') !== -1);

// covenName integration: Night Court theme flows into the stats heading
window.localStorage.setItem('theme', 'twilight');
ok('stats heading uses theme name', window.covenStatsHTML(d).indexOf('Night Court stats') !== -1);
window.localStorage.setItem('theme', 'dark');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
