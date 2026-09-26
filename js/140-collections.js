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
