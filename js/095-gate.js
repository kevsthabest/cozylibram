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
  await cloudFirstSync();
}

function leaveApp() {
  gateEnteredUid = null;
  setLocalUser(null);
  renderGate();
}
