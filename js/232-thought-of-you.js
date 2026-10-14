/* v527 (Social build #2) — "Thought of you": directed recommendations.
 *
 * A reader sends one of their own books to a specific circle friend,
 * with an optional short note; it lands here, in the recipient's
 * Hearth, as a card with one-tap +TBR and a dismiss.
 *
 * House rules this module is built around (migration v527 carries
 * the full contract):
 * - The send is ONE RPC (send_thought_of_you). The client names its
 *   own book by id and nothing else; the server builds the snapshot
 *   from the sender's row. The sender has no read surface here at
 *   all — no sent list, no counts, no receipts — so this module also
 *   never renders anything for the sender.
 *   v532 amends exactly one clause of that: the sender gains a
 *   private record of their own sends (js/234's outbox, served by
 *   caller-scoped definer RPCs — still no counts anywhere, still
 *   no recipient-side state) and an unsend wired to
 *   recall_thought_of_you below. This module still renders nothing
 *   for the sender; the helpers live here because the inbox rows
 *   and the recall are this feature's machinery.
 * - Inbox reads are a plain select: RLS does the whole job (the row
 *   is visible only to its recipient, only while the friendship
 *   stands, only for 60 days).
 * - The content shield (js/230) applies BEFORE any card HTML is
 *   built: the spice map is awaited first (the js/196 discipline),
 *   and a known-high-spice card (≥4, the v524 threshold) is held
 *   whole — cover, title and note. Unknown spice follows the v524
 *   rule (not high-spice). Held cards surface only as a content-free
 *   line — no number, no sender, no title.
 * - The note and every snapshot string render through esc(); the
 *   cover is re-validated client-side (belt over the server check):
 *   an allowlisted provider host, this project's content-addressed
 *   bucket path, or a capped data: URL — anything else renders as
 *   the letter placeholder, never as a loadable URL.
 * - Pre-migration the table/RPCs don't exist: error shapes latch a
 *   module-level "unsupported" flag and every surface fails quiet.
 */

let toyTableMissing = false;   // thought_of_you pre-migration
let toySupportKnown = null;    // probe cache: true / false / null
const TOY_NOTE_MAX = 140;

// The cover-provider hosts (union of the cover-hosts.js sets),
// mirrored for the client-side belt. Pinned EQUAL to
// functions/_lib/cover-hosts.js and to the SQL allowlist by test.
const TOY_COVER_HOSTS = [
  'covers.openlibrary.org', 'books.google.com', 'assets.hardcover.app',
  'img.hardcover.app', 'images-na.ssl-images-amazon.com', 'm.media-amazon.com',
  'archive.org', 'hardcover.app', 'i.gr-assets.com',
  'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com',
];

function toyLog() {
  if (window.AppLog && AppLog.info) AppLog.info.apply(AppLog, ['[toy]'].concat([].slice.call(arguments)));
}
function toyMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /thought_of_you/i.test(msg) &&
    (code === 'PGRST205' || code === '42P01' ||
     /schema cache|does not exist|not found/i.test(msg));
}
function toyRpcMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /(send_thought_of_you|dismiss_thought_of_you|recall_thought_of_you)/i.test(msg) &&
    (code === 'PGRST202' || code === '42883' ||
     /schema cache|does not exist|not found/i.test(msg));
}

/* Support probe (the v526 pattern): one throwaway select. Error
 * shapes from the missing relation latch "unsupported"; success or a
 * transient error leaves the machinery live/unknown. */
async function toySupported() {
  if (toyTableMissing) return false;
  if (toySupportKnown !== null) return toySupportKnown;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.from('thought_of_you').select('id').limit(1);
    if (r.error) {
      if (toyMissingErr(r.error)) { toyTableMissing = true; toySupportKnown = false; }
      return toySupportKnown === true;
    }
    toySupportKnown = true;
    return true;
  } catch (e) { return false; }
}

/* ---------- belt: snapshot hygiene on the recipient's side ---------- */

/* A cover URL may load only if it is self-contained (data:, capped),
 * on this project's content-addressed covers path, or on an
 * allowlisted provider host. Mirrors the server's rule; the server
 * check is the gate, this is the seatbelt. */
function toyCoverAllowed(url) {
  if (!url) return true;
  const u = String(url);
  if (u.indexOf('data:image/') === 0) return u.length <= 204800;
  let parsed;
  try { parsed = new URL(u); } catch (e) { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (/^\/storage\/v1\/object\/public\/covers\/[0-9a-f]{64}\.(jpg|jpeg|png|webp|gif|avif)$/.test(parsed.pathname)) {
    try {
      const cfg = (typeof cloudCfg === 'function') ? cloudCfg() : null;
      if (cfg && cfg.url) return parsed.hostname === new URL(cfg.url).hostname;
    } catch (e) {}
    return /\.supabase\.co$/.test(parsed.hostname);
  }
  return TOY_COVER_HOSTS.indexOf(parsed.hostname) !== -1;
}

/* Rebuild a display book from the stored snapshot with strict types:
 * strings stay strings, arrays of strings stay arrays, the series is
 * an object or null, and anything malformed degrades to empty rather
 * than reaching the DOM. The output is exactly covenCleanCopy's input
 * shape, so +TBR reuses the v219 clean-copy path. */
function toySnapshotBook(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '');
  const strList = (v, cap, n) => (Array.isArray(v)
    ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, n).map(x => x.slice(0, cap))
    : []);
  let series = null;
  if (s.series && typeof s.series === 'object' && typeof s.series.name === 'string' && s.series.name.trim()) {
    series = { name: s.series.name.slice(0, 200), position: str(s.series.position, 20) };
  }
  const cover = str(s.cover, 204800);
  return {
    title: str(s.title, 300) || 'Untitled',
    authors: strList(s.authors, 120, 8),
    isbn: str(s.isbn, 17),
    cover: toyCoverAllowed(cover) ? cover : '',
    coverColor: /^#[0-9a-fA-F]{6}$/.test(s.coverColor || '') ? s.coverColor : '',
    series: series,
    seriesPos: str(s.seriesPos, 20),
    genres: strList(s.genres, 60, 12),
    categories: strList(s.categories, 60, 12),
    description: str(s.description, 2000),
    pageCount: (Number.isFinite(s.pageCount) && s.pageCount > 0) ? Math.floor(s.pageCount) : 0,
    publishedDate: str(s.publishedDate, 10),
  };
}

function toySenderName(senderId, profs) {
  const p = (profs && profs[senderId]) || circProfiles[senderId];
  if (p) {
    const n = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
    if (n) return n;
  }
  return 'A friend';
}

/* ---------- receive side ---------- */

async function toyFetchMine() {
  if (toyTableMissing) return [];
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return [];
    const r = await sb.from('thought_of_you')
      .select('id,sender_id,book,note,created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (r.error) {
      if (toyMissingErr(r.error)) toyTableMissing = true;
      else toyLog('inbox read failed:', (r.error && r.error.message) || r.error);
      return [];
    }
    return Array.isArray(r.data) ? r.data : [];
  } catch (e) { toyLog('inbox read threw', e); return []; }
}

/* The reco keys of the viewer's current inbox — js/196 uses them
 * to keep a book a friend already sent from ALSO headlining
 * "You'd love this" while the card lives (v532, Strategist #2).
 * Same rows the inbox section renders (RLS: mine, ≤60 days); any
 * failure resolves to an empty set, never an error. */
async function toyInboxKeys() {
  const keys = new Set();
  try {
    const rows = await toyFetchMine();
    (rows || []).forEach(row => {
      const k = (typeof recoKey === 'function') ? recoKey(toySnapshotBook(row.book)) : '';
      if (k) keys.add(k);
    });
  } catch (e) { /* suppression is a courtesy, not a gate */ }
  return keys;
}

/* Unsend (v532): recall_thought_of_you has existed server-side
 * since v527 with no client caller (audit #6); the sender outbox
 * (js/234) wires it here. The RPC always answers 'ok' — whether or
 * not a row still stood — so the caller learns nothing about the
 * card's fate, the same discipline as the send. Returns true when
 * the call itself landed. */
async function toyRecall(recipientId, senderBookId) {
  const sb = await cloudClient();
  if (!sb || !cloudUser) return false;
  const r = await sb.rpc('recall_thought_of_you', { p_recipient: recipientId, p_book_id: senderBookId });
  if (r.error) {
    if (toyRpcMissingErr(r.error)) { toyTableMissing = true; return false; }
    toyLog('recall failed:', (r.error && r.error.message) || r.error);
    return false;
  }
  return true;
}

async function toyDeleteRow(id) {
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return;
    await sb.from('thought_of_you').delete().eq('id', id);
  } catch (e) { /* best effort: an undeleted card just re-renders */ }
}

async function toyDismiss(id) {
  const sb = await cloudClient();
  if (!sb || !cloudUser) return;
  const r = await sb.rpc('dismiss_thought_of_you', { p_id: id });
  if (r.error) {
    if (toyRpcMissingErr(r.error)) toyTableMissing = true; // pre-migration: fail quiet
    else throw r.error;
  }
}

function toySectionHTML(visible, heldAny, profs) {
  let html = '<div class="circle-card" style="margin-top:14px"><h3 class="serif" style="margin:0 0 4px">' +
    icon('gift') + ' Thought of you</h3>' +
    '<p class="note" style="margin:0 0 8px">Books your friends picked out for you.</p><div class="circle-list">';
  html += visible.map(v => {
    const b = v.book;
    const note = String(v.row.note || '');
    return '<div class="circle-row reco-row">' +
      recoCoverHTML(b) +
      '<div class="circle-meta"><b>' + esc(b.title) + '</b>' +
      (b.authors.length ? '<span class="note">by ' + esc(b.authors.join(', ')) + '</span>' : '') +
      '<span class="note">' + icon('gift') + ' from ' + esc(toySenderName(v.row.sender_id, profs)) + '</span>' +
      (note ? '<span class="toy-note">\u201C' + esc(note) + '\u201D</span>' : '') +
      '<span class="toy-sub">' +
      '<button class="taplink" data-toy-dismiss="' + esc(v.row.id) + '">Dismiss</button>' +
      '<button class="taplink" data-toy-report="' + esc(v.row.id) + '">Report</button>' +
      '<button class="taplink" data-toy-block="' + esc(v.row.id) + '">Block</button>' +
      '</span></div>' +
      '<div class="circle-actions"><button class="btn sm" data-toy-add="' + esc(v.row.id) + '">+ TBR</button></div></div>';
  }).join('');
  html += '</div>';
  if (heldAny) {
    html += '<p class="note" style="margin:8px 0 0">Some recommendations are hidden by your content shield.</p>';
  }
  return html + '</div>';
}

function wireToyCards(slot, visible, profs) {
  const byId = {};
  visible.forEach(v => { byId[v.row.id] = v; });
  slot.querySelectorAll('[data-toy-add]').forEach(btn => btn.addEventListener('click', async () => {
    const v = byId[btn.getAttribute('data-toy-add')];
    if (!v || btn.disabled) return;
    btn.disabled = true;
    try {
      // The v219 clean copy strips anything personal; the snapshot
      // is already clean, and addBook toasts either way (added /
      // already on your shelves). Either way the card has done its
      // job, so the row goes (a plain recipient delete — +TBR is not
      // a dismissal and must not tombstone).
      addBook(covenCleanCopy(v.book), false, 'thought-of-you');
      await toyDeleteRow(v.row.id);
      refreshThoughtOfYou();
    } catch (e) {
      btn.disabled = false;
      toast('Couldn\u2019t add: ' + ((e && e.message) || e));
    }
  }));
  slot.querySelectorAll('[data-toy-dismiss]').forEach(btn => btn.addEventListener('click', async () => {
    const v = byId[btn.getAttribute('data-toy-dismiss')];
    if (!v || btn.disabled) return;
    btn.disabled = true;
    try { await toyDismiss(v.row.id); refreshThoughtOfYou(); }
    catch (e) { btn.disabled = false; toast('Couldn\u2019t dismiss: ' + ((e && e.message) || e)); }
  }));
  slot.querySelectorAll('[data-toy-report]').forEach(btn => btn.addEventListener('click', () => {
    const v = byId[btn.getAttribute('data-toy-report')];
    if (v) openReportSheet(v.row.sender_id, toySenderName(v.row.sender_id, profs));
  }));
  slot.querySelectorAll('[data-toy-block]').forEach(btn => btn.addEventListener('click', () => {
    const v = byId[btn.getAttribute('data-toy-block')];
    if (v) openBlockSheet(v.row.sender_id, toySenderName(v.row.sender_id, profs), () => refreshThoughtOfYou());
  }));
}

/* Render the inbox into #toy-slot (renderCovenMain's slot). The
 * spice map is awaited BEFORE any innerHTML is built, and the shield
 * decision is made on the sanitized snapshot — never after DOM. */
async function refreshThoughtOfYou() {
  const slot = document.getElementById('toy-slot');
  if (!slot || !cloudUser) return;
  const rows = await toyFetchMine();
  if (!document.body.contains(slot)) return;
  if (!rows.length) { slot.innerHTML = ''; return; }
  const profs = {};
  try {
    // circleFetchProfiles RETURNS the projected rows (circleLists is
    // what fills the circProfiles cache) — keep them local so sender
    // names never depend on render order.
    const fetched = await circleFetchProfiles(Array.from(new Set(rows.map(r => r.sender_id))));
    (fetched || []).forEach(p => { profs[p.user_id] = p; });
  } catch (e) { /* names degrade to "A friend" */ }
  if (!document.body.contains(slot)) return;
  const owned = new Set(library.map(b => recoKey(b)));
  const cards = [];
  rows.forEach(row => {
    const book = toySnapshotBook(row.book);
    if (owned.has(recoKey(book))) { toyDeleteRow(row.id); return; } // already theirs: tidy up quietly
    cards.push({ row: row, book: book });
  });
  if (!cards.length) { slot.innerHTML = ''; return; }
  let visible = cards, heldAny = false;
  if (typeof shieldOn === 'function' && shieldOn()) {
    const map = await shieldSpiceMapFor(cards.map(c => c.book));
    visible = [];
    cards.forEach(c => {
      if (shieldIsHighSpice(c.book, map)) heldAny = true;
      else visible.push(c);
    });
  }
  if (!document.body.contains(slot)) return;
  if (!visible.length && !heldAny) { slot.innerHTML = ''; return; }
  slot.innerHTML = toySectionHTML(visible, heldAny, profs);
  wireToyCards(slot, visible, profs);
}

/* ---------- send side ---------- */

/* Returns 'ok' (landed, or a refusal the sender must not be able to
 * distinguish), 'slow_down' (the sender's own daily caps), or an
 * error message string for the closed set of honest refusals. */
async function toySend(recipientId, book, note) {
  const sb = await cloudClient();
  if (!sb || !cloudUser) return 'not signed in';
  const r = await sb.rpc('send_thought_of_you', {
    p_recipient: recipientId, p_book_id: book && book.id, p_note: note || '',
  });
  if (r.error) {
    if (toyRpcMissingErr(r.error)) { toyTableMissing = true; return 'unavailable'; }
    return String((r.error && r.error.message) || r.error);
  }
  return r.data === 'slow_down' ? 'slow_down' : 'ok';
}

/* Compose sheet: pick a circle friend, optional note (140 chars,
 * plain text), send. Opened from the book detail "…" menu. The sheet
 * is a covenOpenSheet, so the standing swipe-to-dismiss rule is
 * inherited. */
async function openToyCompose(book, opener) {
  if (!book) return;
  if (!cloudUser) { toast('Sign in to recommend books to your circle'); return; }
  track('toy_compose_opened');
  const body =
    '<div class="circle-row reco-row" style="margin-bottom:10px">' + recoCoverHTML(book) +
    '<div class="circle-meta"><b>' + esc(book.title || 'Untitled') + '</b>' +
    (book.authors && book.authors.length ? '<span class="note">by ' + esc(book.authors.join(', ')) + '</span>' : '') +
    '</div></div>' +
    '<div id="toy-compose-body"><p class="note" style="text-align:center">Loading your circle\u2026</p></div>';
  const ref = covenOpenSheet('Thought of you', body, opener || null);
  const host = ref.sheet.querySelector('#toy-compose-body');
  const supported = await toySupported();
  const lists = await circleLists();
  if (!document.body.contains(ref.sheet)) return;
  if (!supported) {
    host.innerHTML = '<p class="note">Recommendations aren\u2019t available yet \u2014 try again soon.</p>';
    return;
  }
  if (!lists.friends.length) {
    host.innerHTML = '<p class="note">No circle friends yet \u2014 recommendations go to friends in your ' +
      esc(covenNameBare().toLowerCase()) + '.</p>';
    return;
  }
  let picked = null;
  host.innerHTML =
    '<div class="field"><label>Send to</label><div class="toy-friends">' +
    lists.friends.map(f =>
      '<button class="toy-friend" data-toy-friend="' + esc(f.id) + '">' +
      circAvatarHTML(f.profile, 'c-avatar') +
      '<span>' + esc(String(f.name || 'Friend').split(' ')[0]) + '</span></button>').join('') +
    '</div></div>' +
    '<div class="field"><label for="toy-note">A note (optional)</label>' +
    '<textarea id="toy-note" rows="2" maxlength="' + TOY_NOTE_MAX + '" placeholder="Why this one, for them\u2026"></textarea>' +
    '<p class="note" style="margin:4px 0 0"><span id="toy-note-count">0</span>/' + TOY_NOTE_MAX + '</p></div>' +
    '<div class="modal-actions"><button class="btn" id="toy-send" disabled>Send ' + icon('gift') + '</button></div>' +
    '<p class="note" id="toy-msg" role="status"></p>';
  const sendBtn = host.querySelector('#toy-send');
  const msg = host.querySelector('#toy-msg');
  const ta = host.querySelector('#toy-note');
  const count = host.querySelector('#toy-note-count');
  ta.addEventListener('input', () => { count.textContent = String(ta.value.length); });
  host.querySelectorAll('[data-toy-friend]').forEach(b => b.addEventListener('click', () => {
    picked = b.getAttribute('data-toy-friend');
    host.querySelectorAll('[data-toy-friend]').forEach(x => x.classList.toggle('sel', x === b));
    sendBtn.disabled = false;
  }));
  sendBtn.addEventListener('click', async () => {
    if (!picked || sendBtn.disabled) return;
    sendBtn.disabled = true;
    msg.textContent = 'Sending\u2026';
    const friend = lists.friends.find(f => f.id === picked);
    const name = friend ? String(friend.name || 'your friend').split(' ')[0] : 'your friend';
    const res = await toySend(picked, book, ta.value);
    if (res === 'ok') {
      track('toy_sent');
      toast('Sent to ' + name + ' \uD83D\uDC8C');
      ref.close();
    } else if (res === 'slow_down') {
      toast('You\u2019re recommending a lot today \u2014 try again tomorrow');
      ref.close();
    } else if (res === 'unavailable') {
      msg.textContent = 'Recommendations aren\u2019t available yet \u2014 try again soon.';
      sendBtn.disabled = false;
    } else if (/not circle friends/i.test(res)) {
      msg.textContent = 'You\u2019re no longer in each other\u2019s ' + covenNameBare().toLowerCase() + '.';
      sendBtn.disabled = false;
    } else if (/note too long/i.test(res)) {
      msg.textContent = 'That note is a little long \u2014 ' + TOY_NOTE_MAX + ' characters max.';
      sendBtn.disabled = false;
    } else if (/no such book/i.test(res)) {
      msg.textContent = 'That book couldn\u2019t be found in your library.';
      sendBtn.disabled = false;
    } else {
      msg.textContent = 'Couldn\u2019t send: ' + res;
      sendBtn.disabled = false;
    }
  });
}
