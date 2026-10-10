'use strict';

/* ---------------- Coven (v96): friends + shared shelves ---------------- */
// Your private reading coven: invite friends with a shareable link, answer
// requests, browse each other's shelves (read-only). All sharing is enforced
// by Supabase RLS — see supabase/schema.sql. The coven needs the cloud; the
// section prompts for sign-in when offline or signed out.

/* v99: the social section takes its name from the active theme. */
const COVEN_NAMES = {
  dark:        'Coven',       // dark romance default
  light:       'Book Club',
  hearthside:  'Fireside',
  candlelight: 'Salon',
  twilight:    'Night Court',
  verdant:     'Grove',
  midnight:    'Moon Court',
  velvet:      'Rose Court',
  abyss:       'The Deep',
  frost:       'Winter Court',
  haunt:       'Haunt Coven', // v416 (T8): was 'Coven' — collided with Dark in the picker
  yuletide:    'Yule Court',
  fete:        'Gala',
  amour:       "Lovers' Court",
  shamrock:    'Emerald Court',
  pastel:      'Spring Court',
  harvest:     'Harvest Court',
  solstice:    'Sun Court', // v416 (T6)
};
function covenNameFor(key) { return COVEN_NAMES[key] || 'Coven'; }
function covenName() { return covenNameFor(typeof getTheme === 'function' ? getTheme() : 'dark'); }
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
  const text = 'Join my ' + covenName() + ' on Cozy Libram — tap the link and we’re connected.';
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
    if (existing.status === 'accepted') throw new Error('You’re already in each other’s ' + covenName().toLowerCase() + '.');
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
    const pr = await sb.from('profiles').select('user_id,first_name,last_name,avatar_id,avatar_path')
      .in('user_id', list);
    if (pr.error) throw pr.error;
    (pr.data || []).forEach(p => { circProfiles[p.user_id] = p; });
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

/* ---------- privacy ---------- */
async function circlePrivacy() {
  const sb = await cloudClient();
  const r = await sb.from('profiles').select('share_library,hidden_shelves').eq('user_id', cloudUser.id).maybeSingle();
  if (r.error) throw r.error;
  return {
    share: r.data ? r.data.share_library !== false : true,
    hidden: (r.data && Array.isArray(r.data.hidden_shelves)) ? r.data.hidden_shelves : [],
  };
}
async function circleSavePrivacy(share, hidden) {
  const sb = await cloudClient();
  const up = await sb.from('profiles').upsert({
    user_id: cloudUser.id, share_library: !!share, hidden_shelves: hidden,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (up.error) throw up.error;
}

/* ---------- friend shelves (read-only) ---------- */
async function circleFriendProfile(friendId) {
  const sb = await cloudClient();
  const r = await sb.from('profiles').select('user_id,first_name,last_name,avatar_id,avatar_path')
    .eq('user_id', friendId).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
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
      '<h2 class="serif">Your ' + covenName().toLowerCase() + ' lives in the cloud</h2>' +
      '<p>Sign in to add friends and browse each other’s shelves.</p>' +
      '<button class="btn" id="cc-signin">Sign in</button></div>');
    document.getElementById('cc-signin').addEventListener('click', () => go('settings'));
    return;
  }
  setView('<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
    '<p class="note" style="text-align:center">Loading your ' + covenName().toLowerCase() + '…</p>');
  // v240: an invite deep link stashed at boot (or tapped while signed in)
  // waits here until the tab renders its accept card.
  if (!pendingInviteToken) {
    try { pendingInviteToken = sessionStorage.getItem('cozylibram.invite') || null; } catch (e) {}
  }
  Promise.all([ensureInviteCode(), circleLists(), circlePrivacy()])
    .then(([code, lists, priv]) => {
      renderCovenMain(code, lists, priv);
      circleUpgradeAvatars(document.getElementById('view'));
      if (typeof refreshRecos === 'function') refreshRecos();
      if (typeof refreshCovenStats === 'function') refreshCovenStats();
      consumePendingInvite();
    })
    .catch(e => {
      setView('<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
        '<div class="empty"><h2 class="serif">Couldn’t load your ' + covenName().toLowerCase() + '</h2>' +
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
    '<span class="note">invited you to their ' + esc(covenName().toLowerCase()) + '</span></div>' +
    '<div class="circle-actions"><button class="btn sm" id="cc-accept">Accept</button>' +
    '<button class="btn ghost sm" id="cc-dismiss">Dismiss</button></div></div>';
  slot.querySelector('#cc-accept').addEventListener('click', async () => {
    try {
      await acceptInviteToken(inv.token);
      track('friend_request_accepted');
      toast('You’re in each other’s ' + covenName().toLowerCase() + ' now');
      clearPendingInvite();
      renderCoven();
    } catch (e) { toast('Couldn’t accept: ' + ((e && e.message) || e)); }
  });
  slot.querySelector('#cc-dismiss').addEventListener('click', () => {
    clearPendingInvite();
    slot.innerHTML = '';
  });
}
// A deep-link token (or a pasted link) waiting on the coven tab: resolve it
// into the accept card, or surface why it's unusable.
function consumePendingInvite() {
  if (!pendingInviteToken) return;
  const slot = document.getElementById('cc-accept-slot');
  const msg = document.getElementById('cc-msg');
  if (!slot) { clearPendingInvite(); return; }
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
  let html = '<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
    '<p class="note" style="text-align:center">Your private reading ' + covenName().toLowerCase() + ' — add people you trust,<br>browse each other’s shelves.</p>' +
    '<div class="circle-card">' +
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
    '</div>';

  html += '<div id="reco-slot"></div><div id="stats-slot"></div>';

  // Requests
  if (lists.received.length || lists.sent.length) {
    html += '<h2 class="section serif">Requests</h2><div class="circle-list">';
    lists.received.forEach(r => {
      html += circleRowHTML(r.profile, r.name,
        '<button class="btn sm" data-accept="' + esc(r.id) + '">Accept</button>' +
        '<button class="btn ghost sm" data-decline="' + esc(r.id) + '">Decline</button>' +
        '<button class="btn ghost sm" data-report="' + esc(r.id) + '" data-name="' + esc(r.name) + '">Report</button>', 'wants to join your ' + covenName().toLowerCase());
    });
    lists.sent.forEach(r => {
      html += circleRowHTML(r.profile, r.name,
        '<button class="btn ghost sm" data-cancel="' + esc(r.id) + '">Cancel</button>', 'requested');
    });
    html += '</div>';
  }

  // Friends
  html += '<h2 class="section serif" id="cc-friends">My ' + covenName() + (lists.friends.length ? ' (' + lists.friends.length + ')' : '') + '</h2>';
  if (!lists.friends.length) {
    html += '<p class="note" style="text-align:center">No friends yet — share your invite link above.</p>';
  } else {
    html += '<div class="circle-list">';
    lists.friends.forEach(f => {
      html += circleRowHTML(f.profile, f.name,
        '<button class="btn ghost sm" data-view="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Shelves</button>' +
        '<button class="btn ghost sm" data-remove="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Remove</button>' +
        '<button class="btn ghost sm" data-report="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Report</button>');
    });
    html += '</div>';
  }

  // Privacy
  html += '<h2 class="section serif">Privacy</h2><div class="circle-card">' +
    '<div class="field"><label>Share my shelves with my ' + covenName().toLowerCase() + '</label>' +
    '<div class="seg" id="cc-share">' +
      '<button data-v="1"' + (priv.share ? ' class="active"' : '') + '>On</button>' +
      '<button data-v="0"' + (!priv.share ? ' class="active"' : '') + '>Off</button></div>' +
    '<p class="note">When off, friends still see you in their ' + covenName().toLowerCase() + ', but none of your books.</p></div>' +
    '<div class="field"><label>Hide these shelves from my ' + covenName().toLowerCase() + '</label>' +
    '<div class="chips" id="cc-hide">' +
      shelves.map(s => '<button class="chip' + (priv.hidden.indexOf(s) !== -1 ? ' active' : '') + '" data-shelf="' + s + '">' +
        STATUS[s] + '</button>').join('') +
    '</div></div></div>';

  setView(html);

  // Wire up
  const rerender = () => renderCoven();
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
  document.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', async () => {
    try { await circleAnswer(b.dataset.accept, true); track('friend_request_accepted'); toast('You’re in each other’s ' + covenName().toLowerCase() + ' now'); rerender(); }
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
  document.querySelectorAll('#cc-share button').forEach(b => b.addEventListener('click', async () => {
    const share = b.dataset.v === '1';
    try {
      await circleSavePrivacy(share, priv.hidden);
      document.querySelectorAll('#cc-share button').forEach(x => x.classList.toggle('active', x === b));
      toast(share ? 'Your shelves are shared with your ' + covenName().toLowerCase() : 'Your shelves are hidden from your ' + covenName().toLowerCase());
    } catch (e) { toast('Couldn’t save: ' + ((e && e.message) || e)); }
  }));
  document.querySelectorAll('#cc-hide .chip').forEach(ch => ch.addEventListener('click', async () => {
    const s = ch.dataset.shelf;
    const hidden = priv.hidden.slice();
    const i = hidden.indexOf(s);
    if (i === -1) hidden.push(s); else hidden.splice(i, 1);
    try {
      await circleSavePrivacy(priv.share, hidden);
      priv.hidden = hidden;
      ch.classList.toggle('active', i === -1);
    } catch (e) { toast('Couldn’t save: ' + ((e && e.message) || e)); }
  }));
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
  let html = '<div class="view-head"><button class="btn ghost sm" id="cf-back">← Back</button>' +
    '<h2 class="serif">' + icon('friends') + ' ' + esc(f.name) + '</h2></div>' +
    (prof ? '<div class="cf-sub">' + circAvatarHTML(prof, 'c-avatar') +
      '<p class="note">' + counts.all + ' book' + (counts.all === 1 ? '' : 's') + ' shared with you</p></div>' : '') +
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
    html += '<div class="grid">' + books.map((b, i) => bookCard(b, i)).join('') + '</div>';
  }
  setView(html);
  document.getElementById('cf-back').addEventListener('click', () => go('coven'));
  document.querySelectorAll('[data-cf]').forEach(c => c.addEventListener('click', () => {
    circShelf = c.dataset.cf;
    animateIn = false;
    renderCovenFriendMain();
  }));
  document.querySelectorAll('#view .book-card').forEach(c => c.addEventListener('click', () => {
    const b = circBookMap[c.dataset.id];
    if (b) openCovenBook(b);
  }));
  circleUpgradeAvatars(document.getElementById('view'));
}
let circBookMap = {};
// v219: the read-only friend shelf browser opens the shared preview modal
// (replacing its own tiny overlay) — description, tropes, genres, with +TBR
// adding a clean copy per the v97 rule and Wishlist as usual.
function openCovenBook(b) {
  openPreviewModal(previewTransient(b, 'friend'), {
    source: 'coven-shelf',
    contextNote: 'On ' + circFriend.name + '’s ' + (STATUS[b.status] || b.status || 'shelf') + ' shelf — read-only.',
    onAddTBR: () => addBook(covenCleanCopy(b), false, 'coven-shelf') || null
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
    try { await circleRemove(friendId); close(); rerender(); }
    catch (e) { toast('Couldn\u2019t remove: ' + ((e && e.message) || e)); }
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

