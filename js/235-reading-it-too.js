'use strict';

/* ---------------- Reading it too (v541, Social build #5) ----------------
 * When people in your Circle are reading the same book you are, the
 * app quietly says so — shared-reading PRESENCE, on the ratified
 * Buddy Reads model (v528, reaffirmed v532): presence, not pace.
 * The contract, in full:
 *
 * - A bare "reading it too" is all that exists to show: no progress,
 *   no page numbers, no dates, no "started when". The data path never
 *   reads a friend's progress/log/date fields — only the copy's
 *   status is consulted, and only for the value 'reading'.
 * - NO counts on the surface: friends appear as avatars + names,
 *   never as a numeral ("3 friends are reading this" is banned).
 * - Consent is the EXISTING visibility machinery, exactly as Buddy
 *   Reads settled it: a friend's copy counts only when it reaches us
 *   through the shelf-visible path (circleFriendBooks — RLS decides
 *   what exists: accepted link, unblocked pair, share_library, and
 *   per-shelf visibility via circle_book_visible). The global
 *   share_activity toggle does NOT gate this (the v528 ruling:
 *   per-book visibility IS the consent; v532 decoupled buddy
 *   matching from the stats pipeline on the same reasoning, and the
 *   matches below deliberately come from the SHELF path, never from
 *   activity stats). Blocked pairs are not circle friends, so they
 *   see nothing of each other in either direction.
 * - Shield (v524): for a shielded viewer, a work whose spice is
 *   KNOWN >= 4 gets no presence row at all — no names, no avatars,
 *   no placeholder. Unknown spice is NOT high (the v524 rule), so a
 *   copy with no spice signal never suppresses the row.
 * - Cross-user matching reuses recoKey (js/196) — the ISBN /
 *   normalized title+author key buddy reads and recommendations
 *   already match on. Row ids and app book ids are per-user and are
 *   never compared across users.
 * - Nothing is stored: no tables, no rows, no moments. Both surfaces
 *   compute live from the same visible-shelf data the Hearth already
 *   loads, and forget it when the view closes.
 */

function ritLog() {
  if (window.AppLog && AppLog.info) AppLog.info.apply(AppLog, ['[rittoo]'].concat([].slice.call(arguments)));
}

/* ---------- the matcher (pure) ----------
 * shelves: [{ friend: { id, name, profile }, books: [visible copies] }]
 * as the shelf-visible path hands them over. Returns one entry per
 * friend holding a 'reading' copy of the work `key` names:
 * [{ friendId, name, profile, copy }]. Only status is read from a
 * friend's copy — never progress, logs, or dates. */
function ritMatchesForKey(key, shelves) {
  const out = [];
  if (!key || !Array.isArray(shelves)) return out;
  shelves.forEach(s => {
    if (!s || !s.friend || !Array.isArray(s.books)) return;
    const copy = s.books.find(b => b && b.status === 'reading' &&
      typeof recoKey === 'function' && recoKey(b) === key);
    if (copy) out.push({ friendId: s.friend.id, name: s.friend.name || 'A friend', profile: s.friend.profile || null, copy: copy });
  });
  return out;
}

/* The Hearth grouping (pure): my currently-reading books × the
 * circle's visible 'reading' copies.
 * mine:   my books with status 'reading'.
 * others: [{ person, reading: [their visible 'reading' copies] }]
 *         — in js/197 these come from each friend's SHELF view
 *         (shelfStats), which is the v532 consent split: shelf data,
 *         shield-filtered upstream, activity toggle irrelevant.
 * Returns [{ book (MY copy), friends: [{ person, copy }] }] in my
 * reading order; a book with no qualifying friend is absent, and a
 * friend with two copies of one work appears once. */
function ritOverlaps(mine, others) {
  const out = [];
  if (!Array.isArray(mine) || !Array.isArray(others)) return out;
  const seen = new Set();
  mine.forEach(book => {
    if (!book || book.status !== 'reading' || typeof recoKey !== 'function') return;
    const key = recoKey(book);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const friends = [];
    others.forEach(o => {
      if (!o || !Array.isArray(o.reading)) return;
      const copy = o.reading.find(b => b && recoKey(b) === key);
      if (copy) friends.push({ person: o.person, copy: copy });
    });
    if (friends.length) out.push({ book: book, friends: friends });
  });
  return out;
}

/* ---------- phrasing + markup ----------
 * Names only, never a count: one friend is "Alyssa is reading this
 * too"; more are listed by first name. The verb agrees with the
 * number of NAMES shown, which is grammar, not a tally. */
function ritFirstName(name) {
  return String(name || 'A friend').split(' ')[0];
}
function ritNamesPhrase(matches) {
  const names = (matches || []).map(m => ritFirstName(m.name));
  if (!names.length) return '';
  if (names.length === 1) return names[0] + ' is reading this too';
  if (names.length === 2) return names[0] + ' and ' + names[1] + ' are reading this too';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' are reading this too';
}
function ritAvatarsHTML(matches) {
  return (matches || []).map(m => {
    if (m.profile && typeof circAvatarHTML === 'function') return circAvatarHTML(m.profile, 'c-avatar rit-avatar');
    const initial = esc(ritFirstName(m.name).charAt(0).toUpperCase() || '?');
    return '<span class="c-avatar letter rit-avatar" aria-hidden="true">' + initial + '</span>';
  }).join('');
}
/* The modal presence row. Deliberately bare: avatars + the phrase.
 * Nothing else about the friend's copy is rendered — no cover, no
 * edition, no state beyond the presence itself. */
function ritRowHTML(matches) {
  if (!matches || !matches.length) return '';
  return '<div class="rit-row"><span class="rit-avatars">' + ritAvatarsHTML(matches) + '</span>' +
    '<span class="rit-text">' + esc(ritNamesPhrase(matches)) + '</span></div>';
}

/* ---------- the shelf-visible fetch (modal surface) ----------
 * Friends via circleLists (accepted links only — blocked pairs are
 * not friends and never appear), shelves via circleFriendBooks
 * concurrently (the v496/loadRecos pattern; a failed fetch skips
 * that friend). Deliberately NO share_activity filter: see the
 * header. Results are cached briefly so opening several books in a
 * row doesn't refetch the circle's shelves each time; the cache is
 * memory-only and dies with the session. */
let ritShelvesCache = null; // { at, shelves }
const RIT_CACHE_MS = 60000;
async function ritLoadShelves() {
  if (ritShelvesCache && (Date.now() - ritShelvesCache.at) < RIT_CACHE_MS) return ritShelvesCache.shelves;
  if (typeof cloudUser === 'undefined' || !cloudUser) return [];
  let friends = [];
  try { friends = (await circleLists()).friends || []; } catch (e) { ritLog('lists failed:', (e && e.message) || e); return []; }
  const fetched = await Promise.all(friends.map(f =>
    circleFriendBooks(f.id).then(books => ({ friend: f, books: books }), () => null)
  ));
  const shelves = fetched.filter(Boolean);
  ritShelvesCache = { at: Date.now(), shelves: shelves };
  return shelves;
}

/* ---------- book modal surface (js/150's #m-rittoo slot) ----------
 * Fills the slot renderDetailModal left under the hero. Empty stays
 * empty: when nobody qualifies, nothing renders — no placeholder,
 * no empty state. The shield runs before any HTML is built (the
 * js/196/js/233 discipline): if ANY qualifying copy of the work is
 * known-high-spice, the row is suppressed whole. */
async function fillReadingItToo(book) {
  const slot = document.getElementById('m-rittoo');
  if (!slot || !book || typeof recoKey !== 'function') return;
  const key = recoKey(book);
  slot.setAttribute('data-rit-key', key || '');
  if (!key || typeof cloudUser === 'undefined' || !cloudUser) return;
  const shelves = await ritLoadShelves();
  // The modal may have moved on (another book, or closed) meanwhile.
  if (!document.body.contains(slot) || slot.getAttribute('data-rit-key') !== key) return;
  const matches = ritMatchesForKey(key, shelves);
  if (!matches.length) return;
  if (typeof shieldOn === 'function' && shieldOn() && typeof shieldIsHighSpice === 'function') {
    let smap = {};
    if (typeof shieldSpiceMapFor === 'function') {
      try { smap = await shieldSpiceMapFor(matches.map(m => m.copy)); } catch (e) { smap = {}; }
    }
    if (matches.some(m => shieldIsHighSpice(m.copy, smap))) return; // suppressed whole
    if (!document.body.contains(slot) || slot.getAttribute('data-rit-key') !== key) return;
  }
  slot.innerHTML = ritRowHTML(matches);
  if (typeof circleUpgradeAvatars === 'function') circleUpgradeAvatars(slot);
}

/* ---------- Hearth surface (js/197's Activity tab) ----------
 * One row per shared read: MY cover and title (my copy is what
 * renders — the buddy-reads discipline), the friends as avatars +
 * the same names phrase as the modal. js/197 computes the overlaps
 * from the shelf view inside loadCovenStats and hands them here;
 * an empty list renders as no section at all (the v535 coven
 * treatment: never a heading over nothing). */
function ritHearthCardHTML(overlaps) {
  if (!overlaps || !overlaps.length) return '';
  let html = '<div class="circle-card"><h3 style="margin:0 0 10px">Reading it too</h3><div class="circle-list">';
  overlaps.forEach(o => {
    const matches = o.friends.map(f => ({
      friendId: f.person.id, name: f.person.name, profile: f.person.profile, copy: f.copy,
    }));
    html += '<div class="circle-row">' +
      ((typeof recoCoverHTML === 'function') ? recoCoverHTML(o.book) : '') +
      '<div class="circle-meta"><b>' + esc(o.book.title || 'Untitled') + '</b>' +
      '<span class="note rit-line"><span class="rit-avatars">' + ritAvatarsHTML(matches) + '</span>' +
      '<span>' + esc(ritNamesPhrase(matches)) + '</span></span></div></div>';
  });
  html += '</div></div>';
  return html;
}
