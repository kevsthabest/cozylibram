'use strict';

/* ---------------- genre-aware ratings ---------------- */
// v132: 11 axes. Fiction: spice/darkness/feels/humor/scare/suspense/
// adventure. Nonfiction (Kevin's shelves): insight/readability/depth/
// practical. Only axes matching the book's genres/tropes/title are shown;
// everything else stays behind the + chips.
const RATING_AXES = [
  { key: 'spice', icon: 'pepper', label: 'Spice', color: '#ff5d6d',
    genres: ['romance', 'erotica'],
    levels: ['Sweet', 'Teasing', 'Steamy', 'Explicit', 'Filthy'] },
  { key: 'darkness', icon: 'moon', label: 'Darkness', color: '#8b5cf6',
    genres: ['gothic', 'grimdark'],
    tropes: ['dark romance', 'morally grey', 'mafia', 'bully', 'dub-con', 'kidnapping', 'stalker'],
    levels: ['Light', 'Edgy', 'Dark themes', 'Very dark', 'Pitch black'] },
  { key: 'feels', icon: 'heart', label: 'Feels', color: '#ff8fb3',
    genres: ['romance', 'drama'],
    tropes: ['tearjerker', 'tragedy', 'second chance', 'grief'],
    levels: ['Unmoved', 'Twinge', 'Teary', 'Cried', 'Sobbed'] },
  { key: 'humor', icon: 'smile', label: 'Humor', color: '#7bc98a',
    genres: ['humor', 'humour', 'comedy', 'comic'],
    tropes: ['witty banter', 'romcom', 'romantic comedy'],
    levels: ['Serious', 'Wry smiles', 'Funny', 'Laugh-out-loud', 'Cackling'] },
  { key: 'scare', icon: 'ghost', label: 'Scare', color: '#9b7ede',
    genres: ['horror'],
    levels: ['Spooky vibes', 'Creepy', 'Disturbing', 'Terrifying', 'Lights on'] },
  { key: 'suspense', icon: 'shock', label: 'Suspense', color: '#5aa9ff',
    genres: ['thriller', 'suspense', 'mystery', 'crime'],
    levels: ['Mild tension', 'Page-turner', 'Gripping', 'Heart-pounding', "Couldn't breathe"] },
  { key: 'adventure', icon: 'swords', label: 'Adventure', color: '#d4a24e',
    genres: ['fantasy', 'science fiction', 'litrpg', 'dungeon', 'adventure'],
    levels: ['Light quest', 'Fun romp', 'Epic', 'Sweeping', 'Legendary'] },
  { key: 'insight', icon: 'bulb', label: 'Insight', color: '#4dd0e1',
    genres: ['history', 'political', 'politics', 'science', 'technology', 'computers', 'biography', 'memoir', 'philosophy'],
    levels: ['Nothing new', 'A few nuggets', 'Learned a lot', 'Eye-opening', 'Changed how I think'] },
  { key: 'readability', icon: 'eye', label: 'Readability', color: '#ffd166',
    genres: ['history', 'political', 'politics', 'science', 'technology', 'biography', 'memoir'],
    levels: ['Textbook-dry', 'Slow going', 'Steady', 'Hard to put down', "Couldn't stop"] },
  { key: 'depth', icon: 'layers', label: 'Depth', color: '#b08968',
    genres: ['history', 'academic', 'philosophy', 'political science'],
    levels: ['Pop overview', 'Casual', 'Solid', 'Thorough', 'Scholarly'] },
  { key: 'practical', icon: 'gear', label: 'Practical', color: '#8d99ae',
    genres: ['technology', 'computers', 'self-help', 'how-to', 'cooking', 'crafts'],
    tropes: ['motorcycle', 'automotive', 'repair', 'diy'],
    levels: ['Theory only', 'Some tips', 'Useful', 'Very handy', 'Essential reference'] },
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
// v132: per-axis trope keywords also match (e.g. "dark romance" trope -> Darkness).
function autoDetectAxes(b) {
  const hay = (bookGenres(b).join(' ') + ' ' + (b.tropes || []).join(' ') + ' ' + (b.title || '')).toLowerCase();
  const hit = RATING_AXES.filter(a =>
    a.genres.some(g => hay.includes(g)) || (a.tropes || []).some(t => hay.includes(t))
  ).map(a => a.key);
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

