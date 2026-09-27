'use strict';

/* ---------------- Cloud sync (Supabase, optional) ---------------- */
// Per-user long-term storage. Needs a Supabase project (see supabase/schema.sql).
// Credentials: the home server shares them with LAN clients via /config.js
// They are configured once in server-config.json on the home PC.
// The anon key is safe in the browser — Row Level Security ensures each user
// only sees their own rows.
const SB_LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
let sbClient = null, sbClientCfg = '', cloudUser = null;
let cloudTimer = null, cloudLastSync = 0, cloudSyncing = false;

function cloudCfg() {
  try {
    const c = window.SPICY_CONFIG || {};
    return { url: (c.supabaseUrl || '').trim(), key: (c.supabaseAnonKey || '').trim() };
  } catch (e) { return { url: '', key: '' }; }
}
function cloudConfigured() { const c = cloudCfg(); return !!(c.url && c.key); }

function loadSupabaseLib() {
  return new Promise((resolve, reject) => {
    if (window.__sbStub) return resolve(); // tests
    if (window.supabase && window.supabase.createClient) return resolve();
    const s = document.createElement('script');
    s.src = SB_LIB_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Supabase library (are you online?)'));
    document.head.appendChild(s);
  });
}
async function cloudClient() {
  if (window.__sbStub) return window.__sbStub;
  if (!cloudConfigured()) return null;
  const c = cloudCfg(), k = c.url + '|' + c.key;
  if (sbClient && sbClientCfg === k) return sbClient;
  await loadSupabaseLib();
  sbClient = window.supabase.createClient(c.url, c.key);
  sbClientCfg = k;
  return sbClient;
}

function bookToRow(b, userId) {
  return { user_id: userId, book_id: b.id, isbn: b.isbn || null, data: b };
}
// Merge cloud rows into the local library. Newer _mtime wins conflicts.
// Rows for tombstoned books are skipped — that's the deletion propagating
// instead of the book resurrecting.
function mergeCloudBooks(local, remoteRows) {
  const dead = tombstonedIds();
  const byId = new Map(local.map(b => [b.id, b]));
  let changed = false;
  for (const r of remoteRows) {
    if (!r || !r.book_id || dead.has(r.book_id)) continue;
    const lb = byId.get(r.book_id);
    const rd = migrateBook(Object.assign({}, r.data || {}));
    if (!lb) { local.push(rd); byId.set(r.book_id, rd); changed = true; }
    else if ((rd._mtime || 0) > (lb._mtime || 0)) { Object.assign(lb, rd); changed = true; }
  }
  return changed;
}

// Translate cryptic PostgREST errors into actionable messages.
function cloudErrMsg(e) {
  const m = String((e && e.message) || e);
  const missing = m.match(/Could not find the table 'public\.(\w+)'/);
  if (missing)
    return "Cloud sync failed: the '" + missing[1] + "' table doesn't exist in your Supabase " +
      "project yet — run supabase/schema.sql in the Supabase SQL editor, then tap Sync now.";
  return 'Cloud sync failed: ' + m;
}

async function cloudPushNow() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser || cloudSyncing) return false;
  cloudSyncing = true;
  try {
    const rows = library.map(b => bookToRow(b, cloudUser.id));
    if (rows.length) {
      const { error } = await sb.from('books').upsert(rows, { onConflict: 'user_id,book_id' });
      if (error) throw error;
    }
    if (tombstones.length) {
      const trows = tombstones.map(t => ({ user_id: cloudUser.id, book_id: t.id,
        deleted_at: new Date(t.at).toISOString() }));
      const { error } = await sb.from('deleted_books').upsert(trows, { onConflict: 'user_id,book_id' });
      if (error) throw error;
    }
    cloudLastSync = Date.now();
    return true;
  } catch (e) {
    toast(cloudErrMsg(e));
    return false;
  } finally {
    cloudSyncing = false;
    refreshAccountUI();
  }
}

async function cloudPullTombstones() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return [];
  const { data, error } = await sb.from('deleted_books').select('book_id');
  if (error) throw error;
  return (data || []).map(r => r.book_id).filter(Boolean);
}

// Apply remote tombstones: drop matching local books and record the
// tombstones locally so this device never re-pushes them.
function applyTombstones(ids) {
  if (!ids || !ids.length) return false;
  const dead = tombstonedIds();
  let changed = false;
  for (const id of ids) {
    if (library.some(b => b.id === id)) {
      library = library.filter(b => b.id !== id);
      bookSnapshots.delete(id);
      changed = true;
    }
    if (!dead.has(id)) { tombstones.push({ id: id, at: Date.now() }); dead.add(id); changed = true; }
  }
  if (changed) { saveTombstones(); saveLibrary({ noCloud: true }); }
  return changed;
}
function scheduleCloudPush() {
  if (!cloudConfigured()) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { cloudPushNow(); }, 2500);
}
async function cloudPullRows() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return [];
  const { data, error } = await sb.from('books').select('book_id,isbn,data');
  if (error) throw error;
  return data || [];
}
async function cloudFirstSync() {
  // After sign-in (or on boot with a session): pull tombstones, apply them,
  // then pull books, merge, and push. Tombstones go first so a deletion that
  // happened on another device can't be undone by this device's push.
  if (!cloudUser) return;
  try {
    await syncCloudProfile();
    if (applyTombstones(await cloudPullTombstones())) render();
    const remote = await cloudPullRows();
    if (mergeCloudBooks(library, remote)) { saveLibrary({ noCloud: true }); render(); }
    await cloudPushNow();
    toast('☁️ Library synced');
  } catch (e) { toast(cloudErrMsg(e)); }
}
async function cloudWipe() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  const { error } = await sb.from('books').delete().eq('user_id', cloudUser.id);
  if (error) toast('Cloud wipe failed: ' + error.message);
}

async function cloudSignUp(email, password, firstName, lastName) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Cloud sync is not configured — add it to server-config.json on your home PC'); return; }
  const meta = {};
  if (firstName) meta.first_name = firstName;
  if (lastName) meta.last_name = lastName;
  const { data, error } = await sb.auth.signUp({ email: email, password: password, options: { data: meta } });
  if (error) { toast('Sign up failed: ' + error.message); return; }
  if (data && data.session) toast('☁️ Account created — signed in');
  else toast('Account created — check your email to confirm, then sign in.');
}
async function cloudSignIn(email, password) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Cloud sync is not configured — add it to server-config.json on your home PC'); return; }
  const { error } = await sb.auth.signInWithPassword({ email: email, password: password });
  if (error) { toast('Sign in failed: ' + error.message); return; }
  // onAuthStateChange fires SIGNED_IN → cloudFirstSync runs there.
}
async function cloudSignOut() {
  const sb = await cloudClient().catch(() => null);
  if (sb) await sb.auth.signOut().catch(() => {});
  // The SIGNED_OUT event also triggers leaveApp; the cloudUser guard keeps it
  // from running twice (e.g. when the event doesn't fire while offline).
  if (cloudUser) { cloudUser = null; leaveApp(); }
  toast('Signed out');
}
async function cloudGoogle() {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Cloud sync is not configured'); return; }
  // NOTE (future APK via Capacitor): Google OAuth needs a custom URL scheme
  // there — use skipBrowserRedirect and handle the callback with deep links
  // instead of this web redirect.
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.href.split('#')[0] }
  });
}

async function cloudResetPassword(email) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Cloud sync is not configured'); return false; }
  const redirectTo = location.origin + location.pathname + '#recovery';
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
  if (error) { toast('Reset failed: ' + error.message); return false; }
  return true;
}

// A password-reset link lands back here with ?code=…. Exchange it for a
// session, then show the new-password form instead of the normal boot flow.
async function handlePasswordRecovery(sb, code) {
  try {
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    if (error || !data || !data.user) { renderGate(); toast('That reset link expired — request a new one.'); return; }
    cloudUser = data.user;
    try { history.replaceState(null, '', location.pathname + '#recovery'); } catch (e) {}
    renderNewPassword();
  } catch (e) { renderGate(); }
}
async function initCloud() {
  if (!cloudConfigured()) return;
  try {
    const sb = await cloudClient();
    const code = new URLSearchParams(location.search).get('code');
    if (code) { await handlePasswordRecovery(sb, code); return; }
    sb.auth.onAuthStateChange((event, session) => {
      const user = (session && session.user) || null;
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && user) {
        if (!cloudUser || cloudUser.id !== user.id) { cloudUser = user; enterApp(user); }
        else cloudUser = user;
      } else if (event === 'SIGNED_OUT') {
        if (cloudUser) { cloudUser = null; leaveApp(); }
      }
      refreshAccountUI();
    });
    // Fallback in case INITIAL_SESSION doesn't fire on this client.
    const { data } = await sb.auth.getSession();
    const user = (data && data.session && data.session.user) || null;
    if (user && (!cloudUser || cloudUser.id !== user.id)) { cloudUser = user; enterApp(user); }
    refreshAccountUI();
  } catch (e) { /* offline or bad config — app keeps working locally */ }
}

function refreshAccountUI() {
  const st = document.getElementById('ac-status');
  if (!st) return; // settings not open
  const inEl = document.getElementById('ac-signedin');
  const outEl = document.getElementById('ac-signedout');
  if (!cloudConfigured()) {
    st.textContent = 'Cloud sync is off — add supabase_url and supabase_anon_key to server-config.json on your home PC.';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
    return;
  }
  if (cloudUser) {
    st.innerHTML = icon('cloud') + ' Signed in as ' + esc(cloudUser.email);
    if (inEl) inEl.style.display = '';
    if (outEl) outEl.style.display = 'none';
    const last = document.getElementById('ac-last');
    if (last) last.textContent = cloudSyncing ? 'Syncing…' :
      (cloudLastSync ? 'Last synced ' + new Date(cloudLastSync).toLocaleString() : 'Not synced yet');
  } else {
    st.textContent = 'Not signed in.';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
  }
}

