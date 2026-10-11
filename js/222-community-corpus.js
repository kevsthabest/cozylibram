/* ---- Community corpus refinement v1 (tropes, characters, trigger warnings).
   Suggestion flows with provenance, curation queue support, community votes
   (dormant surface), contribution tiers (dormant behavior).

   Principles:
   1. Users suggest from controlled vocabularies only (89-trope catalog,
      trigger taxonomy). They never mint catalog IDs.
   2. New-trope ideas go to Kevin's curation queue — never auto-added.
   3. Merge proposals require evidence and are Kevin-only in v1.
   4. Every contribution carries provenance (who, when). Kevin sees who;
      the public sees "refined by the community".
   5. Anti-gaming: rate-limited submissions, obscurity-weighted milestone
      credit, per-book-per-user caps, never reward raw submissions.
   6. v1 behavior is Kevin's queue. Tier fields exist so v2 needs no
      migration; all tier weights are 1 until the community exists.

   Store: Supabase (see supabase/migrations/v399_community_corpus_v1.sql).
   Offline: submissions queue in localStorage and flush on reconnect.
*/

(function () {
'use strict';

/* ---------- rate limiting (client-side throttle) ---------- */
var RL_KEY = 'cozylibram.cc.ratelimit.v1';
var RL_HOUR_MAX = 20, RL_DAY_MAX = 100;

function rlState() {
  try {
    var s = JSON.parse(localStorage.getItem(RL_KEY) || 'null');
    if (s && typeof s === 'object') return s;
  } catch (e) {}
  return { hourStart: 0, hourCount: 0, dayStart: 0, dayCount: 0 };
}
function rlSave(s) {
  try { localStorage.setItem(RL_KEY, JSON.stringify(s)); } catch (e) {}
}
/* Pure-ish: returns {ok, retryAfterMs}. Mutates the stored counters. */
function ccRateLimitCheck() {
  var now = Date.now();
  var s = rlState();
  var hourMs = 3600e3, dayMs = 86400e3;
  if (!s.hourStart || now - s.hourStart >= hourMs) { s.hourStart = now; s.hourCount = 0; }
  if (!s.dayStart || now - s.dayStart >= dayMs) { s.dayStart = now; s.dayCount = 0; }
  if (s.hourCount >= RL_HOUR_MAX) {
    return { ok: false, retryAfterMs: (s.hourStart + hourMs) - now, scope: 'hour' };
  }
  if (s.dayCount >= RL_DAY_MAX) {
    return { ok: false, retryAfterMs: (s.dayStart + dayMs) - now, scope: 'day' };
  }
  s.hourCount++; s.dayCount++;
  rlSave(s);
  return { ok: true };
}

/* ---------- offline outbox ---------- */
var OUTBOX_KEY = 'cozylibram.cc.outbox.v1';
function outboxLoad() {
  try { var o = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(o) ? o : []; }
  catch (e) { return []; }
}
function outboxSave(o) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(o)); } catch (e) {} }
function outboxPush(entry) {
  var o = outboxLoad();
  o.push(entry);
  outboxSave(o);
}

/* ---------- cloud helpers ---------- */
async function ccClient() {
  try {
    if (typeof cloudClient !== 'function') return null;
    return await cloudClient().catch(function () { return null; });
  } catch (e) { return null; }
}
function ccUserId() {
  try { return (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.id) || null; }
  catch (e) { return null; }
}

/* ---------- obscurity weight ----------
   Anti-gaming: credit = 1 / (1 + existing suggestion count for the book).
   Computed at submit time against live pending+accepted counts. */
async function obscurityWeight(sb, table, bookKey) {
  try {
    var r = await sb.from(table).select('id', { count: 'exact', head: true })
      .eq('book_key', bookKey).in('status', ['pending', 'accepted']);
    var n = (r && typeof r.count === 'number') ? r.count : 0;
    return 1 / (1 + n);
  } catch (e) { return 1; }
}

/* Per-book-per-user cap (5). Returns true if the user may submit. */
async function underBookCap(sb, table, bookKey, userField) {
  try {
    var uid = ccUserId();
    if (!uid) return false;
    var r = await sb.from(table).select('id', { count: 'exact', head: true })
      .eq('book_key', bookKey).eq(userField, uid).eq('status', 'pending');
    var n = (r && typeof r.count === 'number') ? r.count : 0;
    return n < 5;
  } catch (e) { return true; }
}

function rateLimitToast() {
  var c = ccRateLimitCheck();
  if (!c.ok) {
    var mins = Math.max(1, Math.round(c.retryAfterMs / 60000));
    toast('Slow down, lorekeeper — try again in ~' + mins + ' min');
    return false;
  }
  return true;
}

/* ---------- public API ---------- */
var CommunityCorpus = {

  /* Suggest an existing catalog trope for a book (89 IDs only). */
  suggestTrope: async function (book, tropeId, opts){
    opts = opts || {};
    var say = function (m) { if (!opts.quiet) toast(m); };
    if (!rateLimitToast()) return { ok: false, reason: 'rate' };
    var sb = await ccClient();
    var key = (typeof bookKeyFor === 'function') ? bookKeyFor(book) : null;
    if (!key) { say('Could not identify this book'); return { ok: false }; }
    var payload = { kind: 'catalog', trope_id: tropeId, book_key: key, status: 'pending' };
    if (!sb) { outboxPush({ table: 'trope_proposals', payload: payload, at: Date.now() }); say('Saved — will send when you\'re back online'); return { ok: true, queued: true }; }
    var uid = ccUserId();
    if (!uid) { say('Sign in to suggest'); return { ok: false, reason: 'auth' }; }
    if (!(await underBookCap(sb, 'trope_proposals', key, 'proposed_by'))) { say('You already have 5 pending suggestions for this book'); return { ok: false, reason: 'cap' }; }
    payload.proposed_by = uid;
    payload.obscurity_weight = await obscurityWeight(sb, 'trope_proposals', key);
    var r = await sb.from('trope_proposals').insert(payload).select('id').single();
    if (r.error) {
      if (String(r.error.message || '').match(/duplicate|unique/i)) say('Already suggested — thank you');
      else say('Could not send suggestion');
      return { ok: false, reason: 'db' };
    }
    say('Suggestion sent — thank you');
    return { ok: true, id: r.data && r.data.id };
  },

  /* New-trope idea outside the catalog → Kevin's curation queue. */
  proposeNewTrope: async function (name, description, book) {
    if (!rateLimitToast()) return { ok: false, reason: 'rate' };
    name = String(name || '').trim();
    if (!name) { toast('Give your trope a name'); return { ok: false }; }
    var sb = await ccClient();
    var key = book && typeof bookKeyFor === 'function' ? bookKeyFor(book) : null;
    var uid = ccUserId();
    if (!sb || !uid) {
      if (!sb) { outboxPush({ table: 'trope_proposals', payload: { kind: 'new-idea', name: name, name_key: name.toLowerCase(), description: String(description || ''), book_key: key, status: 'pending' }, at: Date.now() }); toast('Saved — will send when you\'re back online'); return { ok: true, queued: true }; }
      toast('Sign in to suggest'); return { ok: false, reason: 'auth' };
    }
    var r = await sb.from('trope_proposals').insert({
      kind: 'new-idea', name: name, name_key: name.toLowerCase(),
      description: String(description || '').slice(0, 2000),
      book_key: key, proposed_by: uid, status: 'pending'
    }).select('id').single();
    if (r.error) { toast('Could not send idea'); return { ok: false, reason: 'db' }; }
    toast('Idea sent to the curator — thank you');
    return { ok: true, id: r.data && r.data.id };
  },

  /* Suggest a character for a book. */
  suggestCharacter: async function (book, fields, opts){
    opts = opts || {};
    var say = function (m) { if (!opts.quiet) toast(m); };
    if (!rateLimitToast()) return { ok: false, reason: 'rate' };
    fields = fields || {};
    var name = String(fields.name || '').trim();
    if (!name) { say('Give the character a name'); return { ok: false }; }
    var sb = await ccClient();
    var key = (typeof bookKeyFor === 'function') ? bookKeyFor(book) : null;
    if (!key) { say('Could not identify this book'); return { ok: false }; }
    var uid = ccUserId();
    var w = sb ? await obscurityWeight(sb, 'character_suggestions', key) : 1;
    var payload = {
      type: 'add', book_key: key, name: name.slice(0, 120),
      role: fields.role || null, description: String(fields.description || '').slice(0, 2000),
      evidence: '', status: 'pending', obscurity_weight: w
    };
    if (!sb || !uid) {
      if (!sb) { outboxPush({ table: 'character_suggestions', payload: payload, at: Date.now() }); say('Saved — will send when you\'re back online'); return { ok: true, queued: true }; }
      say('Sign in to suggest'); return { ok: false, reason: 'auth' };
    }
    if (!(await underBookCap(sb, 'character_suggestions', key, 'suggested_by'))) { say('You already have 5 pending suggestions for this book'); return { ok: false, reason: 'cap' }; }
    payload.suggested_by = uid;
    var r = await sb.from('character_suggestions').insert(payload).select('id').single();
    if (r.error) { say('Could not send suggestion'); return { ok: false, reason: 'db' }; }
    say('Character suggested — thank you');
    return { ok: true, id: r.data && r.data.id };
  },

  /* Merge proposal: "these two are the same person". Evidence REQUIRED.
     Never auto-applied; Kevin-only review in v1. */
  proposeMerge: async function (book, charRefA, charRefB, evidence) {
    evidence = String(evidence || '').trim();
    if (!evidence) { toast('Evidence is required — e.g. "both appear in Chapter 12"'); return { ok: false, reason: 'evidence' }; }
    if (!rateLimitToast()) return { ok: false, reason: 'rate' };
    var sb = await ccClient();
    var key = (typeof bookKeyFor === 'function') ? bookKeyFor(book) : null;
    if (!key) { toast('Could not identify this book'); return { ok: false }; }
    var uid = ccUserId();
    if (!sb || !uid) { toast('Sign in to suggest'); return { ok: false, reason: 'auth' }; }
    var w = await obscurityWeight(sb, 'character_suggestions', key);
    var r = await sb.from('character_suggestions').insert({
      type: 'merge', book_key: key,
      character_ref: String(charRefA).slice(0, 200), merge_with_ref: String(charRefB).slice(0, 200),
      evidence: evidence.slice(0, 2000), status: 'pending',
      suggested_by: uid, obscurity_weight: w
    }).select('id').single();
    if (r.error) { toast('Could not send proposal'); return { ok: false, reason: 'db' }; }
    toast('Merge proposed — the curator will review the evidence');
    return { ok: true, id: r.data && r.data.id };
  },

  /* Suggest a trigger warning from the controlled taxonomy. */
  suggestTrigger: async function (book, triggerId, opts){
    opts = opts || {};
    var say = function (m) { if (!opts.quiet) toast(m); };
    if (!rateLimitToast()) return { ok: false, reason: 'rate' };
    var sb = await ccClient();
    var key = (typeof bookKeyFor === 'function') ? bookKeyFor(book) : null;
    if (!key) { say('Could not identify this book'); return { ok: false }; }
    var uid = ccUserId();
    var w = sb ? await obscurityWeight(sb, 'trigger_suggestions', key) : 1;
    var payload = { book_key: key, trigger_id: triggerId, status: 'pending', obscurity_weight: w };
    if (!sb || !uid) {
      if (!sb) { outboxPush({ table: 'trigger_suggestions', payload: payload, at: Date.now() }); say('Saved — will send when you\'re back online'); return { ok: true, queued: true }; }
      say('Sign in to suggest'); return { ok: false, reason: 'auth' };
    }
    payload.suggested_by = uid;
    var r = await sb.from('trigger_suggestions').insert(payload).select('id').single();
    if (r.error) {
      if (String(r.error.message || '').match(/duplicate|unique/i)) say('Already suggested — thank you');
      else say('Could not send suggestion');
      return { ok: false, reason: 'db' };
    }
    say('Warning suggested — thank you for looking out for readers');
    return { ok: true, id: r.data && r.data.id };
  },

  /* Community vote (dormant surface in v1; model is final). */
  vote: async function (suggestionType, suggestionId, vote) {
    var sb = await ccClient();
    var uid = ccUserId();
    if (!sb || !uid) { toast('Sign in to vote'); return { ok: false }; }
    vote = vote > 0 ? 1 : -1;
    var r = await sb.from('community_votes').upsert({
      suggestion_type: suggestionType, suggestion_id: suggestionId,
      user_id: uid, vote: vote
    }, { onConflict: 'suggestion_type,suggestion_id,user_id' });
    if (r.error) {
      if (String(r.error.message || '').match(/own suggestion/i)) toast('You can\'t vote on your own suggestion');
      else toast('Could not record vote');
      return { ok: false };
    }
    return { ok: true };
  },

  /* Tier-weighted consensus for the curation queue display.
     v1: all weights 1 (tiers dormant). */
  consensus: async function (suggestionType, suggestionId) {
    var sb = await ccClient();
    if (!sb) return { up: 0, down: 0, weighted: 0 };
    try {
      var r = await sb.from('community_votes')
        .select('vote, user_id').eq('suggestion_type', suggestionType).eq('suggestion_id', suggestionId);
      var rows = r.data || [];
      var up = 0, down = 0, weighted = 0;
      var tiers = {};
      try {
        var tr = await sb.from('community_tiers').select('user_id, tier');
        (tr.data || []).forEach(function (t) { tiers[t.user_id] = t.tier; });
      } catch (e) {}
      rows.forEach(function (v) {
        var w = tiers[v.user_id] === 'verified' ? 3 : (tiers[v.user_id] === 'established' ? 2 : 1);
        if (v.vote > 0) { up++; weighted += w; } else { down++; weighted -= w; }
      });
      return { up: up, down: down, weighted: weighted };
    } catch (e) { return { up: 0, down: 0, weighted: 0 }; }
  },

  /* Trigger taxonomy (cached). */
  taxonomy: async function () {
    try {
      if (CommunityCorpus._tax && Date.now() - CommunityCorpus._taxAt < 3600e3) return CommunityCorpus._tax;
    } catch (e) {}
    var sb = await ccClient();
    if (!sb) return [];
    try {
      var r = await sb.from('trigger_taxonomy').select('id, label, description, category').order('category').order('label');
      CommunityCorpus._tax = r.data || [];
      CommunityCorpus._taxAt = Date.now();
      return CommunityCorpus._tax;
    } catch (e) { return []; }
  },

  /* Flush offline outbox on reconnect. Fire-and-forget. */
  flushOutbox: async function () {
    var sb = await ccClient();
    var uid = ccUserId();
    if (!sb || !uid) return;
    var o = outboxLoad();
    if (!o.length) return;
    var rest = [];
    for (var i = 0; i < o.length; i++) {
      var e = o[i];
      try {
        // v473: queued trope confirm/dispute votes (Part 1, item 3)
        if (e && e.kind === 'trope-vote') {
          if (typeof TropeVotes !== 'undefined' && TropeVotes.vote) {
            await TropeVotes.vote(e.bookKey, e.tropeId, e.vote);
          } else { rest.push(e); }
          continue;
        }
        var p = Object.assign({}, e.payload);
        if (e.table === 'trope_proposals') p.proposed_by = p.proposed_by || uid;
        else p.suggested_by = p.suggested_by || uid;
        var r = await sb.from(e.table).insert(p);
        if (r.error) rest.push(e);
      } catch (err) { rest.push(e); }
    }
    outboxSave(rest);
  },

  /* Accepted-contribution counters for milestones (cached, refreshed async). */
  acceptedCounts: async function () {
    var sb = await ccClient();
    var uid = ccUserId();
    if (!sb || !uid) return { trope: 0, character: 0, trigger: 0, tropeW: 0, characterW: 0, triggerW: 0, weighted: 0 };
    try {
      var out = { trope: 0, character: 0, trigger: 0,
                  tropeW: 0, characterW: 0, triggerW: 0, weighted: 0 };
      /* Accepted = status accepted/approved. Kevin's approval is final.
         Anti-gaming: cap counting at 3 accepted suggestions per book per
         type (a user can't farm one popular book). */
      var tables = [
        ['trope_proposals', 'proposed_by', 'trope', 'tropeW'],
        ['character_suggestions', 'suggested_by', 'character', 'characterW'],
        ['trigger_suggestions', 'suggested_by', 'trigger', 'triggerW']
      ];
      for (var i = 0; i < tables.length; i++) {
        var tb = tables[i];
        var rr = await sb.from(tb[0]).select('book_key, obscurity_weight').eq(tb[1], uid).in('status', ['accepted', 'approved']);
        var perBook = {};
        (rr.data || []).forEach(function (row) {
          var k = row.book_key || '?';
          perBook[k] = perBook[k] || [];
          if (perBook[k].length < 3) perBook[k].push(row);
        });
        Object.keys(perBook).forEach(function (k) {
          perBook[k].forEach(function (row) {
            var w = (typeof row.obscurity_weight === 'number' ? row.obscurity_weight : 1);
            out[tb[2]]++;
            out[tb[3]] += w;
            out.weighted += w;
          });
        });
      }
      try { localStorage.setItem('cozylibram.cc.accepted.v1', JSON.stringify({ at: Date.now(), counts: out })); } catch (e) {}
      return out;
    } catch (e) { return { trope: 0, character: 0, trigger: 0, weighted: 0 }; }
  },
  acceptedCountsCached: function () {
    try {
      var c = JSON.parse(localStorage.getItem('cozylibram.cc.accepted.v1') || 'null');
      if (c && c.counts) return c.counts;
    } catch (e) {}
    return { trope: 0, character: 0, trigger: 0, tropeW: 0, characterW: 0, triggerW: 0, weighted: 0 };
  }
};

if (typeof window !== 'undefined') window.CommunityCorpus = CommunityCorpus;
if (typeof module !== 'undefined') module.exports = CommunityCorpus;

/* Test hooks (pure logic). */
CommunityCorpus._test = {
  rateLimitCheck: ccRateLimitCheck,
  rateLimitReset: function () { try { localStorage.removeItem(RL_KEY); } catch (e) {} },
  obscurity: function (n) { return 1 / (1 + n); },
  tierWeight: function (tier) { return tier === 'verified' ? 3 : (tier === 'established' ? 2 : 1); }
};

})();
