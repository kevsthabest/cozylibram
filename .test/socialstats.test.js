// Social stats (v100): soulmate scores, superlatives, circle digest, buddy reads.
// v474: leaderboard retired (no ranks, no sorted-by-output); pace-based
// superlatives retired. Pure-function tests — no cloud needed.
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

// statPersonBooks aggregates — book 2's dates stay relative so the "this
// month" and "5 days" assertions hold no matter when the suite runs (the old
// hardcoded 2026-09 dates broke the month count on Oct 1).
const fin2 = new Date(); fin2.setHours(12, 0, 0, 0);
const start2 = new Date(fin2); start2.setDate(start2.getDate() - 5);
const agg = window.statPersonBooks([
  bk(Object.assign({ status: 'read', myRating: 5, dateFinished: new Date().toISOString(), pages: 400 }, G('Fiction / Romance'))),
  bk(Object.assign({ status: 'read', myRating: 4, dateStarted: start2.toISOString(), dateFinished: fin2.toISOString(), pages: 300 }, G('Fiction / Fantasy'))),
  bk({ status: 'tbr', title: 'Buddy', authors: ['Zed'], isbn: '111' }),
  bk({ status: 'dnf', title: 'Nope' }),
  bk(Object.assign({ status: 'read', ratings: { spice: 4 } }, G('Fiction / Romance'))),
]);
ok('finished count', agg.finished === 3);
ok('month books counted', agg.monthBooks === 2 && agg.monthPages === 700);
ok('avg days per book', Math.abs(agg.avgDays - 5) < 0.01 && agg.avgDaysN === 1);
ok('dnf counted', agg.dnf === 1);
ok('tbr tracked', agg.tbrKeys.size === 1 && agg.tbrBooks.length === 1);
ok('genre counts', agg.genreCounts['romance'] === 2 && agg.genreCounts['fantasy'] === 1);
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
ok('shared genres surfaced', smTwin.genres.indexOf('romance') !== -1);
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
  awards: [{ label: 'Fearless Quitter', person: pFr, detail: '2 books abandoned, zero regrets' }],
  soulmates: [{ p: pFr, sm: window.soulmateScore(pMe.stats, pFr.stats) }],
  buddies: [{ p: pFr, books: window.buddyReads(pMe.stats, pFr.stats) }],
  nowReading: [{ p: pFr, book: pFr.stats.reading[0] }],
  trending: ['Romance', 'Fantasy'],
};
const out = window.covenStatsHTML(d);
ok('soulmates block renders', out.indexOf('Book soulmates') !== -1 && out.indexOf('%') !== -1);
ok('circle digest renders', out.indexOf('This month') !== -1);
ok('superlatives hidden with 2 people', out.indexOf('Fearless Quitter') === -1);
const d3 = Object.assign({}, d, { people: [pMe, pFr, mkPerson('f2', 'Bob')] });
const out3 = window.covenStatsHTML(d3);
ok('superlatives render with 3+ people', out3.indexOf('Fearless Quitter') !== -1);
ok('Fearless Quitter rename', window.covenStatsHTML(Object.assign({}, d3, {
  awards: [{ label: 'Fearless Quitter', person: pFr, detail: '2 books' }]
})).indexOf('Fearless Quitter') !== -1);
ok('buddy reads render', out.indexOf('Buddy reads') !== -1 && out.indexOf('Dragon Heist') !== -1);
ok('now reading renders', out.indexOf('Ann Book') !== -1);
ok('trending renders', out.indexOf('Trending:') !== -1);
ok('tabbed layout renders', out.indexOf('coven-tabs') !== -1);

// v474: digest has no rank numbers and follows circle order, not output.
// Zara finished 3 books this month vs your 1 — the old leaderboard would
// have ranked her first.
const pA = mkPerson('me', 'You', [bk({ status: 'read', dateFinished: new Date().toISOString(), pages: 200 })]);
const pB = mkPerson('f1', 'Zara', [
  bk({ status: 'read', dateFinished: new Date().toISOString(), pages: 400 }),
  bk({ status: 'read', dateFinished: new Date().toISOString(), pages: 400 }),
  bk({ status: 'read', dateFinished: new Date().toISOString(), pages: 400 }),
]);
const dRank = { people: [pA, pB, mkPerson('f2', 'Moe')], awards: [], soulmates: [], buddies: [], nowReading: [], trending: [] };
const outRank = window.covenStatsHTML(dRank);
ok('digest has no rank numbers', outRank.indexOf('circle-actions') === -1);
const monthCard = outRank.split('This month')[1].split('circle-card')[0];
ok('digest follows circle order, not output', monthCard.indexOf('You') !== -1 && monthCard.indexOf('You') < monthCard.indexOf('Zara'));

// v474: superlative audit — pace-based awards retired, character ones added
const fastReader = mkPerson('me', 'You', [
  bk({ status: 'read', dateStarted: start2.toISOString(), dateFinished: fin2.toISOString(), pages: 300 }),
  bk({ status: 'read', dateStarted: start2.toISOString(), dateFinished: fin2.toISOString(), pages: 300 }),
  bk({ status: 'read', dateStarted: start2.toISOString(), dateFinished: fin2.toISOString(), pages: 300 }),
]);
const slowReader = mkPerson('f1', 'Zed', [bk({ status: 'read', pages: 250 })]);
const auditLabels = window.covenAwards([fastReader, slowReader]).map(a => a.label);
ok('Fastest Finisher retired', auditLabels.indexOf('Fastest Finisher') === -1);
ok('Page Devourer retired', auditLabels.indexOf('Page Devourer') === -1);
const epicReader = mkPerson('f1', 'Ann', [
  bk({ status: 'read', title: 'The Long Epic', pages: 1200 }),
  bk({ status: 'read', title: 'Short Story', pages: 150 }),
]);
const diver = window.covenAwards([mkPerson('me', 'You', [bk({ status: 'read', pages: 300 })]), epicReader])
  .filter(a => a.label === 'Deep Diver')[0];
ok('Deep Diver awarded for longest book',
  !!diver && diver.person.name === 'Ann' && diver.detail.indexOf('The Long Epic') !== -1 && diver.detail.indexOf('1,200') !== -1);
const loyal = mkPerson('f1', 'Bo', [
  bk({ status: 'read', title: 'B1', authors: ['Devoted Author'] }),
  bk({ status: 'read', title: 'B2', authors: ['Devoted Author'] }),
  bk({ status: 'read', title: 'B3', authors: ['Devoted Author'] }),
  bk({ status: 'read', title: 'Other', authors: ['Someone Else'] }),
]);
const devotee = window.covenAwards([mkPerson('me', 'You', [bk({ status: 'read', authors: ['Lone'] })]), loyal])
  .filter(a => a.label === 'Author Devotee')[0];
ok('Author Devotee awarded', !!devotee && devotee.person.name === 'Bo' && devotee.detail === '3 books by Devoted Author');
ok('Author Devotee needs a repeat author',
  window.covenAwards([mkPerson('me', 'You', [bk({ status: 'read', authors: ['Lone'] })])]
    ).filter(a => a.label === 'Author Devotee').length === 0);
const quitter = mkPerson('f1', 'Quinn', [bk({ status: 'dnf' }), bk({ status: 'dnf' })]);
ok('Fearless Quitter kept',
  window.covenAwards([mkPerson('me', 'You', []), quitter]).some(a => a.label === 'Fearless Quitter'));

// v454: genre normaliser tests
ok('normGenre lowercases', window.normGenre('Dark Romance') === 'dark romance');
ok('normGenre trims', window.normGenre('  Fantasy  ') === 'fantasy');
ok('normGenre dedupes case variants', window.normGenre('DARK ROMANCE') === window.normGenre('dark romance'));
const genreBooks = [
  bk({ categories: ['Dark Romance'] }),
  bk({ categories: ['dark romance '] }),
  bk({ categories: ['DARK ROMANCE'] }),
];
const gStats = window.statPersonBooks(genreBooks);
ok('genre counts merged', Object.keys(gStats.genreCounts).length === 1 && gStats.genreCounts['dark romance'] === 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
