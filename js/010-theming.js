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
