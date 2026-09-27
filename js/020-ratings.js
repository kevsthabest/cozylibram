'use strict';

/* ---------------- genre-aware ratings ---------------- */
// Different genres get different rating axes. Spice stays for romance;
// horror gets Scare, thrillers get Suspense, fantasy/sci-fi/LitRPG get Adventure.
const RATING_AXES = [
  { key: 'spice',     emoji: '🌶️', icon: 'pepper', label: 'Spice',     genres: ['romance', 'erotica'] },
  { key: 'scare',     emoji: '👻', icon: 'ghost',  label: 'Scare',     genres: ['horror'] },
  { key: 'suspense',  emoji: '😰', icon: 'shock',  label: 'Suspense',  genres: ['thriller', 'suspense', 'mystery', 'crime'] },
  { key: 'adventure', emoji: '⚔️', icon: 'swords', label: 'Adventure', genres: ['fantasy', 'science fiction', 'litrpg', 'dungeon', 'adventure'] },
];
function axisByKey(k) { return RATING_AXES.find(a => a.key === k) || RATING_AXES[0]; }

// Genres come from the Google Books categories saved on each book,
// e.g. "Fiction / Romance / Contemporary" -> ["Romance", "Contemporary"].
function bookGenres(b) {
  const out = [];
  (b.categories || []).forEach(c => {
    String(c).split('/').map(s => s.trim()).forEach(s => {
      if (!s || /^(fiction|nonfiction|general)$/i.test(s)) return;
      if (!out.includes(s)) out.push(s);
    });
  });
  return out;
}

// Guess which axes fit a book from its genres, tropes and title. Falls back to spice.
function autoDetectAxes(b) {
  const hay = (bookGenres(b).join(' ') + ' ' + (b.tropes || []).join(' ') + ' ' + (b.title || '')).toLowerCase();
  const hit = RATING_AXES.filter(a => a.genres.some(g => hay.includes(g))).map(a => a.key);
  return hit.length ? hit : ['spice'];
}

// Migrate old books (b.spice) to the new { ratings, axes } model.
function migrateBook(b) {
  if (!b.ratings) b.ratings = {};
  if (b.spice) b.ratings.spice = b.spice;
  delete b.spice;
  if (!Array.isArray(b.authors)) b.authors = [];
  if (!Array.isArray(b.tropes)) b.tropes = [];
  if (!Array.isArray(b.tropesAuto)) b.tropesAuto = []; // v81
  if (!Array.isArray(b.axes) || !b.axes.length) b.axes = autoDetectAxes(b);
  if (!Array.isArray(b.contentWarnings)) b.contentWarnings = [];
  if (!Array.isArray(b.moods)) b.moods = [];
  if (b.series === undefined) b.series = null;
  if (!Array.isArray(b.log)) b.log = []; // daily reading log { d, from, to }
  if (!Array.isArray(b.quotes)) b.quotes = []; // v75: saved quotes { t, p, at }
  b.favorite = !!b.favorite; // pinned to the favorites bookshelf
  if (b.owned === undefined) b.owned = true; // owned vs wishlist ("to buy")
  if (b._mtime == null) b._mtime = 0; // last-modified stamp, used for cloud conflict resolution
  return b;
}

// Ownership badge: line-art home vs cart (v84)
function ownedBadge(b) {
  return b.owned
    ? '<span class="badge owned">' + icon('owned') + ' Owned</span>'
    : '<span class="badge tobuy">' + icon('tobuy') + ' To buy</span>';
}

