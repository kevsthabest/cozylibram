'use strict';

/* ---- wishlist tab: the Wishlist shelf ----
   v559: the Wishlist is a VIEW over the derivation (isWishlistBook,
   js/000) — the to-buy part of TBR. Books marked "to buy" on read /
   reading / dnf are history, not wishlist, and never render here. */
/* v563 (Decision): resolving a trophy want — clears wantFormat, bumps
   _mtime so the resolution wins the next cloud merge, saves. The
   record's primary format is NOT changed here; the modal's format
   picker is the only way to change that. */
function trophyGotIt(id) {
  const b = library.find(x => x.id === id);
  if (!b || !b.wantFormat) return;
  b.wantFormat = '';
  b._mtime = Date.now();
  saveLibrary();
}

function renderWishlist() {
  const books = library.filter(isWishlistBook)
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
  // v563: trophy wants — second copies of books already held in another
  // format (isTrophyWant, js/000). Their own labelled section: they are
  // not to-buy TBR entries and never fold into the header count.
  const trophies = library.filter(isTrophyWant)
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
  if (!books.length && !trophies.length) {
    html += emptyState({
      icon: 'gift', title: 'Nothing on the wishlist… yet',
      body: 'Books on your TBR that you don\'t own yet live here.<br>Mark a book <b>To buy</b> in its Ownership — or add an upcoming release from Discover.',
      cta: { label: 'Discover books', go: 'discover' },
    });
  } else {
    // v582: every card carries a gift-buy slot (data-gift-buy-slot)
    // that js/243 fills with a Buy button opening the minimal
    // retailer sheet — the owner's own copy of the Gift a Book
    // flow, no claim, no address. Empty when gifts are unsupported.
    if (upcoming.length) {
      html += '<h3 class="wish-section">' + icon('calendar') + ' Coming soon</h3>' +
        '<div class="grid">' + upcoming.map((b, i) =>
          '<div class="up-wrap"><div class="up-pill">' + icon('calendar') + ' ' +
          esc(fmtDate(b.releaseDate)) + ' · ' + releaseCountdown(b.releaseDate) + '</div>' +
          bookCard(b, i) + '<div data-gift-buy-slot="' + esc(b.id) + '"></div></div>').join('') + '</div>';
    }
    if (rest.length) html += '<div class="grid">' + rest.map((b, i) =>
      '<div class="up-wrap">' + bookCard(b, i + upcoming.length) +
      '<div data-gift-buy-slot="' + esc(b.id) + '"></div></div>').join('') + '</div>';
    if (trophies.length) {
      html += '<h3 class="wish-section">' + icon('trophy') + ' Trophy wants</h3>' +
        '<p class="note">Second copies you\u2019re hunting — you already have these in another format.</p>' +
        '<div class="grid">' + trophies.map((b, i) =>
          '<div class="up-wrap"><div class="up-pill trophy-pill">' + icon('trophy') + ' Trophy · want ' +
          esc(FORMAT_META[b.wantFormat].label) + '</div>' +
          bookCard(b, i) +
          '<button class="btn ghost sm trophy-got" data-trophy-got="' + esc(b.id) + '">Got it</button>' +
          '<div data-gift-buy-slot="' + esc(b.id) + '"></div></div>').join('') + '</div>';
    }
  }
  setView(html);
  // v114: scope to real shelf cards — release-discovery cards carry data-i,
  // not data-id, and must not open the detail sheet.
  document.querySelectorAll('.book-card[data-id]').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  // v563: Got it resolves a trophy want in place, then re-renders.
  document.querySelectorAll('[data-trophy-got]').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      trophyGotIt(btn.dataset.trophyGot);
      toast('Trophy secured — marked as got');
      renderWishlist();
    }));
  wireReleaseCheck(); // v114: "Check for new releases"
  renderVisibleReleases(); // v150: restore the release list across re-renders
  // v582: Buy buttons on your own wishlist books (js/243; gated on
  // gift server support, silent otherwise).
  if (typeof fillOwnGiftBuys === 'function') fillOwnGiftBuys();
}

