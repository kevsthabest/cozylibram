'use strict';

/* ---- wishlist tab: books marked "to buy" ---- */
function renderWishlist() {
  const books = library.filter(b => b.owned === 'tobuy')
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
  // v113: announced books with a future release date surface first, by date.
  // v114: a release *today* counts too (daysUntil 0 is not falsy-safe).
  const isUpcoming = b => { const du = daysUntil(b.releaseDate); return du != null && du >= 0; };
  const upcoming = books.filter(isUpcoming)
    .sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)));
  const rest = books.filter(b => upcoming.indexOf(b) === -1);
  let html = '<div class="wish-head"><h2 class="serif">' + icon('gift') + ' Wishlist</h2>' +
    '<p class="note">' + books.length + ' book' + (books.length === 1 ? '' : 's') +
    ' you want to get your hands on</p></div>' +
    '<div class="rel-check-row"><button class="btn ghost" id="rel-check">' + icon('sparkles') + ' Check for new releases</button></div>' +
    '<div id="release-results"></div>';
  if (!books.length) {
    html += emptyState({
      icon: 'gift', title: 'Nothing on the wishlist… yet',
      body: 'Open any book and choose <b>' + icon('tobuy') + ' To buy</b><br>under Ownership to add it here.',
      cta: { label: 'Discover books', go: 'discover' },
    });
  } else {
    if (upcoming.length) {
      html += '<h3 class="wish-section">' + icon('calendar') + ' Coming soon</h3>' +
        '<div class="grid">' + upcoming.map((b, i) =>
          '<div class="up-wrap"><div class="up-pill">' + icon('calendar') + ' ' +
          esc(fmtDate(b.releaseDate)) + ' · ' + releaseCountdown(b.releaseDate) + '</div>' +
          bookCard(b, i) + '</div>').join('') + '</div>';
    }
    html += '<div class="grid">' + rest.map((b, i) => bookCard(b, i + upcoming.length)).join('') + '</div>';
  }
  setView(html);
  // v114: scope to real shelf cards — release-discovery cards carry data-i,
  // not data-id, and must not open the detail sheet.
  document.querySelectorAll('.book-card[data-id]').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  wireReleaseCheck(); // v114: "Check for new releases"
}

