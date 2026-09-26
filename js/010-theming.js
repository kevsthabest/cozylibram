'use strict';

/* ---------------- theming ---------------- */
const ACCENTS = [
  { key: 'rose',   name: 'Rose',   color: '#e5488f' },
  { key: 'violet', name: 'Violet', color: '#8b5cf6' },
  { key: 'gold',   name: 'Gold',   color: '#c08a24' },
  { key: 'teal',   name: 'Teal',   color: '#2fa39a' },
];
function getTheme() { return localStorage.getItem('theme') || 'dark'; }
function getAccent() { return localStorage.getItem('accent') || 'rose'; }
function applyTheme() {
  const t = getTheme(), a = getAccent();
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.accent = a;
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', t === 'light' ? '#faf5ec' : '#14101a');
}

