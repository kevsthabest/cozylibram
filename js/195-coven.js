'use strict';

/* ---------------- Coven (v96): friends + shared shelves ---------------- */
// Your private reading coven: invite friends with a short code, answer
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

/* ---------- invite codes ---------- */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genInviteCode() {
  const bytes = new Uint8Array(6);
  try { window.crypto.getRandomValues(bytes); }
  catch (e) { for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return s;
}
function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
async function ensureInviteCode() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return '';
  try {
    const got = await sb.from('circle_invites').select('code').eq('user_id', cloudUser.id).maybeSingle();
    if (got.error) throw got.error;
    if (got.data && got.data.code) return got.data.code;
    for (let t = 0; t < 5; t++) {
      const code = genInviteCode();
      const up = await sb.from('circle_invites').upsert({ user_id: cloudUser.id, code: code }, { onConflict: 'user_id' });
      if (!up.error) return code;
      // Code collision with someone else's → try another; other errors bail.
      if (!/duplicate|unique|conflict/i.test(String((up.error && up.error.message) || ''))) throw up.error;
    }
  } catch (e) { /* offline — the coven needs the cloud */ }
  return '';
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
async function circleSendRequest(rawCode) {
  const sb = await cloudClient();
  const code = normalizeCode(rawCode);
  if (code.length < 6) throw new Error('Enter the full 6-character invite code.');
  const found = await sb.from('circle_invites').select('user_id').eq('code', code).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) throw new Error('No one uses that code — double-check it and try again.');
  const them = found.data.user_id;
  if (them === cloudUser.id) throw new Error('That’s your own code — share it with a friend instead.');
  const existing = await circleLinkBetween(cloudUser.id, them);
  if (existing) {
    if (existing.status === 'accepted') throw new Error('You’re already in each other’s ' + covenName().toLowerCase() + '.');
    if (existing.status === 'pending') throw new Error('A request between you is already pending.');
    // declined before → clear the old row and start fresh
    const del = await sb.from('circle_links').delete()
      .eq('requester_id', existing.requester_id).eq('addressee_id', existing.addressee_id);
    if (del.error) throw del.error;
  }
  const ins = await sb.from('circle_links')
    .insert({ requester_id: cloudUser.id, addressee_id: them, status: 'pending' });
  if (ins.error) throw ins.error;
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
  Promise.all([ensureInviteCode(), circleLists(), circlePrivacy()])
    .then(([code, lists, priv]) => {
      renderCovenMain(code, lists, priv);
      circleUpgradeAvatars(document.getElementById('view'));
      if (typeof refreshRecos === 'function') refreshRecos();
      if (typeof refreshCovenStats === 'function') refreshCovenStats();
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
function renderCovenMain(code, lists, priv) {
  const shelves = ['tbr', 'reading', 'read', 'dnf'];
  let html = '<div class="view-head"><h2 class="serif">' + icon('friends') + ' ' + covenName() + '</h2></div>' +
    '<p class="note" style="text-align:center">Your private reading ' + covenName().toLowerCase() + ' — add people you trust,<br>browse each other’s shelves.</p>' +
    '<div class="circle-card">' +
      '<div class="field"><label>Your invite code</label>' +
        '<div class="search-row"><b class="invite-code" id="cc-code">' + esc(code || '…') + '</b>' +
        '<button class="btn ghost sm" id="cc-copy">' + icon('copy') + ' Copy</button></div></div>' +
      '<p class="note">Share it with someone you trust — they enter it below to request you.</p>' +
      '<div class="field"><label>Add a friend</label>' +
        '<div class="search-row"><input id="cc-input" class="text-input" placeholder="Friend’s invite code" ' +
        'autocapitalize="characters" autocomplete="off" spellcheck="false">' +
        '<button class="btn" id="cc-send">Send request</button></div></div>' +
      '<p class="note" id="cc-msg"></p>' +
    '</div>';

  html += '<div id="reco-slot"></div><div id="stats-slot"></div>';

  // Requests
  if (lists.received.length || lists.sent.length) {
    html += '<h2 class="section serif">Requests</h2><div class="circle-list">';
    lists.received.forEach(r => {
      html += circleRowHTML(r.profile, r.name,
        '<button class="btn sm" data-accept="' + esc(r.id) + '">Accept</button>' +
        '<button class="btn ghost sm" data-decline="' + esc(r.id) + '">Decline</button>', 'wants to join your ' + covenName().toLowerCase());
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
    html += '<p class="note" style="text-align:center">No friends yet — share your invite code above.</p>';
  } else {
    html += '<div class="circle-list">';
    lists.friends.forEach(f => {
      html += circleRowHTML(f.profile, f.name,
        '<button class="btn ghost sm" data-view="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Shelves</button>' +
        '<button class="btn ghost sm" data-remove="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Remove</button>');
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

  // v155: trope proposals — the coven votes, admin reviews in Trope Lab.
  html += '<h2 class="section serif">Trope proposals</h2><div class="circle-card">' +
    '<p class="note">Missing a trope? Propose it — the ' + covenName().toLowerCase() +
    ' votes, and popular proposals get reviewed.</p>' +
    '<button class="btn ghost sm" id="cc-propose">＋ Propose a trope</button>' +
    '<div id="cc-proposals" class="circle-list"><p class="note">Loading…</p></div></div>';

  setView(html);

  // Wire up
  const rerender = () => renderCoven();
  document.getElementById('cc-propose').addEventListener('click', () => openTropeProposalSheet(null));
  renderCovenProposals();
  document.getElementById('cc-copy').addEventListener('click', () => {
    const c = document.getElementById('cc-code').textContent;
    const done = () => toast('Invite code copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c).then(done, done);
    else done();
  });
  document.getElementById('cc-send').addEventListener('click', async () => {
    const input = document.getElementById('cc-input');
    const msg = document.getElementById('cc-msg');
    try {
      await circleSendRequest(input.value);
      track('friend_request_sent');
      toast('Request sent');
      rerender();
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

/* ---------------- Trope proposals (v155) ----------------
   Coven members propose and vote; admin reviews in Trope Lab. */

function proposalRowHTML(p) {
  const net = p.votes.up - p.votes.down;
  return '<div class="circle-row"><div class="circle-meta">' +
    '<b>' + esc(p.name) + '</b>' + (p.mine ? ' <span class="note-inline">· yours</span>' : '') +
    '<p class="note" style="margin:4px 0">' + esc(p.description) + '</p>' +
    '<div class="chips" style="padding-bottom:0">' +
      p.genres.map(g => '<span class="chip" style="cursor:default">' + esc(tropeGenreLabel(g)) + '</span>').join('') +
    '</div></div>' +
    '<div class="circle-actions" style="align-items:center">' +
    '<button class="tvbtn' + (p.votes.mine === 1 ? ' on' : '') + '" data-pv="1" data-pid="' + p.id + '" aria-label="Upvote">▲</button>' +
    '<span class="tvnet">' + (net > 0 ? '+' : '') + net + '</span>' +
    '<button class="tvbtn' + (p.votes.mine === -1 ? ' on' : '') + '" data-pv="-1" data-pid="' + p.id + '" aria-label="Downvote">▼</button>' +
    '</div></div>';
}

async function renderCovenProposals() {
  const box = document.getElementById('cc-proposals');
  if (!box) return;
  try {
    ensureTropeQueueWired();
    const list = await TropeProposals.listPending();
    box.innerHTML = list.length
      ? list.map(proposalRowHTML).join('')
      : '<p class="note">No proposals yet — be the first.</p>';
    box.querySelectorAll('[data-pv]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        await TropeProposals.toggleVote(btn.dataset.pid, parseInt(btn.dataset.pv, 10));
        renderCovenProposals();
      } catch (e) {
        btn.disabled = false;
        toast('Couldn’t vote: ' + ((e && e.message) || e));
      }
    }));
  } catch (e) {
    box.innerHTML = '<p class="note">Couldn’t load proposals.</p>';
  }
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
  ov.querySelector('#rf-back').addEventListener('click', e => { if (e.target.id === 'rf-back') close(); });
  ov.querySelector('#rf-x').addEventListener('click', close);
  ov.querySelector('#rf-cancel').addEventListener('click', close);
  ov.querySelector('#rf-yes').addEventListener('click', async () => {
    try { await circleRemove(friendId); close(); rerender(); }
    catch (e) { toast('Couldn\u2019t remove: ' + ((e && e.message) || e)); }
  });
}

/* Proposal form sheet. `book` is optional — when launched from a book modal
   the book becomes the proposal's originating book. */
function openTropeProposalSheet(book) {
  ensureTropeQueueWired();
  const bookKey = book ? bookKeyFor(book) : null;
  const sel = new Set();
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="tp-back"><div class="modal" role="dialog" aria-label="Propose a trope">' +
    '<button class="modal-close" id="tp-x">✕</button>' +
    '<h2 class="serif">Propose a trope</h2>' +
    (book
      ? '<p class="note">For <b>' + esc(book.title || 'this book') + '</b> — your ' + esc(covenName().toLowerCase()) + ' votes on it.</p>'
      : '<p class="note">Your ' + esc(covenName().toLowerCase()) + ' votes on proposals; the popular ones get reviewed.</p>') +
    '<div class="field"><label>Name</label>' +
    '<input id="tp-name" class="text-input" maxlength="60" placeholder="Only One Bed" autocomplete="off"></div>' +
    '<div class="field"><label>One-line definition</label>' +
    '<input id="tp-desc" class="text-input" maxlength="160" placeholder="What makes this trope what it is, in one line" autocomplete="off"></div>' +
    '<div class="field"><label>Genres</label><div class="chips" id="tp-genres">' +
    TROPE_GENRES.map(g => '<button class="chip" data-tpg="' + g + '">' + esc(tropeGenreLabel(g)) + '</button>').join('') +
    '</div></div>' +
    '<p class="note hidden" id="tp-dup"></p>' +
    '<p class="note hidden" id="tp-err" style="color:var(--danger)"></p>' +
    '<button class="btn block" id="tp-submit">Submit proposal</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom); // v220: back-gesture closes the sheet
  const close = () => { overlayClosed(ovToken); closeDom(); }; // v220: programmatic close consumes the entry
  ov.querySelector('#tp-back').addEventListener('click', e => { if (e.target.id === 'tp-back') close(); });
  ov.querySelector('#tp-x').addEventListener('click', close);
  ov.querySelectorAll('[data-tpg]').forEach(btn => btn.addEventListener('click', () => {
    const g = btn.dataset.tpg;
    if (sel.has(g)) { sel.delete(g); btn.classList.remove('active'); }
    else { sel.add(g); btn.classList.add('active'); }
  }));
  const nameInp = ov.querySelector('#tp-name');
  const dupBox = ov.querySelector('#tp-dup');
  nameInp.addEventListener('input', () => {
    const d = TropeProposals.checkDuplicate(nameInp.value);
    if (d && d.kind === 'exact') {
      dupBox.textContent = '“' + d.trope.name + '” already exists — pick another name.';
      dupBox.classList.remove('hidden');
    } else if (d) {
      dupBox.textContent = 'Similar to existing “' + d.trope.name + '” — you can still submit.';
      dupBox.classList.remove('hidden');
    } else {
      dupBox.classList.add('hidden');
    }
  });
  ov.querySelector('#tp-submit').addEventListener('click', async () => {
    const errBox = ov.querySelector('#tp-err');
    const btn = ov.querySelector('#tp-submit');
    errBox.classList.add('hidden');
    try {
      btn.disabled = true;
      await TropeProposals.submit({
        name: nameInp.value,
        description: ov.querySelector('#tp-desc').value,
        genres: [...sel],
        bookKey,
      });
      ov.querySelector('.modal').innerHTML =
        '<h2 class="serif">Proposed ✓</h2>' +
        '<p class="note">Your ' + esc(covenName().toLowerCase()) + ' can vote on it now.</p>' +
        '<button class="btn block" id="tp-done">Done</button>';
      ov.querySelector('#tp-done').addEventListener('click', () => { close(); renderCovenProposals(); });
    } catch (e) {
      btn.disabled = false;
      errBox.textContent = (e && e.message) || 'Could not submit.';
      errBox.classList.remove('hidden');
    }
  });
}
