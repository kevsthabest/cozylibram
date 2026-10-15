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
// v483: split into releaseAuthorStats() (ranked {name,n,stars,sn}) so the
// Library home card can show per-author counts; topReleaseAuthors() keeps
// its names-only contract for the sweep.
function releaseAuthorStats() {
  const map = {};
  library.forEach(b => {
    if (b.status !== 'read') return; // v484: read books only — the card labels n "books read"
    // v402: skip "Full Cast" and dramatized-audiobook cast members — they're
    // not authors, and scanning them produces actor-credited junk releases.
    const isDramatized = (b.authors || []).some(a =>
      String(a || '').trim().toLowerCase() === 'full cast');
    (b.authors || []).forEach((a, idx) => {
      const k = String(a || '').trim();
      if (!k) return;
      if (k.toLowerCase() === 'full cast') return;
      // For dramatized editions, only the first author is the real author;
      // the rest are cast members.
      if (isDramatized && idx > 0) return;
      const e = map[k] || (map[k] = { name: k, n: 0, stars: 0, sn: 0 });
      e.n++;
      if (b.myRating > 0) { e.stars += b.myRating; e.sn++; }
    });
  });
  return Object.values(map)
    .sort((x, y) => (y.n - x.n) || ((y.sn ? y.stars / y.sn : 0) - (x.sn ? x.stars / x.sn : 0)));
}
function topReleaseAuthors() {
  return releaseAuthorStats().map(e => e.name);
}

// Batch 4 (issue #142): the silent weekly auto sweep is capped — the manual
// "Check for new releases" keeps full coverage (User's call, 2026-10-12).
// Priority: favorited authors first, then most-read, then highest-ranked;
// authors of recently finished books get an extra boost on top.
const AUTO_RELEASE_AUTHOR_CAP = 40;
const AUTO_RELEASE_RECENT_DAYS = 120;
function priorityReleaseAuthors() {
  const fav = {}, recent = {};
  const cutoff = Date.now() - AUTO_RELEASE_RECENT_DAYS * 864e5;
  library.forEach(b => {
    const names = (b.authors || []).map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
    if (!names.length) return;
    if (b.favorite) names.forEach(n => { fav[n] = 1; });
    if (b.status === 'read' && b.dateFinished) {
      const t = new Date(b.dateFinished).getTime();
      if (!isNaN(t) && t >= cutoff) names.forEach(n => { recent[n] = 1; });
    }
  });
  const avg = e => (e.sn ? e.stars / e.sn : 0);
  return releaseAuthorStats()
    .map(e => ({ e: e, boost: (fav[e.name.toLowerCase()] ? 2 : 0) + (recent[e.name.toLowerCase()] ? 1 : 0) }))
    .sort((a, b) => (b.boost - a.boost) || (b.e.n - a.e.n) || (avg(b.e) - avg(a.e)))
    .slice(0, AUTO_RELEASE_AUTHOR_CAP)
    .map(x => x.e.name);
}

// Already on her shelves? Matches by ISBN first, then title + first author.
function releaseInLibrary(c) {
  const isbns = (c.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  if (isbns.length && library.some(b => b.isbn && isbns.indexOf(b.isbn) !== -1)) return true;
  const t = String(c.title || '').toLowerCase().trim();
  const a = String((c.authors || [])[0] || '').toLowerCase().trim();
  if (!t) return false;
  const ownedTitle = (title) => library.some(b =>
    String(b.title || '').toLowerCase().trim() === title &&
    String((b.authors || [])[0] || '').toLowerCase().trim() === a);
  if (ownedTitle(t)) return true;
  // v533: omnibus records bundle several works into one title ("Beach
  // Read / People We Meet On Vacation / Book Lovers / Happy Place").
  // The bundle carries its OWN ISBN and its joined title equals no
  // single owned title, so both checks above miss it and an all-owned
  // bundle surfaced as a new find. If EVERY '/'-separated segment is an
  // owned title by the same first author, the bundle is in the library;
  // a partially-owned bundle is a genuine recommendation and stays.
  if (!a) return false;
  const segs = t.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);
  if (segs.length < 2) return false;
  return segs.every(seg => ownedTitle(seg));
}

function hcBookToCandidate(b) {
  const names = (b.contributions || []).map(x => String((((x || {}).author) || {}).name || '')).filter(Boolean);
  const ed = b.default_physical_edition || {};
  const coverEd = b.default_cover_edition || {};
  // v530: language lives on editions in Hardcover's schema (books have no
  // language field). Physical edition first, cover edition as fallback —
  // audiobook records have no physical edition but do have a cover one.
  const langOf = e => { const l = (e || {}).language; return (l && l.language) ? String(l.language) : ''; };
  return {
    hcId: b.id,
    title: b.title || 'Untitled',
    authors: names.slice(0, 3),
    releaseDate: String(b.release_date || '').slice(0, 10),
    cover: (b.image && b.image.url) || '',
    description: b.description || '',
    // v535: warning passthrough for the discovery filter — Hardcover's
    // books type has no content_warnings field today (it lives on
    // search docs; recoApplyWarningFilter enriches from there), but a
    // source row that ever carries them is honoured as-is.
    contentWarnings: Array.isArray(b.content_warnings) ? b.content_warnings.slice() : [],
    pages: b.pages || null,
    isbns: ed.isbn_13 ? [String(ed.isbn_13)] : [],
    // v530: edition signals for the Recommended sweep's one-edition-per-work
    // collapse (see recoIsAudioRecord / recoLangCode). Inert for the New
    // Releases sweep, which shares this mapper: absent fields read as null.
    audioSeconds: (typeof b.audio_seconds === 'number' && isFinite(b.audio_seconds)) ? b.audio_seconds : null,
    defAudioId: b.default_audio_edition_id != null ? b.default_audio_edition_id : null,
    defPhysId: b.default_physical_edition_id != null ? b.default_physical_edition_id : null,
    defEbookId: b.default_ebook_edition_id != null ? b.default_ebook_edition_id : null,
    langName: langOf(ed) || langOf(coverEd) || ''
  };
}

async function checkNewReleases(onTick, onFound, authorList) {
  // authorList: the auto sweep passes a capped, priority-ordered list
  // (batch 4, issue #142); the manual check passes nothing and keeps the
  // full topReleaseAuthors() coverage.
  const authors = authorList || topReleaseAuthors();
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
        // v402: suppress absurd dates (Hardcover placeholder data, e.g. year 2200).
        // Anything more than 2 years out is not a real announced release.
        const maxDate = new Date();
        maxDate.setFullYear(maxDate.getFullYear() + 2);
        if (c.releaseDate > maxDate.toISOString().slice(0, 10)) return;
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
    // v559: an unreleased find is born tbr + tobuy — on the Wishlist
    // by derivation (the to-buy part of TBR). owned 'tobuy': not in hand.
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

// v538: on Discover the release list renders as a cover rail (the tab's
// shelves); everywhere else (the Wishlist view) the grid above stands.
// Cards keep the .rel-card / [data-add] / [data-dis] / .cover-wrap
// hooks either way, so wireReleaseResults and the shield painter don't
// care which shape a list took.
function releaseListHTML(list) {
  if (typeof view !== 'undefined' && view === 'discover') return releaseRailHTML(list);
  return releaseResultsHTML(list);
}
function releaseRailHTML(list) {
  if (!list.length) {
    return '<p class="note">No new releases found — you\u2019re all caught up ✨</p>';
  }
  return '<div class="rail rel-rail">' + list.map((c, i) => {
    const d = c.releaseDate ? new Date(c.releaseDate + 'T12:00:00') : null;
    const tag = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase() : '';
    return '<div class="rail-card rel-card" data-i="' + i + '">' +
      '<div class="rail-coverbox">' + coverHTML(c) +
      (tag ? '<span class="rel-tag">' + esc(tag) + '</span>' : '') + '</div>' +
      '<h3 class="rail-title">' + esc(c.title) + '</h3>' +
      '<p class="rail-author">' + esc(displayAuthors(c.authors)) + '</p>' +
      '<p class="rail-why">' + icon('calendar') + ' ' + esc(releaseCountdown(c.releaseDate)) + '</p>' +
      '<div class="rail-acts">' +
      '<button class="btn small" data-add="' + i + '">＋ Add</button>' +
      '<button class="btn ghost small" data-dis="' + i + '" aria-label="Dismiss">✕</button></div></div>';
  }).join('') + '</div>';
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
  box.innerHTML = releaseListHTML(list);
  wireReleaseResults(box, list);
  shieldPaintReleaseCovers(box, list);
}

// v524: content shield, Discover only — blur release covers whose work
// is known high-spice. The same results render on the Wishlist (the
// viewer's own surface) unshielded, so the gate is the current view,
// not the markup. The work-spice lookup is async and lands when it
// lands; release candidates are future-dated books, so work-level
// spice for them is rare and unknown spice stays visible (the
// shield's unknown rule).
function shieldPaintReleaseCovers(box, list) {
  if (!box || typeof shieldOn !== 'function' || !shieldOn()) return;
  if (typeof view === 'undefined' || view !== 'discover') return;
  if (typeof shieldSpiceMapFor !== 'function' || typeof shieldIsHighSpice !== 'function') return;
  shieldSpiceMapFor(list || []).then(map => {
    if (!document.body.contains(box)) return;
    box.querySelectorAll('.rel-card').forEach(card => {
      const c = (list || [])[Number(card.dataset.i)];
      if (c && shieldIsHighSpice(c, map)) {
        const w = card.querySelector('.cover-wrap');
        if (w) w.classList.add('shield-blur');
      }
    });
  }).catch(() => {});
}

// Shared wiring: the Wishlist's "Check for new releases" button and
// Discover's inline Check now (v175 tile; v538 a text button in the New
// releases section head). The Discover control shows progress inline in
// #release-results; the Wishlist button keeps its old label-swap behavior.
function wireReleaseCheck() {
  const btn = document.querySelector('[data-dtile="releases"]') || document.getElementById('disc-rel-check') || document.getElementById('rel-check');
  if (!btn) return;
  const isTile = btn.hasAttribute('data-dtile') || btn.id === 'disc-rel-check';
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (!hcReady()) { toast('Hardcover isn\u2019t available right now — try again later'); return; }
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
        (list.length ? releaseListHTML(list) : (done ? releaseListHTML([]) : ''));
      wireReleaseResults(box, list);
      if (done) shieldPaintReleaseCovers(box, list); // v524: final paint only; no-op unless Discover + shield on
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
          'check your connection, then try again.</p>';
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
// v484: the full cached find list, minus dismissed/shelved — ignoring the
// seen timestamp. The Library "new from authors you love" card is a
// persistent coming-soon reminder, not a notification; seen/unseen is for
// the Discover badge only.
function cachedReleaseList() {
  const c = autoReleases();
  if (!c || !c.list.length) return [];
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

/* ---------------- library home: author releases card (v483) ---------------- */
// Compact "new from authors you love" card on the Library home. Reads the
// weekly auto-sweep cache only — never triggers a Hardcover sweep. Rendered
// below Currently Reading, and only when there is something to show (no
// empty state).
var AUTHOR_REL_MAX_AUTHORS = 3;
var AUTHOR_REL_MAX_PER_AUTHOR = 3;

// Group unseen releases by author (case-insensitive name match), ranked by
// the author's library stats. A co-authored release lands under the
// highest-ranked matching author only. Pure — takes (list, stats).
function authorReleaseGroups(list, stats) {
  const seen = new Set();
  const groups = [];
  for (const s of stats) {
    if (groups.length >= AUTHOR_REL_MAX_AUTHORS) break;
    const key = String(s.name || '').trim().toLowerCase();
    if (!key) continue;
    const rels = [];
    for (const c of list) {
      if (!c || seen.has(c.hcId)) continue;
      const authors = (c.authors || []).map(a => String(a || '').trim().toLowerCase());
      if (authors.indexOf(key) < 0) continue;
      seen.add(c.hcId);
      rels.push(c);
      if (rels.length >= AUTHOR_REL_MAX_PER_AUTHOR) break;
    }
    if (rels.length) {
      groups.push({
        name: s.name,
        n: s.n,
        avg: s.sn ? Math.round((s.stars / s.sn) * 10) / 10 : null,
        releases: rels.slice().sort((a, b) =>
          String(a.releaseDate || '').localeCompare(String(b.releaseDate || '')))
      });
    }
  }
  return groups;
}

// Flat candidate list in card render order, for index-based wiring.
var authorReleaseFlat = [];

// Impure wrapper: reads the auto-sweep cache, returns '' when nothing to show.
// v484: uses cachedReleaseList() (full cache, ignoring seen) so the card
// persists after a manual "New Releases" check marks everything seen.
function authorReleasesCard() {
  let groups = [], extra = 0;
  try {
    const list = cachedReleaseList();
    groups = list.length ? authorReleaseGroups(list, releaseAuthorStats()) : [];
    authorReleaseFlat = [];
    groups.forEach(g => g.releases.forEach(c => authorReleaseFlat.push(c)));
    extra = list.length - authorReleaseFlat.length;
  } catch (e) { groups = []; authorReleaseFlat = []; extra = 0; }
  return authorReleasesCardHTML(groups, authorReleaseFlat, extra);
}

// Pure HTML. `flat` parallels the rendered rows for data-i indexing.
function authorReleasesCardHTML(groups, flat, extra) {
  if (!groups.length) return '';
  const cards = groups.map(g => {
    const meta = g.n + (g.n === 1 ? ' book read' : ' books read') +
      (g.avg != null ? ' · ' + g.avg.toFixed(1) + ' average' : '');
    const rows = g.releases.map(c => {
      const i = flat.indexOf(c);
      const dt = (typeof fmtDate === 'function' ? fmtDate(c.releaseDate) : (c.releaseDate || ''));
      return '<div class="ar-rel">' +
        '<button class="ar-main" data-ar-prev="' + i + '" aria-label="' + esc(c.title) + ', releases ' + esc(dt) + '">' +
        '<span class="ar-title">' + esc(c.title) + '</span>' +
        '<span class="ar-date">' + esc(dt) + '</span></button>' +
        '<button class="btn small" data-ar-add="' + i + '">＋ Add</button>' +
        '<button class="btn ghost small ar-dis" data-ar-dis="' + i + '" aria-label="Dismiss ' + esc(c.title) + '">✕</button></div>';
    }).join('');
    return '<div class="author-rel-card"><div class="ar-name">' + esc(g.name) + '</div>' +
      '<div class="ar-meta">' + esc(meta) + '</div>' + rows + '</div>';
  }).join('');
  const more = extra > 0
    ? '<button class="ar-more" data-ar-more>' + extra + ' more in Discover →</button>' : '';
  return '<section class="home-sec" id="author-releases"><h3 class="home-sec-title">' +
    icon('sparkles') + ' New from authors you love</h3>' + cards + more + '</section>';
}

function wireAuthorReleases() {
  const box = document.getElementById('author-releases');
  if (!box) return;
  box.querySelectorAll('[data-ar-prev]').forEach(btn => btn.addEventListener('click', () => {
    const c = authorReleaseFlat[Number(btn.dataset.arPrev)];
    if (c && typeof openReleasePreview === 'function') openReleasePreview(c);
  }));
  box.querySelectorAll('[data-ar-add]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const c = authorReleaseFlat[Number(btn.dataset.arAdd)];
    if (c && typeof addReleaseBook === 'function' && addReleaseBook(c)) {
      btn.textContent = '✓ Added';
      btn.disabled = true;
      const row = btn.closest('.ar-rel');
      if (row) row.style.opacity = '0.4';
    }
  }));
  box.querySelectorAll('[data-ar-dis]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const c = authorReleaseFlat[Number(btn.dataset.arDis)];
    if (c && typeof dismissRelease === 'function') dismissRelease(c.hcId);
    const row = btn.closest('.ar-rel');
    const card = btn.closest('.author-rel-card');
    if (row) row.remove();
    if (card && !card.querySelector('.ar-rel')) card.remove();
    if (!box.querySelector('.author-rel-card')) box.remove();
  }));
  const more = box.querySelector('[data-ar-more]');
  if (more) more.addEventListener('click', () => { if (typeof go === 'function') go('discover'); });
}
// Silent weekly sweep. Skips when Hardcover isn't configured or the library
// is empty; a fully-failed sweep stamps nothing so it retries next boot.
async function maybeAutoReleaseCheck() {
  try {
    updateReleaseBadge();
    if (!hcReady() || !library.length) return;
    const c = autoReleases();
    if (c && Date.now() - c.at < AUTO_REL_DAYS * 864e5) return;
    const res = await checkNewReleases(null, null, priorityReleaseAuthors()); // no onTick: no progress UI; capped priority list (batch 4, issue #142)
    if (res.total > 0 && res.failed >= res.total) return;
    saveAutoReleases(res.list);
    updateReleaseBadge();
    // v150: if she's looking at the release list right now, show the finds
    // immediately instead of waiting for the next navigation.
    if (document.getElementById('release-results')) renderVisibleReleases();
    track('release_auto_check', { book_count: res.list.length });
  } catch (e) {}
}

/* ---------------- Discover landing (v121, restyled v175, remade v538) ----
   v538: Variant B, "The Stage & The Shelves" — the tab is organized by
   JOB. "Tonight's read" is a stage: the Surprise Me roulette behind a
   single centred TBR cover ("Let the shelf decide."). "Find new books"
   is three sideways cover rails by source: Recommended for you (with
   Similar Books absorbed as a "More like" seed lens — no longer a
   destination), New releases (the sweep inline, no doorway tile), and
   From Your <covenName> (friend picks riding the loadRecos path). The
   My Favorites and Add a Book tiles are retired: Favorites is a Library
   surface, and Add lives in the permanent nav. All mechanics underneath
   (roulette, reco sweep/ranking, release sweep) are unchanged. */

// v538: the seed lens's candidates — her highest-rated books and
// favorites, best first. Shared by the chips row and the lens itself.
function similarSeeds() {
  return library.filter(b => b.favorite || (b.myRating || 0) >= 4)
    .sort((a, b) => ((b.myRating || 0) - (a.myRating || 0)) || ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)))
    .slice(0, 6);
}

// v538: "More like:" chips above the Recommended rail. Renders '' when
// she has no seeds yet (the Recommended empty states carry the guidance).
function seedLensHTML() {
  const seeds = similarSeeds();
  if (!seeds.length) return '';
  return '<div class="seed-lens"><span class="seed-lens-label">More like:</span>' +
    '<div class="seed-chips">' + seeds.map(b =>
      '<button class="seed-chip" data-seed="' + esc(b.id) + '">' + esc(b.title) + '</button>').join('') +
    '</div></div>';
}

// v403: Show books similar to a seed book (from recommendations).
// Filters the recommendation pool by seed's author/genres.
// v538: this is now the seed LENS — it re-renders the Recommended rail
// in place with just the matches, instead of swapping in a separate
// Similar view. Tapping the active chip again clears it (clearRecoLens).
let recoLastRender = null;  // last full render's args — the lens restore point
let recoLensSeedId = null;  // seed id while the lens is applied
function showSimilarToSeed(seed) {
  const seedAuthors = (seed.authors || []).map(a => String(a).trim().toLowerCase());
  const seedTropes = (seed.tropes || []).map(t => String(t).trim().toLowerCase());

  // Score recommendations by overlap with seed
  const scored = (visibleRecos || []).map(r => {
    const c = r.c;
    let score = 0;
    const cAuthors = (c.authors || []).map(a => String(a).trim().toLowerCase());
    if (seedAuthors.some(a => cAuthors.includes(a))) score += 3;
    // Batch 4 (issue #147): the genre-overlap term was dead — candidates are
    // hcBookToCandidate-shaped and carry no genres/categories in production,
    // so the +2 term never scored. Removed rather than faked.
    const cTropes = (c.tropes || []).map(t => String(t).trim().toLowerCase());
    const tropeOverlap = seedTropes.filter(t => cTropes.includes(t)).length;
    score += Math.min(tropeOverlap, 3);
    return { r, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const box = document.getElementById('disc-reco');
  if (!box) return;

  // v538: the lens re-renders the rail in place — the subset becomes
  // visibleRecos, so wireRecoResults (preview / ＋TBR / dismiss) lines
  // up exactly as it does for the full ranking. recoLastRender keeps
  // the un-lensed render for the restore.
  recoLensSeedId = seed.id;
  document.querySelectorAll('.seed-chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.seed === seed.id));
  const head = '<div class="lens-head"><span>Books like <b>' + esc(seed.title) + '</b></span>' +
    '<button class="taplink" id="sim-clear">✕ Clear</button></div>';
  const subset = scored.map(x => x.r).slice(0, 12);
  visibleRecos = subset;
  box.innerHTML = head + (subset.length
    ? recoRailHTML(subset, visibleRecoLoved)
    : '<p class="note">No similar books found in recommendations yet. Try the full list, or check back after the next scan.</p>');
  if (subset.length) wireRecoResults(box);
  const clear = document.getElementById('sim-clear');
  if (clear) clear.addEventListener('click', clearRecoLens);
}

// v538: drop the seed lens and re-render the full Recommended ranking.
function clearRecoLens() {
  recoLensSeedId = null;
  document.querySelectorAll('.seed-chip.on').forEach(c => c.classList.remove('on'));
  if (recoLastRender) renderRecoResults(recoLastRender.ranked, recoLastRender.lovedIds, recoLastRender.embedded, recoLastRender.spiceMap);
}

function renderDiscover() {
  track('discover_opened', null, { dedupeKey: 'discover-open', dedupeMs: 8000 });
  // v538: the stage shows the TBR book the roulette is about to choose
  // from — prefer one with a cover; fall back to its title treatment.
  const tbr = (typeof tbrBooks === 'function') ? tbrBooks() : library.filter(b => b.status === 'tbr');
  const stageBook = tbr.find(b => b.cover) || tbr[0] || null;
  const stageCover = !stageBook ? '' :
    stageBook.cover
      ? '<div class="stage-cover"><img src="' + esc(stageBook.cover) + '" alt="" loading="lazy"></div>'
      : '<div class="stage-cover stage-cover-ph"' + (stageBook.coverColor ? ' style="background:' + esc(stageBook.coverColor) + '"' : '') +
        '><b class="serif">' + esc(stageBook.title) + '</b><small>' + esc(displayAuthors(stageBook.authors)) + '</small></div>';
  const tbrLine = !tbr.length
    ? 'Your TBR is empty — add a few books, then let the shelf decide.'
    : 'One of the ' + tbr.length + (tbr.length === 1 ? ' book' : ' books') + ' waiting on your TBR.';
  setView(
    // v538 header: plain framing, no mood promise the tab can't keep.
    // The themed moon stays as the hero's one ornament.
    '<div class="disc-hero"><span class="disc-moon" aria-hidden="true"></span>' +
    '<h2 class="serif">Discover</h2>' +
    '<p>Two ways in — pick one.</p></div>' +

    // v538 THE STAGE: one centred cover (the fan side-covers were cut
    // in the design critique) over a quiet gold settle.
    '<div class="disc-stage">' +
    '<div class="disc-job">Tonight\u2019s read</div>' +
    stageCover +
    '<div class="serif stage-headline">Let the shelf decide.</div>' +
    '<p class="stage-sub">' + tbrLine + '</p>' +
    '<button class="btn stage-btn" data-dtile="pick">' + icon('dice') + ' Surprise Me</button>' +
    // v564: Blind Date rides the same stage as a secondary action —
    // it opens the roulette with the wrapped mode on (spec §7: no new
    // tile, no new doorway).
    '<div><button class="taplink" id="disc-blind-date">or go on a blind date →</button></div>' +
    '<div><button class="taplink" id="disc-browse-tbr">or browse your TBR →</button></div></div>' +

    '<div class="disc-job-row"><span>Find new books</span><i></i></div>' +

    '<section class="disc-sec">' +
    '<div class="disc-sec-head"><h3 class="serif">' + icon('crystal') + ' Recommended for you</h3></div>' +
    '<div id="disc-seeds">' + seedLensHTML() + '</div>' +
    '<div id="disc-reco"><p class="note">' + icon('hourglass') + ' Reading your taste\u2026</p></div></section>' +

    // v538: New Releases is an inline section now — the sweep's results
    // sit in the rail; "All authors →" lives under it (authors view
    // unchanged). Check now is the same control wireReleaseCheck has
    // always owned, wearing a link's clothes.
    '<section class="disc-sec">' +
    '<div class="disc-sec-head"><h3 class="serif">' + icon('sparkles') + ' New releases</h3>' +
    '<button class="taplink" id="disc-rel-check">Check now</button></div>' +
    '<div class="disc-releases"><div id="release-results"><p class="note">New books from your authors land here.</p></div></div>' +
    '<button class="authors-row" data-dtile="authors">' +
    '<span class="disc-ic">' + icon('user') + '</span>' +
    '<span class="disc-tx"><b>All authors</b><small>Everyone on your shelves, A–Z</small></span>' +
    '<span class="disc-go" aria-hidden="true">→</span></button></section>' +

    // v535 (UX P2-6) stands: covenName() carries its article ("The
    // Hearth"), which doubled it after "From Your" — bare form here.
    // v538: the section is real now — a rail of the circle's picks,
    // not just a heading + link over nothing.
    '<section class="disc-sec">' +
    '<div class="disc-sec-head"><h3 class="serif">' + icon('friends') + ' From Your ' + esc(covenNameBare()) + '</h3>' +
    '<button class="taplink" id="disc-coven-all">Open →</button></div>' +
    '<div id="disc-hearth"><p class="note">Books your circle rates 4\u2605 or higher will land here.</p></div></section>'
  );
  wireReleaseCheck();
  renderVisibleReleases(); // v150: restore the release list across re-renders
  refreshRecommendations(); // v538: inline section — loads on arrival; the v536 memo keeps revisits cheap
  refreshDiscoverHearth();

  document.querySelectorAll('[data-dtile]').forEach(el => el.addEventListener('click', () => {
    const t = el.dataset.dtile;
    if (t === 'pick') go('pick');
    else if (t === 'authors') go('authors');
    // Releases is owned by wireReleaseCheck (shared with the Wishlist button).
  }));
  const browse = document.getElementById('disc-browse-tbr');
  if (browse) browse.addEventListener('click', () => {
    filter = 'tbr'; ownFilter = 'all'; query = ''; go('library');
  });
  const bdLink = document.getElementById('disc-blind-date');
  if (bdLink) bdLink.addEventListener('click', () => {
    if (typeof setBlindDate === 'function') setBlindDate(true);
    go('pick');
  });
  document.querySelectorAll('.seed-chip').forEach(chip => chip.addEventListener('click', async () => {
    const seed = library.find(b => b.id === chip.dataset.seed);
    if (!seed) return;
    if (recoLensSeedId === seed.id) { clearRecoLens(); return; }
    if (!visibleRecos.length) { try { await refreshRecommendations(); } catch (e) {} }
    showSimilarToSeed(seed);
  }));
  document.getElementById('disc-coven-all').addEventListener('click', () => go('coven'));
}

/* ---------------- Discover: From Your Hearth rail (v538) ----------------
   Friend picks on Discover ride the exact data path as the Hearth's own
   "You'd love this" (loadRecos, js/196): friends' 4★+ books not on her
   shelves, with the v524 shield exclusion and the v535 warning filter
   applied upstream — this is that list in cover-rail form. Tapping a
   card opens the same read-only preview the Hearth uses, and its
   ＋ Add to TBR resolves through recoCache — loadRecos keeps the array
   and the cache the same object, so the rail's indices line up. No
   friend-initial badges on covers (design critique cut): who loved a
   book is a quiet text line under it. */
function refreshDiscoverHearth() {
  const box = document.getElementById('disc-hearth');
  if (!box) return;
  const quiet = '<p class="note">Books your circle rates 4\u2605 or higher will land here.</p>';
  if (typeof loadRecos !== 'function') { box.innerHTML = quiet; return; }
  loadRecos().then(recos => {
    if (!document.body.contains(box)) return;
    if (!recos.length) { box.innerHTML = quiet; return; }
    box.innerHTML = '<div class="rail hearth-rail">' + recos.slice(0, 10).map((r, i) => {
      const b = r.book;
      const names = r.ratings.map(x => esc(String(x.name).split(' ')[0])).join(', ');
      return '<div class="rail-card hearth-card" data-i="' + i + '">' + recoCoverHTML(b) +
        '<h3 class="rail-title">' + esc(b.title) + '</h3>' +
        '<p class="rail-author">' + esc(displayAuthors(b.authors)) + '</p>' +
        '<p class="rail-why">' + stars(r.avg) + '</p>' +
        '<p class="rail-who">Loved by ' + names + '</p></div>';
    }).join('') + '</div>';
    box.querySelectorAll('.hearth-card').forEach(card => card.addEventListener('click', () => {
      const i = Number(card.dataset.i);
      const r = recos[i];
      if (r) openCovenRecoPreview(r, i);
    }));
  }).catch(() => { if (document.body.contains(box)) box.innerHTML = quiet; });
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
// v403: filter merchandise (tarot decks, coloring books, etc.) — Hardcover's
// books table includes non-book formats.
const RECO_MERCH_RE = /\b(tarot|coloring book|journal|calendar|poster|sticker|notebook|planner|deck|playmat|puzzle)\b/i;
function isRecoMerch(c) {
  const t = String((c && c.title) || '');
  return RECO_MERCH_RE.test(t);
}

/* ---------------- v530: one edition per work, print + language aware ----
   Hardcover models formats and translations as SEPARATE book records of the
   same work, and the pre-v530 sweep deduped by book id only — so one work
   could surface as its print record, its audiobook record and a dramatized
   record side by side, and foreign-language records landed in an English
   reader's list. The collapse below groups the whole sweep by work and
   keeps exactly one record per work:
     browser-language print → browser-language any-format →
     language-unknown print → language-unknown any-format,
   dropping records whose language is KNOWN to differ from the browser's.
   Catalog signals (verified against Hardcover's official GraphQL schema
   docs, hardcoverapp/hardcover-docs): books.audio_seconds (Int, "Audiobook
   duration in seconds"), books.default_audio_edition_id /
   default_physical_edition_id / default_ebook_edition_id, and the edition
   language name via editions.language { language } (books have no language
   field). Title / contributor patterns only supplement the catalog data.
   v533: production probing showed those edition signals are stated for
   only a small minority of records, so unstated records additionally go
   through a conservative stopword detector (recoDetectLangCode below) —
   the catalog's stated language still wins whenever one exists. */

// Pure: the browser's primary language subtag ('en' from 'en-CA'), '' when
// unavailable — '' disables language exclusion entirely.
function recoBrowserLang() {
  try {
    const l = (typeof navigator !== 'undefined' && navigator && navigator.language) || '';
    return String(l).split('-')[0].trim().toLowerCase();
  } catch (e) { return ''; }
}

// Language names (English exonyms + common endonyms) → ISO 639-1, for when
// Hardcover states a language as a name rather than a code.
const RECO_LANG_NAME_TO_CODE = {
  english: 'en', french: 'fr', 'français': 'fr', german: 'de', deutsch: 'de',
  spanish: 'es', 'español': 'es', italian: 'it', italiano: 'it',
  portuguese: 'pt', 'português': 'pt', dutch: 'nl', nederlands: 'nl',
  flemish: 'nl', russian: 'ru', 'русский': 'ru', japanese: 'ja', '日本語': 'ja',
  korean: 'ko', '한국어': 'ko', chinese: 'zh', '中文': 'zh',
  arabic: 'ar', 'العربية': 'ar', hindi: 'hi', 'हिन्दी': 'hi',
  polish: 'pl', polski: 'pl', swedish: 'sv', svenska: 'sv',
  norwegian: 'no', norsk: 'no', danish: 'da', dansk: 'da',
  finnish: 'fi', suomi: 'fi', czech: 'cs', 'čeština': 'cs',
  hungarian: 'hu', magyar: 'hu', turkish: 'tr', 'türkçe': 'tr',
  ukrainian: 'uk', 'українська': 'uk', greek: 'el', 'ελληνικά': 'el',
  hebrew: 'he', 'עברית': 'he', persian: 'fa', farsi: 'fa', 'فارسی': 'fa',
  thai: 'th', 'ภาษาไทย': 'th', vietnamese: 'vi', 'tiếng việt': 'vi',
  indonesian: 'id', 'bahasa indonesia': 'id', malay: 'ms',
  romanian: 'ro', 'română': 'ro', bulgarian: 'bg', 'български': 'bg',
  croatian: 'hr', hrvatski: 'hr', serbian: 'sr', 'српски': 'sr',
  slovak: 'sk', 'slovenčina': 'sk', slovenian: 'sl', 'slovenščina': 'sl',
  lithuanian: 'lt', 'lietuvių': 'lt', latvian: 'lv', 'latviešu': 'lv',
  estonian: 'et', eesti: 'et', catalan: 'ca', 'català': 'ca',
  basque: 'eu', euskara: 'eu', galician: 'gl', galego: 'gl',
  welsh: 'cy', cymraeg: 'cy', irish: 'ga', gaeilge: 'ga',
  icelandic: 'is', 'íslenska': 'is', albanian: 'sq', shqip: 'sq',
  macedonian: 'mk', 'македонски': 'mk', belarusian: 'be', 'беларуская': 'be',
  bosnian: 'bs', bosanski: 'bs', georgian: 'ka', 'ქართული': 'ka',
  armenian: 'hy', 'հայերեն': 'hy', azerbaijani: 'az', kazakh: 'kk',
  uzbek: 'uz', bengali: 'bn', 'বাংলা': 'bn', tamil: 'ta', 'தமிழ்': 'ta',
  telugu: 'te', 'తెలుగు': 'te', marathi: 'mr', 'मराठी': 'mr',
  urdu: 'ur', 'اردو': 'ur', swahili: 'sw', kiswahili: 'sw',
  amharic: 'am', 'አማርኛ': 'am', yoruba: 'yo', igbo: 'ig', hausa: 'ha',
  tagalog: 'tl', filipino: 'tl', burmese: 'my', 'မြန်မာ': 'my',
  khmer: 'km', 'ខ្មែរ': 'km', lao: 'lo', 'ລາວ': 'lo',
  mongolian: 'mn', 'монгол': 'mn', tibetan: 'bo', sinhala: 'si',
  'සිංහල': 'si', malayalam: 'ml', 'മലയാളം': 'ml', kannada: 'kn',
  'ಕನ್ನಡ': 'kn', gujarati: 'gu', 'ગુજરાતી': 'gu', punjabi: 'pa',
  'ਪੰਜਾਬੀ': 'pa', nepali: 'ne', 'नेपाली': 'ne', latin: 'la', esperanto: 'eo'
};
// ISO 639-2/3 → 639-1 for the common codes (Hardcover names languages, but
// a code-shaped value is handled too).
const RECO_LANG_6392_TO_1 = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it',
  por: 'pt', dut: 'nl', nld: 'nl', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh',
  zho: 'zh', ara: 'ar', hin: 'hi', pol: 'pl', swe: 'sv', nor: 'no', dan: 'da',
  fin: 'fi', ces: 'cs', cze: 'cs', hun: 'hu', tur: 'tr', ukr: 'uk', ell: 'el',
  gre: 'el', heb: 'he', fas: 'fa', per: 'fa', tha: 'th', vie: 'vi', ind: 'id',
  may: 'ms', msa: 'ms', ron: 'ro', rum: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr',
  slk: 'sk', slo: 'sk', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et', cat: 'ca',
  baq: 'eu', eus: 'eu', glg: 'gl', cym: 'cy', wel: 'cy', gle: 'ga', isl: 'is',
  ice: 'is', alb: 'sq', sqi: 'sq', mac: 'mk', mkd: 'mk', bel: 'be', bos: 'bs',
  kat: 'ka', geo: 'ka', hye: 'hy', arm: 'hy', aze: 'az', kaz: 'kk', uzb: 'uz',
  ben: 'bn', tam: 'ta', tel: 'te', mar: 'mr', urd: 'ur', swa: 'sw', amh: 'am',
  yor: 'yo', ibo: 'ig', hau: 'ha', fil: 'tl', tgl: 'tl', bur: 'my', mya: 'my',
  khm: 'km', lao: 'lo', mon: 'mn', tib: 'bo', bod: 'bo', sin: 'si', mal: 'ml',
  kan: 'kn', guj: 'gu', pan: 'pa', nep: 'ne', lat: 'la', epo: 'eo'
};

// Pure: normalize a catalog language value (name or code) to an ISO 639-1
// code. null when the catalog states no language at all (unknown — the
// caller fails open). A stated value we cannot map comes back as itself
// (lowercased): it is KNOWN, and it can never equal a browser subtag, so
// the record is treated as a language mismatch rather than as unknown.
function recoLangCode(raw) {
  const s = String(raw || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!s) return null;
  if (/^[a-z]{2}$/.test(s)) return s;
  if (/^[a-z]{3}$/.test(s)) return RECO_LANG_6392_TO_1[s] || s;
  return RECO_LANG_NAME_TO_CODE[s] || s;
}

/* v533: detection supplement for records the catalog leaves UNSTATED.
   Production probing (2026-10-13) showed Hardcover states a language for
   only a small minority of records — genuinely foreign records (Dutch,
   Italian) routinely arrive with no language on any edition, so the
   stated-language rules above never engage and the fail-open "unknown"
   tier lets them headline. Detection fills ONLY the unstated case:
   a stated language always wins, even when it looks wrong (one live
   English record is mislabeled "Persian" — a catalog error, documented
   here as a known casualty; correcting stated values is out of scope).

   Method: count function-word (stopword) hits per language over the
   record's own text. A language is called only on a clear win — at
   least RECO_DETECT_MIN_HITS hits AND a lead of RECO_DETECT_MIN_MARGIN
   over the runner-up. Below that bar the record stays unknown and
   fails open exactly as before: wrongly EXCLUDING a browser-language
   book is the worst outcome, so every tie or near-tie resolves to
   unknown. The title is scored on its own first — it is the record's
   own voice, and a clear title verdict stands even when an inherited
   description blurb in another language would outvote it combined. */
const RECO_DETECT_MIN_HITS = 3;
const RECO_DETECT_MIN_MARGIN = 2;
// Diacritic-folded forms (één→een, für→fur, não→nao) to match the
// folded token stream. Genuinely ambiguous words (was, war, will, door,
// ten) are deliberately absent from every list.
const RECO_DETECT_STOPWORDS = {
  en: ['the', 'of', 'and', 'a', 'an', 'in', 'to', 'is', 'are', 'be', 'been', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'his', 'her', 'their', 'our', 'your', 'my', 'him', 'them', 'this', 'that', 'these', 'those', 'with', 'for', 'on', 'at', 'by', 'from', 'as', 'but', 'not', 'no', 'if', 'or', 'so', 'than', 'then', 'when', 'while', 'who', 'which', 'all', 'any', 'more', 'most', 'other', 'some', 'only', 'over', 'under', 'into', 'about', 'after', 'before', 'between', 'through', 'during', 'out', 'up', 'down', 'here', 'there', 'where', 'how', 'can', 'could', 'would', 'should', 'do', 'does', 'did', 'have', 'has', 'had', 'one', 'two', 'first', 'now', 'just', 'even', 'still', 'also', 'very', 'much', 'many'],
  nl: ['de', 'het', 'een', 'van', 'in', 'is', 'ik', 'hij', 'zij', 'wij', 'dat', 'die', 'dit', 'deze', 'aan', 'met', 'ook', 'maar', 'als', 'bij', 'nog', 'wel', 'niet', 'zijn', 'haar', 'hun', 'mijn', 'naar', 'uit', 'over', 'onder', 'tussen', 'doorheen', 'voor', 'tegen', 'zonder', 'tijdens', 'na', 'tot', 'om', 'op', 'er', 'daar', 'hier', 'waar', 'wanneer', 'waarom', 'hoe', 'wie', 'wat', 'geen', 'werd', 'wordt', 'worden', 'hebben', 'heeft', 'kunnen', 'kan', 'zal', 'zullen', 'zou', 'zouden', 'moeten', 'moet', 'willen', 'wil', 'zelf', 'elkaar', 'samen', 'altijd', 'nooit', 'weer', 'heel', 'erg', 'toch', 'juist', 'eens', 'iets', 'niets', 'iemand', 'niemand', 'alles', 'veel', 'meer', 'andere', 'eigen', 'elke', 'beide', 'zo', 'nu', 'toen', 'omdat', 'zodat', 'terwijl', 'hoewel', 'den', 'des'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'und', 'ist', 'sind', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'sich', 'nicht', 'auch', 'als', 'an', 'am', 'ans', 'im', 'vom', 'von', 'zu', 'zum', 'zur', 'in', 'ins', 'auf', 'aus', 'bei', 'mit', 'nach', 'uber', 'fur', 'um', 'durch', 'gegen', 'ohne', 'unter', 'vor', 'zwischen', 'seit', 'bis', 'wenn', 'aber', 'doch', 'schon', 'noch', 'nur', 'so', 'wie', 'wo', 'wer', 'man', 'mein', 'meine', 'sein', 'seine', 'haben', 'hat', 'hatte', 'werden', 'wird', 'wurde', 'konnen', 'kann', 'mussen', 'muss', 'sollen', 'soll', 'machen', 'gibt', 'am'],
  fr: ['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'est', 'sont', 'et', 'a', 'au', 'aux', 'ce', 'cet', 'cette', 'ces', 'dans', 'en', 'sur', 'sous', 'chez', 'pour', 'par', 'avec', 'sans', 'vers', 'depuis', 'pendant', 'apres', 'avant', 'entre', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'ne', 'pas', 'se', 'lui', 'y', 'qui', 'que', 'quoi', 'dont', 'ou', 'mais', 'donc', 'alors', 'comme', 'quand', 'meme', 'aussi', 'tres', 'plus', 'moins', 'peu', 'beaucoup', 'toujours', 'jamais', 'souvent', 'maintenant', 'fait', 'ont', 'etre', 'avoir', 'suis', 'es', 'sommes', 'cela', 'celui', 'celle', 'ceux', 'ici'],
  es: ['el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'unos', 'unas', 'es', 'son', 'y', 'o', 'en', 'que', 'por', 'para', 'con', 'sin', 'sobre', 'entre', 'cuando', 'muy', 'mas', 'pero', 'sus', 'su', 'al', 'lo', 'como', 'ya', 'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso', 'mi', 'mis', 'tu', 'tus', 'nuestro', 'nuestra', 'le', 'les', 'me', 'te', 'se', 'nos', 'no', 'si', 'porque', 'tambien', 'hasta', 'desde', 'donde', 'quien', 'quienes', 'cual', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras', 'mismo', 'cada', 'tan', 'tanto', 'durante', 'segun', 'era', 'eran', 'fue', 'fueron', 'hay', 'han', 'ha', 'tiene', 'tienen', 'hace', 'puede', 'pueden', 'va', 'van'],
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'un', 'una', 'uno', 'che', 'e', 'non', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'nel', 'nella', 'nello', 'nei', 'negli', 'nelle', 'sul', 'sulla', 'sullo', 'al', 'alla', 'allo', 'ai', 'agli', 'alle', 'dal', 'dalla', 'dallo', 'dai', 'dagli', 'dalle', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle', 'anche', 'come', 'ma', 'se', 'piu', 'ci', 'ne', 'si', 'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mio', 'mia', 'miei', 'mie', 'tuo', 'tua', 'suo', 'sua', 'suoi', 'sue', 'nostro', 'nostra', 'sono', 'era', 'erano', 'siamo', 'siete', 'ho', 'hai', 'ha', 'abbiamo', 'avete', 'hanno', 'fatto', 'quando', 'dove', 'molto', 'tutto', 'tutta', 'tutti', 'tutte', 'cosa', 'cosi', 'perche', 'mentre', 'dopo', 'prima', 'senza', 'sotto', 'sopra', 'ancora', 'ogni', 'qualche', 'altro', 'altra', 'altri', 'altre', 'poco', 'quanto', 'gia', 'invece', 'forse', 'pero', 'dunque', 'quindi', 'allora', 'ora', 'stato', 'stata'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'pelo', 'pela', 'pelos', 'pelas', 'para', 'com', 'sem', 'que', 'e', 'nao', 'se', 'ao', 'aos', 'seu', 'sua', 'seus', 'suas', 'meu', 'minha', 'meus', 'minhas', 'ele', 'ela', 'eles', 'elas', 'voce', 'mais', 'muito', 'ja', 'quando', 'como', 'mas', 'tambem', 'sobre', 'entre', 'depois', 'antes', 'ate', 'so', 'sao', 'era', 'eram', 'foi', 'foram', 'tem', 'tinha', 'vai', 'vao', 'pode', 'podem', 'lhe', 'lhes', 'isso', 'isto', 'aquilo', 'esse', 'essa', 'este', 'esta', 'estes', 'estas', 'aquele', 'aquela', 'tudo', 'todo', 'toda', 'todos', 'todas', 'outro', 'outra', 'cada', 'mesmo', 'mesma', 'onde', 'quem', 'qual', 'quanto', 'pois', 'porque', 'porem', 'ainda', 'sempre', 'nunca', 'talvez', 'aqui', 'bem'],
};
const RECO_DETECT_SETS = {};
Object.keys(RECO_DETECT_STOPWORDS).forEach(code => {
  RECO_DETECT_SETS[code] = new Set(RECO_DETECT_STOPWORDS[code]);
});

// Pure: stopword hit counts per language for a text. Tokens are
// diacritic-folded lowercase letter runs.
function recoLangScores(text) {
  const scores = { en: 0, nl: 0, de: 0, fr: 0, es: 0, it: 0, pt: 0 };
  const toks = String(text || '').toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^\p{L}]+/u).filter(Boolean);
  toks.forEach(tok => {
    for (const code in RECO_DETECT_SETS) {
      if (RECO_DETECT_SETS[code].has(tok)) scores[code]++;
    }
  });
  return scores;
}

// Pure: the winning language from a score table, or null when the
// evidence is below the confidence bar (unknown — caller fails open).
function recoLangFromScores(scores) {
  let best = null, bestN = 0, secondN = 0;
  for (const code in scores) {
    const n = scores[code];
    if (n > bestN) { secondN = bestN; bestN = n; best = code; }
    else if (n > secondN) { secondN = n; }
  }
  return (best && bestN >= RECO_DETECT_MIN_HITS && bestN - secondN >= RECO_DETECT_MIN_MARGIN)
    ? best : null;
}

// Pure: detect a candidate's language from its own text (title first,
// then title + description). null = no confident call. Only meaningful
// for candidates with no stated language — see recoCandidateLangCode.
function recoDetectLangCode(c) {
  if (!c) return null;
  const fromTitle = recoLangFromScores(recoLangScores(c.title));
  if (fromTitle) return fromTitle;
  return recoLangFromScores(recoLangScores(
    String(c.title || '') + ' ' + String(c.description || '')));
}

// Pure: the language code a candidate is classified by — the catalog's
// stated language when there is one (it always wins), otherwise the
// detected language, otherwise null (unknown; ranking fails open).
function recoCandidateLangCode(c) {
  const stated = recoLangCode(c && c.langName);
  if (stated) return stated;
  return recoDetectLangCode(c);
}

// Pure: is this candidate an audiobook record? Primary signal is catalog
// data (book-level audio_seconds; an audio default edition with no print
// or ebook default). A record that HAS a physical default is the work's
// main record even when an audio edition also exists under it — only an
// audio-only default set marks the record itself as the audiobook.
// Title wording and a "Full Cast" dramatized-audio credit supplement.
const RECO_AUDIO_TITLE_RE = /\b(audiobook|audio book|unabridged|dramatized adaptation|graphic audio)\b/i;
function recoIsAudioRecord(c) {
  if (!c) return false;
  if (Number(c.audioSeconds) > 0) return true;
  if (c.defAudioId != null && c.defPhysId == null && c.defEbookId == null) return true;
  if (RECO_AUDIO_TITLE_RE.test(String(c.title || ''))) return true;
  const names = (c.authors || []).map(a => String(a || '').trim().toLowerCase());
  if (names.indexOf('full cast') !== -1) return true;
  return false;
}

// Pure: edition preference tier for one candidate under the browser
// language `want` (a 639-1 subtag, or '' to disable language handling).
// -1 = known language mismatch (excluded); lower tier wins within a work:
// 0 browser-lang print, 1 browser-lang any format, 2 unknown-lang print,
// 3 unknown-lang any format. With no browser language, everything is
// "unknown" (tiers 2/3) — print still beats audio, nothing is excluded.
function recoEditionRank(c, wantLang) {
  const want = String(wantLang || '').trim().toLowerCase();
  // v533: stated language wins; unstated records fall back to detection
  // (recoCandidateLangCode) so a confidently foreign record is a KNOWN
  // mismatch here, not an "unknown" that fails open.
  const code = recoCandidateLangCode(c);
  const audio = recoIsAudioRecord(c);
  if (want && code) {
    if (code !== want) return -1;
    return audio ? 1 : 0;
  }
  return audio ? 3 : 2;
}

// Pure: work grouping key — normalized title + first author. Modeled on
// js/150's looseTitleKey (parenthetical qualifiers are edition noise), but
// deliberately does NOT strip a " - …" suffix wholesale: distinct series
// entries like "Mistborn - The Well of Ascension" must not collapse into
// "Mistborn - The Final Empire". Only a trailing format phrase is cut.
// '' when there is no usable title (such candidates never group).
function recoWorkKey(c) {
  const t = String((c && c.title) || '')
    .replace(/\s*\[[^\]]*\]/g, ' ')
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/\s+[-–—:]\s*(audiobook|audio book|unabridged|dramatized adaptation|graphic audio)\b.*$/i, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^the /, '');
  if (!t) return '';
  const a = String(((c && c.authors) || [])[0] || '').trim().toLowerCase();
  return t + '|' + a;
}

/* v535 (audit #1): "Filter from discovery" for Recommended. Sweep
   candidates carry no warning data — Hardcover's books type has no
   content_warnings field; warnings live only on search-index docs —
   so the final ranked candidates (≤ RECO_FINAL_COUNT) are enriched via
   hcSearchDocs and matched against the reader's excluded set. The doc
   must verify as THIS work (ISBN or title/author) before its warnings
   count. Fail-open everywhere: no prefs, no taxonomy, a failed lookup,
   or an unverifiable doc all keep the candidate — a filter hiccup
   must never empty the list. Session-cached per work. */
const recoWarnCache = {};
async function recoCandidateWarnings(c) {
  const key = recoWorkKey(c);
  if (key && Object.prototype.hasOwnProperty.call(recoWarnCache, key)) return recoWarnCache[key];
  let warns = null;
  try {
    const shim = Object.assign({}, c, { isbn: (c.isbns && c.isbns[0]) || '' });
    const docs = await hcSearchDocs(shim);
    const doc = (docs || []).find(d => {
      try {
        if (c.isbns && c.isbns.length && typeof hcDocIsbnMatch === 'function' &&
            c.isbns.some(i => hcDocIsbnMatch(d, i))) return true;
        return typeof hcFallbackDocMatches === 'function' && hcFallbackDocMatches(d, shim);
      } catch (e) { return false; }
    });
    if (doc && Array.isArray(doc.content_warnings)) warns = doc.content_warnings.slice();
  } catch (e) { warns = null; }
  if (key) recoWarnCache[key] = warns;
  return warns;
}
async function recoApplyWarningFilter(ranked) {
  try {
    const prefs = (typeof getWarningPrefs === 'function') ? getWarningPrefs() : null;
    if (!prefs || !prefs.excluded || !prefs.excluded.length) return ranked;
    if (typeof warnHitIds !== 'function') return ranked;
    if (typeof primeWarningTaxonomy === 'function') { try { await primeWarningTaxonomy(); } catch (e) {} }
    const kept = [];
    for (const r of ranked) {
      const c = r && r.c;
      if (!c) { kept.push(r); continue; }
      let warns = (Array.isArray(c.contentWarnings) && c.contentWarnings.length) ? c.contentWarnings : null;
      if (!warns) warns = await recoCandidateWarnings(c);
      if (warns && warnHitIds(warns, prefs.excluded).length) continue;
      kept.push(r);
    }
    return kept;
  } catch (e) { return ranked; }
}

// Pure: collapse a swept candidate list to one record per work under the
// browser language. Known-language mismatches drop out; within a work the
// lowest recoEditionRank wins (ties keep the first swept — the sweep is
// newest-first per author, authors in loved order). Output order follows
// each work's first appearance, so the loved-author fallback ranking in
// refreshRecommendations keeps its shape on the non-embedded path too.
function collapseRecoWorks(cands, wantLang) {
  const order = [];
  const groups = new Map();
  (cands || []).forEach(c => {
    const rank = recoEditionRank(c, wantLang);
    if (rank < 0) return;
    const key = recoWorkKey(c);
    if (!key) { order.push({ c: c, rank: rank }); return; }
    const g = groups.get(key);
    if (!g) {
      const e = { c: c, rank: rank };
      groups.set(key, e);
      order.push(e);
    } else if (rank < g.rank) {
      g.c = c;
      g.rank = rank;
    }
  });
  return order.map(e => e.c);
}

// v530: the sweep asks Hardcover for the edition signals the collapse
// needs. If the extended query is ever rejected (schema drift), fall back
// per author to the pre-v530 field set — those candidates carry no
// signals, so they collapse as unknown-language print by title alone and
// recommendations degrade instead of vanishing. v533: the fallback is no
// longer silent — one AppLog line per affected sweep (visible in the
// Observatory log viewer), so a production schema change that strips
// every edition signal leaves a trace instead of shipping blind.
function recoSweepQuery(author, extended) {
  const fields = extended
    ? ' { id title description pages audio_seconds default_audio_edition_id' +
      ' default_physical_edition_id default_ebook_edition_id image { url }' +
      ' contributions { author { name } }' +
      ' default_physical_edition { isbn_13 language { language } }' +
      ' default_cover_edition { language { language } } } }'
    : ' { id title description pages image { url }' +
      ' contributions { author { name } } default_physical_edition { isbn_13 } } }';
  return 'query { books(where: {contributions: {author: {name: {_eq: ' + JSON.stringify(author) + '}}},' +
    ' canonical_id: {_is_null: true}}, order_by: {release_date: desc}, limit: 12)' + fields;
}
async function sweepRecoCandidates(authors, dismissed) {
  const out = [], seen = new Set();
  let fellBack = false;
  for (const a of (authors || []).slice(0, 6)) {
    try {
      let data = null;
      try { data = await hcGraphQL(recoSweepQuery(a, true)); }
      catch (e) { fellBack = true; data = await hcGraphQL(recoSweepQuery(a, false)); }
      ((data || {}).books || []).forEach(b => {
        if (b.id == null || seen.has(b.id)) return;
        if (dismissed.has('hc:' + b.id)) return;
        const c = hcBookToCandidate(b);
        if (releaseInLibrary(c)) return;
        if (isRecoMerch(c)) return; // v403: skip merchandise
        seen.add(b.id);
        c.loveAuthor = a;
        out.push(c);
      });
    } catch (e) { /* next author */ }
    await new Promise(r => setTimeout(r, 700)); // share the Hardcover pacing
  }
  if (fellBack) {
    try {
      if (typeof AppLog === 'object' && AppLog) {
        AppLog.warn('reco', 'extended edition-signal query rejected; legacy fallback used — recommendations carry no stated language/audio signals this sweep');
      }
    } catch (e) { /* logging must never break the sweep */ }
  }
  // v530: one edition per work across the WHOLE sweep, print preferred,
  // editions respecting the browser's language — before any ranking, so
  // the embedded path and the warming-up fallback collapse identically.
  return collapseRecoWorks(out, recoBrowserLang());
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
let visibleRecoSpice = {}; // v524: work-spice map for the visible candidates (shield)

// v219: tapping a recommendation opens the read-only preview modal —
// description, tropes, genres. The +TBR / dismiss buttons keep their
// stopPropagation so tapping them never opens the preview.
function openRecoPreview(r) {
  const c = r.c;
  const why = [];
  if (c.loveAuthor) {
    // v403: show "because you read X" with a specific book title if available
    const byAuthor = (typeof library !== 'undefined' ? library : [])
      .filter(b => (b.authors || []).some(a => String(a).trim().toLowerCase() === String(c.loveAuthor).trim().toLowerCase()))
      .sort((a, b) => (b.myRating || 0) - (a.myRating || 0));
    const exemplar = byAuthor[0];
    why.push('<span class="why-chip">' + icon('heart') + ' ' +
      (exemplar ? 'Because you read ' + esc(exemplar.title) : esc(c.loveAuthor)) + '</span>');
  }
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

// v538: the Recommended card is a rail card — cover, title, author, ONE
// compact why line, and the ＋TBR / ✕ row. The full why (loved author,
// shared tropes, match %) still lives in the preview sheet the cover
// opens. The why line's priority: the shield state (it changes what
// she sees), then match strength, then the loved author behind the pick.
function recoCardHTML(r, i, lovedIds) {
  const c = r.c;
  // v524: content shield — a candidate whose work is known high-spice
  // gets a blurred cover and a Shielded line (Discover candidates carry
  // no spice of their own; the work baseline is the only signal, and
  // unknown spice stays visible per the shield's unknown rule).
  const shieldedCover = (typeof shieldOn === 'function' && shieldOn() &&
    typeof shieldIsHighSpice === 'function' && shieldIsHighSpice(c, visibleRecoSpice));
  let why = '';
  if (shieldedCover) why = icon('eyeoff') + ' Shielded';
  else if (r.sim != null) why = '\u2248' + Math.round(r.sim * 100) + '% match';
  else if (c.loveAuthor) why = icon('heart') + ' ' + esc(c.loveAuthor);
  return '<div class="rail-card rel-card" data-i="' + i + '">' +
    coverHTML(c, 'reco-cover' + (shieldedCover ? ' shield-blur' : '')) +
    '<h3 class="rail-title">' + esc(c.title) + '</h3>' +
    '<p class="rail-author">' + esc(displayAuthors(c.authors)) + '</p>' +
    (why ? '<p class="rail-why">' + why + '</p>' : '') +
    '<div class="rail-acts">' +
    '<button class="btn small" data-add="' + i + '">\uFF0B TBR</button>' +
    '<button class="btn ghost small" data-dis="' + i + '" aria-label="Not for me">\u2715</button></div></div>';
}

// v538: the Recommended rail — shared by the full ranking and the seed
// lens subset (both render through wireRecoResults afterwards).
function recoRailHTML(ranked, lovedIds) {
  return '<div class="rail reco-rail">' + ranked.map((r, i) => recoCardHTML(r, i, lovedIds)).join('') + '</div>';
}

function wireRecoResults(box) {
  // v427 (issue #54): the cover gets an explicit preview handler. Tapping
  // the cover was falling through to +TBR on some devices — the cover now
  // opens the preview directly and never triggers the add button.
  box.querySelectorAll('.rel-card .reco-cover').forEach(cv => cv.addEventListener('click', e => {
    e.stopPropagation();
    const card = cv.closest('.rel-card');
    const r = card && visibleRecos[Number(card.dataset.i)];
    if (r) openRecoPreview(r);
  }));
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

function renderRecoResults(ranked, lovedIds, embedded, spiceMap) {
  const box = document.getElementById('disc-reco');
  if (!box) return;
  visibleRecos = ranked;
  visibleRecoLoved = lovedIds || [];
  visibleRecoSpice = spiceMap || {};
  // v538: a fresh full render supersedes any applied seed lens, and is
  // the restore point the lens clears back to. The section label is
  // static markup in renderDiscover now (v224's always-up label stands).
  recoLastRender = { ranked, lovedIds: visibleRecoLoved, embedded: !!embedded, spiceMap: visibleRecoSpice };
  recoLensSeedId = null;
  document.querySelectorAll('.seed-chip.on').forEach(c => c.classList.remove('on'));
  if (!ranked.length) {
    box.innerHTML = '<p class="note">Nothing new from your favorite authors right now \u2014 check back later \u2728</p>';
    return;
  }
  box.innerHTML =
    (embedded ? '' : '<p class="note">\u2726 Taste matching is still warming up \u2014 showing fresh picks from your favorite authors.</p>') +
    recoRailHTML(ranked, lovedIds) +
    '<p class="note" style="text-align:center"><button class="btn ghost small" id="reco-refresh">\u21BB Refresh</button></p>';
  wireRecoResults(box);
  const rf = document.getElementById('reco-refresh');
  if (rf) rf.addEventListener('click', () => refreshRecommendations(true)); // v536: the Refresh button is an explicit re-sweep, bypassing the memo
  track('reco_viewed', { count: ranked.length, embedded: !!embedded });
}
// v536 (UX P3-9): session memo for the ranked Recommended list. Every
// call used to re-run the whole pipeline -- work-id resolution, taste
// embeddings, the per-author Hardcover sweep (with its 700ms pacing),
// candidate embeddings -- so the list visibly collapsed and re-scanned
// after every add and on every revisit. The memo keeps the finished
// ranking for the session, keyed by a fingerprint of everything that
// shapes it (loved authors, the profile books with their ratings /
// favorite flags, the shield state). A render from the memo re-filters
// against the CURRENT library and dismissals, so a book just added (or
// dismissed elsewhere) drops out without a re-sweep, and any change
// that could move the ranking itself (a new finish, a re-rate, a new
// favorite) changes the fingerprint and sweeps fresh. The Refresh
// button passes force=true and always sweeps.
let _recoMemo = null;
function recoTasteFingerprint(authors, profBooks) {
  const shieldBit = (typeof shieldOn === 'function' && shieldOn()) ? '1' : '0';
  return (authors || []).join('\u01c2') + '#' + shieldBit + '#' +
    (profBooks || []).map(b => b.id + ':' + (b.myRating || 0) + (b.favorite ? 'f' : '')).join(',');
}
async function refreshRecommendations(force) {
  const box = document.getElementById('disc-reco');
  if (!box) return;
  try {
    // v214: profile books are finished reads AND favorites (favorites anchor
    // the profile at top weight, so a thin rating history still works).
    const profBooks = library.filter(b => b && (b.status === 'read' || b.favorite));
    if (!profBooks.length) {
      box.innerHTML = '<p class="note">Finish a few books or tap \u2661 on some favorites \u2014 your taste profile grows from the books you love.</p>';
      return;
    }
    const authors = topLovedAuthors(6);
    if (!authors.length) {
      box.innerHTML = '<p class="note">Rate a few finished books 4\u2605 or higher and I\u2019ll find your next obsession.</p>';
      return;
    }
    if (!force && _recoMemo && _recoMemo.fp === recoTasteFingerprint(authors, profBooks)) {
      const dismissedNow = await recoDismissedSet();
      const rankedNow = _recoMemo.ranked.filter(r => r && r.c &&
        !releaseInLibrary(r.c) && !dismissedNow.has('hc:' + r.c.hcId));
      renderRecoResults(rankedNow, recoLovedTropeIds(), _recoMemo.embedded, _recoMemo.spiceMap);
      return;
    }
    if (!hcReady()) {
      box.innerHTML = '<p class="note">Hardcover isn\u2019t available right now \u2014 recommendations need it. Try again later.</p>';
      return;
    }
  box.innerHTML = '<p class="note">' + icon('hourglass') + ' Reading your taste\u2026</p>';
    // Taste profile: weighted mean of her read books' and favorites'
    // work embeddings (v214: favorites included at top weight).
    // v496 (#141): resolve work ids in bounded-concurrency chunks instead of
    // one sequential lookup per book — the old loop dominated
    // time-to-first-result on large libraries. Output order and semantics
    // are identical to the sequential version.
    const withIds = [];
    const RESOLVE_CHUNK = 8;
    for (let i = 0; i < profBooks.length; i += RESOLVE_CHUNK) {
      const chunk = profBooks.slice(i, i + RESOLVE_CHUNK);
      const resolved = await Promise.all(chunk.map(async (b) => {
        try { const wid = await resolveWork(b); return wid ? { book: b, workId: wid } : null; }
        catch (e) { return null; }
      }));
      for (const r of resolved) if (r) withIds.push(r);
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
    // v535 (audit #1): warning-preference discovery filter (see
    // recoApplyWarningFilter). Runs on the final ranked list only, so
    // Similar Books (which reads renderRecoResults' output) inherits it.
    ranked = await recoApplyWarningFilter(ranked);
    // v524: content shield — fetch the work-spice map for the final
    // candidates so recoCardHTML can blur known high-spice covers.
    // Skipped entirely when the shield is off (zero behavior change).
    let spiceMap = {};
    if (typeof shieldOn === 'function' && shieldOn() && typeof shieldSpiceMapFor === 'function') {
      try { spiceMap = await shieldSpiceMapFor(ranked.map(r => r.c)); } catch (e) { spiceMap = {}; }
    }
    const embeddedNow = !!profile && ranked[0] && ranked[0].sim != null;
    _recoMemo = { fp: recoTasteFingerprint(authors, profBooks), ranked: ranked, embedded: embeddedNow, spiceMap: spiceMap };
    renderRecoResults(ranked, lovedIds, embeddedNow, spiceMap);
  } catch (e) {
    box.innerHTML = '<p class="note">Recommendations hiccuped \u2014 try again in a bit.</p>';
  }
}
