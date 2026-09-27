'use strict';

/* ---------------- storefront links ("where to buy" for wishlist books) ---------------- */
// Region-aware retailer search links. Verified live 2026-09-27 against a real
// book (Iron Flame): ISBN search is exact on Amazon ("1-1 of 1 results") but
// unreliable everywhere else — Indigo and B&N return zero results for valid
// ISBNs, Booktopia 404s on ISBN queries — while title + author finds the book
// as the top result on every store tested. So: Amazon searches by ISBN (exact
// edition), every other store searches by title + author (forgiving). No APIs
// or keys needed. (Kobo was dropped in v146 — unverifiable behind its bot
// check, and Indigo covers the Canadian market.)
const STORE_REGIONS = {
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
const STORE_REGION_KEYS = Object.keys(STORE_REGIONS);

function storeRegionSetting() {
  try { return localStorage.getItem('spicyshelves.storeRegion') || 'auto'; }
  catch (e) { return 'auto'; }
}

function detectStoreRegion() {
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
function storeQuery(b) {
  const isbn = String(b.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbn) return isbn;
  return storeTitleQuery(b);
}

// Title + author query — the reliable default for every non-Amazon store.
function storeTitleQuery(b) {
  return [b.title, (b.authors || [])[0]].filter(Boolean).join(' ');
}

function storeLinks(b) {
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
function ratingBadges(b) {
  return (b.axes || []).map(k => {
    const v = (b.ratings || {})[k] || 0;
    const a = axisByKey(k);
    return v > 0 ? '<span class="badge spice">' + icon(a.icon || 'pepper').repeat(v) + '</span>' : '';
  }).join('');
}

// The book's "main" axis: first one with a rating, else first enabled axis.
function primaryAxisKey(b) {
  const axes = (b.axes && b.axes.length) ? b.axes : ['spice'];
  return axes.find(k => ((b.ratings || {})[k] || 0) > 0) || axes[0];
}

