'use strict';

/* ---------------- first-party analytics (v118) ----------------
   "We measure how Cozy Libram is used, not what is inside someone's library."

   track(eventName, props) records a high-level product event. Privacy is
   enforced structurally, not by convention:

   - EVENT_DEFS is an allowlist: unknown event names are dropped silently.
   - Each event declares its allowed property keys; anything else is stripped.
   - Enum-valued props (source, axis, from, to) are validated against
     PROP_VALUES; unknown values are dropped.
   - Book titles, authors, ISBNs, ratings, notes, shelf contents can never
     pass through — there is simply no property key for them.

   Delivery: events batch in memory (flush every 15s or 50 events), persist
   to localStorage while offline, and upload via Supabase when connectivity
   returns. Everything is wrapped so analytics can never break the app.
   Only signed-in users emit events (no anonymous attribution); the
   Settings → Privacy toggle opts out entirely. */

const EVENT_DEFS = {
  // library
  book_added:           { c: 'library',   p: ['source'] },
  book_removed:         { c: 'library',   p: [] },
  book_opened:          { c: 'library',   p: [] },
  book_edited:          { c: 'library',   p: [] },
  book_status_changed:  { c: 'library',   p: ['from', 'to'] },
  book_rated:           { c: 'library',   p: [] },
  book_favorited:       { c: 'library',   p: [] },
  book_unfavorited:     { c: 'library',   p: [] },
  book_completed:       { c: 'library',   p: [] },
  book_dnf:             { c: 'library',   p: [] },
  dnf_reason:           { c: 'library',   p: ['reason', 'progress_pct'] }, // v398: DNF Autopsy
  dna_shared:           { c: 'library',   p: ['books'] }, // v398: Reading DNA card shared
  wrapped_shared:       { c: 'library',   p: ['year', 'books'] }, // v398: Reading Wrapped shared
  // discovery
  search_performed:         { c: 'discovery', p: [] },
  provider_used:            { c: 'discovery', p: ['provider', 'context'] }, // v243: which metadata backend served data
  author_discovery_opened:  { c: 'discovery', p: [] },
  similar_books_opened:     { c: 'discovery', p: [] },
  release_discovery_opened: { c: 'discovery', p: [] },
  release_auto_check:      { c: 'discovery', p: ['book_count'] }, // v149: silent weekly sweep
  recommendation_opened:    { c: 'discovery', p: ['source'] },
  book_preview_opened:     { c: 'discovery', p: ['source', 'kind'] }, // v219: read-only preview modal
  preview_tbr:             { c: 'discovery', p: ['source'] }, // v219: +TBR from the preview
  preview_wishlist:        { c: 'discovery', p: ['source'] }, // v219: wishlist from the preview
  discover_opened:          { c: 'discovery', p: [] }, // v121: Discover landing
  roulette_opened:          { c: 'discovery', p: [] },
  roulette_spun:            { c: 'discovery', p: [] },
  roulette_book_opened:     { c: 'discovery', p: [] },
  roulette_book_started:    { c: 'discovery', p: [] },
  // import
  import_started:   { c: 'import', p: ['source'] },
  import_completed: { c: 'import', p: ['source', 'book_count'] },
  import_failed:    { c: 'import', p: ['source'] },
  // rating axes
  rating_axis_used: { c: 'rating', p: ['axis'] },
  // coven / social
  coven_opened:               { c: 'social', p: [] },
  friend_request_sent:        { c: 'social', p: [] },
  friend_request_accepted:    { c: 'social', p: [] },
  invite_link_shared:         { c: 'social', p: [] }, // v240: invite link shared via sheet/clipboard
  shared_shelf_viewed:        { c: 'social', p: [] },
  // NOTE: the spec's buddy_read_created/buddy_read_joined are intentionally
  // absent — buddy reads in this app are a computed display (shared TBRs),
  // not an actionable create/join flow, and the spec says not to invent
  // events for workflows that don't exist.
  friend_recommendation_used: { c: 'social', p: [] },
  // onboarding
  account_created:       { c: 'onboarding', p: [] },
  library_opened:        { c: 'onboarding', p: [] },
  first_book_added:      { c: 'onboarding', p: [] },
  first_book_rated:      { c: 'onboarding', p: [] },
  onboarding_started:    { c: 'onboarding', p: [] },
  onboarding_completed:  { c: 'onboarding', p: [] },
  onboarding_skipped:    { c: 'onboarding', p: [] },
  returned_within_7_days:{ c: 'onboarding', p: [] },
  // session (powers active-today/week/month)
  session_started: { c: 'session', p: [] },
};

// Enum allowlists for property values. book_count is numeric (validated below).
const PROP_VALUES = {
  // Addition sources reflect this app's real flows (spec §7: only track
  // sources that actually exist). 'wishlist' is not a creation flow here —
  // books reach the wishlist after being added elsewhere — so it is omitted.
  source: ['search', 'isbn', 'barcode', 'isbn_list', 'goodreads', 'storygraph',
           'hardcover', 'bookmory', 'manual', 'recommendation', 'discovery'],
  axis: ['spice', 'scare', 'suspense', 'adventure'],
  from: ['tbr', 'reading', 'read', 'dnf'],
  to:   ['tbr', 'reading', 'read', 'dnf'],
  // Preview kinds are fixed internal constants (150-modal-discovery.js:326);
  // without this entry any kind value was stored unvalidated.
  kind: ['reco', 'release', 'coven-reco', 'friend', 'external'],
  // v243: metadata providers for provider_used — which backend served
  // search/lookup data. Enum-only: no query text, ISBN, or titles.
  provider: ['gbooks', 'openlibrary', 'hardcover', 'cache', 'inventaire'],
  context: ['search', 'isbn', 'pagecount'],
};

const ANALYTICS_OPT_KEY   = 'spicyshelves.analytics'; // '0' = opted out
const ANALYTICS_FLAGS_KEY = 'spicyshelves.analytics.flags';
const ANALYTICS_SEEN_KEY  = 'spicyshelves.analytics.firstseen';
const ANALYTICS_FLUSH_MS  = 15000;
const ANALYTICS_BATCH_MAX = 50;
const ANALYTICS_QUEUE_MAX = 500;
const ANALYTICS_COOLDOWN_MS = 5 * 60 * 1000;

let analyticsQueue = null; // lazy-loaded per user; null = not loaded yet
let analyticsFlushTimer = 0;
let analyticsCooldownUntil = 0;
const analyticsDedupe = new Map();

function analyticsQueueKey() {
  // cloudUser is guaranteed non-null by track(); per-user partition keeps one
  // user's offline events from being uploaded (and RLS-rejected) as another's.
  return 'spicyshelves.analytics.queue.' + cloudUser.id;
}

function analyticsEnabled() {
  try { return localStorage.getItem(ANALYTICS_OPT_KEY) !== '0'; } catch (e) { return true; }
}

function setAnalyticsEnabled(on) {
  try { localStorage.setItem(ANALYTICS_OPT_KEY, on ? '1' : '0'); } catch (e) {}
  if (!on) {
    analyticsQueue = [];
    try { if (typeof cloudUser !== 'undefined' && cloudUser) localStorage.removeItem(analyticsQueueKey()); } catch (e) {}
  }
}

function loadAnalyticsQueue() {
  if (analyticsQueue !== null) return analyticsQueue;
  analyticsQueue = [];
  try {
    const raw = localStorage.getItem(analyticsQueueKey());
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) analyticsQueue = arr.slice(-ANALYTICS_QUEUE_MAX);
    }
  } catch (e) { analyticsQueue = []; }
  return analyticsQueue;
}

function persistAnalyticsQueue() {
  try { localStorage.setItem(analyticsQueueKey(), JSON.stringify(analyticsQueue)); } catch (e) {}
}

/* Queue one event. Returns true when queued, false when dropped. Never throws. */
function track(eventName, props, opts) {
  try {
    const def = EVENT_DEFS[eventName];
    if (!def || !analyticsEnabled()) return false;
    if (typeof cloudUser === 'undefined' || !cloudUser || !cloudUser.id) return false;
    opts = opts || {};
    if (opts.dedupeKey) {
      const now = Date.now();
      const last = analyticsDedupe.get(opts.dedupeKey) || 0;
      if (now - last < (opts.dedupeMs || 8000)) return false;
      analyticsDedupe.set(opts.dedupeKey, now);
      if (analyticsDedupe.size > 200) analyticsDedupe.clear();
    }
    const clean = {};
    (def.p || []).forEach(k => {
      if (!props || props[k] === undefined || props[k] === null) return;
      let v = props[k];
      if (k === 'book_count') {
        v = Math.max(0, Math.floor(Number(v) || 0));
        clean[k] = v;
        return;
      }
      v = String(v).slice(0, 80);
      const allowed = PROP_VALUES[k];
      if (allowed && allowed.indexOf(v) === -1) return; // unknown enum value: drop the prop
      clean[k] = v;
    });
    const q = loadAnalyticsQueue();
    q.push({
      user_id: cloudUser.id,
      event_name: eventName,
      event_category: def.c,
      properties: clean,
      app_version: (typeof APP_VERSION === 'string' && APP_VERSION) || 'unknown',
    });
    if (q.length > ANALYTICS_QUEUE_MAX) q.splice(0, q.length - ANALYTICS_QUEUE_MAX);
    persistAnalyticsQueue();
    if (q.length >= ANALYTICS_BATCH_MAX) flushAnalytics();
    else scheduleAnalyticsFlush();
    return true;
  } catch (e) { return false; }
}

/* Fire an event at most once ever (per user). Used for onboarding funnels. */
function trackOnce(flag, eventName, props) {
  try {
    if (typeof cloudUser === 'undefined' || !cloudUser || !cloudUser.id) return false;
    const key = ANALYTICS_FLAGS_KEY + '.' + cloudUser.id;
    let flags = {};
    try { flags = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { flags = {}; }
    if (flags[flag]) return false;
    if (track(eventName, props)) {
      flags[flag] = 1;
      try { localStorage.setItem(key, JSON.stringify(flags)); } catch (e) {}
      return true;
    }
    return false;
  } catch (e) { return false; }
}

/* Seed once-ever flags from existing state so long-time users don't pollute
   onboarding funnels (e.g. their next added book is not their "first"). */
function initAnalyticsFlags() {
  try {
    if (typeof cloudUser === 'undefined' || !cloudUser || !cloudUser.id) return;
    if (typeof library === 'undefined') return;
    const key = ANALYTICS_FLAGS_KEY + '.' + cloudUser.id;
    let flags = {};
    try { flags = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { flags = {}; }
    let touched = false;
    if (library.length && !flags.first_book) { flags.first_book = 1; touched = true; }
    if (library.some(b => (b.myRating || 0) > 0) && !flags.first_rated) { flags.first_rated = 1; touched = true; }
    if (touched) { try { localStorage.setItem(key, JSON.stringify(flags)); } catch (e) {} }
    // first-seen timestamp powers returned_within_7_days
    try {
      const sk = ANALYTICS_SEEN_KEY + '.' + cloudUser.id;
      if (!localStorage.getItem(sk)) localStorage.setItem(sk, String(Date.now()));
    } catch (e) {}
  } catch (e) {}
}

/* Diff a book's saved fields against their pre-save snapshot. Called from the
   detail modal's Save handler. Pure logic — no DOM, no book content leaves. */
function trackBookSaveDiff(before, after) {
  try {
    before = before || {}; after = after || {};
    if (after.status && after.status !== before.status) {
      track('book_status_changed', { from: before.status, to: after.status });
      if (after.status === 'read') track('book_completed');
      if (after.status === 'dnf') track('book_dnf');
    }
    const newRating = after.myRating || 0;
    if (newRating !== (before.myRating || 0) && newRating > 0) {
      track('book_rated');
      if (!(before.myRating > 0)) trackOnce('first_rated', 'first_book_rated');
    }
    const br = before.ratings || {}, ar = after.ratings || {};
    Object.keys(ar).forEach(k => {
      if ((ar[k] || 0) !== (br[k] || 0) && (ar[k] || 0) > 0) track('rating_axis_used', { axis: k });
    });
    const changed =
      ['title', 'notes', 'releaseDate'].some(f => String(after[f] || '') !== String(before[f] || '')) ||
      (after.tropes || []).join('|') !== (before.tropes || []).join('|') ||
      (after.pageCount || null) !== (before.pageCount || null);
    if (changed) track('book_edited');
  } catch (e) {}
}

/* Once per signed-in app boot: seed onboarding flags, then fire the session
   and onboarding-funnel events. Called from enterApp(). */
function analyticsSessionBoot() {
  try {
    initAnalyticsFlags();
    track('session_started');
    trackOnce('lib_open', 'library_opened');
    // account_created: cloudSignUp leaves a flag when email/password signup
    // succeeds (OAuth signups can't be distinguished — documented).
    try {
      if (localStorage.getItem('spicyshelves.analytics.pending_signup') === '1') {
        localStorage.removeItem('spicyshelves.analytics.pending_signup');
        track('account_created');
      }
    } catch (e) {}
    // returned_within_7_days: a boot well after first-seen (not the first
    // boot itself) inside the 7-day window.
    if (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.id) {
      let fs = 0;
      try { fs = Number(localStorage.getItem(ANALYTICS_SEEN_KEY + '.' + cloudUser.id) || 0); } catch (e) {}
      const age = Date.now() - fs;
      if (fs && age > 3600e3 && age <= 7 * 864e5) trackOnce('returned7', 'returned_within_7_days');
    }
  } catch (e) {}
}

function scheduleAnalyticsFlush() {
  if (analyticsFlushTimer) return;
  analyticsFlushTimer = setTimeout(() => { analyticsFlushTimer = 0; flushAnalytics(); }, ANALYTICS_FLUSH_MS);
}

async function flushAnalytics() {
  let batch = null; // retained for requeue if the upload fails
  try {
    const q = loadAnalyticsQueue();
    if (!q.length || !analyticsEnabled()) return;
    if (typeof cloudUser === 'undefined' || !cloudUser) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // stay queued
    if (Date.now() < analyticsCooldownUntil) { scheduleAnalyticsFlush(); return; }
    batch = q.splice(0, ANALYTICS_BATCH_MAX);
    persistAnalyticsQueue();
    const sb = await cloudClient().catch(() => null);
    if (!sb) throw new Error('supabase unavailable');
    const { error } = await sb.from('analytics_events').insert(batch);
    if (error) throw error;
    batch = null; // delivered
    analyticsCooldownUntil = 0;
    if (q.length) scheduleAnalyticsFlush();
  } catch (e) {
    // Failed upload (network, RLS, table missing): put the batch back at the
    // front and back off so a broken pipeline can't spin the network or drop
    // events. The app itself is never affected.
    try {
      if (batch && batch.length) {
        const q = loadAnalyticsQueue();
        for (let i = batch.length - 1; i >= 0; i--) q.unshift(batch[i]);
        if (q.length > ANALYTICS_QUEUE_MAX) q.splice(0, q.length - ANALYTICS_QUEUE_MAX);
        persistAnalyticsQueue();
      }
    } catch (e2) {}
    analyticsCooldownUntil = Date.now() + ANALYTICS_COOLDOWN_MS;
    scheduleAnalyticsFlush();
  }
}
