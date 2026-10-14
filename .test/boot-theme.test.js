// Tests for v543 — pre-paint theme boot script in index.html <head>.
//
// Bug: styles.css's :root defaults ARE the Dark theme (violet --accent), and
// data-theme was only set when js/010-theming.js ran at end-of-body, so any
// non-Dark theme (e.g. Haunt, ember) flashed purple on load/refresh before
// flipping to the real theme. The inline boot script in <head> mirrors
// js/010's getTheme()/applyTheme() resolution and sets data-theme /
// data-accent before first paint; js/010 stays authoritative.
//
// Covered: (a) the resolver exists in <head> ahead of the styles.css link;
// (b) its THEME_KEYS list matches THEMES in js/010-theming.js exactly, so a
// future theme can't silently desync the mirror; (c) executing the resolver
// against stubbed storage matches js/010 semantics for: no stored theme,
// stored haunt, stored bogus theme, stored accent, and throwing storage.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const headEnd = html.indexOf('</head>');
const head = html.slice(0, headEnd);
const cssLinkIdx = head.indexOf('<link rel="stylesheet" href="styles.css">');

/* ---------- (a) placement ---------- */
// The boot resolver is the src-less <script> in <head> that sets dataset.theme.
const scriptBlocks = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => ({ body: m[1], idx: m.index }));
const boot = scriptBlocks.find(b => b.body.includes('dataset.theme') && b.body.includes('THEME_KEYS'));
ok('inline boot resolver exists in <head>', !!boot);
ok('boot resolver sits ahead of the styles.css link', !!boot && cssLinkIdx !== -1 && boot.idx < cssLinkIdx);
ok('boot resolver is inside <head> (before </head> and <body>)', !!boot && boot.idx < headEnd && !head.includes('<body'));
ok('boot resolver reads localStorage theme + accent keys',
  !!boot && boot.body.includes("localStorage.getItem('theme')") && boot.body.includes("localStorage.getItem('accent')"));
ok('boot resolver is defensive (wrapped in try/catch)',
  !!boot && /try\s*\{/.test(boot.body) && /catch/.test(boot.body));

/* ---------- (b) key list stays in sync with js/010 THEMES ---------- */
const theming = fs.readFileSync(path.join(ROOT, 'js/010-theming.js'), 'utf8');
const themesBlock = theming.match(/const THEMES = \[([\s\S]*?)\n\];/);
ok('THEMES block parseable in js/010-theming.js', !!themesBlock);
const jsKeys = themesBlock ? [...themesBlock[1].matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]) : [];
ok('THEMES yields at least one key', jsKeys.length > 0);

let bootKeys = [];
if (boot) {
  const arrMatch = boot.body.match(/THEME_KEYS\s*=\s*\[([\s\S]*?)\]/);
  if (arrMatch) bootKeys = [...arrMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}
ok('boot THEME_KEYS parseable from the inline script', bootKeys.length > 0);
ok('boot THEME_KEYS exactly matches js/010 THEMES keys (same set, no extras, none missing)',
  bootKeys.length === jsKeys.length &&
  jsKeys.every(k => bootKeys.includes(k)) &&
  bootKeys.every(k => jsKeys.includes(k)));

/* ---------- (c) resolver behaviour, executed against stubs ---------- */
function runBoot(stored, opts) {
  opts = opts || {};
  const dataset = {};
  const sandbox = {
    localStorage: {
      getItem(k) {
        if (opts.throws) throw new Error('storage unavailable');
        return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null;
      },
    },
    document: { documentElement: { dataset } },
  };
  vm.createContext(sandbox);
  let threw = false;
  try { vm.runInContext(boot.body, sandbox); } catch (e) { threw = true; }
  return { dataset, threw };
}

if (boot) {
  let r = runBoot({});
  ok('no stored theme -> data-theme left unset (== Dark :root, js/010 fallback)', r.dataset.theme === undefined && !r.threw);
  ok('no stored theme/accent -> data-accent left unset', r.dataset.accent === undefined);

  r = runBoot({ theme: 'haunt' });
  ok("stored 'haunt' -> data-theme='haunt' pre-paint (the reported bug)", r.dataset.theme === 'haunt' && !r.threw);
  ok("stored 'haunt', no stored accent -> data-accent unset (theme's designed ember accent wins)",
    r.dataset.accent === undefined);

  r = runBoot({ theme: 'not-a-theme' });
  ok('stored bogus theme -> data-theme left unset (js/010 would fall back to Dark)', r.dataset.theme === undefined && !r.threw);

  r = runBoot({ theme: 'dark' });
  ok("stored 'dark' -> data-theme='dark' (explicit, same rendering as unset)", r.dataset.theme === 'dark');

  r = runBoot({ theme: 'haunt', accent: 'gold' });
  ok("stored accent mirrored raw into data-accent, alongside the theme",
    r.dataset.theme === 'haunt' && r.dataset.accent === 'gold' && !r.threw);

  r = runBoot({ accent: 'rose' });
  ok('stored accent with no stored theme -> data-accent set, data-theme unset',
    r.dataset.accent === 'rose' && r.dataset.theme === undefined);

  r = runBoot({ theme: 'haunt' }, { throws: true });
  ok('throwing localStorage -> resolver swallows it and sets nothing', !r.threw && r.dataset.theme === undefined && r.dataset.accent === undefined);
}

/* ---------- js/010 stays the authoritative applier ---------- */
ok('js/010 applyTheme still sets data-theme from getTheme()',
  /document\.documentElement\.dataset\.theme = t/.test(theming) && /function applyTheme\(\)/.test(theming));
ok('styles.css :root still carries the Dark defaults (boot fixes timing, not the theme system)',
  /:root, \[data-theme="dark"\] \{/.test(fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
