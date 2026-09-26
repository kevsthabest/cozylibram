'use strict';

/* ---------------- sign-in gate (multi-user) ---------------- */
// When cloud sync is configured, the app opens on a sign-in gate instead of
// the library: each user gets their own on-device library (partitioned by
// user id — see setLocalUser) plus their own cloud rows (RLS). "Continue
// offline" skips the gate and uses the classic single-device library;
// Settings → Account can sign in later. Sessions persist, so the gate only
// appears while signed out.
const OFFLINE_KEY = 'spicyshelves.offline';
let gateEnteredUid = null;

function renderGate() {
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  setView(
    '<div class="gate-wrap"><div class="gate-card">' +
    '<h1 class="serif">Spicy Shelves</h1>' +
    '<p class="note">her dark little library</p>' +
    '<p class="note" id="gate-status">Sign in to sync your shelves across devices.</p>' +
    '<input id="gate-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
    '<input id="gate-pass" type="password" class="text-input" placeholder="Password" autocomplete="current-password">' +
    '<button class="btn block" id="gate-signin">Sign in</button>' +
    '<button class="btn ghost block" id="gate-signup">Create account</button>' +
    (window.isSecureContext
      ? '<button class="btn ghost block" id="gate-google">Sign in with Google</button>'
      : '') +
    '<button class="btn ghost block gate-offline" id="gate-offline">Continue offline →</button>' +
    '<button class="btn ghost block gate-offline" id="gate-forgot" style="margin-top:2px">Forgot password?</button>' +
    '</div></div>'
  );
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
  document.getElementById('gate-signup').addEventListener('click', () => {
    if (!em() || pw().length < 6) { busy('Enter an email and a password (6+ characters).'); return; }
    busy('Creating account…');
    cloudSignUp(em(), pw());
  });
  const g = document.getElementById('gate-google');
  if (g) g.addEventListener('click', () => { busy('Redirecting to Google…'); cloudGoogle(); });
  document.getElementById('gate-offline').addEventListener('click', () => {
    try { localStorage.setItem(OFFLINE_KEY, '1'); } catch (e) {}
    hideGate();
    render();
  });
  document.getElementById('gate-forgot').addEventListener('click', renderGateReset);
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
  try { localStorage.removeItem(OFFLINE_KEY); } catch (e) {}
  setLocalUser(user.id);
  hideGate();
  view = 'library';
  render();
  renderTopbar();
  adoptLegacyMetadata(user);
  await syncCloudProfile();
  await cloudFirstSync();
}

function leaveApp() {
  gateEnteredUid = null;
  setLocalUser(null);
  renderTopbar();
  renderGate();
}
