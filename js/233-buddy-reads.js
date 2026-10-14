'use strict';

/* ---------------- Buddy reads (v528, Social build #3) ----------------
 * The Buddy tab stops being a coincidence list: a reader can invite
 * a circle friend to read a shared-TBR book together, and while the
 * buddy read is active the pair sees each other's reading STATE for
 * that one book. Full contract in migration v528; the shape here:
 *
 * - Rows are key-only (no book snapshot exists anywhere): every
 *   surface renders title/cover from the VIEWER'S OWN library copy.
 * - The inviter has NO read on pendings (server-enforced): sending
 *   is fire-and-forget like a Thought-of-you card, declines are
 *   invisible, and the inviter's only feedback is an active read
 *   appearing. This module therefore never renders a "waiting" list
 *   — the one record of an invite sent from THIS device is the
 *   session-local marker below, an affordance, not a read surface.
 * - Presence is a per-book grant (the invite + the accept), served
 *   by buddy_states() as a bare enum. This module never touches a
 *   friend's book rows for state — state arrives as not_started /
 *   reading / finished / set_aside / null, and null renders as
 *   nothing (never a guessed state). NO pace data exists in this
 *   feature to render: no percentages, no page counts, no dates
 *   (created_at is fetched for ordering only and never displayed).
 * - The shield (js/230) applies before any HTML is built (the
 *   js/196/js/232 discipline): incoming invites for known-high-spice
 *   books are held whole behind a content-free line, active rows
 *   blur their cover (the viewer's own copy, friend-grid
 *   discipline), and buddy_states() is never called for a book the
 *   viewer's shield filters (the v525 fetch discipline).
 * - Pre-migration the table/RPCs don't exist: error shapes latch a
 *   module-level "unsupported" flag and every surface fails quiet
 *   (invite buttons hide; the tab keeps its v197 matches card).
 */

let buddyTableMissing = false;   // buddy_reads pre-migration
let buddySupportKnown = null;    // probe cache: true / false / null
let buddyRowsCache = [];         // rows as RLS hands them to me
const buddyInvitedLocal = new Set(); // session-only: friendId|key I invited

const BUDDY_STATE_LABELS = {
  not_started: 'Not started',
  reading: 'Reading',
  finished: 'Finished',
  set_aside: 'Set aside',
};

function buddyLog() {
  if (window.AppLog && AppLog.info) AppLog.info.apply(AppLog, ['[buddy]'].concat([].slice.call(arguments)));
}
function buddyMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /buddy_reads/i.test(msg) &&
    (code === 'PGRST205' || code === '42P01' ||
     /schema cache|does not exist|not found/i.test(msg));
}
function buddyRpcMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /(buddy_invite|buddy_respond|buddy_end|buddy_states)/i.test(msg) &&
    (code === 'PGRST202' || code === '42883' ||
     /schema cache|does not exist|not found/i.test(msg));
}

/* Support probe (the v526/v527 pattern): one throwaway select. */
async function buddySupported() {
  if (buddyTableMissing) return false;
  if (buddySupportKnown !== null) return buddySupportKnown;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.from('buddy_reads').select('id').limit(1);
    if (r.error) {
      if (buddyMissingErr(r.error)) { buddyTableMissing = true; buddySupportKnown = false; }
      // v532 (RC3): a NON-missing probe error used to fail just as
      // silently as a missing table — every offer button hid and
      // nothing anywhere said why. Log it; the surface still fails
      // quiet, but the failure is now diagnosable.
      else buddyLog('support probe failed:', (r.error && r.error.message) || r.error);
      return buddySupportKnown === true;
    }
    buddySupportKnown = true;
    return true;
  } catch (e) { buddyLog('support probe threw', e); return false; }
}

/* ---------- rows ---------- */

async function buddyFetchRows() {
  if (buddyTableMissing) return [];
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return [];
    const r = await sb.from('buddy_reads')
      .select('id,inviter_id,invitee_id,book_key,status')
      .order('created_at', { ascending: false })
      .limit(100);
    if (r.error) {
      if (buddyMissingErr(r.error)) buddyTableMissing = true;
      else buddyLog('rows read failed:', (r.error && r.error.message) || r.error);
      return [];
    }
    return Array.isArray(r.data) ? r.data : [];
  } catch (e) { buddyLog('rows read threw', e); return []; }
}

function buddyPartnerId(row) {
  if (!row || typeof cloudUser === 'undefined' || !cloudUser) return '';
  return row.inviter_id === cloudUser.id ? row.invitee_id : row.inviter_id;
}
function buddyName(uid) {
  const p = (typeof circProfiles !== 'undefined' && circProfiles) ? circProfiles[uid] : null;
  if (p) {
    const n = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
    if (n) return n;
  }
  return 'A friend';
}
function buddyFirstName(uid) {
  return String(buddyName(uid)).split(' ')[0];
}
function buddyAvatar(uid) {
  const p = (typeof circProfiles !== 'undefined' && circProfiles) ? circProfiles[uid] : null;
  if (p && typeof circAvatarHTML === 'function') return circAvatarHTML(p, 'c-avatar');
  const initial = esc(String(buddyName(uid)).trim().charAt(0).toUpperCase() || '?');
  return '<span class="c-avatar letter" aria-hidden="true">' + initial + '</span>';
}
/* A row I can see for (friend, key) — actives in both directions,
 * plus pendings addressed to me. (My own pendings are not readable,
 * by design; buddyInvitedLocal covers this device's memory of them.) */
function buddyRowFor(friendId, key) {
  if (!key || typeof cloudUser === 'undefined' || !cloudUser) return null;
  return buddyRowsCache.find(r => r.book_key === key && buddyPartnerId(r) === friendId) || null;
}

/* The display book for a row: MY copy of the book (the only copy
 * this client may render — the row itself stores no book data).
 * Fallbacks keep a row legible if my copy is gone: the ta: key
 * carries its title|author; an isbn: key with no local copy renders
 * as a plain "A book". */
function buddyMyCopy(key) {
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  return lib.find(b => (typeof recoKey === 'function') && recoKey(b) === key) || null;
}
function buddyDisplayBook(row) {
  const mine = buddyMyCopy(row.book_key);
  if (mine) return mine;
  const k = String(row.book_key || '');
  if (k.indexOf('ta:') === 0) {
    const parts = k.slice(3).split('|');
    return { title: parts[0] || 'A book', authors: parts[1] ? [parts[1]] : [], cover: '', coverColor: '', ratings: {} };
  }
  return { title: 'A book', authors: [], cover: '', coverColor: '', ratings: {} };
}

/* ---------- writes (RPC only — the v525/v527 house pattern) ---------- */

async function buddyInvite(friendId, myBook) {
  const sb = await cloudClient();
  if (!sb || !cloudUser || !myBook) return 'unavailable';
  const r = await sb.rpc('buddy_invite', { p_friend: friendId, p_book_id: myBook.id });
  if (r.error) {
    if (buddyRpcMissingErr(r.error) || buddyMissingErr(r.error)) { buddyTableMissing = true; return 'unavailable'; }
    return String((r.error && r.error.message) || r.error);
  }
  return r.data === 'slow_down' ? 'slow_down' : 'ok';
}
async function buddyRespond(id, accept) {
  const sb = await cloudClient();
  if (!sb || !cloudUser) return false;
  const r = await sb.rpc('buddy_respond', { p_id: id, p_accept: !!accept });
  if (r.error) {
    if (buddyRpcMissingErr(r.error) || buddyMissingErr(r.error)) { buddyTableMissing = true; return false; }
    buddyLog('respond failed:', (r.error && r.error.message) || r.error);
    return false;
  }
  return true;
}
async function buddyEnd(id) {
  const sb = await cloudClient();
  if (!sb || !cloudUser) return false;
  const r = await sb.rpc('buddy_end', { p_id: id });
  if (r.error) {
    if (buddyRpcMissingErr(r.error) || buddyMissingErr(r.error)) { buddyTableMissing = true; return false; }
    buddyLog('end failed:', (r.error && r.error.message) || r.error);
    return false;
  }
  return true;
}
/* The presence read: both states as bare enums from the server, or
 * null when the read isn't active / no longer stands. */
async function buddyStates(id) {
  if (buddyTableMissing) return null;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return null;
    const r = await sb.rpc('buddy_states', { p_id: id });
    if (r.error) {
      if (buddyRpcMissingErr(r.error) || buddyMissingErr(r.error)) { buddyTableMissing = true; return null; }
      buddyLog('states failed:', (r.error && r.error.message) || r.error);
      return null;
    }
    const d = r.data || {};
    const norm = v => (typeof v === 'string' && BUDDY_STATE_LABELS[v]) ? v : null;
    return { mine: norm(d.mine), theirs: norm(d.theirs) };
  } catch (e) { buddyLog('states threw', e); return null; }
}

/* ---------- offers ---------- */

/* The pre-reading shelves (v532): TBR and Wishlist. The v531
 * presence ladder and the server's buddy_invite gate already
 * treat a Wishlist copy as a valid pre-reading copy — this offer
 * gate was the only piece still insisting on TBR alone. */
function buddyPreReading(status) { return status === 'tbr' || status === 'wishlist'; }

/* My book id if I can invite this friend to buddy-read their book:
 * the shared pre-reading rule (their copy and mine both sit on a
 * pre-reading shelf — TBR or Wishlist) and no row I can see already
 * stands for the pair + book. Used by the Buddy tab's match rows
 * and by the friend-shelf preview modal (js/195 openCovenBook). */
function buddyOfferBookId(friendId, theirBook) {
  if (!theirBook || !buddyPreReading(theirBook.status)) return '';
  if (typeof recoKey !== 'function') return '';
  const key = recoKey(theirBook);
  if (!key) return '';
  if (buddyRowFor(friendId, key)) return '';
  if (buddyInvitedLocal.has(friendId + '|' + key)) return '';
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  const mine = lib.find(b => recoKey(b) === key && buddyPreReading(b.status));
  return mine ? mine.id : '';
}

async function buddySendInvite(friendId, key, btn) {
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  const mine = lib.find(b => (typeof recoKey === 'function') && recoKey(b) === key && buddyPreReading(b.status));
  if (!mine) { toast('That book isn’t on your TBR or Wishlist'); return; }
  if (btn) btn.disabled = true;
  const res = await buddyInvite(friendId, mine);
  const name = buddyFirstName(friendId);
  if (res === 'ok') {
    track('buddy_invite_sent');
    buddyInvitedLocal.add(friendId + '|' + key);
    toast('Invitation sent to ' + name);
    if (typeof refreshCovenStats === 'function') refreshCovenStats();
  } else if (res === 'slow_down') {
    toast('You’re inviting a lot today — try again tomorrow');
    if (btn) btn.disabled = false;
  } else if (res === 'unavailable') {
    toast('Buddy reads aren’t available yet — try again soon');
    if (btn) btn.disabled = false;
  } else if (/not circle friends/i.test(res)) {
    toast('You’re no longer in each other’s ' + covenNameBare().toLowerCase() + '.');
    if (btn) btn.disabled = false;
  } else if (/no such book/i.test(res)) {
    toast('That book couldn’t be found in your library.');
    if (btn) btn.disabled = false;
  } else {
    toast('Couldn’t send: ' + res);
    if (btn) btn.disabled = false;
  }
}

/* ---------- rendering (into the Buddy tab, js/197's panel) ---------- */

function buddyCoverHTML(book, blurred) {
  let html = (typeof recoCoverHTML === 'function')
    ? recoCoverHTML(book)
    : '<div class="cover-wrap reco-cover"><span class="cover-initial">' +
      esc(String(book.title || '?').trim().charAt(0).toUpperCase() || '?') + '</span></div>';
  if (blurred) html = html.replace('cover-wrap', 'cover-wrap shield-blur');
  return html;
}

function buddyInviteCardHTML(row, book, blurred) {
  const partner = buddyPartnerId(row);
  /* The consent line and the quiet actions sit full-width under the
   * row: at 360px the meta column is too narrow for a sentence, and
   * the consent is the one part that must actually be read. */
  return '<div class="buddy-invite"><div class="circle-row reco-row">' + buddyCoverHTML(book, blurred) +
    '<div class="circle-meta"><b>' + esc(book.title || 'Untitled') + '</b>' +
    (book.authors && book.authors.length ? '<span class="note buddy-line">by ' + esc(book.authors.join(', ')) + '</span>' : '') +
    '<span class="note buddy-line">' + icon('friends') + ' ' + esc(buddyName(partner)) + ' invited you to read this together</span></div>' +
    '<div class="circle-actions"><button class="btn sm" data-buddy-accept="' + esc(row.id) + '">Read together</button></div></div>' +
    '<p class="note buddy-consent">If you accept, you’ll each see whether the other has started or finished this book — just this book, only while the buddy read lasts.</p>' +
    '<span class="toy-sub">' +
    '<button class="taplink" data-buddy-decline="' + esc(row.id) + '">Decline</button>' +
    '<button class="taplink" data-buddy-report="' + esc(row.id) + '">Report</button>' +
    '<button class="taplink" data-buddy-block="' + esc(row.id) + '">Block</button>' +
    '</span></div>';
}

function buddyActiveRowHTML(row, book, blurred) {
  const partner = buddyPartnerId(row);
  return '<div class="circle-row reco-row">' + buddyCoverHTML(book, blurred) +
    '<div class="circle-meta"><b>' + esc(book.title || 'Untitled') + '</b>' +
    (book.authors && book.authors.length ? '<span class="note buddy-line">by ' + esc(book.authors.join(', ')) + '</span>' : '') +
    '<span class="note buddy-line">with ' + esc(buddyName(partner)) + '</span>' +
    '<span class="buddy-states" data-buddy-states="' + esc(row.id) + '"></span>' +
    '<span class="buddy-done" data-buddy-done="' + esc(row.id) + '"></span></div>' +
    '<div class="circle-actions"><button class="btn ghost sm" data-buddy-end="' + esc(row.id) + '">End</button></div></div>';
}

function buddyStateChipsHTML(row, states) {
  if (!states) return '';
  const partner = buddyPartnerId(row);
  const chip = (who, v) => v
    ? '<span class="rx-chip">' + esc(who) + ' · ' + esc(BUDDY_STATE_LABELS[v]) + '</span>'
    : '';
  return chip('You', states.mine) + chip(buddyFirstName(partner), states.theirs);
}

/* Fill the Buddy tab: my live sections go above the static shared-
 * TBR card js/197 rendered; the match rows' invite buttons are
 * wired (or labelled per the rows that already stand). Called by
 * refreshCovenStats after the stats HTML lands. */
async function wireBuddyReads(root) {
  const panel = root ? root.querySelector('#ctab-buddy') : null;
  if (!panel || typeof cloudUser === 'undefined' || !cloudUser) return;
  const hideOffers = () => panel.querySelectorAll('[data-buddy-invite]').forEach(b => { b.style.display = 'none'; });
  if (!(await buddySupported())) { hideOffers(); return; }
  if (!document.body.contains(panel)) return;
  const rows = await buddyFetchRows();
  buddyRowsCache = rows;
  if (!document.body.contains(panel)) return;

  const me = cloudUser.id;
  const pendings = rows.filter(r => r.status === 'pending' && r.invitee_id === me);
  const actives = rows.filter(r => r.status === 'active');

  /* Shield first (before any HTML is built): resolve spice for the
   * books these cards would show — all from MY copies. */
  const display = new Map();
  pendings.concat(actives).forEach(r => display.set(r.id, buddyDisplayBook(r)));
  let smap = {};
  const shielded = (typeof shieldOn === 'function') && shieldOn();
  if (shielded && typeof shieldSpiceMapFor === 'function') {
    try { smap = await shieldSpiceMapFor(Array.from(display.values())); } catch (e) { smap = {}; }
  }
  if (!document.body.contains(panel)) return;
  const isHigh = (book) => shielded && typeof shieldIsHighSpice === 'function' && shieldIsHighSpice(book, smap);

  let html = '';
  /* Invitations to me. A known-high-spice invitation is held whole
   * (v527 card discipline): it renders nothing — no title, no
   * sender — and simply expires server-side if never seen. */
  const visPend = [], heldPend = [];
  pendings.forEach(r => { (isHigh(display.get(r.id)) ? heldPend : visPend).push(r); });
  if (visPend.length || heldPend.length) {
    html += '<div class="circle-card"><h3 style="margin:0 0 4px">Buddy read invitations</h3>' +
      '<p class="note" style="margin:0 0 10px">Friends who’d like to read a book with you.</p><div class="circle-list">';
    html += visPend.map(r => buddyInviteCardHTML(r, display.get(r.id), false)).join('');
    html += '</div>';
    if (heldPend.length) html += '<p class="note" style="margin:8px 0 0">Some invitations are hidden by your content shield.</p>';
    html += '</div>';
  }
  /* Active reads. */
  if (actives.length) {
    html += '<div class="circle-card"><h3 style="margin:0 0 4px">Reading together</h3>' +
      '<p class="note" style="margin:0 0 10px">While a buddy read is active, you and your partner can each see whether the other has started or finished that book — for that book only. Ending a buddy read stops that right away.</p><div class="circle-list">';
    html += actives.map(r => buddyActiveRowHTML(r, display.get(r.id), isHigh(display.get(r.id)))).join('');
    html += '</div></div>';
  }
  let host = panel.querySelector('#buddy-live');
  if (!host) {
    host = document.createElement('div');
    host.id = 'buddy-live';
    panel.insertBefore(host, panel.firstChild);
  }
  host.innerHTML = html;
  // v532 (RC2): live sections exist → js/197's empty-state note
  // has done its job.
  if (html) { const note = panel.querySelector('#buddy-empty-note'); if (note) note.remove(); }

  /* Match-row buttons: label per the rows that stand. */
  panel.querySelectorAll('[data-buddy-invite]').forEach(btn => {
    const friendId = btn.getAttribute('data-buddy-friend');
    const key = btn.getAttribute('data-buddy-invite');
    const row = buddyRowFor(friendId, key);
    if (row && row.status === 'active') {
      btn.replaceWith(Object.assign(document.createElement('span'), { className: 'note', textContent: 'Reading together' }));
    } else if (row && row.status === 'pending') {
      btn.replaceWith(Object.assign(document.createElement('span'), { className: 'note', textContent: 'Invitation above' }));
    } else if (buddyInvitedLocal.has(friendId + '|' + key)) {
      btn.replaceWith(Object.assign(document.createElement('span'), { className: 'note', textContent: 'Invited' }));
    } else {
      btn.addEventListener('click', () => buddySendInvite(friendId, key, btn));
    }
  });

  /* Invite-card + active-row wiring. */
  const byId = {};
  rows.forEach(r => { byId[r.id] = r; });
  host.querySelectorAll('[data-buddy-accept]').forEach(btn => btn.addEventListener('click', async () => {
    const row = byId[btn.getAttribute('data-buddy-accept')];
    if (!row || btn.disabled) return;
    btn.disabled = true;
    if (await buddyRespond(row.id, true)) {
      track('buddy_accepted');
      toast('You’re reading it together now');
      if (typeof refreshCovenStats === 'function') refreshCovenStats();
    } else { btn.disabled = false; toast('Couldn’t accept that invitation'); }
  }));
  host.querySelectorAll('[data-buddy-decline]').forEach(btn => btn.addEventListener('click', async () => {
    const row = byId[btn.getAttribute('data-buddy-decline')];
    if (!row || btn.disabled) return;
    btn.disabled = true;
    // Quiet by design: no toast, no trace on the inviter's side.
    if (await buddyRespond(row.id, false)) {
      if (typeof refreshCovenStats === 'function') refreshCovenStats();
    } else { btn.disabled = false; toast('Couldn’t decline that invitation'); }
  }));
  host.querySelectorAll('[data-buddy-report]').forEach(btn => btn.addEventListener('click', () => {
    const row = byId[btn.getAttribute('data-buddy-report')];
    if (row) openReportSheet(buddyPartnerId(row), buddyName(buddyPartnerId(row)));
  }));
  host.querySelectorAll('[data-buddy-block]').forEach(btn => btn.addEventListener('click', () => {
    const row = byId[btn.getAttribute('data-buddy-block')];
    if (row) openBlockSheet(buddyPartnerId(row), buddyName(buddyPartnerId(row)), () => {
      if (typeof renderCoven === 'function') renderCoven();
    });
  }));
  host.querySelectorAll('[data-buddy-end]').forEach(btn => btn.addEventListener('click', () => {
    const row = byId[btn.getAttribute('data-buddy-end')];
    if (row) openBuddyEndSheet(row, btn);
  }));

  /* Presence: fetch state enums for the active reads and paint the
   * chips. A book the viewer's shield filters is never asked about
   * (the v525 fetch discipline) — its chips simply stay empty. */
  await Promise.all(actives.map(async (row) => {
    if (isHigh(display.get(row.id))) return;
    const states = await buddyStates(row.id);
    if (!states || !document.body.contains(panel)) return;
    const strip = host.querySelector('[data-buddy-states="' + row.id + '"]');
    if (strip) strip.innerHTML = buddyStateChipsHTML(row, states);
    if (states.mine === 'finished' && states.theirs === 'finished') {
      const done = host.querySelector('[data-buddy-done="' + row.id + '"]');
      if (done) done.innerHTML = icon('sparkles') + ' You both finished it';
    }
  }));
}

/* End a buddy read: a calm confirm (a covenOpenSheet, so the
 * swipe-to-dismiss rule is inherited), then the RPC. Silent for
 * the partner — the read just stops being there. */
function openBuddyEndSheet(row, opener) {
  const partner = buddyPartnerId(row);
  const book = buddyDisplayBook(row);
  const body =
    '<p class="note" style="margin-top:0">End your buddy read of <i>' + esc(book.title || 'Untitled') +
    '</i> with ' + esc(buddyName(partner)) + '? You’ll both stop seeing each other’s reading state for this book. ' +
    'The book stays on both your shelves — this only ends the buddy read.</p>' +
    '<div class="modal-actions"><button class="btn" id="buddy-end-yes">End buddy read</button>' +
    '<button class="btn ghost" id="buddy-end-no">Keep reading</button></div>';
  const ref = covenOpenSheet('End buddy read?', body, opener || null);
  ref.sheet.querySelector('#buddy-end-no').addEventListener('click', () => ref.close());
  ref.sheet.querySelector('#buddy-end-yes').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    if (await buddyEnd(row.id)) {
      track('buddy_ended');
      buddyRowsCache = buddyRowsCache.filter(r => r.id !== row.id);
      toast('Buddy read ended');
      ref.close();
      if (typeof refreshCovenStats === 'function') refreshCovenStats();
    } else {
      e.currentTarget.disabled = false;
      toast('Couldn’t end that buddy read');
    }
  });
}
