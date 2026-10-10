'use strict';

/* ---------------- library view ---------------- */
function filteredBooks() {
  const q = query.trim().toLowerCase();
  const out = library.filter(b => {
    if (filter !== 'all' && b.status !== filter) return false;
    if (ownFilter === 'owned' && b.owned !== 'owned') return false;
    if (ownFilter === 'tobuy' && b.owned !== 'tobuy') return false;
    if (ownFilter === 'borrowed' && b.owned !== 'borrowed') return false;
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
      const pa = a.pageCount ? (a.progress || 0) / a.pageCount : 0;
      const pb = b.pageCount ? (b.progress || 0) / b.pageCount : 0;
      return pb - pa;
    },
    added: (a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')),
  }[sortBy] || ((a, b) => 0);
  return out.sort(by);
}

/* v125: glanceable cards — favorite heart overlaid on the cover, status strip
   (+ progress for currently-reading) along the tile's bottom edge. */
function coverFav(b) {
  return b.favorite
    ? '<span class="card-fav" role="img" aria-label="Favorite">' + icon('heart') + '</span>'
    : '';
}
function tileStatusBar(b) {
  let fill = '';
  if (b.status === 'reading' && b.pageCount) {
    const pct = Math.max(0, Math.min(100, Math.round((b.progress || 0) / b.pageCount * 100)));
    fill = '<i class="bt-fill" style="width:' + pct + '%"></i>';
  }
  return '<span class="bt-statusbar status-' + esc(b.status) + '" title="' + esc(STATUS[b.status]) + '">' + fill + '</span>';
}

function bookCard(b, i) {
  const badges = ['<span class="badge status-' + esc(b.status) + '">' + STATUS[b.status] + '</span>', ownedBadge(b)];
  if (b.publicRating) badges.push('<span class="badge">★ ' + Number(b.publicRating).toFixed(1) + '</span>');
  badges.push(ratingBadges(b));
  if (b.myRating > 0) badges.push('<span class="badge">' + '♥'.repeat(b.myRating) + '</span>');
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 40, 400) + 'ms' : '';
  let progHTML = '';
  if (b.status === 'reading' && b.pageCount) {
    const pct = Math.max(0, Math.min(100, Math.round((b.progress || 0) / b.pageCount * 100)));
    progHTML = '<div class="progress-line slim"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<p class="card-progress">p. ' + (b.progress || 0) + ' / ' + b.pageCount + ' · ' + pct + '%</p>';
  }
  return '<div class="book-card' + anim + '" data-id="' + esc(b.id) + '">' +
    coverHTML(b, '', coverFav(b)) +
    '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(displayAuthors(b.authors) || 'Unknown author') + '</p>' +
    '<div class="badges">' + badges.join('') + '</div>' + progHTML + '</div></div>';
}

/* Bookmory-style grid tile (v57): tall rounded card, cover up top in a fixed
   2:3 box, title below. The cover img is absolutely positioned so it can never
   stretch the box, no matter the photo's real dimensions. */
function bookTile(b, i) {
  const inner = b.cover
    ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' /* v217: async decode off the main thread */
    : '<span class="bt-fallback">' + icon('covers') + '</span>';
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 35, 420) + 'ms' : '';
  // v188: read badge — the same gold seal as the favorite spines, so a
  // finished book is recognizable in grid view too.
  const readSeal = b.status === 'read'
    ? '<span class="tile-read" title="Read" aria-label="Read">' + icon('check') + '</span>' : '';
  // v404: status/progress badge on grid tiles (TBR vs Reading vs progress)
  let gridBadge = '';
  if (b.status === 'reading' && b.pageCount) {
    const pct = Math.max(0, Math.min(100, Math.round((b.progress || 0) / b.pageCount * 100)));
    gridBadge = '<span class="bt-badge">' + pct + '%</span>';
  } else if (b.status === 'tbr') {
    gridBadge = '<span class="bt-badge">TBR</span>';
  } else if (b.status === 'dnf') {
    gridBadge = '<span class="bt-badge">DNF</span>';
  }
  return '<div class="book-tile' + anim + '" data-id="' + esc(b.id) + '">' +
    '<div class="bt-cover">' + inner + coverFav(b) + readSeal + gridBadge + tileStatusBar(b) + '</div>' +
    '<div class="bt-title" title="' + esc(b.title) + '">' + esc(b.title) + '</div></div>';
}

