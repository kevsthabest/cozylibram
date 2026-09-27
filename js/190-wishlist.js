'use strict';

/* ---- wishlist tab: books marked "to buy" ---- */
function renderWishlist() {
  const books = library.filter(b => !b.owned)
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
  let html = '<div class="wish-head"><h2 class="serif">' + icon('gift') + ' Wishlist</h2>' +
    '<p class="note">' + books.length + ' book' + (books.length === 1 ? '' : 's') +
    ' you want to get your hands on</p></div>';
  if (!books.length) {
    html += '<div class="empty"><div class="big">' + icon('gift') + '</div><h2 class="serif">Nothing on the wishlist</h2>' +
      '<p>Open any book and choose <b>' + icon('tobuy') + ' To buy</b><br>under Ownership to add it here.</p></div>';
  } else {
    html += '<div class="grid">' + books.map((b, i) => bookCard(b, i)).join('') + '</div>';
  }
  setView(html);
  document.querySelectorAll('.book-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
}

