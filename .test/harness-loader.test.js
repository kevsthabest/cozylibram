/* Harness module loader (migration plan §9.4) — the successor pass's
   first PR. Pins the loader contract the cluster PRs will rely on:
   - a file with first-party static imports loads with its dependencies
     first (the fixtures are named so directory order alone would load
     the dependency LAST — only dependency order makes them pass);
   - imported names bind the dependency's real exports: a value, a
     function, and an accessor-published name (ADR-003) that stays LIVE —
     a post-load mutation through the accessor, from either side, is
     visible to the importer; aliases and namespace imports forward live
     the same way, never as load-time snapshots;
   - the tripwire's strictness moved rather than vanished: bare,
     absolute-path, and URL specifiers throw; an unresolvable specifier
     throws; a specifier escaping the load root throws; importing a name
     the dependency does not export throws; an import cycle throws,
     naming the cycle; re-exports and default bindings throw; and
     classicize() still refuses an import outright for direct callers.
   Fixtures live in .test/fixtures/loader/ (never production js/);
   negative fixtures are generated into a temp dir at run time.
   Run: node .test/harness-loader.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const harness = require('./harness');

const FIX = path.join(__dirname, 'fixtures', 'loader');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
function throws(name, fn, re) {
  try { fn(); } catch (e) {
    if (re.test(e.message)) { ok(name, true); return; }
    console.log('  threw, but the message was: ' + e.message);
    ok(name, false); return;
  }
  console.log('  did not throw');
  ok(name, false);
}
function freshWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  return dom.window;
}

/* ---- Positive: plain named imports, dependencies first ---- */
{
  const w = freshWindow();
  harness.loadJsFile(w, path.join(FIX, 'aa-loader-importer.js'), FIX);
  ok('dependency loaded first (its bridge ran though only the importer was named)',
    typeof w.fixtureGreet === 'function');
  ok('value export binds the dependency\'s real value', w.readFixtureValue() === 'loader-dep-value');
  ok('function export binds the dependency\'s real function', w.readFixtureGreet() === 'hello, loader');
  ok('accessor export reads its initial value', w.readFixtureLive() === 'initial');
  w.fixtureLive = 'set-through-accessor';
  ok('post-load mutation through the accessor is visible to the importer',
    w.readFixtureLive() === 'set-through-accessor');
  w.fixtureSetLive('set-by-dependency');
  ok('dependency-side mutation is visible to the importer (and back through the accessor)',
    w.readFixtureLive() === 'set-by-dependency' && w.fixtureLive === 'set-by-dependency');
  harness.loadJsFile(w, path.join(FIX, 'aa-loader-importer.js'), FIX);
  ok('loading the same file twice in one window is a no-op', w.readFixtureLive() === 'set-by-dependency');
}

/* ---- Positive: side-effect import ---- */
{
  const w = freshWindow();
  harness.loadJsFile(w, path.join(FIX, 'ac-loader-importer-side-effect.js'), FIX);
  ok('side-effect import loads the dependency (bridge surface present)',
    w.readSideEffectValue() === 'loader-dep-value');
}

/* ---- Positive: aliased and namespace imports bind live ---- */
{
  const w = freshWindow();
  harness.loadJsFile(w, path.join(FIX, 'ab-loader-importer-alias.js'), FIX);
  ok('aliased import binds the real value', w.readAliasedValue() === 'loader-dep-value');
  ok('namespace import exposes the exports', w.readNsValue() === 'loader-dep-value');
  ok('namespace object is frozen (a view, not a bag)', Object.isFrozen(w.fixtureDepNs()));
  w.fixtureLive = 'alias-sees-this';
  ok('aliased accessor read forwards live', w.readAliasedLive() === 'alias-sees-this');
  ok('namespace accessor read forwards live', w.readNsLive() === 'alias-sees-this');
  w.writeAliasedLive('written-through-alias');
  ok('writing through the alias reaches the dependency\'s binding',
    w.fixtureLive === 'written-through-alias' && w.readAliasedLive() === 'written-through-alias');
}

/* ---- Negatives: each forbidden shape throws, naming the problem ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-loader-neg-'));
function negFile(rel, text) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
negFile('dep-ok.js', 'export const yes = 1;\nwindow.yes = yes;\n');
negFile('outside.js', 'export const outside = 1;\n');
const neg = (rel) => () => harness.loadJsFile(freshWindow(), path.join(tmp, rel), tmp);

throws('bare specifier throws',
  negFile('imp-bare.js', "import { x } from 'some-package';\n") && neg('imp-bare.js'),
  /bare specifier/);
throws('absolute-path specifier throws',
  negFile('imp-absolute.js', "import { x } from '/abs/path.js';\n") && neg('imp-absolute.js'),
  /absolute-path specifier/);
throws('URL specifier throws',
  negFile('imp-url.js', "import { x } from 'https://example.invalid/x.js';\n") && neg('imp-url.js'),
  /URL specifier/);
throws('unresolvable specifier throws',
  negFile('imp-missing.js', "import { x } from './ghost.js';\n") && neg('imp-missing.js'),
  /cannot resolve/);
throws('specifier escaping the load root throws', () => {
  negFile('root/imp-escape.js', "import { outside } from '../outside.js';\n");
  harness.loadJsFile(freshWindow(), path.join(tmp, 'root', 'imp-escape.js'), path.join(tmp, 'root'));
}, /resolves outside the load root/);
throws('importing a name the dependency does not export throws',
  negFile('imp-missing-export.js', "import { nope } from './dep-ok.js';\n") && neg('imp-missing-export.js'),
  /does not export that name/);
throws('default import throws (named exports only)',
  negFile('imp-default.js', "import depOk from './dep-ok.js';\n") && neg('imp-default.js'),
  /named exports only/);
throws('re-export throws',
  negFile('imp-reexport.js', "export { yes } from './dep-ok.js';\n") && neg('imp-reexport.js'),
  /re-export/);
throws('export default throws',
  negFile('bad-default.js', 'export default 42;\n') && neg('bad-default.js'),
  /export default/);
throws('import cycle throws, naming the cycle', () => {
  negFile('cyc-a.js', "import { b } from './cyc-b.js';\nexport const a = 1;\n");
  negFile('cyc-b.js', "import { a } from './cyc-a.js';\nexport const b = 2;\n");
  harness.loadJsFile(freshWindow(), path.join(tmp, 'cyc-a.js'), tmp);
}, /import cycle detected: cyc-a\.js -> cyc-b\.js -> cyc-a\.js/);

/* ---- classicize keeps its tripwire for direct callers ---- */
throws('classicize still throws on a static import',
  () => harness.classicize("import { x } from './y.js';\n", 'wired.js'),
  /classicize: wired\.js carries a static import/);
ok('classicize still strips a plain converted file identically',
  harness.classicize('export const a = 1;\n', 'plain.js') === 'const a = 1;\n');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
