'use strict';

/* ---- 216-shelf3d-theme.js: 3D shelf theme mapping (v405) ----
   Maps the 17 app themes (+ 12 accents) to Three.js scene parameters.
   The Autumn cozy preset is the north star: harvest theme carries it.

   Moods drive decoration suggestions:
   - cozy:    warm, inviting (dark, hearthside, amour, harvest)
   - moody:   dramatic, low-key (twilight, verdant, midnight, velvet, abyss)
   - bright:  airy, light (light, candlelight, frost, pastel)
   - spooky:  halloween (haunt)
   - festive: celebratory (yuletide, fete, shamrock) */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const SHELF3D_ACCENTS = {
  rose: '#e5488f', violet: '#8b5cf6', gold: '#c08a24', teal: '#2fa39a',
  crimson: '#d43a55', ember: '#e0722a', ocean: '#3f8fd6', sage: '#8aa864',
  blush: '#f2a3c0', copper: '#c47b4a', mint: '#6fce9e', lilac: '#b9a3f2',
};

// Per-theme 3D params. woodBase/woodDark: shelf timber. lightWarm: key light.
// lightCool: rim/fill. ambientLevel/exposure: lift for dark themes.
// accentGlow: fairy-light/decoration glow. floorTint: floor/vignette.
export const SHELF3D_THEMES = {
  dark:        { woodBase: '#5a3d24', woodDark: '#33220f', lightWarm: '#ffd9a0', lightCool: '#7a6ac0', ambientLevel: 0.8,  exposure: 1.0,  accentGlow: '#e5488f', floorTint: '#14101a', mood: 'cozy' },
  light:       { woodBase: '#c9a06a', woodDark: '#8a6a3f', lightWarm: '#fff2dc', lightCool: '#ffe9c9', ambientLevel: 1.1,  exposure: 1.15, accentGlow: '#e5488f', floorTint: '#faf5ec', mood: 'bright' },
  hearthside:  { woodBase: '#6b4426', woodDark: '#3d2612', lightWarm: '#ffb86a', lightCool: '#8a5a2a', ambientLevel: 0.8,  exposure: 1.05, accentGlow: '#e0722a', floorTint: '#17100a', mood: 'cozy' },
  candlelight: { woodBase: '#cfa96f', woodDark: '#8f6f42', lightWarm: '#ffe8b8', lightCool: '#ffd9a0', ambientLevel: 1.0,  exposure: 1.15, accentGlow: '#c08a24', floorTint: '#f7efdc', mood: 'bright' },
  twilight:    { woodBase: '#4a3448', woodDark: '#2a1c28', lightWarm: '#c9a0ff', lightCool: '#5a4a8a', ambientLevel: 0.9,  exposure: 1.0,  accentGlow: '#8b5cf6', floorTint: '#0e1120', mood: 'moody' },
  verdant:     { woodBase: '#4a5a34', woodDark: '#2a331c', lightWarm: '#ffe0a0', lightCool: '#4a7a4a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#8aa864', floorTint: '#0d140e', mood: 'moody' },
  midnight:    { woodBase: '#3d3d5a', woodDark: '#22222f', lightWarm: '#b8c8ff', lightCool: '#4a4a8a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#3f8fd6', floorTint: '#191a30', mood: 'moody' },
  velvet:      { woodBase: '#5a2f42', woodDark: '#331a26', lightWarm: '#ff9a8a', lightCool: '#6a3a5a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#e5488f', floorTint: '#1c1219', mood: 'moody' },
  abyss:       { woodBase: '#2f3d3d', woodDark: '#1a2222', lightWarm: '#a0d8d8', lightCool: '#2a4a4a', ambientLevel: 0.9,  exposure: 1.0,  accentGlow: '#2fa39a', floorTint: '#0b1416', mood: 'moody' },
  frost:       { woodBase: '#b8c4d4', woodDark: '#7a8698', lightWarm: '#eef4ff', lightCool: '#ffe9c9', ambientLevel: 1.05, exposure: 1.1,  accentGlow: '#3f8fd6', floorTint: '#edf1f6', mood: 'bright' },
  haunt:       { woodBase: '#3d2b21', woodDark: '#1f150e', lightWarm: '#b86aff', lightCool: '#3a5a2a', ambientLevel: 0.8,  exposure: 0.95, accentGlow: '#e0722a', floorTint: '#150e1c', mood: 'spooky' },
  yuletide:    { woodBase: '#4a3a24', woodDark: '#2a2012', lightWarm: '#ff9a6a', lightCool: '#3a6a3a', ambientLevel: 0.85, exposure: 1.05, accentGlow: '#d43a55', floorTint: '#0c1811', mood: 'festive' },
  fete:        { woodBase: '#4a3d5a', woodDark: '#2a2233', lightWarm: '#ffd86a', lightCool: '#6a5aaa', ambientLevel: 0.85, exposure: 1.05, accentGlow: '#c08a24', floorTint: '#0f1330', mood: 'festive' },
  amour:       { woodBase: '#6a3a3a', woodDark: '#3d2020', lightWarm: '#ff9ab8', lightCool: '#8a4a5a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#f2a3c0', floorTint: '#1d0e15', mood: 'cozy' },
  shamrock:    { woodBase: '#3d5a34', woodDark: '#22331c', lightWarm: '#ffd86a', lightCool: '#2a8a4a', ambientLevel: 0.85, exposure: 1.05, accentGlow: '#6fce9e', floorTint: '#0c1e13', mood: 'festive' },
  pastel:      { woodBase: '#d4b8a0', woodDark: '#96745e', lightWarm: '#fff0f5', lightCool: '#ffe0ec', ambientLevel: 1.05, exposure: 1.1,  accentGlow: '#b9a3f2', floorTint: '#f7f2fa', mood: 'bright' },
  harvest:     { woodBase: '#6b4426', woodDark: '#3a2412', lightWarm: '#ffc27a', lightCool: '#b07a3a', ambientLevel: 0.8,  exposure: 1.05, accentGlow: '#c47b4a', floorTint: '#191007', mood: 'cozy' },
  solstice:    { woodBase: '#d4a86a', woodDark: '#96703e', lightWarm: '#fff3d8', lightCool: '#ffe9b8', ambientLevel: 1.15, exposure: 1.2,  accentGlow: '#c08a24', floorTint: '#fdf1d7', mood: 'bright' }, // v416 (T6)
  // v423: premium packs.
  stormrider:  { woodBase: '#3d3a55', woodDark: '#222031', lightWarm: '#ffd9a0', lightCool: '#5a6a9a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#e8a94e', floorTint: '#12141f', mood: 'moody' },
  briarthrone: { woodBase: '#4a2f52', woodDark: '#2a1a30', lightWarm: '#d8c0ff', lightCool: '#5a3a6a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#c9b3f5', floorTint: '#130e1a', mood: 'moody' },
  voidsignal:  { woodBase: '#2a3a44', woodDark: '#162026', lightWarm: '#a0e8ff', lightCool: '#1a3a44', ambientLevel: 0.9,  exposure: 1.0,  accentGlow: '#38e1ff', floorTint: '#0a0f14', mood: 'moody' },
  wisp:        { woodBase: '#c9a06a', woodDark: '#8a6a3f', lightWarm: '#fff2dc', lightCool: '#ffe9c9', ambientLevel: 1.1,  exposure: 1.15, accentGlow: '#e86a92', floorTint: '#fdf6ec', mood: 'bright' },
  'wisp-night':{ woodBase: '#3a2a55', woodDark: '#1e1430', lightWarm: '#ffe9a0', lightCool: '#4a3a7a', ambientLevel: 0.85, exposure: 1.0,  accentGlow: '#ffd76a', floorTint: '#0e0a1a', mood: 'moody' },
};

/* v475: room shells — the walls, floor and trim around the bookcases.
   [wall colour, wall pattern, floor colour, floor kind, trim colour]
   wall patterns: plain | wainscot | panel | stripe | starry | grid
   floor kinds:   boards | tile | stone                                    */
export const SHELF3D_SHELLS = {
  dark:        ['#2e2338', 'wainscot', '#33231b', 'boards', '#1f1527'],
  light:       ['#efe2cc', 'wainscot', '#c9a579', 'boards', '#fbf3e4'],
  hearthside:  ['#4a2c1a', 'panel',    '#2f1c10', 'boards', '#2a190e'],
  candlelight: ['#f0dcb4', 'stripe',   '#b98f58', 'boards', '#fff1d0'],
  twilight:    ['#2d2758', 'starry',   '#1f1938', 'boards', '#171230'],
  verdant:     ['#2f4d34', 'stripe',   '#2c2c1b', 'boards', '#1d2d1f'],
  midnight:    ['#1f2850', 'starry',   '#161c38', 'tile',   '#10162e'],
  velvet:      ['#52243a', 'stripe',   '#2e141c', 'boards', '#2f1220'],
  abyss:       ['#173a41', 'plain',    '#10252a', 'stone',  '#0c1d21'],
  frost:       ['#dce7f2', 'panel',    '#b4c2d2', 'tile',   '#f3f8ff'],
  haunt:       ['#2f1d3f', 'stripe',   '#1e1415', 'boards', '#1a0f24'],
  yuletide:    ['#27513a', 'panel',    '#3d261a', 'boards', '#6a1f2a'],
  fete:        ['#2d2468', 'stripe',   '#271c3e', 'tile',   '#d9a93a'],
  amour:       ['#612a40', 'panel',    '#3d1c25', 'boards', '#2d121c'],
  shamrock:    ['#225f3b', 'stripe',   '#273d1c', 'boards', '#143a22'],
  pastel:      ['#f7dde8', 'stripe',   '#e2c6b0', 'boards', '#fff6fa'],
  harvest:     ['#74482a', 'panel',    '#3d2614', 'boards', '#3a2412'],
  solstice:    ['#f5dfa0', 'stripe',   '#d7b06a', 'boards', '#fff4cf'],
  stormrider:  ['#2c3250', 'panel',    '#1f2334', 'stone',  '#161a28'],
  briarthrone: ['#35233f', 'stripe',   '#20152a', 'stone',  '#1a1024'],
  voidsignal:  ['#102232', 'grid',     '#0d1822', 'tile',   '#0a141c'],
  wisp:        ['#fbe6ef', 'stripe',   '#e8c9a8', 'boards', '#fffaf4'],
  'wisp-night':['#2d2150', 'starry',   '#1c1334', 'boards', '#150e28'],
};
export function shelf3dShellFor(themeKey, base) {
  const r = SHELF3D_SHELLS[themeKey];
  const light = base.mood === 'bright';
  const a = r || [base.floorTint, 'plain', base.woodDark, 'boards', base.woodDark];
  return { wall: a[0], pattern: a[1], floor: a[2], floorKind: a[3], trim: a[4], light: light };
}

export function shelf3dThemeFor(themeKey, accentKey) {
  const base = SHELF3D_THEMES[themeKey] || SHELF3D_THEMES.dark;
  const accent = SHELF3D_ACCENTS[accentKey] || base.accentGlow;
  // Fresh object per call — no shared-reference leaks.
  return {
    woodBase: base.woodBase,
    woodDark: base.woodDark,
    lightWarm: base.lightWarm,
    lightCool: base.lightCool,
    ambientLevel: base.ambientLevel,
    exposure: base.exposure,
    accentGlow: accent,
    floorTint: base.floorTint,
    mood: base.mood,
    shell: shelf3dShellFor(themeKey, base),
  };
}

export const Shelf3DTheme = { forTheme: shelf3dThemeFor };

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The one classic consumer, js/217-shelf3d-view.js,
   reads the Shelf3DTheme namespace at runtime, so the bridge
   republishes exactly the pre-conversion public surface on window.
   Bare-name lookups in classic scripts resolve through the global
   object, so the caller needs no changes. Module scripts are deferred,
   so the bridge is in place before any consumer can run. Remove a name
   from this bridge only when its last classic caller is gone. */
window.SHELF3D_ACCENTS = SHELF3D_ACCENTS;
window.SHELF3D_THEMES = SHELF3D_THEMES;
window.SHELF3D_SHELLS = SHELF3D_SHELLS;
window.shelf3dShellFor = shelf3dShellFor;
window.shelf3dThemeFor = shelf3dThemeFor;
window.Shelf3DTheme = Shelf3DTheme;
