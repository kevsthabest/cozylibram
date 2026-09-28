// Tests for v183 — bespoke per-theme modal artwork.
//
// Covered: the 16 art files exist on disk (Asset/floral-right.svg for
// midnight + vine/divider/moon for twilight, verdant, velvet, abyss,
// frost); styles.css maps each art theme's .modal::after to its vine;
// sw.js precaches the art and the cache name matches APP_VERSION.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const THEMES = ['twilight', 'verdant', 'velvet', 'abyss', 'frost'];
const KINDS = ['vine', 'divider', 'moon'];

// 1. art files exist on disk
ok('Asset/floral-right.svg exists (midnight vine)', fs.existsSync(path.join(ROOT, 'Asset', 'floral-right.svg')));
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

// 2. styles.css maps each art theme to its vine
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
for (const t of THEMES) {
  ok(`styles.css: [data-theme="${t}"] .modal::after -> vine-${t}.svg`,
    css.includes(`[data-theme="${t}"] .modal::after`) && css.includes(`Asset/themes/vine-${t}.svg`));
}
ok('styles.css: [data-theme="midnight"] .modal::after -> Asset/floral-right.svg',
  css.includes('[data-theme="midnight"] .modal::after') && css.includes('Asset/floral-right.svg'));

// the bespoke rules must clear the v170 mask silhouette, or the art would be masked away
ok('styles.css: bespoke vine rules clear mask-image',
  /\[data-theme="twilight"\][\s\S]{0,400}?mask-image:\s*none/.test(css));

// themes without bespoke art keep the tinted silhouette (no override)
for (const t of ['dark', 'light', 'hearthside', 'candlelight']) {
  ok(`styles.css: no bespoke vine override for ${t}`, !css.includes(`[data-theme="${t}"] .modal::after`));
}

// 3. sw.js precaches the art and matches the app version
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
ok('sw.js precaches THEME_ART', sw.includes('THEME_ART'));
ok('sw.js precaches Asset/floral-right.svg', sw.includes('./Asset/floral-right.svg'));
const appversion = fs.readFileSync(path.join(ROOT, 'js', '181-appversion.js'), 'utf8');
const m = appversion.match(/APP_VERSION = '(v\d+)'/);
ok('APP_VERSION parsed', !!m);
if (m) ok(`sw.js cache name matches APP_VERSION (${m[1]})`, sw.includes(`cozy-libram-${m[1]}`));
ok('APP_VERSION is v183', m && m[1] === 'v183');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
