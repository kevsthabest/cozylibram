'use strict';

/* ---------------- sign-in gate (multi-user) ---------------- */
// Sign-in is required (v204: the "Continue offline" escape hatch is gone).
// Each user gets their own on-device library (partitioned by user id — see
// setLocalUser) plus their own cloud rows (RLS). Sessions persist, so the
// gate only appears while signed out, and returning users keep working from
// the on-device cache when offline. A pre-v204 offline library is adopted
// into the account on first sign-in — see setLocalUser.
let gateEnteredUid = null;

// v230: rotating taglines — a fresh one every login. The header tagline in
// index.html and the meta/manifest descriptions keep the canonical
// "every spine has a story"; these cycle through the shortlist below.
const TAGLINES = [
  'every spine has a story',
  'your shelves, your story',
  'for readers who live between the pages',
  'cozy shelves for wild stories',
  'where the tbr never ends',
  'read boldly, rest softly',
];
function taglineIndex() {
  try {
    const n = parseInt(localStorage.getItem('cozylibram.tagline') || '0', 10);
    return Number.isFinite(n) && n >= 0 ? n % TAGLINES.length : 0;
  } catch (e) { return 0; }
}
function currentTagline() { return TAGLINES[taglineIndex()]; }
function advanceTagline() {
  const next = (taglineIndex() + 1) % TAGLINES.length;
  try { localStorage.setItem('cozylibram.tagline', String(next)); } catch (e) {}
}
function applyHeaderTagline(t) {
  const el = document.querySelector('.app-header .tagline');
  if (el) el.textContent = t;
}

// v246: pending suspension notice, consumed by the next renderGate() after a
// banned user is signed back out.
let gateNotice = null;

// v246: fail open — a network blip must never lock a legitimate user out.
// The /api/* ban check in require-user.js is the hard enforcement.
async function isBannedUser(uid) {
  try {
    const sb = await cloudClient();
    const { data } = await sb.from('banned_users').select('user_id').eq('user_id', uid).maybeSingle();
    return !!data;
  } catch (e) { return false; }
}

// Batch 4 (issue #143): keyboard users hit Enter after typing — route it to
// the form's primary button. The buttons read field values at click time, so
// btn.click() reuses the exact same validation path as a tap. (No <form>
// wrapper: these are plain buttons, so there is no implicit submit to
// double-fire against.)
function gateSubmitOnEnter(inputIds, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
  });
}

function renderGate() {
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  // v242: the gate is a focused sign-in screen — hide the account menu
  // button. While signed out its only item is Settings, and the stray
  // profile circle on the login prompt confused invite-link recipients.
  const mb = document.getElementById('menu-btn');
  if (mb) mb.style.display = 'none';
  const configured = cloudConfigured();
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const shelfCount = (typeof library !== 'undefined' && library) ? library.length : 0;
  let status;
  if (gateNotice) {
    // v246: a banned user was just signed back out.
    status = gateNotice;
    gateNotice = null;
  } else if (!configured) {
    status = 'Sign-in isn\u2019t set up on this server yet.';
  } else if (!online) {
    status = 'You\u2019re offline \u2014 connect to the internet to sign in.';
  } else if (shelfCount > 0) {
    // Pre-v204 offline library waiting for adoption on first sign-in.
    status = 'You have ' + shelfCount + ' book' + (shelfCount === 1 ? '' : 's') +
      ' on this device \u2014 sign in to bring ' + (shelfCount === 1 ? 'it' : 'them') +
      ' into your account.';
  } else {
    status = 'Sign in to sync your shelves across devices.';
  }
  setView(
    '<div class="gate-wrap"><div class="gate-card">' +
    '<h1 class="serif">Cozy Libram</h1>' +
    '<p class="note">' + esc(currentTagline()) + '</p>' +
    '<p class="note" id="gate-status">' + esc(status) + '</p>' +
    (configured ?
      '<input id="gate-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
      '<input id="gate-pass" type="password" class="text-input" placeholder="Password" autocomplete="current-password">' +
      '<button class="btn block" id="gate-signin">Sign in</button>' +
      '<button class="btn ghost block" id="gate-show-signup">New here? Create account</button>' +
      (window.isSecureContext
        ? '<button class="btn ghost block" id="gate-google">Sign in with Google</button>'
        : '') +
      '<button class="btn ghost block gate-offline" id="gate-forgot" style="margin-top:2px">Forgot password?</button>'
      : '') +
    '</div></div>'
  );
  if (!configured) return;
  const em = () => document.getElementById('gate-email').value.trim();
  const pw = () => document.getElementById('gate-pass').value;
  const busy = (msg) => {
    const st = document.getElementById('gate-status');
    if (st) st.textContent = msg;
  };
  document.getElementById('gate-signin').addEventListener('click', () => {
    if (!em() || !pw()) { busy('Enter your email and password.'); return; }
    busy('Signing in…');
    cloudSignIn(em(), pw());
  });
  document.getElementById('gate-show-signup').addEventListener('click', renderGateSignup);
  const g = document.getElementById('gate-google');
  if (g) g.addEventListener('click', () => { busy('Redirecting to Google…'); cloudGoogle(); });
  document.getElementById('gate-forgot').addEventListener('click', renderGateReset);
  gateSubmitOnEnter(['gate-email', 'gate-pass'], 'gate-signin');
}

// "Create account" view (v90): the gate itself is sign-in only; tapping the
// "New here? Create account" option opens this form. First/last name travel
// in Supabase user_metadata and are adopted into the local profile (then the
// profiles table) on sign-in — see enterApp.
function renderGateSignup() {
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  setView(
    '<div class="gate-wrap"><div class="gate-card">' +
    '<h1 class="serif">Create account</h1>' +
    '<p class="note" id="gs-status">Your shelves, on every device.</p>' +
    '<input id="gs-first" type="text" class="text-input" placeholder="First name" autocomplete="given-name">' +
    '<input id="gs-last" type="text" class="text-input" placeholder="Last name" autocomplete="family-name">' +
    // v551: the handle is a required signup field (User directive —
    // Name, Email and handle). Validated here for format + the shared
    // screen (js/237); availability is NOT checkable from this form —
    // handle_available is granted to signed-in callers only, so the
    // chosen handle rides user_metadata like the names and is claimed
    // on the first sign-in (claimSignupHandle, js/237). The copy says
    // exactly that: confirmed when the account is created.
    '<div style="text-align:left;margin:2px 0 4px">' +
    '<div class="search-row"><span class="note" style="align-self:center">@</span>' +
    '<input id="gs-handle" type="text" class="text-input" placeholder="Handle" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24"></div>' +
    '<p class="note" style="margin:6px 0 0">Your public name on Cozy Libram — friends see your @handle instead of your real name. 3–20 characters: lowercase letters, numbers, underscores. It’s confirmed when your account is created; if it’s been taken by then, you’ll pick another in your Profile.</p></div>' +
    // v524: age band — self-declared at signup, stated 13+ floor. The
    // band only sets starting positions for the privacy + shield
    // toggles (js/230-privacy.js); it is stored privately (user_state),
    // never displayed, and can be changed later in Profile.
    '<div class="field" style="text-align:left;margin:2px 0 10px"><label>Your age group</label>' +
    '<div class="seg" id="gs-band" style="grid-template-columns:1fr 1fr">' +
    '<button type="button" data-b="teen">13–17</button>' +
    '<button type="button" data-b="adult">18+</button></div>' +
    '<p class="note" style="margin:6px 0 0">Cozy Libram is for readers 13 and up. Your age group sets your starting privacy and content settings — stored privately, never shown to anyone.</p></div>' +
    '<input id="gs-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
    '<input id="gs-pass" type="password" class="text-input" placeholder="Password (6+ characters)" autocomplete="new-password">' +
    '<input id="gs-pass2" type="password" class="text-input" placeholder="Confirm password" autocomplete="new-password">' +
    '<button class="btn block" id="gs-create">Create account</button>' +
    '<button class="btn ghost block" id="gs-back">← Back to sign in</button>' +
    '</div></div>'
  );
  const busy = (msg) => { const st = document.getElementById('gs-status'); if (st) st.textContent = msg; };
  document.getElementById('gs-back').addEventListener('click', renderGate);
  // v551: handles are lowercase-only by construction (the claim RPC
  // enforces the same charset) — normalize as they type, with the
  // same cleanHandleInput the profile editor uses.
  const gsHandle = document.getElementById('gs-handle');
  if (gsHandle && typeof cleanHandleInput === 'function') {
    gsHandle.addEventListener('input', () => {
      const c = cleanHandleInput(gsHandle.value);
      if (gsHandle.value !== c) gsHandle.value = c;
    });
  }
  // v524: single-select age band (radio behavior — no clear-to-unset).
  const bandBtns = Array.from(document.querySelectorAll('#gs-band button'));
  bandBtns.forEach(b => b.addEventListener('click', () => {
    bandBtns.forEach(x => x.classList.toggle('active', x === b));
  }));
  document.getElementById('gs-create').addEventListener('click', () => {
    const first = document.getElementById('gs-first').value.trim();
    const last = document.getElementById('gs-last').value.trim();
    const em = document.getElementById('gs-email').value.trim();
    const pw = document.getElementById('gs-pass').value;
    const pw2 = document.getElementById('gs-pass2').value;
    if (!first || !last) { busy('Tell us your first and last name.'); return; }
    if (!em) { busy('Enter your email.'); return; }
    if (pw.length < 6) { busy('Use a password with at least 6 characters.'); return; }
    if (pw !== pw2) { busy('Those passwords don\'t match — try again.'); return; }
    const bsel = document.querySelector('#gs-band button.active');
    const band = bsel ? bsel.dataset.b : '';
    if (band !== 'teen' && band !== 'adult') { busy('Choose your age group — it sets your starting privacy settings.'); return; }
    // v551: the handle is required — format + the shared screen are
    // checked here (the server re-checks both at claim time; the
    // screen lists' canonical copy is the SQL one). Availability
    // cannot be checked signed-out (see the field note above), so a
    // handle taken in the meantime fails honestly at claim time.
    const handle = (typeof cleanHandleInput === 'function')
      ? cleanHandleInput(document.getElementById('gs-handle').value)
      : document.getElementById('gs-handle').value.trim().toLowerCase().replace(/^@+/, '');
    if (!handle) { busy('Choose a handle — it’s the name friends will see.'); return; }
    if (typeof handleFormatValid === 'function' && !handleFormatValid(handle)) { busy('Handles are 3–20 characters: lowercase letters, numbers and underscores.'); return; }
    if (typeof handleScreenHit === 'function') {
      const hit = handleScreenHit(handle, 'handle');
      if (hit) {
        const reserved = typeof handleHitIsReserved === 'function' && handleHitIsReserved(hit);
        busy(reserved ? 'That handle is reserved — please pick a different one.' : 'That handle can’t be used — please pick a different one.');
        return;
      }
    }
    busy('Creating account…');
    // Record the band on this device immediately (shield state applies
    // even before email confirmation); it also travels in user_metadata
    // so the first sign-in on any device adopts it (enterApp).
    try { if (typeof setAgeBand === 'function') setAgeBand(band); } catch (e) {}
    cloudSignUp(em, pw, first, last, band, handle);
  });
  gateSubmitOnEnter(['gs-first', 'gs-last', 'gs-handle', 'gs-email', 'gs-pass', 'gs-pass2'], 'gs-create');
}

// "Forgot password?" view: sends a Supabase reset email. The link returns to
// this app with ?code=…, which initCloud exchanges and turns into the
// new-password form below. (Needs the Supabase Site URL set to the app's real
// address, or the email link points at localhost.)
function renderGateReset() {
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  setView(
    '<div class="gate-wrap"><div class="gate-card">' +
    '<h1 class="serif">Reset password</h1>' +
    '<p class="note" id="gr-status">Enter your account email and we\'ll send a reset link.</p>' +
    '<input id="gr-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
    '<button class="btn block" id="gr-send">Send reset link</button>' +
    '<button class="btn ghost block" id="gr-back">← Back to sign in</button>' +
    '</div></div>'
  );
  const busy = (msg) => { const st = document.getElementById('gr-status'); if (st) st.textContent = msg; };
  document.getElementById('gr-back').addEventListener('click', renderGate);
  document.getElementById('gr-send').addEventListener('click', async () => {
    const em = document.getElementById('gr-email').value.trim();
    if (!em) { busy('Enter your email first.'); return; }
    busy('Sending…');
    const ok = await cloudResetPassword(em);
    busy(ok ? 'Reset link sent — check your email.' : 'Could not send the link. Try again.');
  });
  gateSubmitOnEnter(['gr-email'], 'gr-send');
}

// New-password form shown after a reset link is exchanged.
function renderNewPassword() {
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  setView(
    '<div class="gate-wrap"><div class="gate-card">' +
    '<h1 class="serif">New password</h1>' +
    '<p class="note" id="np-status">Choose a new password for your account.</p>' +
    '<input id="np-pass" type="password" class="text-input" placeholder="New password (6+ characters)" autocomplete="new-password">' +
    '<button class="btn block" id="np-save">Save new password</button>' +
    '</div></div>'
  );
  const busy = (msg) => { const st = document.getElementById('np-status'); if (st) st.textContent = msg; };
  document.getElementById('np-save').addEventListener('click', async () => {
    const pw = document.getElementById('np-pass').value;
    if (pw.length < 6) { busy('Use at least 6 characters.'); return; }
    busy('Saving…');
    const sb = await cloudClient().catch(() => null);
    if (!sb) { busy('Something went wrong — request a new link.'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { busy('Could not save: ' + error.message); return; }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    toast('Password updated ✨');
    if (cloudUser) enterApp(cloudUser);
    else renderGate();
  });
  gateSubmitOnEnter(['np-pass'], 'np-save');
}

function hideGate() {
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = '';
}

// Idempotent: safe to call from INITIAL_SESSION, the getSession fallback, and
// SIGNED_IN — only the first call per user id takes effect.
async function enterApp(user) {
  if (gateEnteredUid === user.id) return;
  gateEnteredUid = user.id;
  // v246: banned users are signed straight back out before anything loads.
  if (await isBannedUser(user.id)) {
    gateEnteredUid = null;
    gateNotice = 'This account has been suspended.';
    try { await cloudSignOut(); } catch (e) {}
    toast('This account has been suspended.');
    return;
  }
  // v204: drop the retired offline-mode flags (the choice no longer exists).
  try { localStorage.removeItem('spicyshelves.offline'); localStorage.removeItem('spicyshelves.offline.owner'); } catch (e) {}
  // v202: async in the IndexedDB backend — the slot must be loaded before render().
  // A failed switch is logged (not thrown): enterApp is fire-and-forget.
  try { await setLocalUser(user.id); }
  catch (e) { try { AppLog.error('storage', 'sign-in slot switch failed: ' + (e && e.message)); } catch (_) {} }
  // Names captured on the "Create account" form travel in user_metadata —
  // adopt them into the local profile so syncCloudProfile pushes them to
  // the profiles table. Never overwrites names already set on the device.
  try {
    const md = (user && user.user_metadata) || {};
    const p = loadProfile();
    let touched = false;
    if (!p.firstName && md.first_name) { p.firstName = String(md.first_name); touched = true; }
    if (!p.lastName && md.last_name) { p.lastName = String(md.last_name); touched = true; }
    if (touched) touchProfile(p);
  } catch (e) {}
  hideGate();
  // v240: invite deep link — land on the coven tab so the stashed token
  // renders its accept card (works for brand-new accounts too).
  let inviteToken = null;
  try { inviteToken = sessionStorage.getItem('cozylibram.invite') || null; } catch (e) {}
  view = inviteToken ? 'coven' : 'library';
  applyHeaderTagline(currentTagline()); // v230: this login's tagline…
  advanceTagline(); // …then rotate so the next login gets a fresh one.
  render();
  const mb = document.getElementById('menu-btn');
  if (mb) mb.style.display = ''; // v242: restore the menu button hidden by renderGate()
  renderTopbar();
  analyticsSessionBoot(); // v118: session_started + onboarding funnel events
  adoptLegacyMetadata(user);
  await syncCloudProfile();
  // v524: adopt the signup age band from user_metadata (one-time seed —
  // a band later changed in Profile is never stomped), then land any
  // teen starting positions still pending (declared at signup before
  // email confirmation, when no session existed to write them with).
  try { if (typeof adoptSignupBand === 'function') await adoptSignupBand(user); } catch (e) {}
  try { if (typeof applyPendingTeenDefaults === 'function') await applyPendingTeenDefaults(); } catch (e) {}
  // v551: claim the handle chosen on the Create-account form (it rode
  // user_metadata like the names; the profile load has completed by
  // now, so the claim RPC has its session + profiles row).
  try { if (typeof claimSignupHandle === 'function') await claimSignupHandle(user); } catch (e) {}
  await cloudFirstSync();
  cloudRealtimeStart(); // v143: live sync while signed in (fire and forget)
  maybeOnboard(); // v127: library is settled — welcome brand-new accounts
  // v119: resolve admin status for the Observatory menu entry, then honor
  // #admin deep links (e.g. cozylibram.pages.dev/#admin).
  refreshAdminStatus().then(() => {
    renderTopbar();
    try {
      if (location.hash === '#admin') {
        history.replaceState(null, '', location.pathname + location.search);
        go('admin');
      }
    } catch (e) {}
  });
  // Library is settled now — let the Hardcover auto-sweep backfill the rest.
  setTimeout(autoEnrichSweep, 5000);
  // v476: metadata enrichment is automatic now (no user-facing section).
  // Page counts and covers backfill quietly in the background — additive
  // only, never overwriting existing data.
  setTimeout(function () {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (typeof backfillPageCounts === 'function') backfillPageCounts(1200, { quiet: true });
    } catch (e) {}
  }, 12000);
  setTimeout(function () {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (typeof downloadMissingCovers === 'function') downloadMissingCovers();
    } catch (e) {}
  }, 18000);
  // v476: quiet metadata compare sweep — blanks auto-fill, conflicts get a
  // badge in the book modal (see 134-verify.js). Hardcover-first priority.
  setTimeout(function () {
    try {
      if (typeof runMetaCompareSweep === 'function') runMetaCompareSweep();
    } catch (e) {}
  }, 25000);
  // Cover-storage closure: backfill round 2 — quietly adopt any cover
  // still pointing at a provider (or still a data: upload) into the
  // bucket. Resumable by construction; the sweep checks the kill-switch
  // and online state itself.
  setTimeout(function () {
    try { if (typeof sweepCoverAdoptions === 'function') sweepCoverAdoptions(); } catch (e) {}
  }, 30000);
  updateReleaseBadge(); // v149: surface any unseen auto-found releases
  setTimeout(maybeAutoReleaseCheck, 9000); // v149: weekly silent new-release sweep
  // v491: stale-bundle probe — compare the running bundle against the server
  // copy; a mismatch shows the tap-to-refresh banner (never auto-reloads).
  setTimeout(function () {
    try { if (typeof checkBootVersion === 'function') checkBootVersion(); } catch (e) {}
  }, 15000);
}

async function leaveApp() {
  gateEnteredUid = null;
  try { if (typeof resetMilestoneSync === 'function') resetMilestoneSync(); } catch (e) {} // v474: drop milestone sync state
  cloudRealtimeStop(); // v143
  // v202: async in the IndexedDB backend. Logged, not thrown: leaveApp is fire-and-forget.
  try { await setLocalUser(null); }
  catch (e) { try { AppLog.error('storage', 'sign-out slot switch failed: ' + (e && e.message)); } catch (_) {} }
  isAppAdmin = false; // v119: drop admin state + cached analytics on sign-out
  adminRowsCache = {}; adminAggCache = {}; adminModCache = null; adminUserDir = {}; // v246/v248
  renderTopbar();
  renderGate();
}
