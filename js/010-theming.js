'use strict';

/* ---------------- theming ---------------- */
const THEMES = [
  { key: 'dark',        name: 'Dark',        meta: '#14101a' },
  { key: 'light',       name: 'Light',       meta: '#faf5ec' },
  { key: 'hearthside',  name: 'Hearthside',  meta: '#17100a' },
  { key: 'candlelight', name: 'Candlelight', meta: '#f7efdc' },
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
  { key: 'amour',       name: 'Amour',       meta: '#1d0e15', season: 'valentine' },
  { key: 'shamrock',    name: 'Shamrock',    meta: '#0c1e13', season: 'stpatrick' },
  { key: 'pastel',      name: 'Pastel',      meta: '#f7f2fa', season: 'easter' },
  { key: 'harvest',     name: 'Harvest',     meta: '#191007', season: 'thanksgiving' },
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
function getAccent() { return localStorage.getItem('accent') || 'rose'; }
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
  document.documentElement.dataset.accent = a;
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', themeMeta(t));
  // v99: the social section is named per theme — keep the nav label in sync,
  // and re-render the coven views if that's where the user is standing.
  try {
    if (typeof refreshCovenNav === 'function') refreshCovenNav();
    if ((view === 'coven' || view === 'coven-friend') && typeof render === 'function') render();
  } catch (e) {}
}
