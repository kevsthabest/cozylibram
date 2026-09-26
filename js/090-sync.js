'use strict';

/* ---------------- Cloud sync (Supabase, optional) ---------------- */
// Per-user long-term storage. Needs a Supabase project (see supabase/schema.sql).
// Credentials: the home server shares them with LAN clients via /config.js
// (LAN-only). They are configured once in server-config.json on the home PC.
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
function mergeCloudBooks(local, remoteRows) {
  const byId = new Map(local.map(b => [b.id, b]));
  let changed = false;
  for (const r of remoteRows) {
    if (!r || !r.book_id) continue;
    const lb = byId.get(r.book_id);
    const rd = migrateBook(Object.assign({}, r.data || {}));
    if (!lb) { local.push(rd); byId.set(r.book_id, rd); changed = true; }
    else if ((rd._mtime || 0) > (lb._mtime || 0)) { Object.assign(lb, rd); changed = true; }
  }
  return changed;
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
    cloudLastSync = Date.now();
    return true;
  } catch (e) {
    toast('Cloud sync failed: ' + e.message);
    return false;
  } finally {
    cloudSyncing = false;
    refreshAccountUI();
  }
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
  // After sign-in (or on boot with a session): pull, merge, push.
  if (!cloudUser) return;
  try {
    const remote = await cloudPullRows();
    if (mergeCloudBooks(library, remote)) { saveLibrary({ noCloud: true }); render(); }
    await cloudPushNow();
    toast('☁️ Library synced');
  } catch (e) { toast('Cloud sync failed: ' + e.message); }
}
async function cloudWipe() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  const { error } = await sb.from('books').delete().eq('user_id', cloudUser.id);
  if (error) toast('Cloud wipe failed: ' + error.message);
}

async function cloudSignUp(email, password) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Cloud sync is not configured — add it to server-config.json on your home PC'); return; }
  const { data, error } = await sb.auth.signUp({ email: email, password: password });
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

async function initCloud() {
  if (!cloudConfigured()) return;
  try {
    const sb = await cloudClient();
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
    st.textContent = '☁️ Signed in as ' + cloudUser.email;
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

