'use strict';

/* ---------------- library view ---------------- */
function filteredBooks() {
  const q = query.trim().toLowerCase();
  return library.filter(b => {
    if (filter !== 'all' && b.status !== filter) return false;
    if (ownFilter === 'owned' && !b.owned) return false;
    if (ownFilter === 'tobuy' && b.owned) return false;
    if (!q) return true;
    return (b.title + ' ' + b.authors.join(' ') + ' ' + b.tropes.join(' '))
      .toLowerCase().includes(q);
  });
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
    coverHTML(b) +
    '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(b.authors.join(', ') || 'Unknown author') + '</p>' +
    '<div class="badges">' + badges.join('') + '</div>' + progHTML + '</div></div>';
}

function coverTile(b, i) {
  const short = { tbr: 'TBR', reading: 'Reading', read: 'Read', dnf: 'DNF' };
  const inner = b.cover
    ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '<span class="tile-fallback">📕</span>';
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 35, 420) + 'ms' : '';
  const pk = primaryAxisKey(b);
  const pv = (b.ratings || {})[pk] || 0;
  const ratingOverlay = pv > 0
    ? '<span class="tile-spice">' + axisByKey(pk).emoji + pv + '</span>' : '';
  return '<div class="cover-tile' + anim + '" data-id="' + b.id + '">' +
    '<div class="tile-cover">' + inner +
    '<span class="tile-status s-' + b.status + '">' + short[b.status] + '</span>' +
    (b.owned ? '' : '<span class="tile-buy" title="To buy">🛒</span>') +
    ratingOverlay +
    '</div>' +
    '<div class="tile-title">' + esc(b.title) + '</div>' +
    '<div class="tile-author">' + esc(b.authors.join(', ') || 'Unknown author') + '</div></div>';
}

