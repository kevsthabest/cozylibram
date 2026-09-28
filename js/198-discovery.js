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
      '<p class="author">' + esc(c.authors.join(', ')) + '</p>' +
      '<div class="up-pill">' + icon('calendar') + ' ' + esc(fmtDate(c.releaseDate)) + ' · ' + releaseCountdown(c.releaseDate) + '</div>' +
      '</div><div style="align-self:center;display:flex;gap:6px">' +
      '<button class="btn small" data-add="' + i + '">＋ Add</button>' +
      '<button class="btn ghost small" data-dis="' + i + '" aria-label="Dismiss">✕</button></div></div>'
    ).join('') + '</div>';
}

function wireReleaseResults(box, list) {
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
   card, four tiles (My Favorites / Similar Books / Authors / New Releases),
   a Search-the-Library-&-Beyond row, and a From-Your-Coven section. Every
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
function similarSeedHTML() {
  const seeds = library.filter(b => b.favorite || (b.myRating || 0) >= 4)
    .sort((a, b) => ((b.myRating || 0) - (a.myRating || 0)) || ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)))
    .slice(0, 6);
  if (!seeds.length)
    return '<p class="note">Rate a few books 4\u2605 or tap the \u2661 on a favorite — your top books will show up here as starting points.</p>';
  return '<p class="note">Like which one?</p><div class="sim-seeds">' + seeds.map(b =>
    '<button class="sim-seed" data-seed="' + b.id + '" aria-label="Find books like ' + esc(b.title) + '">' +
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
    '<div class="disc-hero"><span class="disc-hero-ic">' + icon('sparkles') + '</span>' +
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
    '</div>' +

    '<div id="disc-sim" hidden></div>' +

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
    // 'releases' is owned by wireReleaseCheck (shared with the Wishlist button).
  }));
  document.getElementById('disc-coven-all').addEventListener('click', () => go('coven'));
  document.querySelectorAll('[data-cj]').forEach(c =>
    c.addEventListener('click', () => covenJump(c.dataset.cj)));
}
