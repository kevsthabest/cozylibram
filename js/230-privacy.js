'use strict';

/* ---------------- age band + content shield (v524) ----------------
   Circle permissions Phase 2 (the User's design, approved 2026-10-13):
   the app is 13+ going forward, and Circles get an age-aware shield.

   Two private per-user facts live here:

   - The age BAND: 'teen' (13–17) or 'adult' (18+), self-declared at
     signup or set later in Settings → Account. A band is a DEFAULTS mechanism,
     not identity verification — it only sets where the sharing and
     shield toggles START. It is never displayed anywhere: no badge,
     no profile field, no circle surface. Storage is the privacy
     section of user_state (own-rows-only RLS), mirrored from the
     on-device key below — NEVER the profiles table, whose rows a
     circle friend can project fields from.

   - The content SHIELD: when on for the VIEWER, shared/social surfaces
     (circle shelves, Discover, recommendations, circle stats) blur
     high-spice covers, hide spice indicators, and keep adult titles
     out of "You'd love this" and circle stats. The shield NEVER
     touches the viewer's own library, book metadata, author
     pages/bios, or avatar sets — it filters what other people's
     shelves push at the viewer, nothing else.

   Runtime source is the local key (the warning-prefs pattern);
   js/229-user-state.js mirrors it into user_state.privacy_state so it
   follows the account across devices. */
const PRIVACY_KEY = 'cozylibram.privacy.v1';

/* High-spice threshold: the app's own spice axis words (js/020) name
   level 4 "Explicit" and level 5 "Filthy" — 4+ is where the scale
   itself stops describing mainstream romance (level 3 is "Steamy").
   The shield anchors to the top two rungs of the app's existing
   scale rather than inventing a second one. */
const SHIELD_SPICE_MIN = 4;

function privacyState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(PRIVACY_KEY) || 'null'); } catch (e) {}
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  return {
    band: (s.band === 'teen' || s.band === 'adult') ? s.band : null,
    shield: s.shield === true,
    teenDefaultsApplied: s.teenDefaultsApplied === true,
    bandSetAt: Number(s.bandSetAt) || 0,
  };
}
function privacySave(state) {
  try { localStorage.setItem(PRIVACY_KEY, JSON.stringify(state)); } catch (e) {}
  // Roam it (hash-gated inside userStatePush; a no-op signed out).
  try { if (typeof userStatePush === 'function') userStatePush(); } catch (e) {}
}

function shieldOn() { return privacyState().shield === true; }
function setShield(on) {
  const s = privacyState();
  s.shield = !!on;
  privacySave(s);
  return s;
}

/* ---------------- the band ----------------
   IDEMPOTENCE RULE (the load-bearing detail of this phase): teen
   starting positions are applied EXACTLY ONCE — the first time the
   band becomes 'teen' — and only the parts that haven't landed yet are
   retried:
   - the shield flips on locally the moment teen is first declared
     (device-local, works signed out, never undone by later saves);
   - the three profiles toggles (share_library / share_bio /
     share_activity all off) are written by applyPendingTeenDefaults,
     which runs on declaration and again at every sign-in until it
     succeeds. teenDefaultsApplied is set ONLY after that write lands,
     so an offline declaration retries instead of being forgotten —
     and once it has landed, NOTHING ever re-applies it: re-saving
     Profile, re-declaring teen, or flipping adult→teen later leaves
     every toggle exactly where the user put it.
   Declaring 'adult' never writes any toggle, in either direction. */
async function setAgeBand(band) {
  if (band !== 'teen' && band !== 'adult') return privacyState();
  const s = privacyState();
  const firstTeen = band === 'teen' && !s.teenDefaultsApplied;
  s.band = band;
  s.bandSetAt = Date.now();
  if (firstTeen) s.shield = true;
  privacySave(s);
  if (band === 'teen') { try { await applyPendingTeenDefaults(); } catch (e) {} }
  return privacyState();
}

// The profiles half of the teen starting positions. Safe to call any
// time: a no-op unless the band is teen and the write hasn't landed.
async function applyPendingTeenDefaults() {
  const s = privacyState();
  if (s.band !== 'teen' || s.teenDefaultsApplied) return false;
  if (typeof cloudUser === 'undefined' || !cloudUser) return false; // signed out: stays pending
  if (typeof circlePrivacy !== 'function' || typeof circleSavePrivacy !== 'function') return false;
  try {
    const priv = await circlePrivacy();
    // Per-shelf hiding is preserved (priv.hidden) — only the three
    // sharing toggles take their teen starting positions.
    await circleSavePrivacy(false, priv.hidden || [], false, false);
  } catch (e) { return false; } // offline / pre-migration: flag stays unset, retried at next sign-in
  const s2 = privacyState(); // re-read: a toggle may have changed meanwhile
  s2.teenDefaultsApplied = true;
  privacySave(s2);
  return true;
}

/* Signup adoption (enterApp hook): the band chosen on the Create
   account form travels in Supabase user_metadata (like first/last
   name). Adopt it ONLY when this account has never recorded a band —
   metadata is a one-time seed, so a band the user later changed in
   Profile is never stomped by the stale signup value. When the band
   was already declared on this device at signup, this is a no-op and
   applyPendingTeenDefaults (called alongside) does any retry. */
async function adoptSignupBand(user) {
  const md = (user && user.user_metadata) || {};
  const b = md.age_band;
  if (b !== 'teen' && b !== 'adult') return false;
  const s = privacyState();
  if (s.band || s.bandSetAt) return false;
  await setAgeBand(b);
  return true;
}

/* ---------------- shield spice resolution ----------------
   Effective spice for one book, for shield purposes:
   1. the book record's own spice rating (book.ratings.spice) — the
      signal that travels with a friend's shared book row;
   2. else the work-level baseline (works.spice_manual when set, else
      spice_detected — the v313 precedence) from a bulk map built by
      WorkStore.spiceMapFor;
   3. else null — UNKNOWN. Unknown is treated as NOT high-spice
      (visible, unblurred, included): spice coverage in this app is
      opt-in metadata, most books have none, and failing closed would
      blank most of a friend's shelves and teach users to switch the
      shield off. The shield claims only what the data supports. */
function shieldWorkKey(book) {
  try {
    if (typeof workKeysFor === 'function') {
      const k = workKeysFor(book);
      if (k) return k.titleNorm + '|' + k.authorNorm;
    }
  } catch (e) {}
  return '';
}
function shieldSpiceOf(book, map) {
  const own = Number(((book && book.ratings) || {}).spice) || 0;
  if (own > 0) return own;
  if (map) {
    const k = shieldWorkKey(book);
    if (k && map[k] != null) return map[k];
  }
  return null;
}
function shieldIsHighSpice(book, map) {
  const v = shieldSpiceOf(book, map);
  return v != null && v >= SHIELD_SPICE_MIN;
}
async function shieldSpiceMapFor(books) {
  if (typeof WorkStore === 'undefined' || !WorkStore || typeof WorkStore.spiceMapFor !== 'function') return {};
  try { return (await WorkStore.spiceMapFor(books || [])) || {}; } catch (e) { return {}; }
}

/* Display copy for shared surfaces: with the shield on, the spice
   axis badge is stripped (spice indicators hidden) — every other
   field renders as-is. Returns the book itself when the shield is
   off, so unshielded rendering is byte-identical to before v524. */
function shieldCardBook(b) {
  if (!b || !shieldOn()) return b;
  if (!Array.isArray(b.axes) || b.axes.indexOf('spice') === -1) return b;
  const copy = Object.assign({}, b);
  copy.axes = b.axes.filter(k => k !== 'spice');
  return copy;
}
