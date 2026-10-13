'use strict';

/* ---------------- roaming settings (v518) ---------------- */
// Themes and taste settings live in localStorage, which is per-device: the
// PC and the phone drifted apart (a different theme on each). This module
// mirrors the in-scope keys into the user's own user_state row (own-rows
// RLS — see supabase/migrations/v518_user_state.sql) so any signed-in
// device adopts them. localStorage stays the runtime source: every feature
// keeps reading and writing it exactly as before; this module only
// collects snapshots of it, applies newer snapshots, and upserts changes.
//
// Snapshot shape: { _at: <epoch ms>, values: { key: stringValue } }.
// _at is the conflict clock — a pull applies only when the server's _at is
// strictly newer than the last one this device synced for this account.
//
// Account discipline: sync bookkeeping is keyed per user id (mirroring the
// per-user localStorage partitions elsewhere), plus a device-global owner
// marker naming the account whose values this device last synced. If a
// different account signs in and has no server row yet, the values on the
// device are baselined (marked as already-synced) instead of seeded — one
// user's settings never land in another user's row. Only changes made
// after that point push.
//
// Fail-open throughout: offline or any error → AppLog, no throw, no state
// change, never a blocker for boot or sign-in.
const USER_STATE_KEYS = [
  'theme', 'accent',
  'spicyshelves.animation', 'spicyshelves.favstyle',
  'pshareStyle', 'portraitShareV1',
  'cozylibram.tagline', 'cl_hide_spoilers',
  'cozylibram.dnaSurveyOff', 'cozylibram.dnaNudgesOff',
  'spicyshelves.onboarded',
  // User's call (2026-10-13): region roams with the other preferences,
  // overriding the earlier keep-it-local reconciliation.
  'spicyshelves.storeRegion',
  // User's call (2026-10-13): sort + series filter roam too — all user
  // details sync. Only navigation transients (setgroups, covenTab) and
  // shelf-state keys stay local; shelf state gets its own section later.
  'spicyshelves.sortby', 'spicyshelves.seriesfilter',
];
// Prefix families: seasonThemeNudge:<season>, wrapped-banner-<...>.
const USER_STATE_PREFIXES = ['seasonThemeNudge:', 'wrapped-banner-'];
const USER_STATE_META_PREFIX = 'cozylibram.userstate.v1.';
const USER_STATE_OWNER_KEY = 'cozylibram.userstate.owner';
let userStatePushing = false;

function userStateInScope(key) {
  return USER_STATE_KEYS.indexOf(key) !== -1 ||
    USER_STATE_PREFIXES.some(p => key.indexOf(p) === 0);
}

// The complete in-scope snapshot of localStorage right now. Absent keys
// mean "not set on this device" — a snapshot is the whole truth, so a key
// missing from a newer snapshot is removed locally on apply (that's how
// e.g. an accent reset propagates).
function userStateCollect() {
  const values = {};
  try {
    for (const k of USER_STATE_KEYS) {
      const v = localStorage.getItem(k);
      if (v != null) values[k] = v;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && USER_STATE_PREFIXES.some(p => k.indexOf(p) === 0)) {
        const v = localStorage.getItem(k);
        if (v != null) values[k] = v;
      }
    }
  } catch (e) {}
  return values;
}

function userStateHash(values) {
  let s;
  try { s = (typeof stableJson === 'function') ? stableJson(values) : JSON.stringify(values); }
  catch (e) { s = JSON.stringify(values || {}); }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function userStateMeta(uid) {
  try {
    const raw = localStorage.getItem(USER_STATE_META_PREFIX + uid);
    const m = raw ? JSON.parse(raw) : null;
    return (m && typeof m.at === 'number' && typeof m.hash === 'string') ? m : null;
  } catch (e) { return null; }
}
function userStateSaveMeta(uid, meta) {
  try { localStorage.setItem(USER_STATE_META_PREFIX + uid, JSON.stringify(meta)); } catch (e) {}
}
function userStateOwner() {
  try { return localStorage.getItem(USER_STATE_OWNER_KEY) || null; } catch (e) { return null; }
}
function userStateClaimOwner(uid) {
  try { localStorage.setItem(USER_STATE_OWNER_KEY, uid); } catch (e) {}
}

// Replace the local in-scope keys with a server snapshot (full-snapshot
// semantics: in-scope keys absent from the snapshot are removed).
function userStateApply(values) {
  try {
    const incoming = {};
    for (const k of Object.keys(values || {})) {
      if (userStateInScope(k)) incoming[k] = String(values[k]);
    }
    for (const k of USER_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) localStorage.setItem(k, incoming[k]);
      else localStorage.removeItem(k);
    }
    const localPrefixed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && USER_STATE_PREFIXES.some(p => k.indexOf(p) === 0)) localPrefixed.push(k);
    }
    for (const k of localPrefixed) {
      if (!Object.prototype.hasOwnProperty.call(incoming, k)) localStorage.removeItem(k);
    }
    for (const k of Object.keys(incoming)) {
      if (USER_STATE_PREFIXES.some(p => k.indexOf(p) === 0)) localStorage.setItem(k, incoming[k]);
    }
  } catch (e) {}
}

// Pull the account's settings snapshot. Applies it when the server copy is
// newer than what this device last synced for this account, then restyles
// via the existing applyTheme() so arriving on a new device just looks
// right — no manual step. Runs before any push at sign-in (the seeding
// rule): a fresh device's defaults must never overwrite the account's
// synced settings, and an empty server means this device may seed it on
// the following push. Returns true when local state was replaced.
async function userStatePull() {
  try {
    if (typeof cloudUser === 'undefined' || !cloudUser) return false;
    const sb = await cloudClient().catch(() => null);
    if (!sb) return false;
    const uid = cloudUser.id;
    const { data, error } = await sb.from('user_state')
      .select('settings').eq('user_id', uid).maybeSingle();
    if (error) throw error;
    const remote = (data && data.settings && typeof data.settings === 'object') ? data.settings : null;
    const remoteValues = (remote && remote.values && typeof remote.values === 'object') ? remote.values : null;
    const meta = userStateMeta(uid);
    if (remoteValues) {
      const remoteAt = Number(remote._at) || 0;
      if (!meta || remoteAt > meta.at) {
        userStateApply(remoteValues);
        userStateSaveMeta(uid, { at: remoteAt, hash: userStateHash(userStateCollect()) });
        userStateClaimOwner(uid);
        try { if (typeof applyTheme === 'function') applyTheme(); } catch (e) {}
        AppLog.info('sync', 'roaming settings pulled (server newer)');
        return true;
      }
      return false; // local is at least as new; the push cycle carries any diff
    }
    // No server row for this account.
    if (!meta) {
      const owner = userStateOwner();
      if (owner && owner !== uid) {
        // The values on this device were last synced by another account.
        // Baseline them as this account's synced state (without pushing)
        // so a later push sends only changes made from now on.
        userStateSaveMeta(uid, { at: 0, hash: userStateHash(userStateCollect()) });
        AppLog.info('sync', 'roaming settings: baselined local values from another account (no seed push)');
      }
      // Fresh device (no owner marker) or same owner: leave unseeded —
      // the push that follows first sync seeds this account's row.
    }
    return false;
  } catch (e) {
    try { AppLog.warn('sync', 'roaming settings pull failed: ' + ((e && e.message) || e)); } catch (_) {}
    return false;
  }
}

// Push the local snapshot if it changed since the last successful sync
// for this account. Hash-gated: an unchanged snapshot costs no request.
// Rides the cloud push cycle (js/090-sync.js) and the pagehide flush.
async function userStatePush() {
  if (userStatePushing) return false;
  try {
    if (typeof cloudUser === 'undefined' || !cloudUser) return false;
    const uid = cloudUser.id;
    let meta = userStateMeta(uid);
    if (!meta) {
      // Never push blind: establish the seeding/baseline state first so a
      // push can't beat the sign-in pull and clobber (or leak) settings.
      await userStatePull();
      meta = userStateMeta(uid);
    }
    const values = userStateCollect();
    const hash = userStateHash(values);
    if (meta && meta.hash === hash) return false;
    const sb = await cloudClient().catch(() => null);
    if (!sb) return false;
    userStatePushing = true;
    const at = Date.now();
    const { error } = await sb.from('user_state').upsert(
      { user_id: uid, settings: { _at: at, values: values }, updated_at: new Date(at).toISOString() },
      { onConflict: 'user_id' });
    if (error) throw error;
    userStateSaveMeta(uid, { at: at, hash: hash });
    userStateClaimOwner(uid);
    AppLog.info('sync', 'roaming settings pushed');
    return true;
  } catch (e) {
    try { AppLog.warn('sync', 'roaming settings push failed: ' + ((e && e.message) || e)); } catch (_) {}
    return false;
  } finally {
    userStatePushing = false;
  }
}

// Last chance to carry a settings change up before the page is gone (a
// theme picked and the app closed, with no library edit in between to
// trigger a push cycle). Best-effort by nature — whatever it misses, the
// next sign-in push cycle still sends, because the hash stays dirty.
window.addEventListener('pagehide', () => {
  try { if (typeof cloudUser !== 'undefined' && cloudUser) userStatePush(); } catch (e) {}
});
