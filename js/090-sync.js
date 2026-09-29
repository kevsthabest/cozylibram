'use strict';

/* ---------------- Cloud sync (Supabase, optional) ---------------- */
// Per-user long-term storage. Needs a Supabase project (see supabase/schema.sql).
// Credentials: the home server shares them with LAN clients via /config.js
// They are configured once in server-config.json on the home PC.
// The anon key is safe in the browser — Row Level Security ensures each user
// only sees their own rows.
// v194 (security): vendored as js/vendor/supabase.min.js (pinned 2.117.2,
// see js/vendor/SOURCES.txt). Same-origin, no CDN, works offline.
const SB_LIB_URL = 'js/vendor/supabase.min.js';
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
    s.onerror = () => reject(new Error('Could not load Supabase library (js/vendor/supabase.min.js missing?)'));
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
  /* v167: log every outcome. A silently dropped push is exactly what the
     Observatory log viewer exists to catch. */
  if (!sb || !cloudUser) { AppLog.warn('sync', 'push skipped: not signed in'); return false; }
  if (cloudSyncing) { AppLog.warn('sync', 'push skipped: another sync in flight'); return false; }
  cloudSyncing = true;
  syncBegin(); // v144: the dot covers push activity too
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
      // v147: a tombstoned book is gone for good — drop its row from the cloud
      // library too, so no pull/merge on any device can ever resurrect it.
      // Only an explicit manual re-add (which untombstones the id) brings it back.
      const deadIds = tombstones.map(t => t.id);
      const { error: delError } = await sb.from('books').delete()
        .eq('user_id', cloudUser.id).in('book_id', deadIds);
      if (delError) throw delError;
    }
    cloudLastSync = Date.now();
    AppLog.info('sync', 'push ok: ' + rows.length + ' books, ' + tombstones.length + ' tombstones');
    return true;
  } catch (e) {
    AppLog.error('sync', 'push failed: ' + ((e && e.message) || e));
    toast(cloudErrMsg(e));
    return false;
  } finally {
    cloudSyncing = false;
    syncEnd(false); // v144
    refreshAccountUI();
  }
}

async function cloudPullTombstones() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return [];
  // v142: also pull deleted_at so the tombstone floor can tell stale
  // deletions (older than the user's explicit un-delete) from fresh ones.
  // v147: scope to this user (v101 parity with cloudPullRows).
  const { data, error } = await sb.from('deleted_books').select('book_id, deleted_at').eq('user_id', cloudUser.id);
  if (error) throw error;
  return (data || [])
    .map(r => ({ id: r.book_id, at: r.deleted_at ? Date.parse(r.deleted_at) || 0 : 0 }))
    .filter(r => r.id);
}

// v141: explicit un-delete — used by "Download into this library". Clears
// tombstones (local + cloud) for these ids so the merge can't skip them,
// then merges the rows in.
// v142: verifies the cloud delete actually landed (a blocked delete must not
// silently resurrect the wipe loop) and stamps the tombstone floor, so even
// stale rows that come back — re-pushed by another device or never deleted —
// are ignored on this device. Returns { added, blocked }.
async function resurrectCloudBooks(rows) {
  const ids = (rows || []).map(r => r && r.book_id).filter(Boolean);
  ids.forEach(id => untombstone(id));
  let blocked = 0;
  try {
    await cloudDeleteTombstones(ids);
    const still = await cloudPullTombstones();
    const stillIds = new Set(still.map(r => r.id));
    blocked = ids.filter(id => stillIds.has(id)).length;
  } catch (e) { /* verify failed; the floor below still protects this device */ }
  tombstoneFloor = Date.now();
  saveTombFloor();
  const before = library.length;
  if (mergeCloudBooks(library, rows)) { saveLibrary(); render(); }
  return { added: library.length - before, blocked: blocked };
}

// v141: rescind deletions — drop tombstone rows so no device re-applies them.
async function cloudDeleteTombstones(ids) {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser || !ids.length) return;
  const { error } = await sb.from('deleted_books').delete().eq('user_id', cloudUser.id).in('book_id', ids);
  if (error) toast(cloudErrMsg(error));
}

// Apply remote tombstones: drop matching local books and record the
// tombstones locally so this device never re-pushes them.
function applyTombstones(rows) {
  if (!rows || !rows.length) return false;
  // v142: ignore stale deletions older than the tombstone floor (set by an
  // explicit "Download into this library" un-delete). Fresh deletions still
  // propagate normally. Accepts plain id strings for backward compatibility.
  const ids = rows
    .map(r => (typeof r === 'string' ? { id: r, at: 0 } : r))
    .filter(r => r && r.id && (r.at || 0) >= tombstoneFloor)
    .map(r => r.id);
  if (!ids.length) return false;
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
  AppLog.info('sync', 'push scheduled (2.5s debounce)');
  cloudTimer = setTimeout(() => { cloudPushNow(); }, 2500);
}
async function cloudPullRows() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return [];
  // v101: always scope to our own rows. The unfiltered select was safe while
  // RLS only exposed your own books, but v96's friend-readable policies meant
  // a sync after adding a friend merged their shared books into your library
  // (and pushed them back as your own rows).
  const { data, error } = await sb.from('books').select('book_id,isbn,data').eq('user_id', cloudUser.id);
  if (error) throw error;
  return data || [];
}
async function cloudFirstSync(opts) {
  // After sign-in (or on boot with a session): pull tombstones, apply them,
  // then pull books, merge, and push. Tombstones go first so a deletion that
  // happened on another device can't be undone by this device's push.
  // v144: quiet by default — background syncs surface through the sync dot,
  // not a toast. Pass { announce: true } for user-tapped syncs.
  if (!cloudUser) return { changed: false };
  const announce = !!(opts && opts.announce);
  let changed = false;
  syncBegin();
  try {
    await syncCloudProfile();
    if (applyTombstones(await cloudPullTombstones())) { render(); changed = true; }
    const remote = await cloudPullRows();
    if (mergeCloudBooks(library, remote)) { saveLibrary({ noCloud: true }); render(); changed = true; }
    await cloudPushNow();
    await repairFriendPollution();
    if (announce) toast(changed ? '☁️ Library updated' : '☁️ Already up to date');
    AppLog.info('sync', 'first sync done' + (changed ? ' (library changed)' : ''));
  } catch (e) {
    AppLog.error('sync', 'first sync failed: ' + ((e && e.message) || e));
    toast(cloudErrMsg(e));
  }
  syncEnd(changed);
  return { changed };
}

/* ---------------- quiet-sync activity dot (v144) ---------------- */
// One passive indicator for every kind of cloud activity (push, pull,
// realtime). Nested syncs share a counter so an outer sync's "done" state
// isn't clobbered by an inner push finishing first.
let syncActive = 0, syncDotTimer = null;
function syncBegin() { syncActive++; setSyncDot('syncing'); }
function syncEnd(changed) {
  syncActive = Math.max(0, syncActive - 1);
  if (!syncActive) setSyncDot(changed ? 'done' : 'idle');
}
function setSyncDot(state) {
  const d = document.getElementById('sync-dot');
  if (syncDotTimer) { clearTimeout(syncDotTimer); syncDotTimer = null; }
  if (!d) return;
  d.classList.toggle('on', state === 'syncing');
  d.classList.toggle('done', state === 'done');
  if (state === 'done') syncDotTimer = setTimeout(() => setSyncDot('idle'), 2500);
}

/* ---------------- realtime sync (v143) ---------------- */
// Devices subscribe to each other's book + tombstone changes, so a deletion
// (or add/edit) on one device lands on the others within seconds instead of
// waiting for the next boot or a manual Sync. Requires the tables to be in
// the supabase_realtime publication — see supabase/realtime.sql (one-time).
// Event payloads are ignored on purpose: the handler re-runs the same
// pull/merge path as a boot sync (debounced), so semantics never drift.
let rtChannel = null, rtTimer = null, rtStatus = 'off'; // off|connecting|live|error
let rtErrToastShown = false;
const RT_DEBOUNCE_MS = 1500;

async function cloudRealtimeStart() {
  await cloudRealtimeStop();
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser || typeof sb.channel !== 'function') return;
  rtStatus = 'connecting'; refreshAccountUI();
  try {
    const ch = sb.channel('libram-' + cloudUser.id);
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'books', filter: 'user_id=eq.' + cloudUser.id },
      () => scheduleRealtimePull());
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'deleted_books', filter: 'user_id=eq.' + cloudUser.id },
      () => scheduleRealtimePull());
    rtChannel = ch;
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { rtStatus = 'live'; }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        rtStatus = 'error';
        if (!rtErrToastShown) {
          rtErrToastShown = true;
          toast('Realtime sync unavailable — sync still works when the app opens. See supabase/realtime.sql');
        }
      }
      refreshAccountUI();
    });
  } catch (e) { rtChannel = null; rtStatus = 'error'; refreshAccountUI(); }
}

async function cloudRealtimeStop() {
  if (rtTimer) { clearTimeout(rtTimer); rtTimer = null; }
  rtStatus = 'off'; rtErrToastShown = false;
  if (rtChannel) {
    const ch = rtChannel; rtChannel = null;
    try {
      const sb = await cloudClient().catch(() => null);
      if (sb && typeof sb.removeChannel === 'function') await sb.removeChannel(ch);
    } catch (e) { /* already gone */ }
  }
  refreshAccountUI();
}

function scheduleRealtimePull() {
  if (!cloudUser || rtTimer) return; // batch rapid events into one pull
  rtTimer = setTimeout(() => { rtTimer = null; cloudRealtimePull(); }, RT_DEBOUNCE_MS);
}

async function cloudRealtimePull() {
  // Same order as cloudFirstSync: tombstones first, then books. Deliberately
  // never pushes — the cloud already holds whatever triggered this event, so
  // pushing here would echo our own writes back at us in a loop.
  if (!cloudUser) return;
  syncBegin(); // v144
  try {
    let changed = applyTombstones(await cloudPullTombstones());
    if (mergeCloudBooks(library, await cloudPullRows())) { saveLibrary({ noCloud: true }); changed = true; }
    if (changed) render();
    cloudLastSync = Date.now();
    refreshAccountUI();
    syncEnd(changed);
  } catch (e) { syncEnd(false); /* transient — the next event or boot retries */ }
}
// v101: one-time repair for libraries polluted by the pre-fix unfiltered
// pull (v96–v100). Once RLS let friends read each other's books, a sync after
// adding a friend merged their shared books into your local library and then
// pushed them back as your own rows. A polluted book is identifiable by its id:
// it's identical to a book id in a friend's shared library, and genuine copies
// (the + TBR button, manual adds) always get fresh ids via uid().
async function repairFriendPollution() {
  const FLAG = 'spicyshelves.depollute.v1';
  try { if (localStorage.getItem(FLAG) === '1') return; } catch (e) { return; }
  const done = () => { try { localStorage.setItem(FLAG, '1'); } catch (e) {} };
  if (!cloudUser || typeof circleLists !== 'function' || typeof circleFriendBooks !== 'function') { done(); return; }
  let friends = [];
  try { friends = ((await circleLists()).friends) || []; } catch (e) { done(); return; }
  if (!friends.length) { done(); return; }
  const friendIds = new Set();
  for (const f of friends) {
    try { (await circleFriendBooks(f.id)).forEach(b => { if (b && b.id) friendIds.add(b.id); }); }
    catch (e) { /* one friend's shelves failing shouldn't block the repair */ }
  }
  const polluted = (typeof library !== 'undefined' ? library : []).filter(b => b && friendIds.has(b.id));
  if (polluted.length) {
    polluted.forEach(b => { try { removeBook(b.id); } catch (e) {} });
    render();
    toast('🧹 Removed ' + polluted.length + ' friend ' + (polluted.length === 1 ? 'book' : 'books') +
      ' that had leaked into your library');
  }
  done();
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
  // v118: remember the signup so the next enterApp can log account_created
  // (analytics needs a user id, which may not exist until email confirmation).
  try { localStorage.setItem('spicyshelves.analytics.pending_signup', '1'); } catch (e) {}
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
  /* v167: answer the pending-push question in the log — if a debounced
     push was scheduled but never ran, the next "push skipped: not signed
     in" entry explains where the change went. */
  AppLog.info('sync', 'sign-out requested' + (cloudSyncing ? ' (a sync was in flight)' : ''));
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
    if (last) {
      const base = cloudSyncing ? 'Syncing…' :
        (cloudLastSync ? 'Last synced ' + new Date(cloudLastSync).toLocaleString() : 'Not synced yet');
      const rt = rtStatus === 'live' ? ' · Realtime on' : // v143
        rtStatus === 'connecting' ? ' · Realtime connecting…' :
        rtStatus === 'error' ? ' · Realtime unavailable' : '';
      last.textContent = base + rt;
    }
  } else {
    st.textContent = 'Not signed in.';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
  }
}

