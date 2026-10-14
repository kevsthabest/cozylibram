'use strict';

/* ---------------- Things you've sent (v532, remediation Batch A) ----------------
 * The sender-side gap the review wave named (Strategist #1): a
 * Thought-of-you send and a buddy invite were both fire-and-forget
 * with NO durable record the sender could look at — a send was
 * indistinguishable from the app eating the action. This section
 * is the email model's Sent folder, NOT a receipt system:
 *
 * - Data comes only from two caller-scoped SECURITY DEFINER RPCs
 *   (migration v532): my_sent_thoughts() / my_sent_buddy_invites().
 *   The tables gain no new policies; each RPC returns only rows
 *   where the caller is the sender.
 * - A row carries what the sender already knows: the book, who it
 *   went to, and when it was sent. It NEVER carries recipient-side
 *   state — the buddy RPC doesn't even return the row's status, so
 *   an invite reads "sent" whether it is pending, active (already
 *   visible to both in Reading together), or anything else.
 * - An entry stands while its card/invite row stands. A send
 *   leaves the list when the card is dismissed, added to a TBR,
 *   expired (60 days), unsent from here, or the pair parts — the
 *   sender is never told which, and two of those are the good
 *   outcomes. That ambiguity is the anti-receipt property, kept
 *   deliberately.
 * - Unsend for Thought-of-you lives here (recall_thought_of_you,
 *   wired at last — audit #6). Buddy invites carry no action: an
 *   active read is managed in Reading together, as before.
 * - Pre-migration the RPCs don't exist: the fetch latches
 *   "unsupported" and the section hides quietly, like every social
 *   surface before it.
 */

let sentUnsupported = false;

function sentLog() {
  if (window.AppLog && AppLog.info) AppLog.info.apply(AppLog, ['[sent]'].concat([].slice.call(arguments)));
}
function sentRpcMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /(my_sent_thoughts|my_sent_buddy_invites)/i.test(msg) &&
    (code === 'PGRST202' || code === '42883' ||
     /schema cache|does not exist|not found/i.test(msg));
}

/* Both lists in one fetch, or null when the surface can't be
 * served (signed out, pre-migration, transient failure) — the
 * section renders nothing for null, and only the missing-function
 * shape latches. */
async function sentFetch() {
  if (sentUnsupported) return null;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return null;
    const [t, b] = await Promise.all([
      sb.rpc('my_sent_thoughts'),
      sb.rpc('my_sent_buddy_invites'),
    ]);
    if (t.error || b.error) {
      const e = t.error || b.error;
      if (sentRpcMissingErr(e)) { sentUnsupported = true; return null; }
      sentLog('fetch failed:', (e && e.message) || e);
      return null;
    }
    return { thoughts: Array.isArray(t.data) ? t.data : [], invites: Array.isArray(b.data) ? b.data : [] };
  } catch (e) { sentLog('fetch threw', e); return null; }
}

const SENT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function sentDayLabel(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const base = SENT_MONTHS[d.getMonth()] + ' ' + d.getDate();
  return d.getFullYear() === new Date().getFullYear() ? base : base + ', ' + d.getFullYear();
}

/* The recipient's name for a sent row: my circle projection first
 * (freshest), then the name the RPC carried (it survives the pair
 * parting — the record of who I sent to is mine), then generic. */
function sentName(id, rpcName) {
  const p = (typeof circProfiles !== 'undefined' && circProfiles) ? circProfiles[id] : null;
  if (p) {
    // v550: the one display helper (js/237) — @handle when set.
    const n = friendDisplayName(p, '');
    if (n) return n;
  }
  if (rpcName) return String(rpcName);
  return 'A friend';
}

function sentThoughtRowHTML(e) {
  const r = e.row;
  const b = toySnapshotBook(r.book);
  const note = String(r.note || '');
  return '<div class="circle-row reco-row">' +
    recoCoverHTML(b) +
    '<div class="circle-meta"><b>' + esc(b.title) + '</b>' +
    (b.authors.length ? '<span class="note">by ' + esc(b.authors.join(', ')) + '</span>' : '') +
    '<span class="note">' + icon('gift') + ' to ' + esc(sentName(r.recipient_id, r.recipient_name)) +
    ' · ' + esc(sentDayLabel(r.created_at)) + '</span>' +
    (note ? '<span class="toy-note">\u201C' + esc(note) + '\u201D</span>' : '') +
    '</div>' +
    '<div class="circle-actions"><button class="btn ghost sm" data-sent-unsend="' + esc(r.id) + '">Unsend</button></div></div>';
}

function sentInviteRowHTML(e) {
  const r = e.row;
  const b = (typeof buddyDisplayBook === 'function')
    ? buddyDisplayBook({ book_key: r.book_key })
    : { title: 'A book', authors: [], cover: '', coverColor: '', ratings: {} };
  return '<div class="circle-row reco-row">' +
    ((typeof buddyCoverHTML === 'function') ? buddyCoverHTML(b, false) : recoCoverHTML(b)) +
    '<div class="circle-meta"><b>' + esc(b.title || 'Untitled') + '</b>' +
    (b.authors && b.authors.length ? '<span class="note">by ' + esc(b.authors.join(', ')) + '</span>' : '') +
    '<span class="note">' + icon('friends') + ' Buddy read invitation to ' +
    esc(sentName(r.invitee_id, r.invitee_name)) + ' · ' + esc(sentDayLabel(r.created_at)) + '</span>' +
    '</div></div>';
}

function sentSectionHTML(entries) {
  let html = '<div class="circle-card" style="margin-top:14px"><h3 class="serif" style="margin:0 0 4px">' +
    icon('share') + ' Things you\u2019ve sent</h3>' +
    '<p class="note" style="margin:0 0 8px">Only you see this list. It\u2019s a record of sending \u2014 not a window into what happened next.</p><div class="circle-list">';
  html += entries.map(e => (e.kind === 'toy' ? sentThoughtRowHTML(e) : sentInviteRowHTML(e))).join('');
  return html + '</div></div>';
}

function wireSentOutbox(slot, entries) {
  const byId = {};
  entries.forEach(e => { if (e.kind === 'toy') byId[e.row.id] = e.row; });
  slot.querySelectorAll('[data-sent-unsend]').forEach(btn => btn.addEventListener('click', async () => {
    const r = byId[btn.getAttribute('data-sent-unsend')];
    if (!r || btn.disabled) return;
    btn.disabled = true;
    if (typeof toyRecall === 'function' && await toyRecall(r.recipient_id, r.sender_book_id)) {
      toast('Recommendation unsent');
      refreshSentOutbox();
    } else {
      btn.disabled = false;
      toast('Couldn\u2019t unsend that one');
    }
  }));
}

/* Render the outbox into #sent-slot (renderCovenMain's slot, right
 * under the Thought-of-you inbox). Empty or unservable → the slot
 * stays empty; the section exists only when there is something
 * the sender actually sent. */
async function refreshSentOutbox() {
  const slot = document.getElementById('sent-slot');
  if (!slot || typeof cloudUser === 'undefined' || !cloudUser) return;
  const data = await sentFetch();
  if (!document.body.contains(slot)) return;
  if (!data) { slot.innerHTML = ''; return; }
  const entries = [];
  (data.thoughts || []).forEach(r => entries.push({ kind: 'toy', at: String(r.created_at || ''), row: r }));
  (data.invites || []).forEach(r => entries.push({ kind: 'buddy', at: String(r.created_at || ''), row: r }));
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (!entries.length) { slot.innerHTML = ''; return; }
  const shown = entries.slice(0, 30);
  slot.innerHTML = sentSectionHTML(shown);
  wireSentOutbox(slot, shown);
}
