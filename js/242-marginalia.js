'use strict';

/* ---------------- Marginalia (v574) ----------------
 * Progress-gated circle notes on the book page. Friends reading
 * the same book leave short notes pinned to a point in the book; a
 * note appears for you only when YOUR progress reaches it. The
 * full contract lives in supabase/migrations/v574_marginalia.sql;
 * the shape here:
 *
 * - The position is a FRACTION of the book, computed by the
 *   SERVER from the author's own copy (the client never supplies
 *   a fraction or a key). Locked notes are not in the read RPC's
 *   payload at all — not blurred, not counted, not hinted. The
 *   client gate below is a second belt over the same rule, run on
 *   whatever the server handed over.
 * - Posting flushes the cloud push first and re-reads the
 *   author's own row: positions derive from the CLOUD copy, and a
 *   note must never pin at a stale, earlier progress than the
 *   page its text was written about (the sync-lag spoiler
 *   channel). When the push can't be confirmed, posting refuses.
 * - The shield (js/230) applies BEFORE the fetch (the v525 fetch
 *   discipline): for a book the viewer's shield holds, the read
 *   RPC is never called and only a content-free line renders.
 * - Report and Block sit on every friend note (Report attaches
 *   the note itself server-side, via marginalia_report); Delete
 *   sits on your own. Your notes also live in Settings →
 *   Circle & privacy ("My margin notes"), so removing a book
 *   never strands them beyond your reach.
 * - The off switch (Circle & privacy → Marginalia) is
 *   authoritative in profiles (the server stops serving your
 *   notes and refuses your writes); locally it rides the roamed
 *   prefs key cozylibram.marginalia (js/229), reconciled from
 *   profiles at the first modal open of a session.
 * - Pre-migration the column/RPCs don't exist: error shapes latch
 *   a module-level "unsupported" flag and every surface fails
 *   quiet — the section simply never renders (fail closed).
 */

let margTableMissing = false;   // marginalia pre-migration
let margSupportKnown = null;    // probe cache: true / false / null
let margReconciled = false;     // profiles → local toggle sync, per session
const MARGINALIA_KEY = 'cozylibram.marginalia';
const MARG_NOTE_MAX = 280;

function margLog() {
  if (window.AppLog && AppLog.info) AppLog.info.apply(AppLog, ['[marginalia]'].concat([].slice.call(arguments)));
}
function margMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /(marginalia_enabled|marginalia_notes)/i.test(msg) &&
    (code === '42703' || code === 'PGRST204' || code === 'PGRST205' || code === '42P01' ||
     /schema cache|does not exist|not found/i.test(msg));
}
function margRpcMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /(marginalia_add|marginalia_for_book|marginalia_delete|marginalia_report|marginalia_mine|marginalia_admin_remove)/i.test(msg) &&
    (code === 'PGRST202' || code === '42883' ||
     /schema cache|does not exist|not found/i.test(msg));
}
function margLatchIfMissing(e) {
  if (margMissingErr(e) || margRpcMissingErr(e)) { margTableMissing = true; margSupportKnown = false; return true; }
  return false;
}

/* Support probe: the profiles column is the migration's footprint
 * (the notes table itself is policy-closed by design, so a table
 * probe can't distinguish missing from locked). */
async function marginaliaSupported() {
  if (margTableMissing) return false;
  if (margSupportKnown !== null) return margSupportKnown;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.from('profiles').select('marginalia_enabled').eq('user_id', cloudUser.id).maybeSingle();
    if (r.error) {
      if (margMissingErr(r.error)) { margTableMissing = true; margSupportKnown = false; }
      else margLog('support probe failed:', (r.error && r.error.message) || r.error);
      return margSupportKnown === true;
    }
    margSupportKnown = true;
    return true;
  } catch (e) { margLog('support probe threw', e); return false; }
}

/* ---------- the toggle ---------- */

function marginaliaEnabled() {
  try { return localStorage.getItem(MARGINALIA_KEY) !== 'off'; } catch (e) { return true; }
}
/* Local write only (book-dressing pattern: 'off' is stored, ON is
 * the absence of the key); js/229 roams it via the prefs section. */
function marginaliaSetLocal(on) {
  try {
    if (on) localStorage.removeItem(MARGINALIA_KEY);
    else localStorage.setItem(MARGINALIA_KEY, 'off');
  } catch (e) {}
  try { if (typeof userStatePush === 'function') userStatePush(); } catch (e) {}
}
/* profiles is authoritative for serving; the local key follows
 * it. Runs at most once per session, and only latches on success
 * (the teen-defaults retry discipline): a failed reconcile simply
 * retries at the next book open. */
async function marginaliaReconcile() {
  if (margReconciled) return;
  if (typeof circlePrivacy !== 'function') return;
  try {
    const priv = await circlePrivacy();
    if (priv && typeof priv.marginalia !== 'undefined') {
      margReconciled = true;
      const on = priv.marginalia !== false;
      if (marginaliaEnabled() !== on) marginaliaSetLocal(on);
    }
  } catch (e) { margLog('reconcile failed:', (e && e.message) || e); }
}

/* ---------- pure pieces (the pinned contract) ---------- */

/* One copy's HISTORICAL read fraction (client mirror of the
 * SQL): finished by any recorded evidence counts as 1 — a re-read
 * never re-locks what a first read unlocked. */
function marginaliaBookFrac(b) {
  if (!b) return 0;
  if (b.status === 'read' || b.dateFinished || (Number(b.readCount) || 0) >= 1 || b.previouslyRead) return 1;
  const pc = Number(b.pageCount) || 0, pr = Number(b.progress) || 0;
  if (pc <= 0 || pr <= 0) return 0;
  return Math.min(1, pr / pc);
}
function marginaliaViewerFrac(book) {
  if (!book || typeof recoKey !== 'function') return 0;
  const key = recoKey(book);
  let f = marginaliaBookFrac(book);
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  lib.forEach(b => { if (b && recoKey(b) === key) f = Math.max(f, marginaliaBookFrac(b)); });
  return f;
}
/* The gate: MY notes always; a friend's note only at or below my
 * fraction. Applied to whatever the server returned (it already
 * gated on the cloud copy; this gates on the local one — the two
 * can only ever disagree in the fail-safe direction). Returns the
 * notes in book order. */
function marginaliaGate(notes, myId, vfrac) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter(n => n && (n.author_id === myId || (typeof n.frac === 'number' && n.frac <= vfrac)))
    .slice()
    .sort((a, b) => (a.frac - b.frac) || (String(a.created_at || '') < String(b.created_at || '') ? -1 : 1));
}
/* Same-edition readers see the writer's page; everyone else gets
 * the fraction in words — never another edition's page number
 * presented as theirs, and never a percentage (no pace data). */
function marginaliaPositionLabel(note, myBook) {
  if (myBook && Number(myBook.pageCount) > 0 && Number(note.page_count) === Number(myBook.pageCount)) {
    return 'p. ' + note.page;
  }
  const f = Number(note && note.frac) || 0;
  if (f <= 0.12) return 'near the start';
  if (f < 0.28) return 'about a quarter in';
  if (f < 0.42) return 'about a third in';
  if (f < 0.58) return 'about halfway in';
  if (f < 0.72) return 'about two-thirds in';
  if (f < 0.88) return 'about three-quarters in';
  return 'near the end';
}
function margAuthorName(uid) {
  if (typeof cloudUser !== 'undefined' && cloudUser && uid === cloudUser.id) return 'You';
  const p = (typeof circProfiles !== 'undefined' && circProfiles) ? circProfiles[uid] : null;
  if (p && typeof friendDisplayName === 'function') {
    const n = friendDisplayName(p, '');
    if (n) return n;
  }
  return 'A friend';
}

/* ---------- RPC doors ---------- */

async function marginaliaFetch(book) {
  if (margTableMissing) return null;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return null;
    const r = await sb.rpc('marginalia_for_book', { p_book_id: book.id });
    if (r.error) {
      if (!margLatchIfMissing(r.error)) margLog('read failed:', (r.error && r.error.message) || r.error);
      return null;
    }
    return Array.isArray(r.data) ? r.data : null;
  } catch (e) { margLog('read threw', e); return null; }
}
/* Confirm the cloud copy of this book carries my local progress
 * BEFORE posting: flush the push, then re-read my own row. */
async function marginaliaFlushBook(book) {
  try { if (typeof cloudPushNow === 'function') await cloudPushNow(); } catch (e) {}
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.from('books').select('data').eq('user_id', cloudUser.id).eq('book_id', book.id).maybeSingle();
    if (r.error || !r.data) return false;
    const d = r.data.data || {};
    return (Number(d.progress) || 0) >= (Number(book.progress) || 0) &&
      (Number(d.pageCount) || 0) === (Number(book.pageCount) || 0);
  } catch (e) { return false; }
}
async function marginaliaAdd(book, page, body) {
  if (margTableMissing) return 'unavailable';
  if (!(await marginaliaFlushBook(book))) return 'offline';
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return 'unavailable';
    const r = await sb.rpc('marginalia_add', { p_book_id: book.id, p_page: page, p_body: body });
    if (r.error) {
      if (margLatchIfMissing(r.error)) return 'unavailable';
      const msg = String((r.error && r.error.message) || r.error);
      if (/page count needed/i.test(msg)) return 'nopagecount';
      if (/note refused/i.test(msg)) return 'refused';
      if (/too many notes/i.test(msg)) return 'toomany';
      if (/pin outside/i.test(msg)) return 'badpin';
      if (/no progress yet/i.test(msg)) return 'noprogress';
      if (/note length/i.test(msg)) return 'badlength';
      margLog('add failed:', msg);
      return 'error';
    }
    return (r.data === 'slow_down' || r.data === 'off') ? r.data : 'ok';
  } catch (e) { margLog('add threw', e); return 'error'; }
}
async function marginaliaDelete(id) {
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.rpc('marginalia_delete', { p_id: id });
    if (r.error) { margLatchIfMissing(r.error); margLog('delete failed:', (r.error && r.error.message) || r.error); return false; }
    return true;
  } catch (e) { return false; }
}
async function marginaliaReport(noteId, reason, details) {
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.rpc('marginalia_report', { p_note_id: noteId, p_reason: reason, p_details: details || '' });
    if (r.error) { margLatchIfMissing(r.error); margLog('report failed:', (r.error && r.error.message) || r.error); return false; }
    return true;
  } catch (e) { return false; }
}
async function marginaliaMine() {
  if (margTableMissing) return null;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return null;
    const r = await sb.rpc('marginalia_mine', {});
    if (r.error) {
      if (!margLatchIfMissing(r.error)) margLog('mine failed:', (r.error && r.error.message) || r.error);
      return null;
    }
    return Array.isArray(r.data) ? r.data : null;
  } catch (e) { return null; }
}

/* ---------- the book-page section ---------- */

function marginaliaNoteHTML(note, myBook) {
  const mine = typeof cloudUser !== 'undefined' && cloudUser && note.author_id === cloudUser.id;
  const actions = mine
    ? '<button class="taplink" data-marg-del="' + esc(note.id) + '">Delete</button>'
    : '<button class="taplink" data-marg-report="' + esc(note.id) + '">Report</button>' +
      '<button class="taplink" data-marg-block="' + esc(note.author_id) + '">Block</button>';
  return '<div class="marg-note"><div class="marg-meta"><b>' + esc(margAuthorName(note.author_id)) + '</b>' +
    '<span class="marg-pos">' + esc(marginaliaPositionLabel(note, myBook)) + '</span></div>' +
    '<p class="marg-body">' + esc(note.body || '') + '</p>' +
    '<div class="marg-actions">' + actions + '</div></div>';
}
function marginaliaSectionHTML(book, notes) {
  const prog = Number(book.progress) || 0, pc = Number(book.pageCount) || 0;
  let html = '<div class="marg-card"><h3 style="margin:0 0 2px">Marginalia</h3>' +
    '<p class="note" style="margin:0 0 10px">Margin notes from your ' + covenNameBare().toLowerCase() +
    ' appear when your reading reaches them — never before.</p>';
  if (notes.length) {
    html += '<div class="marg-list">' + notes.map(n => marginaliaNoteHTML(n, book)).join('') + '</div>';
  } else {
    html += '<p class="note" style="margin:0 0 4px">No margin notes here yet.</p>';
  }
  if (prog >= 1 && pc >= 1) {
    html += '<div class="marg-compose"><button class="btn ghost sm" data-marg-compose="1">Leave a note</button></div>';
  } else if (prog >= 1) {
    html += '<p class="note" style="margin:8px 0 0">Set this book’s page count to leave margin notes.</p>';
  } else {
    html += '<p class="note" style="margin:8px 0 0">Start reading to leave a note at the page you’ve reached.</p>';
  }
  return html + '</div>';
}

function wireMarginaliaSection(slot, book, notes) {
  const byId = {};
  notes.forEach(n => { byId[n.id] = n; });
  slot.querySelectorAll('[data-marg-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    if (await marginaliaDelete(btn.getAttribute('data-marg-del'))) {
      toast('Note removed');
      fillMarginalia(book);
    } else { btn.disabled = false; toast('Couldn’t remove that note'); }
  }));
  slot.querySelectorAll('[data-marg-report]').forEach(btn => btn.addEventListener('click', () => {
    const note = byId[btn.getAttribute('data-marg-report')];
    if (note) openMarginaliaReportSheet(note, btn);
  }));
  slot.querySelectorAll('[data-marg-block]').forEach(btn => btn.addEventListener('click', () => {
    const uid = btn.getAttribute('data-marg-block');
    if (typeof openBlockSheet === 'function') {
      openBlockSheet(uid, margAuthorName(uid), () => fillMarginalia(book));
    }
  }));
  const comp = slot.querySelector('[data-marg-compose]');
  if (comp) comp.addEventListener('click', () => openMarginaliaComposer(book, comp));
}

/* Fill #m-marginalia in the book modal. Every early return leaves
 * the slot EMPTY (feature invisible): signed out, toggled off,
 * pre-migration, shield-held, or any read failure. Staleness is
 * the js/235 discipline: the slot is stamped with the book's key
 * and re-checked after every await. */
async function fillMarginalia(book) {
  const slot = document.getElementById('m-marginalia');
  if (!slot || !book || typeof recoKey !== 'function') return;
  const key = recoKey(book);
  slot.setAttribute('data-marg-key', key || '');
  const fresh = () => document.body.contains(slot) && slot.getAttribute('data-marg-key') === key;
  if (!key || typeof cloudUser === 'undefined' || !cloudUser) return;
  if (!marginaliaEnabled()) return;
  if (!(await marginaliaSupported())) return;
  if (!fresh()) return;
  await marginaliaReconcile();
  if (!fresh()) return;
  if (!marginaliaEnabled()) { slot.innerHTML = ''; return; }
  /* Shield before the fetch (v525 discipline): the read RPC is
   * never called for a book the viewer's shield holds — the notes
   * are held whole behind a content-free line, like buddy cards. */
  if (typeof shieldOn === 'function' && shieldOn() && typeof shieldIsHighSpice === 'function') {
    let smap = {};
    if (typeof shieldSpiceMapFor === 'function') {
      try { smap = await shieldSpiceMapFor([book]); } catch (e) { smap = {}; }
    }
    if (!fresh()) return;
    if (shieldIsHighSpice(book, smap)) {
      slot.innerHTML = '<div class="marg-card"><p class="note" style="margin:0">Margin notes are hidden by your content shield for this book.</p></div>';
      return;
    }
  }
  const notes = await marginaliaFetch(book);
  if (!fresh()) return;
  if (!notes) { slot.innerHTML = ''; return; }
  /* Names: fetch the authors' profiles for THIS render (the
   * js/232 discipline) rather than depending on a cache another
   * surface may not have filled yet. */
  const ids = Array.from(new Set(notes.map(n => n.author_id).filter(id => id !== cloudUser.id)));
  if (ids.length && typeof circleFetchProfiles === 'function') {
    try {
      const rows = await circleFetchProfiles(ids);
      if (rows) rows.forEach(p => { if (p && p.user_id) circProfiles[p.user_id] = p; });
    } catch (e) { /* names degrade to "A friend" */ }
    if (!fresh()) return;
  }
  const gated = marginaliaGate(notes, cloudUser.id, marginaliaViewerFrac(book));
  slot.innerHTML = marginaliaSectionHTML(book, gated);
  wireMarginaliaSection(slot, book, gated);
}

/* ---------- composer + report sheets (covenOpenSheet: the
 * swipe-to-dismiss rule is inherited, js/195) ---------- */

function openMarginaliaComposer(book, opener) {
  const prog = Math.max(1, Math.floor(Number(book.progress) || 0));
  const pc = Math.floor(Number(book.pageCount) || 0);
  const body =
    '<p class="note" style="margin-top:0">Your note unlocks for each friend when their own reading reaches the page you pin — never before. Pin it at or before the page you’ve reached.</p>' +
    '<div class="field"><label for="marg-page">Pin at page</label>' +
    '<input id="marg-page" class="text-input" type="number" min="1" max="' + prog + '" value="' + prog + '" inputmode="numeric">' +
    '<p class="note" style="margin:4px 0 0">You’ve read to page ' + prog + ' of ' + pc + '.</p></div>' +
    '<div class="field"><label for="marg-body">Note</label>' +
    '<textarea id="marg-body" rows="3" maxlength="' + MARG_NOTE_MAX + '" placeholder="A thought for whoever reads this far…"></textarea>' +
    '<p class="note" style="margin:4px 0 0"><span id="marg-count">0</span>/' + MARG_NOTE_MAX + '</p></div>' +
    '<div class="modal-actions"><button class="btn" id="marg-post">Leave note</button>' +
    '<button class="btn ghost" id="marg-cancel">Cancel</button></div>';
  const ref = covenOpenSheet('Leave a margin note', body, opener || null);
  const ta = ref.sheet.querySelector('#marg-body');
  const cnt = ref.sheet.querySelector('#marg-count');
  ta.addEventListener('input', () => { cnt.textContent = String(ta.value.length); });
  ref.sheet.querySelector('#marg-cancel').addEventListener('click', () => ref.close());
  ref.sheet.querySelector('#marg-post').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const text = ta.value.trim();
    if (!text) { toast('Write the note first'); return; }
    let page = Math.floor(Number(ref.sheet.querySelector('#marg-page').value) || prog);
    page = Math.max(1, Math.min(prog, page));
    btn.disabled = true;
    const res = await marginaliaAdd(book, page, text);
    if (res === 'ok') {
      track('marginalia_posted');
      toast('Note left in the margin');
      ref.close();
      fillMarginalia(book);
    } else if (res === 'slow_down') { btn.disabled = false; toast('You’re leaving a lot of notes today — try again tomorrow'); }
    else if (res === 'off') { btn.disabled = false; toast('Marginalia is off in your privacy settings'); }
    else if (res === 'offline') { btn.disabled = false; toast('Couldn’t confirm your reading progress reached the cloud — check your connection and try again'); }
    else if (res === 'unavailable') { btn.disabled = false; toast('Marginalia isn’t available yet — try again soon'); }
    else if (res === 'refused') { btn.disabled = false; toast('That note couldn’t be posted'); }
    else if (res === 'toomany') { btn.disabled = false; toast('You’ve left a lot of notes on this book already'); }
    else if (res === 'badpin') { btn.disabled = false; toast('Notes can only be pinned at or before the page you’ve reached'); }
    else if (res === 'nopagecount') { btn.disabled = false; toast('Set this book’s page count first'); }
    else if (res === 'noprogress') { btn.disabled = false; toast('Read a page first, then leave your note'); }
    else { btn.disabled = false; toast('Couldn’t post that note'); }
  });
}

function openMarginaliaReportSheet(note, opener) {
  const reasons = (typeof REPORT_REASONS !== 'undefined' && Array.isArray(REPORT_REASONS)) ? REPORT_REASONS :
    [['spam', 'Spam'], ['harassment', 'Harassment'], ['inappropriate', 'Inappropriate content'], ['fake_account', 'Fake account'], ['other', 'Other']];
  const body =
    '<p class="note" style="margin-top:0">Report ' + esc(margAuthorName(note.author_id)) + '’s margin note? The note itself is attached to your report for the app administrator.</p>' +
    '<blockquote class="marg-quote">' + esc(note.body || '') + '</blockquote>' +
    '<div class="field"><label for="marg-rp-reason">Reason</label>' +
    '<select id="marg-rp-reason">' + reasons.map(r => '<option value="' + r[0] + '">' + r[1] + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="marg-rp-details">Details (optional)</label>' +
    '<textarea id="marg-rp-details" rows="3" maxlength="500" placeholder="What happened?"></textarea></div>' +
    '<div class="modal-actions"><button class="btn danger" id="marg-rp-send">Send report</button>' +
    '<button class="btn ghost" id="marg-rp-cancel">Cancel</button></div>';
  const ref = covenOpenSheet('Report margin note', body, opener || null);
  ref.sheet.querySelector('#marg-rp-cancel').addEventListener('click', () => ref.close());
  ref.sheet.querySelector('#marg-rp-send').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const okSend = await marginaliaReport(note.id,
      ref.sheet.querySelector('#marg-rp-reason').value,
      ref.sheet.querySelector('#marg-rp-details').value.trim());
    if (okSend) {
      track('marginalia_reported');
      toast('Report sent — thank you');
      ref.close();
    } else { btn.disabled = false; toast('Couldn’t send that report'); }
  });
}

/* ---------- Settings: "My margin notes" (js/180 mounts this
 * under the Circle & privacy panel; it renders NOTHING when the
 * feature is unsupported or the list is empty — the
 * blocked-readers discipline) ---------- */

async function renderMarginaliaMine(box) {
  if (!box || typeof cloudUser === 'undefined' || !cloudUser) return;
  if (!(await marginaliaSupported())) return;
  const notes = await marginaliaMine();
  if (!notes || !notes.length || !document.body.contains(box)) return;
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  const copyFor = (key) => (typeof recoKey === 'function') ? (lib.find(b => b && recoKey(b) === key) || null) : null;
  const titleFor = (key) => {
    const c = copyFor(key);
    if (c) return c.title || 'Untitled';
    if (key && key.indexOf('ta:') === 0) return key.slice(3).split('|')[0] || 'A book';
    return 'A book';
  };
  box.innerHTML = '<div class="field"><label>My margin notes</label><div class="marg-mine">' +
    notes.map(n => '<div class="marg-note"><div class="marg-meta"><b>' + esc(titleFor(n.book_key)) + '</b>' +
      '<span class="marg-pos">' + esc(marginaliaPositionLabel(n, copyFor(n.book_key))) + '</span></div>' +
      '<p class="marg-body">' + esc(n.body || '') + '</p>' +
      '<div class="marg-actions"><button class="taplink" data-marg-mine-del="' + esc(n.id) + '">Delete</button></div></div>').join('') +
    '</div><p class="note" style="margin:6px 0 0">Your notes stay listed here even if you remove the book. Deleting one removes it for everyone.</p></div>';
  box.querySelectorAll('[data-marg-mine-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    if (await marginaliaDelete(btn.getAttribute('data-marg-mine-del'))) {
      toast('Note removed');
      box.innerHTML = '';
      renderMarginaliaMine(box);
    } else { btn.disabled = false; toast('Couldn’t remove that note'); }
  }));
}
