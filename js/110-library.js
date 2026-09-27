'use strict';

/* ---------------- library view ---------------- */
function filteredBooks() {
  const q = query.trim().toLowerCase();
  return library.filter(b => {
    if (filter !== 'all' && b.status !== filter) return false;
    if (ownFilter === 'owned' && b.owned !== 'owned') return false;
    if (ownFilter === 'tobuy' && b.owned !== 'tobuy') return false;
    if (ownFilter === 'borrowed' && b.owned !== 'borrowed') return false;
    if (!q) return true;
    return (b.title + ' ' + b.authors.join(' ') + ' ' + b.tropes.join(' '))
      .toLowerCase().includes(q);
  });
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
  return '<span class="bt-statusbar status-' + b.status + '" title="' + esc(STATUS[b.status]) + '">' + fill + '</span>';
}

function bookCard(b, i) {
  const badges = ['<span class="badge status-' + b.status + '">' + STATUS[b.status] + '</span>', ownedBadge(b)];
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
  return '<div class="book-card' + anim + '" data-id="' + b.id + '">' +
    coverHTML(b, '', coverFav(b)) +
    '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(b.authors.join(', ') || 'Unknown author') + '</p>' +
    '<div class="badges">' + badges.join('') + '</div>' + progHTML + '</div></div>';
}

/* Bookmory-style grid tile (v57): tall rounded card, cover up top in a fixed
   2:3 box, title below. The cover img is absolutely positioned so it can never
   stretch the box, no matter the photo's real dimensions. */
function bookTile(b, i) {
  const inner = b.cover
    ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '<span class="bt-fallback">' + icon('covers') + '</span>';
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 35, 420) + 'ms' : '';
  return '<div class="book-tile' + anim + '" data-id="' + b.id + '">' +
    '<div class="bt-cover">' + inner + coverFav(b) + tileStatusBar(b) + '</div>' +
    '<div class="bt-title">' + esc(b.title) + '</div></div>';
}

