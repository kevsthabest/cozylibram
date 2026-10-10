'use strict';

/* ---------------- theming ---------------- */
const THEMES = [
  { key: 'dark',        name: 'Dark',        meta: '#14101a' },
  { key: 'light',       name: 'Light',       meta: '#faf5ec' },
  { key: 'hearthside',  name: 'Hearthside',  meta: '#1e0e0a' }, // v416 (T2): was #17100a
  { key: 'candlelight', name: 'Candlelight', meta: '#f2e2bd' }, // v416 (T3): was #f7efdc
  { key: 'twilight',    name: 'Twilight',    meta: '#0e1120' },
  { key: 'verdant',     name: 'Verdant',     meta: '#0d140e' },
  { key: 'midnight',    name: 'Midnight',    meta: '#191a30' },
  { key: 'velvet',      name: 'Velvet',      meta: '#1c1219' },
  { key: 'abyss',       name: 'Abyss',       meta: '#0b1416' },
  { key: 'frost',       name: 'Frost',       meta: '#edf1f6' },
  // v257: seasonal themes — always pickable, nudged while their season runs.
  { key: 'haunt',       name: 'Haunt',       meta: '#150e1c', season: 'halloween' },
  { key: 'yuletide',    name: 'Yuletide',    meta: '#0c1811', season: 'christmas' },
  { key: 'fete',        name: 'Fête',        meta: '#0f1330', season: 'newyear' },
  { key: 'amour',       name: 'Amour',       meta: '#2a1420', season: 'valentine' }, // v416 (T1): was #1d0e15
  { key: 'shamrock',    name: 'Shamrock',    meta: '#0c1e13', season: 'stpatrick' },
  { key: 'pastel',      name: 'Pastel',      meta: '#f7f2fa', season: 'easter' },
  { key: 'harvest',     name: 'Harvest',     meta: '#191007', season: 'thanksgiving' },
  // v416 (T6): Solstice — summer seasonal. Completes the year.
  { key: 'solstice',    name: 'Solstice',    meta: '#fdf1d7', season: 'summer' },
  // v423: premium theme packs (flagged premium, unlocked during alpha).
  { key: 'stormrider',  name: 'Stormrider',  meta: '#12141f', premium: true, pack: 'stormrider' },
  { key: 'briarthrone', name: 'Briarthrone', meta: '#130e1a', premium: true, pack: 'briarthrone' },
  { key: 'voidsignal',  name: 'Voidsignal',  meta: '#0a0f14', premium: true, pack: 'voidsignal' },
  { key: 'wisp',        name: 'Wisp',        meta: '#fdf6ec', premium: true, pack: 'wisp' },
  { key: 'wisp-night',  name: 'Wisp Night',  meta: '#0e0a1a', premium: true, pack: 'wisp' },
];
const ACCENTS = [
  { key: 'rose',   name: 'Rose',   color: '#e5488f' },
  { key: 'violet', name: 'Violet', color: '#8b5cf6' },
  { key: 'gold',   name: 'Gold',   color: '#c08a24' },
  { key: 'teal',   name: 'Teal',   color: '#2fa39a' },
  { key: 'crimson', name: 'Crimson', color: '#d43a55' },
  { key: 'ember',   name: 'Ember',   color: '#e0722a' },
  { key: 'ocean',   name: 'Ocean',   color: '#3f8fd6' },
  { key: 'sage',    name: 'Sage',    color: '#8aa864' },
  { key: 'blush',   name: 'Blush',   color: '#f2a3c0' },
  { key: 'copper',  name: 'Copper',  color: '#c47b4a' },
  { key: 'mint',    name: 'Mint',    color: '#6fce9e' },
  { key: 'lilac',   name: 'Lilac',   color: '#b9a3f2' },
];
function getTheme() {
  const t = localStorage.getItem('theme') || 'dark';
  return THEMES.some(th => th.key === t) ? t : 'dark';
}
function themeMeta(key) {
  const th = THEMES.find(x => x.key === key);
  return th ? th.meta : '#14101a';
}
function getAccent() {
  // v416: null when the user never picked one — the theme's own designed
  // accent (its CSS --accent) wins instead of forcing rose everywhere.
  try { return localStorage.getItem('accent'); } catch (e) { return null; }
}
// v416 (T4): each theme's designed default accent — mirrors the CSS --accent
// token per theme. Used for "reset to theme default" and accent guidance.
const THEME_DEFAULT_ACCENT = {
  dark: 'violet', light: 'rose', hearthside: 'ember', candlelight: 'gold',
  twilight: 'violet', verdant: 'sage', midnight: 'rose', velvet: 'rose',
  abyss: 'teal', frost: 'rose',
  haunt: 'ember', yuletide: 'crimson', fete: 'gold', amour: 'blush',
  shamrock: 'mint', pastel: 'lilac', harvest: 'copper', solstice: 'gold',
  // v423: premium packs
  stormrider: 'gold', briarthrone: 'lilac', voidsignal: 'ocean',
  wisp: 'rose', 'wisp-night': 'gold',
};
function themeDefaultAccent(key) { return THEME_DEFAULT_ACCENT[key] || 'rose'; }
// Effective accent: the user's explicit pick, else the theme's designed default.
function effectiveAccent() { return getAccent() || themeDefaultAccent(getTheme()); }
// v416 (P2): accent pairing guidance per theme. First entry is the theme default.
const THEME_ACCENT_PAIRINGS = {
  dark: ['violet', 'rose', 'gold'],
  light: ['rose', 'gold', 'blush'],
  hearthside: ['ember', 'copper', 'gold'],
  candlelight: ['gold', 'copper', 'rose'],
  twilight: ['violet', 'lilac', 'ocean'],
  verdant: ['sage', 'mint', 'gold'],
  midnight: ['rose', 'violet', 'gold'],
  velvet: ['rose', 'blush', 'gold'],
  abyss: ['teal', 'ocean', 'violet'],
  frost: ['rose', 'ocean', 'lilac'],
  haunt: ['ember', 'gold', 'crimson'],
  yuletide: ['crimson', 'gold', 'mint'],
  fete: ['gold', 'violet', 'rose'],
  amour: ['blush', 'rose', 'lilac'],
  shamrock: ['mint', 'sage', 'gold'],
  pastel: ['lilac', 'blush', 'mint'],
  harvest: ['copper', 'gold', 'ember'],
  solstice: ['gold', 'ocean', 'blush'],
  // v423: premium packs
  stormrider: ['gold', 'ocean', 'ember'],
  briarthrone: ['lilac', 'crimson', 'violet'],
  voidsignal: ['ocean', 'teal', 'crimson'],
  wisp: ['rose', 'blush', 'mint'],
  'wisp-night': ['gold', 'rose', 'violet'],
};
function themeAccentPairings(key) { return THEME_ACCENT_PAIRINGS[key] || [themeDefaultAccent(key)]; }
// v416 (P1): live mini-preview tokens per theme for the gallery cards.
// bg mirrors the THEMES meta; accent is the theme's designed default.
const THEME_PREVIEW = {
  dark:        { bg: '#14101a', card: '#241a30', ink: '#f3e9f5', muted: '#b9a8c4', accent: '#8b5cf6' },
  light:       { bg: '#faf5ec', card: '#fffdf7', ink: '#2c2333', muted: '#6f5f78', accent: '#e5488f' },
  hearthside:  { bg: '#1e0e0a', card: '#331a12', ink: '#f7e8d6', muted: '#d0a080', accent: '#e0722a' },
  candlelight: { bg: '#f2e2bd', card: '#faf0d8', ink: '#33250f', muted: '#6f5a36', accent: '#c08a24' },
  twilight:    { bg: '#0e1120', card: '#1a2138', ink: '#e9ebf7', muted: '#a4aac9', accent: '#8b5cf6' },
  verdant:     { bg: '#0d140e', card: '#172419', ink: '#eaf3e5', muted: '#a5bda1', accent: '#8aa864' },
  midnight:    { bg: '#191a30', card: '#232442', ink: '#f0edf9', muted: '#b3b0d2', accent: '#e5488f' },
  velvet:      { bg: '#1c1219', card: '#2c1f28', ink: '#f7ecef', muted: '#c9a9b5', accent: '#e5488f' },
  abyss:       { bg: '#0b1416', card: '#142427', ink: '#e8f2f1', muted: '#a3bcb9', accent: '#2fa39a' },
  frost:       { bg: '#edf1f6', card: '#ffffff', ink: '#232b3a', muted: '#5d6b82', accent: '#e5488f' },
  haunt:       { bg: '#150e1c', card: '#221630', ink: '#f5e8f0', muted: '#c2a8c8', accent: '#e0722a' },
  yuletide:    { bg: '#0c1811', card: '#142a1c', ink: '#f0f4ec', muted: '#a9c2ae', accent: '#d43a55' },
  fete:        { bg: '#0f1330', card: '#1a2049', ink: '#f2ecdc', muted: '#b3abd0', accent: '#c08a24' },
  amour:       { bg: '#2a1420', card: '#3d2030', ink: '#fbeef3', muted: '#d8b0bf', accent: '#f2a3c0' },
  shamrock:    { bg: '#0c1e13', card: '#163620', ink: '#ecf5e8', muted: '#a4c8ab', accent: '#6fce9e' },
  pastel:      { bg: '#f7f2fa', card: '#fffdf9', ink: '#3a2c44', muted: '#6f5b79', accent: '#b9a3f2' },
  harvest:     { bg: '#191007', card: '#2a1a0d', ink: '#f5e9d6', muted: '#c8a87e', accent: '#c47b4a' },
  solstice:    { bg: '#fdf1d7', card: '#fffaf0', ink: '#3a2a12', muted: '#7a6540', accent: '#c08a24' },
  // v423: premium packs
  stormrider:  { bg: '#12141f', card: '#1d2233', ink: '#eef1f8', muted: '#8a94b8', accent: '#c08a24' },
  briarthrone: { bg: '#130e1a', card: '#211628', ink: '#f3e9f5', muted: '#a898b8', accent: '#b9a3f2' },
  voidsignal:  { bg: '#0a0f14', card: '#111a22', ink: '#e6f1f5', muted: '#7a94a8', accent: '#3f8fd6' },
  wisp:        { bg: '#fdf6ec', card: '#ffffff', ink: '#3a2f28', muted: '#8a7a68', accent: '#e5488f' },
  'wisp-night':{ bg: '#0e0a1a', card: '#1a1230', ink: '#f5eefb', muted: '#a898c8', accent: '#c08a24' },
};
function themePreview(key) { return THEME_PREVIEW[key] || THEME_PREVIEW.dark; }
// v257: season -> full look (theme + accent). The nudge offers it; the
// user's existing theme is never switched without a tap.
const SEASON_THEMES = {
  newyear:      { theme: 'fete',     accent: 'gold',   blurb: 'Happy New Year' },
  valentine:    { theme: 'amour',    accent: 'blush',  blurb: "Valentine's Day is coming" },
  stpatrick:    { theme: 'shamrock', accent: 'mint',   blurb: "St. Patrick's Day is coming" },
  easter:       { theme: 'pastel',   accent: 'lilac',  blurb: 'Easter is coming' },
  thanksgiving: { theme: 'harvest',  accent: 'copper', blurb: 'Thanksgiving is coming' },
  halloween:    { theme: 'haunt',    accent: 'ember',  blurb: 'Spooky season is here' },
  christmas:    { theme: 'yuletide', accent: 'crimson', blurb: 'The holidays are coming' },
  summer:       { theme: 'solstice', accent: 'gold',   blurb: 'Long days are here' }, // v416 (T6)
};
function seasonThemeNudge() {
  const season = (typeof shelfSeason === 'function') ? shelfSeason() : 'none';
  const st = SEASON_THEMES[season];
  if (!st || getTheme() === st.theme) return null;
  try {
    if (localStorage.getItem('seasonThemeNudge:' + season)) return null;
  } catch (e) {}
  return season;
}
function seasonThemeNudgeHTML() {
  const season = seasonThemeNudge();
  if (!season) return '';
  const st = SEASON_THEMES[season];
  const th = THEMES.find(t => t.key === st.theme) || { name: st.theme };
  const icon = (typeof SHELF_SEASONS !== 'undefined' && SHELF_SEASONS[season])
    ? SHELF_SEASONS[season].icon : '✨';
  return '<div class="season-nudge" id="seasonNudge">' +
    '<span class="sn-icon" aria-hidden="true">' + icon + '</span>' +
    '<div class="sn-text"><b>' + esc(st.blurb) + '</b><span>Try the ' + esc(th.name) + ' theme</span></div>' +
    '<button class="btn sm" id="snApply">Try it</button>' +
    '<button class="sn-x" id="snDismiss" aria-label="Dismiss">✕</button></div>';
}
function seasonThemeDismiss(season) {
  try { localStorage.setItem('seasonThemeNudge:' + season, '1'); } catch (e) {}
}
function wireSeasonNudge() {
  const apply = document.getElementById('snApply');
  if (!apply) return;
  const season = seasonThemeNudge();
  const st = season && SEASON_THEMES[season];
  if (!st) return;
  apply.addEventListener('click', () => {
    try {
      localStorage.setItem('theme', st.theme);
      localStorage.setItem('accent', st.accent);
    } catch (e) {}
    seasonThemeDismiss(season);
    applyTheme();
    render();
    toast('Theme: ' + (THEMES.find(t => t.key === st.theme) || {}).name);
  });
  const x = document.getElementById('snDismiss');
  if (x) x.addEventListener('click', () => {
    seasonThemeDismiss(season);
    const el = document.getElementById('seasonNudge');
    if (el) el.remove();
  });
}
function applyTheme() {
  const t = getTheme(), a = getAccent();
  document.documentElement.dataset.theme = t;
  // v416: only override the theme's designed accent when the user picked one.
  // No stored pick -> the theme's own CSS --accent wins (T4: Dark opens violet).
  if (a) document.documentElement.dataset.accent = a;
  else document.documentElement.removeAttribute('data-accent');
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', themeMeta(t));
  // v99: the social section is named per theme — keep the nav label in sync,
  // and re-render the coven views if that's where the user is standing.
  try {
    if (typeof refreshCovenNav === 'function') refreshCovenNav();
    if ((view === 'coven' || view === 'coven-friend') && typeof render === 'function') render();
    // v418: re-apply modal flairs — motif follows the theme.
    if (typeof ModalFlairs !== 'undefined' && typeof ModalFlairs.refresh === 'function') ModalFlairs.refresh();
  } catch (e) {}
}
