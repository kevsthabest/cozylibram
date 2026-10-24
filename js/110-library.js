'use strict';

/* ---------------- library view ---------------- */
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */

export function filteredBooks() {
  const q = query.trim().toLowerCase();
  const out = library.filter(b => {
    // v559: the 'wishlist' filter is the derived shelf (tbr + tobuy),
    // not a status match.
    if (filter === 'wishlist') { if (!isWishlistBook(b)) return false; }
    else if (filter !== 'all' && b.status !== filter) return false;
    if (ownFilter === 'owned' && b.owned !== 'owned') return false;
    if (ownFilter === 'tobuy' && b.owned !== 'tobuy') return false;
    if (ownFilter === 'borrowed' && b.owned !== 'borrowed') return false;
    if (ownFilter === 'subscription' && b.owned !== 'subscription') return false; // v563
    if (!q) return true;
    return (b.title + ' ' + b.authors.join(' ') + ' ' + b.tropes.join(' '))
      .toLowerCase().includes(q);
  });
  // v404: sort
  const by = {
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
    author: (a, b) => String((a.authors || [])[0] || '').localeCompare(String((b.authors || [])[0] || '')),
    rating: (a, b) => (b.myRating || b.publicRating || 0) - (a.myRating || a.publicRating || 0),
    progress: (a, b) => {
      // Sort by percent read, whichever unit a book logs in — a percent
      // divided by a print page count would rank audiobooks by fiction.
      const pa = (progressPctOf(a) ?? 0) / 100;
      const pb = (progressPctOf(b) ?? 0) / 100;
      return pb - pa;
    },
    added: (a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')),
  }[sortBy] || ((a, b) => 0);
  return out.sort(by);
}

/* v510: status -> [bookmark glyph, badge label] for the tile chip family. */
export const STATUS_BADGE = {
  tbr: ['bmtbr', 'To read'],
  reading: ['bmreading', 'Reading'],
  read: ['bmread', 'Read'],
  dnf: ['bmdnf', 'Did not finish'],
  wishlist: ['bmwishlist', 'Wishlist'] // v559: not a status — the derived wishlist book's chip (see bookTile)
};

/* v125: glanceable cards — favorite heart overlaid on the cover, status strip
   (+ progress for currently-reading) along the tile's bottom edge. */
export function coverFav(b) {
  return b.favorite
    ? '<span class="card-fav" role="img" aria-label="Favorite">' + icon('favbook') + '</span>'
    : '';
}
export function tileStatusBar(b) {
  let fill = '';
  if (b.status === 'reading') {
    // The fill is the book's percent read, whichever unit it logs in:
    // progressPctOf derives it from pages, or returns the stored
    // percent itself for a percent-logging audiobook (whose progress
    // is not a page number and may have no pageCount to divide by).
    const pct = progressPctOf(b);
    if (pct != null) fill = '<i class="bt-fill" style="width:' + pct + '%"></i>';
  }
  return '<span class="bt-statusbar status-' + esc(b.status) + '" title="' + esc(STATUS[b.status]) + '">' + fill + '</span>';
}

export function bookCard(b, i) {
  const badges = ['<span class="badge status-' + esc(b.status) + '">' + STATUS[b.status] + '</span>', ownedBadge(b)];
  if (b.publicRating) badges.push('<span class="badge">★ ' + Number(b.publicRating).toFixed(1) + '</span>');
  badges.push(ratingBadges(b));
  if (b.myRating > 0) badges.push('<span class="badge">' + '♥'.repeat(b.myRating) + '</span>');
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 40, 400) + 'ms' : '';
  let progHTML = '';
  if (b.status === 'reading') {
    const pct = progressPctOf(b);
    if (pct != null) {
      progHTML = '<div class="progress-line slim"><div class="fill" style="width:' + pct + '%"></div></div>' +
        // A percent-logging audiobook's label is the percent alone —
        // "p. 45 / 384" would present a percent as a page number.
        (progressUnitOf(b) === 'pct'
          ? '<p class="card-progress">' + pct + '%</p>'
          : '<p class="card-progress">p. ' + (b.progress || 0) + ' / ' + b.pageCount + ' · ' + pct + '%</p>');
    }
  }
  return '<div class="book-card' + anim + '" data-id="' + esc(b.id) + '">' +
    coverHTML(b, '', coverFav(b)) +
    '<div class="book-meta"><h4>' + esc(b.title) + '</h4>' +
    '<p class="author">' + esc(displayAuthors(b.authors) || 'Unknown author') + '</p>' +
    '<div class="badges">' + badges.join('') + '</div>' + progHTML + '</div></div>';
}

/* Bookmory-style grid tile (v57): tall rounded card, cover up top in a fixed
   2:3 box, title below. The cover img is absolutely positioned so it can never
   stretch the box, no matter the photo's real dimensions. */
export function bookTile(b, i) {
  const inner = b.cover
    ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' /* v217: async decode off the main thread */
    : '<span class="bt-fallback">' + icon('covers') + '</span>';
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 35, 420) + 'ms' : '';
  // v510: status bookmark chip (Variant A) — one bookmark silhouette per
  // state in the retired gold seal's corner, above the status strip. The
  // TBR/DNF text badges retire; the reading % stays text as a pill tucked
  // left of the chip (a number can't be an icon). The reading glyph's
  // half-fill is a fixed state cue, never the real percentage.
  // v559: a wishlist book's bookmark is the wishlist glyph — wishlist-
  // ness is derived (tbr + tobuy), so the badge key derives with it.
  const badgeKey = isWishlistBook(b) ? 'wishlist' : b.status;
  const sb = STATUS_BADGE[badgeKey];
  const stateBadge = sb
    ? '<span class="tile-badge st-' + badgeKey + '" title="' + sb[1] + '" aria-label="' + sb[1] + '">' + icon(sb[0]) + '</span>' : '';
  let pctPill = '';
  if (b.status === 'reading') {
    const pct = progressPctOf(b);
    if (pct != null) pctPill = '<span class="bt-pct">' + pct + '%</span>';
  }
  return '<div class="book-tile' + anim + '" data-id="' + esc(b.id) + '">' +
    '<div class="bt-cover">' + inner + coverFav(b) + stateBadge + pctPill + tileStatusBar(b) + '</div>' +
    '<div class="bt-title" title="' + esc(b.title) + '">' + esc(b.title) + '</div></div>';
}


/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/120-favorites.js, js/190-wishlist.js and js/195-coven.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.filteredBooks = filteredBooks;
window.STATUS_BADGE = STATUS_BADGE;
window.coverFav = coverFav;
window.tileStatusBar = tileStatusBar;
window.bookCard = bookCard;
window.bookTile = bookTile;
