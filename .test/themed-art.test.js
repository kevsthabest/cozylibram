// Tests for v183/v184 — bespoke per-theme modal artwork.
//
// Covered: the art files exist on disk (Asset/floral-right.svg for
// midnight + vine/divider/moon for the other nine themes); styles.css maps
// each theme's .modal::after to its vine; sw.js precaches the art and the
// cache name matches APP_VERSION.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

// v228: all ten themes have bespoke art (midnight got its own moon/divider/vine)
const THEMES = ['twilight', 'verdant', 'velvet', 'abyss', 'frost', 'midnight', 'dark', 'light', 'hearthside', 'candlelight'];
const KINDS = ['vine', 'divider', 'moon'];

// 1. art files exist on disk
for (const t of THEMES) {
  for (const k of KINDS) {
    const p = path.join(ROOT, 'Asset', 'themes', `${k}-${t}.svg`);
    ok(`Asset/themes/${k}-${t}.svg exists`, fs.existsSync(p));
    if (fs.existsSync(p)) {
      const src = fs.readFileSync(p, 'utf8');
      ok(`${k}-${t}.svg is an SVG`, src.includes('<svg') && src.includes('</svg>'));
    }
  }
}

// 2. v418: the full-height .modal::after vine strip is retired (it got
// sliced by section backgrounds). The flair system replaces it: five
// divider-proof placements, theme-matched via js/151-modal-flairs.js.
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
ok('styles.css: retired .modal::after vine strip (no per-theme vine rules)',
  !css.includes('.modal::after') || !/\.modal::after[^}]*vine-/.test(css));
for (const sel of ['.mflair-vine', '.mflair-corners', '.mflair-divider', '.mflair-garland', '.mflair-watermark']) {
  ok(`styles.css: flair placement ${sel}`, css.includes(sel));
}
ok('styles.css: flairs tint via --floral-tint', css.includes('color: var(--floral-tint)'));

// 3. sw.js precaches the art and matches the app version
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
ok('sw.js precaches THEME_ART', sw.includes('THEME_ART'));
ok('sw.js precaches Asset/floral-right.svg', sw.includes('./Asset/floral-right.svg'));
const appversion = fs.readFileSync(path.join(ROOT, 'js', '181-appversion.js'), 'utf8');
const m = appversion.match(/APP_VERSION = '(v\d+)'/);
ok('APP_VERSION parsed', !!m);
if (m) ok(`sw.js cache name matches APP_VERSION (${m[1]})`, sw.includes(`cozy-libram-${m[1]}`));
// the version number itself is asserted by .test/appversion.test.js; here we
// only require the two to agree, so the art can't go stale behind a worker.

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
