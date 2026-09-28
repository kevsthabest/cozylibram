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
function topReleaseAuthors(limit) {
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
    .slice(0, limit || 8).map(e => e.name);
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

async function checkNewReleases(onTick) {
  const authors = topReleaseAuthors(8);
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

function renderReleaseResults(list) {
  const box = document.getElementById('release-results');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<p class="note">No new releases found — you\'re all caught up ✨</p>';
    return;
  }
  box.innerHTML = '<h3 class="wish-section">' + icon('sparkles') + ' New from your authors</h3>' +
    '<div class="grid">' + list.map((c, i) =>
      '<div class="book-card rel-card" data-i="' + i + '">' + coverHTML(c) +
      '<div class="book-meta"><h3>' + esc(c.title) + '</h3>' +
      '<p class="author">' + esc(c.authors.join(', ')) + '</p>' +
      '<div class="up-pill">' + icon('calendar') + ' ' + esc(fmtDate(c.releaseDate)) + ' · ' + releaseCountdown(c.releaseDate) + '</div>' +
      '</div><div style="align-self:center;display:flex;gap:6px">' +
      '<button class="btn small" data-add="' + i + '">＋ Add</button>' +
      '<button class="btn ghost small" data-dis="' + i + '" aria-label="Dismiss">✕</button></div></div>'
    ).join('') + '</div>';
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

// Wishlist wiring: runs the sweep with progress on the button.
function wireReleaseCheck() {
  const btn = document.getElementById('rel-check');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!hcReady()) { toast('Connect Hardcover in Settings → Hardcover first'); return; }
    track('release_discovery_opened');
    btn.disabled = true;
    const label = btn.innerHTML;
    try {
      const res = await checkNewReleases((a, i, n) => {
        btn.innerHTML = icon('hourglass') + ' Checking ' + esc(a) + '… (' + i + '/' + n + ')';
      });
      const box = document.getElementById('release-results');
      // v135: if every author's lookup failed, say so — "all caught up"
      // would be a lie when we never actually reached Hardcover.
      if (!res.list.length && res.total > 0 && res.failed >= res.total && box) {
        box.innerHTML = '<p class="note">Couldn\'t reach Hardcover for any author — ' +
          'check the connection in Settings → Hardcover, then try again.</p>';
      } else {
        renderReleaseResults(res.list);
        saveAutoReleases(res.list); // v149: manual checks refresh the auto cache
        visibleReleases = res.list; // v150: survive re-renders while adding
        markReleasesSeen();
      }
    } catch (e) {
      const box = document.getElementById('release-results');
      if (box) box.innerHTML = '<p class="note">The check failed — try again in a bit.</p>';
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
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

/* ---------------- Discover landing (v121) ----------------
   "What are you in the mood for?" — one destination for every discovery
   feature, each with a plain-language explanation. Cards route to real
   features only; the release check runs inline. */
function discCard(ic, title, blurb, target) {
  return '<button class="disc-card" data-disc="' + target + '">' +
    '<span class="disc-ic">' + icon(ic) + '</span>' +
    '<span class="disc-tx"><b>' + esc(title) + '</b><small>' + esc(blurb) + '</small></span>' +
    '<span class="disc-go" aria-hidden="true">→</span></button>';
}

function renderDiscover() {
  track('discover_opened', null, { dedupeKey: 'discover-open', dedupeMs: 8000 });
  setView('<div class="view-head"><h2 class="serif">' + icon('sparkles') + ' Discover</h2>' +
    '<p class="note">What are you in the mood for?</p></div>' +
    '<div class="disc-list">' +
    discCard('dice', 'Surprise Me', 'Can\u2019t decide what to read? Let Cozy Libram pick something from your TBR.', 'pick') +
    discCard('calendar', 'New Releases', 'Fresh and upcoming books from your favorite authors.', 'releases') +
    discCard('user', 'Authors You Might Like', 'Find missing books from authors you already love.', 'authors') +
    discCard('friends', 'From Friends', 'Books your coven couldn\u2019t put down.', 'coven') +
    discCard('search', 'Search Books', 'Search millions of titles to add to your library.', 'search') +
    '</div>' +
    '<div class="disc-releases"><button class="btn sm" id="rel-check">' + icon('sparkles') + ' Check for new releases</button>' +
    '<div id="release-results"></div></div>');
  wireReleaseCheck();
  renderVisibleReleases(); // v150: restore the release list across re-renders
  document.querySelectorAll('[data-disc]').forEach(c => c.addEventListener('click', () => {
    const t = c.dataset.disc;
    if (t === 'pick') go('pick');
    else if (t === 'authors') go('authors');
    else if (t === 'coven') go('coven');
    else if (t === 'releases') { // v134: the card itself runs the release check
      const b = document.getElementById('rel-check');
      if (b) b.click();
    }
    else if (t === 'search') { addTab = 'search'; go('add'); }
  }));
}
