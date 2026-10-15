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
// v494 (#129): canonical JSON for conflict tiebreaks — object keys sorted
// recursively, so two devices holding the same record content produce the
// same string regardless of key insertion order.
function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
// Assign the newer remote record into the local book during a cloud merge.
// v495 (#125): unmark the book afterwards. The proxy set-traps fire on every
// assigned value, but a merge must not dirty the book: the content already
// lives in the cloud, and dirtying here would bump _mtime and re-push on
// every cross-device merge — an _mtime ping-pong that never converges. The
// newer _mtime rides along with the assign so both sides agree on the winner.
// (New books take the push path in mergeCloudBooks, which marks them dirty
// explicitly — they're new to this device and must persist.)
function mergeAssign(lb, rd) {
  Object.assign(lb, rd);
  unmarkDirty(lb);
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
    if (!lb) { local.push(rd); markDirty(rd); byId.set(r.book_id, rd); changed = true; }
    else if ((rd._mtime || 0) > (lb._mtime || 0)) { mergeAssign(lb, rd); changed = true; }
    else if ((rd._mtime || 0) === (lb._mtime || 0) && (rd._mtime || 0) > 0) {
      // v494 (#129): same-ms tie — stampMtimes stamps a whole save with one Date.now(),
      // so cross-device ties are real. Strictly-greater silently dropped the
      // remote version. Break the tie deterministically: both devices
      // canonicalize the same two records, so the lexicographic pick is
      // identical on both sides and the conflict converges instead of
      // flapping. The pick is arbitrary, not meaningful — determinism is the
      // point. Identical records keep the local copy (no-op).
      if (stableJson(rd) > stableJson(lb)) { mergeAssign(lb, rd); changed = true; }
    }
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

/* v495 (#128): differential push support.
   pushHighWater is the max _mtime successfully pushed; only books newer than
   it are upserted. Stored per slot (IDB kv) or per user (localStorage
   fallback) — it's sync state, partitioned exactly like the library. */
function pushHighWaterKey() {
  return localUid ? 'spicyshelves.pushhighwater.v2.' + localUid : 'spicyshelves.pushhighwater.v1';
}
async function readPushHighWater() {
  try {
    if (!idbDisabled && currentDb) return Number(await idbKvGet(currentDb, 'pushHighWater')) || 0;
    return Number(localStorage.getItem(pushHighWaterKey())) || 0;
  } catch (e) { return 0; }
}
async function writePushHighWater(v) {
  try {
    if (!idbDisabled && currentDb) await idbKvPut(currentDb, 'pushHighWater', v);
    else { try { localStorage.setItem(pushHighWaterKey(), String(v)); } catch (_) {} }
  } catch (e) {}
}
// Pure selection for the differential push (unit-tested): the books changed
// since the last successful push, plus the ceiling to advance the high-water
// mark to. Bootstrap (since === 0): push everything, exactly like before.
// Untracked books are always included (fail-safe — see #125).
function selectPushBatch(books, since) {
  const batch = since > 0
    ? books.filter(b => b && ((b._mtime || 0) > since || !proxyRootOf.has(b)))
    : books.slice();
  const sendCeil = batch.reduce((m, b) => Math.max(m, (b && b._mtime) || 0), since);
  return { batch: batch, sendCeil: sendCeil };
}
// Pure tombstone pruning (unit-tested): deletions older than 90 days have
// propagated to every device by now, so drop them instead of upserting and
// .in()-deleting an ever-growing list. Trade-off, documented: a device
// offline >90 days could resurrect a book by pushing its stale copy; the next
// delete re-propagates normally. Call only after a successful push.
function pruneTombstones(rows, nowMs) {
  const PRUNE_AFTER_MS = 90 * 864e5;
  return (rows || []).filter(t => (nowMs - ((t && t.at) || 0)) < PRUNE_AFTER_MS);
}

async function cloudPushNow() {
  const sb = await cloudClient().catch(() => null);
  /* v167: log every outcome. A silently dropped push is exactly what the
     Observatory log viewer exists to catch. */
  if (!sb || !cloudUser) { AppLog.warn('sync', 'push skipped: not signed in'); return false; }
  // v162: a push that lands while another sync is in flight used to be
  // silently dropped — reschedule it so the change still goes up.
  if (cloudSyncing) { AppLog.warn('sync', 'push deferred: sync in flight, rescheduled'); scheduleCloudPush(); return false; }
  cloudSyncing = true;
  syncBegin(); // v144: the dot covers push activity too
  // v494 (#126): the whole push races one abort budget. A hung upsert used
  // to leave cloudSyncing true forever — every later save hit the "in
  // flight" guard and re-armed the 2.5s timer, an infinite futile retry
  // loop. The abort guarantees the awaits settle, so the finally below
  // always runs and cloudSyncing resets. The vendored supabase client
  // supports .abortSignal(); the guard keeps test fakes (plain promises)
  // working.
  const abort = new AbortController();
  const abortTimer = setTimeout(() => { try { abort.abort(); } catch (e) {} }, NET_TIMEOUT_MS);
  const abortable = (q) => (q && typeof q.abortSignal === 'function') ? q.abortSignal(abort.signal) : q;
  try {
    // v495 (#128): pin the slot for this push. If the user switches slots
    // mid-push, the high-water write is skipped (next push re-pushes —
    // redundant but convergent) instead of recording one slot's ceiling
    // against another slot's library, which could skip books.
    const pushDb = currentDb;
    const since = await readPushHighWater();
    // v495 (#128): differential push — upsert only books changed since the
    // last successful push. Bootstrap (no high-water yet) pushes everything,
    // exactly like before. Tombstones always go up whole (they're tiny) and
    // are pruned below once the push succeeds.
    const pushSel = selectPushBatch(library, since);
    const rows = pushSel.batch.map(b => bookToRow(b, cloudUser.id));
    // sendCeil bounds the high-water advance: it covers every _mtime in the
    // batch, so a book edited DURING the upsert (stamped after batch
    // selection) lands strictly above it and is caught by the re-scan below
    // instead of being skipped. A same-ms edit is narrower than the #129
    // tiebreak window and self-heals on the next change.
    const sendCeil = pushSel.sendCeil;
    if (rows.length) {
      const { error } = await abortable(sb.from('books').upsert(rows, { onConflict: 'user_id,book_id' }));
      if (error) throw error;
    }
    if (tombstones.length) {
      const trows = tombstones.map(t => ({ user_id: cloudUser.id, book_id: t.id,
        deleted_at: new Date(t.at).toISOString() }));
      const { error } = await abortable(sb.from('deleted_books').upsert(trows, { onConflict: 'user_id,book_id' }));
      if (error) throw error;
      // v147: a tombstoned book is gone for good — drop its row from the cloud
      // library too, so no pull/merge on any device can ever resurrect it.
      // Only an explicit manual re-add (which untombstones the id) brings it back.
      const deadIds = tombstones.map(t => t.id);
      const { error: delError } = await abortable(sb.from('books').delete()
        .eq('user_id', cloudUser.id).in('book_id', deadIds));
      if (delError) throw delError;
    }
    const pruned = pruneTombstones(tombstones, Date.now());
    if (pruned.length !== tombstones.length) { tombstones = pruned; saveTombstones(); }
    if (currentDb === pushDb) await writePushHighWater(sendCeil);
    cloudLastSync = Date.now();
    AppLog.info('sync', 'push ok: ' + rows.length + ' books (' + library.length + ' total), ' + tombstones.length + ' tombstones');
    // v495 (#128): convergence — re-scan after advancing the high-water mark;
    // anything edited mid-push is now strictly above it and gets its own round
    // instead of waiting for the next user save.
    if (library.some(b => b && (b._mtime || 0) > sendCeil)) scheduleCloudPush();
    // v518: roaming settings ride the same push cycle (hash-gated inside
    // js/229-user-state.js, so an unchanged snapshot costs no request).
    // Runs after the books push, so the sign-in pull above has already had
    // its chance to adopt or baseline the local snapshot.
    try { if (typeof userStatePush === 'function') await userStatePush(); } catch (e) {}
    return true;
  } catch (e) {
    AppLog.error('sync', 'push failed: ' + ((e && e.message) || e));
    toast(cloudErrMsg(e));
    return false;
  } finally {
    clearTimeout(abortTimer);
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
    // v518: adopt roaming settings BEFORE any push in this sync — the
    // seeding rule from js/229-user-state.js. A fresh device's defaults
    // must never overwrite the account's synced theme.
    try { if (typeof userStatePull === 'function') await userStatePull(); } catch (e) {}
    if (applyTombstones(await cloudPullTombstones())) { render(); changed = true; }
    const remote = await cloudPullRows();
    if (mergeCloudBooks(library, remote)) { saveLibrary({ noCloud: true }); render(); changed = true; }
    await cloudPushNow();
    // v474: merge milestone achievements across devices (fire-and-forget —
    // the milestone pull never blocks the library sync).
    try { if (typeof syncMilestonesFromCloud === 'function') syncMilestonesFromCloud().catch(function () {}); } catch (e) {}
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
// The v101 depollute repair (repairFriendPollution) was retired by decision
// on 2026-10-15. It removed any local book whose id also appeared in a
// friend's visible library, tombstoning it — which deleted the cloud row
// and propagated the loss to every device. An id collision cannot
// distinguish a genuine pre-fix leak from the same record legitimately
// present in two friended accounts (seeded fixtures, shared backup
// imports); production lost real books to exactly that false positive.
// The leak era it cleaned up (v96–v100) is long past. The
// 'spicyshelves.depollute.v1' localStorage flag is deliberately left in
// place on devices that hold it — orphaned and unread, it is harmless.
async function cloudWipe() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  const { error } = await sb.from('books').delete().eq('user_id', cloudUser.id);
  if (error) toast('Cloud wipe failed: ' + error.message);
}

async function cloudSignUp(email, password, firstName, lastName, ageBand, handle) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Cloud sync is not configured — add it to server-config.json on your home PC'); return; }
  const meta = {};
  if (firstName) meta.first_name = firstName;
  if (lastName) meta.last_name = lastName;
  // v524: the self-declared age band rides user_metadata like the
  // names; enterApp adopts it into user_state exactly once (the band
  // itself never lives in profiles — see js/230-privacy.js).
  if (ageBand === 'teen' || ageBand === 'adult') meta.age_band = ageBand;
  // v551: the required signup handle rides along the same way. It is
  // NOT claimed here — claim_handle needs an authenticated session
  // and a profiles row — enterApp claims it on the first sign-in
  // (claimSignupHandle, js/237). Callers without a handle (the
  // Settings create-account shortcut) simply omit it.
  if (handle) meta.handle = handle;
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
  /* v167: log the sign-out. With the v162 flush below, a pending debounced
     push is sent before sign-out instead of being silently dropped. */
  AppLog.info('sync', 'sign-out requested' + (cloudSyncing ? ' (a sync was in flight)' : ''));
  // v162: flush any pending debounced push before signing out. A change made
  // within ~2.5s of sign-out used to be silently dropped: the timer later
  // fired with cloudUser == null and did nothing, so the cloud kept the old
  // version (and clearing site data made the loss permanent).
  clearTimeout(cloudTimer);
  if (sb && cloudUser) await cloudPushNow();
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
  // v350: own the gate decision — boot() shows a neutral splash (Advisor triage)
  if (!cloudConfigured()) { try { renderGate(); } catch (e) {} return; }
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
    else if (!cloudUser) { try { renderGate(); } catch (e) {} }
    refreshAccountUI();
  } catch (e) {
    /* v351: never strand the user on the loading splash (Advisor) */
    try { if (!cloudUser) renderGate(); } catch (_) {}
  }
}

function refreshAccountUI() {
  const st = document.getElementById('ac-status');
  if (!st) return; // settings not open
  const inEl = document.getElementById('ac-signedin');
  const outEl = document.getElementById('ac-signedout');
  // S4 (settings review): account card vs login form; subsection header follows state.
  const subhead = document.getElementById('ac-subhead');
  const cardEmail = document.getElementById('ac-card-email');
  if (!cloudConfigured()) {
    st.textContent = 'Cloud sync is off — add supabase_url and supabase_anon_key to server-config.json on your home PC.';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
    if (subhead) subhead.textContent = 'Login';
    return;
  }
  if (cloudUser) {
    st.innerHTML = icon('cloud') + ' Signed in as ' + esc(cloudUser.email);
    if (inEl) inEl.style.display = '';
    if (outEl) outEl.style.display = 'none';
    if (subhead) subhead.textContent = 'Account';
    if (cardEmail) cardEmail.textContent = cloudUser.email;
    const last = document.getElementById('ac-last');
    if (last) {
      // v476: realtime status removed from user-facing text — it's an
      // implementation detail; the "Last synced" timestamp says enough.
      const base = cloudSyncing ? 'Syncing…' :
        (cloudLastSync ? 'Last synced ' + new Date(cloudLastSync).toLocaleString() : 'Not synced yet');
      last.textContent = base;
    }
  } else {
    st.textContent = 'Not signed in.';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
    if (subhead) subhead.textContent = 'Login';
  }
}

