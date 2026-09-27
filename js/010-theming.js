'use strict';

/* ---------------- theming ---------------- */
const THEMES = [
  { key: 'dark',        name: 'Dark',        meta: '#14101a' },
  { key: 'light',       name: 'Light',       meta: '#faf5ec' },
  { key: 'hearthside',  name: 'Hearthside',  meta: '#17100a' },
  { key: 'candlelight', name: 'Candlelight', meta: '#f7efdc' },
  { key: 'twilight',    name: 'Twilight',    meta: '#0e1120' },
  { key: 'verdant',     name: 'Verdant',     meta: '#0d140e' },
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
