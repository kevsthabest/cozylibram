'use strict';
/* v97 — "You'd love this": recommendations from friends' highly-rated books.
 *
 * A book becomes a recommendation when at least one friend rates it 4★ or
 * higher (their own myRating) and it isn't already on your shelves. Only
 * books the friend actually shares reach us — hidden shelves and the
 * share-library toggle are enforced by Supabase RLS before we ever see them.
 */

// Candidates for the "+ TBR" buttons, rebuilt by loadRecos().
let recoCache = [];

// Stable dedupe key: ISBN when we have one, else normalized title + author.
function recoKey(b) {
  const isbn = String(b.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (isbn) return 'isbn:' + isbn;
  const t = String(b.title || '').trim().toLowerCase();
  if (!t) return '';
  const a = String(((b.authors || [])[0] || '')).trim().toLowerCase();
  return 'ta:' + t + '|' + a;
}

// Load and aggregate recommendations across all friends.
// Returns [{ book, ratings: [{friendId, name, rating}], count, avg }]
async function loadRecos() {
  recoCache = [];
  if (!cloudUser) return [];
  let friends = [];
  try { friends = (await circleLists()).friends || []; } catch (e) { return []; }
  if (!friends.length) return [];
  const mine = new Set();
  (library || []).forEach(b => { const k = recoKey(b); if (k) mine.add(k); });
  const byKey = {};
  for (const f of friends) {
    let books = [];
    try { books = await circleFriendBooks(f.id); } catch (e) { continue; }
    books.forEach(b => {
      const r = Number(b.myRating) || 0;
      if (r < 4) return; // v97: only 4★+ earns a recommendation
      const k = recoKey(b);
      if (!k || mine.has(k)) return;
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

function recoSectionHTML(recos) {
  let html = '<div class="circle-card"><h3 style="margin:0 0 4px">You\u2019d love this</h3>' +
    '<p class="note" style="margin:0 0 10px">Books your friends rated 4\u2605 or higher that aren\u2019t on your shelves yet.</p>' +
    '<div class="circle-list">';
  recos.slice(0, 15).forEach((r, i) => {
    const b = r.book;
    const names = r.ratings.map(x => esc(String(x.name).split(' ')[0])).join(', ');
    html += '<div class="circle-row">' + coverHTML(b, 'reco-cover') +
      '<div class="circle-meta"><b>' + esc(b.title) + '</b>' +
      '<span class="note">' + stars(r.avg) + ' \u00b7 loved by ' + names + '</span></div>' +
      '<div class="circle-actions"><button class="btn sm" data-reco-add="' + i + '">\uFF0B TBR</button></div></div>';
  });
  html += '</div></div>';
  return html;
}

// Fill the #reco-slot left by renderCovenMain; safe to call repeatedly.
function refreshRecos() {
  const slot = document.getElementById('reco-slot');
  if (!slot) return;
  loadRecos().then(recos => {
    if (!document.body.contains(slot)) return; // user navigated away mid-load
    slot.innerHTML = recos.length ? recoSectionHTML(recos) : '';
    slot.querySelectorAll('[data-reco-add]').forEach(btn => {
      btn.addEventListener('click', () => recoAddToTBR(Number(btn.dataset.recoAdd)));
    });
  }).catch(() => {});
}

// Add a recommendation to the TBR shelf. The friend's personal data
// (their rating, progress, dates) never comes along — just the book.
function recoAddToTBR(idx) {
  const r = recoCache[idx];
  if (!r) return;
  const src = r.book;
  const nb = {
    id: uid(),
    title: src.title || 'Untitled',
    authors: (src.authors || []).slice(),
    isbn: src.isbn || '',
    cover: src.cover || '',
    coverColor: src.coverColor || '',
    status: 'tbr',
    series: src.series || '',
    seriesPos: src.seriesPos || '',
    genres: (src.genres || []).slice(),
    description: src.description || '',
    pageCount: src.pageCount || 0,
    publishedDate: src.publishedDate || '',
    _mtime: Date.now(),
  };
  if (addBook(nb, false)) renderCoven(); // re-render picks up the now-owned book
}
