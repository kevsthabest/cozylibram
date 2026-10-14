/* ---- Book Portrait v1 (v468): one scannable card per book.
   Pinned under the book hero, above the tabs in renderDetailModal.

   Sections: tropes (community-accepted first, then pipeline, then user),
   content warnings, characters (top 2 by role weight), flavor line
   (genre · spice · mood). "See full breakdown" expands inline.

   Sparse states are contribution invitations, not failures — each empty
   section links to the existing corpus suggestion flows. Completeness %
   is a nudge, never a grade.

   Characters + community data fill in async via portraitEnhance(); the
   card renders synchronously so the modal never waits on the network.
*/
(function () {
'use strict';

var charCache = {}; // workId -> {count, top:[{name, role}]} (memory only)

function findBook(id) {
  try {
    var lib = (typeof library !== 'undefined') ? library : [];
    for (var i = 0; i < lib.length; i++) if (lib[i] && lib[i].id === id) return lib[i];
  } catch (e) {}
  return null;
}

/* ---------- local data ---------- */
function localTropes(b) {
  // user tropes first (deliberate), then pipeline AI not already listed
  var out = [], seen = {};
  (b.tropes || []).forEach(function (t) {
    t = String(t || '').trim(); if (!t) return;
    var k = t.toLowerCase();
    if (!seen[k]) { seen[k] = 1; out.push({ name: t, source: 'you' }); }
  });
  (b.tropesAI || []).forEach(function (t) {
    t = String(t || '').trim(); if (!t) return;
    var k = t.toLowerCase();
    if (!seen[k]) { seen[k] = 1; out.push({ name: t, source: 'auto' }); }
  });
  return out;
}
function localWarnings(b) {
  return (b.contentWarnings || []).map(function (w) { return String(w); }).filter(Boolean);
}
function flavorLine(b) {
  var parts = [];
  try {
    var g = (typeof bookGenres === 'function') ? bookGenres(b) : [];
    if (g && g.length) parts.push(g[0]);
  } catch (e) {}
  if (b.ratings && b.ratings.spice != null && b.ratings.spice !== '') parts.push('🌶️ ' + b.ratings.spice + '/5');
  if (b.moods && b.moods.length) parts.push(String(b.moods[0]));
  return parts.join(' · ');
}

/* ---------- completeness (0-100) ---------- */
function portraitScore(b, charCount) {
  var s = 0;
  if (localTropes(b).length) s += 30;
  if (localWarnings(b).length || b.warningsReviewed) s += 25;
  if ((charCount || 0) > 0) s += 25;
  var hasGM = false;
  try { hasGM = ((typeof bookGenres === 'function') ? bookGenres(b) : []).length > 0; } catch (e) {}
  if (hasGM || (b.moods && b.moods.length)) s += 10;
  if (b.ratings && b.ratings.spice != null && b.ratings.spice !== '') s += 10;
  return s;
}

/* ---------- async: characters ---------- */
var ROLE_W = { protagonist: 3, supporting: 2, minor: 1 };
function roleWeight(r) { return ROLE_W[String(r || '').toLowerCase()] || 1; }

async function portraitCharData(b) {
  var key = 'noid';
  try {
    if (typeof resolveWork !== 'function') return { count: 0, top: [] };
    var wid = await resolveWork(b);
    if (!wid) return { count: 0, top: [] };
    key = wid;
    if (charCache[key]) return charCache[key];
    if (typeof CharacterStore === 'undefined') return { count: 0, top: [] };
    var rows = await CharacterStore.listForWork(wid).catch(function () { return []; });
    rows = rows || [];
    var sorted = rows.slice().sort(function (a, c2) { return roleWeight(c2.role) - roleWeight(a.role); });
    var res = {
      count: rows.length,
      top: sorted.slice(0, 2).map(function (r) { return { name: r.name, role: r.role }; }),
      all: sorted.map(function (r) { return { name: r.name, role: r.role }; })
    };
    charCache[key] = res;
    return res;
  } catch (e) { return { count: 0, top: [] }; }
}
/* Sync-safe character count for guards (nudge signals). Returns null when
   the cloud can't be reached — callers must treat null as "unknown",
   never as zero. */
async function portraitCharCount(b) {
  try {
    if (typeof cloudClient !== 'function') return null;
    var sb = await cloudClient().catch(function () { return null; });
    if (!sb) return null;
    var d = await portraitCharData(b);
    return d.count;
  } catch (e) { return null; }
}

/* ---------- async: community tropes ---------- */
async function communityTropes(b) {
  var out = [];
  try {
    if (typeof cloudClient !== 'function' || typeof bookKeyFor !== 'function') return out;
    var sb = await cloudClient().catch(function () { return null; });
    if (!sb) return out;
    var key = bookKeyFor(b);
    var r = await sb.from('book_tropes').select('trope_id').eq('book_key', key).eq('source', 'community');
    var seen = {};
    localTropes(b).forEach(function (t) { seen[t.name.toLowerCase()] = 1; });
    (r.data || []).forEach(function (row) {
      var name = row.trope_id;
      try {
        if (typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy.byId) {
          var t = TropeTaxonomy.byId(row.trope_id);
          if (t && t.name) name = t.name;
        }
      } catch (e) {}
      var k = String(name).toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push({ name: name, source: 'community' }); }
    });
  } catch (e) {}
  return out;
}

/* ---------- card HTML (sync) ---------- */
// v473: warnings area state (Part 2, item 5). Pure — unit-tested.
// Returns 'unreviewed' | 'none-confirmed' | 'has-warnings'.
function warningsState(warns, b) {
  if (warns && warns.length) return 'has-warnings';
  if (b && b.warningsReviewed) return 'none-confirmed';
  return 'unreviewed';
}
function tropeChipsHTML(tropes, bookId, votes) {
  if (!tropes.length) {
    return '<span class="note">No tropes mapped yet — </span>' +
      '<button class="taplink" data-pt="suggest-tropes" data-book="' + esc(bookId) + '">what kind of story is this?</button>';
  }
  // v473: provenance labels (Part 1, item 1). votes optional — without them
  // every auto trope reads "from the text", which is correct pre-fetch.
  var votable = (typeof TropeVotes !== 'undefined' && TropeVotes.canVote && TropeVotes.canVote());
  var shown = tropes.slice(0, 2).map(function (t) {
    var prov = (typeof tropeProvenance === 'function')
      ? tropeProvenance(t, votes || {}, null)
      : { key: 'text', label: 'from the text' };
    var tappable = votable && t.id && prov.key === 'text';
    return '<span class="chip" data-tprov="' + prov.key + '"' +
      (t.id ? ' data-tid="' + esc(t.id) + '"' : '') +
      (tappable ? ' tabindex="0" role="button" aria-label="' + esc(t.name) + ' — ' + esc(prov.label) + '. Tap to confirm or dispute."' : '') +
      '>' + esc(t.name) + '<span class="tprov">' + esc(prov.label) + '</span></span>';
  }).join(' ');
  if (tropes.length > 2) shown += ' <button class="chip ghost" data-pt="gotab" data-tab="tropes">+' + (tropes.length - 2) + '</button>';
  return shown;
}
function warnChipsHTML(warns, b, bookId) {
  if (!warns.length) {
    // v473: two states (Part 2, item 5) — "Not reviewed yet" vs
    // "Readers found nothing to flag". "Nothing to flag" only when Read (item 6).
    if (warningsState(warns, b) === 'none-confirmed') {
      return '<span class="note">✓ Readers found nothing to flag</span>';
    }
    var html = '<span class="note">Not reviewed yet. </span>' +
      '<button class="taplink" data-pt="suggest-warn" data-book="' + esc(bookId) + '">Flag one</button>';
    if (b && b.status === 'read') {
      html += ' <button class="taplink" data-pt="warn-none" data-book="' + esc(bookId) + '">Nothing to flag</button>';
    }
    return html;
  }
  // v535 (audit #1): warning preferences apply — prominent first +
  // emphasised; 'detailed' lifts the +N truncation; 'on-request'
  // holds the names behind a tap (session-only reveal, js/226).
  var prefs = null;
  try { prefs = (typeof getWarningPrefs === 'function') ? getWarningPrefs() : null; } catch (e) {}
  if (prefs && prefs.detail === 'on-request' && b &&
      !(typeof warnIsRevealed === 'function' && warnIsRevealed(b))) {
    return '<button class="taplink" data-pt="warn-reveal" data-book="' + esc(bookId) + '">Content warnings — tap to view</button>';
  }
  var ordered = (prefs && typeof warnOrderProminent === 'function') ? warnOrderProminent(warns, prefs) : warns;
  var limit = (prefs && prefs.detail === 'detailed') ? ordered.length : 3;
  return ordered.slice(0, limit).map(function (w) {
    var prom = prefs && typeof warnIsProminent === 'function' && warnIsProminent(w, prefs);
    return '<span class="warn-tag' + (prom ? ' warn-tag-prom' : '') + '">' + esc(w) + '</span>';
  }).join(' ') + (ordered.length > limit ? ' <span class="note">+' + (ordered.length - limit) + '</span>' : '');
}

function portraitCardHTML(b) {
  if (!b) return '';
  var bookId = b.id || '';
  var tropes = localTropes(b);
  var warns = localWarnings(b);
  var flavor = flavorLine(b);
  var pct = portraitScore(b, 0);
  var html =
    '<div class="portrait-card" id="portraitCard" data-book="' + esc(bookId) + '">' +
    '<div class="portrait-head"><span style="width:22px;height:22px;color:var(--accent);flex-shrink:0;vertical-align:middle;margin-right:10px;display:inline-flex;align-items:center">' + icon('portrait') + '</span>' +
    '<span class="serif portrait-title">Book Portrait</span> ' +
    '<span class="note" id="ptPct">' + pct + '% mapped</span></div>' +
    '<div class="portrait-sec"><div class="portrait-label">Tropes</div><div id="ptTropes">' +
    tropeChipsHTML(tropes, bookId) + '</div></div>' +
    '<div class="portrait-sec"><div class="portrait-label">Content warnings</div><div id="ptWarns">' +
    warnChipsHTML(warns, b, bookId) + '</div></div>' +
    '<div class="portrait-sec"><div class="portrait-label">Characters</div><div id="ptChars">' +
    '<span class="note">Loading cast…</span></div></div>' +
    (flavor ? '<div class="portrait-flavor">' + esc(flavor) + '</div>' : '') +
    '<button class="taplink portrait-more" data-pt="more">See full breakdown ↓</button>' +
    '<div class="portrait-full" id="ptFull" hidden></div>' +
    '</div>';
  return html;
}

/* ---------- async enhance ---------- */
async function portraitEnhance(b) {
  if (!b) return;
  var card = document.getElementById('portraitCard');
  if (!card || card.dataset.book !== (b.id || '')) return;
  var fresh = findBook(b.id) || b;
  // characters
  try {
    var cd = await portraitCharData(fresh);
    var chEl = document.getElementById('ptChars');
    if (chEl && card.isConnected) {
      if (!cd.count) {
        chEl.innerHTML = '<span class="note">No characters recorded — </span>' +
          '<button class="taplink" data-pt="suggest-chars" data-book="' + esc(fresh.id || '') + '">who\u2019s in this story?</button>';
      } else {
        chEl.innerHTML = cd.top.map(function (c) { return '<span class="chip">' + esc(c.name) + '</span>'; }).join(' ') +
          (cd.count > 2 ? ' <button class="chip ghost" data-pt="gotab" data-tab="characters">+' + (cd.count - 2) + '</button>' : '');
      }
      card._ptChars = cd;
    }
    var pctEl = document.getElementById('ptPct');
    if (pctEl && card.isConnected) pctEl.textContent = portraitScore(fresh, cd.count) + '% mapped';
  } catch (e) {}
  // community tropes (prepend) + enriched warnings
  // v473: resolve trope ids + fetch votes for provenance labels (Part 1)
  try {
    var ct = await communityTropes(fresh);
    var tEl = document.getElementById('ptTropes');
    if (tEl && card.isConnected) {
      var merged = ct.concat(localTropes(fresh));
      merged.forEach(function (t) {
        if (!t.id && typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy.resolveId) {
          try { t.id = TropeTaxonomy.resolveId(t.name); } catch (e) {}
        }
      });
      var pvotes = {};
      try {
        if (typeof TropeVotes !== 'undefined' && TropeVotes.getVotes && typeof bookKeyFor === 'function') {
          pvotes = await TropeVotes.getVotes(bookKeyFor(fresh));
        }
      } catch (e) {}
      tEl.innerHTML = tropeChipsHTML(merged, fresh.id || '', pvotes);
      card._ptTropes = merged;
      card._ptVotes = pvotes;
      try { card._ptBookKey = (typeof bookKeyFor === 'function') ? bookKeyFor(fresh) : null; } catch (e) {}
    }
  } catch (e) {}
  try {
    if (typeof ccEnrichWarnings === 'function') await ccEnrichWarnings(fresh);
    var wEl = document.getElementById('ptWarns');
    if (wEl && card.isConnected) {
      wEl.innerHTML = warnChipsHTML(localWarnings(fresh), fresh, fresh.id || '');
    }
  } catch (e) {}
}

/* ---------- breakdown ---------- */
function portraitBreakdownHTML(b) {
  var card = document.getElementById('portraitCard');
  var tropes = (card && card._ptTropes) || localTropes(b);
  var warns = localWarnings(b);
  var chars = (card && card._ptChars && card._ptChars.all) || [];
  var srcLabel = { you: 'your list', auto: 'auto-detected', community: 'community ✓' };
  var h = '<div class="portrait-bsec"><div class="portrait-label">All tropes</div>';
  h += tropes.length ? tropes.map(function (t) {
    return '<div class="portrait-brow"><span class="chip">' + esc(t.name) + '</span> <span class="note">' + esc(srcLabel[t.source] || t.source || '') + '</span></div>';
  }).join('') : '<p class="note">None mapped yet.</p>';
  h += '</div><div class="portrait-bsec"><div class="portrait-label">All warnings</div>';
  // v535 (audit #1): prominent-first + emphasised, descriptions at the
  // 'detailed' level. The breakdown is itself an explicit "show me
  // everything" view, so 'on-request' does not hide rows here.
  h += warns.length ? (function () {
    var bp = null;
    try { bp = (typeof getWarningPrefs === 'function') ? getWarningPrefs() : null; } catch (e) {}
    var ow = (bp && typeof warnOrderProminent === 'function') ? warnOrderProminent(warns, bp) : warns;
    return ow.map(function (w) {
      var comm = /\(community\)\s*$/.test(w);
      var prom = bp && typeof warnIsProminent === 'function' && warnIsProminent(w, bp);
      var desc = (bp && bp.detail === 'detailed' && typeof warnDescFor === 'function') ? warnDescFor(w) : '';
      return '<div class="portrait-brow"><span class="warn-tag' + (prom ? ' warn-tag-prom' : '') + '">' + esc(w) + '</span> <span class="note">' + (comm ? 'community ✓' : 'catalog') + (desc ? ' — ' + esc(desc) : '') + '</span></div>';
    }).join('');
  })() : '<p class="note">' + (warningsState(null, b) === 'none-confirmed' ? 'Readers found nothing to flag.' : 'Not reviewed yet.') + '</p>';
  h += '</div><div class="portrait-bsec"><div class="portrait-label">All characters</div>';
  h += chars.length ? chars.map(function (c) {
    return '<div class="portrait-brow"><b>' + esc(c.name) + '</b> <span class="note">' + esc(c.role || '') + '</span></div>';
  }).join('') : '<p class="note">None recorded yet.</p>';
  h += '</div>';
  return h;
}

/* ---------- delegated clicks ---------- */
function suggestVia(which, bookId) {
  var b = findBook(bookId);
  if (!b) return;
  try {
    if (typeof window.ccSuggest === 'function' || typeof window.ccSuggest === 'object') {
      var s = window.ccSuggest;
      if (which === 'tropes' && s.trope) return s.trope(b);
      if (which === 'chars' && s.character) return s.character(b);
      if (which === 'warn' && s.warning) return s.warning(b);
    }
    // fallback: open the tab where the suggest buttons live
    var tab = which === 'tropes' ? 'tropes' : 'characters';
    var btn = document.querySelector('[data-dtab="' + tab + '"]');
    if (btn) btn.click();
    toast(which === 'warn' ? 'Open Details → content warnings to suggest' : 'Use the Suggest button on the tab');
  } catch (e) {}
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', function (e) {
    // v473: trope confirm/dispute on portrait chips (Part 1, item 2)
    var tc = e.target && e.target.closest ? e.target.closest('#ptTropes [data-tid][tabindex]') : null;
    if (tc && typeof TropeConfirm !== 'undefined') {
      var card0 = document.getElementById('portraitCard');
      if (card0 && card0._ptBookKey) {
        (function (chip, card) {
          TropeConfirm.open(document.getElementById('ptTropes'), {
            bookKey: card._ptBookKey,
            tropeId: chip.getAttribute('data-tid'),
            onDone: function () {
              var b = findBook(card.dataset.book);
              if (b) portraitEnhance(b);
            }
          });
        })(tc, card0);
      }
      return;
    }
    var el = e.target && e.target.closest ? e.target.closest('[data-pt]') : null;
    if (!el) return;
    var kind = el.getAttribute('data-pt');
    var card = document.getElementById('portraitCard');
    if (kind === 'more') {
      var full = document.getElementById('ptFull');
      if (!full) return;
      var open = full.hidden;
      if (open) {
        var b = card ? findBook(card.dataset.book) : null;
        full.innerHTML = portraitBreakdownHTML(b || {});
      }
      full.hidden = !open;
      el.textContent = open ? 'Hide breakdown ↑' : 'See full breakdown ↓';
    } else if (kind === 'gotab') {
      var tab = el.getAttribute('data-tab');
      var btn = document.querySelector('[data-dtab="' + tab + '"]');
      if (btn) btn.click();
    } else if (kind === 'suggest-tropes') suggestVia('tropes', el.getAttribute('data-book'));
    else if (kind === 'suggest-chars') suggestVia('chars', el.getAttribute('data-book'));
    else if (kind === 'suggest-warn') suggestVia('warn', el.getAttribute('data-book'));
    // v535: 'on-request' reveal for the portrait warning chips.
    else if (kind === 'warn-reveal') {
      var rv = findBook(el.getAttribute('data-book'));
      if (rv && typeof warnReveal === 'function') {
        warnReveal(rv);
        var wEl3 = document.getElementById('ptWarns');
        if (wEl3) wEl3.innerHTML = warnChipsHTML(localWarnings(rv), rv, rv.id || '');
      }
    }
    // v473: "Nothing to flag" (Part 2, items 5-6) — Read books only; the
    // book object + saveLibrary() is the offline story (rides library sync).
    else if (kind === 'warn-none') {
      var wb = findBook(el.getAttribute('data-book'));
      if (wb && wb.status === 'read') {
        wb.warningsReviewed = true;
        try { if (typeof saveLibrary === 'function') saveLibrary(); } catch (e) {}
        var wEl = document.getElementById('ptWarns');
        if (wEl) wEl.innerHTML = warnChipsHTML(localWarnings(wb), wb, wb.id || '');
        try { toast('Thanks — noted'); } catch (e) {}
      }
    }
  });
}

if (typeof window !== 'undefined') {
  window.portraitCardHTML = portraitCardHTML;
  window.portraitEnhance = portraitEnhance;
  window.portraitCharCount = portraitCharCount;
  window.portraitScore = portraitScore;
  window.portraitLocalTropes = localTropes;
}
if (typeof module !== 'undefined') {
  module.exports = { portraitScore: portraitScore, localTropes: localTropes, warningsState: warningsState };
}
})();
