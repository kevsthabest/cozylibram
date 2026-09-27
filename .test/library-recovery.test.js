// Tests for v136 — library recovery.
//
// Covered:
//  1. Signing out hands the library back to the shared offline slot instead
//     of stranding it in the per-user slot (the "lost library" bug).
//  2. Signing back in still finds the books in the per-user slot.
//  3. libraryPartitions() lists every on-device partition with book counts.
//  4. restorePartition() restores a partition's books into the open library.

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

// --- 1. The lost-library bug: sign out must not strand the library ---
window.localStorage.clear();
run('library = ' + JSON.stringify(books(3)) + '; saveLibrary({noCloud:true});');
run("setLocalUser('user-1')"); // sign in: offline books adopted into per-user slot
ok('sign-in: books move to per-user slot',
  run('library.length') === 3 && ls('spicyshelves.library.v2.user-1') !== null);
ok('sign-in: offline slot cleared after adoption', ls('spicyshelves.library.v1') === null);

run('setLocalUser(null)'); // sign out — this used to show an empty library
ok('sign-out: library still has the books', run('library.length') === 3);
ok('sign-out: offline slot restored with books',
  (() => { try { return JSON.parse(ls('spicyshelves.library.v1')).length === 3; } catch (e) { return false; } })());
ok('sign-out: per-user slot keeps its copy',
  (() => { try { return JSON.parse(ls('spicyshelves.library.v2.user-1')).length === 3; } catch (e) { return false; } })());

// --- 2. Signing back in finds the books again ---
run('setLocalUser("user-1")');
ok('sign-in again: books are back', run('library.length') === 3);

// --- 3. libraryPartitions lists every partition ---
const parts = run('JSON.stringify(libraryPartitions())');
const parsed = JSON.parse(parts);
ok('partitions: both slots listed', parsed.length === 2);
ok('partitions: counts correct', parsed.every(p => p.n === 3));
ok('partitions: current slot flagged once', parsed.filter(p => p.current).length === 1);
ok('partitionLabel: offline slot labelled', run("partitionLabel({key:'spicyshelves.library.v1'})") === 'Offline shelf (signed out)');
ok('partitionLabel: other sign-in labelled', run("partitionLabel({key:'spicyshelves.library.v2.someone-else'})") === 'Another sign-in on this device');

// --- 4. restorePartition restores a stranded partition ---
run('setLocalUser(null)'); // back to offline; simulate the OLD bug state:
window.localStorage.setItem('spicyshelves.library.v1', '[]'); // offline slot wiped
run('library = []; bookSnapshots.clear();');
ok('setup: library looks empty', run('library.length') === 0);
const restored = run("restorePartition('spicyshelves.library.v2.user-1')");
ok('restorePartition: returns book count', restored === 3);
ok('restorePartition: library has the books', run('library.length') === 3);
ok('restorePartition: books migrated', run("library.every(b => b.id && b.title)") === true);
ok('restorePartition: persisted to current slot',
  (() => { try { return JSON.parse(ls('spicyshelves.library.v1')).length === 3; } catch (e) { return false; } })());
ok('restorePartition: bad key returns 0', run("restorePartition('spicyshelves.library.v2.nope')") === 0);

// --- 5. Sign-out with an empty library is a no-op ---
window.localStorage.clear();
run('library = []; bookSnapshots.clear(); setLocalUser("user-2");');
run('setLocalUser(null)');
ok('sign-out empty: nothing invented', ls('spicyshelves.library.v1') === '[]');

// --- 6. A different user signing in does NOT adopt another user's hand-back ---
window.localStorage.clear();
run('library = ' + JSON.stringify(books(2)) + '; saveLibrary({noCloud:true});');
run("setLocalUser('user-A');"); // genuine offline library adopted by user-A
run('setLocalUser(null);');     // sign out → hand-back, marked as user-A's
ok('hand-back: offline shelf marked with owner',
  ls('spicyshelves.offline.owner') === 'user-A');
run("setLocalUser('user-B');"); // a different user signs in on the same device
ok('other user: starts with an empty shelf', run('library.length') === 0);
ok('other user: hand-back not absorbed into their slot',
  (() => { try { return (JSON.parse(ls('spicyshelves.library.v2.user-B')) || []).length === 0; } catch (e) { return false; } })());
ok('other user: first user shelf untouched',
  (() => { try { return JSON.parse(ls('spicyshelves.library.v2.user-A')).length === 2; } catch (e) { return false; } })());
run("setLocalUser('user-A');"); // original user returns
ok('original user: books are back', run('library.length') === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
