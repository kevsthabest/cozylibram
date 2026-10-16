'use strict';

/* ---- The Finale (series-finish ceremony + keepsake + wax seal) ----
   When a reader finishes a series, the moment gets marked: a ceremony
   card presents once per series, the keepsake lives in the series view,
   and a wax seal marks the series — but ONLY on an honest claim.

   THE HONESTY RULE (earned, not guessed):
   - "Series complete" + the wax seal require the series total to be
     KNOWN and MET: Hardcover's series listing was found (fetchSeriesBooks
     `found`), the reader owns everything the listing holds (the v108
     union total equals the library count), and the just-finished book
     sits at the listing's last position.
   - Otherwise the honour is "All caught up" — true of her shelf, silent
     about the bibliography — and there is never a seal.
   - A manual "Mark as finished" (series view) produces the caught-up
     card, never the seal — even if the total happens to be known and
     met. The seal is earned through the detection path only.
   - Detection runs on the mark-read path only (book modal save, shelf
     move). Imports/backfills never fire ceremonies. Re-reads don't
     re-trigger: a record exists per series, and the ceremony presents
     once — except the one upgrade that matters: a caught-up record the
     detection path later proves complete is upgraded (and presented),
     because the seal rule would otherwise lie by omission.

   Records live in localStorage 'cozylibram.finale.v1' (a map keyed by
   the seriesData key) and roam in their own user_state section
   (finale_state, js/229) — a reader detail, so it syncs like the other
   sections; never in the frozen settings snapshot, never in profiles.

   Spec: docs/series-finale-spec.md. Not a milestone: this never enters
   the milestone catalogue (spec section 6). */

/* ---------------- pure evaluation ---------------- */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */

export function finaleSeriesKey(name) {
  return String(name || '').trim().toLowerCase();
}

export function finalePos(b) {
  const p = parseFloat(b && b.series && b.series.position);
  return isNaN(p) ? null : p;
}

/* The series' books from a library array, in reading order — the same
   grouping/ordering as seriesData() (js/140). */
export function finaleSeriesBooks(lib, name) {
  const key = finaleSeriesKey(name);
  if (!key || !Array.isArray(lib)) return [];
  return lib.filter(b => b && b.series && finaleSeriesKey(b.series.name) === key)
    .slice()
    .sort((a, b) => {
      const pa = finalePos(a), pb = finalePos(b);
      const ka = pa == null ? 1e9 : pa, kb = pb == null ? 1e9 : pb;
      if (ka !== kb) return ka - kb;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
}

export function finaleAllRead(books) {
  return books.length > 0 && books.every(b => b.status === 'read');
}

/* The finished book must be the highest-positioned book in the library.
   When NO book carries a position, the completing read is the finale
   (positions are metadata garnish, not the reader's fault). When some
   books are positioned and the finished one is not, highest can't be
   verified — no auto finale; the manual override covers that shelf. */
export function finaleIsHighest(books, finishedId) {
  const fin = books.find(b => b.id === finishedId);
  if (!fin) return false;
  const known = books.map(finalePos).filter(p => p != null);
  if (!known.length) return true;
  const fp = finalePos(fin);
  if (fp == null) return false;
  return fp >= Math.max.apply(null, known);
}

/* Last position across the library books and the listing rows. */
export function finaleMaxPos(books, rows) {
  let m = null;
  const eat = p => { if (p != null && !isNaN(p) && (m == null || p > m)) m = p; };
  (books || []).forEach(b => eat(finalePos(b)));
  (rows || []).forEach(r => {
    const p = parseFloat(r && r.position);
    eat(isNaN(p) ? null : p);
  });
  return m;
}

/* The verdict. listing is null (total unknown) or { total, maxPos } from
   a FOUND Hardcover listing. Returns 'complete' | 'caughtup' | null
   (null = no finale: not a series, not library-complete, or the wrong
   book finished last). */
export function finaleKindFor(books, finishedId, listing) {
  if (!Array.isArray(books) || books.length < 2) return null;
  const fin = books.find(b => b.id === finishedId);
  if (!fin || fin.status !== 'read') return null;
  if (!finaleAllRead(books)) return null;
  if (!finaleIsHighest(books, finishedId)) return null;
  if (listing && listing.total != null && books.length >= listing.total &&
      (listing.maxPos == null || finalePos(fin) === listing.maxPos)) {
    return 'complete';
  }
  return 'caughtup';
}

/* The seal is a pure function of the record kind — nothing else in the
   app may grant it. */
export function finaleHasSeal(rec) {
  return !!rec && rec.kind === 'complete';
}

/* ---------------- records ---------------- */

/* No character-favourites source exists in the app today (characters
   live in the corpus; readers can't favourite one yet), so this returns
   null and the keepsake/ceremony simply omit the line — the spec's
   clause is conditional ("if the reader has one favorited"), and an
   absent line beats an invented favourite. Wire a real source here
   when one exists. */
export function finaleFavCharacter(books) {
  return null;
}

export function finaleBuildRecord(books, finished, kind, opts) {
  const dates = books.map(b => b.dateFinished).filter(Boolean).sort();
  const finDate = (finished && finished.dateFinished) || dates[dates.length - 1] || null;
  return {
    kind: kind,
    at: Date.now(),
    name: String((finished && finished.series && finished.series.name) ||
      (books[0] && books[0].series && books[0].series.name) || '').trim(),
    count: books.length,
    pages: books.reduce((n, b) => n + (Number(b.pageCount) > 0 ? Number(b.pageCount) : 0), 0),
    first: dates[0] || null,
    last: finDate,
    ratings: books.map(b => {
      const r = Math.round(Number(b.myRating) || 0);
      return r < 0 ? 0 : r > 5 ? 5 : r;
    }),
    favChar: finaleFavCharacter(books),
    override: !!(opts && opts.override),
    seen: false,
  };
}

/* Validate/coerce a stored record; null when it isn't one. The kind is
   the load-bearing field — an unknown kind drops the record rather
   than risk rendering an honour the data doesn't support. */
export function finaleNormalizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (r.kind !== 'complete' && r.kind !== 'caughtup') return null;
  const iso = v => (typeof v === 'string' && v && !isNaN(Date.parse(v))) ? v : null;
  return {
    kind: r.kind,
    at: Number(r.at) || 0,
    name: String(r.name || '').slice(0, 200),
    count: Math.max(0, Math.min(100000, Math.round(Number(r.count) || 0))),
    pages: Math.max(0, Math.min(100000000, Math.round(Number(r.pages) || 0))),
    first: iso(r.first),
    last: iso(r.last),
    ratings: (Array.isArray(r.ratings) ? r.ratings : []).slice(0, 500).map(v => {
      const n = Math.round(Number(v) || 0);
      return n < 0 ? 0 : n > 5 ? 5 : n;
    }),
    favChar: (typeof r.favChar === 'string' && r.favChar) ? r.favChar.slice(0, 200) : null,
    override: r.override === true,
    seen: r.seen === true,
  };
}

export function finaleNormalize(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const k of Object.keys(v)) {
    if (Object.keys(out).length >= 500) break;
    const rec = finaleNormalizeRecord(v[k]);
    if (rec) out[String(k).slice(0, 200)] = rec;
  }
  return out;
}

/* ---------------- store ---------------- */

export const FINALE_STORE_KEY = 'cozylibram.finale.v1';

export function loadFinales() {
  try {
    const raw = localStorage.getItem(FINALE_STORE_KEY);
    return raw ? finaleNormalize(JSON.parse(raw)) : {};
  } catch (e) { return {}; }
}

export function saveFinales(map) {
  try { localStorage.setItem(FINALE_STORE_KEY, JSON.stringify(finaleNormalize(map))); } catch (e) {}
  // Roam it (hash-gated inside userStatePush; a no-op signed out).
  try { if (typeof userStatePush === 'function') userStatePush(); } catch (e) {}
}

export function finaleRecordFor(key) {
  return loadFinales()[finaleSeriesKey(key)] || null;
}

/* ---------------- presentation model ---------------- */

export function finaleMonthYear(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function finaleLongDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function finaleStars(r) {
  const n = Math.max(0, Math.min(5, Math.round(Number(r) || 0)));
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
}

/* Everything the ceremony, keepsake, and share card render — one model
   so the three surfaces can never disagree about the honour. */
export function finaleCardModel(rec) {
  const complete = finaleHasSeal(rec);
  const bits = [];
  bits.push(rec.count + (rec.count === 1 ? ' book' : ' books'));
  if (rec.pages > 0) bits.push(rec.pages.toLocaleString() + ' pages');
  const span = (rec.first && rec.last && rec.first !== rec.last)
    ? finaleMonthYear(rec.first) + ' → ' + finaleMonthYear(rec.last)
    : (rec.last ? finaleMonthYear(rec.last) : '');
  return {
    eyebrow: complete ? 'SERIES COMPLETE' : 'ALL CAUGHT UP',
    label: complete ? 'Series complete' : 'All caught up',
    seal: complete,
    name: rec.name || 'Your series',
    span: span,
    stats: bits.join(' · '),
    arc: (rec.ratings || []).map(finaleStars),
    favChar: rec.favChar || null,
    dateLine: rec.last ? 'Finished ' + finaleLongDate(rec.last) : '',
    copy: complete
      ? 'Every volume, cover to cover. The whole story, finished.'
      : 'Everything you own in this series, read. If more exists, it’s out there waiting — no rush.',
  };
}

/* ---------------- wax seal ----------------
   First-cut art (inline SVG / canvas): a scalloped wax disc in deep
   red with an embossed star. Spec section 7 leaves the final seal art
   to the Designer with the User's veto — replace finaleSealHTML /
   drawFinaleSeal art without touching the honesty logic. */

export function finaleSealHTML(cls) {
  let d = '';
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = i % 2 ? 21.2 : 23;
    pts.push((24 + r * Math.cos(a)).toFixed(1) + ' ' + (24 + r * Math.sin(a)).toFixed(1));
  }
  d = 'M' + pts.join(' L') + ' Z';
  return '<span class="finale-seal ' + (cls || '') + '" role="img" aria-label="Series complete wax seal">' +
    '<svg viewBox="0 0 48 48" aria-hidden="true"><path class="fs-wax" d="' + d + '"/>' +
    '<circle class="fs-ring" cx="24" cy="24" r="16.5"/>' +
    '<text class="fs-star" x="24" y="30.5" text-anchor="middle">★</text></svg></span>';
}

export function drawFinaleSeal(x, cx, cy, r) {
  x.save();
  const g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r);
  g.addColorStop(0, '#a63a48');
  g.addColorStop(1, '#671624');
  x.fillStyle = g;
  x.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const rr = r * (i % 4 === 2 ? 0.93 : 1);
    const px = cx + rr * Math.cos(a), py = cy + rr * Math.sin(a);
    if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
  }
  x.closePath();
  x.fill();
  x.strokeStyle = 'rgba(243,217,164,.6)';
  x.lineWidth = Math.max(2, r * 0.045);
  x.beginPath(); x.arc(cx, cy, r * 0.68, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#f3d9a4';
  x.font = Math.round(r * 0.85) + 'px system-ui, sans-serif';
  x.textAlign = 'center';
  x.fillText('★', cx, cy + r * 0.3);
  x.restore();
}

/* ---------------- ceremony sheet ---------------- */

export function finaleCardHTML(rec) {
  const m = finaleCardModel(rec);
  return '<div class="finale-card">' +
    (m.seal ? finaleSealHTML('finale-seal-lg') : '') +
    '<div class="finale-eyebrow">' + esc(m.eyebrow) + '</div>' +
    '<h3 class="finale-name serif">' + esc(m.name) + '</h3>' +
    (m.span ? '<p class="finale-span">' + esc(m.span) + '</p>' : '') +
    '<p class="finale-stats">' + esc(m.stats) + '</p>' +
    (m.arc.length ? '<p class="finale-arc">' + m.arc.map(esc).join(' ') + '</p>' : '') +
    (m.favChar ? '<p class="finale-fav">With ' + esc(m.favChar) + ', along for the whole ride</p>' : '') +
    '<p class="finale-copy">' + esc(m.copy) + '</p></div>';
}

export let finaleCloseFn = null;

export function closeFinaleCeremony() {
  if (finaleCloseFn) {
    const f = finaleCloseFn;
    finaleCloseFn = null;
    f(true);
  }
}

/* Presents the ceremony once. If another sheet owns the moment (the
   post-save portrait survey can fire on the same save), retry briefly;
   the keepsake waits in the series view either way. */
export function presentFinaleCeremony(key, tries) {
  tries = tries || 0;
  if (typeof document === 'undefined') return false;
  if (document.querySelector('.finale-sheet')) return true;
  if (document.querySelector('.sv-sheet')) {
    if (tries < 8) setTimeout(() => presentFinaleCeremony(key, tries + 1), 700);
    return false;
  }
  const all = loadFinales();
  const rec = all[key];
  if (!rec) return false;
  if (!rec.seen) {
    rec.seen = true;
    all[key] = rec;
    saveFinales(all);
  }
  const bodyHTML = '<div class="finale-inner">' + finaleCardHTML(rec) +
    '<button class="btn finale-share-btn" data-finale-share="' + esc(key) + '">Share this moment</button>' +
    '<button class="btn ghost finale-done-btn">Lovely</button></div>';
  const scrim = document.createElement('div');
  scrim.className = 'sv-scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sv-sheet finale-sheet';
  sheet.innerHTML = bodyHTML;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => sheet.classList.add('open'));
  else sheet.classList.add('open');
  const close = function (immediate) {
    finaleCloseFn = null;
    sheet.classList.remove('open');
    const remove = () => {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    };
    if (immediate) remove(); else setTimeout(remove, 250);
    if (typeof overlayClosed === 'function') overlayClosed(token);
  };
  const token = (typeof overlayOpened === 'function') ? overlayOpened('finale', () => close(false)) : null;
  finaleCloseFn = close;
  if (typeof wireSheetDrag === 'function') wireSheetDrag(sheet, () => close(false));
  const shareBtn = sheet.querySelector('[data-finale-share]');
  if (shareBtn) shareBtn.addEventListener('click', () => shareFinaleCard(key));
  const doneBtn = sheet.querySelector('.finale-done-btn');
  if (doneBtn) doneBtn.addEventListener('click', () => close(false));
  scrim.addEventListener('click', () => close(false));
  return true;
}

/* ---------------- keepsake (series view) ---------------- */

export function finaleKeepsakeHTML(key, rec) {
  const m = finaleCardModel(rec);
  return '<div class="finale-keep">' +
    (m.seal ? finaleSealHTML('finale-seal-sm') : '') +
    '<div class="finale-keep-main">' +
    '<div class="finale-keep-title">' + esc(m.label) + (m.span ? ' · ' + esc(m.span) : '') + '</div>' +
    '<div class="finale-keep-sub">' + esc(m.stats) +
    (m.arc.length ? ' · ' + m.arc.map(esc).join(' ') : '') + '</div></div>' +
    '<button class="btn ghost sm" data-finale-share="' + esc(key) + '">Share</button></div>';
}

/* ---------------- share card ---------------- */

export function drawFinaleCard(key) {
  const rec = finaleRecordFor(key);
  if (!rec) return null;
  const m = finaleCardModel(rec);
  const c = (typeof cardCanvas === 'function')
    ? cardCanvas([[0, '#241532'], [0.55, '#1c1028'], [1, '#0e0916']])
    : null;
  if (!c) return null;
  const cv = c.cv, x = c.x, W = c.W, C = c.C;
  const ink = C.ink, mut = C.mut, gold = C.gold;

  const glow = x.createRadialGradient(W / 2, 620, 40, W / 2, 620, 560);
  glow.addColorStop(0, 'rgba(229,184,106,.22)');
  glow.addColorStop(1, 'rgba(229,184,106,0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, W, c.H);

  x.textAlign = 'center';
  try { x.letterSpacing = '14px'; } catch (e) {}
  x.fillStyle = mut;
  x.font = '40px system-ui, sans-serif';
  x.fillText('COZY LIBRAM', W / 2, 150);
  try { x.letterSpacing = '0px'; } catch (e) {}

  // Medallion: the wax seal for complete; a plain gold ring otherwise —
  // the caught-up card must never borrow the seal's shape-language of
  // honour beyond a ring, and it never gets the wax.
  if (m.seal) {
    drawFinaleSeal(x, W / 2, 560, 185);
  } else {
    x.fillStyle = 'rgba(229,184,106,.10)';
    x.beginPath(); x.arc(W / 2, 560, 185, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(229,184,106,.45)'; x.lineWidth = 3;
    x.beginPath(); x.arc(W / 2, 560, 185, 0, Math.PI * 2); x.stroke();
    x.fillStyle = gold;
    x.font = '170px system-ui, sans-serif';
    x.fillText('✦', W / 2, 625);
  }

  let y = 880;
  try { x.letterSpacing = '8px'; } catch (e) {}
  x.fillStyle = gold;
  x.font = '36px system-ui, sans-serif';
  x.fillText(m.eyebrow, W / 2, y);
  try { x.letterSpacing = '0px'; } catch (e) {}
  y += 110;

  x.fillStyle = ink;
  x.font = 'bold 76px Georgia, serif';
  (typeof cvWrap === 'function' ? cvWrap(x, m.name, W - 200) : [m.name])
    .slice(0, 3).forEach(t => { x.fillText(t, W / 2, y); y += 92; });
  y += 30;

  x.fillStyle = mut;
  x.font = '42px Georgia, serif';
  (typeof cvWrap === 'function' ? cvWrap(x, m.copy, W - 220) : [m.copy])
    .slice(0, 4).forEach(t => { x.fillText(t, W / 2, y); y += 62; });
  y += 50;

  if (m.arc.length) {
    x.fillStyle = gold;
    x.font = '44px system-ui, sans-serif';
    x.fillText(m.arc.join('  '), W / 2, y);
    y += 70;
  }
  if (m.favChar) {
    x.fillStyle = mut;
    x.font = '40px Georgia, serif';
    x.fillText('With ' + m.favChar + ', along for the whole ride', W / 2, y);
    y += 70;
  }

  x.fillStyle = gold;
  x.font = '38px system-ui, sans-serif';
  const foot = [m.stats, m.dateLine].filter(Boolean).join(' · ');
  if (foot) x.fillText(foot, W / 2, y);

  if (typeof cardFooter === 'function') cardFooter(x, W);
  return cv;
}

export function shareFinaleCard(key) {
  const rec = finaleRecordFor(key);
  if (!rec) { toast('No finale recorded for this series yet'); return; }
  toast('Making your card… ✨');
  const cv = drawFinaleCard(key);
  if (!cv) { toast('Image export isn’t supported on this device'); return; }
  const safe = finaleSeriesKey(rec.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'series';
  shareCanvasFile(cv, 'cozy-libram-finale-' + safe + '.png', rec.name + ' — ' + finaleCardModel(rec).label);
  if (typeof track === 'function') track('finale_shared', { kind: rec.kind });
}

/* ---------------- detection + override ---------------- */

/* Resolve the series total from Hardcover's listing. Returns null when
   the total is UNKNOWN (no token, listing not found, fetch failed) —
   unknown must never be dressed up as known. */
export async function finaleResolveListing(books, sample) {
  try {
    if (typeof hcReady !== 'function' || !hcReady()) return null;
    if (typeof fetchSeriesBooks !== 'function') return null;
    const r = await fetchSeriesBooks(sample.series.name, (sample.authors || [])[0]);
    if (!r || !r.found) return null;
    const rows = r.rows || [];
    const total = (typeof seriesFullTotal === 'function')
      ? seriesFullTotal(books, rows)
      : books.length + rows.length;
    return { total: total, maxPos: finaleMaxPos(books, rows) };
  } catch (e) { return null; }
}

/* Mark-read hook (book modal save, shelf move). Fire-and-forget: never
   blocks or breaks the save path. Idempotent per series. */
export async function maybeFinaleCeremony(book) {
  try {
    if (!book || !book.series || !book.series.name) return null;
    if (typeof library === 'undefined' || !library) return null;
    const key = finaleSeriesKey(book.series.name);
    const books = finaleSeriesBooks(library, book.series.name);
    if (books.length < 2) return null;
    // Local gate first (no network): the series must be library-complete
    // with this book as its finale.
    if (finaleKindFor(books, book.id, null) === null) return null;
    const existing = loadFinales()[key];
    if (existing && existing.kind === 'complete') return null; // top honour already recorded
    const listing = await finaleResolveListing(books, book);
    const kind = finaleKindFor(books, book.id, listing);
    if (!kind) return null;
    if (existing && existing.kind === kind) return null; // already celebrated at this level
    const rec = finaleBuildRecord(books, book, kind, {});
    const all = loadFinales();
    all[key] = rec;
    saveFinales(all);
    presentFinaleCeremony(key);
    if (typeof track === 'function') track('finale_recorded', { kind: kind, override: false });
    return rec;
  } catch (e) { return null; }
}

/* Manual override on the series view: the reader declares the series
   finished (another format owns the middle book, out-of-order reading,
   ...). Produces the caught-up card — NEVER the seal, even when the
   total is known and met: the override deliberately does not consult
   the listing at all, so no code path here can mint a seal. */
export async function finaleMarkFinished(key) {
  try {
    if (typeof library === 'undefined' || !library) return null;
    const k = finaleSeriesKey(key);
    const all = loadFinales();
    if (all[k]) { presentFinaleCeremony(k); return all[k]; }
    const sample = library.find(b => b && b.series && finaleSeriesKey(b.series.name) === k);
    if (!sample) return null;
    const books = finaleSeriesBooks(library, sample.series.name);
    if (!books.length) return null;
    const finished = books[books.length - 1];
    const rec = finaleBuildRecord(books, finished, 'caughtup', { override: true });
    all[k] = rec;
    saveFinales(all);
    presentFinaleCeremony(k);
    if (typeof track === 'function') track('finale_recorded', { kind: 'caughtup', override: true });
    return rec;
  } catch (e) { return null; }
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/140-collections.js, js/150-modal-discovery.js, js/205-shelfview.js and js/229-user-state.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.finaleSeriesKey = finaleSeriesKey;
window.finalePos = finalePos;
window.finaleSeriesBooks = finaleSeriesBooks;
window.finaleAllRead = finaleAllRead;
window.finaleIsHighest = finaleIsHighest;
window.finaleMaxPos = finaleMaxPos;
window.finaleKindFor = finaleKindFor;
window.finaleHasSeal = finaleHasSeal;
window.finaleFavCharacter = finaleFavCharacter;
window.finaleBuildRecord = finaleBuildRecord;
window.finaleNormalizeRecord = finaleNormalizeRecord;
window.finaleNormalize = finaleNormalize;
window.FINALE_STORE_KEY = FINALE_STORE_KEY;
window.loadFinales = loadFinales;
window.saveFinales = saveFinales;
window.finaleRecordFor = finaleRecordFor;
window.finaleMonthYear = finaleMonthYear;
window.finaleLongDate = finaleLongDate;
window.finaleStars = finaleStars;
window.finaleCardModel = finaleCardModel;
window.finaleSealHTML = finaleSealHTML;
window.drawFinaleSeal = drawFinaleSeal;
window.finaleCardHTML = finaleCardHTML;
window.finaleCloseFn = finaleCloseFn;
window.closeFinaleCeremony = closeFinaleCeremony;
window.presentFinaleCeremony = presentFinaleCeremony;
window.finaleKeepsakeHTML = finaleKeepsakeHTML;
window.drawFinaleCard = drawFinaleCard;
window.shareFinaleCard = shareFinaleCard;
window.finaleResolveListing = finaleResolveListing;
window.maybeFinaleCeremony = maybeFinaleCeremony;
window.finaleMarkFinished = finaleMarkFinished;
