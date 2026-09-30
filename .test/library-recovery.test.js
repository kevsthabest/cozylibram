// Tests for v204 — signed-out mode deprecated (was: v136 library recovery).
//
// Covered:
//  1. Signing out no longer hands the library back to the shared offline
//     slot — the books stay in the per-user slot; the gate is the only
//     signed-out UI.
//  2. Signing back in still finds the books in the per-user slot.
//  3. libraryPartitions() lists every on-device partition with book counts.
//  4. restorePartition() restores a partition's books into the open library.
//  5. A different user signing in starts with a clean shelf (no hand-back
//     exists to leak between users).

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
const ls = (k) => window.localStorage.getItem(k);
const books = (n) => Array.from({ length: n }, (_, i) =>
  ({ id: 'b' + i, title: 'Book ' + i, authors: ['A'], status: 'tbr' }));

// --- 1. v204: sign-out keeps the books in the per-user slot; no hand-back ---
window.localStorage.clear();
run('library = ' + JSON.stringify(books(3)) + '; saveLibrary({noCloud:true});');
run("setLocalUser('user-1')"); // sign in: offline books adopted into per-user slot
ok('sign-in: books move to per-user slot',
  run('library.length') === 3 && ls('spicyshelves.library.v2.user-1') !== null);
ok('sign-in: offline slot cleared after adoption', ls('spicyshelves.library.v1') === null);

run('setLocalUser(null)'); // sign out — no hand-back (v204)
ok('sign-out: in-memory library is empty (signed-out mode is gone)', run('library.length') === 0);
ok('sign-out: offline slot stays empty — no hand-back',
  (() => { try { return (JSON.parse(ls('spicyshelves.library.v1')) || []).length === 0; } catch (e) { return ls('spicyshelves.library.v1') === null; } })());
ok('sign-out: no owner marker written', ls('spicyshelves.offline.owner') === null);
ok('sign-out: per-user slot keeps its copy',
  (() => { try { return JSON.parse(ls('spicyshelves.library.v2.user-1')).length === 3; } catch (e) { return false; } })());

// --- 2. Signing back in finds the books again ---
run('setLocalUser("user-1")');
ok('sign-in again: books are back', run('library.length') === 3);

// --- 3. libraryPartitions lists every partition ---
const parts = run('JSON.stringify(libraryPartitions())');
const parsed = JSON.parse(parts);
ok('partitions: per-user slot listed with the books',
  parsed.some(p => p.key === 'spicyshelves.library.v2.user-1' && p.n === 3));
ok('partitions: offline shelf holds no books (no hand-back recreated it)',
  !parsed.some(p => p.key === 'spicyshelves.library.v1' && p.n > 0));
ok('partitions: current slot flagged once', parsed.filter(p => p.current).length === 1);
ok('partitionLabel: offline slot labelled', run("partitionLabel({key:'spicyshelves.library.v1'})") === 'Offline shelf (signed out)');
ok('partitionLabel: other sign-in labelled', run("partitionLabel({key:'spicyshelves.library.v2.someone-else'})") === 'Another sign-in on this device');

// --- 4. restorePartition restores a stranded partition ---
run('setLocalUser(null)'); // signed out; simulate a stranded per-user partition:
run('library = []; bookSnapshots.clear();');
ok('setup: library looks empty', run('library.length') === 0);
const restored = run("restorePartition('spicyshelves.library.v2.user-1')");
ok('restorePartition: returns book count', restored === 3);
ok('restorePartition: library has the books', run('library.length') === 3);
ok('restorePartition: books migrated', run("library.every(b => b.id && b.title)") === true);
ok('restorePartition: bad key returns 0', run("restorePartition('spicyshelves.library.v2.nope')") === 0);

// --- 5. Sign-out with an empty library is a no-op ---
window.localStorage.clear();
run('library = []; bookSnapshots.clear(); setLocalUser("user-2");');
run('setLocalUser(null)');
ok('sign-out empty: nothing invented', ls('spicyshelves.library.v1') === null || ls('spicyshelves.library.v1') === '[]');

// --- 6. A different user signing in starts clean; the first user's shelf is untouched ---
window.localStorage.clear();
run('library = ' + JSON.stringify(books(2)) + '; saveLibrary({noCloud:true});');
run("setLocalUser('user-A');"); // genuine offline library adopted by user-A
run('setLocalUser(null);');     // sign out — no hand-back, no owner marker (v204)
ok('sign-out: no owner marker written', ls('spicyshelves.offline.owner') === null);
run("setLocalUser('user-B');"); // a different user signs in on the same device
ok('other user: starts with an empty shelf', run('library.length') === 0);
ok('other user: first user shelf untouched',
  (() => { try { return JSON.parse(ls('spicyshelves.library.v2.user-A')).length === 2; } catch (e) { return false; } })());
run("setLocalUser('user-A');"); // original user returns
ok('original user: books are back', run('library.length') === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
