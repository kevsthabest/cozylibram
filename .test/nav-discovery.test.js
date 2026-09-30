// Tests for v121 — P0 navigation rework (UI Improvement Pass), restyled v175.
//
// Covered: five-tab bottom nav (Library, Discover, +Add center, Stats, Coven),
// navTab parent mapping for sub-views, Discover landing cards routing to real
// features, inline release check wiring, Library toolbar Wishlist link, and
// the discover_opened analytics event.
//
// Nothing is removed: every previous top-level destination (wishlist, authors,
// pick) must remain reachable through its new parent tab.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));

// --- 1. Bottom nav: exactly five tabs in the right order ---
const tabs = qa('.bottom-nav button').map(b => b.dataset.nav);
ok('nav: six entries (five primary + desktop-only settings, v171)', tabs.length === 6);
ok('nav: order is library/discover/add/stats/coven/settings',
  JSON.stringify(tabs) === JSON.stringify(['library', 'discover', 'add', 'stats', 'coven', 'settings']));
const addBtn = q('.bottom-nav button.nav-add');
ok('nav: add is the visually distinct center action',
  !!addBtn && addBtn.dataset.nav === 'add' && qa('.bottom-nav button').indexOf(addBtn) === 2);
ok('nav: every tab has an accessible label',
  qa('.bottom-nav button').every(b => (b.getAttribute('aria-label') || '').length > 0));

// --- 2. navTab parent mapping ---
ok('navTab: wishlist highlights library', run("navTab('wishlist')") === 'library');
ok('navTab: upnext highlights library', run("navTab('upnext')") === 'library');
ok('navTab: quotes highlights library', run("navTab('quotes')") === 'library');
ok('navTab: pick highlights discover', run("navTab('pick')") === 'discover');
ok('navTab: authors highlights discover', run("navTab('authors')") === 'discover');
ok('navTab: author highlights discover', run("navTab('author')") === 'discover');
ok('navTab: series follows its return target (library by default)', run("navTab('series')") === 'library');
run("seriesReturn = 'stats'");
ok('navTab: series from stats highlights stats', run("navTab('series')") === 'stats');
run("seriesReturn = 'library'");
ok('navTab: coven-friend highlights coven', run("navTab('coven-friend')") === 'coven');
ok('navTab: settings highlights itself (v171)', run("navTab('settings')") === 'settings');
ok('navTab: unknown view has no tab', run("navTab('nope-not-a-view')") === null);

// --- 3. go() activates the parent tab ---
run("go('wishlist')");
ok('go(wishlist): library tab active',
  q('.bottom-nav button[data-nav="library"]').classList.contains('active') &&
  !q('.bottom-nav button[data-nav="discover"]').classList.contains('active'));
run("go('pick')");
ok('go(pick): discover tab active',
  q('.bottom-nav button[data-nav="discover"]').classList.contains('active'));

// --- 4. Discover landing ---
run("go('discover')");
const viewHTML = q('#view').innerHTML;
ok('discover: asks the mood question',
  viewHTML.indexOf('What are you in the mood for?') !== -1);
const tiles = qa('#view [data-dtile]').map(c => c.dataset.dtile).sort();
ok('discover: mockup tiles present (v175, +recommended v213)',
  JSON.stringify(tiles) === JSON.stringify(['authors', 'favorites', 'pick', 'recommended', 'releases', 'search', 'similar']));
ok('discover: every tile has a plain-language explanation',
  qa('#view [data-dtile]').every(c => (c.querySelector('small') || { textContent: '' }).textContent.trim().length > 3));
ok('discover: New Releases tile + inline results box present',
  !!q('[data-dtile="releases"]') && !!q('#release-results'));
ok('discover: From Your Coven section with deep-link chips',
  !!q('#disc-coven-all') && qa('#view [data-cj]').length === 3);

// Tile routing — each target is a real feature, never a dead end.
q('#view [data-dtile="pick"]').click(); // Surprise Me
ok('discover: Surprise Me opens roulette', run("view") === 'pick');
run("go('discover')");
q('#view [data-dtile="authors"]').click(); // Authors
ok('discover: Authors tile opens author discovery', run("view") === 'authors');
run("go('discover')");
q('#view [data-dtile="search"]').click(); // Search the Library & Beyond
ok('discover: Search opens add in search mode (v172: unified view)',
  run("view") === 'add' && run("addTab") === 'search');
run("go('discover')");
q('#view [data-dtile="favorites"]').click(); // My Favorites
ok('discover: My Favorites opens the library home', run("view") === 'library');
run("go('discover')");
run(`library.push({ id: 'sim1', title: 'Seed Book', authors: ['Ann Author'], status: 'read',
  progress: 100, pageCount: 200, isbn: '', publishedDate: '', cover: '', tropes: [],
  publicRating: null, ratingsCount: 0, genres: [], myRating: 5, ratings: {}, axes: [],
  favorite: true, notes: '', description: '', quotes: [], log: [],
  dateAdded: '2026-01-01T00:00:00.000Z', dateFinished: null });`);
q('#view [data-dtile="similar"]').click(); // Similar Books
ok('discover: Similar Books expands the seed picker',
  q('#disc-sim').hidden === false && !!q('#disc-sim [data-seed]'));
q('#disc-sim [data-seed]').click();
ok('discover: seed opens the book detail sheet', !!q('#m-back'));
q('#m-x').click();
run(`go('discover');`);
q('#view [data-cj="#reco-slot"]').click(); // Coven chip
ok('discover: Coven chip navigates to the coven tab', run("view") === 'coven');

// --- 5. Wishlist stays reachable via Library ---
run("go('library')");
ok('library: toolbar links to wishlist', !!q('#lib-wishlist'));
q('#lib-wishlist').click();
ok('library: wishlist button navigates to wishlist', run("view") === 'wishlist');

// --- 6. Analytics: discover_opened is a declared event ---
ok('analytics: discover_opened is in the allowlist',
  run("typeof EVENT_DEFS !== 'undefined' && !!EVENT_DEFS.discover_opened") === true);

// --- 7. No dead tabs: every data-nav target dispatches in render() ---
const bootSrc = fs.readFileSync(path.join(ROOT, 'js', '200-boot.js'), 'utf8');
ok('nav: every tab target has a render dispatch',
  tabs.every(t => bootSrc.indexOf("view === '" + t + "'") !== -1));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
