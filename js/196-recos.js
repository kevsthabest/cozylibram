'use strict';
/* v97 — "You'd love this": recommendations from friends' highly-rated books.
 *
 * A book becomes a recommendation when at least one friend rates it 4★ or
 * higher (their own myRating) and it isn't already on your shelves. Only
 * books the friend actually shares reach us — hidden shelves and the
 * share-library toggle are enforced by Supabase RLS before we ever see them.
 */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
// Candidates for the "+ TBR" buttons, rebuilt by loadRecos().
export let recoCache = [];

// v454: cover fallback chain — stored cover -> coverColor placeholder with
// title initial -> line-art icon. Never an empty dark square.
export function recoCoverHTML(b) {
  if (b.cover) {
    return '<div class="cover-wrap reco-cover"><img src="' + esc(b.cover) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()"></div>';
  }
  const initial = esc(String(b.title || '?').trim().charAt(0).toUpperCase() || '?');
  const bg = b.coverColor ? ' style="background:' + esc(b.coverColor) + '"' : '';
  return '<div class="cover-wrap reco-cover"' + bg + '><span class="cover-initial">' + initial + '</span></div>';
}

// Stable dedupe key: ISBN when we have one, else normalized title + author.
export function recoKey(b) {
  const isbn = String(b.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (isbn) return 'isbn:' + isbn;
  const t = String(b.title || '').trim().toLowerCase();
  if (!t) return '';
  const a = String(((b.authors || [])[0] || '')).trim().toLowerCase();
  return 'ta:' + t + '|' + a;
}

// Load and aggregate recommendations across all friends.
// Returns [{ book, ratings: [{friendId, name, rating}], count, avg }]
export async function loadRecos() {
  recoCache = [];
  if (!cloudUser) return [];
  let friends = [];
  try { friends = (await circleLists()).friends || []; } catch (e) { return []; }
  // v522: recommendations are built from friends' ratings — reading
  // activity. Friends who haven't opted in to sharing activity are left
  // out entirely (their shelves still browse in the circle as usual).
  friends = friends.filter(f => !(f.profile && f.profile.share_activity === false));
  if (!friends.length) return [];
  const mine = new Set();
  (library || []).forEach(b => { const k = recoKey(b); if (k) mine.add(k); });
  // v532 (remediation Batch A, Strategist #2): a book already
  // sitting in the viewer's Thought-of-you inbox is being
  // recommended by a person, on purpose — the same work shouldn't
  // ALSO headline this list while the card lives (the inbox's
  // 60-day life). Keys come from js/232's inbox helper; any failure
  // there means no suppression, never broken recos.
  const inInbox = new Set();
  if (typeof toyInboxKeys === 'function') {
    try { (await toyInboxKeys()).forEach(k => inInbox.add(k)); } catch (e) { /* suppression is a courtesy, not a gate */ }
  }
  const byKey = {};
  // v496 (#140): fetch all friends' shelves concurrently instead of one
  // sequential round-trip per friend. Aggregation is order-independent
  // (keyed map + final sort), and a failed fetch still skips that friend.
  const fetched = await Promise.all(friends.map(f =>
    circleFriendBooks(f.id).then(books => ({ f: f, books: books }), () => null)
  ));
  // v524: content shield — adult (high-spice) titles are excluded from
  // "You'd love this" for a shielded viewer: not blurred, gone. The
  // filter runs over the fetched copies only; nothing about the
  // friends' data changes. Shield off → this block is skipped entirely.
  const shielded = typeof shieldOn === 'function' && shieldOn();
  let spiceMap = {};
  if (shielded && typeof shieldSpiceMapFor === 'function') {
    const all = [];
    fetched.forEach(r => { if (r) (r.books || []).forEach(b => all.push(b)); });
    try { spiceMap = await shieldSpiceMapFor(all); } catch (e) { spiceMap = {}; }
  }
  // v535 (audit #1): warning preferences — "Filter from discovery"
  // finally applies. Friend copies carry their own contentWarnings
  // (exact, owner-side data), so no enrichment is needed here; a book
  // matching an excluded warning never enters the list.
  const wprefs = (typeof getWarningPrefs === 'function') ? getWarningPrefs() : null;
  const wfilter = !!(wprefs && wprefs.excluded && wprefs.excluded.length &&
    typeof warnBookExcluded === 'function');
  if (wfilter && typeof primeWarningTaxonomy === 'function') {
    try { await primeWarningTaxonomy(); } catch (e) { /* labels still resolve by slug */ }
  }
  for (const r of fetched) {
    if (!r) continue;
    const f = r.f;
    const books = r.books;
    books.forEach(b => {
      if (shielded && typeof shieldIsHighSpice === 'function' && shieldIsHighSpice(b, spiceMap)) return;
      if (wfilter && warnBookExcluded(b, wprefs)) return;
      const r = Number(b.myRating) || 0;
      if (r < 4) return; // v97: only 4★+ earns a recommendation
      const k = recoKey(b);
      if (!k || mine.has(k) || inInbox.has(k)) return;
      if (!byKey[k]) byKey[k] = { book: b, ratings: [] };
      if (!byKey[k].ratings.some(x => x.friendId === f.id))
        byKey[k].ratings.push({ friendId: f.id, name: f.name || 'A friend', rating: r });
    });
  }
  const recos = Object.keys(byKey).map(k => {
    const e = byKey[k];
    const avg = e.ratings.reduce((s, x) => s + x.rating, 0) / e.ratings.length;
    return { book: e.book, ratings: e.ratings, count: e.ratings.length, avg: avg };
  });
  // Most-loved first: more friends recommending beats a higher average.
  recos.sort((a, b) => b.count - a.count || b.avg - a.avg);
  recoCache = recos;
  return recos;
}

export function recoSectionHTML(recos) {
  let html = '<div class="circle-card"><h3 style="margin:0 0 4px">You\u2019d love this</h3>' +
    '<p class="note" style="margin:0 0 10px">Books your friends rated 4\u2605 or higher that aren\u2019t on your shelves yet.</p>' +
    '<div class="circle-list">';
  recos.slice(0, 15).forEach((r, i) => {
    const b = r.book;
    const names = r.ratings.map(x => esc(String(x.name).split(' ')[0])).join(', ');
    html += '<div class="circle-row">' + recoCoverHTML(b) +
      '<div class="circle-meta"><b>' + esc(b.title) + '</b>' +
      '<span class="note">' + stars(r.avg) + ' \u00b7 loved by ' + names + '</span></div>' +
      '<div class="circle-actions"><button class="btn sm" data-reco-add="' + i + '">\uFF0B TBR</button></div></div>';
  });
  html += '</div></div>';
  return html;
}

// Fill the #reco-slot left by renderCovenMain; safe to call repeatedly.
export function refreshRecos() {
  const slot = document.getElementById('reco-slot');
  if (!slot) return;
  loadRecos().then(recos => {
    if (!document.body.contains(slot)) return; // user navigated away mid-load
    slot.innerHTML = recos.length ? recoSectionHTML(recos) : '';
    if (recos.length) {
      track('recommendation_opened', { source: 'coven' }, { dedupeKey: 'reco-open' });
      // v532 (RC2): recommendations landed → js/197's Discover-tab
      // empty-state note has done its job.
      const note = document.getElementById('discover-empty-note');
      if (note) note.remove();
    }
    slot.querySelectorAll('[data-reco-add]').forEach(btn => {
      btn.addEventListener('click', () => recoAddToTBR(Number(btn.dataset.recoAdd)));
    });
    // v219: tapping the row itself opens the read-only preview modal
    slot.querySelectorAll('.circle-row').forEach((row, i) => {
      row.addEventListener('click', e => {
        if (e.target.closest('[data-reco-add]')) return;
        const r = recos[i];
        if (r) openCovenRecoPreview(r, i);
      });
    });
  }).catch(() => {});
}

// v219: clean-copy builder shared by the +TBR button and the preview modal.
// The friend's personal data (their rating, progress, dates) never comes
// along — just the book, per the v97 rule.
// v492: run through migrateBook() so the copy has the full book shape
// (tropes, ratings, log, etc.) like every other ingestion path.
export function covenCleanCopy(src) {
  return migrateBook({
    id: uid(),
    title: src.title || 'Untitled',
    authors: (src.authors || []).slice(),
    isbn: src.isbn || '',
    cover: src.cover || '',
    coverColor: src.coverColor || '',
    status: 'tbr',
    // v535 (audit #18): align with addRecoBook (js/198) — a book added
    // from someone else's shelf isn't in hand yet, so the ownership
    // facet is 'tobuy' (status carries the shelf, owned is purely the
    // ownership facet since v529; migrateBook's 'owned' default was
    // skewing Purchase Ledger / to-buy counts).
    // v559: unchanged mechanically — and the born pair (tbr + tobuy)
    // is wishlist-visible by derivation, which is the unified model
    // working as decided, not a side effect.
    owned: 'tobuy',
    series: (src.series && typeof src.series === 'object') ? src.series : null,
    seriesPos: src.seriesPos || '',
    genres: (src.genres || []).slice(),
    categories: (src.categories || []).slice(),
    description: src.description || '',
    pageCount: src.pageCount || 0,
    publishedDate: src.publishedDate || '',
    _mtime: Date.now(),
  });
}

// Add a recommendation to the TBR shelf. Returns the new book's id (v219),
// or null when the add didn't happen (already on her shelves).
export function recoAddToTBR(idx) {
  const r = recoCache[idx];
  if (!r) return null;
  const added = addBook(covenCleanCopy(r.book), false, 'recommendation');
  if (!added) return null;
  track('friend_recommendation_used');
  renderCoven(); // re-render picks up the now-owned book
  return added.id;
}

// v219: tapping a friend recommendation opens the read-only preview modal.
export function openCovenRecoPreview(r, idx) {
  const names = r.ratings.map(x => esc(String(x.name).split(' ')[0])).join(', ');
  const why = ['<span class="why-chip">' + icon('heart') + ' loved by ' + names + '</span>'];
  if (r.avg) why.push('<span class="why-chip">' + stars(r.avg) + '</span>');
  openPreviewModal(previewTransient(r.book, 'coven-reco'), {
    source: 'coven-reco',
    why: why,
    onAddTBR: () => {
      const id = recoAddToTBR(idx);
      return id ? { id: id } : null;
    }
  });
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/195-coven.js, js/197-social-stats.js, js/198-discovery.js, js/232-thought-of-you.js, js/233-buddy-reads.js, js/234-outbox.js, js/235-reading-it-too.js and js/242-marginalia.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.recoCache = recoCache;
window.recoCoverHTML = recoCoverHTML;
window.recoKey = recoKey;
window.loadRecos = loadRecos;
window.recoSectionHTML = recoSectionHTML;
window.refreshRecos = refreshRecos;
window.covenCleanCopy = covenCleanCopy;
window.recoAddToTBR = recoAddToTBR;
window.openCovenRecoPreview = openCovenRecoPreview;
