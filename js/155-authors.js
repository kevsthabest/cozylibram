'use strict';

/* ---- Authors tab (v43): every author she owns books by. Tapping an author
   shows owned books, wishlist books, and their other books she's missing
   (shaded out) — missing books come from the Open Library author lookup
   shared with the discovery sheets, each with a + Wishlist button. ---- */
let authorView = null; // author display name when view === 'author'

function authorIndex() {
  const map = new Map();
  library.forEach(b => {
    (b.authors || []).forEach(a => {
      const name = String(a || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!map.has(key)) map.set(key, { name: name, owned: [], wanted: [] });
      const e = map.get(key);
      if (b.owned) e.owned.push(b); else e.wanted.push(b);
    });
  });
  // only authors she owns at least one book by
  const list = Array.from(map.values()).filter(e => e.owned.length > 0);
  list.sort((x, y) => x.name.localeCompare(y.name));
  return list;
}

function authorRowHTML(e) {
  const sub = e.owned.length + ' owned' +
    (e.wanted.length ? ' · ' + e.wanted.length + ' on wishlist' : '');
  return '<button class="crow author-row" data-author="' + esc(e.name) + '">' +
    '<span class="aavatar">' + esc(e.name.trim().charAt(0).toUpperCase()) + '</span>' +
    '<span class="ctext"><b>' + esc(e.name) + '</b><small>' + esc(sub) + '</small></span>' +
    '<span class="cgo">›</span></button>';
}

function renderAuthors() {
  const list = authorIndex();
  let html = '<div class="wish-head"><h2 class="serif">✍️ Authors</h2>' +
    '<p class="note">' + list.length + ' author' + (list.length === 1 ? '' : 's') +
    ' on your shelves</p></div>';
  if (!list.length) {
    html += '<div class="empty"><div class="big">✍️</div><h2 class="serif">No authors yet</h2>' +
      '<p>Add some books and your authors<br>will gather here.</p></div>';
  } else {
    html += '<div class="collection-list">' + list.map(authorRowHTML).join('') + '</div>';
  }
  setView(html);
  document.querySelectorAll('[data-author]').forEach(el =>
    el.addEventListener('click', () => openAuthor(el.dataset.author)));
}

function openAuthor(name) {
  authorView = name;
  view = 'author';
  animateIn = true;
  document.querySelectorAll('.bottom-nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === 'authors'));
  render();
  window.scrollTo(0, 0);
}

// a book by this author she doesn't have: shaded out, with a + Wishlist button
function missingRowHTML(x, i) {
  return '<div class="crow ext missing" data-miss="' + i + '">' +
    (x.cover ? '<img src="' + esc(x.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<span class="cnocover">📕</span>') +
    '<span class="ctext"><b>' + esc(x.title) + '</b><small>' + esc(x.author || 'Unknown author') + '</small></span>' +
    '<span class="m-chip">Not owned</span>' +
    '<button class="btn small" data-madd="' + i + '">+ Wishlist</button></div>';
}

// Fill the "missing books" section of the author detail (async, after render).
async function fillMissingBooks(name) {
  const box = document.getElementById('a-missing');
  if (!box) return;
  try {
    const rows = (await fetchMoreByAuthor(name)).filter(x => !inLibrary(x));
    if (!rows.length) {
      box.innerHTML = '<p class="note">Nothing missing — you have them all! 🎉</p>';
      return;
    }
    box.innerHTML = '<div class="collection-list">' + rows.map(missingRowHTML).join('') + '</div>';
    box.querySelectorAll('[data-madd]').forEach(btn =>
      btn.addEventListener('click', () => {
        addExternalBook(rows[Number(btn.dataset.madd)]);
        btn.outerHTML = '<span class="c-added">💝 In wishlist</span>';
        toast('Added to wishlist 💝');
      }));
  } catch (e) {
    box.innerHTML = '<p class="note">Couldn\'t look up their other books right now.</p>';
  }
}

function renderAuthorDetail() {
  const name = authorView || '';
  const key = name.trim().toLowerCase();
  const match = b => (b.authors || []).some(a => String(a).trim().toLowerCase() === key);
  const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
  const owned = library.filter(b => match(b) && b.owned).sort(byTitle);
  const wanted = library.filter(b => match(b) && !b.owned).sort(byTitle);
  let html = '<div class="view-head"><button class="btn ghost sm" id="a-back">← Back</button></div>' +
    '<div class="wish-head"><h2 class="serif">✍️ ' + esc(name) + '</h2>' +
    '<p class="note">' + owned.length + ' owned' +
    (wanted.length ? ' · ' + wanted.length + ' on wishlist' : '') + '</p></div>';
  html += '<h3 class="serif sec-h">On your shelves</h3>';
  html += owned.length
    ? '<div class="collection-list">' + owned.map(collectionRowHTML).join('') + '</div>'
    : '<p class="note">None owned yet.</p>';
  if (wanted.length) {
    html += '<h3 class="serif sec-h">On your wishlist</h3>' +
      '<div class="collection-list">' + wanted.map(collectionRowHTML).join('') + '</div>';
  }
  html += '<h3 class="serif sec-h">Missing from your shelves</h3>' +
    '<div id="a-missing"><p class="note">Looking up their other books…</p></div>';
  setView(html);
  document.getElementById('a-back').addEventListener('click', () => go('authors'));
  document.querySelectorAll('#view [data-book]').forEach(el =>
    el.addEventListener('click', () => openDetail(el.dataset.book)));
  fillMissingBooks(name);
}
