'use strict';

/* ---------------- detail modal ---------------- */
/* ---- author / series collections: "more like this" from your own shelves ---- */
function collectionRowHTML(b) {
  const sub = (b.series && b.series.name
    ? '📚 ' + esc(b.series.name) +
      (b.series.position != null && b.series.position !== '' ? ' #' + esc(String(b.series.position)) : '') + ' · '
    : '') +
    esc((b.authors || []).join(', ') || 'Unknown author') + ' · ' + STATUS[b.status];
  return '<button class="crow" data-book="' + b.id + '">' +
    (b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<span class="cnocover">📕</span>') +
    '<span class="ctext"><b>' + esc(b.title) + '</b><small>' + sub + '</small></span>' +
    '<span class="cgo">›</span></button>';
}

/* ---------------- series overview (v76) ---------------- */
// Every series on her shelves: owned vs read progress plus the next unread
// she already owns. Progress is stated honestly — "X of Y you own", never an
// invented series total (Hardcover provides no dependable totals).
let seriesReturn = 'library';
function seriesData() {
  const byKey = {};
  library.forEach(b => {
    const sn = b.series && b.series.name;
    if (!sn) return;
    const k = String(sn).trim().toLowerCase();
    if (!byKey[k]) byKey[k] = { name: String(sn).trim(), books: [] };
    byKey[k].books.push(b);
  });
  const pos = b => {
    const p = parseFloat(b.series && b.series.position);
    return isNaN(p) ? 1e9 : p;
  };
  return Object.values(byKey).map(s => {
    s.books.sort((a, b) => pos(a) - pos(b) ||
      String(a.title || '').localeCompare(String(b.title || '')));
    s.read = s.books.filter(b => b.status === 'read').length;
    s.next = s.books.find(b => b.status !== 'read' && b.status !== 'dnf') || null;
    const authors = [];
    s.books.forEach(b => (b.authors || []).forEach(a => { if (!authors.includes(a)) authors.push(a); }));
    s.authorLine = authors.slice(0, 2).join(', ');
    return s;
  }).sort((a, b) => {
    const an = a.next ? 0 : 1, bn = b.next ? 0 : 1; // series with a next unread first
    if (an !== bn) return an - bn;
    if (b.books.length !== a.books.length) return b.books.length - a.books.length;
    return a.name.localeCompare(b.name);
  });
}
function renderSeries() {
  const all = seriesData();
  let html = '<button class="btn ghost" id="sr-back">← Back</button>' +
    '<h2 class="section serif" style="font-size:26px;margin-top:10px">📚 Series' +
    (all.length ? ' <span class="note-inline">· ' + all.length + '</span>' : '') + '</h2>';
  if (!all.length) {
    html += '<div class="empty"><div class="big">📚</div><h2 class="serif">No series yet</h2>' +
      '<p>Series info arrives automatically<br>with Hardcover enrichment.</p></div>';
  } else {
    html += '<div class="sr-list">' + all.map(s => {
      const pct = Math.round(s.read / s.books.length * 100);
      const covers = s.books.slice(0, 6).map(b =>
        b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" title="' + esc(b.title) + '">'
                : '<span class="sr-nocover" title="' + esc(b.title) + '">📕</span>').join('');
      const posTag = (s.next && s.next.series && s.next.series.position != null && s.next.series.position !== '')
        ? ' <span class="note-inline">#' + esc(String(s.next.series.position)) + '</span>' : '';
      return '<div class="sr-card"><div class="sr-head"><div><div class="sr-name">' + esc(s.name) + '</div>' +
        (s.authorLine ? '<div class="sr-author">' + esc(s.authorLine) + '</div>' : '') + '</div>' +
        '<span class="sr-count">' + s.read + ' / ' + s.books.length + ' read</span></div>' +
        '<div class="sr-covers">' + covers +
        (s.books.length > 6 ? '<span class="sr-more">+' + (s.books.length - 6) + '</span>' : '') + '</div>' +
        '<div class="progress-line"><div class="fill" style="width:' + pct + '%"></div></div>' +
        (s.next
          ? '<button class="sr-next" data-id="' + s.next.id + '">⏭️ Next: <b>' + esc(s.next.title) +
            '</b>' + posTag + ' <span class="cgo">›</span></button>'
          : (s.read === s.books.length
              ? '<div class="sr-done">✅ Everything you own is read</div>'
              : '<div class="sr-done">🚫 The rest are DNF</div>')) +
        '</div>';
    }).join('') + '</div>';
  }
  setView(html);
  document.getElementById('sr-back').addEventListener('click', () => go(seriesReturn));
  document.querySelectorAll('.sr-next').forEach(btn =>
    btn.addEventListener('click', () => openDetail(btn.dataset.id)));
}
