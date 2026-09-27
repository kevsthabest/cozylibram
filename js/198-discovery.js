'use strict';

/* ---------------- new-release discovery (v114) ---------------- */
// "Check for new releases": sweeps Hardcover for upcoming books by the authors
// she reads most, keeps only future release dates, and offers them as one-tap
// adds into the Wishlist's Coming soon section. Dismissed suggestions never
// come back.

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

function releaseInLibrary(doc) {
  const isbns = (doc.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  if (isbns.length && library.some(b => b.isbn && isbns.indexOf(b.isbn) !== -1)) return true;
  const t = String(doc.title || '').toLowerCase().trim();
  const a = String((doc.author_names || [])[0] || '').toLowerCase().trim();
  if (!t) return false;
  return library.some(b => String(b.title || '').toLowerCase().trim() === t &&
    String((b.authors || [])[0] || '').toLowerCase().trim() === a);
}

function releaseCandidate(doc) {
  return {
    hcId: doc.id,
    title: doc.title || 'Untitled',
    authors: (doc.author_names || []).map(String).slice(0, 3),
    releaseDate: String(doc.release_date || '').slice(0, 10),
    cover: (doc.image && doc.image.url) || '',
    description: doc.description || '',
    pages: doc.pages || null,
    isbns: doc.isbns || []
  };
}

async function checkNewReleases(onTick) {
  const authors = topReleaseAuthors(8);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < authors.length; i++) {
    const a = authors[i];
    if (onTick) onTick(a, i + 1, authors.length);
    try {
      const data = await hcGraphQL('query { search(query: ' + JSON.stringify(a) +
        ', query_type: "Book", per_page: 10) { results } }');
      hcHits(data).map(h => h.document).filter(Boolean).forEach(doc => {
        const names = (doc.author_names || []).map(String);
        if (!names.some(n => n.toLowerCase() === a.toLowerCase())) return; // actually theirs
        const du = daysUntil(String(doc.release_date || '').slice(0, 10));
        if (du == null || du < 0) return; // already out, or dateless
        if (doc.id == null || seen.has(doc.id) || isReleaseDismissed(doc.id)) return;
        seen.add(doc.id);
        if (releaseInLibrary(doc)) return;
        out.push(releaseCandidate(doc));
      });
    } catch (e) { /* one author failing never kills the sweep */ }
    await new Promise(r => setTimeout(r, 1100)); // share the Hardcover pacing
  }
  out.sort((x, y) => x.releaseDate.localeCompare(y.releaseDate));
  return out;
}

function addReleaseBook(c) {
  const clean = (c.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  const book = {
    id: uid(),
    isbn: clean.find(i => i.length === 13) || clean[0] || '',
    title: c.title, authors: c.authors, cover: c.cover, description: c.description,
    pageCount: c.pages, publishedDate: '', releaseDate: c.releaseDate,
    categories: [], publicRating: null, ratingsCount: 0,
    status: 'tbr', owned: false, ratings: {}, myRating: 0,
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
      const list = await checkNewReleases((a, i, n) => {
        btn.innerHTML = icon('hourglass') + ' Checking ' + esc(a) + '… (' + i + '/' + n + ')';
      });
      renderReleaseResults(list);
    } catch (e) {
      const box = document.getElementById('release-results');
      if (box) box.innerHTML = '<p class="note">The check failed — try again in a bit.</p>';
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  });
}
