'use strict';

/* ---- wishlist tab: books marked "to buy" ---- */
function renderWishlist() {
  const books = library.filter(b => !b.owned)
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
  // v113: announced books with a future release date surface first, by date.
  const upcoming = books.filter(b => (daysUntil(b.releaseDate) || -1) >= 0)
    .sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)));
  const rest = books.filter(b => upcoming.indexOf(b) === -1);
  let html = '<div class="wish-head"><h2 class="serif">' + icon('gift') + ' Wishlist</h2>' +
    '<p class="note">' + books.length + ' book' + (books.length === 1 ? '' : 's') +
    ' you want to get your hands on</p></div>';
  if (!books.length) {
    html += '<div class="empty"><div class="big">' + icon('gift') + '</div><h2 class="serif">Nothing on the wishlist</h2>' +
      '<p>Open any book and choose <b>' + icon('tobuy') + ' To buy</b><br>under Ownership to add it here.</p></div>';
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
  document.querySelectorAll('.book-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
}

