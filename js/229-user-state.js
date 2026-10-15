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
//
// v520 adds three sibling sections on the same row — warning prefs,
// Up Next, release state — each in its own jsonb column with its own _at
// clock and its own slice of the sync bookkeeping (see the sections block
// below). They are separate columns, NOT new settings keys: the settings
// snapshot keeps its exact v518 shape.
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
  // details sync. Only navigation transients (setgroups, covenTab) stay
  // local; shelf state is NOT a settings key — it rides its own section
  // (v521, below) so this snapshot keeps its exact v518 shape.
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
// Merge-preserving meta save (v520): settings (at/hash) and the
// per-section slices share one record — a save for one part must never
// drop another part's bookkeeping. A fresh record starts with an empty
// settings hash, which the settings paths treat as "never synced" (so
// the seeding/baseline rules still run before any settings push).
function userStatePatchMeta(uid, patch) {
  const cur = userStateMeta(uid);
  const curSections = (cur && cur.sections && typeof cur.sections === 'object' && !Array.isArray(cur.sections))
    ? cur.sections : {};
  const next = {
    at: cur ? cur.at : 0,
    hash: cur ? cur.hash : '',
    sections: Object.assign({}, curSections),
  };
  if (patch) {
    if (typeof patch.at === 'number') next.at = patch.at;
    if (typeof patch.hash === 'string') next.hash = patch.hash;
    if (patch.sections) {
      for (const k of Object.keys(patch.sections)) next.sections[k] = patch.sections[k];
    }
  }
  if (!Object.keys(next.sections).length) delete next.sections;
  userStateSaveMeta(uid, next);
  return next;
}
// One section's bookkeeping slice: { at, hash } — hash is null when the
// section was established by a pull but nothing has synced yet (the next
// push seeds it). Returns null when the section was never established.
function userStateSectionMeta(meta, key) {
  const s = (meta && meta.sections && typeof meta.sections === 'object') ? meta.sections[key] : null;
  return (s && typeof s.at === 'number' && (typeof s.hash === 'string' || s.hash === null)) ? s : null;
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

// v534: sortBy / seriesFilter are boot-time globals read once from
// localStorage (js/000-core.js, js/140-collections.js). A settings
// snapshot adopted from another device replaces those keys, but
// nothing re-read them — the adopted sort/filter only took effect
// after a full reload. Re-read them (same validation as boot) and
// re-render the live view.
function applyRoamedViewState() {
  try {
    sortBy = localStorage.getItem('spicyshelves.sortby') || 'added';
    const sf = localStorage.getItem('spicyshelves.seriesfilter');
    seriesFilter = (sf === 'started' || sf === 'completed') ? sf : 'all';
  } catch (e) {}
  try { if (typeof render === 'function') render(); } catch (e) {}
}

/* ---------------- roaming sections (v520) ---------------- */
// Three more slices of per-user state ride the same user_state row, each
// in its own column (supabase/migrations/v520_user_state_sections.sql):
//   warning   → warning_prefs  { _at, value }  — cozylibram.warningPrefs.v1, parsed JSON as-is
//   upnext    → up_next        { _at, value }  — the Up Next queue array as-is
//   release   → release_state  { _at, values } — the three release keys, settings-style
// Independent columns are the point (v518 Advisor constraint): the
// settings key list is NOT extended, full-snapshot apply stays safe per
// section, and one section's absence never touches another's data.
//
// A section is present on the server only when its payload carries a
// numeric _at > 0 — the column defaults ({} / []) mean "never synced".
// A missing/empty server section NEVER wipes local data; the seeding
// rules mirror settings exactly: first device seeds, second adopts,
// another account's on-device values are baselined instead of seeded.
//
// v521 adds a fourth section, shelf (column shelf_state), on the same
// machinery — see the shelf block below for its inventory.
//
// v524 adds a fifth section, privacy (column privacy_state): the age
// band + content shield object from js/230-privacy.js, warning-style
// { _at, value }. See the privacy block below.
//
// v536 adds a sixth section, milestone (column milestone_state): the
// pinned milestone id, warning-style { _at, value }. v537 adds a
// seventh, prefs (column prefs_state): the analytics opt-out and the
// reading-log remove-entry visibility keys, release-style
// { _at, values }. See their blocks below.
/* ---------------- roaming privacy state (v524) ---------------- */
// The fifth section: age band + content shield (js/230-privacy.js), in
// its own column (privacy_state, supabase/migrations/
// v524_user_state_privacy.sql), payload { _at, value } — value is the
// privacy object as-is, warning-style. The band lives ONLY in this
// section and its on-device key: never in profiles (circle friends
// project those rows) and never in the settings snapshot, whose key
// list stays frozen at its v518 shape (the full-snapshot apply of an
// older client must never be able to delete a band).
const PRIVACY_STATE_KEY = 'cozylibram.privacy.v1';
function userStatePrivacyNormalize(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return {
    band: (v.band === 'teen' || v.band === 'adult') ? v.band : null,
    shield: v.shield === true,
    teenDefaultsApplied: v.teenDefaultsApplied === true,
    bandSetAt: Number(v.bandSetAt) || 0,
  };
}
function userStateCollectPrivacy() {
  try {
    const raw = localStorage.getItem(PRIVACY_STATE_KEY);
    if (raw == null) return { value: null };
    return { value: userStatePrivacyNormalize(JSON.parse(raw)) };
  } catch (e) { return { value: null }; }
}
function userStateApplyPrivacy(payload) {
  try {
    const v = userStatePrivacyNormalize(payload ? payload.value : null);
    if (v) localStorage.setItem(PRIVACY_STATE_KEY, JSON.stringify(v));
    else localStorage.removeItem(PRIVACY_STATE_KEY);
  } catch (e) {}
}

/* ---------------- roaming milestone pin (v536) ---------------- */
// The sixth section: the pinned milestone (js/219), in its own column
// (milestone_state, supabase/migrations/v536_user_state_milestone.sql),
// payload { _at, value } — value is the pinned milestone id (a catalog
// key from js/219's MILESTONE_CATALOG or a dynamic id) or null,
// warning/privacy-style. Placement, per the roaming rules: the pin is
// a user preference, so it roams; it does NOT join the settings
// snapshot (that key list is frozen at its v518 shape, and a
// full-snapshot apply from an older client must never delete a pin),
// and it does NOT live in profiles (circle friends project those rows;
// user_state is own-rows-only, so the pin stays the reader's own).
const MILESTONE_PIN_STATE_KEY = 'cozylibram.milestonePin.v1';
function userStateCollectMilestonePin() {
  try {
    const v = localStorage.getItem(MILESTONE_PIN_STATE_KEY);
    return { value: (typeof v === 'string' && v) ? v : null };
  } catch (e) { return { value: null }; }
}
function userStateApplyMilestonePin(payload) {
  try {
    const v = payload ? payload.value : null;
    if (typeof v === 'string' && v && v.length <= 128) localStorage.setItem(MILESTONE_PIN_STATE_KEY, v);
    else localStorage.removeItem(MILESTONE_PIN_STATE_KEY);
  } catch (e) {}
}

/* ---------------- roaming device prefs (v537) ---------------- */
// The seventh section: two keys that lived only in per-device
// localStorage but are account preferences, not device ones — the
// analytics opt-out (spicyshelves.analytics, js/065) and the reading-
// log "Remove today's entry" visibility (spicyshelves.logremove,
// js/040 read, js/180 write). Opting out on one device left the other
// still emitting (audit finding; Decision: both roam). Own column
// (prefs_state, supabase/migrations/v537_user_state_prefs.sql),
// payload { _at, values } — release-style: values maps each key to
// its raw localStorage string, and a key absent from a newer snapshot
// is removed locally (full-snapshot semantics within the section,
// exactly like release). They are NOT settings keys: the v518 list
// stays frozen, and a full-snapshot settings apply from an older
// client must never be able to delete an opt-out.
//
// Both keys are read live from localStorage at point of use
// (analyticsEnabled() on every track/flush; the log-remove read on
// every log render), so apply writing localStorage IS the live apply
// — no restyle hook needed, same as the release pieces. And because
// the live read is local, an opt-out set on this device is honoured
// from boot, before any pull runs.
// v571: the prefs section gains a third key — cozylibram.bookdress, the
// book-dressing toggle (js/240). Same reasoning as the original pair: a
// user preference (default ON; only an explicit 'off' is ever stored)
// that must roam without joining the frozen v518 settings list. It is
// read live at every resolve (bookDressingEnabled), and the apply hook
// below re-resolves the dressing so a roamed OFF undresses this device
// the moment it lands.
const PREFS_STATE_KEYS = ['spicyshelves.analytics', 'spicyshelves.logremove', 'cozylibram.bookdress'];
function userStateCollectPrefs() {
  const values = {};
  try {
    for (const k of PREFS_STATE_KEYS) {
      const v = localStorage.getItem(k);
      if (v != null) values[k] = v;
    }
  } catch (e) {}
  return { values };
}
function userStateApplyPrefs(payload) {
  try {
    const incoming = (payload && payload.values && typeof payload.values === 'object') ? payload.values : {};
    for (const k of PREFS_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) localStorage.setItem(k, String(incoming[k]));
      else localStorage.removeItem(k);
    }
  } catch (e) {}
  // v571: a roamed dressing toggle applies live, not on next boot.
  try { if (typeof refreshBookDressing === 'function') refreshBookDressing(); } catch (e) {}
}

/* ---------------- roaming finale keepsakes (v567) ---------------- */
// The eighth section: The Finale's per-series records (js/239), in
// their own column (finale_state, supabase/migrations/
// v567_user_state_finale.sql), payload { _at, value } — value is the
// finale record map (series key -> record), warning-style. Placement,
// per the roaming rules: a keepsake is a reader detail, so it roams;
// it does NOT join the settings snapshot (that key list is frozen at
// its v518 shape) and never lives in profiles (user_state is
// own-rows-only, so friends can't read a finale). The on-device key
// is read live by js/238 at point of use, so apply writing localStorage
// IS the live apply, same as the release pieces. Normalization is
// js/239's finaleNormalize — one validator for every surface the map
// crosses; js/229 never interprets a record itself.
const FINALE_STATE_KEY = 'cozylibram.finale.v1';
function userStateCollectFinale() {
  try {
    const raw = localStorage.getItem(FINALE_STATE_KEY);
    if (raw == null) return { value: null };
    const v = JSON.parse(raw);
    return { value: (typeof finaleNormalize === 'function') ? finaleNormalize(v) : null };
  } catch (e) { return { value: null }; }
}
function userStateApplyFinale(payload) {
  try {
    const v = (typeof finaleNormalize === 'function') ? finaleNormalize(payload ? payload.value : null) : null;
    if (v && Object.keys(v).length) localStorage.setItem(FINALE_STATE_KEY, JSON.stringify(v));
    else localStorage.removeItem(FINALE_STATE_KEY);
  } catch (e) {}
}

const USER_STATE_SECTION_COLS = { warning: 'warning_prefs', upnext: 'up_next', release: 'release_state', shelf: 'shelf_state', privacy: 'privacy_state', milestone: 'milestone_state', prefs: 'prefs_state', finale: 'finale_state' };
const USER_STATE_SECTION_ORDER = ['warning', 'upnext', 'release', 'shelf', 'privacy', 'milestone', 'prefs', 'finale'];
const WARNING_PREFS_KEY = 'cozylibram.warningPrefs.v1';
const RELEASE_STATE_KEYS = [
  'spicyshelves.auto_releases', 'spicyshelves.auto_releases_seen', 'spicyshelves.dismissed_releases',
];

function userStateCollectWarning() {
  try {
    const raw = localStorage.getItem(WARNING_PREFS_KEY);
    if (raw == null) return { value: null };
    const parsed = JSON.parse(raw);
    return { value: (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null };
  } catch (e) { return { value: null }; }
}
function userStateApplyWarning(payload) {
  try {
    const v = payload ? payload.value : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) localStorage.setItem(WARNING_PREFS_KEY, JSON.stringify(v));
    else localStorage.removeItem(WARNING_PREFS_KEY);
  } catch (e) {}
}

function userStateUpNextKey() {
  try { if (typeof upNextKey === 'function') return upNextKey(); } catch (e) {}
  try { return (typeof localUid !== 'undefined' && localUid) ? 'spicyshelves.upnext.v1.' + localUid : 'spicyshelves.upnext.v1'; }
  catch (e) { return 'spicyshelves.upnext.v1'; }
}
function userStateCollectUpNext() {
  // The authoritative queue is the in-memory one: js/040-storage.js keeps
  // it per account slot, backed by IndexedDB since v202 — the localStorage
  // key (spicyshelves.upnext.v1.<uid>) is the legacy mirror, read here
  // only if the binding is somehow absent.
  try {
    if (typeof upNext !== 'undefined' && Array.isArray(upNext)) return { value: upNext.slice() };
  } catch (e) {}
  try {
    const arr = JSON.parse(localStorage.getItem(userStateUpNextKey()) || '[]');
    return { value: Array.isArray(arr) ? arr : [] };
  } catch (e) { return { value: [] }; }
}
function userStateApplyUpNext(payload) {
  const arr = (payload && Array.isArray(payload.value)) ? payload.value.slice() : [];
  try { if (typeof upNext !== 'undefined') upNext = arr.slice(); } catch (e) {}
  try { if (typeof persistUpNext === 'function') persistUpNext(); } catch (e) {}
  try { localStorage.setItem(userStateUpNextKey(), JSON.stringify(arr)); } catch (e) {}
}

function userStateCollectRelease() {
  const values = {};
  try {
    for (const k of RELEASE_STATE_KEYS) {
      const v = localStorage.getItem(k);
      if (v != null) values[k] = v;
    }
  } catch (e) {}
  return { values };
}
function userStateApplyRelease(payload) {
  try {
    const incoming = (payload && payload.values && typeof payload.values === 'object') ? payload.values : {};
    for (const k of RELEASE_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) localStorage.setItem(k, String(incoming[k]));
      else localStorage.removeItem(k);
    }
  } catch (e) {}
}

/* ---------------- roaming shelf state (v521) ---------------- */
// The fourth section: shelf state, in its own column (shelf_state,
// supabase/migrations/v521_user_state_shelf.sql), payload { _at, values }
// where values maps a fixed piece name to the raw string that piece
// lives in on-device — settings/release-style full snapshot: a piece
// absent from a newer snapshot is cleared locally. Inventory, from
// reading the code that writes and reads each piece (piece → live
// source):
//   order    — the 2D shelf doc: per-group manual order + layout +
//              format + season + 2D decorations, all one object behind
//              shelfOrder() (js/205-shelfview.js), persisted per account
//              partition to spicyshelves.shelforder.v1.<uid>. Collect
//              reads the in-memory doc (what the user actually sees);
//              apply writes back through saveShelfOrder() + the cache
//              assignment — the app's own write path, so the shelf
//              re-renders from the adopted doc on its next render.
//   deco     — cozylibram.s3d.deco.v2: 3D decorations per bookcase
//              ({ v: 2, cases: { 'group:index': [...] } }). js/215 reads
//              and writes this localStorage key directly, so
//              localStorage IS the live source (the 3D scene's placed
//              list is a closure rebuilt from it on mount / case load).
//   dressed  — cozylibram.s3d.dressed.v1: the 3D dressed-theme name.
//   arrange  — cozylibram.s3d.arrange: 3D room arrange mode (js/217).
//   spines   — cozylibram.s3d.spines: 3D spines mode (js/217).
//   viewmode — shelfViewMode: the 2D/3D shelf view mode (js/217).
// Deliberately NOT synced: cozylibram.s3d.deco.v1 (legacy format the
// v2 doc adopts once — syncing it could resurrect superseded layouts),
// spicyshelves.setgroups (navigation transient), spicyshelves.
// spinecolors (a derived cache of sampled cover colours — recomputable,
// and spine colour itself rides the book rows), spicyshelves.layout
// (the LIBRARY browse layout, not shelf state — and the settings key
// list stays frozen), book poses (stored on book records; they already
// roam with the library), and session transients (case index, decor
// undo stack, current group — never persisted at all).
const SHELF_STATE_LS_PIECES = {
  deco: 'cozylibram.s3d.deco.v2',
  dressed: 'cozylibram.s3d.dressed.v1',
  arrange: 'cozylibram.s3d.arrange',
  spines: 'cozylibram.s3d.spines',
  viewmode: 'shelfViewMode',
};

function userStateCollectShelf() {
  const values = {};
  try {
    let doc = null;
    try { if (typeof shelfOrder === 'function') doc = shelfOrder(); } catch (e) {}
    if (!doc) {
      try { if (typeof loadShelfOrder === 'function') doc = loadShelfOrder(); } catch (e) {}
    }
    // An empty doc is the pristine default — omitting the piece keeps
    // untouched devices' payloads empty (and under full-snapshot apply
    // an omitted piece still clears, which is how a deliberate reset
    // propagates).
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && Object.keys(doc).length) {
      values.order = JSON.stringify(doc);
    }
  } catch (e) {}
  try {
    for (const piece of Object.keys(SHELF_STATE_LS_PIECES)) {
      const v = localStorage.getItem(SHELF_STATE_LS_PIECES[piece]);
      if (v != null) values[piece] = v;
    }
  } catch (e) {}
  return { values };
}

function userStateApplyShelfOrder(doc) {
  let wrote = false;
  try {
    if (typeof saveShelfOrder === 'function') { saveShelfOrder(doc); wrote = true; }
  } catch (e) {}
  // The cache assignment mirrors js/205's own setters: without it the
  // running shelf would keep rendering the pre-apply doc until reload.
  try { shelfOrderCache = doc; wrote = true; } catch (e) {}
  if (!wrote) {
    try {
      if (typeof shelfOrderKey === 'function') {
        localStorage.setItem(shelfOrderKey(), JSON.stringify(doc));
      }
    } catch (e) {}
  }
}
function userStateApplyShelf(payload) {
  const incoming = (payload && payload.values && typeof payload.values === 'object') ? payload.values : {};
  try {
    if (!Object.prototype.hasOwnProperty.call(incoming, 'order')) {
      userStateApplyShelfOrder({});
    } else {
      let doc = null;
      try {
        const parsed = JSON.parse(String(incoming.order));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
      } catch (e) {}
      // A malformed order piece is ignored, never allowed to wipe a
      // good local arrangement (same type-gate spirit as warning prefs).
      if (doc) userStateApplyShelfOrder(doc);
    }
  } catch (e) {}
  try {
    for (const piece of Object.keys(SHELF_STATE_LS_PIECES)) {
      const key = SHELF_STATE_LS_PIECES[piece];
      if (!Object.prototype.hasOwnProperty.call(incoming, piece)) {
        localStorage.removeItem(key);
        continue;
      }
      const raw = String(incoming[piece]);
      if (piece === 'deco') {
        // Mirror js/215's readDecoDoc validation: only a well-formed
        // v2 doc may replace the local one.
        let valid = false;
        try {
          const d = JSON.parse(raw);
          valid = !!d && d.v === 2 && !!d.cases && typeof d.cases === 'object';
        } catch (e) {}
        if (!valid) continue;
      }
      localStorage.setItem(key, raw);
    }
  } catch (e) {}
}

const USER_STATE_SECTION_FNS = {
  warning: { collect: userStateCollectWarning, apply: userStateApplyWarning },
  upnext: { collect: userStateCollectUpNext, apply: userStateApplyUpNext },
  release: { collect: userStateCollectRelease, apply: userStateApplyRelease },
  shelf: { collect: userStateCollectShelf, apply: userStateApplyShelf },
  privacy: { collect: userStateCollectPrivacy, apply: userStateApplyPrivacy },
  milestone: { collect: userStateCollectMilestonePin, apply: userStateApplyMilestonePin },
  prefs: { collect: userStateCollectPrefs, apply: userStateApplyPrefs },
  finale: { collect: userStateCollectFinale, apply: userStateApplyFinale },
};
function userStateSectionPresent(remote) {
  return !!remote && typeof remote === 'object' && !Array.isArray(remote) && Number(remote._at) > 0;
}

// Pull the sections in one select. On a database missing any section
// column (pre-v520, or pre-v521 for shelf_state) PostgREST errors the
// whole select — caught here, so the sections simply stay device-local
// until the migration lands (fail-open, exactly like a missing table
// in v518). The settings pull uses its own select and is unaffected
// either way. deviceOwner is the owner marker captured BEFORE this
// sync's settings apply could claim ownership, so the cross-account
// baseline sees the truth.
async function userStatePullSections(deviceOwner) {
  try {
    if (typeof cloudUser === 'undefined' || !cloudUser) return false;
    const sb = await cloudClient().catch(() => null);
    if (!sb) return false;
    const uid = cloudUser.id;
    const { data, error } = await sb.from('user_state')
      .select('warning_prefs,up_next,release_state,shelf_state,privacy_state,milestone_state,prefs_state,finale_state').eq('user_id', uid).maybeSingle();
    if (error) throw error;
    const meta = userStateMeta(uid);
    let changed = false;
    for (const key of USER_STATE_SECTION_ORDER) {
      const remote = data ? data[USER_STATE_SECTION_COLS[key]] : null;
      const sm = userStateSectionMeta(meta, key);
      if (userStateSectionPresent(remote)) {
        const remoteAt = Number(remote._at);
        if (!sm || remoteAt > sm.at) {
          USER_STATE_SECTION_FNS[key].apply(remote);
          const secPatch = {};
          secPatch[key] = { at: remoteAt, hash: userStateHash(USER_STATE_SECTION_FNS[key].collect()) };
          userStatePatchMeta(uid, { sections: secPatch });
          userStateClaimOwner(uid);
          changed = true;
        }
      } else if (!sm) {
        const secPatch = {};
        if (deviceOwner && deviceOwner !== uid) {
          // The values on this device were last synced by another
          // account — baseline them (no seed push), like settings.
          secPatch[key] = { at: 0, hash: userStateHash(USER_STATE_SECTION_FNS[key].collect()) };
          AppLog.info('sync', 'roaming section ' + key + ': baselined local values from another account (no seed push)');
        } else {
          // Established but unseeded: the push that follows seeds it.
          secPatch[key] = { at: 0, hash: null };
        }
        userStatePatchMeta(uid, { sections: secPatch });
      }
    }
    if (changed) AppLog.info('sync', 'roaming sections pulled (server newer)');
    return changed;
  } catch (e) {
    try { AppLog.warn('sync', 'roaming sections pull failed: ' + ((e && e.message) || e)); } catch (_) {}
    return false;
  }
}

// Pull the account's settings snapshot. Applies it when the server copy is
// newer than what this device last synced for this account, then restyles
// via the existing applyTheme() so arriving on a new device just looks
// right — no manual step. Runs before any push at sign-in (the seeding
// rule): a fresh device's defaults must never overwrite the account's
// synced settings, and an empty server means this device may seed it on
// the following push. Returns true when local state was replaced.
async function userStatePullSettings() {
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
        userStatePatchMeta(uid, { at: remoteAt, hash: userStateHash(userStateCollect()) });
        userStateClaimOwner(uid);
        try { if (typeof applyTheme === 'function') applyTheme(); } catch (e) {}
        try { applyRoamedViewState(); } catch (e) {} // v534: live sort/filter adopt
        AppLog.info('sync', 'roaming settings pulled (server newer)');
        return true;
      }
      return false; // local is at least as new; the push cycle carries any diff
    }
    // No server row for this account. (An empty settings hash means the
    // record was created by a sections save and settings never synced —
    // the baseline rule below must still run; see userStatePatchMeta.)
    if (!meta || !meta.hash) {
      const owner = userStateOwner();
      if (owner && owner !== uid) {
        // The values on this device were last synced by another account.
        // Baseline them as this account's synced state (without pushing)
        // so a later push sends only changes made from now on.
        userStatePatchMeta(uid, { at: 0, hash: userStateHash(userStateCollect()) });
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

// The pull entry point (js/090-sync.js, sign-in sync): settings first,
// then the v520 sections. The owner marker is captured before either can
// claim ownership — the sections' cross-account baseline depends on
// seeing whose values were on the device when the sync started. Return
// value keeps its v518 meaning: true when the settings were replaced.
async function userStatePull() {
  const deviceOwner = userStateOwner();
  const applied = await userStatePullSettings();
  try { await userStatePullSections(deviceOwner); } catch (e) {}
  return applied;
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
    const sectionsReady = !!meta &&
      USER_STATE_SECTION_ORDER.every(k => userStateSectionMeta(meta, k));
    if (!meta || !meta.hash || !sectionsReady) {
      // Never push blind: establish the seeding/baseline state first so a
      // push can't beat the sign-in pull and clobber (or leak) state.
      await userStatePull();
      meta = userStateMeta(uid);
    }
    const values = userStateCollect();
    const hash = userStateHash(values);
    const settingsDirty = !(meta && meta.hash === hash);
    const sectionPayloads = {};
    const dirtySections = [];
    for (const key of USER_STATE_SECTION_ORDER) {
      const payload = USER_STATE_SECTION_FNS[key].collect();
      sectionPayloads[key] = payload;
      const sm = userStateSectionMeta(meta, key);
      if (!sm || sm.hash !== userStateHash(payload)) dirtySections.push(key);
    }
    if (!settingsDirty && !dirtySections.length) return false;
    const sb = await cloudClient().catch(() => null);
    if (!sb) return false;
    userStatePushing = true;
    const at = Date.now();
    let pushed = false;
    if (settingsDirty) {
      const { error } = await sb.from('user_state').upsert(
        { user_id: uid, settings: { _at: at, values: values }, updated_at: new Date(at).toISOString() },
        { onConflict: 'user_id' });
      if (error) throw error;
      userStatePatchMeta(uid, { at: at, hash: hash });
      userStateClaimOwner(uid);
      AppLog.info('sync', 'roaming settings pushed');
      pushed = true;
    }
    if (dirtySections.length) {
      // Separate upsert, own failure domain: on a database missing the
      // section columns (pre-v520 / pre-v521) this errors — caught here
      // so a settings push above still counts, and the section
      // bookkeeping stays un-advanced so the next cycle retries.
      try {
        const row = { user_id: uid, updated_at: new Date(at).toISOString() };
        for (const key of dirtySections) {
          row[USER_STATE_SECTION_COLS[key]] = Object.assign({ _at: at }, sectionPayloads[key]);
        }
        const { error } = await sb.from('user_state').upsert(row, { onConflict: 'user_id' });
        if (error) throw error;
        const secPatch = {};
        for (const key of dirtySections) secPatch[key] = { at: at, hash: userStateHash(sectionPayloads[key]) };
        userStatePatchMeta(uid, { sections: secPatch });
        userStateClaimOwner(uid);
        AppLog.info('sync', 'roaming sections pushed: ' + dirtySections.join(', '));
        pushed = true;
      } catch (e) {
        try { AppLog.warn('sync', 'roaming sections push failed: ' + ((e && e.message) || e)); } catch (_) {}
      }
    }
    return pushed;
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
