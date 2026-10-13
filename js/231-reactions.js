'use strict';

/* ---------------- Reactions on moments (v525) ----------------
   Social build #1: the Hearth stops being one-way. A "moment" is a
   circle member finishing a book (status 'read' with a finish date,
   last 90 days), derived client-side in js/197 from the same book
   lists the digest already uses:

   - activity opt-in: a friend who hasn't opted into activity sharing
     (share_activity, v522) never has their books fetched for stats,
     so the app produces no moments for them;
   - the content shield (v524): js/197 hands this module the
     POST-filter book list, so a moment filtered out for this viewer
     is never computed — and because reaction fetches go by explicit
     moment-key list (never a blanket query), the app never requests
     reaction data for a filtered moment either. (Stated precisely:
     this is a property of the app's own data flow. The shield is a
     viewer-side display filter, never a server boundary.)

   Display discipline is NOT the security boundary here — the server
   is. Writes go only through the react_to_moment() RPC (migration
   v525), which re-validates at write time: accepted friendship, the
   owner's CURRENT activity opt-in, read-shelf visibility, and the
   book really existing with that status and finish day. Reads are
   RLS-bound to giver-or-owner. So turning activity off, unsharing,
   or hiding the read shelf stops new reactions immediately, whoever
   asks.

   HARD RULE (the User's spec): no counts or tallies anywhere — no
   "×3", no aggregate numbers, no leaderboards. Reactions are shown
   as the individual people who gave them: the moment's owner sees
   one chip per reactor, and a giver sees only their own reaction on
   someone else's moment. RLS makes third-party enumeration
   impossible, so no tally over other people's reactions can be
   computed by any client.

   Friend milestones are deliberately NOT moments in v1: a friend's
   milestone can't be computed truthfully from the books they share
   (hidden shelves distort the counts) — earned, not guessed. */

/* The reaction set: five warm, bookish kinds, all from the app's own
   ICONS set, no negatives, no free text anywhere in the feature. */
const REACTION_KINDS = [
  { id: 'heart',    icon: 'heart',    label: 'Loved it' },
  { id: 'sparkles', icon: 'sparkles', label: 'Pure magic' },
  { id: 'moon',     icon: 'moon',     label: 'Kept me up all night' },
  { id: 'trophy',   icon: 'trophy',   label: 'What a feat' },
  { id: 'smile',    icon: 'smile',    label: 'Made me smile' },
];
function reactionKind(id) {
  for (let i = 0; i < REACTION_KINDS.length; i++) if (REACTION_KINDS[i].id === id) return REACTION_KINDS[i];
  return null;
}

/* ---------- moment identity ----------
   key = owner_id || ':' || book_id || ':' || finish-day, built
   identically by this client (for reads) and by react_to_moment()
   (for writes). book_id is the book row id that already syncs across
   the owner's devices; owner ids are uuids and book ids are base36
   (js/050 uid()), so ':' is an unambiguous separator. The key is a
   plain join key, NOT a secret and NOT an entitlement: every part of
   it is already visible to the two parties who may read a reaction
   row, and the RPC re-validates the whole claim at write time
   regardless of who computed the key. Editing a finish date re-keys
   the moment (reactions stay with the old key, readable only by
   giver/owner). */
function momentDayOf(book) {
  const d = book && book.dateFinished ? String(book.dateFinished).slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}
function momentKeyFor(ownerId, book) {
  if (!ownerId || !book || !book.id || book.status !== 'read') return '';
  const day = momentDayOf(book);
  if (!day) return '';
  return ownerId + ':' + book.id + ':' + day;
}
const MOMENT_WINDOW_DAYS = 90;
const MOMENT_FEED_MAX = 30;
function rxDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/* Finished-book moments from one person's (already gate-filtered)
   book list, newest first. */
function momentsFromBooks(ownerId, books, now) {
  const out = [];
  const cutoff = rxDayKey(new Date((now || new Date()).getTime() - MOMENT_WINDOW_DAYS * 864e5));
  (books || []).forEach(b => {
    const key = momentKeyFor(ownerId, b);
    if (!key) return;
    const day = momentDayOf(b);
    if (day < cutoff) return;
    out.push({ key: key, ownerId: ownerId, bookId: b.id, title: b.title || 'Untitled', day: day });
  });
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : String(a.title).localeCompare(String(b.title))));
  return out;
}

/* ---------- storage (moment_reactions) ----------
   Pre-migration tolerance (the v524 rule): if the table/function
   isn't there yet, fetches resolve to [] and writes no-op — the feed
   renders without reactions rather than breaking. Only the missing
   -object errors are silent; anything else is logged, not swallowed.
   The coordinator applies migration v525 right after merge. */
let rxTableMissing = false;
function reactionsMissingErr(e) {
  const s = String((e && (e.code + ' ' + e.message)) || e || '');
  return /moment_reactions/i.test(s) && /schema cache|could not find|does not exist|not found|PGRST205|404|42P01/i.test(s);
}
function reactionsRpcMissing(e) {
  const s = String((e && (e.code + ' ' + e.message)) || e || '');
  return /react_to_moment/i.test(s) || /PGRST202|42883|could not find the function/i.test(s);
}
function rxLog(what, e) {
  try { if (typeof AppLog !== 'undefined' && AppLog.error) AppLog.error('reactions', what + ': ' + ((e && e.message) || e)); } catch (x) {}
}
async function reactionsFetch(keys) {
  if (!keys || !keys.length || rxTableMissing) return [];
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return [];
    const r = await sb.from('moment_reactions')
      .select('moment_key,owner_id,giver_id,kind').in('moment_key', keys);
    if (r.error) {
      if (reactionsMissingErr(r.error)) { rxTableMissing = true; return []; }
      rxLog('fetch failed', r.error);
      return [];
    }
    // Belt to the RLS braces (the circleProjectRow pattern): even if a
    // future query mistake widened the read, only rows where I am the
    // giver or the owner may reach the UI — a third friend's reactions
    // on someone else's moment are dropped here, never rendered.
    return (r.data || []).filter(row => row && (row.giver_id === cloudUser.id || row.owner_id === cloudUser.id));
  } catch (e) { rxLog('fetch failed', e); return []; }
}
/* The write path is the react_to_moment() RPC and nothing else: the
   server validates friendship, the owner's current sharing posture,
   and the moment's reality, then computes the key and upserts. A
   kind change arrives here the same way (the function's conflict
   path updates the one row). Returns true when the reaction landed. */
async function reactionSet(moment, kind) {
  if (rxTableMissing || !moment || !reactionKind(kind)) return false;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.rpc('react_to_moment', {
      p_owner: moment.ownerId, p_book_id: moment.bookId, p_day: moment.day, p_kind: kind,
    });
    if (r.error) {
      if (reactionsRpcMissing(r.error) || reactionsMissingErr(r.error)) { rxTableMissing = true; return false; }
      rxLog('react failed', r.error);
      return false;
    }
    return true;
  } catch (e) { rxLog('react failed', e); return false; }
}
async function reactionRemove(momentKey) {
  if (rxTableMissing || !momentKey) return false;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.from('moment_reactions').delete()
      .eq('moment_key', momentKey).eq('giver_id', cloudUser.id);
    if (r.error) {
      if (reactionsMissingErr(r.error)) { rxTableMissing = true; return false; }
      rxLog('remove failed', r.error);
      return false;
    }
    return true;
  } catch (e) { rxLog('remove failed', e); return false; }
}

/* ---------- rendering ----------
   Owner's view of their moment: one chip per reactor — the person
   and their kind, never a number. Giver's view of a friend's moment:
   only their own chip ("You · kind"); other givers' reactions are
   not returned by RLS and not rendered. */
const RX_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function momentDayLabel(day) {
  const p = String(day || '').split('-');
  if (p.length !== 3) return '';
  const m = RX_MONTHS[Number(p[1]) - 1] || '';
  return m ? m + ' ' + Number(p[2]) : '';
}
function momentRowHTML(m) {
  const p = m.person || { name: 'A reader', profile: null };
  const mine = typeof cloudUser !== 'undefined' && cloudUser && m.ownerId === cloudUser.id;
  return '<div class="moment" data-moment="' + esc(m.key) + '">' +
    '<div class="circle-row">' + statAvatar(p) +
    '<div class="circle-meta"><b>' + esc(mine ? 'You' : (p.name || 'A reader')) + '</b>' +
    '<span class="note">finished <i>' + esc(m.title) + '</i> · ' + esc(momentDayLabel(m.day)) + '</span></div>' +
    (mine ? '' : '<div class="circle-actions"><button class="btn ghost sm" data-react="' + esc(m.key) + '">React</button></div>') +
    '</div>' +
    '<div class="moment-strip" data-mstrip="' + esc(m.key) + '"></div>' +
    (mine ? '' : '<div class="moment-picker" data-mpicker="' + esc(m.key) + '" hidden>' +
      REACTION_KINDS.map(k =>
        '<button class="rx-kind" data-kind="' + k.id + '" data-mkey="' + esc(m.key) + '" aria-label="' + esc(k.label) + '" title="' + esc(k.label) + '">' +
        icon(k.icon) + '<span>' + esc(k.label) + '</span></button>').join('') +
      '<button class="rx-kind rx-remove" data-rxremove="' + esc(m.key) + '" hidden>Remove</button>' +
      '</div>') +
    '</div>';
}
function rxGiverName(giverId) {
  const pr = (typeof circProfiles !== 'undefined' && circProfiles) ? circProfiles[giverId] : null;
  if (pr) {
    const n = ((pr.first_name || '') + ' ' + (pr.last_name || '')).trim();
    if (n) return n;
  }
  return 'A friend';
}
function rxStripHTML(m, rows) {
  const me = (typeof cloudUser !== 'undefined' && cloudUser) ? cloudUser.id : '';
  const mine = m.ownerId === me;
  let html = '';
  (rows || []).forEach(r => {
    const k = reactionKind(r.kind);
    if (!k) return;
    if (mine) {
      html += '<span class="rx-chip" title="' + esc(rxGiverName(r.giver_id)) + ' — ' + esc(k.label) + '">' +
        icon(k.icon) + esc(String(rxGiverName(r.giver_id)).split(' ')[0]) + '</span>';
    } else if (r.giver_id === me) {
      html += '<span class="rx-chip mine" title="Your reaction — ' + esc(k.label) + '">' + icon(k.icon) + 'You</span>';
    }
    // Any other row (a third friend's reaction) is not rendered — RLS
    // already keeps it off the wire; this is the second lock.
  });
  return html;
}
/* Fetch reactions for exactly the rendered moments and paint the
   strips; wire the React buttons + pickers. Called by js/197 after
   the stats HTML lands (the refreshRecos pattern). */
async function wireMomentReactions(root, moments) {
  if (!root || !moments || !moments.length) return;
  const byKey = {};
  moments.forEach(m => { byKey[m.key] = m; });
  const paint = (rows) => {
    const grouped = {};
    (rows || []).forEach(r => { (grouped[r.moment_key] = grouped[r.moment_key] || []).push(r); });
    moments.forEach(m => {
      const strip = root.querySelector('[data-mstrip="' + m.key + '"]');
      if (strip) strip.innerHTML = rxStripHTML(m, grouped[m.key] || []);
      const me = (typeof cloudUser !== 'undefined' && cloudUser) ? cloudUser.id : '';
      const myRow = (grouped[m.key] || []).find(r => r.giver_id === me);
      const rm = root.querySelector('[data-rxremove="' + m.key + '"]');
      if (rm) rm.hidden = !myRow;
      root.querySelectorAll('[data-mpicker="' + m.key + '"] .rx-kind[data-kind]').forEach(b => {
        b.classList.toggle('active', !!myRow && myRow.kind === b.dataset.kind);
      });
    });
  };
  const refresh = async () => paint(await reactionsFetch(moments.map(m => m.key)));
  root.querySelectorAll('[data-react]').forEach(btn => btn.addEventListener('click', () => {
    const picker = root.querySelector('[data-mpicker="' + btn.dataset.react + '"]');
    if (picker) picker.hidden = !picker.hidden;
  }));
  root.querySelectorAll('.rx-kind[data-kind]').forEach(b => b.addEventListener('click', async () => {
    const m = byKey[b.dataset.mkey];
    if (!m) return;
    const ok = await reactionSet(m, b.dataset.kind);
    if (ok) { toast('Reaction sent'); refresh(); }
    else toast('Couldn’t send that reaction');
  }));
  root.querySelectorAll('[data-rxremove]').forEach(b => b.addEventListener('click', async () => {
    const ok = await reactionRemove(b.dataset.rxremove);
    if (ok) { toast('Reaction removed'); refresh(); }
    else toast('Couldn’t remove that reaction');
  }));
  await refresh();
}
