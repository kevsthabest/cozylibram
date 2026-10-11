/* ---- Curation queue v1 (Observatory): Kevin's review inbox for community
   corpus suggestions (tropes, characters, trigger warnings).

   - Lists pending suggestions across all three pillars with provenance
     (Kevin sees WHO suggested — full provenance for the curator).
   - Consensus state per suggestion: votes for/against, tier-weighted
     (all weights 1 in v1 — tiers dormant).
   - Bulk approve/reject — fast, not one-by-one clicks.
   - Kevin's decision is final; his curation always overrides.
   - Merge proposals are never auto-applied: approve records the decision;
     Kevin applies the merge in the Character Lab.

   Approve effects:
   - catalog trope  → upsert book_tropes (book_key, trope_id, source='community')
   - catalog trope reject → mark rejected + admin downvote in trope_votes
   - new-trope idea → mark approved/rejected (Kevin adds to taxonomy manually)
   - character add  → resolve work_id → insert book_characters (source_type='community')
   - character merge/correct → mark accepted/rejected (Kevin applies manually)
   - trigger        → mark accepted/rejected (accepted flows into the
                      Start Reading trigger check via ccEnrichWarnings)
   All decisions bump community_tiers accepted/rejected counters (tiers
   dormant in v1, counters accumulate for v2).
*/
(function () {
'use strict';

function escHtml(s) {
  try { return (typeof esc === 'function') ? esc(s) : String(s); }
  catch (e) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
}
async function cqClient() {
  try { return await cloudClient().catch(function () { return null; }); }
  catch (e) { return null; }
}

/* book_key → work_id via editions (isbn:) or title/author norm (t:). */
async function workIdFromBookKey(sb, bookKey) {
  try {
    if (!bookKey) return null;
    if (bookKey.indexOf('isbn:') === 0) {
      var r = await sb.from('editions').select('work_id').eq('isbn', bookKey.slice(5)).limit(1).maybeSingle();
      return (r.data && r.data.work_id) || null;
    }
    if (bookKey.indexOf('t:') === 0) {
      var parts = bookKey.slice(2).split(':');
      var tnorm = parts[0] || '', anorm = parts.slice(1).join(':') || '';
      var r2 = await sb.from('works').select('id').eq('title_norm', tnorm).eq('author_norm', anorm).limit(1).maybeSingle();
      return (r2.data && r2.data.id) || null;
    }
  } catch (e) {}
  return null;
}

async function bumpCounters(sb, userId, accepted) {
  try {
    var r = await sb.from('community_tiers').select('accepted_count, rejected_count').eq('user_id', userId).maybeSingle();
    var row = r.data || { accepted_count: 0, rejected_count: 0 };
    var upd = {
      user_id: userId,
      accepted_count: row.accepted_count + (accepted ? 1 : 0),
      rejected_count: row.rejected_count + (accepted ? 0 : 1),
      updated_at: new Date().toISOString()
    };
    await sb.from('community_tiers').upsert(upd, { onConflict: 'user_id' });
  } catch (e) {}
}

/* ---------- queue data ---------- */
async function loadQueue(sb) {
  var items = [];
  try {
    var tp = await sb.from('trope_proposals')
      .select('id, kind, trope_id, name, description, book_key, proposed_by, created_at, obscurity_weight')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(200);
    (tp.data || []).forEach(function (r) {
      items.push({
        ptype: r.kind === 'catalog' ? 'trope' : 'new-trope',
        id: r.id, bookKey: r.book_key,
        title: r.kind === 'catalog' ? ('Trope: ' + r.trope_id) : ('New trope idea: ' + r.name),
        detail: r.kind === 'catalog' ? '' : String(r.description || '').slice(0, 200),
        by: r.proposed_by, at: r.created_at, weight: r.obscurity_weight,
        raw: r
      });
    });
  } catch (e) {}
  try {
    var cs = await sb.from('character_suggestions')
      .select('id, type, book_key, character_ref, merge_with_ref, name, role, description, evidence, suggested_by, created_at, obscurity_weight')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(200);
    (cs.data || []).forEach(function (r) {
      var title = r.type === 'add' ? ('Character: ' + r.name)
        : r.type === 'merge' ? ('Merge: ' + r.character_ref + ' ← ' + r.merge_with_ref)
        : ('Correct: ' + (r.character_ref || r.name));
      items.push({
        ptype: 'character', id: r.id, bookKey: r.book_key, title: title,
        detail: (r.description || '') + (r.evidence ? ' | Evidence: ' + r.evidence : ''),
        by: r.suggested_by, at: r.created_at, weight: r.obscurity_weight, raw: r
      });
    });
  } catch (e) {}
  try {
    var ts = await sb.from('trigger_suggestions')
      .select('id, book_key, trigger_id, suggested_by, created_at, obscurity_weight, trigger_taxonomy(label)')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(200);
    (ts.data || []).forEach(function (r) {
      var label = (r.trigger_taxonomy && r.trigger_taxonomy.label) || r.trigger_id;
      items.push({
        ptype: 'trigger', id: r.id, bookKey: r.book_key,
        title: 'Warning: ' + label, detail: '',
        by: r.suggested_by, at: r.created_at, weight: r.obscurity_weight, raw: r
      });
    });
  } catch (e) {}
  items.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  return items;
}

/* ---------- approve / reject ---------- */
async function setStatus(sb, item, accepted) {
  var status = accepted ? (item.ptype === 'new-trope' ? 'approved' : 'accepted') : 'rejected';
  if (item.ptype === 'trope' || item.ptype === 'new-trope') {
    var r = await sb.from('trope_proposals').update({ status: status }).eq('id', item.id);
    if (r.error) throw new Error(r.error.message);
    if (accepted && item.ptype === 'trope') {
      /* Apply: upsert into the shared book_key-keyed cache as community. */
      var up = await sb.from('book_tropes').upsert({
        book_key: item.bookKey, trope_id: item.raw.trope_id,
        source: 'community', confidence: 0.7, taxonomy_version: 1,
        updated_at: new Date().toISOString()
      }, { onConflict: 'book_key,trope_id' });
      if (up.error) throw new Error(up.error.message);
    }
    if (!accepted && item.ptype === 'trope') {
      /* Rejected wins: admin downvote so the suggestion stays down. */
      try {
        var uid = (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.id) || null;
        if (uid) await sb.from('trope_votes').upsert(
          { book_key: item.bookKey, trope_id: item.raw.trope_id, user_id: uid, vote: -1 },
          { onConflict: 'book_key,trope_id,user_id' });
      } catch (e) {}
    }
    await bumpCounters(sb, item.by, accepted);
    return;
  }
  if (item.ptype === 'character') {
    var r2 = await sb.from('character_suggestions').update({ status: status }).eq('id', item.id);
    if (r2.error) throw new Error(r2.error.message);
    if (accepted && item.raw.type === 'add') {
      var workId = await workIdFromBookKey(sb, item.bookKey);
      if (!workId) throw new Error('could not resolve work for ' + item.bookKey + ' — kept pending');
      var ins = await sb.from('book_characters').insert({
        work_id: workId, name: item.raw.name, role: item.raw.role,
        description: item.raw.description, source_type: 'community'
      });
      if (ins.error) throw new Error(ins.error.message);
    }
    /* merge/correct: decision recorded; Kevin applies manually in Character Lab. */
    await bumpCounters(sb, item.by, accepted);
    return;
  }
  if (item.ptype === 'trigger') {
    var r3 = await sb.from('trigger_suggestions').update({ status: status }).eq('id', item.id);
    if (r3.error) throw new Error(r3.error.message);
    /* Accepted warnings flow into the Start Reading trigger check via
       ccEnrichWarnings (reads status='accepted' live). Safety bias: the
       bar for applying is Kevin's one click. */
    await bumpCounters(sb, item.by, accepted);
    return;
  }
  throw new Error('unknown type');
}

/* ---------- render ---------- */
var cqSelected = {};
var cqItems = [];

async function renderCurationQueue() {
  var body = document.getElementById('ob-body');
  if (!body) return;
  body.innerHTML = '<div class="ob-card"><h3 class="serif">Curation queue</h3>' +
    '<p class="note">Community suggestions awaiting review. Your decision is final. ' +
    'Bulk-select to approve/reject fast. Provenance shown to you only — the public sees "refined by the community".</p>' +
    '<p class="note" id="cq-status">Loading…</p></div><div id="cq-list"></div>';
  var sb = await cqClient();
  if (!sb) { document.getElementById('cq-status').textContent = 'Sign in to curate.'; return; }
  cqItems = await loadQueue(sb);
  cqSelected = {};
  renderCqList(sb);
}

async function renderCqList(sb) {
  var statusEl = document.getElementById('cq-status');
  var listEl = document.getElementById('cq-list');
  if (!statusEl || !listEl) return;
  if (!cqItems.length) {
    statusEl.textContent = 'Queue is clear — nothing pending.';
    listEl.innerHTML = '';
    return;
  }
  statusEl.innerHTML = cqItems.length + ' pending. ' +
    '<button class="btn sm" id="cq-approve-sel">Approve selected</button> ' +
    '<button class="btn sm ghost" id="cq-reject-sel">Reject selected</button> ' +
    '<span class="note" id="cq-msg"></span>';
  /* consensus per item — v1: votes are dormant, skip the per-item DB
     round-trips (107 items × 2 queries was hanging the render). The display
     defaults to "no votes yet"; re-enable when voting goes live. */
  var consens = {};
  /* suggester names (best-effort from profiles) */
  var names = {};
  try {
    var ids = [...new Set(cqItems.map(function (x) { return x.by; }).filter(Boolean))];
    if (ids.length) {
      var pr = await sb.from('profiles').select('user_id, first_name').in('user_id', ids);
      (pr.data || []).forEach(function (p) {
        if (p.first_name) names[p.user_id] = p.first_name;
      });
    }
  } catch (e) {}
  var typeBadge = { trope: 'trope', 'new-trope': 'new idea', character: 'character', trigger: 'warning' };
  listEl.innerHTML = cqItems.map(function (it) {
    var c = consens[it.id] || { up: 0, down: 0, weighted: 0 };
    var who = names[it.by] || (it.by ? 'user ' + String(it.by).slice(0, 8) : 'unknown');
    var when = it.at ? new Date(it.at).toLocaleDateString() : '';
    var con = (c.up || c.down) ? ('<span class="note">consensus +' + c.up + '/−' + c.down + ' (w:' + c.weighted + ')</span>') : '<span class="note">no votes yet</span>';
    return '<div class="ob-card cq-row" data-cqid="' + it.id + '">' +
      '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">' +
      '<input type="checkbox" class="cq-check" data-cqid="' + it.id + '"' + (cqSelected[it.id] ? ' checked' : '') + ' style="margin-top:4px">' +
      '<span style="flex:1">' +
      '<span class="chip">' + escHtml(typeBadge[it.ptype] || it.ptype) + '</span> ' +
      '<b>' + escHtml(it.title) + '</b><br>' +
      (it.detail ? '<span class="note">' + escHtml(String(it.detail).slice(0, 220)) + '</span><br>' : '') +
      '<span class="note">' + escHtml(it.bookKey || '') + ' · by ' + escHtml(who) + ' · ' + escHtml(when) + '</span><br>' + con +
      '</span></label>' +
      '<p style="margin:6px 0 0"><button class="btn sm" data-cq-ok="' + it.id + '">Approve</button> ' +
      '<button class="btn sm ghost" data-cq-no="' + it.id + '">Reject</button></p>' +
      '</div>';
  }).join('');
  listEl.querySelectorAll('.cq-check').forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (cb.checked) cqSelected[cb.dataset.cqid] = true; else delete cqSelected[cb.dataset.cqid];
    });
  });
  listEl.querySelectorAll('[data-cq-ok]').forEach(function (b) {
    b.addEventListener('click', function () { cqDecide(sb, [b.dataset.cqOk], true); });
  });
  listEl.querySelectorAll('[data-cq-no]').forEach(function (b) {
    b.addEventListener('click', function () { cqDecide(sb, [b.dataset.cqNo], false); });
  });
  document.getElementById('cq-approve-sel').addEventListener('click', function () {
    cqDecide(sb, Object.keys(cqSelected), true);
  });
  document.getElementById('cq-reject-sel').addEventListener('click', function () {
    cqDecide(sb, Object.keys(cqSelected), false);
  });
}

async function cqDecide(sb, ids, accepted) {
  var msg = document.getElementById('cq-msg');
  if (!ids.length) { if (msg) msg.textContent = 'Nothing selected.'; return; }
  if (msg) msg.textContent = (accepted ? 'Approving' : 'Rejecting') + ' ' + ids.length + '…';
  var ok = 0, failed = [];
  for (var i = 0; i < ids.length; i++) {
    var it = cqItems.find(function (x) { return x.id === ids[i]; });
    if (!it) continue;
    try { await setStatus(sb, it, accepted); ok++; }
    catch (e) { failed.push(it.title + ': ' + (e.message || e)); }
  }
  cqItems = await loadQueue(sb);
  cqSelected = {};
  await renderCqList(sb);
  var m2 = document.getElementById('cq-msg');
  if (m2) m2.textContent = ok + ' ' + (accepted ? 'approved' : 'rejected') + (failed.length ? '. ' + failed.length + ' failed: ' + failed.slice(0, 3).join('; ') : '.');
  try { toast(ok + (accepted ? ' approved' : ' rejected')); } catch (e) {}
}

if (typeof window !== 'undefined') {
  window.renderCurationQueue = renderCurationQueue;
  window.CurationQueue = { loadQueue: loadQueue, setStatus: setStatus, workIdFromBookKey: workIdFromBookKey };
}
if (typeof module !== 'undefined') module.exports = { workIdFromBookKey: workIdFromBookKey };

})();
