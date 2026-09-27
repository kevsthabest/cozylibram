// v81: automatic trope suggestions from two sources — an offline keyword scan
// of the book's blurb, and community tags from Hardcover. Suggestions land in
// book.tropesAuto and are shown as tappable chips in the book editor; they
// never overwrite book.tropes (her hand-picked list). The source is chosen in
// Settings → Hardcover → "Trope suggestions".

const TROPE_SRC_KEY = 'spicyshelves.tropesrc';
const TROPE_SOURCES = ['off', 'keywords', 'hardcover', 'both'];
const TROPE_SRC_LABELS = { off: 'Off', keywords: 'Keywords', hardcover: 'Hardcover', both: 'Both' };

function tropeSource() {
  try { const v = localStorage.getItem(TROPE_SRC_KEY); return TROPE_SOURCES.includes(v) ? v : 'both'; }
  catch (e) { return 'both'; }
}
function setTropeSource(v) {
  if (!TROPE_SOURCES.includes(v)) return;
  try { localStorage.setItem(TROPE_SRC_KEY, v); } catch (e) {}
}
function tropeSourceKey() { return tropeSource(); } // alias used by the editor

// Curated trope dictionary: [canonical label, match pattern]. Scanned against
// the book's description + title. Dark-romance leaning, but general enough for
// the rest of the shelf. Keep labels short — they become filter chips.
const TROPE_PATTERNS = [
  ['enemies to lovers', /enemies?\s+to\s+lovers/i],
  ['forced proximity', /forced proximity/i],
  ['mafia romance', /\bmafia\b|mobster|organized crime|\bcartel\b/i],
  ['bully romance', /\bbull(y|ies|ied)\b/i],
  ['reverse harem', /reverse[-\s]?harem/i],
  ['why choose', /why[-\s]?choose/i],
  ['stalker', /\bstalk(ers?|ing)\b/i],
  ['kidnapping', /\bkidnap/i],
  ['arranged marriage', /arranged marriage/i],
  ['marriage of convenience', /marriage of convenience/i],
  ['age gap', /age[-\s]?gap/i],
  ['forbidden romance', /\bforbidden\b/i],
  ['second chance', /second chance/i],
  ['secret baby', /secret baby/i],
  ['grumpy sunshine', /\bgrumpy\b/i],
  ['billionaire', /\bbillionaire\b/i],
  ['biker', /\bbiker\b|motorcycle club/i],
  ['vampire', /\bvampire\b/i],
  ['werewolf', /werewol(f|ves)/i],
  ['shifter', /\bshifter\b/i],
  ['fated mates', /fated mates/i],
  ['dark academia', /dark academia/i],
  ['academy', /\bacademy\b/i],
  ['revenge', /\brevenge\b/i],
  ['captive', /\bcaptive\b/i],
  ['bodyguard', /\bbodyguard\b/i],
  ['single dad', /single (dad|father)/i],
  ['fake dating', /fake dat/i],
  ['workplace romance', /workplace|office romance/i],
  ['amnesia', /\bamnesia\b/i],
  ['secret society', /secret society/i],
  ['stepbrother', /step[-\s]?brother/i],
  ['royalty', /\b(prince|princess|duke|king)\b/i],
  ['pregnancy', /pregnan/i],
];

function scanTropesFromText(text) {
  const out = [];
  const t = String(text || '');
  if (!t) return out;
  for (const [label, re] of TROPE_PATTERNS) {
    if (out.length >= 8) break;
    try { if (re.test(t) && !out.includes(label)) out.push(label); } catch (e) {}
  }
  return out;
}

// Genre-ish and junk tags are not tropes — filter them out of Hardcover's
// community tags before suggesting.
const TAG_STOPWORDS = new Set([
  'general', 'fiction', 'nonfiction', 'contemporary', 'adult', 'new adult',
  'young adult', 'ya', 'romance', 'dark romance', 'contemporary romance',
  'paranormal romance', 'erotica', 'fantasy', 'paranormal', 'sci-fi', 'science fiction',
  'horror', 'mystery', 'thriller', 'large type', 'audiobooks', 'audiobook',
  'textbook', 'textbooks', 'ebook', 'ebooks', 'paperback', 'hardcover',
]);
function cleanTag(t) {
  t = String(t == null ? '' : t).toLowerCase().replace(/^#+/, '').trim();
  if (!t || t.length < 2 || t.length > 30) return null;
  if (TAG_STOPWORDS.has(t)) return null;
  if (/^\d+$/.test(t)) return null;
  return t;
}
function normalizeCachedTags(ct) {
  if (!ct) return [];
  if (Array.isArray(ct)) return ct.map(x => (x && typeof x === 'object') ? (x.tag || x.name || '') : x);
  if (typeof ct === 'object') return Object.keys(ct);
  return [];
}

// Pull community tags for a book from Hardcover. Tries the tags stashed from
// the search document first (free), then the books table's cached_tags via the
// book's Hardcover id (one extra request, best-effort). Never throws.
async function fetchHardcoverTags(book) {
  const out = [];
  const push = t => { const c = cleanTag(t); if (c && !out.includes(c)) out.push(c); };
  // Tags stashed from the search document are free — no token needed.
  try {
    if (Array.isArray(book._hcDocTags)) book._hcDocTags.forEach(push);
  } catch (e) {}
  try { delete book._hcDocTags; } catch (e) {}
  // Community tags via the books table need the token (one extra request).
  try {
    if (book.hcId && typeof hcToken === 'function' && hcToken() && typeof hcGraphQL === 'function') {
      const data = await hcGraphQL('query { books(where: {id: {_eq: ' + Number(book.hcId) + '}}) { cached_tags } }');
      const ct = data && data.books && data.books[0] && data.books[0].cached_tags;
      normalizeCachedTags(ct).forEach(push);
      book._hcTagsFetched = true; // tells the enricher to pace the extra request
    }
  } catch (e) { /* tags are best-effort; a 429 or schema change just yields fewer */ }
  return out.slice(0, 8);
}

// Recompute a book's suggested tropes from the active source. Never touches
// book.tropes. Never throws.
async function refreshTropeSuggestions(book) {
  if (!book) return [];
  const src = tropeSource();
  if (src === 'off') { book.tropesAuto = []; book.tropeSrc = 'off'; return []; }
  const found = [];
  const add = t => { const c = cleanTag(t); if (c && !found.includes(c)) found.push(c); };
  if (src === 'keywords' || src === 'both') {
    scanTropesFromText((book.description || '') + '\n' + (book.title || '')).forEach(add);
  }
  if ((src === 'hardcover' || src === 'both')) {
    (await fetchHardcoverTags(book)).forEach(add);
  }
  book.tropesAuto = found.slice(0, 8);
  book.tropeSrc = src;
  return book.tropesAuto;
}
