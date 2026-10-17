'use strict';

/* js/030-storefront.js — Storefront: region-aware "where to buy" links
 * for wishlist books, plus the rating badges the library and roulette
 * render.
 *
 * storeLinks(book) returns {name, url} search links for the stores of
 * the reader's region (STORE_REGIONS: CA / US / UK / AU). A stored
 * region choice ('spicyshelves.storeRegion') wins when present; else
 * the region is auto-detected from the device language, then the
 * timezone, else US.
 *
 * Which stores get which query is the file's load-bearing choice,
 * verified live 2026-09-27 against a real book: Amazon searches by ISBN
 * (exact — "1-1 of 1 results"), but ISBN search is unreliable
 * everywhere else (Indigo and Barnes & Noble return zero results for
 * valid ISBNs, Booktopia 404s on ISBN queries), so every other store
 * searches by title + author, which lands the book as the top result
 * on each. These are plain search URLs — no APIs, no keys. (Kobo was
 * dropped in v146: unverifiable behind its bot check, and Indigo
 * covers the Canadian market.)
 *
 * ratingBadges and primaryAxisKey render a book's rated axes from
 * js/020-ratings.js's axis table. This file's outbound reads are wired
 * as real imports — axisByKey from js/020-ratings.js, icon from
 * js/050-helpers.js (see ADR-003); its own surface still reaches
 * js/110, js/150, js/160 and js/180 through the window bridge at the
 * bottom of this file.
 */
import { axisByKey } from './020-ratings.js';
import { icon } from './050-helpers.js';

export const STORE_REGIONS = {
  CA: { label: 'Canada', stores: [
    { name: 'Amazon', mode: 'isbn', url: q => 'https://www.amazon.ca/s?k=' + encodeURIComponent(q) },
    { name: 'Indigo', url: q => 'https://www.indigo.ca/search?q=' + encodeURIComponent(q) },
  ] },
  US: { label: 'United States', stores: [
    { name: 'Amazon', mode: 'isbn', url: q => 'https://www.amazon.com/s?k=' + encodeURIComponent(q) },
    // v145: was /s/<query> — 404s; real pattern is /search?q= (verified live)
    { name: 'Barnes & Noble', url: q => 'https://www.barnesandnoble.com/search?q=' + encodeURIComponent(q) },
    // v145: /search redirects to /beta-search; link there directly
    { name: 'Bookshop.org', url: q => 'https://bookshop.org/beta-search?keywords=' + encodeURIComponent(q) },
  ] },
  UK: { label: 'United Kingdom', stores: [
    { name: 'Amazon', mode: 'isbn', url: q => 'https://www.amazon.co.uk/s?k=' + encodeURIComponent(q) },
    { name: 'Waterstones', url: q => 'https://www.waterstones.com/books/search/term/' + encodeURIComponent(q).replace(/%20/g, '+') },
    { name: 'Bookshop.org', url: q => 'https://bookshop.org/beta-search?keywords=' + encodeURIComponent(q) },
  ] },
  AU: { label: 'Australia', stores: [
    { name: 'Amazon', mode: 'isbn', url: q => 'https://www.amazon.com.au/s?k=' + encodeURIComponent(q) },
    // v145: was search.ep?keywords= — dead; real pattern from their search box (verified live)
    { name: 'Booktopia', url: q => 'https://www.booktopia.com.au/search?keywords=' + encodeURIComponent(q) + '&productType=917504&pn=1' },
  ] },
};
export const STORE_REGION_KEYS = Object.keys(STORE_REGIONS);

export function storeRegionSetting() {
  try { return localStorage.getItem('spicyshelves.storeRegion') || 'auto'; }
  catch (e) { return 'auto'; }
}

export function detectStoreRegion() {
  const s = storeRegionSetting();
  if (STORE_REGIONS[s]) return s;
  // auto: device language first (en-CA -> CA), then timezone, then US
  try {
    const lang = String((typeof navigator !== 'undefined' && navigator.language) || '').toUpperCase();
    const m = lang.match(/-([A-Z]{2})$/);
    if (m) {
      if (STORE_REGIONS[m[1]]) return m[1];
      if (m[1] === 'GB') return 'UK';
    }
  } catch (e) {}
  try {
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
    if (/^(America\/(Halifax|Toronto|Montreal|Vancouver|Winnipeg|Edmonton|Regina|St_Johns)|Canada\/)/.test(tz)) return 'CA';
    if (tz === 'Europe/London') return 'UK';
    if (/^Australia\//.test(tz)) return 'AU';
  } catch (e) {}
  return 'US';
}

// What to search the storefront for. Amazon gets the ISBN (exact-edition
// landing, verified); every other store gets title + author, which proved
// far more reliable live. storeQuery falls back to title + author when there
// is no ISBN, so Amazon degrades gracefully too.
export function storeQuery(b) {
  const isbn = String(b.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbn) return isbn;
  return storeTitleQuery(b);
}

// Title + author query — the reliable default for every non-Amazon store.
export function storeTitleQuery(b) {
  return [b.title, (b.authors || [])[0]].filter(Boolean).join(' ');
}

export function storeLinks(b) {
  const isbnQ = storeQuery(b);
  const titleQ = storeTitleQuery(b);
  return STORE_REGIONS[detectStoreRegion()].stores.map(s => ({
    name: s.name,
    url: s.url(s.mode === 'isbn' ? isbnQ : titleQ),
  }));
}

// Badges for every rated axis — line-art glyphs (v102). The axis emoji
// (notably ⚔️) render near-black on some Android emoji fonts, making them
// invisible on dark themes; the icons inherit the badge's accent color.
export function ratingBadges(b) {
  return (b.axes || []).map(k => {
    const v = (b.ratings || {})[k] || 0;
    const a = axisByKey(k);
    return v > 0 ? '<span class="badge spice">' + icon(a.icon || 'pepper').repeat(v) + '</span>' : '';
  }).join('');
}

// The book's "main" axis: first one with a rating, else first enabled axis.
export function primaryAxisKey(b) {
  const axes = (b.axes && b.axes.length) ? b.axes : ['spice'];
  return axes.find(k => ((b.ratings || {})[k] || 0) > 0) || axes[0];
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its consumers — js/110-library.js,
   js/150-modal-discovery.js, js/160-roulette.js and js/180-settings.js
   — still read this surface as globals at runtime, so the bridge
   republishes exactly the pre-conversion public surface on window.
   Bare-name lookups resolve through the global object, so the callers
   need no changes. Module scripts are deferred, so the bridge is in
   place before any consumer can run. Remove a name from this bridge
   only when its last window-reading caller has wired the read as an
   import (ADR-003). */
window.STORE_REGIONS = STORE_REGIONS;
window.STORE_REGION_KEYS = STORE_REGION_KEYS;
window.storeRegionSetting = storeRegionSetting;
window.detectStoreRegion = detectStoreRegion;
window.storeQuery = storeQuery;
window.storeTitleQuery = storeTitleQuery;
window.storeLinks = storeLinks;
window.ratingBadges = ratingBadges;
window.primaryAxisKey = primaryAxisKey;
