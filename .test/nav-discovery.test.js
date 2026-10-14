// Tests for v121 — P0 navigation rework (UI Improvement Pass), restyled v175,
// Discover landing remade v538 (The Stage & The Shelves).
//
// Covered: five-tab bottom nav (Library, Discover, +Add center, Stats, Coven),
// navTab parent mapping for sub-views, Discover landing controls routing to
// real features, inline release check wiring, Library toolbar Wishlist link,
// and the discover_opened analytics event.
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

// --- 1. Bottom nav: seven tabs in the right order (v250 adds Shelf) ---
const tabs = qa('.bottom-nav button').map(b => b.dataset.nav);
ok('nav: seven entries (six primary + desktop-only settings, v171; v250 adds Shelf)', tabs.length === 7);
ok('nav: order is library/discover/add/stats/shelf/coven/settings',
  JSON.stringify(tabs) === JSON.stringify(['library', 'discover', 'add', 'stats', 'shelf', 'coven', 'settings']));
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

// --- 4. Discover landing (v538: The Stage & The Shelves) ---
run("go('discover')");
const viewHTML = q('#view').innerHTML;
ok('discover: no mood question (v538 — the tab makes no mood promise)',
  viewHTML.indexOf('What are you in the mood for?') === -1);
ok('discover: stage present — centred cover slot, headline, Surprise Me',
  !!q('.disc-stage') && viewHTML.indexOf('Let the shelf decide.') !== -1 && !!q('[data-dtile="pick"]'));
const tiles = qa('#view [data-dtile]').map(c => c.dataset.dtile).sort();
ok('discover: only pick + authors carry data-dtile (tiles retired, v538)',
  JSON.stringify(tiles) === JSON.stringify(['authors', 'pick']));
ok('discover: favorites / search / similar / recommended doorways are gone',
  !q('[data-dtile="favorites"]') && !q('[data-dtile="search"]') &&
  !q('[data-dtile="similar"]') && !q('[data-dtile="recommended"]'));
ok('discover: releases are inline — results box + Check now, no doorway tile',
  !!q('#release-results') && !!q('#disc-rel-check') && !q('[data-dtile="releases"]'));
ok('discover: From Your Hearth section with its Open link',
  !!q('#disc-coven-all') && viewHTML.indexOf('From Your') !== -1);
ok('discover: Recommended section renders inline (seed lens slot + reco box)',
  !!q('#disc-seeds') && !!q('#disc-reco'));

// Routing — each control reaches a real feature, never a dead end.
q('#view [data-dtile="pick"]').click(); // Surprise Me
ok('discover: Surprise Me opens roulette', run("view") === 'pick');
run("go('discover')");
q('#view [data-dtile="authors"]').click(); // All authors
ok('discover: All authors opens author discovery', run("view") === 'authors');
run("go('discover')");
q('#disc-browse-tbr').click(); // or browse your TBR
ok('discover: browse-your-TBR opens the library on the TBR filter',
  run("view") === 'library' && run("filter") === 'tbr');
run("go('discover')");
run(`library.push({ id: 'sim1', title: 'Seed Book', authors: ['Ann Author'], status: 'read',
  progress: 100, pageCount: 200, isbn: '', publishedDate: '', cover: '', tropes: [],
  publicRating: null, ratingsCount: 0, genres: [], myRating: 5, ratings: {}, axes: [],
  favorite: true, notes: '', description: '', quotes: [], log: [],
  dateAdded: '2026-01-01T00:00:00.000Z', dateFinished: null });`);
run("go('discover')");
ok('discover: seed lens chips render for a loved book (Similar absorbed, v538)',
  !!q('.seed-chip[data-seed="sim1"]'));
// Seed lens: preset the reco pool, tap the chip, the rail narrows in place.
run(`visibleRecos = [
  { c: { hcId: 's1', title: 'Same Author Book', authors: ['Ann Author'], tropes: [] }, sim: 0.5 },
  { c: { hcId: 's2', title: 'Unrelated Book', authors: ['Someone Else'], tropes: [] }, sim: 0.5 }
];`);
q('.seed-chip[data-seed="sim1"]').click();
ok('discover: seed lens narrows the Recommended rail in place',
  qa('#disc-reco .rail-card').length === 1 &&
  q('#disc-reco .rail-card .rail-title').textContent === 'Same Author Book' &&
  q('.seed-chip[data-seed="sim1"]').classList.contains('on'));
q('.seed-chip[data-seed="sim1"]').click();
ok('discover: tapping the active chip clears the lens',
  !q('.seed-chip[data-seed="sim1"]').classList.contains('on'));
run(`go('discover');`);
q('#disc-coven-all').click(); // Hearth Open
ok('discover: Hearth Open navigates to the coven tab', run("view") === 'coven');

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
