'use strict';

/* Cozy Libram v1 — mobile-first personal library PWA.
   Storage: localStorage (on-device). Metadata: Google Books API + Open Library covers.
   No backend, no account, works from any static host. */

'use strict';

const LS_KEY = 'spicyshelves.library.v1';
const STATUS = {
  tbr: 'To Be Read',
  reading: 'Currently Reading',
  read: 'Read',
  dnf: 'Did Not Finish'
};

// v559 (Decision): the Wishlist is not a status. A book is on the
// Wishlist exactly when it is TBR and not yet owned — the to-buy part
// of TBR. This helper is the single owner of that derivation; no
// surface equality-checks a wishlist status anymore. The Wishlist
// SHELF persists as a view over this derivation, and the status term
// keeps the history exception: a read/reading/dnf book marked to-buy
// is never a wishlist book. (Re-decides the v529 status model.)
function isWishlistBook(b) {
  return !!b && b.status === 'tbr' && b.owned === 'tobuy';
}

// v563 (Decision): format is a first-class book field, separate from the
// ownership facet — ownership says HOW a copy is held (owned / tobuy /
// borrowed / subscription), format says WHAT the copy is. Binding is
// first-class so paperback -> hardcover is representable; 'physical' is
// the unspecified-print bucket. Unset (absent/'') is meaningful: the app
// never guesses a format, and an unset format renders as nothing extra.
const BOOK_FORMATS = ['hardcover', 'paperback', 'physical', 'ebook', 'audio'];
const FORMAT_META = {
  hardcover: { label: 'Hardcover', ic: 'physical' },
  paperback: { label: 'Paperback', ic: 'physical' },
  physical:  { label: 'Physical',  ic: 'physical' },
  ebook:     { label: 'Ebook',     ic: 'ebook' },
  audio:     { label: 'Audiobook', ic: 'audio' },
};
// Free-text binding/format words (provider + import columns) -> a format
// value, or '' when the text states nothing unambiguous. Shared by the
// scan funnel (js/130) and the import parsers (js/132).
function formatFromBindingText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  if (t.includes('hardcover')) return 'hardcover';
  if (t.includes('paperback')) return 'paperback';
  if (t.includes('kindle') || t.includes('ebook') || t.includes('e-book')) return 'ebook';
  if (t.includes('audio')) return 'audio';
  if (t.includes('board book') || t.includes('library binding') || t.includes('spiral') || t.includes('print')) return 'physical';
  return '';
}

// v563 (Decision): the trophy want — "I want this book in that format
// too." A book is a trophy want when it HAS a format, wants a DIFFERENT
// one, and is not already on the Wishlist proper: the to-buy set wins,
// so a book never renders or counts in both sets. Independent of the
// ownership facet (an owned ebook wanting print is canonical; borrowed
// and subscription records may carry a want too). Status-independent.
function isTrophyWant(b) {
  return !!b && BOOK_FORMATS.includes(b.format) && BOOK_FORMATS.includes(b.wantFormat) &&
    b.wantFormat !== b.format && !isWishlistBook(b);
}

let view = 'library';
let filter = 'all';
let ownFilter = 'all'; // all | owned | tobuy | borrowed | subscription (v148; subscription v563)
let query = '';
let heatSel = null; // selected heatmap day 'YYYY-MM-DD' (v62)
let calY = new Date().getFullYear(); // v63: month calendar restored
let calM = new Date().getMonth();
let calSel = null; // selected calendar day 'YYYY-MM-DD'
let genreGran = 'quarter'; // v69: genre evolution granularity (year|quarter|month)
let layout = 'grid'; // v57: grid view restored (Bookmory-style); default grid
try { layout = localStorage.getItem('spicyshelves.layout') || 'grid'; } catch (e) {}
let sortBy = 'added'; // v404: library sort (added|title|author|rating|progress)
try { sortBy = localStorage.getItem('spicyshelves.sortby') || 'added'; } catch (e) {}
let animateIn = true; // staggered card entrance; disabled while typing in search
let rouletteTimer = null; // slot-machine animation handle
let pickState = { genres: [], trope: '', minIntensity: 0, upNextOnly: false };
let addTab = 'scan';
let editingId = null;
let editingDraft = null; // live draft of the open book modal (for background fills)
let refreshProgressSection = null; // re-render fn for the open modal's progress section
let searchResults = [];
let searchQuery = ''; // v150: last Add → Search query, restored across re-renders
let searchSource = 'all'; // v139: Add → Search source filter (all/gbooks/openlibrary/hardcover)
let scanState = { stream: null, timer: null, active: false, zxing: false, zxingTimer: null,
  panelOpen: false, // v193: scan panel expansion survives re-renders
  resume: false,     // v193: restart the camera after renderAdd() rebuilds the view
  lastCode: null, hits: 0 }; // v193: misread rejection — consensus counters

