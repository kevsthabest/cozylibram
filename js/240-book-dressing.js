'use strict';

/* ---------------- the app dresses for your book (v571) ----------------
   Spec: docs/book-dressing-spec.md. While a book is marked reading, the
   app's accent layer (--accent / --accent-deep — and --floral-tint, which
   is var(--accent) in styles.css, so it follows on its own) shifts to a
   palette derived from that book's cover. Accents ONLY: backgrounds,
   surfaces and text colours never change, and the reader's theme stays
   the base everywhere the accent doesn't reach.

   Palette source is CACHE-ONLY: the js/120 spine sampler's cache
   (spineColorCache — the same values the 3D spines and the candle tint
   read). This module never samples an image; a book whose cover hasn't
   been sampled yet simply doesn't dress until the cache catches up, and
   refreshBookDressing is re-run whenever the cache is written (hook in
   js/120's saveSpineColorCache), so the dress lands the moment the
   palette exists.

   Contrast gate: the raw cover colour is pulled, hue preserved, to the
   nearest HSL lightness whose WCAG contrast reaches DRESSING_GATE_MIN
   against BOTH the active theme's bg and card surfaces. The floor is
   measured, not invented: across all 23 built-in themes, the weakest
   built-in accent against its own surfaces scores ~1.99 (Pastel's lilac
   on its bg) and the rest run 2.4–9.1 — so 2.0 IS "the same contrast
   expectations as the built-in accents" (spec §1). Near-gray covers
   (saturation < 0.08) have no hue worth wearing and never dress.

   Which book: of the books marked reading, the one with the most recent
   progress update — lastPagedAt (stamped by logPages on every page
   update, js/040), falling back to the record's _mtime.

   The toggle ("Dress for my current book", Settings → Display, default
   ON) lives in localStorage key cozylibram.bookdress ('off' = disabled;
   absent = on) and roams in the v537 PREFS section (js/229
   PREFS_STATE_KEYS) — an existing roamed home for account preferences
   that are not settings keys; the frozen v518 settings list
   (USER_STATE_KEYS) is untouched. It is read live at every resolve, so
   a roamed apply is honoured the moment it lands (hook in js/229's
   userStateApplyPrefs).

   No-flash (the v543 lesson): the library lives in IndexedDB and can't
   be read synchronously at first paint, so this module mirrors its last
   resolved accent into localStorage (cozylibram.bookdress.applied) and
   the inline boot script in index.html re-applies that mirror pre-paint
   when the toggle is on — the same mirror pattern as the v543 theme
   boot. refreshBookDressing re-resolves authoritatively once the
   library is in and corrects or clears a stale mirror.

   Application is inline style properties on <html>, which sit above
   the [data-theme]/[data-accent] cascade: dressing never writes the
   reader's stored theme or accent pick, and removing the properties
   restores their exact cascade. styles.css registers --accent /
   --accent-deep as <color> via @property so changes cross-fade where
   the browser supports it; elsewhere the swap is instant, as before. */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const BOOK_DRESS_KEY = 'cozylibram.bookdress';
export const BOOK_DRESS_APPLIED_KEY = 'cozylibram.bookdress.applied';
export const BOOK_DRESS_NOTED_KEY = 'cozylibram.bookdress.noted';
export const DRESSING_GATE_MIN = 2.0;
export const DRESSING_CHROMA_MIN = 0.08;

/* Default ON: only an explicit 'off' disables (the prefs section's
   full-snapshot apply encodes "back to default" by removing the key). */
export function bookDressingEnabled() {
  try { return localStorage.getItem(BOOK_DRESS_KEY) !== 'off'; } catch (e) { return true; }
}

/* ---------- colour maths (self-contained; candle-family helpers) ---------- */
export function _dressRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function _dressHex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function _dressHsl(rgb) {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l: l };
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (mx === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h: h, s: s, l: l };
}
export function _dressFromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x]; else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
  return _dressHex(rgb.map(v => (v + m) * 255));
}
export function _dressLum(rgb) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
export function dressingContrast(hexA, hexB) {
  const a = _dressRgb(hexA), b = _dressRgb(hexB);
  if (!a || !b) return 0;
  const x = _dressLum(a), y = _dressLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function dressingHue(hex) {
  const rgb = _dressRgb(hex);
  return rgb ? _dressHsl(rgb).h : 0;
}

/* The gate: nearest lightness (hue + saturation preserved) whose contrast
   reaches `min` (default DRESSING_GATE_MIN) against EVERY surface, or
   null. Candidates scan [0.15, 0.85] ordered by distance from the cover's
   own lightness, so the winning shade is the closest honest version of
   the cover's colour. accent-deep mirrors the built-in pairs: same hue,
   lightness scaled ~0.78. */
export function dressingGate(hex, surfaces, min) {
  const rgb = _dressRgb(hex);
  if (!rgb || !Array.isArray(surfaces) || !surfaces.length) return null;
  const need = (typeof min === 'number' && min > 0) ? min : DRESSING_GATE_MIN;
  const hsl = _dressHsl(rgb);
  if (hsl.s < DRESSING_CHROMA_MIN) return null;
  const s = Math.min(hsl.s, 0.92);
  const steps = [];
  for (let i = 0; i <= 140; i++) steps.push(0.15 + i * 0.005);
  steps.sort((a, b) => Math.abs(a - hsl.l) - Math.abs(b - hsl.l));
  for (const l of steps) {
    const cand = _dressFromHsl(hsl.h, s, l);
    let pass = true;
    for (const surf of surfaces) {
      if (dressingContrast(cand, surf) < need - 1e-9) { pass = false; break; }
    }
    if (pass) {
      const deepL = Math.max(0.10, Math.min(l * 0.78, l - 0.04));
      return { accent: cand, deep: _dressFromHsl(hsl.h, s, deepL) };
    }
  }
  return null;
}

/* The sampler's cached dominant hex for the book's CURRENT cover, or
   null. Mirrors candleCoverHex's guard exactly (js/238): the cache entry
   must exist, its cover must equal b.cover (a cover change invalidates
   the palette until the new cover is sampled), hex must be #rrggbb. */
export function dressingCoverHex(b) {
  try {
    if (!b || !b.cover || typeof spineColorCache === 'undefined') return null;
    const c = spineColorCache[b.id];
    return (c && c.cover === b.cover && /^#[0-9a-f]{6}$/i.test(c.hex || '')) ? String(c.hex).toLowerCase() : null;
  } catch (e) { return null; }
}

/* The book to dress for: status 'reading', most recent progress update
   first (lastPagedAt, then _mtime). Deterministic on ties: first wins. */
export function dressingBook(books) {
  const reading = (books || []).filter(b => b && b.status === 'reading');
  let best = null, bestAt = -1;
  for (const b of reading) {
    const at = (Date.parse(b.lastPagedAt || '') || Number(b._mtime) || 0);
    if (at > bestAt) { bestAt = at; best = b; }
  }
  return best;
}

/* Pure resolution: { bookId, title, accent, deep } or null — null always
   means "the theme's own accents apply", for every reason (toggle off,
   nothing reading, palette uncached/stale, gate failed). */
export function resolveBookDressing() {
  try {
    if (!bookDressingEnabled()) return null;
    const books = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
    const book = dressingBook(books);
    if (!book) return null;
    const hex = dressingCoverHex(book);
    if (!hex) return null;
    const themeKey = (typeof getTheme === 'function') ? getTheme() : 'dark';
    const pv = (typeof themePreview === 'function') ? themePreview(themeKey) : null;
    if (!pv || !pv.bg || !pv.card) return null;
    const gated = dressingGate(hex, [pv.bg, pv.card]);
    if (!gated) return null;
    return { bookId: book.id, title: book.title || '', accent: gated.accent, deep: gated.deep };
  } catch (e) { return null; }
}

export let _dressingState = null; // last resolved { bookId, accent, deep } applied to the DOM

/* Reconcile the document with resolveBookDressing(). Cheap and
   idempotent: DOM/localStorage writes happen only on an actual change,
   so the hot hooks (every saveLibrary, every palette-cache write) cost
   a resolve and a comparison. */
export function refreshBookDressing() {
  try {
    const de = document.documentElement;
    const next = resolveBookDressing();
    if (!next) {
      if (_dressingState || de.dataset.dressed) {
        de.style.removeProperty('--accent');
        de.style.removeProperty('--accent-deep');
        delete de.dataset.dressed;
        try { localStorage.removeItem(BOOK_DRESS_APPLIED_KEY); } catch (e) {}
        _dressingState = null;
      }
      return;
    }
    if (_dressingState && _dressingState.bookId === next.bookId &&
        _dressingState.accent === next.accent && _dressingState.deep === next.deep &&
        de.dataset.dressed === next.bookId) return;
    de.style.setProperty('--accent', next.accent);
    de.style.setProperty('--accent-deep', next.deep);
    de.dataset.dressed = next.bookId;
    try {
      localStorage.setItem(BOOK_DRESS_APPLIED_KEY, JSON.stringify({ accent: next.accent, deep: next.deep }));
    } catch (e) {}
    const firstActivation = !_dressingState;
    _dressingState = next;
    // Spec §7: the first time dressing activates on this device, say what
    // happened and where the off switch is — once, never again.
    if (firstActivation) {
      try {
        if (localStorage.getItem(BOOK_DRESS_NOTED_KEY) !== '1') {
          localStorage.setItem(BOOK_DRESS_NOTED_KEY, '1');
          if (typeof toast === 'function') {
            toast('The app is dressed for \u201C' + (next.title || 'your current book') + '\u201D — its cover colours, worn as accents. Off any time in Settings \u2192 Display.');
          }
        }
      } catch (e) {}
    }
  } catch (e) { /* dressing must never break a render path */ }
}

if (typeof module !== 'undefined') {
  module.exports = {
    bookDressingEnabled: bookDressingEnabled,
    dressingGate: dressingGate,
    dressingContrast: dressingContrast,
    dressingHue: dressingHue,
    dressingCoverHex: dressingCoverHex,
    dressingBook: dressingBook,
    resolveBookDressing: resolveBookDressing,
    refreshBookDressing: refreshBookDressing,
    DRESSING_GATE_MIN: DRESSING_GATE_MIN,
    BOOK_DRESS_KEY: BOOK_DRESS_KEY,
    BOOK_DRESS_APPLIED_KEY: BOOK_DRESS_APPLIED_KEY,
  };
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/010-theming.js, js/040-storage.js, js/095-gate.js, js/120-favorites.js, js/180-settings.js and js/229-user-state.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.BOOK_DRESS_KEY = BOOK_DRESS_KEY;
window.BOOK_DRESS_APPLIED_KEY = BOOK_DRESS_APPLIED_KEY;
window.BOOK_DRESS_NOTED_KEY = BOOK_DRESS_NOTED_KEY;
window.DRESSING_GATE_MIN = DRESSING_GATE_MIN;
window.DRESSING_CHROMA_MIN = DRESSING_CHROMA_MIN;
window.bookDressingEnabled = bookDressingEnabled;
window._dressRgb = _dressRgb;
window._dressHex = _dressHex;
window._dressHsl = _dressHsl;
window._dressFromHsl = _dressFromHsl;
window._dressLum = _dressLum;
window.dressingContrast = dressingContrast;
window.dressingHue = dressingHue;
window.dressingGate = dressingGate;
window.dressingCoverHex = dressingCoverHex;
window.dressingBook = dressingBook;
window.resolveBookDressing = resolveBookDressing;
window._dressingState = _dressingState;
window.refreshBookDressing = refreshBookDressing;
