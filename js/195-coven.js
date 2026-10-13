'use strict';

/* ---------------- The Hearth (v96): friends + shared shelves ---------------- */
// Your private reading circle: invite friends with a shareable link, answer
// requests, browse each other's shelves (read-only). All sharing is enforced
// by Supabase RLS — see supabase/schema.sql. The hearth needs the cloud; the
// section prompts for sign-in when offline or signed out.
// v522: other users' profiles are read ONLY through the circle_profiles
// public projection (identity + toggled-on fields) — see the projection
// section below. Base profiles rows are owner-only.

/* User's call (2026-10-11): the social section is called "The Hearth" in
   every theme. The old theme-specific names (Night Court, Harvest Court,
   Book Club, ...) are retired. */
function covenName() { return 'The Hearth'; }
// Possessive-safe form: "your hearth", not "your the hearth".
function covenNameBare() { return covenName().replace(/^the\s+/i, ''); }
function refreshCovenNav() {
  const btn = document.querySelector('.bottom-nav [data-nav="coven"]');
  if (!btn) return;
  const name = covenName();
  btn.setAttribute('aria-label', name);
  const label = btn.querySelector('span');
  if (label) label.textContent = name;
}

let circFriend = null;   // { id, name } — friend whose shelves are open
let circShelf = 'all';   // shelf filter in the friend view
let circBooks = [];      // friend's visible books (this session's view)
const circProfiles = {}; // user_id -> profile row cache (names, avatars)

/* ---------- invite links ---------- */
// v240: invite links replaced the old 6-char codes. The token is a 12-char
// URL-safe crypto-random string (72 bits) — unguessable, so invite codes are
// no longer enumerable. It doubles as the link slug: #/invite/<token>.
const INVITE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function genInviteCode() {
  const bytes = new Uint8Array(12);
  try { window.crypto.getRandomValues(bytes); }
  catch (e) { for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let s = '';
  for (let i = 0; i < 12; i++) s += INVITE_CHARS[bytes[i] % 64];
  return s;
}
// Accept a bare token or a pasted invite link/URL; '' when unusable.
function parseInviteToken(s) {
  const t = String(s || '').trim();
  const m = /invite\/([A-Za-z0-9\-_]{6,})/.exec(t);
  const tok = m ? m[1] : t;
  return /^[A-Za-z0-9\-_]{10,16}$/.test(tok) ? tok : '';
}
function inviteLinkFor(code) {
  return location.origin + '/#/invite/' + code;
}
// A token arriving via deep link (#/invite/<token>) waits here until the
// coven tab renders its accept card.
let pendingInviteToken = null;
function clearPendingInvite() {
  pendingInviteToken = null;
  try { sessionStorage.removeItem('cozylibram.invite'); } catch (e) {}
}
async function storeInviteCode(code) {
  const sb = await cloudClient();
  for (let t = 0; t < 5; t++) {
    const c = t === 0 ? code : genInviteCode();
    const up = await sb.from('circle_invites').upsert({ user_id: cloudUser.id, code: c }, { onConflict: 'user_id' });
    if (!up.error) return c;
    // Token collision with someone else's → try another; other errors bail.
    if (!/duplicate|unique|conflict/i.test(String((up.error && up.error.message) || ''))) throw up.error;
  }
  throw new Error('Couldn’t save the invite link — try again.');
}
async function ensureInviteCode() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return '';
  try {
    const got = await sb.from('circle_invites').select('code').eq('user_id', cloudUser.id).maybeSingle();
    if (got.error) throw got.error;
    // v240: rotate legacy short codes to the new token format lazily.
    if (got.data && got.data.code && got.data.code.length >= 10) return got.data.code;
    return await storeInviteCode(genInviteCode());
  } catch (e) { /* offline — the coven needs the cloud */ }
  return '';
}
async function rotateInviteCode() {
  return storeInviteCode(genInviteCode());
}
async function shareInviteLink(code) {
  const url = inviteLinkFor(code);
  const text = 'Join me in ' + covenName() + ' on Cozy Libram — tap the link and we’re connected.';
  track('invite_link_shared');
  if (navigator.share) {
    try { await navigator.share({ title: 'Cozy Libram', text: text, url: url }); }
    catch (e) { if (!e || e.name !== 'AbortError') toast('Couldn’t open the share sheet'); }
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
    toast('Invite link copied — send it to a friend');
  } catch (e) { toast('Couldn’t copy the link'); }
}

/* ---------- friend links ---------- */
async function circleLinkBetween(a, b) {
  const sb = await cloudClient();
  const r1 = await sb.from('circle_links').select('requester_id,addressee_id,status')
    .eq('requester_id', a).eq('addressee_id', b).maybeSingle();
  if (r1.error) throw r1.error;
  if (r1.data) return r1.data;
  const r2 = await sb.from('circle_links').select('requester_id,addressee_id,status')
    .eq('requester_id', b).eq('addressee_id', a).maybeSingle();
  if (r2.error) throw r2.error;
  return r2.data || null;
}
// Look up who owns an invite token. Returns { token, userId, profile, name }.
async function resolveInviteToken(raw) {
  const sb = await cloudClient();
  const token = parseInviteToken(raw);
  if (!token) throw new Error('That doesn’t look like an invite link — paste the full link.');
  const found = await sb.from('circle_invites').select('user_id').eq('code', token).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) throw new Error('This invite link is no longer valid — ask for a fresh one.');
  const them = found.data.user_id;
  if (them === cloudUser.id) throw new Error('That’s your own invite link — share it with a friend instead.');
  const existing = await circleLinkBetween(cloudUser.id, them);
  if (existing) {
    if (existing.status === 'accepted') throw new Error('You’re already in each other’s ' + covenNameBare().toLowerCase() + '.');
    if (existing.status === 'pending') throw new Error('A request between you is already pending.');
  }
  let prof = null, nm = 'A reader';
  try {
    prof = await circleFriendProfile(them);
    if (prof) nm = ((prof.first_name || '') + ' ' + (prof.last_name || '')).trim() || 'A reader';
  } catch (e) { /* name stays generic */ }
  return { token: token, userId: them, profile: prof, name: nm };
}
// One-sided accept: the token proves the inviter's consent, so this creates
// the friendship immediately (server-side via accept_circle_invite — the
// plain insert policy deliberately only allows pending rows).
async function acceptInviteToken(token) {
  const sb = await cloudClient();
  const r = await sb.rpc('accept_circle_invite', { p_token: token });
  if (r.error) throw r.error;
}
async function circleAnswer(them, accept) {
  const sb = await cloudClient();
  const up = await sb.from('circle_links').update({ status: accept ? 'accepted' : 'declined' })
    .eq('requester_id', them).eq('addressee_id', cloudUser.id).eq('status', 'pending');
  if (up.error) throw up.error;
  if (accept) {
    // both sides requested each other → keep a single accepted link
    await sb.from('circle_links').delete()
      .eq('requester_id', cloudUser.id).eq('addressee_id', them).eq('status', 'pending');
  }
}
async function circleCancel(them) {
  const sb = await cloudClient();
  const del = await sb.from('circle_links').delete()
    .eq('requester_id', cloudUser.id).eq('addressee_id', them).eq('status', 'pending');
  if (del.error) throw del.error;
}
async function circleRemove(them) {
  const sb = await cloudClient();
  const d1 = await sb.from('circle_links').delete()
    .eq('requester_id', cloudUser.id).eq('addressee_id', them);
  if (d1.error) throw d1.error;
  const d2 = await sb.from('circle_links').delete()
    .eq('requester_id', them).eq('addressee_id', cloudUser.id);
  if (d2.error) throw d2.error;
  delete circProfiles[them];
}

/* ---------- blocking (v526) ----------
 * Blocking severs a circle pair and keeps it severed, silently: the
 * insert into blocks fires a database trigger that deletes the pair's
 * links (and, through the v525 unfriend trigger, their reactions);
 * the projection and book visibility exclude blocked pairs outright;
 * and invite redemption refuses them with the same 'invite not found'
 * a dead token gets. The other person is never told, and no query
 * available to them can reveal the block — the blocks table's only
 * read policy is "rows I created", so everything below reads MY list
 * and nothing else. Unblocking deletes my row; it does NOT restore
 * any old link (a fresh invite is required, like anyone new). */
function blocksMissing(e) {
  const s = String((e && (e.code + ' ' + e.message)) || e || '');
  return /block/i.test(s) && /schema cache|could not find|does not exist|not found|PGRST20[0-9]|404/i.test(s);
}
let circBlocksState = null; // null = unknown; boolean once proven
async function circleBlocksSupported() {
  if (circBlocksState !== null) return circBlocksState;
  try {
    const sb = await cloudClient();
    const r = await sb.from('blocks').select('blocked_id').limit(1);
    if (!r.error) { circBlocksState = true; return true; }
    if (blocksMissing(r.error)) { circBlocksState = false; return false; }
  } catch (e) { /* transient failure: unsupported for this render, not cached */ }
  return false;
}
// Pre-migration tolerance: when the blocks table isn't there yet the
// block affordances hide entirely — nothing renders half-working.
async function applyBlockUi(scope) {
  if (!cloudUser) return;
  if (await circleBlocksSupported()) return;
  (scope || document).querySelectorAll('[data-block]').forEach(b => { b.style.display = 'none'; });
}
async function circleBlock(them) {
  const sb = await cloudClient();
  const ins = await sb.from('blocks').insert({ blocker_id: cloudUser.id, blocked_id: them });
  if (ins.error) {
    // Already blocked (unique violation): the sever ran when the row
    // was created, so the end state is exactly what was asked for.
    const s = String(ins.error.code || '') + ' ' + String(ins.error.message || '');
    if (!/23505|duplicate|unique/i.test(s)) throw ins.error;
  }
  delete circProfiles[them];
}
async function circleUnblock(them) {
  const sb = await cloudClient();
  const del = await sb.from('blocks').delete().eq('blocked_id', them);
  if (del.error) throw del.error;
}
// My blocked list (Settings). Returns null when the blocks machinery
// isn't there yet (pre-v526 database) so the section can hide.
async function circleBlockedReaders() {
  const sb = await cloudClient();
  const r = await sb.rpc('my_blocked_readers');
  if (r.error) {
    if (blocksMissing(r.error)) return null;
    throw r.error;
  }
  return r.data || [];
}
// Settings → Circle & privacy: the Blocked readers list. Only ever
// shows people I blocked (the RPC cannot return anything else).
async function renderBlockedReaders(box) {
  if (!box || !cloudUser) return;
  let rows = null;
  try { rows = await circleBlockedReaders(); } catch (e) { rows = null; }
  if (!rows) { box.innerHTML = ''; return; }
  let html = '<div class="field" style="margin-top:20px"><label>Blocked readers</label>';
  if (!rows.length) {
    html += '<p class="note">You haven’t blocked anyone.</p>';
  } else {
    html += '<div class="circle-list">' + rows.map(r => {
      const nm = ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'A reader';
      return '<div class="circle-row">' + circAvatarHTML(r, 'c-avatar') +
        '<div class="circle-meta"><b>' + esc(nm) + '</b></div>' +
        '<div class="circle-actions"><button class="btn ghost sm" data-unblock="' + esc(r.user_id) + '">Unblock</button></div></div>';
    }).join('') + '</div>';
  }
  html += '<p class="note">Blocking removes you from each other’s ' + covenNameBare().toLowerCase() +
    ' and stops either of you re-adding the other. They aren’t told. Unblocking doesn’t restore the old connection — they’d need a fresh invite, like anyone new.</p></div>';
  box.innerHTML = html;
  box.querySelectorAll('[data-unblock]').forEach(b => b.addEventListener('click', async () => {
    try {
      await circleUnblock(b.dataset.unblock);
      toast('Unblocked — a fresh invite can connect you again');
      renderBlockedReaders(box);
    } catch (e) { toast('Couldn’t unblock: ' + ((e && e.message) || e)); }
  }));
  circleUpgradeAvatars(box);
}
/* ---------- the public projection (v522) ----------
 * Every read of ANOTHER user's profile goes through the circle_profiles
 * view (migration v522): identity (name, avatar — always shared), the
 * sharing-posture flags, and bio / favourite genres only when the owner
 * has share_bio on. The base profiles row is owner-only now, so nothing
 * beyond this shape can cross the wire — not via the app, and not via a
 * hand-built PostgREST query either. circleProjectRow is the client-side
 * belt to the view's braces: it rebuilds each row with only the projected
 * keys, so even a future query mistake can't smuggle extra fields into
 * the app. A user's OWN profile is still read from the base table (see
 * circlePrivacy / js/105) and keeps every field. */
const CIRCLE_PROFILE_COLS = 'user_id,first_name,last_name,avatar_id,avatar_path,share_library,share_bio,share_activity,bio,fav_genres';
const CIRCLE_IDENTITY_COLS = 'user_id,first_name,last_name,avatar_id,avatar_path';
function circleProjectRow(p) {
  if (!p) return null;
  const out = {
    user_id: p.user_id,
    first_name: p.first_name || '', last_name: p.last_name || '',
    avatar_id: p.avatar_id || '', avatar_path: p.avatar_path || '',
    share_library: p.share_library !== false,
    share_bio: p.share_bio !== false,
    share_activity: p.share_activity === true,
  };
  if (out.share_bio) {
    if (p.bio) out.bio = String(p.bio);
    if (Array.isArray(p.fav_genres) && p.fav_genres.length) out.fav_genres = p.fav_genres.slice();
  }
  return out;
}
// True when the error says the circle_profiles view isn't there (the app
// deployed before migration v522 was applied). Only then may reads fall
// back to the legacy identity-only base-table select; any other error is
// real and must surface rather than silently degrade a privacy boundary.
function circleViewMissing(e) {
  const s = String((e && (e.code + ' ' + e.message)) || e || '');
  return /circle_profiles/i.test(s) && /schema cache|could not find|does not exist|not found|PGRST205|404/i.test(s);
}
async function circleFetchProfiles(ids) {
  const sb = await cloudClient();
  if (!ids.length) return [];
  const q = await sb.from('circle_profiles').select(CIRCLE_PROFILE_COLS).in('user_id', ids);
  if (!q.error) return (q.data || []).map(circleProjectRow);
  if (!circleViewMissing(q.error)) throw q.error;
  const legacy = await sb.from('profiles').select(CIRCLE_IDENTITY_COLS).in('user_id', ids);
  if (legacy.error) throw legacy.error;
  return (legacy.data || []).map(circleProjectRow);
}

async function circleLists() {
  const sb = await cloudClient();
  const me = cloudUser.id;
  const [rec, sent, f1, f2] = await Promise.all([
    sb.from('circle_links').select('requester_id,created_at').eq('addressee_id', me).eq('status', 'pending'),
    sb.from('circle_links').select('addressee_id,created_at').eq('requester_id', me).eq('status', 'pending'),
    sb.from('circle_links').select('addressee_id').eq('requester_id', me).eq('status', 'accepted'),
    sb.from('circle_links').select('requester_id').eq('addressee_id', me).eq('status', 'accepted'),
  ]);
  [rec, sent, f1, f2].forEach(r => { if (r.error) throw r.error; });
  const ids = {};
  (rec.data || []).forEach(r => { ids[r.requester_id] = 1; });
  (sent.data || []).forEach(r => { ids[r.addressee_id] = 1; });
  (f1.data || []).forEach(r => { ids[r.addressee_id] = 1; });
  (f2.data || []).forEach(r => { ids[r.requester_id] = 1; });
  const list = Object.keys(ids);
  if (list.length) {
    const rows = await circleFetchProfiles(list);
    rows.forEach(p => { circProfiles[p.user_id] = p; });
  }
  const prof = id => circProfiles[id] || { user_id: id, first_name: '', last_name: '', avatar_id: '', avatar_path: '' };
  const name = p => ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || 'A reader';
  const seen = {}, friends = [];
  const addFriend = id => {
    if (id && !seen[id]) { seen[id] = 1; friends.push({ id: id, profile: prof(id), name: name(prof(id)) }); }
  };
  (f1.data || []).forEach(r => addFriend(r.addressee_id));
  (f2.data || []).forEach(r => addFriend(r.requester_id));
  return {
    received: (rec.data || []).map(r => ({ id: r.requester_id, profile: prof(r.requester_id), name: name(prof(r.requester_id)) })),
    sent: (sent.data || []).map(r => ({ id: r.addressee_id, profile: prof(r.addressee_id), name: name(prof(r.addressee_id)) })),
    friends: friends,
  };
}

/* ---------- privacy ----------
 * The owner's OWN row is read from the base table (owner-only RLS) — the
 * full set of toggles lives here, never in the projection beyond the
 * posture flags themselves. Defaults match migration v522: shelves keep
 * whatever share_library already says, bio/genres on (today's de-facto
 * exposure), activity off (opt-in for everyone). */
async function circlePrivacy() {
  const sb = await cloudClient();
  let r = await sb.from('profiles').select('share_library,hidden_shelves,share_bio,share_activity,receive_recos,receive_buddy_invites').eq('user_id', cloudUser.id).maybeSingle();
  if (r.error && typeof isMissingColumn === 'function' && isMissingColumn(r.error)) {
    // Pre-v522 database: the new toggle columns don't exist yet — fall back
    // to the legacy columns and report the migration defaults for the rest.
    r = await sb.from('profiles').select('share_library,hidden_shelves').eq('user_id', cloudUser.id).maybeSingle();
  }
  if (r.error) throw r.error;
  return {
    share: r.data ? r.data.share_library !== false : true,
    hidden: (r.data && Array.isArray(r.data.hidden_shelves)) ? r.data.hidden_shelves : [],
    bio: r.data ? r.data.share_bio !== false : true,
    activity: r.data ? r.data.share_activity === true : false,
    // v527: inbound recommendations (default ON — see the migration
    // header for the called-out decision). Never projected to friends:
    // this is read from the reader's OWN profile row only.
    recos: r.data ? r.data.receive_recos !== false : true,
    // v528: buddy read invitations — the same posture as recos.
    buddy: r.data ? r.data.receive_buddy_invites !== false : true,
  };
}
async function circleSavePrivacy(share, hidden, bio, activity, recos, buddy) {
  const sb = await cloudClient();
  const row = {
    user_id: cloudUser.id, share_library: !!share, hidden_shelves: hidden,
    updated_at: new Date().toISOString(),
  };
  // bio/activity/recos/buddy are optional params: two-arg callers (the
  // shelf-share consent) must not clobber toggles they don't know
  // about, so the keys are only written when the caller passes them.
  if (typeof bio !== 'undefined') row.share_bio = !!bio;
  if (typeof activity !== 'undefined') row.share_activity = !!activity;
  if (typeof recos !== 'undefined') row.receive_recos = !!recos;
  if (typeof buddy !== 'undefined') row.receive_buddy_invites = !!buddy;
  let up = await sb.from('profiles').upsert(row, { onConflict: 'user_id' });
  if (up.error && typeof isMissingColumn === 'function' && isMissingColumn(up.error) &&
      ('share_bio' in row || 'share_activity' in row || 'receive_recos' in row || 'receive_buddy_invites' in row)) {
    // Pre-migration database: persist what exists; the new toggles
    // land with their defaults when the migration is applied.
    delete row.share_bio; delete row.share_activity; delete row.receive_recos; delete row.receive_buddy_invites;
    up = await sb.from('profiles').upsert(row, { onConflict: 'user_id' });
  }
  if (up.error) throw up.error;
}

/* v522 — the "Circle & privacy" controls, shared by the coven Privacy
 * sheet (prefix 'cc') and Settings → Circle & privacy (prefix 'st') so
 * the two surfaces can never drift. Name & avatar are identity, not a
 * toggle: they're always shared, and the panel says so instead of
 * offering a switch that couldn't keep its promise. */
function circlePrivacyPanelHTML(priv, p, shelves) {
  const seg = (id, on) => '<div class="seg" id="' + id + '">' +
    '<button data-v="1"' + (on ? ' class="active"' : '') + '>On</button>' +
    '<button data-v="0"' + (!on ? ' class="active"' : '') + '>Off</button></div>';
  let html =
    '<div class="field"><label>Name &amp; avatar</label>' +
    '<p class="note" style="margin:0">Always shared — it’s how your ' + covenNameBare().toLowerCase() + ' recognises you.</p></div>' +
    '<div class="field"><label>Profile bio &amp; favourite genres</label>' + seg(p + '-bio', priv.bio) +
    '<p class="note">Your short bio and favourite genres, shown on your profile to your ' + covenNameBare().toLowerCase() + '.</p></div>' +
    '<div class="field"><label>Share my shelves &amp; books</label>' + seg(p + '-share', priv.share) +
    '<p class="note">When off, friends still see you in their ' + covenNameBare().toLowerCase() + ', but none of your books.</p></div>';
  if (shelves && shelves.length) {
    html += '<div class="field"><label>Hide these shelves from my ' + covenNameBare().toLowerCase() + '</label>' +
      '<div class="chips" id="' + p + '-hide">' +
      shelves.map(s => '<button class="chip' + (priv.hidden.indexOf(s) !== -1 ? ' active' : '') + '" data-shelf="' + s + '">' +
        STATUS[s] + '</button>').join('') +
      '</div></div>';
  }
  html +=
    '<div class="field"><label>Reading activity</label>' + seg(p + '-act', priv.activity) +
    '<p class="note">Recently finished books, your star ratings and your Reader Portrait in circle digests. Off unless you opt in.</p></div>' +
    // v527: the one inbound social switch — whether friends may push
    // "Thought of you" recommendation cards to this reader.
    '<div class="field"><label>Book recommendations from friends</label>' + seg(p + '-recos', priv.recos !== false) +
    '<p class="note">Friends in your ' + covenNameBare().toLowerCase() + ' can send you a book with a short note (\u201CThought of you\u201D). Off stops new recommendations from arriving.</p></div>' +
    // v528: the buddy-read counterpart — whether friends may invite
    // this reader to read a book together.
    '<div class="field"><label>Buddy read invitations</label>' + seg(p + '-buddyinv', priv.buddy !== false) +
    '<p class="note">Friends in your ' + covenNameBare().toLowerCase() + ' can invite you to read a book together. Off stops new invitations from arriving.</p></div>';
  // v524: the content shield — the one INCOMING control in this panel
  // (what the viewer sees, not what they send). Its state lives in
  // user_state (js/230-privacy.js), never in profiles, so it is read
  // directly here rather than arriving via circlePrivacy().
  const shieldNow = (typeof privacyState === 'function') ? privacyState().shield : false;
  html +=
    '<div class="field"><label>Content shield</label>' + seg(p + '-shield', shieldNow) +
    '<p class="note">For what you see: high-spice covers are blurred and spice ratings hidden in shared views, Discover and recommendations — and adult titles stay out of “You’d love this” and circle stats. Your own library is never changed.</p></div>';
  return html;
}
function wireCirclePrivacyPanel(root, priv, p) {
  const state = {
    share: priv.share, hidden: (priv.hidden || []).slice(),
    bio: priv.bio !== false, activity: priv.activity === true,
    recos: priv.recos !== false, buddy: priv.buddy !== false,
  };
  const save = () => circleSavePrivacy(state.share, state.hidden, state.bio, state.activity, state.recos, state.buddy);
  const segWire = (id, key, msgOn, msgOff) => {
    root.querySelectorAll('#' + id + ' button').forEach(b => b.addEventListener('click', async () => {
      const v = b.dataset.v === '1';
      if (state[key] === v) return;
      const prev = state[key];
      state[key] = v;
      try {
        await save();
        root.querySelectorAll('#' + id + ' button').forEach(x => x.classList.toggle('active', x === b));
        toast(v ? msgOn : msgOff);
      } catch (e) {
        state[key] = prev;
        toast('Couldn’t save: ' + ((e && e.message) || e));
      }
    }));
  };
  const circle = covenNameBare().toLowerCase();
  segWire(p + '-share', 'share',
    'Your shelves are shared with your ' + circle,
    'Your shelves are hidden from your ' + circle);
  segWire(p + '-bio', 'bio',
    'Your bio & favourite genres are shared with your ' + circle,
    'Your bio & favourite genres are no longer shared');
  segWire(p + '-act', 'activity',
    'Your reading activity is shared with your ' + circle,
    'Your reading activity is no longer shared');
  segWire(p + '-recos', 'recos',
    'Friends can send you book recommendations',
    'Friends can no longer send you recommendations');
  segWire(p + '-buddyinv', 'buddy',
    'Friends can invite you to buddy reads',
    'Friends can no longer invite you to buddy reads');
  // v524: the shield seg saves through js/230 (user_state) — deliberately
  // NOT through circleSavePrivacy, so shield state can never land in
  // the profiles row a friend projects.
  if (typeof setShield === 'function' && typeof shieldOn === 'function') {
    root.querySelectorAll('#' + p + '-shield button').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.v === '1';
      if (shieldOn() === v) return;
      setShield(v);
      root.querySelectorAll('#' + p + '-shield button').forEach(x => x.classList.toggle('active', x === b));
      toast(v ? 'Content shield on' : 'Content shield off');
    }));
  }
  root.querySelectorAll('#' + p + '-hide .chip').forEach(ch => ch.addEventListener('click', async () => {
    const s = ch.dataset.shelf;
    const hidden = state.hidden.slice();
    const i = hidden.indexOf(s);
    if (i === -1) hidden.push(s); else hidden.splice(i, 1);
    const prev = state.hidden;
    state.hidden = hidden;
    try {
      await save();
      ch.classList.toggle('active', i === -1);
    } catch (e) {
      state.hidden = prev;
      toast('Couldn’t save: ' + ((e && e.message) || e));
    }
  }));
}

/* ---------- shelf-share consent (v476) ----------
   Private by default: the first time the reader accepts someone into their
   Hearth, ask whether their shelves should be shared. The profiles.share_library
   toggle is global, so this prompt runs once per device (localStorage flag) —
   answering sets the standing preference; later acceptances respect it.
   "Not now"/dismiss means defer, not revoke: an existing opt-in is never
   silently revoked. Only an explicit "Yes, share" writes to the profile. */
var SHELF_SHARE_ASKED_KEY = 'cozylibram.shelfShareAsked';
function shelfShareAsked() {
  try { return localStorage.getItem(SHELF_SHARE_ASKED_KEY) === '1'; } catch (e) { return true; }
}
function markShelfShareAsked() {
  try { localStorage.setItem(SHELF_SHARE_ASKED_KEY, '1'); } catch (e) {}
}
async function maybeAskShelfShare(friendName) {
  if (shelfShareAsked()) return;
  let hidden = [];
  try { hidden = (await circlePrivacy()).hidden || []; } catch (e) {}
  let decided = false;
  const finish = async (share) => {
    if (decided) return; decided = true;
    if (share) {
      try {
        await circleSavePrivacy(true, hidden);
        markShelfShareAsked();
      } catch (e) { /* save failed: flag stays unset, prompt returns next time */ }
    } else {
      // "Not now"/dismiss means defer, not revoke: leave profiles.share_library
      // untouched so an existing opt-in is never silently revoked for all
      // existing friends. Just record that we asked so the prompt doesn't return.
      markShelfShareAsked();
    }
    covenCloseSheet();
    toast(share ? 'Your shelves are shared with your ' + covenNameBare().toLowerCase()
                : 'No changes — manage sharing anytime in Privacy settings');
  };
  const nm = esc(friendName || 'your new friend');
  const body =
    '<p><b>' + nm + '</b> is now in your ' + esc(covenNameBare().toLowerCase()) + '.</p>' +
    '<p class="note">Let them browse your shelves? You can change this anytime in Privacy settings.</p>' +
    '<div class="modal-actions" style="margin-top:16px">' +
    '<button class="btn ghost" id="cc-ss-yes" style="flex:1;min-height:44px">Yes, share</button>' +
    '<button class="btn ghost" id="cc-ss-no" style="flex:1;min-height:44px">Not now</button>' +
    '</div>';
  covenOpenSheet('Share your shelves?', body, null, () => { if (!decided) finish(false); });
  document.getElementById('cc-ss-yes').addEventListener('click', () => finish(true));
  document.getElementById('cc-ss-no').addEventListener('click', () => finish(false));
}

/* ---------- friend shelves (read-only) ---------- */
async function circleFriendProfile(friendId) {
  const sb = await cloudClient();
  const r = await sb.from('circle_profiles').select(CIRCLE_PROFILE_COLS)
    .eq('user_id', friendId).maybeSingle();
  if (!r.error) return r.data ? circleProjectRow(r.data) : null;
  if (!circleViewMissing(r.error)) throw r.error;
  // Pre-migration fallback: identity columns only, as before v522.
  const legacy = await sb.from('profiles').select(CIRCLE_IDENTITY_COLS)
    .eq('user_id', friendId).maybeSingle();
  if (legacy.error) throw legacy.error;
  return legacy.data ? circleProjectRow(legacy.data) : null;
}
async function circleFriendBooks(friendId) {
  const sb = await cloudClient();
  const r = await sb.from('books').select('book_id,isbn,data').eq('user_id', friendId);
  if (r.error) throw r.error;
  return (r.data || []).map(row => {
    try { return migrateBook(Object.assign({}, row.data)); } catch (e) { return null; }
  }).filter(Boolean);
}
function circAvatarHTML(profile, cls) {
  const p = { avatar: { type: 'letter' }, firstName: profile.first_name, lastName: profile.last_name };
  if (profile.avatar_id && DEFAULT_AVATARS.some(a => a.id === profile.avatar_id)) {
    p.avatar = { type: 'default', id: profile.avatar_id };
  } else if (profile._photoUrl) {
    p.avatar = { type: 'upload', dataUrl: profile._photoUrl };
  }
  return avatarHTML(p, cls || 'c-avatar')
    .replace(/^<(img|span)/, '<$1 data-cav="' + esc(profile.user_id) + '"');
}
// Swap letter/themed avatars for real photos where friends share one.
async function circleUpgradeAvatars(scopeEl) {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !sb.storage) return;
  const els = Array.from((scopeEl || document).querySelectorAll('[data-cav]'));
  await Promise.all(els.map(async el => {
    const uid = el.getAttribute('data-cav');
    const pr = circProfiles[uid];
    if (!pr || !pr.avatar_path || pr._photoUrl || pr._photoTried) return;
    pr._photoTried = true;
    try {
      const dl = await sb.storage.from('avatars').download(pr.avatar_path);
      if (!dl.error && dl.data) {
        pr._photoUrl = await blobToDataUrl(dl.data);
        const tmp = document.createElement('div');
        tmp.innerHTML = circAvatarHTML(pr, 'c-avatar');
        const fresh = tmp.firstChild;
        // keep the original element's classes (row styling)
        fresh.className = el.className;
        fresh.setAttribute('data-cav', uid);
        el.replaceWith(fresh);
      }
    } catch (e) { /* keep the fallback avatar */ }
  }));
}

/* ---------- Coven section ---------- */
function renderCoven() {
  refreshCovenNav(); // theme may have changed since the nav was drawn
  track('coven_opened', null, { dedupeKey: 'coven-open', dedupeMs: 60000 });
  if (!cloudUser) {
    setView('<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
      '<div class="empty"><div class="big">' + icon('friends') + '</div>' +
      '<h2 class="serif">Your ' + covenNameBare().toLowerCase() + ' lives in the cloud</h2>' +
      '<p>Sign in to add friends and browse each other’s shelves.</p>' +
      '<button class="btn" id="cc-signin">Sign in</button></div>');
    document.getElementById('cc-signin').addEventListener('click', () => go('settings'));
    return;
  }
  setView('<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
    '<p class="note" style="text-align:center">Loading your ' + covenNameBare().toLowerCase() + '…</p>');
  // v240: an invite deep link stashed at boot (or tapped while signed in)
  // waits here until the tab renders its accept card.
  if (!pendingInviteToken) {
    try { pendingInviteToken = sessionStorage.getItem('cozylibram.invite') || null; } catch (e) {}
  }
  Promise.all([ensureInviteCode(), circleLists(), circlePrivacy()])
    .then(([code, lists, priv]) => {
      renderCovenMain(code, lists, priv);
      circleUpgradeAvatars(document.getElementById('view'));
      if (typeof refreshThoughtOfYou === 'function') refreshThoughtOfYou();
      if (typeof refreshRecos === 'function') refreshRecos();
      if (typeof refreshCovenStats === 'function') refreshCovenStats();
      consumePendingInvite(code, lists.friends);
    })
    .catch(e => {
      setView('<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
        '<div class="empty"><h2 class="serif">Couldn’t load your ' + covenNameBare().toLowerCase() + '</h2>' +
        '<p>' + esc((e && e.message) || e) + '</p>' +
        '<button class="btn" id="cc-retry">Try again</button></div>');
      document.getElementById('cc-retry').addEventListener('click', renderCoven);
    });
}
function circleRowHTML(p, name, actions, sub) {
  return '<div class="circle-row">' + circAvatarHTML(p, 'c-avatar') +
    '<div class="circle-meta"><b>' + esc(name) + '</b>' + (sub ? '<span class="note">' + sub + '</span>' : '') + '</div>' +
    '<div class="circle-actions">' + actions + '</div></div>';
}
function renderInviteAccept(slot, inv) {
  slot.innerHTML =
    '<div class="circle-row invite-accept">' +
    (inv.profile ? circAvatarHTML(inv.profile, 'c-avatar') : '<span class="c-avatar"></span>') +
    '<div class="circle-meta"><b>' + esc(inv.name) + '</b>' +
    '<span class="note">invited you to their ' + esc(covenNameBare().toLowerCase()) + '</span></div>' +
    '<div class="circle-actions"><button class="btn sm" id="cc-accept">Accept</button>' +
    '<button class="btn ghost sm" id="cc-dismiss">Dismiss</button></div></div>';
  slot.querySelector('#cc-accept').addEventListener('click', async () => {
    try {
      await acceptInviteToken(inv.token);
      track('friend_request_accepted');
      toast('You’re in each other’s ' + covenNameBare().toLowerCase() + ' now');
      clearPendingInvite();
      renderCoven();
      maybeAskShelfShare(inv.name); // v476: private-by-default consent, once
    } catch (e) {
      // v526: a refused redemption (a block stands between the pair)
      // raises the same server error as a dead token — answer with the
      // same words the paste flow uses for a dead link, never the raw
      // shape, so the two stay indistinguishable.
      const raw = (e && e.message) || String(e || '');
      toast(/invite not found/i.test(raw)
        ? 'Couldn’t accept — this invite link is no longer valid. Ask for a fresh one.'
        : 'Couldn’t accept: ' + raw);
    }
  });
  slot.querySelector('#cc-dismiss').addEventListener('click', () => {
    clearPendingInvite();
    slot.innerHTML = '';
  });
}
// A deep-link token (or a pasted link) waiting on the coven tab: resolve it
// into the accept card, or surface why it's unusable.
function consumePendingInvite(code, friends) {
  if (!pendingInviteToken) return;
  // v454: invite UI lives in the sheet now — open it for the deep link
  let slot = document.getElementById('cc-accept-slot');
  if (!slot) {
    if (typeof openInviteSheet === 'function' && code) {
      openInviteSheet(code, null, friends || []);
      slot = document.getElementById('cc-accept-slot');
    }
    if (!slot) { clearPendingInvite(); return; }
  }
  const msg = document.getElementById('cc-msg');
  slot.innerHTML = '<p class="note" style="text-align:center">Checking that invite…</p>';
  resolveInviteToken(pendingInviteToken).then(inv => {
    const s2 = document.getElementById('cc-accept-slot');
    if (s2) renderInviteAccept(s2, inv);
  }).catch(e => {
    clearPendingInvite();
    const m2 = document.getElementById('cc-msg');
    if (m2) m2.textContent = (e && e.message) || e;
    const s2 = document.getElementById('cc-accept-slot');
    if (s2) s2.innerHTML = '';
  });
}
function renderCovenMain(code, lists, priv) {
  const shelves = ['tbr', 'reading', 'read', 'dnf'];
  let html = '<div class="view-head" style="position:relative"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2>' +
    '<button id="cc-privacy-gear" aria-label="Privacy settings" style="position:absolute;right:0;top:50%;transform:translateY(-50%);background:none;border:0;cursor:pointer;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;color:var(--muted)">' + icon('gear') + '</button></div>' +
    '<p class="note" style="text-align:center">Your private reading ' + covenNameBare().toLowerCase() + ' — add people you trust,<br>browse each other’s shelves.</p>' +
    // v454: friends strip — horizontal scroll row under the title
    '<div class="friend-strip" id="friendStrip">' +
    '<button class="friend-tile invite-tile" id="cc-invite-open" aria-label="Invite a friend"><span class="invite-plus">+</span><span class="friend-name">Invite</span></button>' +
    lists.friends.map(f => {
      const initial = esc(String(f.name || '?').trim().charAt(0).toUpperCase() || '?');
      const avatar = f.profile ? circAvatarHTML(f.profile, 'friend-avatar') : '<span class="friend-avatar letter">' + initial + '</span>';
      return '<button class="friend-tile" data-friend="' + esc(f.id) + '" data-name="' + esc(f.name) + '" aria-label="View ' + esc(f.name) + '\u2019s shelves">' +
        avatar + '<span class="friend-name">' + esc(String(f.name || '?').split(' ')[0]) + '</span></button>';
    }).join('') +
    '</div>';

  html += '<div id="toy-slot"></div>';
  html += '<div id="stats-slot"></div>';

  // Requests
  if (lists.received.length || lists.sent.length) {
    html += '<h2 class="section serif">Requests</h2><div class="circle-list">';
    lists.received.forEach(r => {
      html += circleRowHTML(r.profile, r.name,
        '<button class="btn sm" data-accept="' + esc(r.id) + '" data-name="' + esc(r.name) + '">Accept</button>' +
        '<button class="btn ghost sm" data-decline="' + esc(r.id) + '">Decline</button>' +
        '<button class="btn ghost sm" data-report="' + esc(r.id) + '" data-name="' + esc(r.name) + '">Report</button>' +
        '<button class="btn ghost sm" data-block="' + esc(r.id) + '" data-name="' + esc(r.name) + '">Block</button>', 'wants to join your ' + covenNameBare().toLowerCase());
    });
    lists.sent.forEach(r => {
      html += circleRowHTML(r.profile, r.name,
        '<button class="btn ghost sm" data-cancel="' + esc(r.id) + '">Cancel</button>', 'requested');
    });
    html += '</div>';
  }


  setView(html);

  // Wire up
  const rerender = () => renderCoven();
  // v454: invite tile opens the sheet; friend tiles open shelves
  const inviteBtn = document.getElementById('cc-invite-open');
  if (inviteBtn) inviteBtn.addEventListener('click', () => openInviteSheet(code, inviteBtn, lists.friends));
  document.querySelectorAll('.friend-tile[data-friend]').forEach(t =>
    t.addEventListener('click', () => {
      circFriend = { id: t.dataset.friend, name: t.dataset.name };
      circShelf = 'all';
      go('coven-friend');
    }));
  document.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', async () => {
    try { await circleAnswer(b.dataset.accept, true); track('friend_request_accepted'); toast('You’re in each other’s ' + covenNameBare().toLowerCase() + ' now'); rerender(); maybeAskShelfShare(b.dataset.name); }
    catch (e) { toast('Couldn’t accept: ' + ((e && e.message) || e)); }
  }));
  document.querySelectorAll('[data-decline]').forEach(b => b.addEventListener('click', async () => {
    try { await circleAnswer(b.dataset.decline, false); rerender(); }
    catch (e) { toast('Couldn’t decline: ' + ((e && e.message) || e)); }
  }));
  document.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
    try { await circleCancel(b.dataset.cancel); rerender(); }
    catch (e) { toast('Couldn’t cancel: ' + ((e && e.message) || e)); }
  }));
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    circFriend = { id: b.dataset.view, name: b.dataset.name };
    circShelf = 'all';
    go('coven-friend');
  }));
  document.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    // v224 (UX-21): the app's own confirm sheet, not a blocking window.confirm.
    openRemoveFriendSheet(b.dataset.remove, b.dataset.name || 'this friend');
  }));
  document.querySelectorAll('[data-report]').forEach(b => b.addEventListener('click', () => {
    openReportSheet(b.dataset.report, b.dataset.name || 'this user');
  }));
  document.querySelectorAll('[data-block]').forEach(b => b.addEventListener('click', () => {
    openBlockSheet(b.dataset.block, b.dataset.name || 'this reader');
  }));
  applyBlockUi(document.getElementById('view'));
  // v454: privacy gear opens the sheet
  const gearBtn = document.getElementById('cc-privacy-gear');
  if (gearBtn) gearBtn.addEventListener('click', () => openPrivacySheet(priv, shelves, gearBtn));
}

/* ---------- friend shelf browser (read-only) ---------- */
function renderCovenFriend() {
  const f = circFriend;
  if (!f || !cloudUser) { go('coven'); return; }
  track('shared_shelf_viewed', null, { dedupeKey: 'shelf-' + f.id, dedupeMs: 60000 });
  setView('<div class="view-head"><button class="btn ghost sm" id="cf-back">← Back</button>' +
    '<h2 class="serif">' + icon('friends') + ' ' + esc(f.name) + '</h2></div>' +
    '<p class="note" style="text-align:center">Opening their shelves…</p>');
  document.getElementById('cf-back').addEventListener('click', () => go('coven'));
  Promise.all([circleFriendProfile(f.id), circleFriendBooks(f.id)])
    .then(([prof, books]) => {
      if (prof) { circProfiles[f.id] = prof; f.name = ((prof.first_name || '') + ' ' + (prof.last_name || '')).trim() || f.name; }
      circBooks = books.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      // v524: content shield — resolve work-level spice for the grid in
      // the background (the avatar-upgrade pattern); record-rated books
      // blur on first paint, baseline-only books when the map lands.
      circSpiceMap = {};
      if (typeof shieldOn === 'function' && shieldOn() && typeof shieldSpiceMapFor === 'function') {
        shieldSpiceMapFor(circBooks).then(m => { circSpiceMap = m || {}; markShieldedCovers(); }).catch(() => {});
      }
      renderCovenFriendMain();
    })
    .catch(e => {
      setView('<div class="view-head"><button class="btn ghost sm" id="cf-back2">← Back</button>' +
        '<h2 class="serif">' + icon('friends') + ' ' + esc(f.name) + '</h2></div>' +
        '<div class="empty"><h2 class="serif">Couldn’t open their shelves</h2><p>' + esc((e && e.message) || e) + '</p></div>');
      document.getElementById('cf-back2').addEventListener('click', () => go('coven'));
    });
}
function renderCovenFriendMain() {
  const f = circFriend;
  const prof = circProfiles[f.id];
  const counts = { all: circBooks.length };
  ['tbr', 'reading', 'read', 'dnf'].forEach(s => { counts[s] = circBooks.filter(b => b.status === s).length; });
  const books = circShelf === 'all' ? circBooks : circBooks.filter(b => b.status === circShelf);
  const chip = (v, label) =>
    '<button class="chip' + (circShelf === v ? ' active' : '') + '" data-cf="' + v + '">' + label +
    (counts[v] ? ' · ' + counts[v] : '') + '</button>';
  let html = '<div class="view-head" style="position:relative"><button class="btn ghost sm" id="cf-back">← Back</button>' +
    '<h2 class="serif">' + icon('friends') + ' ' + esc(f.name) + '</h2>' +
    '<button class="btn ghost sm" data-block="' + esc(f.id) + '" data-name="' + esc(f.name) + '" style="position:absolute;right:0;top:50%;transform:translateY(-50%)">Block</button></div>' +
    (prof ? '<div class="cf-sub">' + circAvatarHTML(prof, 'c-avatar') +
      '<p class="note">' + counts.all + ' book' + (counts.all === 1 ? '' : 's') + ' shared with you</p></div>' +
      // v522: bio / favourite genres ride the projection only when the
      // friend shares them (share_bio) — absent keys render as nothing.
      (prof.bio ? '<p class="cf-bio">' + esc(prof.bio) + '</p>' : '') +
      (prof.fav_genres && prof.fav_genres.length
        ? '<div class="cf-genres">' + prof.fav_genres.map(g => '<span class="chip">' + esc(g) + '</span>').join('') + '</div>' : '') : '') +
    '<div class="chips">' + chip('all', 'All') +
    ['tbr', 'reading', 'read', 'dnf'].map(s => chip(s, STATUS[s])).join('') + '</div>';
  if (!circBooks.length) {
    html += '<div class="empty"><div class="big">' + icon('covers') + '</div>' +
      '<h2 class="serif">Nothing shared</h2><p>' + esc(f.name) + ' isn’t sharing any shelves with you right now.</p></div>';
  } else if (!books.length) {
    html += '<p class="note" style="text-align:center">Nothing on this shelf.</p>';
  } else {
    const map = {};
    circBooks.forEach(b => { map[b.id] = b; });
    circBookMap = map;
    // v524: display copies strip the spice badge when the shield is on
    // (js/230 shieldCardBook); circBookMap keeps the originals — the
    // preview modal receives the book's metadata as-is, but openCovenBook
    // blanks a shielded high-spice cover on its transient copy (v524:
    // in this flow the cover is a shared-view cover, not metadata).
    const cardBook = (typeof shieldCardBook === 'function') ? shieldCardBook : (x) => x;
    html += '<div class="grid">' + books.map((b, i) => bookCard(cardBook(b), i)).join('') + '</div>';
  }
  setView(html);
  document.getElementById('cf-back').addEventListener('click', () => go('coven'));
  document.querySelectorAll('[data-block]').forEach(b => b.addEventListener('click', () => {
    openBlockSheet(b.dataset.block, b.dataset.name || 'this reader', () => go('coven'));
  }));
  applyBlockUi(document.getElementById('view'));
  document.querySelectorAll('[data-cf]').forEach(c => c.addEventListener('click', () => {
    circShelf = c.dataset.cf;
    animateIn = false;
    renderCovenFriendMain();
  }));
  document.querySelectorAll('#view .book-card').forEach(c => c.addEventListener('click', () => {
    const b = circBookMap[c.dataset.id];
    if (b) openCovenBook(b);
  }));
  markShieldedCovers();
  circleUpgradeAvatars(document.getElementById('view'));
}
let circBookMap = {};
let circSpiceMap = {}; // v524: work-spice map for the open friend's books
/* v524: content shield — blur high-spice covers in the friend grid and
   tag them with a "Shielded" badge so the blur reads as deliberate,
   not as a broken image. Idempotent; runs at first paint (record-rated
   books) and again when the work-spice map lands. */
function markShieldedCovers() {
  if (typeof shieldOn !== 'function' || !shieldOn()) return;
  if (typeof shieldIsHighSpice !== 'function') return;
  document.querySelectorAll('#view .book-card').forEach(c => {
    const b = circBookMap[c.dataset.id];
    if (!b || !shieldIsHighSpice(b, circSpiceMap)) return;
    const w = c.querySelector('.cover-wrap');
    if (w) w.classList.add('shield-blur');
    const badges = c.querySelector('.badges');
    if (badges && !badges.querySelector('.shield-note')) {
      const s = document.createElement('span');
      s.className = 'badge shield-note';
      s.innerHTML = icon('eyeoff') + ' Shielded';
      badges.appendChild(s);
    }
  });
}
// v219: the read-only friend shelf browser opens the shared preview modal
// (replacing its own tiny overlay) — description, tropes, genres, with +TBR
// adding a clean copy per the v97 rule and Wishlist as usual.
function openCovenBook(b) {
  const t = previewTransient(b, 'friend');
  // v524 (Advisor ruling): the modal's DATA is metadata, but its cover in
  // this friend flow is a shared-view cover, which the shield promises to
  // blur. Blank the cover on the transient copy — the placeholder renders;
  // the original book keeps its cover (+TBR still copies it as before).
  if (typeof shieldOn === 'function' && shieldOn() &&
      typeof shieldIsHighSpice === 'function' && shieldIsHighSpice(b, circSpiceMap)) {
    t.cover = '';
  }
  const modalOpts = {
    source: 'coven-shelf',
    contextNote: 'On ' + circFriend.name + '’s ' + (STATUS[b.status] || b.status || 'shelf') + ' shelf — read-only.',
    onAddTBR: () => addBook(covenCleanCopy(b), false, 'coven-shelf') || null
  };
  // v528: a shared-TBR match on a friend's shelf can become a buddy
  // read invitation right here (js/233 decides eligibility: both
  // copies on TBR, no row standing). The button lives in the modal's
  // primary row via the opt-in opts.onBuddyRead slot (js/150).
  if (typeof buddyOfferBookId === 'function' && circFriend) {
    const myBookId = buddyOfferBookId(circFriend.id, b);
    if (myBookId) {
      const friendId = circFriend.id, key = recoKey(b);
      modalOpts.onBuddyRead = async () => {
        if (typeof buddySendInvite !== 'function') return false;
        await buddySendInvite(friendId, key, null);
        return true;
      };
    }
  }
  openPreviewModal(t, modalOpts);
}

/* v454: privacy sheet — same controls as Settings → Circle & privacy
 * (v522: one shared panel builder, in a bottom sheet). */
function openPrivacySheet(priv, shelves, opener) {
  const full = {
    share: priv.share, hidden: priv.hidden || [],
    bio: priv.bio !== false, activity: priv.activity === true,
    // v528: carry the inbound toggles through the rebuild — without
    // them, any save from this sheet would reset a Settings choice
    // (recos had this latent gap; buddy must not inherit it).
    recos: priv.recos !== false, buddy: priv.buddy !== false,
  };
  const body =
    '<p class="note" style="margin-top:0">Your ' + covenNameBare().toLowerCase() +
    ' only receives what you switch on — anything off is never sent to them, not just hidden.</p>' +
    circlePrivacyPanelHTML(full, 'cc', shelves);
  covenOpenSheet('Privacy', body, opener);
  wireCirclePrivacyPanel(document, full, 'cc');
}

/* v454: invite sheet — the invite card UI moved into a bottom sheet. */
function openInviteSheet(code, opener, friends) {
  const body =
    '<div class="field"><label>Invite a friend</label>' +
    '<p class="note">Share your personal invite link — they tap it, sign in (or create an account), and you’re connected. Nothing to type.</p>' +
    '<div class="search-row"><button class="btn" id="cc-share">' + icon('share') + ' Share invite link</button>' +
    '<button class="btn ghost sm" id="cc-rotate">New link</button></div>' +
    '<p class="note">Making a new link invalidates the old one.</p></div>' +
    '<div class="field"><label>Add a friend</label>' +
      '<div class="search-row"><input id="cc-input" class="text-input" placeholder="Paste an invite link" ' +
      'autocapitalize="none" autocomplete="off" spellcheck="false">' +
      '<button class="btn" id="cc-send">Continue</button></div>' +
    '<p class="note" id="cc-msg"></p></div>' +
    '<div id="cc-accept-slot"></div>' +
    '<div class="field" style="margin-top:16px"><label>Manage friends' + (friends && friends.length ? ' (' + friends.length + ')' : '') + '</label>' +
    ((friends && friends.length) ?
      '<div class="circle-list">' + friends.map(f =>
        '<div class="circle-row">' + circAvatarHTML(f.profile, 'c-avatar') +
        '<div class="circle-meta"><b>' + esc(f.name) + '</b></div>' +
        '<div class="circle-actions friend-actions">' +
        '<button class="btn ghost sm" data-view="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Shelves</button>' +
        '<button class="btn ghost sm" data-remove="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Remove</button>' +
        '<button class="btn ghost sm" data-report="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Report</button>' +
        '<button class="btn ghost sm" data-block="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Block</button>' +
        '<button class="btn ghost sm friend-menu-btn" data-fmenu="' + esc(f.id) + '" aria-label="More options">…</button>' +
        '</div></div>').join('') + '</div>'
      : '<p class="note">No friends yet.</p>') +
    '</div>';
  const ref = covenOpenSheet('Invite', body, opener);
  // Wire the invite controls (same handlers as the old card)
  document.getElementById('cc-share').addEventListener('click', () => shareInviteLink(code));
  document.getElementById('cc-rotate').addEventListener('click', async () => {
    try {
      code = await rotateInviteCode();
      toast('New invite link made — the old one no longer works');
    } catch (e) { toast('Couldn’t make a new link: ' + ((e && e.message) || e)); }
  });
  document.getElementById('cc-send').addEventListener('click', async () => {
    const input = document.getElementById('cc-input');
    const msg = document.getElementById('cc-msg');
    const slot = document.getElementById('cc-accept-slot');
    msg.textContent = '';
    try {
      renderInviteAccept(slot, await resolveInviteToken(input.value));
    } catch (e) { msg.textContent = (e && e.message) || e; }
  });
  // Wire Manage friends buttons (same handlers as the old list)
  ref.sheet.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    ref.close();
    circFriend = { id: b.dataset.view, name: b.dataset.name };
    circShelf = 'all';
    go('coven-friend');
  }));
  ref.sheet.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    openRemoveFriendSheet(b.dataset.remove, b.dataset.name || 'this friend');
  }));
  ref.sheet.querySelectorAll('[data-report]').forEach(b => b.addEventListener('click', () => {
    openReportSheet(b.dataset.report, b.dataset.name || 'this user');
  }));
  ref.sheet.querySelectorAll('[data-block]').forEach(b => b.addEventListener('click', () => {
    openBlockSheet(b.dataset.block, b.dataset.name || 'this reader');
  }));
  applyBlockUi(ref.sheet);
  // v454: "..." menu toggles the full button row on narrow widths
  ref.sheet.querySelectorAll('[data-fmenu]').forEach(b => b.addEventListener('click', () => {
    const row = b.closest('.friend-actions');
    if (row) row.classList.toggle('show-all');
  }));
  return ref;
}
function covenOpenSheet(title, bodyHTML, opener, onDismiss) {
  covenCloseSheet();
  const scrim = document.createElement('div');
  scrim.className = 'coven-scrim'; scrim.id = 'covenScrim';
  const sheet = document.createElement('div');
  sheet.className = 'coven-sheet'; sheet.id = 'covenSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = '<div class="sheet-grabber" aria-hidden="true"></div>' +
    '<h3 class="serif" style="margin:0 0 12px">' + title + '</h3>' + bodyHTML;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => sheet.classList.add('open'));
  else sheet.classList.add('open');
  const close = () => {
    covenCloseSheet();
    if (opener && opener.focus) { try { opener.focus(); } catch (e) {} }
    if (onDismiss) { try { onDismiss(); } catch (e) {} }
  };
  scrim.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  sheet._covenClose = close;
  /* v513: drag-to-dismiss — standing app rule: every sheet wires the
     shared helper (the sheet already ships a grabber handle). */
  if (typeof wireSheetDrag === 'function') wireSheetDrag(sheet, close);
  return { sheet: sheet, close: close };
}
function covenCloseSheet() {
  ['covenScrim', 'covenSheet'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
}

/* v224 (UX-21): confirm removing a friend with the app's own sheet pattern
   (collection-overlay + modal-backdrop + overlayOpened), not window.confirm. */
function openRemoveFriendSheet(friendId, friendName) {
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="rf-back"><div class="modal" role="dialog" aria-label="Remove friend">' +
    '<button class="modal-close" id="rf-x">\u2715</button>' +
    '<h2 class="serif">Remove friend?</h2>' +
    '<p class="note"><b>' + esc(friendName) + '</b> will lose access to your shelves.</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="rf-cancel">Keep friend</button>' +
    '<button class="btn danger" id="rf-yes">Remove</button></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom); // v220: back-gesture closes the sheet
  const close = () => { overlayClosed(ovToken); closeDom(); };
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('#rf-back .modal'), close); // v227: swipe-down-to-close
  ov.querySelector('#rf-back').addEventListener('click', e => { if (e.target.id === 'rf-back') close(); });
  ov.querySelector('#rf-x').addEventListener('click', close);
  ov.querySelector('#rf-cancel').addEventListener('click', close);
  ov.querySelector('#rf-yes').addEventListener('click', async () => {
    try { await circleRemove(friendId); close(); renderCoven(); }
    catch (e) { toast('Couldn\u2019t remove: ' + ((e && e.message) || e)); }
  });
}

/* v526: block a reader — same sheet pattern as remove/report. Calm,
   plain language: what happens, and the fact that they aren't told.
   `after` replaces the default re-render (the friend view navigates
   back to the circle instead). */
function openBlockSheet(friendId, friendName, after) {
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="bl-back"><div class="modal" role="dialog" aria-label="Block reader">' +
    '<button class="modal-close" id="bl-x">\u2715</button>' +
    '<h2 class="serif">Block ' + esc(friendName) + '?</h2>' +
    '<p class="note"><b>' + esc(friendName) + '</b> will be removed from your ' + covenNameBare().toLowerCase() +
    ', and neither of you will be able to add the other again while the block stands. They won’t be told — it will look like any other removal.</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="bl-cancel">Keep friend</button>' +
    '<button class="btn danger" id="bl-yes">Block</button></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom);
  const close = () => { overlayClosed(ovToken); closeDom(); };
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('#bl-back .modal'), close);
  ov.querySelector('#bl-back').addEventListener('click', e => { if (e.target.id === 'bl-back') close(); });
  ov.querySelector('#bl-x').addEventListener('click', close);
  ov.querySelector('#bl-cancel').addEventListener('click', close);
  ov.querySelector('#bl-yes').addEventListener('click', async () => {
    try {
      await circleBlock(friendId);
      track('reader_blocked');
      close();
      toast('Blocked — you’re out of each other’s ' + covenNameBare().toLowerCase() + ' now');
      if (after) after(); else renderCoven();
    } catch (e) {
      if (typeof blocksMissing === 'function' && blocksMissing(e)) toast('Blocking isn’t available right now — try again soon');
      else toast('Couldn’t block: ' + ((e && e.message) || e));
    }
  });
}

/* v246: report a user for abuse. Uses the app's own sheet pattern
   (collection-overlay + modal-backdrop + overlayOpened), not window.confirm. */
const REPORT_REASONS = [
  ['spam', 'Spam'],
  ['harassment', 'Harassment'],
  ['inappropriate', 'Inappropriate content'],
  ['fake_account', 'Fake account'],
  ['other', 'Other'],
];
function openReportSheet(userId, userName) {
  if (!cloudUser || userId === cloudUser.id) return;
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="rp-back"><div class="modal" role="dialog" aria-label="Report user">' +
    '<button class="modal-close" id="rp-x">\u2715</button>' +
    '<h2 class="serif">Report ' + esc(userName) + '?</h2>' +
    '<p class="note">Reports go to the app administrator, who reviews them in the Libram Observatory.</p>' +
    '<div class="field"><label for="rp-reason">Reason</label>' +
    '<select id="rp-reason">' + REPORT_REASONS.map(r => '<option value="' + r[0] + '">' + r[1] + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="rp-details">Details (optional)</label>' +
    '<textarea id="rp-details" rows="3" maxlength="1000" placeholder="What happened?"></textarea></div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="rp-cancel">Cancel</button>' +
    '<button class="btn danger" id="rp-send">Send report</button></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom); // v220: back-gesture closes the sheet
  const close = () => { overlayClosed(ovToken); closeDom(); };
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('#rp-back .modal'), close); // v227: swipe-down-to-close
  ov.querySelector('#rp-back').addEventListener('click', e => { if (e.target.id === 'rp-back') close(); });
  ov.querySelector('#rp-x').addEventListener('click', close);
  ov.querySelector('#rp-cancel').addEventListener('click', close);
  ov.querySelector('#rp-send').addEventListener('click', async () => {
    const reason = ov.querySelector('#rp-reason').value;
    const details = ov.querySelector('#rp-details').value.trim();
    ov.querySelector('#rp-send').disabled = true;
    try {
      await submitUserReport(userId, reason, details);
      close();
      toast('Report sent — thank you');
    } catch (e) {
      ov.querySelector('#rp-send').disabled = false;
      toast('Couldn\u2019t send report: ' + ((e && e.message) || e));
    }
  });
}
async function submitUserReport(reportedUserId, reason, details) {
  const sb = await cloudClient();
  const { error } = await sb.from('user_reports').insert({
    reporter_id: cloudUser.id,
    reported_user_id: reportedUserId,
    reason,
    details: details || '',
  });
  if (error) throw error;
}

