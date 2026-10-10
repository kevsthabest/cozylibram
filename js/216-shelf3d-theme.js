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

const SHELF3D_ACCENTS = {
  rose: '#e5488f', violet: '#8b5cf6', gold: '#c08a24', teal: '#2fa39a',
  crimson: '#d43a55', ember: '#e0722a', ocean: '#3f8fd6', sage: '#8aa864',
  blush: '#f2a3c0', copper: '#c47b4a', mint: '#6fce9e', lilac: '#b9a3f2',
};

// Per-theme 3D params. woodBase/woodDark: shelf timber. lightWarm: key light.
// lightCool: rim/fill. ambientLevel/exposure: lift for dark themes.
// accentGlow: fairy-light/decoration glow. floorTint: floor/vignette.
const SHELF3D_THEMES = {
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
};

function shelf3dThemeFor(themeKey, accentKey) {
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
  };
}

window.Shelf3DTheme = { forTheme: shelf3dThemeFor };
