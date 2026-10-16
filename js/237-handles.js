'use strict';

/* ---------------- handles (v550) ----------------
   A handle is a reader's chosen public identity: unique, and — only
   when they separately opt in — findable. When a handle is set,
   friend-facing surfaces show @handle INSTEAD of the real name
   (friendDisplayName is the one helper that owns that choice);
   the owner's own surfaces keep the real name, with @handle
   alongside. All enforcement lives server-side (migration v550):
   claim_handle / clear_handle are the only write paths, lookup is
   exact-match + rate-limited + name-free, and add-by-handle creates
   a PENDING request, never an instant friendship. This module is
   the client half: the screen mirror (for instant, honest feedback
   — the SQL lists are canonical and a test asserts the two copies
   agree), the RPC wrappers, the profile-editor block, and the
   add-by-handle card in the invite sheet. */

/* The screen lists — mirrored token-for-token from
   handle_screen_slurs() / handle_screen_reserved() in
   supabase/migrations/v550_handles.sql. Matching posture (same as
   the SQL): handles are screened STRICTLY (a slur as a substring, a
   reserved term as a whole '_'-delimited token); names and bio are
   screened by WHOLE-TOKEN equality only, so a name merely containing
   a flagged substring is never blocked. The list is deliberately
   narrow — unambiguous abuse + impersonation terms — with report
   and block as the backstop, as everywhere in the app. */
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const HANDLE_SCREEN_SLURS = [
  'arsehole', 'asshole', 'bastard', 'beaner', 'bitch', 'chink',
  'cunt', 'faggot', 'fuck', 'gook', 'jigaboo', 'kike', 'nigger',
  'nigga', 'pedophile', 'porchmonkey', 'raghead', 'rapist',
  'retard', 'shit', 'slut', 'tranny', 'wetback', 'whore'
];
export const HANDLE_SCREEN_RESERVED = [
  'admin', 'administrator', 'cozylibram', 'libram', 'luna', 'mod',
  'moderator', 'official', 'owner', 'root', 'staff', 'support',
  'system', 'team'
];

/* Leetspeak + case normalization, the mirror of handle_normalize():
   0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b, @→a, $→s, !→i, +→t. */
export function handleNormalizeText(s) {
  const map = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't' };
  return String(s == null ? '' : s).toLowerCase().split('').map(c => map[c] || c).join('');
}

/* handleScreenHit(text, mode) → the listed term hit, or null.
   Modes: 'handle' | 'name' | 'bio' (see the posture note above). */
export function handleScreenHit(text, mode) {
  const raw = String(text == null ? '' : text).toLowerCase();
  const norm = handleNormalizeText(text);
  let i, t, j;
  if (mode === 'handle') {
    for (i = 0; i < HANDLE_SCREEN_SLURS.length; i++) {
      t = HANDLE_SCREEN_SLURS[i];
      if (norm.indexOf(t) !== -1 || raw.indexOf(t) !== -1) return t;
    }
    for (i = 0; i < HANDLE_SCREEN_RESERVED.length; i++) {
      t = HANDLE_SCREEN_RESERVED[i];
      if (norm.split('_').indexOf(t) !== -1) return t;
      const rawToks = raw.split('_');
      for (j = 0; j < rawToks.length; j++) {
        if (rawToks[j].replace(/[0-9]+$/, '') === t) return t;
      }
    }
    return null;
  }
  const tokens = norm.split(/[^a-z0-9]+/).concat(raw.split(/[^a-z0-9]+/));
  for (i = 0; i < HANDLE_SCREEN_SLURS.length; i++) {
    if (tokens.indexOf(HANDLE_SCREEN_SLURS[i]) !== -1) return HANDLE_SCREEN_SLURS[i];
  }
  if (mode === 'name') {
    for (i = 0; i < HANDLE_SCREEN_RESERVED.length; i++) {
      if (tokens.indexOf(HANDLE_SCREEN_RESERVED[i]) !== -1) return HANDLE_SCREEN_RESERVED[i];
    }
  }
  return null;
}

/* Is a screen hit one of the reserved terms? (The editor and the
   signup form word reserved hits apart from slur hits.) */
export function handleHitIsReserved(hit) {
  return HANDLE_SCREEN_RESERVED.indexOf(hit) !== -1;
}

/* The profile save's pre-check (the server trigger is the backstop):
   returns 'firstName' | 'lastName' | 'bio' | null. */
export function profileContentScreenHit(p) {
  if (!p) return null;
  if (handleScreenHit(p.firstName || '', 'name')) return 'firstName';
  if (handleScreenHit(p.lastName || '', 'name')) return 'lastName';
  if (handleScreenHit(p.bio || '', 'bio')) return 'bio';
  return null;
}

export function handleFormatValid(h) {
  return /^[a-z0-9_]{3,20}$/.test(String(h || ''));
}
/* What the user typed → the canonical handle (lowercase, @ stripped). */
export function cleanHandleInput(v) {
  return String(v || '').trim().toLowerCase().replace(/^@+/, '');
}

/* THE display helper: the one place friend-facing name choice lives.
   A set handle wins, rendered as '@handle' — a single token on
   purpose, so the many first-token renderings (name.split(' ')[0])
   show the handle whole. Else today's behaviour: the full real name,
   or the caller's fallback. */
export function friendDisplayName(p, fallback) {
  if (p && p.handle) return '@' + p.handle;
  const n = p ? (((p.first_name || p.firstName || '') + ' ' + (p.last_name || p.lastName || '')).trim()) : '';
  return n || fallback || 'A reader';
}

/* ---------- RPC wrappers (pre-migration tolerant) ---------- */
export function handlesRpcMissing(e) {
  const s = String((e && (e.code + ' ' + e.message)) || e || '');
  return /PGRST20[0-9]|schema cache|could not find|does not exist|404/i.test(s);
}
export async function handleRpc(name, args) {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return { data: null, error: { message: 'not signed in' } };
  try { return await sb.rpc(name, args || {}); }
  catch (e) { return { data: null, error: e }; }
}
export async function claimHandleRpc(h) {
  const r = await handleRpc('claim_handle', { p_handle: cleanHandleInput(h) });
  if (r.error) return { ok: false, error: handlesRpcMissing(r.error) ? 'unsupported' : 'failed' };
  return r.data || { ok: false, error: 'failed' };
}
export async function clearHandleRpc() {
  const r = await handleRpc('clear_handle', {});
  if (r.error) return { ok: false, error: handlesRpcMissing(r.error) ? 'unsupported' : 'failed' };
  return r.data || { ok: false, error: 'failed' };
}
export async function handleAvailableRpc(h) {
  const r = await handleRpc('handle_available', { p_handle: cleanHandleInput(h) });
  if (r.error) return { available: false, unsupported: handlesRpcMissing(r.error) };
  return { available: r.data === true, unsupported: false };
}
export async function lookupHandleRpc(h) {
  const r = await handleRpc('lookup_handle', { p_handle: cleanHandleInput(h) });
  if (r.error || !Array.isArray(r.data) || !r.data.length) return null;
  return r.data[0];
}
export async function requestByHandleRpc(h) {
  const r = await handleRpc('request_by_handle', { p_handle: cleanHandleInput(h) });
  if (r.error) return { ok: false, error: 'unavailable' };
  return r.data || { ok: false, error: 'unavailable' };
}
export async function blockByHandleRpc(h) {
  const r = await handleRpc('block_by_handle', { p_handle: cleanHandleInput(h) });
  if (r.error) return { ok: false, error: 'unavailable' };
  return r.data || { ok: false, error: 'unavailable' };
}
export async function reportByHandleRpc(h, reason, details) {
  const r = await handleRpc('report_by_handle', { p_handle: cleanHandleInput(h), p_reason: reason, p_details: details || '' });
  if (r.error) return { ok: false, error: 'unavailable' };
  return r.data || { ok: false, error: 'unavailable' };
}
export async function friendFormerlyRpc(uid) {
  const r = await handleRpc('friend_formerly', { p_user: uid });
  if (r.error || !r.data) return null;
  return String(r.data);
}

/* The typed claim results → honest words. The cooldown copy carries
   the server's own days_remaining — never a client-side guess. */
export function handleClaimErrorMessage(res) {
  if (!res) return 'Something went wrong — try again.';
  switch (res.error) {
    case 'invalid': return 'Handles are 3–20 characters: lowercase letters, numbers and underscores.';
    case 'screened': return 'That handle can’t be used — please pick a different one.';
    case 'reserved': return 'That handle is reserved — please pick a different one.';
    case 'taken': return 'That handle is already taken.';
    case 'quarantined': return 'That handle was released recently — it’s held for its previous owner for now.';
    case 'cooldown': return 'You changed your handle recently — you can change it again in ' + (res.days_remaining || 'a few') + ' days.';
    case 'not_signed_in': return 'Sign in first.';
    case 'unsupported': return 'Handles aren’t available yet — try again soon.';
    default: return 'Couldn’t save that handle — try again.';
  }
}

/* ---------- the handle editor block (js/105 account form) ---------- */
export function handleEditorHTML(p) {
  const h = (p && p.handle) || '';
  return (h
    ? '<p class="note" style="margin:0 0 6px">Your handle is <b>@' + esc(h) + '</b> — friends see it instead of your name.</p>'
    : '<p class="note" style="margin:0 0 6px">Pick a handle if you’d rather friends see <b>@you</b> than your name. It’s also how people can find you — but only if you turn that on below.</p>') +
    '<div class="search-row"><span class="note" style="align-self:center">@</span>' +
    // v590: the placeholder must read as an EXAMPLE, not a value the
    // reader already has (census F-copy) — "e.g." plus a visually
    // distinct sample, and a real label for the field.
    '<label class="sr-only" for="pf-handle">Handle</label>' +
    '<input id="pf-handle" class="text-input" value="' + esc(h) + '" maxlength="20" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="e.g. moon_reader42">' +
    '<button type="button" class="btn" id="pf-handle-save">' + (h ? 'Change handle' : 'Claim handle') + '</button></div>' +
    '<p class="note" id="pf-handle-status" style="margin:6px 0 0">3–20 characters: lowercase letters, numbers, underscores.</p>' +
    (h ? '<button type="button" class="btn ghost sm" id="pf-handle-clear" style="margin-top:8px">Remove handle</button>' : '');
}
export function refreshHandleEditor() {
  const box = document.getElementById('pf-handle-box');
  if (!box) return;
  box.innerHTML = handleEditorHTML(loadProfile());
  wireHandleEditor();
}
/* The findable seg lives in the account form (its value rides the
   form's autosave commit); its enabled state follows the handle. */
export function syncFindableSeg() {
  const seg = document.getElementById('pf-findable');
  if (!seg) return;
  const has = !!(loadProfile().handle);
  seg.dataset.disabled = has ? '0' : '1';
  seg.querySelectorAll('button').forEach(b => { b.disabled = !has; });
}
export async function wireHandleEditor() {
  const box = document.getElementById('pf-handle-box');
  if (!box) return;
  // Pre-migration database: the whole handle field hides, exactly
  // like the block affordances did before v526.
  const probeRes = await handleAvailableRpc('');
  if (probeRes.unsupported) {
    const field = box.closest('.field');
    if (field) field.style.display = 'none';
    const f2 = document.getElementById('pf-findable-field');
    if (f2) f2.style.display = 'none';
    return;
  }
  const input = document.getElementById('pf-handle');
  const status = document.getElementById('pf-handle-status');
  const saveBtn = document.getElementById('pf-handle-save');
  const setStatus = (t) => { if (status) status.textContent = t; };
  let debounce = null;
  if (input) input.addEventListener('input', () => {
    clearTimeout(debounce);
    const v = cleanHandleInput(input.value);
    const cur = loadProfile().handle || '';
    if (!v || v === cur) { setStatus('3–20 characters: lowercase letters, numbers, underscores.'); return; }
    if (!handleFormatValid(v)) { setStatus(handleClaimErrorMessage({ ok: false, error: 'invalid' })); return; }
    const hit = handleScreenHit(v, 'handle');
    if (hit) {
      setStatus(handleClaimErrorMessage({ ok: false, error: HANDLE_SCREEN_RESERVED.indexOf(hit) !== -1 ? 'reserved' : 'screened' }));
      return;
    }
    setStatus('Checking…');
    debounce = setTimeout(async () => {
      const r = await handleAvailableRpc(v);
      if (!input.isConnected || cleanHandleInput(input.value) !== v) return; // typed on
      if (r.unsupported) { setStatus('Handles aren’t available yet — try again soon.'); return; }
      setStatus(r.available ? '✓ @' + v + ' is available' : 'That handle isn’t available.');
    }, 350);
  });
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const v = cleanHandleInput(input ? input.value : '');
    if (!handleFormatValid(v)) { setStatus(handleClaimErrorMessage({ ok: false, error: 'invalid' })); return; }
    const hit = handleScreenHit(v, 'handle');
    if (hit) {
      setStatus(handleClaimErrorMessage({ ok: false, error: HANDLE_SCREEN_RESERVED.indexOf(hit) !== -1 ? 'reserved' : 'screened' }));
      return;
    }
    saveBtn.disabled = true;
    const res = await claimHandleRpc(v);
    saveBtn.disabled = false;
    if (res && res.ok) {
      const p = loadProfile();
      p.handle = res.handle || v;
      saveProfile(p);
      toast('Handle saved — you’re @' + p.handle + ' now');
      refreshHandleEditor();
      syncFindableSeg();
    } else {
      setStatus(handleClaimErrorMessage(res));
    }
  });
  const clearBtn = document.getElementById('pf-handle-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (clearBtn.dataset.armed !== '1') {
      // First tap states the consequence; the second confirms. The
      // 90-day hold is the anti-squatting quarantine from the design:
      // nobody else can take the released handle, and the owner can
      // reclaim it at any time within the window.
      clearBtn.dataset.armed = '1';
      clearBtn.textContent = 'Tap again to remove it';
      setStatus('Removing releases @' + (loadProfile().handle || '') + ' — it’s held for you for 90 days: nobody else can claim it, and you can reclaim it anytime. Taking a different handle waits out a 30-day cooldown.');
      return;
    }
    clearBtn.disabled = true;
    const res = await clearHandleRpc();
    if (res && res.ok) {
      const p = loadProfile();
      p.handle = '';
      p.findable = false;
      saveProfile(p);
      toast('Handle removed');
      refreshHandleEditor();
      syncFindableSeg();
    } else {
      clearBtn.disabled = false;
      setStatus('Couldn’t remove the handle — try again.');
    }
  });
}

/* ---------- add by handle (the invite sheet, js/195) ---------- */
export async function wireHandleAdd() {
  const btn = document.getElementById('cc-handle-find');
  const input = document.getElementById('cc-handle');
  const slot = document.getElementById('cc-handle-slot');
  if (!btn || !input || !slot) return;
  const probeRes = await handleAvailableRpc('');
  if (probeRes.unsupported) {
    const field = btn.closest('.field');
    if (field) field.style.display = 'none';
    return;
  }
  const run = async () => {
    const v = cleanHandleInput(input.value);
    slot.innerHTML = '';
    if (!handleFormatValid(v)) {
      slot.innerHTML = '<p class="note">Enter the exact handle — 3–20 characters: letters, numbers, underscores.</p>';
      return;
    }
    btn.disabled = true;
    const card = await lookupHandleRpc(v);
    btn.disabled = false;
    if (!card) {
      // One message for every miss: unknown, not findable, blocked,
      // or rate-limited are indistinguishable by design (v550).
      slot.innerHTML = '<p class="note">No reader goes by that handle. Handles only appear here once their owner turns on “Findable by handle” — and a mistyped or blocked handle looks exactly the same.</p>';
      return;
    }
    renderHandleCard(slot, card);
  };
  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
}
export function renderHandleCard(slot, card) {
  // The lookup shape carries no user_id and no name — by design. The
  // avatar renders from avatar_id alone (an uploaded photo sits
  // behind the accepted-link storage policy, so it can't — and
  // shouldn't — load for a stranger).
  const prof = { user_id: '', first_name: '', last_name: '', avatar_id: card.avatar_id || '', avatar_path: '' };
  slot.innerHTML =
    '<div class="circle-row" style="margin-top:10px">' +
    (typeof circAvatarHTML === 'function' ? circAvatarHTML(prof, 'c-avatar') : '') +
    '<div class="circle-meta"><b>@' + esc(card.handle) + '</b>' +
    (card.bio ? '<span class="note">' + esc(card.bio) + '</span>' : '') +
    (Array.isArray(card.fav_genres) && card.fav_genres.length
      ? '<span class="note">' + card.fav_genres.map(g => esc(g)).join(' · ') + '</span>' : '') +
    '</div>' +
    '<div class="circle-actions"><button class="btn sm" id="cc-handle-send">Send request</button></div></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">' +
    '<button class="btn ghost sm" id="cc-handle-report">Report</button>' +
    '<button class="btn ghost sm" id="cc-handle-block">Block</button></div>' +
    '<p class="note" id="cc-handle-msg"></p>';
  const msg = slot.querySelector('#cc-handle-msg');
  slot.querySelector('#cc-handle-send').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const res = await requestByHandleRpc(card.handle);
    if (res && res.ok) {
      msg.textContent = 'Request sent — they’ll see it in their requests and can accept or decline.';
    } else {
      b.disabled = false;
      msg.textContent = 'Couldn’t send that request — you may already be connected, or that handle is no longer available.';
    }
  });
  slot.querySelector('#cc-handle-report').addEventListener('click', () => openHandleReportSheet(card.handle));
  slot.querySelector('#cc-handle-block').addEventListener('click', () => openHandleBlockSheet(card.handle, slot));
}

/* Block from the lookup card — same sheet pattern and calm copy as
   openBlockSheet (js/195), but the resolution happens server-side:
   the card never learns a user_id. */
export function openHandleBlockSheet(handle, slot) {
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="hb-back"><div class="modal" role="dialog" aria-label="Block reader">' +
    '<button class="modal-close" id="hb-x">✕</button>' +
    '<h2 class="serif">Block @' + esc(handle) + '?</h2>' +
    '<p class="note">Neither of you will be able to add the other while the block stands. They won’t be told — to them, this handle simply stops appearing.</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="hb-cancel">Cancel</button>' +
    '<button class="btn danger" id="hb-yes">Block</button></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom);
  const close = () => { overlayClosed(ovToken); closeDom(); };
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('#hb-back .modal'), close);
  ov.querySelector('#hb-back').addEventListener('click', e => { if (e.target.id === 'hb-back') close(); });
  ov.querySelector('#hb-x').addEventListener('click', close);
  ov.querySelector('#hb-cancel').addEventListener('click', close);
  ov.querySelector('#hb-yes').addEventListener('click', async () => {
    const res = await blockByHandleRpc(handle);
    if (res && res.ok) {
      close();
      toast('Blocked — you’re out of each other’s way now');
      if (slot) slot.innerHTML = '<p class="note">Blocked. This handle won’t appear for you again.</p>';
    } else {
      toast('Couldn’t block — that handle is no longer available.');
    }
  });
}

/* Report from the lookup card — the v246 flow (same reasons, same
   table), resolved server-side like the block. */
export function openHandleReportSheet(handle) {
  if (!cloudUser) return;
  const reasons = (typeof REPORT_REASONS !== 'undefined' && REPORT_REASONS) || [
    ['spam', 'Spam'], ['harassment', 'Harassment'], ['inappropriate', 'Inappropriate content'],
    ['fake_account', 'Fake account'], ['other', 'Other'],
  ];
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="hr-back"><div class="modal" role="dialog" aria-label="Report user">' +
    '<button class="modal-close" id="hr-x">✕</button>' +
    '<h2 class="serif">Report @' + esc(handle) + '?</h2>' +
    '<p class="note">Reports go to the app administrator, who reviews them in the Libram Observatory.</p>' +
    '<div class="field"><label for="hr-reason">Reason</label>' +
    '<select id="hr-reason">' + reasons.map(r => '<option value="' + r[0] + '">' + r[1] + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="hr-details">Details (optional)</label>' +
    '<textarea id="hr-details" rows="3" maxlength="1000" placeholder="What happened?"></textarea></div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="hr-cancel">Cancel</button>' +
    '<button class="btn danger" id="hr-send">Send report</button></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom);
  const close = () => { overlayClosed(ovToken); closeDom(); };
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('#hr-back .modal'), close);
  ov.querySelector('#hr-back').addEventListener('click', e => { if (e.target.id === 'hr-back') close(); });
  ov.querySelector('#hr-x').addEventListener('click', close);
  ov.querySelector('#hr-cancel').addEventListener('click', close);
  ov.querySelector('#hr-send').addEventListener('click', async () => {
    const reason = ov.querySelector('#hr-reason').value;
    const details = ov.querySelector('#hr-details').value.trim();
    ov.querySelector('#hr-send').disabled = true;
    const res = await reportByHandleRpc(handle, reason, details);
    if (res && res.ok) {
      close();
      toast('Report sent — thank you');
    } else {
      ov.querySelector('#hr-send').disabled = false;
      toast('Couldn’t send that report — that handle is no longer available.');
    }
  });
}

/* ---------- the signup handle: the deferred claim (v551) ----------
   Since v551 the Create-account form REQUIRES the handle (User
   directive: Name, Email and handle). The claim itself cannot happen
   there — claim_handle needs an authenticated session and a profiles
   row, and email confirmation means the form usually runs signed-out —
   so the chosen handle rides user_metadata (meta.handle, js/090)
   exactly like the signup names, and enterApp calls this helper once
   the first session's profile load has completed.

   The invariant that makes a stale stash harmless: this helper only
   ever claims into an EMPTY profile handle. Once profile.handle is
   set — by this helper, by the Profile editor, or by another device —
   the stash is dead and never fires. The per-session flag below only
   bounds repeat attempts within one session; clearing the stash is
   best-effort (updateUser can fail offline) and is NOT load-bearing. */
export let signupHandleClaimFor = null;

export async function clearSignupHandleStash() {
  try {
    const sb = await cloudClient().catch(() => null);
    if (sb && sb.auth && typeof sb.auth.updateUser === 'function') {
      await sb.auth.updateUser({ data: { handle: '' } });
    }
  } catch (e) { /* tolerated — see the invariant above */ }
  try { if (cloudUser && cloudUser.user_metadata) cloudUser.user_metadata.handle = ''; } catch (e) {}
}

export async function claimSignupHandle(user) {
  if (!user || !user.id) return;
  if (signupHandleClaimFor === user.id) return; // once per user per session
  const md = user.user_metadata || {};
  const stash = cleanHandleInput(md.handle || '');
  if (!stash) { signupHandleClaimFor = user.id; return; }
  if ((loadProfile().handle || '') !== '') { signupHandleClaimFor = user.id; return; }
  signupHandleClaimFor = user.id; // set BEFORE the await: never loops
  if (!handleFormatValid(stash)) {
    // A malformed stash can only arrive from an older/other client —
    // it can never claim; drop it quietly rather than nag.
    await clearSignupHandleStash();
    return;
  }
  const res = await claimHandleRpc(stash);
  if (res && res.ok) {
    const p = loadProfile();
    p.handle = res.handle || stash;
    saveProfile(p); // no updatedAt stamp — the handle never rides the profile sync (see js/105)
    await clearSignupHandleStash();
    toast('Your handle @' + p.handle + ' is yours');
    return;
  }
  if (res && ['taken', 'quarantined', 'screened', 'reserved', 'cooldown', 'invalid'].indexOf(res.error) !== -1) {
    // A typed refusal is final for this stash: clear it, say honestly
    // what happened, and put the reader on the Profile view to pick
    // another — the claim race they lost was real (account created,
    // email confirmed, handle gone in the meantime).
    await clearSignupHandleStash();
    toast(res.error === 'taken'
      ? 'The handle @' + stash + ' was just taken — pick yours in Profile.'
      : handleClaimErrorMessage(res) + ' Pick yours in Profile.');
    if (typeof go === 'function') go('profile');
    return;
  }
  // 'unsupported' (a pre-v550 database) or a transient failure: leave
  // the stash in place — a later session can complete the claim.
}

/* ---------- friend card: "formerly @…" ---------- */
export async function fillFriendFormerly(uid) {
  const el = document.getElementById('cf-formerly');
  if (!el || !uid) return;
  const former = await friendFormerlyRpc(uid).catch(() => null);
  if (!former) return;
  el.textContent = 'Formerly @' + former;
  el.hidden = false;
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/095-gate.js, js/105-account.js, js/195-coven.js, js/231-reactions.js, js/232-thought-of-you.js, js/233-buddy-reads.js, js/234-outbox.js and js/242-marginalia.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.HANDLE_SCREEN_SLURS = HANDLE_SCREEN_SLURS;
window.HANDLE_SCREEN_RESERVED = HANDLE_SCREEN_RESERVED;
window.handleNormalizeText = handleNormalizeText;
window.handleScreenHit = handleScreenHit;
window.handleHitIsReserved = handleHitIsReserved;
window.profileContentScreenHit = profileContentScreenHit;
window.handleFormatValid = handleFormatValid;
window.cleanHandleInput = cleanHandleInput;
window.friendDisplayName = friendDisplayName;
window.handlesRpcMissing = handlesRpcMissing;
window.handleRpc = handleRpc;
window.claimHandleRpc = claimHandleRpc;
window.clearHandleRpc = clearHandleRpc;
window.handleAvailableRpc = handleAvailableRpc;
window.lookupHandleRpc = lookupHandleRpc;
window.requestByHandleRpc = requestByHandleRpc;
window.blockByHandleRpc = blockByHandleRpc;
window.reportByHandleRpc = reportByHandleRpc;
window.friendFormerlyRpc = friendFormerlyRpc;
window.handleClaimErrorMessage = handleClaimErrorMessage;
window.handleEditorHTML = handleEditorHTML;
window.refreshHandleEditor = refreshHandleEditor;
window.syncFindableSeg = syncFindableSeg;
window.wireHandleEditor = wireHandleEditor;
window.wireHandleAdd = wireHandleAdd;
window.renderHandleCard = renderHandleCard;
window.openHandleBlockSheet = openHandleBlockSheet;
window.openHandleReportSheet = openHandleReportSheet;
window.signupHandleClaimFor = signupHandleClaimFor;
window.clearSignupHandleStash = clearSignupHandleStash;
window.claimSignupHandle = claimSignupHandle;
window.fillFriendFormerly = fillFriendFormerly;
