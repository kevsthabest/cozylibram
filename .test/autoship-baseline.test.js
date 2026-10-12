// Auto-ship baseline 2026-10-12: regression tests for the 5 auto-ship fixes.
// uid() counter, hashStr/milestoneIdHash split, covenCleanCopy migrateBook,
// bookGenres() in milestone detectors, renderCoven() in remove-friend sheet.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in autoship tests'); };

require('./harness').loadApp(window);
const run = (code) => window.eval(code);

/* 1. uid() uniqueness in a tight loop (050-helpers.js:9) */
{
  ok('uid: 2000 tight-loop ids are all unique',
    run(`(() => { const ids = Array.from({length: 2000}, () => uid()); return new Set(ids).size === 2000; })()`));
  ok('uid: ids are strings starting with b',
    run(`(() => { const ids = Array.from({length: 200}, () => uid()); return ids.every(id => typeof id === 'string' && id[0] === 'b'); })()`));
}

/* 2. hashStr split: favorites keeps the canonical number hash (050 vs 219) */
{
  ok('hashStr (favorites) returns a number', run(`typeof hashStr('The Name of the Wind')`) === 'number');
  ok('milestoneIdHash returns a base36 string', run(`typeof milestoneIdHash('The Name of the Wind')`) === 'string');
  ok('favorites spine math no longer NaN', run(`(() => { const c = ['a','b','c']; return c[hashStr('x') % c.length] !== undefined; })()`));
}

/* 3. covenCleanCopy returns the full migrated shape (196-recos.js) */
{
  ok('covenCleanCopy: tropes is an array (modal join safe)',
    run(`Array.isArray(covenCleanCopy({ title: 'T' }).tropes)`));
  ok('covenCleanCopy: search join does not throw',
    run(`(() => { try { covenCleanCopy({ title: 'T' }).tropes.join(' '); return true; } catch (e) { return false; } })()`));
  ok('covenCleanCopy: copies categories',
    run(`JSON.stringify(covenCleanCopy({ title: 'T', categories: ['Dark Romance'] }).categories)`) === '["Dark Romance"]');
  ok('covenCleanCopy: series object preserved',
    run(`(() => { const b = covenCleanCopy({ title: 'T', series: { name: 'S', position: 2 } }); return b.series && b.series.name === 'S' && b.series.position === 2; })()`));
  ok('covenCleanCopy: stray series string becomes null',
    run(`covenCleanCopy({ title: 'T', series: 'Saga' }).series === null`));
  ok('covenCleanCopy: has ratings/log/owned defaults',
    run(`(() => { const b = covenCleanCopy({ title: 'T' }); return !!b.ratings && Array.isArray(b.log) && typeof b.owned === 'string'; })()`));
}

/* 4. milestone detectors read categories via bookGenres() (219-milestones.js) */
{
  const mk = (i, cats) => ({ id: 'b' + i, title: 'Book ' + i, status: 'read', dateFinished: '2024-0' + (i + 1) + '-15T00:00:00Z', authors: [], categories: cats, tropes: [] });
  const lib5 = [mk(0, ['Fantasy']), mk(1, ['Mystery']), mk(2, ['Romance']), mk(3, ['Horror']), mk(4, ['Science Fiction'])];
  run(`library = ${JSON.stringify(lib5)}`);
  const ids5 = run(`detectMilestones(library).map(d => d.id)`);
  ok('genres-5 earned from categories (not b.genres)', ids5.includes('genres-5'));
  ok('wander-genre-* family alive', ids5.some(id => id.indexOf('wander-genre-') === 0));
  const libDR = Array.from({ length: 10 }, (_, i) => mk(i, ['Dark Romance']));
  run(`library = ${JSON.stringify(libDR)}`);
  const idsDR = run(`detectMilestones(library).map(d => d.id)`);
  ok('taste-dark-romance-10 earned from categories', idsDR.includes('taste-dark-romance-10'));
}

/* 5. remove-friend sheet calls the global renderCoven (195-coven.js:722) */
{
  ok('openRemoveFriendSheet calls renderCoven() directly',
    run(`openRemoveFriendSheet.toString().indexOf('renderCoven()') !== -1`));
  ok('openRemoveFriendSheet no longer references bare rerender()',
    run(`!/\brerender\(\)/.test(openRemoveFriendSheet.toString())`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
