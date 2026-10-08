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
// v237: also strips *format* tags ("Audiobook", "Ebook", "Large Print") —
// the metadata sources mix those into the genre lists, and they are not genres.
// v262: Open Library subjects leak library headings into the genre list —
// character headings ("Blomkvist, Mikael (Fictional character)"), OL-specific
// non-genres ("Large type books", "Accessible book"), and overlong headings.
// None of these are genres.
const GENRE_JUNK = /^(fiction|nonfiction|general|audio[ -]?books?|e[ -]?books?|paperback|hardcover|large[ -]?(print|type( books?)?)|accessible book|protected daisy|in library|overdrive|internet archive)$/i;
const GENRE_SUBJECT_JUNK = /\((fictional|fictitious|imaginary|legendary|mythical)\b/i;
/* v353: multilingual genre normalization — map non-English variants to
   canonical English (triage #7: "Fantasia"/"fantástico" → "Fantasy") */
const GENRE_NORM = {
  'fantasia': 'Fantasy', 'fantastique': 'Fantasy', 'fantástico': 'Fantasy', 'fantastica': 'Fantasy',
  'romance': 'Romance', 'romantique': 'Romance', 'romântico': 'Romance',
  'horreur': 'Horror', 'terror': 'Horror',
  'science fiction': 'Science Fiction', 'ficção científica': 'Science Fiction',
  'dragons & mythical creatures': 'Dragons & Mythical Creatures',
  'dragons et créatures mythiques': 'Dragons & Mythical Creatures',
  'dragões e criaturas míticas': 'Dragons & Mythical Creatures',
};
function bookGenres(b) {
  const out = [];
  (b.categories || []).forEach(c => {
    String(c).split('/').map(s => s.trim()).forEach(s => {
      if (!s || s.length > 48 || GENRE_JUNK.test(s) || GENRE_SUBJECT_JUNK.test(s)) return;
      // v353: normalize multilingual dupes
      const norm = GENRE_NORM[s.toLowerCase()] || s;
      if (!out.includes(norm)) out.push(norm);
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

// v211: format junk is not a trope. One canonical set, shared by seedTropes
// (js/061) and the migrateBook strip below — the bug was two stopword sets
// drifting apart ('audiobook' singular slipped through 061's).
const TROPE_FORMAT_JUNK = new Set([
  'audiobook', 'audiobooks', 'ebook', 'ebooks', 'paperback', 'hardcover',
  'textbook', 'textbooks', 'large type',
]);

// Migrate old books (b.spice) to the new { ratings, axes } model.
function migrateBook(b) {
  if (!b.ratings) b.ratings = {};
  if (b.spice) b.ratings.spice = b.spice;
  delete b.spice;
  // v194 (security): books cross a trust boundary here — friend libraries,
  // cloud rows, CSV/Bookmory imports. `id` and `status` are interpolated
  // into HTML attributes and selectors by several renderers, so neutralize
  // them once at this choke point. App-generated ids are [a-z0-9] (uid()),
  // so stripping anything else only ever mangles attacker-controlled values.
  if (typeof b.id !== 'string' || !b.id) b.id = uid();
  else { const clean = b.id.replace(/[^A-Za-z0-9_-]/g, ''); b.id = clean || uid(); }
  if (!Object.prototype.hasOwnProperty.call(STATUS, b.status)) b.status = 'tbr';
  if (!Array.isArray(b.authors)) b.authors = [];
  if (!Array.isArray(b.tropes)) b.tropes = [];
  if (!Array.isArray(b.tropesAuto)) b.tropesAuto = []; // v81
  if (!Array.isArray(b.tropesAI)) b.tropesAI = []; // v212: AI auto-added trope names (✦ badge)
  if (!Array.isArray(b.tropesAIDismissed)) b.tropesAIDismissed = []; // v212: dismissed AI trope ids
  // v211: strip format junk ('audiobook' etc.) that older stopword sets let
  // seedTropes plant in b.tropes. _mtime bumps only when something was
  // actually removed, so the cleaned book wins the cloud merge and pushes once.
  let _junkRemoved = false;
  const _stripJunk = arr => arr.filter(t => {
    const bad = TROPE_FORMAT_JUNK.has(String(t).toLowerCase().trim());
    if (bad) _junkRemoved = true;
    return !bad;
  });
  b.tropes = _stripJunk(b.tropes);
  b.tropesAuto = _stripJunk(b.tropesAuto);
  if (_junkRemoved) b._mtime = Date.now();
  if (!Array.isArray(b.axes) || !b.axes.length) b.axes = autoDetectAxes(b);
  if (!Array.isArray(b.contentWarnings)) b.contentWarnings = [];
  if (!Array.isArray(b.moods)) b.moods = [];
  if (b.series === undefined) b.series = null;
  if (!Array.isArray(b.log)) b.log = []; // daily reading log { d, from, to }
  if (!Array.isArray(b.quotes)) b.quotes = []; // v75: saved quotes { t, p, at }
  b.favorite = !!b.favorite; // pinned to the favorites bookshelf
  if (b.owned === undefined || b.owned === true) b.owned = 'owned'; // v148: ownership is now
  else if (b.owned === false) b.owned = 'tobuy'; // 'owned' | 'tobuy' | 'borrowed' (legacy booleans migrate)
  if (b._mtime == null) b._mtime = 0; // last-modified stamp, used for cloud conflict resolution
  return b;
}

// Ownership badge: line-art home vs cart vs lent-out book (v84, v148)
function ownedBadge(b) {
  if (b.owned === 'tobuy') return '<span class="badge tobuy">' + icon('tobuy') + ' To buy</span>';
  if (b.owned === 'borrowed') return '<span class="badge borrowed">' + icon('borrowed') + ' Borrowed</span>';
  return '<span class="badge owned">' + icon('owned') + ' Owned</span>';
}

