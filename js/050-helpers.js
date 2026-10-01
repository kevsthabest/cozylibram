'use strict';

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
/* v224 (UX-05): one display normalization for author names — unicode-normalize,
   collapse stray whitespace, strip publisher suffixes (Inc/LLC/Ltd/Co), and
   title-case uniformly-cased names ("H D CARLTON" -> "H D Carlton"). Mixed-case
   names ("McDonald", "bell hooks") are left as-is. Display only — records keep
   their raw strings. */
function displayAuthorName(n) {
  let s = String(n || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\b(Inc|LLC|Ltd|Co)\.?$/i, '').trim();
  if (/[a-zA-Z]/.test(s) && (s === s.toUpperCase() || s === s.toLowerCase())) {
    s = s.toLowerCase().replace(/(^|[\s\-–—.'("])\p{L}/gu,
      m => m.toUpperCase());
  }
  return s;
}
function displayAuthors(arr) {
  return (arr || []).map(displayAuthorName).filter(Boolean).join(', ');
}
// v79: cohesive line-art icon set (inline SVG, inherits text color). Used for
// the library toolbar and view headers instead of mixed emoji glyphs.
const ICONS = {
  // two book covers side by side (grid / covers view)
  covers: '<rect x="3.5" y="4.5" width="7" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="15" rx="1.5"/>',
  // list view
  list: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>' +
    '<circle cx="4.8" cy="6" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="4.8" cy="12" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="4.8" cy="18" r="1.15" fill="currentColor" stroke="none"/>',
  // three book spines on a shelf (series)
  series: '<path d="M4.5 16.5v-8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v8"/><path d="M10.5 16.5v-11a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v11"/><path d="M16.5 16.5v-6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6"/><line x1="3" y1="20" x2="21" y2="20"/>',
  // upright book spines (favorites shelf style)
  spines: '<rect x="3.5" y="4" width="3.5" height="16" rx="1"/><rect x="8.5" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="3" height="16" rx="1"/><rect x="18.5" y="4" width="3" height="16" rx="1"/>',
  // quotation mark (quotes)
  quotes: '<path d="M9.5 6.5C6.7 6.5 5 8.6 5 11.4v5.1h5.5V11H7.8"/><path d="M19 6.5c-2.8 0-4.5 2.1-4.5 4.9v5.1H20V11h-2.7"/>',
  // ---- book modal chrome (v84) ----
  // TBR pile: two stacked books
  tbr: '<rect x="4" y="12.5" width="16" height="4.5" rx="1"/><path d="M6.5 12.5V8a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v4.5"/>',
  // currently reading: open book
  reading: '<path d="M12 6.5C10 5 7.5 4.5 4.5 4.5v13.5c3 0 5.5.5 7.5 2 2-1.5 4.5-2 7.5-2V4.5c-3 0-5.5.5-7.5 2z"/><line x1="12" y1="6.5" x2="12" y2="20"/>',
  // read: check in circle
  read: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.4l2.6 2.6 4.8-5.4"/>',
  // v189: plain check mark (read seals — the seal itself is the circle)
  check: '<path d="M8.3 12.4l2.6 2.6 4.8-5.4"/>',
  // DNF: x in circle
  dnf: '<circle cx="12" cy="12" r="8.5"/><line x1="9.2" y1="9.2" x2="14.8" y2="14.8"/><line x1="14.8" y1="9.2" x2="9.2" y2="14.8"/>',
  // up next: skip-forward
  upnext: '<path d="M6 5.5l8 6.5-8 6.5z" fill="currentColor" stroke="none"/><line x1="16.5" y1="5.5" x2="16.5" y2="18.5"/>',
  // owned: home
  owned: '<path d="M4 11l8-7 8 7"/><path d="M6.2 9.3V20h11.6V9.3"/>',
  // to buy: cart
  tobuy: '<path d="M3 4.5h2l2.4 11.5h10.8L21 8H7"/><circle cx="9.6" cy="19.6" r="1.3" fill="currentColor" stroke="none"/><circle cx="16.4" cy="19.6" r="1.3" fill="currentColor" stroke="none"/>',
  // borrowed: book with an outgoing arrow (read elsewhere — Kindle, library loan)
  borrowed: '<path d="M6 3.5h11a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z"/><path d="M6 3.5v14"/><path d="M10 10h5"/><path d="M13.2 8.2L15 10l-1.8 1.8"/>',
  // external link
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18.5 13.5V19a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1H11"/>',
  // previously read: clock
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  // trash
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/><line x1="10" y1="11" x2="10" y2="16.5"/><line x1="14" y1="11" x2="14" y2="16.5"/>',
  // magnifier
  search: '<circle cx="11" cy="11" r="6.5"/><line x1="15.8" y1="15.8" x2="20.3" y2="20.3"/>',
  // picture (change cover)
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 16.8l4.8-3.8 3.7 2.8 3-2.3 4 3"/>',
  // heart (favorite)
  heart: '<path d="M12 20.3C7.2 16.6 3.8 13.4 3.8 9.7A4.4 4.4 0 0 1 8.2 5.3c1.6 0 3 .8 3.8 2.1a4.6 4.6 0 0 1 3.8-2.1 4.4 4.4 0 0 1 4.4 4.4c0 3.7-3.4 6.9-8.2 10.6z"/>',
  // ---- axis rating glyphs (v84) ----
  // chili pepper (spice)
  pepper: '<path d="M14.6 5.2c.4-1.9 1.9-2.9 4-3.1"/><path d="M14.8 5.4c-4.2.9-7.4 4.3-8 8.8-.3 2.8 1 5.2 3.1 5.7 2.5.6 3.6-1 3.1-3.6-.7-3.6.3-7.8 1.8-10.9z"/>',
  // ghost (scare)
  ghost: '<path d="M12 3.8c-3.9 0-6.3 2.9-6.3 6.8v8.6l2.1-1.5 2.1 1.5 2.1-1.5 2.1 1.5 2.1-1.5 2.1 1.5v-8.6c0-3.9-2.4-6.8-6.3-6.8z"/><circle cx="9.8" cy="10.2" r=".95" fill="currentColor" stroke="none"/><circle cx="14.2" cy="10.2" r=".95" fill="currentColor" stroke="none"/>',
  // shocked face (suspense)
  shock: '<circle cx="12" cy="12" r="8.5"/><circle cx="9.4" cy="10" r=".95" fill="currentColor" stroke="none"/><circle cx="14.6" cy="10" r=".95" fill="currentColor" stroke="none"/><ellipse cx="12" cy="15.2" rx="2.1" ry="2.7"/>',
  // crossed swords (adventure)
  swords: '<path d="M6.8 6.8l9.5 9.5"/><path d="M4.6 4.6l2.9-.7-.7 2.9z"/><path d="M17.2 6.8l-9.5 9.5"/><path d="M19.4 4.6l-2.9-.7.7 2.9z"/>',
  // v132: smile (humor axis), layers (depth axis)
  smile: '<circle cx="12" cy="12" r="8.5"/><circle cx="9.2" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M8 14.2c1 1.7 2.4 2.6 4 2.6s3-0.9 4-2.6"/>',
  layers: '<path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M4.2 12.4l7.8 4.2 7.8-4.2"/><path d="M4.2 16.4L12 20.5l7.8-4.1"/>',
  // ---- v85: full-UI line-art sweep ----
  // overflow menu (vertical ellipsis)
  dots: '<circle cx="12" cy="5.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor" stroke="none"/>',
  // die (roulette)
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/>',
  // sparkles (toggles, headers)
  sparkles: '<path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  // theme toggle
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>',
  // region
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z"/>',
  // show / hide
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeoff: '<path d="M4 4l16 16"/><path d="M10.5 5.9c.5-.1 1-.1 1.5-.1 6 0 9.5 6.2 9.5 6.2a17.6 17.6 0 0 1-3.1 3.5M6.6 6.8A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.4-.2 3.4-.7"/>',
  // import / export
  download: '<path d="M12 4v11"/><path d="M7.5 11l4.5 4.5L16.5 11"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4.5 19.5h15"/>',
  // document (page counts, metadata)
  doc: '<path d="M6 3.5h8L19 8.5V19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V8.5H19"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="16.5" x2="15" y2="16.5"/>',
  // camera (scan)
  camera: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7l1.2-2.5h4.6L15.5 7"/><circle cx="12" cy="13" r="3.5"/>',
  // barcode (ISBN tab)
  barcode: '<path d="M4 5v14M7.5 5v14M10.5 5v14M12.5 5v14M15.5 5v14M19.5 5v14"/>',
  // clipboard (bulk tab, copy)
  clipboard: '<rect x="5.5" y="4.5" width="13" height="16.5" rx="2"/><rect x="9" y="2.5" width="6" height="4" rx="1"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="15" y2="15"/>',
  // share (connected nodes)
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="5.5" r="2.5"/><circle cx="17" cy="18.5" r="2.5"/><path d="M8.2 10.8l6.6-4M8.2 13.2l6.6 4"/>',
  // copy (overlapping sheets)
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"/>',
  // account menu
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  // friends / circle (two people)
  friends: '<circle cx="9" cy="8.2" r="3.1"/><path d="M3.6 19.2c.9-3.1 2.9-4.7 5.4-4.7s4.5 1.6 5.4 4.7"/><circle cx="16.8" cy="9.2" r="2.4"/><path d="M15.9 14.7c2.2.4 3.8 1.8 4.5 4.3"/>',
  logout: '<path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8"/><path d="M10 12h10"/><path d="M16.5 8.5L20 12l-3.5 3.5"/>',
  key: '<circle cx="7.5" cy="12" r="3.5"/><path d="M11 12h10"/><path d="M17.5 12v3M20.5 12v2"/>',
  // pencil (authors, write)
  pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  // gift (wishlist)
  gift: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M3 6.5h18V10H3z"/><line x1="12" y1="6.5" x2="12" y2="20"/><path d="M12 6.5C10.5 4.5 9.5 3.5 8.3 3.5a1.5 1.5 0 0 0 0 3c1.2 0 2.5 0 3.7 0zM12 6.5c1.5-2 2.5-3 3.7-3a1.5 1.5 0 0 1 0 3c-1.2 0-2.5 0-3.7 0z"/>',
  // warning triangle
  warn: '<path d="M12 4L2.8 20h18.4z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>',
  // stats headers
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16"/><path d="M8.5 3.5v4M15.5 3.5v4"/>',
  chart: '<path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M8.5 15.5v-4M13 15.5V8.5M17.5 15.5v-6.5"/>',
  trophy: '<path d="M8 4.5h8v5a4 4 0 0 1-8 0z"/><path d="M8 5.5H4.5a3.5 3.5 0 0 0 3.6 3.5M16 5.5h3.5a3.5 3.5 0 0 1-3.6 3.5"/><path d="M12 13.5v3M8.5 20h7M10 16.5h4"/>',
  medal: '<circle cx="12" cy="14" r="4.5"/><path d="M9 10.5L6 3.5h4l2 5 2-5h4l-3 7"/>',
  flame: '<path d="M12 3c.8 2.8-.5 4.8-2 6.5C8.5 11.2 7 12.8 7 15.5A5 5 0 0 0 17 15.5c0-1.8-.8-3.2-1.7-4.3-.2.9-.8 1.6-1.6 2 .4-2.4-.3-5.4-1.7-10.2z"/>',
  bulb: '<path d="M9.5 18h5"/><path d="M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.3 2.2h4.6c.2-.9.6-1.6 1.3-2.2A6 6 0 0 0 12 3z"/>',
  crystal: '<circle cx="12" cy="10" r="6"/><path d="M8 19.5h8l1.2 2.5H6.8z"/>',
  // cloud (sync)
  cloud: '<path d="M17.5 18.5a4.2 4.2 0 0 0 .6-8.4A6 6 0 0 0 6.3 11a3.9 3.9 0 0 0 .7 7.5z"/>',
  // pause (off toggle)
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  // help (not-found status)
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1.9-1.1 1.8"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>',
  // hourglass (time to finish)
  hourglass: '<path d="M6 3.5h12"/><path d="M6 20.5h12"/><path d="M7.5 3.5c0 5 4 6.5 4 8.5s-4 3.5-4 8.5M16.5 3.5c0 5-4 6.5-4 8.5s4 3.5 4 8.5"/>',
};
function icon(name) {
  const body = ICONS[name] || ICONS.covers;
  return '<svg class="ticon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + '</svg>';
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return ''; }
}

/* v126: one consistent empty-state block — empathetic title, gentle guidance,
   and a single contextual action. `body` is trusted HTML from the call site;
   `cta` navigates to a view via go(). */
function emptyState(o) {
  return '<div class="empty"><div class="big">' + icon(o.icon || 'covers') + '</div>' +
    '<h2 class="serif">' + esc(o.title) + '</h2>' +
    (o.body ? '<p>' + o.body + '</p>' : '') +
    // v185: the current theme's divider art — a quiet flourish between the
    // message and the call to action, styled per theme in CSS.
    '<div class="empty-div" aria-hidden="true"></div>' +
    (o.cta ? '<button class="btn" data-empty-go="' + esc(o.cta.go) + '">' + esc(o.cta.label) + '</button>' : '') +
    '</div>';
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-empty-go]');
  if (el && typeof go === 'function') go(el.dataset.emptyGo);
});
// v113: days from today (local) until a YYYY-MM-DD date; null when unparsable.
function daysUntil(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const t = new Date(iso + 'T00:00:00');
  if (isNaN(t)) return null;
  return Math.round((t - now) / 86400000);
}
// v113: human countdown for a release date ('' when past/unparsable).
function releaseCountdown(iso) {
  const n = daysUntil(iso);
  if (n == null || n < 0) return '';
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days';
}
function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function coverHTML(book, cls, extra) {
  const inner = book.cover
    ? '<img src="' + esc(book.cover) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' // v217: async decode off the main thread
    : icon('covers'); // v85: line-art no-cover placeholder
  return '<div class="cover-wrap ' + (cls || '') + '">' + inner + (extra || '') + '</div>';
}
function stars(n) {
  if (!n) return '';
  return '★'.repeat(Math.round(n)) + ' <span style="color:var(--faint)">' + Number(n).toFixed(1) + '</span>';
}
/* v225: authed same-origin API fetch. Attaches the Supabase session JWT as
   `Authorization: Bearer <token>` so the /api/* Pages Functions can verify
   the caller is signed in. cloudClient() lives in js/090-sync.js — this only
   calls it at runtime, so script load order doesn't matter. Never throws:
   any failure (not configured, no session, offline) falls back to a plain
   fetch and lets the endpoint answer 401. */
async function apiFetch(path, options) {
  options = options || {};
  let token = null;
  try {
    const sb = await cloudClient().catch(() => null);
    if (sb && sb.auth && sb.auth.getSession) {
      const { data } = await sb.auth.getSession();
      token = data && data.session && data.session.access_token;
    }
  } catch (e) { token = null; }
  if (!token) return fetch(path, options);
  const headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + token });
  return fetch(path, Object.assign({}, options, { headers }));
}

