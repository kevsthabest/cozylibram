'use strict';

/* ---------------- new-release discovery (v114, reworked v135) ---------------- */
// "Check for new releases": for each of her top authors, queries Hardcover's
// books table directly for future-dated books by that author (ordered by
// release date), and offers them as one-tap adds into the Wishlist's Coming
// soon section. Dismissed suggestions never come back.
//
// v135 rework: the original swept each author's 10 most *relevant* books via
// the Typesense search endpoint — for an established author that's the
// popular backlist, so upcoming titles almost never appeared and the check
// usually found nothing. The books-table query below asks for future
// release dates explicitly. Query shape verified against Hardcover's public
// GraphQL docs (books → contributions → author → name, release_date filter,
// order_by release_date).

const REL_DISMISS_KEY = 'spicyshelves.dismissed_releases';

function dismissedReleases() {
  try { return new Set(JSON.parse(localStorage.getItem(REL_DISMISS_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function dismissRelease(hcId) {
  try {
    const arr = JSON.parse(localStorage.getItem(REL_DISMISS_KEY) || '[]');
    arr.push('hc:' + hcId);
    localStorage.setItem(REL_DISMISS_KEY, JSON.stringify(arr.slice(-200)));
  } catch (e) {}
}
function isReleaseDismissed(hcId) { return dismissedReleases().has('hc:' + hcId); }

// Authors ranked by shelf count, then by her average rating of them.
// v176: every unique nonblank author in the library, ranked by shelf count
// then average rating so her favorites scan first. No truncation — the
// release sweep covers the whole library, not just the top 8.
function topReleaseAuthors() {
  const map = {};
  library.forEach(b => {
    (b.authors || []).forEach(a => {
      const k = String(a || '').trim();
      if (!k) return;
      const e = map[k] || (map[k] = { name: k, n: 0, stars: 0, sn: 0 });
      e.n++;
      if (b.myRating > 0) { e.stars += b.myRating; e.sn++; }
    });
  });
  return Object.values(map)
    .sort((x, y) => (y.n - x.n) || ((y.sn ? y.stars / y.sn : 0) - (x.sn ? x.stars / x.sn : 0)))
    .map(e => e.name);
}

// Already on her shelves? Matches by ISBN first, then title + first author.
function releaseInLibrary(c) {
  const isbns = (c.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  if (isbns.length && library.some(b => b.isbn && isbns.indexOf(b.isbn) !== -1)) return true;
  const t = String(c.title || '').toLowerCase().trim();
  const a = String((c.authors || [])[0] || '').toLowerCase().trim();
  if (!t) return false;
  return library.some(b => String(b.title || '').toLowerCase().trim() === t &&
    String((b.authors || [])[0] || '').toLowerCase().trim() === a);
}

function hcBookToCandidate(b) {
  const names = (b.contributions || []).map(x => String((((x || {}).author) || {}).name || '')).filter(Boolean);
  const ed = b.default_physical_edition || {};
  return {
    hcId: b.id,
    title: b.title || 'Untitled',
    authors: names.slice(0, 3),
    releaseDate: String(b.release_date || '').slice(0, 10),
    cover: (b.image && b.image.url) || '',
    description: b.description || '',
    pages: b.pages || null,
    isbns: ed.isbn_13 ? [String(ed.isbn_13)] : []
  };
}

async function checkNewReleases(onTick, onFound) {
  const authors = topReleaseAuthors();
  const out = [];
  const seen = new Set();
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  let failed = 0;
  for (let i = 0; i < authors.length; i++) {
    const a = authors[i];
    if (onTick) onTick(a, i + 1, authors.length);
    try {
      const q = 'query { books(where: {contributions: {author: {name: {_eq: ' + JSON.stringify(a) + '}}},' +
        ' release_date: {_gt: "' + today + '"}, canonical_id: {_is_null: true}},' +
        ' order_by: {release_date: asc}, limit: 10)' +
        ' { id title description release_date pages image { url }' +
        ' contributions { author { name } } default_physical_edition { isbn_13 } } }';
      const data = await hcGraphQL(q);
      ((data || {}).books || []).forEach(b => {
        if (b.id == null || seen.has(b.id) || isReleaseDismissed(b.id)) return;
        const c = hcBookToCandidate(b);
        if (!c.releaseDate || c.releaseDate <= today) return; // defensive: the server filters too
        seen.add(b.id);
        if (releaseInLibrary(c)) return;
        out.push(c);
        if (onFound) onFound(c); // v176: stream each find as it's detected
      });
    } catch (e) { failed++; /* one author failing never kills the sweep */ }
    await new Promise(r => setTimeout(r, 700)); // share the Hardcover pacing
  }
  out.sort((x, y) => x.releaseDate.localeCompare(y.releaseDate));
  return { list: out, failed: failed, total: authors.length };
}

function addReleaseBook(c) {
  const clean = (c.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  const book = {
    id: uid(),
    isbn: clean.find(i => i.length === 13) || clean[0] || '',
    title: c.title, authors: c.authors, cover: c.cover, description: c.description,
    pageCount: c.pages, publishedDate: '', releaseDate: c.releaseDate,
    categories: [], publicRating: null, ratingsCount: 0,
    status: 'tbr', owned: 'tobuy', ratings: {}, myRating: 0,
    tropes: [], tropesAuto: [], progress: 0,
    dateAdded: new Date().toISOString(), dateFinished: null, notes: '',
    hcId: c.hcId, hcEnriched: true // already holds this Hardcover doc's data
  };
  book.axes = autoDetectAxes(book);
  return addBook(book, false, 'discovery');
}

function releaseResultsHTML(list) {
  if (!list.length) {
    return '<p class="note">No new releases found — you\'re all caught up ✨</p>';
  }
  return '<h3 class="wish-section">' + icon('sparkles') + ' New from your authors</h3>' +
    '<div class="grid">' + list.map((c, i) =>
      '<div class="book-card rel-card" data-i="' + i + '">' + coverHTML(c) +
      '<div class="book-meta"><h3>' + esc(c.title) + '</h3>' +
      '<p class="author">' + esc(displayAuthors(c.authors)) + '</p>' +
      '<div class="up-pill">' + icon('calendar') + ' ' + esc(fmtDate(c.releaseDate)) + ' · ' + releaseCountdown(c.releaseDate) + '</div>' +
      '</div><div style="align-self:center;display:flex;gap:6px">' +
      '<button class="btn small" data-add="' + i + '">＋ Add</button>' +
      '<button class="btn ghost small" data-dis="' + i + '" aria-label="Dismiss">✕</button></div></div>'
    ).join('') + '</div>';
}

function wireReleaseResults(box, list) {
  box.querySelectorAll('.rel-card').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('[data-add]') || e.target.closest('[data-dis]')) return;
    const c = list[Number(card.dataset.i)];
    if (c) openReleasePreview(c);
  }));
  box.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const c = list[Number(btn.dataset.add)];
    if (addReleaseBook(c)) {
      btn.closest('.rel-card').style.opacity = '0.4';
      btn.textContent = '✓ Added';
      btn.disabled = true;
    }
  }));
  box.querySelectorAll('[data-dis]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    dismissRelease(list[Number(btn.dataset.dis)].hcId);
    btn.closest('.rel-card').remove();
    if (!box.querySelector('.rel-card')) box.innerHTML = '<p class="note">All caught up ✨</p>';
  }));
}

function renderReleaseResults(list) {
  const box = document.getElementById('release-results');
  if (!box) return;
  box.innerHTML = releaseResultsHTML(list);
  wireReleaseResults(box, list);
}

// Shared wiring: the Wishlist's "Check for new releases" button and (v175)
// Discover's New Releases tile. The tile shows progress inline in
// #release-results; the Wishlist button keeps its old label-swap behavior.
function wireReleaseCheck() {
  const btn = document.querySelector('[data-dtile="releases"]') || document.getElementById('rel-check');
  if (!btn) return;
  const isTile = btn.hasAttribute('data-dtile');
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (!hcReady()) { toast('Connect Hardcover in Settings → Hardcover first'); return; }
    track('release_discovery_opened');
    btn.disabled = true;
    const box = document.getElementById('release-results');
    const label = isTile ? '' : btn.innerHTML;
    if (isTile && box && box.scrollIntoView)
      box.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    // v176: accumulate finds and repaint after each one, so the results
    // list grows live while the sweep is still running.
    const found = [];
    visibleReleases = found; // v150: survive re-renders while adding
    let done = false, prog = '';
    const byDate = (x, y) => x.releaseDate.localeCompare(y.releaseDate);
    const cleanList = () => found.slice().sort(byDate)
      .filter(x => x && !isReleaseDismissed(x.hcId) && !releaseInLibrary(x));
    const paint = () => {
      if (!box) return;
      const list = cleanList();
      box.innerHTML = (prog ? '<p class="note">' + prog + '</p>' : '') +
        (list.length ? releaseResultsHTML(list) : (done ? releaseResultsHTML([]) : ''));
      wireReleaseResults(box, list);
    };
    try {
      const res = await checkNewReleases(
        (a, i, n) => {
          prog = icon('hourglass') + ' Checking ' + esc(a) + '… (' + i + '/' + n + ')';
          if (!isTile) btn.innerHTML = prog;
          paint();
        },
        (c) => { found.push(c); paint(); }
      );
      done = true; prog = '';
      // Reconcile with the returned list (covers any find onFound missed).
      res.list.forEach(c => {
        if (c && !found.some(f => f.hcId === c.hcId)) found.push(c);
      });
      found.sort(byDate);
      // v135: if every author's lookup failed, say so — "all caught up"
      // would be a lie when we never actually reached Hardcover.
      if (!found.length && res.total > 0 && res.failed >= res.total) {
        if (box) box.innerHTML = '<p class="note">Couldn\'t reach Hardcover for any author — ' +
          'check the connection in Settings → Hardcover, then try again.</p>';
      } else {
        paint();
        saveAutoReleases(found); // v149: manual checks refresh the auto cache
        markReleasesSeen();
      }
    } catch (e) {
      if (box) box.innerHTML = '<p class="note">The check failed — try again in a bit.</p>';
    } finally {
      btn.disabled = false;
      if (!isTile) btn.innerHTML = label;
    }
  });
}

/* ---------------- auto new-release checks (v149) ---------------- */
// The manual "Check for new releases" sweep now also runs by itself: once a
// week, silently, on app entry (same pattern as the Hardcover auto-enrich
// sweep). Fresh finds raise a count badge on the Discover tab; opening
// Discover (or the Wishlist) renders them inline and clears the badge.
const AUTO_REL_KEY = 'spicyshelves.auto_releases';          // { at, list }
const AUTO_REL_SEEN_KEY = 'spicyshelves.auto_releases_seen'; // ms epoch
const AUTO_REL_DAYS = 7;

function autoReleases() {
  try {
    const c = JSON.parse(localStorage.getItem(AUTO_REL_KEY) || 'null');
    if (c && typeof c.at === 'number' && Array.isArray(c.list)) return c;
  } catch (e) {}
  return null;
}
function saveAutoReleases(list) {
  try {
    localStorage.setItem(AUTO_REL_KEY,
      JSON.stringify({ at: Date.now(), list: (list || []).slice(0, 40) }));
  } catch (e) {}
}
function autoReleasesSeenAt() {
  try { return Number(localStorage.getItem(AUTO_REL_SEEN_KEY) || 0) || 0; }
  catch (e) { return 0; }
}
// Unseen finds, minus anything dismissed or shelved since the sweep.
function unseenReleaseList() {
  const c = autoReleases();
  if (!c || !c.list.length || c.at <= autoReleasesSeenAt()) return [];
  return c.list.filter(x => x && !isReleaseDismissed(x.hcId) && !releaseInLibrary(x));
}
function updateReleaseBadge() {
  const n = unseenReleaseList().length;
  const el = document.getElementById('nav-rel-badge');
  if (el) {
    el.textContent = n > 9 ? '9+' : String(n);
    el.style.display = n > 0 ? '' : 'none';
  }
  const btn = document.querySelector('.bottom-nav button[data-nav="discover"]');
  if (btn) btn.setAttribute('aria-label', n > 0 ? 'Discover, ' + n + ' new releases' : 'Discover');
}
function markReleasesSeen() {
  try { localStorage.setItem(AUTO_REL_SEEN_KEY, String(Date.now())); } catch (e) {}
  updateReleaseBadge();
}
// Renders cached auto-check finds into the current view's #release-results
// box (Discover and Wishlist both have one). Returns true when shown.
function renderUnseenReleases() {
  const list = unseenReleaseList();
  if (!list.length) return false;
  const box = document.getElementById('release-results');
  if (!box) return false;
  visibleReleases = list; // v150: remember what's on screen across re-renders
  renderReleaseResults(list);
  markReleasesSeen();
  return true;
}
// v150: the release list currently on screen, whatever its origin (auto
// cache or manual check). Re-rendered — minus added/dismissed/shelved —
// whenever the view re-renders, so adding one book never wipes the rest.
let visibleReleases = [];
function renderVisibleReleases() {
  if (!renderUnseenReleases() && visibleReleases.length) {
    const list = visibleReleases.filter(x => x && !isReleaseDismissed(x.hcId) && !releaseInLibrary(x));
    const box = document.getElementById('release-results');
    if (box && list.length) renderReleaseResults(list);
  }
}
// Silent weekly sweep. Skips when Hardcover isn't configured or the library
// is empty; a fully-failed sweep stamps nothing so it retries next boot.
async function maybeAutoReleaseCheck() {
  try {
    updateReleaseBadge();
    if (!hcReady() || !library.length) return;
    const c = autoReleases();
    if (c && Date.now() - c.at < AUTO_REL_DAYS * 864e5) return;
    const res = await checkNewReleases(); // no onTick: no progress UI
    if (res.total > 0 && res.failed >= res.total) return;
    saveAutoReleases(res.list);
    updateReleaseBadge();
    // v150: if she's looking at the release list right now, show the finds
    // immediately instead of waiting for the next navigation.
    if (document.getElementById('release-results')) renderVisibleReleases();
    track('release_auto_check', { book_count: res.list.length });
  } catch (e) {}
}

/* ---------------- Discover landing (v121, restyled v175) ----------------
   "What are you in the mood for?" per the UI mockup: a featured Surprise Me
   card, five tiles (My Favorites / Similar Books / Authors / New Releases /
   Recommended), a Search-the-Library-&-Beyond row, and a From-Your-Coven section. Every
   tile routes to a real feature; the release check runs inline under the
   New Releases tile. */
function discTile(ic, title, blurb, target) {
  return '<button class="disc-tile" data-dtile="' + target + '">' +
    '<span class="disc-ic">' + icon(ic) + '</span>' +
    '<b>' + esc(title) + '</b><small>' + esc(blurb) + '</small></button>';
}

// v175: "Similar Books — like this one": pick a seed from her highest-rated
// books and favorites; tapping one opens its detail sheet, whose Discovery
// section already lists similar books from her shelves.
// v224 (UX-06): the section carries a proper label now, not just the prompt.
function similarSeedHTML() {
  const head = '<h3 class="wish-section">' + icon('covers') + ' Similar Books</h3>';
  const seeds = library.filter(b => b.favorite || (b.myRating || 0) >= 4)
    .sort((a, b) => ((b.myRating || 0) - (a.myRating || 0)) || ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)))
    .slice(0, 6);
  if (!seeds.length)
    return head + '<p class="note">Rate a few books 4\u2605 or tap the \u2661 on a favorite — your top books will show up here as starting points.</p>';
  return head + '<p class="note">Like which one?</p><div class="sim-seeds">' + seeds.map(b =>
    '<button class="sim-seed" data-seed="' + esc(b.id) + '" aria-label="Find books like ' + esc(b.title) + '">' +
    (b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy">'
             : '<span class="sim-nocover">' + icon('covers') + '</span>') +
    '<small>' + esc(b.title) + '</small></button>').join('') + '</div>';
}

// v175: "From Your Coven" chips deep-link into the Coven tab's sections.
// Coven renders async, so poll briefly for the target instead of assuming
// it is already in the DOM.
function covenJump(sel) {
  go('coven');
  const t0 = Date.now();
  const iv = setInterval(() => {
    const el = document.querySelector(sel);
    if (el) {
      clearInterval(iv);
      if (el.scrollIntoView) el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } else if (Date.now() - t0 > 6000) clearInterval(iv);
  }, 150);
}

function renderDiscover() {
  track('discover_opened', null, { dedupeKey: 'discover-open', dedupeMs: 8000 });
  setView(
    '<div class="disc-hero"><span class="disc-moon" aria-hidden="true"></span>' +
    '<span class="disc-hero-ic">' + icon('sparkles') + '</span>' +
    '<h2 class="serif">What are you in the mood for?</h2>' +
    '<p>Find your next favorite book, or let us surprise you.</p></div>' +

    '<button class="disc-surprise" data-dtile="pick">' +
    '<span class="disc-ic">' + icon('dice') + '</span>' +
    '<span class="disc-tx"><b>Surprise Me</b><small>Pick something from your TBR</small></span>' +
    '<span class="disc-go" aria-hidden="true">→</span></button>' +

    '<div class="disc-tiles">' +
    discTile('heart', 'My Favorites', 'Books you\u2019ve loved', 'favorites') +
    discTile('covers', 'Similar Books', 'Like this one', 'similar') +
    discTile('user', 'Authors', 'Your favorite authors', 'authors') +
    discTile('calendar', 'New Releases', 'Fresh picks', 'releases') +
    discTile('crystal', 'Recommended', 'Picked for your taste', 'recommended') +
    '</div>' +

    '<div id="disc-sim" hidden></div>' +
    '<div id="disc-reco" hidden></div>' +

    '<button class="disc-search" data-dtile="search">' +
    '<span class="disc-ic">' + icon('search') + '</span>' +
    '<span class="disc-tx"><b>Search the Library &amp; Beyond</b>' +
    '<small>Search across your library and external sources</small></span>' +
    '<span class="disc-go" aria-hidden="true">→</span></button>' +

    '<div class="disc-coven"><div class="disc-coven-head"><h3 class="serif">' + icon('friends') + ' From Your Coven</h3>' +
    '<button class="taplink" id="disc-coven-all">View All →</button></div>' +
    '<div class="chips">' +
    '<button class="chip" data-cj="#reco-slot">Recommendations</button>' +
    '<button class="chip" data-cj="#cc-friends">Shared Shelves</button>' +
    '<button class="chip" data-cj="#stats-slot">Friend Activity</button>' +
    '</div></div>' +

    '<div class="disc-releases"><div id="release-results"></div></div>');
  wireReleaseCheck();
  renderVisibleReleases(); // v150: restore the release list across re-renders

  document.querySelectorAll('[data-dtile]').forEach(el => el.addEventListener('click', () => {
    const t = el.dataset.dtile;
    if (t === 'pick') go('pick');
    else if (t === 'authors') go('authors');
    else if (t === 'search') { addTab = 'search'; go('add'); }
    else if (t === 'favorites') { // v173 home-tile behavior: the shelf lives on Library home
      filter = 'all'; ownFilter = 'all'; query = '';
      go('library');
      const f = document.querySelector('.fav-shelf');
      if (f && f.scrollIntoView) f.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
    else if (t === 'similar') {
      const p = document.getElementById('disc-sim');
      p.hidden = !p.hidden;
      if (!p.hidden) {
        p.innerHTML = similarSeedHTML();
        p.querySelectorAll('[data-seed]').forEach(s =>
          s.addEventListener('click', () => openDetail(s.dataset.seed)));
      }
    }
    else if (t === 'recommended') {
      const p = document.getElementById('disc-reco');
      p.hidden = !p.hidden;
      if (!p.hidden && !p.dataset.loaded) { p.dataset.loaded = '1'; refreshRecommendations(); }
    }
    // 'releases' is owned by wireReleaseCheck (shared with the Wishlist button).
  }));
  document.getElementById('disc-coven-all').addEventListener('click', () => go('coven'));
  document.querySelectorAll('[data-cj]').forEach(c =>
    c.addEventListener('click', () => covenJump(c.dataset.cj)));
}

/* ---------------- Recommended for you (v213, diversity v214) ----------------
   Embeddings-based recommendations. A taste profile is built from the
   1024-dim bge-m3 embeddings stored on works (v213 migration): the
   weighted mean of her read books' and favorites' vectors (v214: favorites
   anchor the profile at weight 1.0 so a thin rating history still works).
   Candidates are fresh books by her most-loved authors (4★+ reads) via the
   Hardcover books table; their embed texts go through /api/embed and rank
   by cosine similarity to the profile in JS, then v214 re-ranks with
   Maximal Marginal Relevance (λ=0.7) plus a max-3-per-author cap so one
   prolific author can't sweep the whole list.

   Graceful degradation: with no work embeddings yet (backfill pending) or
   when the embed proxy is unreachable, candidates still show, ranked by
   loved-author order (still capped per author), with a "warming up" note.
   Dismissals persist in the IDB kv store ('reco_dismissed'), localStorage
   fallback. */

// Pure: embed text for one book. Shared with scripts/backfill-embeddings.js
// (loaded via vm), so the client and the backfill can never drift.
function buildEmbedText(b) {
  b = b || {};
  const parts = [];
  const title = String(b.title || '').trim();
  if (title) {
    const authors = [].concat(b.authors || []).map(a => String(a || '').trim()).filter(Boolean);
    parts.push(authors.length ? title + ' \u2014 ' + authors.join(', ') : title);
  }
  const desc = String(b.description || '').replace(/\s+/g, ' ').trim();
  if (desc) parts.push(desc.slice(0, 2000));
  const tropes = [].concat(b.tropes || []).map(t => String(t || '').trim()).filter(Boolean);
  if (tropes.length) parts.push('Tropes: ' + tropes.join(', '));
  const genres = [].concat(b.genres || b.categories || []).map(g => String(g || '').trim()).filter(Boolean);
  if (genres.length) parts.push('Genres: ' + genres.join(', '));
  return parts.join('. ').slice(0, 4000);
}

// Pure: cosine similarity in [-1, 1]; 0 on any malformed input.
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Pure: profile weight for one book. Favorites anchor the profile (1.0, or
// max(rating/5, 0.9) when also rated); rated reads use rating/5; unrated
// reads count neutrally at 0.6.
function recoItemWeight(it) {
  const r = (it && it.rating) || 0;
  if (it && it.favorite) return it.rating ? Math.max(r / 5, 0.9) : 1.0;
  return (r || 3) / 5;
}

// Pure: rating-weighted mean of embedding vectors. items: [{vector, rating,
// favorite}]; weight comes from recoItemWeight. Vectors with a different
// dimensionality than the first valid one are dropped.
function tasteProfileVector(items) {
  const valid = (items || []).filter(it => it && Array.isArray(it.vector) && it.vector.length &&
    it.vector.every(n => typeof n === 'number' && Number.isFinite(n)));
  if (!valid.length) return null;
  const dims = valid[0].vector.length;
  const same = valid.filter(it => it.vector.length === dims);
  if (!same.length) return null;
  const acc = new Array(dims).fill(0);
  let wsum = 0;
  for (const it of same) {
    const w = recoItemWeight(it);
    if (w <= 0) continue;
    wsum += w;
    for (let i = 0; i < dims; i++) acc[i] += it.vector[i] * w;
  }
  if (wsum <= 0) return null;
  return acc.map(v => v / wsum);
}

const RECO_FINAL_COUNT = 12; // cards shown
const RECO_AUTHOR_CAP = 3;   // max books per author in the final list
const RECO_MMR_LAMBDA = 0.7; // similarity vs. diversity trade-off

// Pure: diversity re-ranking over pre-sorted [{c, sim, vector?}] (sim may be
// null on the non-embedded fallback path). Iteratively picks the candidate
// maximizing λ·sim − (1−λ)·maxSimToPicked (candidate similarity via cosine
// of their embeddings), skipping candidates whose primary author already hit
// RECO_AUTHOR_CAP. Returns up to `limit` items.
function mmrDiversify(ranked, limit) {
  const cap = RECO_AUTHOR_CAP, lambda = RECO_MMR_LAMBDA;
  const key = c => String((c && c.authors && c.authors[0]) || (c && c.loveAuthor) || '').trim().toLowerCase();
  const remaining = (ranked || []).slice();
  const picked = [], authorCount = {};
  const n = limit || RECO_FINAL_COUNT;
  while (picked.length < n && remaining.length) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      if ((authorCount[key(r.c)] || 0) >= cap) continue;
      const sim = (r.sim == null ? 0 : r.sim);
      let red = 0;
      if (r.vector) {
        for (const p of picked) {
          if (!p.vector) continue;
          const s = cosineSim(r.vector, p.vector);
          if (s > red) red = s;
        }
      }
      const score = lambda * sim - (1 - lambda) * red;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break; // everything left is cap-blocked
    const r = remaining.splice(best, 1)[0];
    const k = key(r.c);
    authorCount[k] = (authorCount[k] || 0) + 1;
    picked.push(r);
  }
  return picked;
}

// Pure: pgvector comes back from PostgREST as a "[0.1, ...]" string;
// normalize to a validated number array, or null.
function parseEmbedding(v) {
  if (Array.isArray(v)) {
    return v.length && v.every(n => typeof n === 'number' && Number.isFinite(n)) ? v.slice() : null;
  }
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return parseEmbedding(p);
    } catch (e) { return null; }
  }
  return null;
}

// Authors of her 4★+ read books, most-loved first.
function topLovedAuthors(limit) {
  const map = {};
  library.forEach(b => {
    if (!b || b.status !== 'read' || (b.myRating || 0) < 4) return;
    (b.authors || []).forEach(a => {
      const k = String(a || '').trim();
      if (k) map[k] = (map[k] || 0) + 1;
    });
  });
  return Object.keys(map).sort((x, y) => map[y] - map[x]).slice(0, limit || 6);
}

// Canonical trope ids across her 4★+ read books (book.tropes holds display
// names, so resolve each through the taxonomy; v212's AI-added entries
// qualify too since they live in book.tropes).
function recoLovedTropeIds() {
  const ids = [], seen = new Set();
  library.forEach(b => {
    if (!b || b.status !== 'read' || (b.myRating || 0) < 4) return;
    ((b.tropes || []).concat(b.tropesAuto || [])).forEach(t => {
      let id = null;
      try { id = typeof tropeResolveId === 'function' ? tropeResolveId(t) : null; } catch (e) {}
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    });
  });
  return ids;
}

// Pure: which of her loved trope ids have a name/alias mentioned in the
// candidate text (title + description). Returns up to 3 display names.
function recoSharedTropes(text, lovedIds) {
  const hay = String(text || '').toLowerCase();
  if (!hay || !(lovedIds || []).length) return [];
  const out = [];
  for (const id of lovedIds) {
    let terms = [String(id).replace(/-/g, ' ')];
    let label = id;
    try {
      const t = typeof tropeById === 'function' ? tropeById(id) : null;
      if (t) {
        label = t.name;
        terms.push(t.name);
        const als = (typeof TROPE_ALIASES !== 'undefined' && TROPE_ALIASES[id]) || [];
        als.forEach(a => terms.push(a));
      }
    } catch (e) {}
    const hit = terms.some(term => {
      const s = String(term || '').toLowerCase().trim();
      return s.length > 2 && hay.indexOf(s) !== -1;
    });
    if (hit) out.push(label);
    if (out.length >= 3) break;
  }
  return out;
}

/* Dismissals: 'hc:<id>' keys in the IDB kv store, localStorage fallback
   (same split-brain rule as the release dismissals, per-device). */
const RECO_DISMISS_KEY = 'reco_dismissed';
async function recoDismissedSet() {
  try {
    if (typeof currentDb !== 'undefined' && currentDb) {
      const v = await idbKvGet(currentDb, RECO_DISMISS_KEY);
      if (Array.isArray(v)) return new Set(v);
    }
  } catch (e) {}
  try { return new Set(JSON.parse(localStorage.getItem('spicyshelves.' + RECO_DISMISS_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
async function recoDismiss(key) {
  const s = await recoDismissedSet();
  s.add(key);
  const arr = Array.from(s).slice(-200);
  let saved = false;
  try {
    if (typeof currentDb !== 'undefined' && currentDb) {
      await idbKvPut(currentDb, RECO_DISMISS_KEY, arr);
      saved = true;
    }
  } catch (e) {}
  if (!saved) {
    try { localStorage.setItem('spicyshelves.' + RECO_DISMISS_KEY, JSON.stringify(arr)); } catch (e) {}
  }
}

// Work embeddings for her read books. RLS: "works: read for signed-in"
// (v205) — returns {} offline or when signed out, and the caller degrades.
async function fetchWorkEmbeddings(workIds) {
  const ids = (workIds || []).filter(Boolean);
  if (!ids.length) return {};
  let sb = null;
  try { sb = await cloudClient(); } catch (e) { return {}; }
  if (!sb) return {};
  try {
    const { data, error } = await sb.from('works').select('id, embedding').in('id', ids);
    if (error) throw error;
    const out = {};
    for (const r of (data || [])) {
      const v = parseEmbedding(r && r.embedding);
      if (v) out[r.id] = v;
    }
    return out;
  } catch (e) { return {}; }
}

async function embedTextsClient(texts) {
  const res = await apiFetch('/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: texts }),
  });
  if (!res.ok) throw new Error('embed proxy ' + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.vectors) || data.vectors.length !== texts.length) {
    throw new Error('embed proxy returned an unexpected shape');
  }
  return data.vectors;
}

// Fresh books by her loved authors (Hardcover books table, newest first).
// Reuses hcBookToCandidate / releaseInLibrary; one author failing never
// kills the sweep (same pacing as the release check).
async function sweepRecoCandidates(authors, dismissed) {
  const out = [], seen = new Set();
  for (const a of (authors || []).slice(0, 6)) {
    try {
      const q = 'query { books(where: {contributions: {author: {name: {_eq: ' + JSON.stringify(a) + '}}},' +
        ' canonical_id: {_is_null: true}}, order_by: {release_date: desc}, limit: 12)' +
        ' { id title description pages image { url }' +
        ' contributions { author { name } } default_physical_edition { isbn_13 } } }';
      const data = await hcGraphQL(q);
      ((data || {}).books || []).forEach(b => {
        if (b.id == null || seen.has(b.id)) return;
        if (dismissed.has('hc:' + b.id)) return;
        const c = hcBookToCandidate(b);
        if (releaseInLibrary(c)) return;
        seen.add(b.id);
        c.loveAuthor = a;
        out.push(c);
      });
    } catch (e) { /* next author */ }
    await new Promise(r => setTimeout(r, 700)); // share the Hardcover pacing
  }
  return out;
}

function addRecoBook(c) {
  const clean = (c.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  const book = {
    id: uid(),
    isbn: clean.find(i => i.length === 13) || clean[0] || '',
    title: c.title, authors: c.authors, cover: c.cover, description: c.description,
    pageCount: c.pages, publishedDate: '', releaseDate: '',
    categories: [], publicRating: null, ratingsCount: 0,
    status: 'tbr', owned: 'tobuy', ratings: {}, myRating: 0,
    tropes: [], tropesAuto: [], progress: 0,
    dateAdded: new Date().toISOString(), dateFinished: null, notes: '',
    hcId: c.hcId, hcEnriched: true // already holds this Hardcover doc's data
  };
  book.axes = autoDetectAxes(book);
  return addBook(book, false, 'discovery');
}

let visibleRecos = []; // ranked [{c, sim}] currently on screen
let visibleRecoLoved = []; // loved trope ids, for the preview's why-chips (v219)

// v219: tapping a recommendation opens the read-only preview modal —
// description, tropes, genres. The +TBR / dismiss buttons keep their
// stopPropagation so tapping them never opens the preview.
function openRecoPreview(r) {
  const c = r.c;
  const why = [];
  if (c.loveAuthor) why.push('<span class="why-chip">' + icon('heart') + ' ' + esc(c.loveAuthor) + '</span>');
  recoSharedTropes((c.title || '') + ' ' + (c.description || ''), visibleRecoLoved).slice(0, 2)
    .forEach(t => why.push('<span class="why-chip">✦ ' + esc(t) + '</span>'));
  if (r.sim != null) why.push('<span class="why-chip">≈' + Math.round(r.sim * 100) + '% match</span>');
  openPreviewModal(previewTransient(c, 'reco'), {
    source: 'discovery-reco',
    why: why,
    onAddTBR: () => addRecoBook(c) // returns the new book (or null) — preview hands off to its real modal
  });
}

// v219: same treatment for New Releases results.
function openReleasePreview(c) {
  const why = [];
  const cd = releaseCountdown(c.releaseDate);
  if (cd) why.push('<span class="why-chip">' + icon('calendar') + ' Releases ' +
    esc(fmtDate(c.releaseDate)) + ' · ' + cd + '</span>');
  openPreviewModal(previewTransient(c, 'release'), {
    source: 'new-release',
    why: why,
    onAddTBR: () => addReleaseBook(c)
  });
}

function recoCardHTML(r, i, lovedIds) {
  const c = r.c;
  const chips = [];
  if (c.loveAuthor) chips.push('<span class="why-chip">' + icon('heart') + ' ' + esc(c.loveAuthor) + '</span>');
  recoSharedTropes((c.title || '') + ' ' + (c.description || ''), lovedIds).slice(0, 2)
    .forEach(t => chips.push('<span class="why-chip">\u2726 ' + esc(t) + '</span>'));
  if (r.sim != null) chips.push('<span class="why-chip">\u2248' + Math.round(r.sim * 100) + '% match</span>');
  return '<div class="book-card rel-card" data-i="' + i + '">' + coverHTML(c) +
    '<div class="book-meta"><h3>' + esc(c.title) + '</h3>' +
    '<p class="author">' + esc(displayAuthors(c.authors)) + '</p>' +
    (chips.length ? '<div class="why-chips">' + chips.join('') + '</div>' : '') +
    '</div><div style="align-self:center;display:flex;gap:6px">' +
    '<button class="btn small" data-add="' + i + '">\uFF0B TBR</button>' +
    '<button class="btn ghost small" data-dis="' + i + '" aria-label="Not for me">\u2715</button></div></div>';
}

function wireRecoResults(box) {
  box.querySelectorAll('.rel-card').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('[data-add]') || e.target.closest('[data-dis]')) return;
    const r = visibleRecos[Number(card.dataset.i)];
    if (r) openRecoPreview(r);
  }));
  box.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const r = visibleRecos[Number(btn.dataset.add)];
    if (r && addRecoBook(r.c)) {
      btn.closest('.rel-card').style.opacity = '0.4';
      btn.textContent = '\u2713 Added';
      btn.disabled = true;
    }
  }));
  box.querySelectorAll('[data-dis]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const r = visibleRecos[Number(btn.dataset.dis)];
    if (r) await recoDismiss('hc:' + r.c.hcId);
    btn.closest('.rel-card').remove();
    if (!box.querySelector('.rel-card')) box.innerHTML = '<p class="note">All caught up \u2728</p>';
  }));
}

function renderRecoResults(ranked, lovedIds, embedded) {
  const box = document.getElementById('disc-reco');
  if (!box) return;
  visibleRecos = ranked;
  visibleRecoLoved = lovedIds || [];
  // v224 (UX-06): the section label stays up in every state — empty or loaded.
  if (!ranked.length) {
    box.innerHTML = recoHeadHTML() + '<p class="note">Nothing new from your favorite authors right now \u2014 check back later \u2728</p>';
    return;
  }
  box.innerHTML = recoHeadHTML() +
    (embedded ? '' : '<p class="note">\u2726 Taste matching is still warming up \u2014 showing fresh picks from your favorite authors.</p>') +
    '<div class="grid">' + ranked.map((r, i) => recoCardHTML(r, i, lovedIds)).join('') + '</div>' +
    '<p class="note" style="text-align:center"><button class="btn ghost small" id="reco-refresh">\u21BB Refresh</button></p>';
  wireRecoResults(box);
  const rf = document.getElementById('reco-refresh');
  if (rf) rf.addEventListener('click', () => refreshRecommendations());
  track('reco_viewed', { count: ranked.length, embedded: !!embedded });
}

// v224 (UX-06): the Recommended section label renders in every state,
// including loading and the early-return empty states below.
function recoHeadHTML() {
  return '<h3 class="wish-section">' + icon('crystal') + ' Recommended for you</h3>';
}
async function refreshRecommendations() {
  const box = document.getElementById('disc-reco');
  if (!box) return;
  box.innerHTML = recoHeadHTML() + '<p class="note">' + icon('hourglass') + ' Reading your taste\u2026</p>';
  try {
    // v214: profile books are finished reads AND favorites (favorites anchor
    // the profile at top weight, so a thin rating history still works).
    const profBooks = library.filter(b => b && (b.status === 'read' || b.favorite));
    if (!profBooks.length) {
      box.innerHTML = recoHeadHTML() + '<p class="note">Finish a few books or tap \u2661 on some favorites \u2014 your taste profile grows from the books you love.</p>';
      return;
    }
    const authors = topLovedAuthors(6);
    if (!authors.length) {
      box.innerHTML = recoHeadHTML() + '<p class="note">Rate a few finished books 4\u2605 or higher and I\u2019ll find your next obsession.</p>';
      return;
    }
    if (!hcReady()) {
      box.innerHTML = recoHeadHTML() + '<p class="note">Connect Hardcover in Settings \u2192 Hardcover to browse recommendations.</p>';
      return;
    }
    // Taste profile: weighted mean of her read books' and favorites'
    // work embeddings (v214: favorites included at top weight).
    const withIds = [];
    for (const b of profBooks) {
      let wid = null;
      try { wid = await resolveWork(b); } catch (e) {}
      if (wid) withIds.push({ book: b, workId: wid });
    }
    const emb = await fetchWorkEmbeddings(withIds.map(x => x.workId));
    const profile = tasteProfileVector(withIds.map(x => ({
      vector: emb[x.workId] || null, rating: x.book.myRating || 0, favorite: !!x.book.favorite,
    })));
    const dismissed = await recoDismissedSet();
    const lovedIds = recoLovedTropeIds();
    box.innerHTML = '<p class="note">' + icon('hourglass') + ' Browsing ' + authors.length + ' favorite authors\u2026</p>';
    const cands = await sweepRecoCandidates(authors, dismissed);
    if (!cands.length) {
      box.innerHTML = '<p class="note">Nothing new from your favorite authors right now \u2014 check back later \u2728</p>';
      return;
    }
    let ranked = null;
    if (profile) {
      try {
        const vectors = await embedTextsClient(cands.map(c =>
          buildEmbedText({ title: c.title, authors: c.authors, description: c.description })));
        // v214: MMR re-ranking spreads the list across authors instead of
        // letting one prolific loved author sweep every slot.
        ranked = mmrDiversify(cands
          .map((c, i) => ({ c: c, sim: cosineSim(profile, vectors[i]), vector: vectors[i] }))
          .sort((x, y) => y.sim - x.sim), RECO_FINAL_COUNT);
      } catch (e) { ranked = null; /* proxy down: fall through to the fallback */ }
    }
    if (!ranked) {
      const rank = {};
      authors.forEach((a, i) => { rank[a] = i; });
      ranked = mmrDiversify(cands.slice()
        .sort((x, y) => ((rank[x.loveAuthor] == null ? 99 : rank[x.loveAuthor]) - (rank[y.loveAuthor] == null ? 99 : rank[y.loveAuthor])))
        .map(c => ({ c: c, sim: null })), RECO_FINAL_COUNT);
    }
    renderRecoResults(ranked, lovedIds, !!profile && ranked[0] && ranked[0].sim != null);
  } catch (e) {
    box.innerHTML = '<p class="note">Recommendations hiccuped \u2014 try again in a bit.</p>';
  }
}
