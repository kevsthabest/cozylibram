'use strict';

/* js/162-charlab.js — Character Lab: the Observatory's curation
 * views for pipeline-extracted characters, and the merge machinery
 * that makes merging duplicates reversible.
 *
 * renderCharacterLab() is the entry: the Observatory shell in
 * js/199-admin.js dispatches to it when adminTab === 'characters',
 * and it renders into #ob-body. charLabView selects the view:
 * 'characters' (the default — a per-work grid with role filters,
 * duplicate detection and inline editing), 'review' (the
 * relationship inbox: pipeline relationships not yet reviewed
 * into an edge row, plus pending reader-suggested edges), and
 * 'relationships' (a placeholder card — the graph workspace was
 * never built, and the card says so). charLabCanonDetail()
 * groups a canonical character's linked instances, with unlink
 * controls.
 *
 * Data contract (from the ebook processor): book_characters rows
 * carry work_id, name, role (protagonist / antagonist / supporting
 * / minor), description, and relationships as JSONB
 * [{to: "<name>", type: "<type>"}]. A relationship's `to` is a
 * NAME string, not an id, so targets resolve defensively through
 * charResolveTarget and unresolved targets are shown, never
 * dropped. Relationship types are a closed set of 10 (spouse /
 * parent / child / sibling / friend / enemy / mentor / colleague /
 * neighbor / other); charNormRelType maps anything unknown to
 * "other". Casts are handled one work at a time.
 *
 * charMerge / charUnmerge live here because the Lab's surfaces
 * are their only callers. A merge is soft — the loser is marked
 * status 'merged' with duplicate_of pointing at the winner, never
 * deleted — and reversible by construction: charMerge stores one
 * snapshot (merge_snapshot) on the loser row BEFORE any repoint
 * lands, and aborts untouched if that write fails; charUnmerge
 * restores verbatim from the snapshot only and refuses merges
 * that have none. The companions over that core (the restore
 * preview sheet, its counted results, and winner-side merge
 * history) are pure derivations over the in-memory Lab list plus
 * the snapshot. The merge core is pinned end-to-end by
 * .test/char-unmerge.test.js and the companions by
 * .test/char-unmerge-companions.test.js.
 *
 * What does NOT live here: CharacterStore and the pure character
 * helpers stay in js/154-characterstore.js, shared with js/159
 * and the other character surfaces — this file reads them as
 * wired imports, together with the js/050 helpers, the js/152
 * overlay pair and js/055's sheet-drag helper (see ADR-003).
 * Several Lab writes still reach Supabase through
 * CharacterStore._sb() directly rather than through a store
 * method. CHAR_ROLE_LABELS lives here; js/159 reads it, and
 * js/199 reads renderCharacterLab, through the window bridge at
 * the bottom of this file.
 */
import { confirmModal, esc, findCharByName, fmtDate, icon, toast } from './050-helpers.js';
import { wireSheetDrag } from './055-sheetdrag.js';
import { overlayClosed, overlayOpened } from './152-overlay-history.js';
import { CHAR_ROLES, CharacterStore, charFindDuplicates, charIsBlocked, charNormRelType, charResolveTarget } from './154-characterstore.js';

export const CHAR_ROLE_LABELS = { protagonist: 'Protagonist', antagonist: 'Antagonist',
  supporting: 'Supporting', minor: 'Minor' };

export let charLabWorkId = null;
export let charLabRoleFilter = '';
export let charLabSelectedId = null;
export let charLabShowBlocked = false; // v317: hidden by default
export let charLabView = 'characters'; // v395: 'review' | 'relationships' | 'characters' (was 'work'|'relationships')
export let charLabCanonicalId = null;

export async function renderCharacterLab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  body.innerHTML = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3><p class="note">Loading…</p></div>';

  const works = await CharacterStore.listWorks();
  if (!works.length) {
    body.innerHTML = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
      ' Character Lab</h3><p class="note">No character data yet. The ebook ' +
      'processor writes to <code>book_characters</code> per work.</p></div>';
    return;
  }
  if (!charLabWorkId || !works.some(w => w.workId === charLabWorkId)) {
    charLabWorkId = works[0].workId;
  }
  // v395: New navigation — Review | Relationships | Characters
  if (charLabView === 'review') {
    await charLabRenderReview(body, works);
    return;
  }
  if (charLabView === 'relationships') {
    await charLabRenderRelationships(body, works);
    return;
  }
  // Default: Characters view (was 'work')
  const chars = await CharacterStore.listForWork(charLabWorkId);
  charLabRender(body, works, chars);
}

/* v395: Review view — things needing human attention.
   Currently: relationship inbox. Future: characters needing review, identity matches. */
export async function charLabRenderReview(body, works) {
  // For now, Review = Relationship Inbox
  await charLabRenderInbox(body, works);
}

/* Relationships view — a placeholder, not a workspace yet: the graph
   workspace was never built, so this renders a card saying so and
   points at Review, where relationship curation actually happens. */
export async function charLabRenderRelationships(body, works) {
  body.innerHTML = '<div class="ob-card"><h3 class="serif">Relationships</h3>' +
    '<p class="note">Graph workspace coming soon. Use Review for now.</p></div>';
}

/* v397: Shared work deletion (consolidated from inbox + grid duplicates). */
export async function deleteWork(workId, workTitle) {
  if (!await confirmModal('Delete work "' + workTitle + '"? This removes the work, its editions, characters, relationships, claims, and quotes. This cannot be undone.', { okLabel: 'Delete', danger: true })) return;
  try {
    const sb = await CharacterStore._sb();
    // ON DELETE CASCADE handles editions, characters, claims, quotes, links
    const { error } = await sb.from('works').delete().eq('id', workId);
    if (error) throw error;
    toast('Work deleted');
    charLabWorkId = null;
    renderCharacterLab();
  } catch (e) {
    toast('Delete failed: ' + (e.message || 'unknown error'));
  }
}

/* v377: Phase 1 — Relationship Inbox.
   Review pipeline-suggested relationships: Accept / Change / Reject.
   Works against current JSON model; Phase 2 moves to edge table. */
export async function charLabRenderInbox(body, works) {
  // v395: Drive inbox from DB review_status, not localStorage (Claude bug 3)
  // Pipeline JSON items are matched to edge rows; reviewed = edge exists in any status

  if (!charLabWorkId || !works.some(w => w.workId === charLabWorkId)) {
    charLabWorkId = works[0].workId;
  }
  const work = works.find(w => w.workId === charLabWorkId);
  const chars = await CharacterStore.listForWork(charLabWorkId);

  // Get all edge rows for this work's characters (any status)
  let existingEdges = [];
  try {
    const sb = await CharacterStore._sb();
    const charIds = chars.map(c => c.id);
    if (charIds.length) {
      const { data } = await sb.from('character_relationships')
        .select('id, character_a_id, character_b_id, relationship_type, review_status')
        .in('character_a_id', charIds);
      existingEdges = data || [];
    }
  } catch (e) { console.warn('Edge fetch failed', e); }

  // Helper: find edge for a from/to pair (v395: type-agnostic to avoid duplicates — Advisor)
  const findEdge = (fromId, toName) => {
    const toChar = findCharByName(chars, toName);
    if (!toChar) return null;
    return existingEdges.find(e =>
      e.character_a_id === fromId &&
      e.character_b_id === toChar.id
    );
  };

  // v381: Collect pipeline JSON relationships AND user-suggested edges
  const inbox = [];
  chars.forEach(c => {
    (c.relationships || []).forEach((r, idx) => {
      const relId = c.id + ':' + idx;
      const type = String(r.type || 'friend').toLowerCase();
      const toName = String(r.to || '').trim();
      // Skip if an edge row exists (already reviewed in any status)
      if (findEdge(c.id, toName)) return;
      inbox.push({
        id: relId,
        fromId: c.id,
        fromName: c.name,
        toName: toName,
        type: type,
        importance: r.importance || null,
        source: 'pipeline',
      });
    });
  });

  // Add user-suggested edges (pending, created_by != null)
  try {
    const sb = await CharacterStore._sb();
    const charIds = chars.map(c => c.id);
    if (charIds.length) {
      const { data: suggested } = await sb.from('character_relationships')
        .select('id, character_a_id, character_b_id, relationship_type, importance, tags, created_by')
        .in('character_a_id', charIds)
        .eq('review_status', 'pending')
        .not('created_by', 'is', null);
      (suggested || []).forEach(edge => {
        const fromChar = chars.find(c => c.id === edge.character_a_id);
        const toChar = chars.find(c => c.id === edge.character_b_id);
        if (fromChar && toChar) {
          inbox.push({
            id: 'edge:' + edge.id,
            edgeId: edge.id,
            fromId: edge.character_a_id,
            fromName: fromChar.name,
            toName: toChar.name,
            type: edge.relationship_type,
            importance: edge.importance,
            tags: edge.tags || [],
            source: 'user',
          });
        }
      });
    }
  } catch (e) { console.warn('User suggestions fetch failed', e); }

  // Filter out empty targets
  const valid = inbox.filter(r => r.toName);

  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab — Review</h3>' +
    '<p class="note">Keyboard: ↑/↓ navigate · A accept · R reject · 1-5 importance · T cycle type</p>' +
    '<p class="note">' +
    '<button class="btn sm ghost" data-chview="characters">Characters</button> ' +
    '<button class="btn sm ghost" data-chview="relationships">Relationships</button> ' +
    '<button class="btn sm" data-chview="review">Review</button></p>' +
    '<p class="note"><label>Work: <select id="ch-work" class="text-input" style="width:auto;display:inline-block;max-width:280px">' +
    works.map(w => '<option value="' + esc(w.workId) + '"' +
      (w.workId === charLabWorkId ? ' selected' : '') + '>' +
      esc(w.title) + ' (' + w.count + ')</option>').join('') +
    '</select></label> ' +
    '<button class="btn sm ghost" id="ch-refresh">↻</button> ' +
    '<button class="btn sm ghost" id="ch-delete-work" style="color:var(--danger,red)">Delete work</button></p>' +
    '<p class="note">' + valid.length + ' relationships awaiting review in <b>' + esc(work ? work.title : '') + '</b>.</p>';

  // v386: Inbox as data grid
  if (!valid.length) {
    html += '<p class="note">All caught up! No unreviewed relationships.</p>';
  } else {
    html += '<div class="ch-grid-wrap" style="overflow-x:auto"><table class="ch-grid">' +
      '<thead><tr><th>From</th><th>Type</th><th>To</th><th>Importance</th><th>Source</th><th>Actions</th></tr></thead><tbody>';
    valid.forEach(r => {
      html += '<tr data-rel="' + esc(r.id) + '">' +
        '<td><b>' + esc(r.fromName) + '</b></td>' +
        '<td><select class="ch-grid-input" data-rel-type="' + esc(r.id) + '" style="min-width:100px">' +
        ['spouse','partner','parent','child','sibling','friend','enemy','rival','mentor','colleague'].map(t =>
          '<option value="' + t + '"' + (r.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
        '</select></td>' +
        '<td><b>' + esc(r.toName) + '</b></td>' +
        '<td><select class="ch-grid-input" data-rel-imp="' + esc(r.id) + '" style="min-width:60px">' +
        '<option value="">-</option>' +
        [1,2,3,4,5].map(i => '<option value="' + i + '"' + (r.importance == i ? ' selected' : '') + '>' + i + '</option>').join('') +
        '</select></td>' +
        '<td>' + (r.source === 'user' ?
          '<span title="Reader suggestion">🟡</span> <span class="chip">reader</span>' :
          '<span title="Pipeline suggestion">🔵</span> <span class="note">pipeline</span>') +
        (r.tags && r.tags.length ? '<br>' + r.tags.map(t => '<span class="chip sm">' + esc(t) + '</span>').join(' ') : '') + '</td>' +
        '<td style="white-space:nowrap">' +
        '<button class="btn sm" data-rel-accept="' + esc(r.id) + '">✓</button> ' +
        '<button class="btn sm ghost" data-rel-reject="' + esc(r.id) + '">✕</button>' +
        '</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  body.innerHTML = html;

  // Wire view toggle (v389: was renderAdminBody which lands on Analytics — Claude caught it)
  body.querySelectorAll('[data-chview]').forEach(b => b.addEventListener('click', () => {
    charLabView = b.getAttribute('data-chview');
    renderCharacterLab();
  }));
  document.getElementById('ch-work').addEventListener('change', e => {
    charLabWorkId = e.target.value;
    charLabRenderInbox(body, works);
  });
  document.getElementById('ch-refresh').addEventListener('click', () => charLabRenderInbox(body, works));
  document.getElementById('ch-delete-work').addEventListener('click', () => {
    deleteWork(charLabWorkId, work ? work.title : charLabWorkId);
  });

  // Wire accept/reject (v395: DB-driven, no localStorage)
  // v387: Inbox dropdowns save on change (Advisor MEDIUM — were decorative)
  body.querySelectorAll('[data-rel-type]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const relId = sel.getAttribute('data-rel-type');
      const newType = sel.value;
      // Store pending change — applied on Accept
      sel.closest('tr').dataset.pendingType = newType;
      sel.style.borderColor = 'var(--gold)';
    });
  });
  body.querySelectorAll('[data-rel-imp]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const relId = sel.getAttribute('data-rel-imp');
      const newImp = sel.value;
      sel.closest('tr').dataset.pendingImp = newImp;
      sel.style.borderColor = 'var(--gold)';
    });
  });

  body.querySelectorAll('[data-rel-accept]').forEach(b => b.addEventListener('click', async () => {
    const relId = b.getAttribute('data-rel-accept');
    const item = b.closest('tr[data-rel]');
    // v381: handle both edge IDs (user suggestions) and JSON relIds (pipeline)
    // v387: apply pending type/imp changes from dropdowns
    const row = item;
    const pendingType = row.dataset.pendingType;
    const pendingImp = row.dataset.pendingImp;
    try {
      if (relId.startsWith('edge:')) {
        // User suggestion — flip to confirmed (with pending changes)
        const edgeId = relId.slice(5);
        const updates = { review_status: 'confirmed' };
        if (pendingType) updates.relationship_type = pendingType;
        if (pendingImp) updates.importance = parseInt(pendingImp, 10) || null;
        await CharacterStore.updateRelationship(edgeId, updates);
      } else {
        // Pipeline JSON — upsert as before (v380)
        // v388: apply pending dropdown changes (Advisor — were silently discarded)
        const [fromId, idx] = relId.split(':');
        const chars = await CharacterStore.listForWork(charLabWorkId);
        const fromChar = chars.find(c => c.id === fromId);
        if (fromChar && fromChar.relationships && fromChar.relationships[idx]) {
          const r = fromChar.relationships[idx];
          const toName = String(r.to || '').trim();
          const origType = String(r.type || 'friend').toLowerCase();
          const newType = pendingType || origType;
          const newImp = pendingImp ? parseInt(pendingImp, 10) || null : (r.importance || null);
          const toChar = findCharByName(chars, toName);
          if (toChar) {
            const sb = await CharacterStore._sb();
            // Look up by ORIGINAL type (backfilled row) — not newType
            const { data: existing } = await sb.from('character_relationships')
              .select('id')
              .eq('character_a_id', fromId)
              .eq('character_b_id', toChar.id)
              .eq('relationship_type', origType)
              .eq('review_status', 'pending')
              .maybeSingle();
            if (existing) {
              await CharacterStore.updateRelationship(existing.id, {
                review_status: 'confirmed',
                relationship_type: newType,
                importance: newImp,
              });
            } else {
              await CharacterStore.createRelationship(fromId, toChar.id, newType, {
                direction: 'mutual',
                importance: newImp,
                workId: charLabWorkId,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Edge upsert failed', e);
      toast('Accept failed: ' + (e.message || 'unknown error'));
      return; // v389: don't mark reviewed on failure (Claude)
    }
    // v395: re-render to reflect DB state
    charLabRenderInbox(body, works);
    item.querySelectorAll('button').forEach(x => x.disabled = true);
    toast('Relationship accepted');
  }));

  body.querySelectorAll('[data-rel-reject]').forEach(b => b.addEventListener('click', async () => {
    const relId = b.getAttribute('data-rel-reject');
    try {
      if (relId.startsWith('edge:')) {
        const edgeId = relId.slice(5);
        await CharacterStore.updateRelationship(edgeId, { review_status: 'rejected' });
      } else {
        // v395: Pipeline JSON — create rejected edge so it's tracked in DB (Claude bug 3)
        const [fromId, idx] = relId.split(':');
        const chars = await CharacterStore.listForWork(charLabWorkId);
        const fromChar = chars.find(c => c.id === fromId);
        if (fromChar && fromChar.relationships && fromChar.relationships[idx]) {
          const r = fromChar.relationships[idx];
          const toName = String(r.to || '').trim();
          const toChar = findCharByName(chars, toName);
          if (toChar) {
            await CharacterStore.createRelationship(fromId, toChar.id, String(r.type || 'friend').toLowerCase(), {
              direction: 'mutual',
              importance: r.importance || null,
              workId: charLabWorkId,
              review_status: 'rejected',
            });
          }
        }
      }
    } catch (e) {
      console.warn('Reject failed', e);
      toast('Reject failed: ' + (e.message || 'unknown error'));
      return;
    }
    // v395: re-render to reflect DB state
    charLabRenderInbox(body, works);
    toast('Relationship rejected');
  }));

  // v386: Change is now inline via dropdowns (no dialog needed)

  // v395: Keyboard-driven inbox (Claude — biggest time saver)
  // ↑/↓ navigate, A accept, R reject, 1-5 importance, T cycle type
  let kbIndex = 0;
  const rows = () => [...body.querySelectorAll('tr[data-rel]')];
  const highlightRow = (idx) => {
    rows().forEach((r, i) => r.classList.toggle('kb-sel', i === idx));
    const row = rows()[idx];
    if (row) row.scrollIntoView({ block: 'nearest' });
  };
  const kbHandler = (e) => {
    // Only when inbox is visible and not typing in an input
    if (!body.contains(document.activeElement) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const rs = rows();
    if (!rs.length) return;
    const row = rs[kbIndex];
    if (!row) return;

    if (e.key === 'ArrowDown') { kbIndex = Math.min(kbIndex + 1, rs.length - 1); highlightRow(kbIndex); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { kbIndex = Math.max(kbIndex - 1, 0); highlightRow(kbIndex); e.preventDefault(); }
    else if (e.key === 'a' || e.key === 'A') { row.querySelector('[data-rel-accept]')?.click(); }
    else if (e.key === 'r' || e.key === 'R') { row.querySelector('[data-rel-reject]')?.click(); }
    else if (e.key >= '1' && e.key <= '5') {
      const sel = row.querySelector('[data-rel-imp]');
      if (sel) { sel.value = e.key; sel.dispatchEvent(new Event('change')); }
    }
    else if (e.key === 't' || e.key === 'T') {
      const sel = row.querySelector('[data-rel-type]');
      if (sel) {
        const opts = [...sel.options];
        const next = (sel.selectedIndex + 1) % opts.length;
        sel.selectedIndex = next;
        sel.dispatchEvent(new Event('change'));
      }
    }
  };
  // v395: Remove old handler before adding (Advisor HIGH — was leaking)
  if (body._kbHandler) document.removeEventListener('keydown', body._kbHandler);
  document.addEventListener('keydown', kbHandler);
  body._kbHandler = kbHandler;
  highlightRow(0);

  if (charLabCanonicalId) await charLabCanonDetail();
}

export function charLabWireViewToggle(body) {
  body.querySelectorAll('[data-chview]').forEach(b => b.addEventListener('click', () => {
    charLabView = b.getAttribute('data-chview');
    renderCharacterLab();
  }));
}

/* Unified character detail: all linked instances, merged relationships
   labeled by book, and unlink controls. */
export async function charLabCanonDetail() {
  const el = document.getElementById('ch-canon-detail');
  if (!el || !charLabCanonicalId) { if (el) el.innerHTML = ''; return; }
  el.innerHTML = '<p class="note">Loading…</p>';
  const d = await CharacterStore.getCanonicalDetail(charLabCanonicalId);
  if (!d) { el.innerHTML = '<p class="note">Character not found.</p>'; return; }

  let html = '<div class="ob-card"><h3 class="serif">' + esc(d.name) + '</h3>';
  if (d.description) html += '<p>' + esc(d.description) + '</p>';
  html += '<h4 class="serif">Appears in (' + d.instances.length + ')</h4>';
  d.instances.forEach(inst => {
    html += '<div class="ch-instance"><p><b>' + esc(inst.workTitle) + '</b> ' +
      '<span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[inst.role] || inst.role || '?') + '</span> ' +
      '<span class="note">as "' + esc(inst.name) + '"</span> ' +
      '<button class="btn sm ghost" data-chunlink="' + esc(inst.id) + '">Unlink</button></p>';
    if (inst.description) html += '<p class="note">' + esc(inst.description) + '</p>';
    if (inst.relationships.length) {
      html += '<p class="note">Relationships in this book:</p><p>';
      html += inst.relationships.map(r =>
        '<span class="chip">' + esc(charNormRelType(r.type)) + '</span> ' + esc(r.to)
      ).join(' · ');
      html += '</p>';
    }
    html += '</div>';
  });
  html += '<p class="note" id="ch-unlink-msg"></p></div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-chunlink]').forEach(b => b.addEventListener('click', async () => {
    const rowId = b.getAttribute('data-chunlink');
    if (!await confirmModal('Unlink this appearance from ' + d.name + '?', { okLabel: 'Unlink' })) return;
    b.disabled = true;
    try {
      await CharacterStore.unlink(rowId);
      await charLabCanonDetail();
    } catch (e) {
      b.disabled = false;
      document.getElementById('ch-unlink-msg').textContent = 'Failed: ' + ((e && e.message) || e);
    }
  }));
}

export function charLabRender(body, works, chars) {
  const work = works.find(w => w.workId === charLabWorkId);
  const rf = charLabRoleFilter;
  // v317: blocked names hidden unless toggled; v321: merged hidden too
  const unmerged = chars.filter(c => c.status !== 'merged');
  const mergedCount = chars.length - unmerged.length;
  const visible = charLabShowBlocked ? unmerged : unmerged.filter(c => !charIsBlocked(c));
  const blockedCount = unmerged.length - visible.length;
  const filtered = rf ? visible.filter(c => c.role === rf) : visible;

  // Role counts for filter chips (over visible set)
  const roleCounts = {};
  CHAR_ROLES.forEach(r => { roleCounts[r] = visible.filter(c => c.role === r).length; });

  // v577: merged characters (hidden from the grid) surface here for unmerge
  const mergedChars = chars.filter(c => c.status === 'merged');

  // Duplicate detection
  const dupes = charFindDuplicates(visible);
  const dupeIds = new Set();
  dupes.forEach(([a, b]) => { dupeIds.add(a.id); dupeIds.add(b.id); });

  let html = '<div class="ob-card"><h3 class="serif">' + icon('friends') +
    ' Character Lab</h3>' +
    '<p class="note">' +
    '<button class="btn sm" data-chview="characters">Characters</button> ' +

    '<button class="btn sm ghost" data-chview="relationships">Relationships</button> ' +
    '<button class="btn sm ghost" data-chview="review">Review</button></p>' +
    '<p class="note"><label>Work: <select id="ch-work" class="text-input" style="width:auto;display:inline-block;max-width:280px">' +
    works.map(w => '<option value="' + esc(w.workId) + '"' +
      (w.workId === charLabWorkId ? ' selected' : '') + '>' +
      esc(w.title) + ' (' + w.count + ')</option>').join('') +
    '</select></label> ' +
    '<button class="btn sm ghost" id="ch-refresh">↻</button> ' +
    '<button class="btn sm ghost" id="ch-delete-work2" style="color:var(--danger,red)">Delete work</button>' +
    (blockedCount ? ' <button class="btn sm ghost" id="ch-blocked-toggle">' +
      (charLabShowBlocked ? 'Hide' : 'Show') + ' ' + blockedCount + ' hidden</button>' : '') +
    (mergedCount ? ' <span class="note">' + mergedCount + ' merged</span>' : '') +
    '</p>' +
    (dupes.length ? '<div class="ob-card" style="border-color:var(--warn,orange)">' +
      '<h4 class="serif">' + icon('warn') + ' Possible duplicates (' + dupes.length + ')</h4>' +
      dupes.map(([a, b, kind], i) =>
        '<p><b>' + esc(a.name) + '</b> ↔ <b>' + esc(b.name) + '</b> ' +
        '<span class="note">(' + esc(kind) + ' match)</span><br>' +
        '<button class="btn sm" data-chmerge="' + i + '" data-keep="' + esc(a.id) + '">Keep ' +
        esc(a.name) + '</button> ' +
        '<button class="btn sm ghost" data-chmerge="' + i + '" data-keep="' + esc(b.id) + '">Keep ' +
        esc(b.name) + '</button></p>').join('') +
      '<p class="note" id="ch-merge-msg"></p></div>' : '') +
    (mergedChars.length ? '<div class="ob-card">' +
      '<h4 class="serif">' + icon('friends') + ' Merged characters</h4>' +
      // v578 (spec §1): the count line counts RESTORABLE merges only —
      // the UI never implies a restorable total it can't deliver.
      '<p class="note">' + mergedChars.filter(c => c.mergeSnapshot).length + ' can be restored</p>' +
      mergedChars.map(c => {
        const w = chars.find(x => x.id === c.duplicateOf);
        return '<p><b>' + esc(c.name) + '</b> <span class="note">merged into <b>' +
          esc(w ? w.name : 'a character no longer in this work') + '</b></span><br>' +
          (c.mergeSnapshot
            ? '<span class="note">' + esc(charMergeHistoryLine(c)) + '</span><br>' +
              '<button class="btn sm" data-chrestore="' + esc(c.id) + '">Review restore…</button>'
            : '<span class="note">No snapshot — can\'t be restored</span>') +
          '</p>';
      }).join('') + '</div>' : '') +
    '<p class="note">' +
    '<button class="btn sm' + (!rf ? '' : ' ghost') + '" data-chrole="">All (' + chars.length + ')</button> ' +
    CHAR_ROLES.map(r =>
      '<button class="btn sm' + (rf === r ? '' : ' ghost') + '" data-chrole="' + r + '">' +
      CHAR_ROLE_LABELS[r] + ' (' + roleCounts[r] + ')</button>').join(' ') +
    '</p>';

  // v385: Desktop data grid (rows/columns, inline editing)
  if (!filtered.length) {
    html += '<p class="note">No characters with this role.</p>';
  } else {
    html += '<div class="ch-grid-wrap" style="overflow-x:auto"><table class="ch-grid">' +
      '<thead><tr>' +
      '<th><input type="checkbox" id="ch-select-all"></th>' +
      '<th>Name</th><th>Role</th><th>Status</th><th>Rels</th><th>Actions</th>' +
      '</tr></thead><tbody>';
    filtered.forEach(c => {
      const relCount = (c.relationships || []).length;
      html += '<tr data-chid="' + esc(c.id) + '"' + (c.id === charLabSelectedId ? ' class="sel"' : '') + '>' +
        '<td><input type="checkbox" class="ch-select" value="' + esc(c.id) + '"></td>' +
        '<td><input type="text" class="ch-grid-input" data-field="name" data-id="' + esc(c.id) + '" value="' + esc(c.name || '') + '"></td>' +
        '<td><select class="ch-grid-input" data-field="role" data-id="' + esc(c.id) + '">' +
        CHAR_ROLES.map(r => '<option value="' + r + '"' + (c.role === r ? ' selected' : '') + '>' + CHAR_ROLE_LABELS[r] + '</option>').join('') +
        '</select></td>' +
        '<td><select class="ch-grid-input" data-field="vitality" data-id="' + esc(c.id) + '">' +
        ['alive', 'dead', 'unknown', 'missing'].map(st => '<option value="' + st + '"' + (c.vitality === st ? ' selected' : '') + '>' + st + '</option>').join('') +
        '</select></td>' +
        '<td>' + relCount + '</td>' +
        '<td><button class="btn sm ghost" data-chdetail="' + esc(c.id) + '">Detail</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div><div id="ch-detail"></div>';
  body.innerHTML = html;

  // Wire work selector
  document.getElementById('ch-work').addEventListener('change', async (e) => {
    charLabWorkId = e.target.value;
    charLabSelectedId = null;
    const nc = await CharacterStore.listForWork(charLabWorkId);
    charLabRender(body, works, nc);
  });
  charLabWireViewToggle(body);
  document.getElementById('ch-refresh').addEventListener('click', async () => {
    const nc = await CharacterStore.listForWork(charLabWorkId);
    charLabRender(body, works, nc);
  });
  // v397: Delete work from grid view (uses shared deleteWork)
  const delBtn2 = document.getElementById('ch-delete-work2');
  if (delBtn2) delBtn2.addEventListener('click', () => {
    deleteWork(charLabWorkId, work ? work.title : charLabWorkId);
  });
  const blockedToggle = document.getElementById('ch-blocked-toggle');
  if (blockedToggle) blockedToggle.addEventListener('click', () => {
    charLabShowBlocked = !charLabShowBlocked;
    charLabRender(body, works, chars);
  });
  // v385: Grid inline editing
  body.querySelectorAll('.ch-grid-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const id = inp.getAttribute('data-id');
      const field = inp.getAttribute('data-field');
      // v387: whitelist fields (Advisor MEDIUM — prevent mass assignment)
      if (!['name', 'role', 'vitality'].includes(field)) return;
      const val = inp.value;
      try {
        const sb = await CharacterStore._sb();
        const updates = {};
        updates[field] = val;
        const { error } = await sb.from('book_characters').update(updates).eq('id', id);
        if (error) throw error;
        // v391: update local chars array so filters see the change (Claude bug 4)
        const local = chars.find(c => c.id === id);
        if (local) local[field] = val;
        inp.style.borderColor = 'var(--gold)';
        setTimeout(() => inp.style.borderColor = '', 800);
      } catch (e) {
        toast('Save failed: ' + e.message);
        inp.style.borderColor = 'red';
      }
    });
  });

  // v385: Grid detail buttons
  body.querySelectorAll('[data-chdetail]').forEach(b => b.addEventListener('click', () => {
    charLabSelectedId = b.getAttribute('data-chdetail');
    charLabRender(body, works, chars);
    // Scroll to detail
    const detail = document.getElementById('ch-detail');
    if (detail) detail.scrollIntoView({ behavior: 'smooth' });
  }));

  // v385: Select all
  const selAll = document.getElementById('ch-select-all');
  if (selAll) selAll.addEventListener('change', () => {
    body.querySelectorAll('.ch-select').forEach(cb => cb.checked = selAll.checked);
  });

  body.querySelectorAll('[data-chmerge]').forEach(b => b.addEventListener('click', async () => {
    const idx = Number(b.getAttribute('data-chmerge'));
    const keepId = b.getAttribute('data-keep');
    const [a, bb] = dupes[idx];
    const loserId = a.id === keepId ? bb.id : a.id;
    const msg = document.getElementById('ch-merge-msg');
    // v352: in-app confirm
    if (!await confirmModal('Merge "' + (a.id === keepId ? bb.name : a.name) + '" into "' +
        (a.id === keepId ? a.name : bb.name) + '"? Relationships will be repointed.', { okLabel: 'Merge' })) return;
    b.disabled = true;
    if (msg) msg.textContent = 'Merging…';
    const err = await charMerge(keepId, loserId, chars);
    if (err) {
      if (msg) msg.textContent = 'Merge failed: ' + err;
      b.disabled = false;
      return;
    }
    if (charLabSelectedId === loserId) charLabSelectedId = keepId;
    charLabRender(body, works, chars);
  }));

  // v578: restore always starts from the preview sheet (spec §1/§2) —
  // nothing restores from the list itself. Legacy merges have no button;
  // charUnmerge refuses them again server-side regardless.
  body.querySelectorAll('[data-chrestore]').forEach(b => b.addEventListener('click', () => {
    openCharRestoreSheet(b.getAttribute('data-chrestore'), { body, works, chars });
  }));
  document.querySelectorAll('[data-chrole]').forEach(b => b.addEventListener('click', () => {
    charLabRoleFilter = b.getAttribute('data-chrole');
    charLabRender(body, works, chars);
  }));
  // Wire character selection
  body.querySelectorAll('[data-chid]').forEach(b => b.addEventListener('click', () => {
    charLabSelectedId = b.getAttribute('data-chid');
    body.querySelectorAll('.ch-card').forEach(x =>
      x.classList.toggle('sel', x.getAttribute('data-chid') === charLabSelectedId));
    charLabDetail(chars);
  }));
  // Restore detail if a character was selected
  if (charLabSelectedId) charLabDetail(chars);
}

/* Character detail panel with relationship tracing. Clicking a resolved
   relationship target navigates to that character (trace the graph). */
export function charLabDetail(chars) {
  const el = document.getElementById('ch-detail');
  if (!el) return;
  const c = chars.find(x => x.id === charLabSelectedId);
  if (!c) { el.innerHTML = ''; return; }

  // Group relationships by normalized type
  const byType = {};
  c.relationships.forEach(r => {
    const t = charNormRelType(r.type);
    (byType[t] || (byType[t] = [])).push(r);
  });

  // Reverse relationships: who points TO this character
  const mentionedBy = [];
  chars.forEach(o => {
    if (o.id === c.id) return;
    o.relationships.forEach(r => {
      const res = charResolveTarget(r.to, chars);
      if (res.character && res.character.id === c.id) {
        mentionedBy.push({ from: o, type: charNormRelType(r.type) });
      }
    });
  });

  let html = '<div class="ob-card"><h3 class="serif">' + esc(c.name) + '</h3>' +
    '<p><span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[c.role] || c.role) + '</span>' +
    (c.confidence != null ? ' <span class="note">' + Math.round(Number(c.confidence) * 100) + '% confidence</span>' : '') +
    ' <span class="chip">' + esc(c.status || 'candidate') + '</span></p>' +
    (c.status === 'candidate'
      ? '<p><button class="btn sm" data-chstatus="confirmed" data-chid="' + esc(c.id) + '">✓ Confirm</button> ' +
        '<button class="btn sm ghost" data-chstatus="rejected" data-chid="' + esc(c.id) + '">✕ Reject</button></p>'
      : '') +
    '<p>' + (c.characterId
      ? '<span class="note">Linked to canonical character</span> ' +
        '<button class="btn sm ghost" data-chunlink-row="' + esc(c.id) + '">Unlink</button>'
      : '<button class="btn sm" id="ch-link-btn" data-chid="' + esc(c.id) + '">Link to character…</button>') +
    '</p>' +
    (!c.characterId && c.suggestedCharacterId
      ? '<div class="ob-card" style="border-color:var(--accent)"><p>' +
        '<b>Pipeline suggests:</b> <span id="ch-suggest-name">loading…</span><br>' +
        '<button class="btn sm" data-chsuggest-accept="' + esc(c.id) + '">Accept</button> ' +
        '<button class="btn sm ghost" data-chsuggest-reject="' + esc(c.id) + '">Reject</button></p></div>'
      : '') +
    '<div id="ch-link-ui"></div>';
  if (c.description) html += '<p>' + esc(c.description) + '</p>';

  // v578 (spec §4): merge history — one line per snapshot-backed merge
  // into this character. A restored merge's line leaves with it: the
  // loser is no longer status='merged' and its snapshot is cleared.
  const mergesIn = chars.filter(x =>
    x.status === 'merged' && x.duplicateOf === c.id && x.mergeSnapshot);
  if (mergesIn.length) {
    html += '<h4 class="serif">Merge history</h4>' + mergesIn.map(l =>
      '<p class="note">' + esc(charMergeHistoryLine(l)) + '</p>').join('');
  }

  // Outgoing relationships
  const types = Object.keys(byType).sort();
  if (types.length) {
    html += '<h4 class="serif">Relationships (' + c.relationships.length + ')</h4>';
    types.forEach(t => {
      html += '<p><b>' + esc(t) + ':</b> ';
      html += byType[t].map(r => {
        const res = charResolveTarget(r.to, chars);
        if (res.character) {
          return '<button class="taplink" data-chtrace="' + esc(res.character.id) + '"' +
            (res.fuzzy ? ' title="Fuzzy match"' : '') + '>' +
            esc(res.character.name) + (res.fuzzy ? ' ~' : '') + '</button>';
        }
        return '<span class="chip" title="Unresolved reference">? ' + esc(res.unresolved) + '</span>';
      }).join(' · ');
      html += '</p>';
    });
  } else {
    html += '<p class="note">No recorded relationships.</p>';
  }

  // Incoming relationships
  if (mentionedBy.length) {
    html += '<h4 class="serif">Mentioned by (' + mentionedBy.length + ')</h4><p>';
    html += mentionedBy.map(m =>
      '<button class="taplink" data-chtrace="' + esc(m.from.id) + '">' +
      esc(m.from.name) + '</button> <span class="note">(' + esc(m.type) + ')</span>'
    ).join(' · ');
    html += '</p>';
  }

  html += '</div>';
  el.innerHTML = html;

  // Wire trace navigation
  el.querySelectorAll('[data-chtrace]').forEach(b => b.addEventListener('click', () => {
    charLabSelectedId = b.getAttribute('data-chtrace');
    document.querySelectorAll('.ch-card').forEach(x =>
      x.classList.toggle('sel', x.getAttribute('data-chid') === charLabSelectedId));
    charLabDetail(chars);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  // Wire link button — show canonical picker
  const linkBtn = el.querySelector('#ch-link-btn');
  if (linkBtn) linkBtn.addEventListener('click', async () => {
    const ui = el.querySelector('#ch-link-ui');
    const rowId = linkBtn.getAttribute('data-chid');
    ui.innerHTML = '<p class="note">Loading characters…</p>';
    const canonicals = await CharacterStore.listCanonical();
    // Suggest matches by normalized name
    const norm = CharacterStore.normName(c.name);
    const suggestions = canonicals.filter(cc =>
      CharacterStore.normName(cc.name) === norm ||
      CharacterStore.normName(cc.name).includes(norm) ||
      norm.includes(CharacterStore.normName(cc.name)));
    let h = '<div class="ob-card"><h4 class="serif">Link "' + esc(c.name) + '" to…</h4>';
    if (suggestions.length) {
      h += '<p><b>Suggestions:</b></p>';
      suggestions.forEach(sg => {
        h += '<p><button class="btn sm" data-chdolink="' + esc(sg.id) + '" data-row="' + esc(rowId) + '">' +
          esc(sg.name) + '</button> <span class="note">' + sg.workCount + ' books</span></p>';
      });
    }
    h += '<p><b>All characters:</b> <select id="ch-link-pick" class="text-input" style="width:auto;display:inline-block;max-width:220px">' +
      '<option value="">— pick —</option>' +
      canonicals.filter(cc => !suggestions.some(sg => sg.id === cc.id)).map(cc =>
        '<option value="' + esc(cc.id) + '">' + esc(cc.name) + ' (' + cc.workCount + ')</option>').join('') +
      '</select> <button class="btn sm" id="ch-link-pick-go">Link</button></p>';
    h += '<p><b>Or create new:</b> <input id="ch-link-new" class="text-input" style="width:auto;display:inline-block" placeholder="Character name" value="' + esc(c.name) + '"> ' +
      '<button class="btn sm" id="ch-link-new-go">Create & link</button></p>';
    h += '<p class="note" id="ch-link-msg"></p></div>';
    ui.innerHTML = h;
    const doLink = async (charId) => {
      const msg = ui.querySelector('#ch-link-msg');
      try {
        const sb = await CharacterStore._sb();
        if (!sb) throw new Error('cloud unavailable');
        let userId = null;
        try { const { data: { user } } = await sb.auth.getUser(); userId = user && user.id; } catch (e) {}
        const { error } = await sb.from('character_links').upsert({
          book_character_id: rowId,
          character_id: charId,
          linked_by: userId,
        }, { onConflict: 'book_character_id' });
        if (error) throw error;
        c.characterId = charId;
        charLabDetail(chars);
      } catch (e) { if (msg) msg.textContent = 'Failed: ' + ((e && e.message) || e); }
    };
    ui.querySelectorAll('[data-chdolink]').forEach(b => b.addEventListener('click', () =>
      doLink(b.getAttribute('data-chdolink'))));
    ui.querySelector('#ch-link-pick-go').addEventListener('click', () => {
      const v = ui.querySelector('#ch-link-pick').value;
      if (v) doLink(v);
    });
    ui.querySelector('#ch-link-new-go').addEventListener('click', async () => {
      const v = ui.querySelector('#ch-link-new').value.trim();
      const msg = ui.querySelector('#ch-link-msg');
      if (!v) { if (msg) msg.textContent = 'Enter a name.'; return; }
      try {
        const cid = await CharacterStore.createCanonical(v, c.description, [rowId]);
        c.characterId = cid;
        charLabDetail(chars);
      } catch (e) { if (msg) msg.textContent = 'Failed: ' + ((e && e.message) || e); }
    });
  });
  // Load pipeline suggestion name
  const sugName = el.querySelector('#ch-suggest-name');
  if (sugName && c.suggestedCharacterId) {
    CharacterStore._sb().then(sb => sb && sb.from('characters')
      .select('name').eq('id', c.suggestedCharacterId).maybeSingle()
    ).then(r => {
      if (sugName.isConnected) sugName.textContent =
        (r && r.data && r.data.name) ? '"' + r.data.name + '"' : '(deleted)';
    }).catch(() => { if (sugName.isConnected) sugName.textContent = '(error)'; });
  }
  // Wire suggestion accept/reject
  el.querySelectorAll('[data-chsuggest-accept]').forEach(b => b.addEventListener('click', async () => {
    const rowId = b.getAttribute('data-chsuggest-accept');
    b.disabled = true;
    try {
      const sb = await CharacterStore._sb();
      if (!sb) throw new Error('cloud unavailable');
      let userId = null;
      try { const { data: { user } } = await sb.auth.getUser(); userId = user && user.id; } catch (e) {}
      const { error: lerr } = await sb.from('character_links').upsert({
        book_character_id: rowId,
        character_id: c.suggestedCharacterId,
        linked_by: userId,
        note: 'accepted pipeline suggestion',
      }, { onConflict: 'book_character_id' });
      if (lerr) throw lerr;
      const { error } = await sb.from('book_characters')
        .update({ suggested_character_id: null }).eq('id', rowId);
      if (error) throw error;
      c.characterId = c.suggestedCharacterId;
      c.suggestedCharacterId = null;
      charLabDetail(chars);
    } catch (e) { b.disabled = false; b.title = 'Failed: ' + ((e && e.message) || e); }
  }));
  el.querySelectorAll('[data-chsuggest-reject]').forEach(b => b.addEventListener('click', async () => {
    const rowId = b.getAttribute('data-chsuggest-reject');
    b.disabled = true;
    try {
      const sb = await CharacterStore._sb();
      if (!sb) throw new Error('cloud unavailable');
      const { error } = await sb.from('book_characters')
        .update({ suggested_character_id: null }).eq('id', rowId);
      if (error) throw error;
      c.suggestedCharacterId = null;
      charLabDetail(chars);
    } catch (e) { b.disabled = false; b.title = 'Failed: ' + ((e && e.message) || e); }
  }));
  // Wire unlink from detail
  el.querySelectorAll('[data-chunlink-row]').forEach(b => b.addEventListener('click', async () => {
    if (!await confirmModal('Unlink this character?', { okLabel: 'Unlink' })) return;
    b.disabled = true;
    try {
      await CharacterStore.unlink(b.getAttribute('data-chunlink-row'));
      c.characterId = null;
      charLabDetail(chars);
    } catch (e) { b.disabled = false; b.title = 'Failed: ' + ((e && e.message) || e); }
  }));
  // Wire confirm/reject
  el.querySelectorAll('[data-chstatus]').forEach(b => b.addEventListener('click', async () => {
    const status = b.getAttribute('data-chstatus');
    const cid = b.getAttribute('data-chid');
    b.disabled = true;
    try {
      const sb = await CharacterStore._sb();
      if (!sb) throw new Error('cloud unavailable');
      const { error } = await sb.from('book_characters').update({ status }).eq('id', cid);
      if (error) throw error;
      const ch = chars.find(x => x.id === cid);
      if (ch) ch.status = status;
      charLabDetail(chars);
    } catch (e) {
      b.disabled = false;
      b.title = 'Failed: ' + ((e && e.message) || 'unknown error');
    }
  }));
}

/* Merge two duplicate characters: repoint relationships, soft-merge the loser.
   v321: loser is marked status='merged' with duplicate_of pointing at the
   winner — NOT deleted. Unmerge restores it. Reversible human errors only.
   v577: the repoints are lossy (nothing recorded which relationships the
   merge rewrote), so the merge first computes every write, then stores
   ONE snapshot on the loser row (merge_snapshot) BEFORE any repoint
   lands — pre-merge relationship arrays for the winner and for every
   other character the merge rewrites, plus the loser's pre-merge
   status. The snapshot write is fail-closed: if it errors, the merge
   aborts untouched, so this code can never mint a fresh irreversible
   merge. charUnmerge restores from the snapshot only.
   Never throws — returns error string on failure. */
export async function charMerge(winnerId, loserId, chars) {
  try {
    const sb = await CharacterStore._sb();
    if (!sb) return 'cloud unavailable';
    const winner = chars.find(c => c.id === winnerId);
    const loser = chars.find(c => c.id === loserId);
    if (!winner || !loser) return 'character not found';
    const loserName = String(loser.name).trim().toLowerCase();
    const deepCopy = (v) => JSON.parse(JSON.stringify(Array.isArray(v) ? v : []));
    // Compute every write first (pure): the repointed relationship array
    // for each character the merge changes, remembering the pre-merge
    // array of every non-winner it touches.
    const updates = [];
    const repoints = [];
    for (const c of chars) {
      if (c.id === loserId) continue; // don't touch the loser's own rels
      let changed = false;
      const rels = c.relationships.map(r => {
        if (String(r.to || '').trim().toLowerCase() === loserName) {
          changed = true;
          return Object.assign({}, r, { to: winner.name });
        }
        return r;
      });
      // Merge loser's relationships into winner (dedupe by to+type)
      if (c.id === winnerId) {
        const seen = new Set(rels.map(r =>
          String(r.to).toLowerCase() + '|' + charNormRelType(r.type)));
        loser.relationships.forEach(r => {
          const key = String(r.to).toLowerCase() + '|' + charNormRelType(r.type);
          if (!seen.has(key)) { rels.push(r); seen.add(key); }
        });
        changed = true;
      }
      if (changed) {
        updates.push({ id: c.id, rels });
        if (c.id !== winnerId) repoints.push({ id: c.id, rels: deepCopy(c.relationships) });
      }
    }
    // Record the snapshot on the loser row before any repoint lands.
    let by = null;
    try {
      const { data: { user } } = await sb.auth.getUser();
      by = user ? user.id : null;
    } catch (e) { /* provenance is best-effort, as in character_links */ }
    const snap = {
      v: 1, at: new Date().toISOString(), by,
      winnerId, loserId,
      loserStatus: loser.status || 'candidate',
      winnerRels: deepCopy(winner.relationships),
      repoints,
    };
    const { error: sErr } = await sb.from('book_characters')
      .update({ merge_snapshot: snap }).eq('id', loserId);
    if (sErr) return 'snapshot failed: ' + sErr.message;
    // Apply the repoints (same order and failure behaviour as pre-v577).
    for (const u of updates) {
      const { error } = await sb.from('book_characters')
        .update({ relationships: u.rels }).eq('id', u.id);
      if (error) return 'repoint failed: ' + error.message;
    }
    // Soft-merge: mark loser, point at winner (reversible)
    const { error: mErr } = await sb.from('book_characters')
      .update({ status: 'merged', duplicate_of: winnerId }).eq('id', loserId);
    if (mErr) return 'merge failed: ' + mErr.message;
    loser.status = 'merged';
    loser.duplicateOf = winnerId;
    loser.mergeSnapshot = snap;
    return null;
  } catch (e) { return (e && e.message) || 'unknown error'; }
}

/* Unmerge: restore a soft-merged character.
   v577: restores ONLY from the merge_snapshot charMerge recorded on the
   loser row — the winner's and every repointed character's relationship
   arrays come back verbatim (original entries, direction and evidence
   keys included), and the loser returns to its exact pre-merge status
   (a confirmed character is restored confirmed, a rejected one stays
   rejected — unmerge never launders or resurrects a review state).
   Legacy merges (pre-v577) recorded no snapshot and REFUSE: nothing is
   reconstructed by inference. The loser row is written LAST and the
   snapshot is cleared only in that final write, so a failed unmerge
   leaves the loser still merged with its snapshot intact — every
   restore write is a verbatim snapshot value, so retrying is safe and
   a second unmerge after success refuses as "not merged" instead of
   duplicating anything. Never throws — returns error string on
   failure, null on success. */
export async function charUnmerge(loserId, chars) {
  try {
    const sb = await CharacterStore._sb();
    if (!sb) return 'cloud unavailable';
    const loser = chars.find(c => c.id === loserId);
    if (!loser) return 'character not found';
    // Decide on the server's record, not the possibly stale in-memory copy.
    const { data: row, error: fErr } = await sb.from('book_characters')
      .select('id, status, duplicate_of, merge_snapshot').eq('id', loserId).maybeSingle();
    if (fErr) return 'unmerge failed: ' + fErr.message;
    if (!row) return 'character not found';
    if (row.status !== 'merged') return 'not merged — nothing to restore';
    const snap = row.merge_snapshot;
    if (!snap || !Array.isArray(snap.winnerRels) || !Array.isArray(snap.repoints)) {
      return 'no merge snapshot — cannot restore (this merge predates reversible merges)';
    }
    if (snap.winnerId !== row.duplicate_of || snap.loserId !== loserId) {
      return 'merge snapshot mismatch — cannot restore';
    }
    const winner = chars.find(c => c.id === snap.winnerId);
    if (!winner) return 'winner no longer in this work — cannot restore';
    const deepCopy = (v) => JSON.parse(JSON.stringify(v));
    for (const rp of snap.repoints) {
      const { error } = await sb.from('book_characters')
        .update({ relationships: deepCopy(rp.rels) }).eq('id', rp.id);
      if (error) return 'unmerge failed: ' + error.message;
    }
    const { error: wErr } = await sb.from('book_characters')
      .update({ relationships: deepCopy(snap.winnerRels) }).eq('id', snap.winnerId);
    if (wErr) return 'unmerge failed: ' + wErr.message;
    const { error: lErr } = await sb.from('book_characters')
      .update({ status: snap.loserStatus || 'candidate', duplicate_of: null, merge_snapshot: null })
      .eq('id', loserId);
    if (lErr) return 'unmerge failed: ' + lErr.message;
    loser.status = snap.loserStatus || 'candidate';
    loser.duplicateOf = null;
    loser.mergeSnapshot = null;
    return null;
  } catch (e) { return (e && e.message) || 'unknown error'; }
}

/* ================= v578: Unmerge companions — preview + history =====
   Presentation over the v577 restore core above; charUnmerge's
   semantics are untouched. Design record:
   docs/../prototypes character-unmerge-ui-spec (Designer, 2026-10-15) —
   the card counts restorable merges only, restore always starts from
   the preview sheet, results report in counts, and the winner's
   curation view carries the merge-history lines. The derivations are
   pure functions over the in-memory Lab list + the snapshot, so the
   counts the sheet shows are the counts the restore will perform.
   One copy deviation from the spec, forced by the shipped semantics:
   charUnmerge restores the rewritten relationship lists VERBATIM, so
   entries added to those lists after the merge are rewound, not kept —
   section C therefore enumerates the winner's own snapshot
   relationships as the stays and discloses the rewind, rather than
   claiming post-merge additions to those lists survive. */

export function charUnmergeNameEq(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
export function charUnmergeRelKey(r) {
  return String((r && r.to) || '').trim().toLowerCase() + '|' + charNormRelType(r && r.type);
}

/* The fold set, built exactly as charMerge builds its `seen`: the
   winner's pre-merge relationships with loser-pointing entries
   REPOINTED to the winner's name first, then keyed. charMerge folds a
   loser entry into the winner only when the entry's key is absent from
   this set — so in a mutual same-type pair (winner and loser pointing
   at each other with the same type) the loser's entry keys IN via the
   repoint, never folds, and stays on the loser's own array, which
   merge and unmerge both leave untouched. */
export function charUnmergePostRepointKeys(winnerRels, winnerName, loserName) {
  return new Set((Array.isArray(winnerRels) ? winnerRels : []).map(r =>
    charUnmergeRelKey(charUnmergeNameEq(r.to, loserName)
      ? { to: winnerName, type: r.type } : r)));
}

/* The preview model for restoring `loser` from `winner`: who comes
   back, every move named with its landing place, what stays, and what
   a verbatim restore rewinds. */
export function charUnmergePreview(loser, winner, chars) {
  const snap = (loser && loser.mergeSnapshot) || {};
  const loserName = loser ? loser.name : '';
  const winnerName = winner ? winner.name : '';
  const winnerRels = Array.isArray(snap.winnerRels) ? snap.winnerRels : [];
  const repoints = Array.isArray(snap.repoints) ? snap.repoints : [];
  const loserRels = (loser && Array.isArray(loser.relationships)) ? loser.relationships : [];
  const winnerNow = (winner && Array.isArray(winner.relationships)) ? winner.relationships : [];
  const winnerKeys = new Set(winnerRels.map(charUnmergeRelKey));
  const loserKeys = new Set(loserRels.map(charUnmergeRelKey));
  const postRepointKeys = charUnmergePostRepointKeys(winnerRels, winnerName, loserName);

  // Links back: third-party pointers the merge repointed at the winner.
  const linksBack = [];
  repoints.forEach(rp => {
    const owner = (chars || []).find(c => c.id === rp.id);
    (Array.isArray(rp.rels) ? rp.rels : []).forEach(r => {
      if (charUnmergeNameEq(r.to, loserName)) {
        linksBack.push({ name: owner ? owner.name : '(a character)', type: charNormRelType(r.type) });
      }
    });
  });
  // Relationships back, winner side: the winner's own pointers at the
  // loser, plus the loser entries the merge folded into the winner.
  const relsBack = [];
  winnerRels.forEach(r => {
    if (charUnmergeNameEq(r.to, loserName)) {
      relsBack.push({ name: winnerName, type: charNormRelType(r.type) });
    }
  });
  // Folded-in loser entries — tested against the POST-REPOINT set
  // (charMerge's `seen`), not the raw snapshot keys: against the raw
  // keys a mutual same-type entry would be listed as moving back when
  // it never folded and never moves.
  loserRels.forEach(r => {
    if (!postRepointKeys.has(charUnmergeRelKey(r))) {
      relsBack.push({ name: String(r.to || ''), type: charNormRelType(r.type) });
    }
  });
  // Stays: the winner's own pre-merge relationships that never involved
  // the loser — the winner's throughout, before and after the restore.
  const staysList = [];
  winnerRels.forEach(r => {
    if (!charUnmergeNameEq(r.to, loserName)) {
      staysList.push({ name: String(r.to || ''), type: charNormRelType(r.type) });
    }
  });
  // Rewound: entries on the winner NOW that the snapshot does not know
  // (added after the merge). Verbatim restore takes them off again.
  const rewound = [];
  winnerNow.forEach(e => {
    const k = charUnmergeRelKey(e);
    if (winnerKeys.has(k) || loserKeys.has(k)) return;
    const isRepointedOwn = winnerRels.some(w =>
      charNormRelType(w.type) === charNormRelType(e.type) &&
      charUnmergeNameEq(w.to, loserName) && charUnmergeNameEq(e.to, winnerName));
    if (!isRepointedOwn) rewound.push({ name: String(e.to || ''), type: charNormRelType(e.type) });
  });
  return {
    loserId: loser ? loser.id : null, loserName,
    winnerId: winner ? winner.id : null, winnerName,
    returnsAs: snap.loserStatus || 'candidate',
    linksBack, relsBack,
    movesBack: linksBack.concat(relsBack),
    staysList, rewound,
    counts: { links: linksBack.length, relationships: relsBack.length, stays: staysList.length },
    // internals for charUnmergeOutcome's post-hoc count
    winnerRels, repoints, loserRels,
  };
}

/* Long-list window for the preview sections: first 8, then "+N more"
   expanding in place (spec §2). */
export function charUnmergeListWindow(items, expanded) {
  const list = Array.isArray(items) ? items : [];
  if (expanded || list.length <= 8) return { shown: list.slice(), moreCount: 0 };
  return { shown: list.slice(0, 8), moreCount: list.length - 8 };
}

/* Post-hoc movement count against a freshly read Lab list — how the
   partial-failure result reports what actually landed. An entry counts
   as back when the state charUnmerge writes verbatim is present: a
   third-party pointer naming the loser again, a winner pointer back in
   the snapshot array, a folded-in copy gone from the winner. */
export function charUnmergeOutcome(preview, charsAfter) {
  const chars = Array.isArray(charsAfter) ? charsAfter : [];
  const byId = id => chars.find(c => c.id === id);
  let linksMoved = 0;
  (preview.repoints || []).forEach(rp => {
    const now = byId(rp.id);
    if (!now || !Array.isArray(now.relationships)) return;
    const avail = now.relationships.filter(r => charUnmergeNameEq(r.to, preview.loserName));
    (Array.isArray(rp.rels) ? rp.rels : []).forEach(r => {
      if (!charUnmergeNameEq(r.to, preview.loserName)) return;
      const i = avail.findIndex(x => charNormRelType(x.type) === charNormRelType(r.type));
      if (i >= 0) { linksMoved++; avail.splice(i, 1); }
    });
  });
  let relsMoved = 0;
  const w = byId(preview.winnerId);
  if (w && Array.isArray(w.relationships)) {
    const wKeys = new Set(w.relationships.map(charUnmergeRelKey));
    const postRepointKeys = charUnmergePostRepointKeys(
      preview.winnerRels, preview.winnerName, preview.loserName);
    (preview.winnerRels || []).forEach(r => {
      if (charUnmergeNameEq(r.to, preview.loserName) && wKeys.has(charUnmergeRelKey(r))) relsMoved++;
    });
    (preview.loserRels || []).forEach(r => {
      const k = charUnmergeRelKey(r);
      if (!postRepointKeys.has(k) && !wKeys.has(k)) relsMoved++;
    });
  }
  const loserAfter = byId(preview.loserId);
  return {
    linksMoved, relsMoved,
    finished: !!loserAfter && loserAfter.status !== 'merged',
  };
}

export function charUnmergeCounted(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* The result-state text model (spec §3): counts, never a bare "Done";
   a partial failure gets its own heading and of-total counts. */
export function charUnmergeResultModel(preview, outcome) {
  const p = preview;
  if (!outcome || outcome.finished) {
    const links = outcome ? outcome.linksMoved : p.counts.links;
    const rels = outcome ? outcome.relsMoved : p.counts.relationships;
    return {
      done: true,
      heading: p.loserName + ' is back.',
      countsLine: charUnmergeCounted(links, 'link', 'links') + ' moved back · ' +
        charUnmergeCounted(rels, 'relationship', 'relationships') + ' restored',
      staysLine: p.counts.stays
        ? charUnmergeCounted(p.counts.stays, 'item', 'items') + ' stayed with ' + p.winnerName
        : null,
      statusLine: p.loserName + ' returns as ' + p.returnsAs + '.',
    };
  }
  return {
    done: false,
    heading: "Restore didn't finish",
    countsLine: outcome.linksMoved + ' of ' + charUnmergeCounted(p.counts.links, 'link', 'links') +
      ' moved back · ' + outcome.relsMoved + ' of ' +
      charUnmergeCounted(p.counts.relationships, 'relationship', 'relationships') + ' restored',
    staysLine: null,
    statusLine: null,
  };
}

/* Spec §4: "Merged from {loser} · by {by} · {when}". The snapshot
   carries `at`; a snapshot without one reads "date not recorded" —
   never an invented date. Returns null for snapshot-less merges. */
export function charMergeHistoryLine(loser) {
  const snap = loser && loser.mergeSnapshot;
  if (!snap) return null;
  const when = snap.at ? (fmtDate(snap.at) || 'date not recorded') : 'date not recorded';
  return 'Merged from ' + (loser.name || '') + ' · by ' + (snap.by || 'unknown') + ' · ' + when;
}

/* ---- the preview / result sheet ---- */
export let chRestoreState = null; // { ctx, loserId, preview, expandedB, expandedC, phase, outcome, err, busy }
export let chRestoreToken = null;

export function openCharRestoreSheet(loserId, ctx) {
  const loser = ctx.chars.find(c => c.id === loserId);
  const winner = loser ? ctx.chars.find(c => c.id === loser.duplicateOf) : null;
  if (!loser || !loser.mergeSnapshot) return;
  if (!winner) { // same refusal charUnmerge would give — say it, don't swallow the click
    if (typeof toast === 'function') toast('Winner no longer in this work — cannot restore');
    return;
  }
  closeCharRestoreSheet();
  chRestoreState = {
    ctx, loserId,
    preview: charUnmergePreview(loser, winner, ctx.chars),
    expandedB: false, expandedC: false,
    phase: 'preview', outcome: null, err: null, busy: false,
  };
  const ov = document.createElement('div');
  ov.className = 'modal-backdrop';
  ov.id = 'ch-restore-back';
  ov.innerHTML =
    '<div class="modal" id="ch-restore-sheet" role="dialog" aria-modal="true" ' +
    'aria-label="Restore ' + esc(loser.name) + '">' +
    '<div class="sheet-grabber"></div><div id="ch-restore-body"></div></div>';
  document.body.appendChild(ov);
  if (typeof overlayOpened === 'function') {
    chRestoreToken = overlayOpened('char-restore', closeCharRestoreSheet);
  }
  // App rule: every sheet ships swipe-down-to-dismiss via the shared
  // helper in js/055. See ADR-009.
  if (typeof wireSheetDrag === 'function') {
    wireSheetDrag(ov.querySelector('#ch-restore-sheet'), closeCharRestoreSheet);
  }
  ov.addEventListener('click', e => { if (e.target === ov) closeCharRestoreSheet(); });
  ov.addEventListener('keydown', e => { if (e.key === 'Escape') closeCharRestoreSheet(); });
  chRestoreRender();
}

export function closeCharRestoreSheet() {
  if (chRestoreToken != null) {
    const t = chRestoreToken; chRestoreToken = null;
    if (typeof overlayClosed === 'function') overlayClosed(t);
  }
  const ov = document.getElementById('ch-restore-back');
  if (ov) ov.remove();
  chRestoreState = null;
}

export function chRestoreItemLines(items, lands, tail) {
  return items.map(it =>
    '<p>' + esc(it.name) + ' — ' + esc(it.type) + ' ' + tail + ' ' + esc(lands) + '</p>').join('');
}

export function chRestorePreviewHtml(st) {
  const p = st.preview;
  const winB = charUnmergeListWindow(p.movesBack, st.expandedB);
  const winC = charUnmergeListWindow(p.staysList, st.expandedC);
  return '<h3 class="serif">Restore ' + esc(p.loserName) + '?</h3>' +
    '<h4 class="serif">Who comes back</h4>' +
    '<p><b>' + esc(p.loserName) + '</b> returns as its own character.<br>' +
    'Returns as: ' + esc(p.returnsAs) + '.</p>' +
    '<h4 class="serif">What moves back</h4>' +
    (winB.shown.length
      ? chRestoreItemLines(winB.shown, p.loserName, 'returns to')
      : '<p class="note">Nothing to move — the merge rewrote no relationships.</p>') +
    (winB.moreCount
      ? '<p><button class="taplink" data-chmore="b">+ ' + winB.moreCount + ' more</button></p>' : '') +
    '<h4 class="serif">Stays with ' + esc(p.winnerName) + '</h4>' +
    '<p class="note">Everything on ' + esc(p.winnerName) + ' that isn\'t listed above stays with ' +
    esc(p.winnerName) + '. Its relationship list returns to the merge snapshot, so changes made to ' +
    'the rewritten lists since the merge are rewound.</p>' +
    (winC.shown.length ? chRestoreItemLines(winC.shown, p.winnerName, 'stays with') : '') +
    (winC.moreCount
      ? '<p><button class="taplink" data-chmore="c">+ ' + winC.moreCount + ' more</button></p>' : '') +
    (p.rewound.length
      ? '<p class="note">Added to ' + esc(p.winnerName) + ' since the merge — these come off when ' +
        'the snapshot is restored:</p>' +
        p.rewound.map(it => '<p>' + esc(it.name) + ' — ' + esc(it.type) + '</p>').join('')
      : '') +
    (st.err ? '<p class="note" style="color:var(--danger,red)">' + esc(st.err) + '</p>' : '') +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="ch-restore-keep"' + (st.busy ? ' disabled' : '') + '>Keep merged</button>' +
    '<button class="btn" id="ch-restore-commit"' + (st.busy ? ' disabled' : '') + '>' +
    (st.busy ? 'Restoring…' : 'Restore ' + esc(p.loserName)) + '</button></div>';
}

export function chRestoreResultHtml(st) {
  const p = st.preview;
  const m = charUnmergeResultModel(p, st.outcome);
  if (m.done) {
    return '<h3 class="serif">' + esc(m.heading) + '</h3>' +
      '<p>' + esc(m.countsLine) + '</p>' +
      (m.staysLine ? '<p>' + esc(m.staysLine) + '</p>' : '') +
      '<p>' + esc(m.statusLine) + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn ghost" id="ch-restore-done">Done</button>' +
      '<button class="btn" id="ch-restore-view">View ' + esc(p.loserName) + '</button></div>';
  }
  return '<h3 class="serif">' + esc(m.heading) + '</h3>' +
    (st.outcome
      ? '<p>' + esc(m.countsLine) + '</p>'
      : '<p class="note">Couldn\'t re-check what moved — reopen the Character Lab to see the current state.</p>') +
    (st.err ? '<p class="note" style="color:var(--danger,red)">' + esc(st.err) + '</p>' : '') +
    '<p class="note">Nothing is lost — the merge snapshot is still recorded, and restoring again is safe.</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="ch-restore-done">Close</button>' +
    '<button class="btn" id="ch-restore-retry">Try again</button></div>';
}

export function chRestoreRender() {
  const st = chRestoreState;
  if (!st) return;
  const host = document.getElementById('ch-restore-body');
  if (!host) return;
  host.innerHTML = st.phase === 'preview' ? chRestorePreviewHtml(st) : chRestoreResultHtml(st);
  host.querySelectorAll('[data-chmore]').forEach(b => b.addEventListener('click', () => {
    if (b.getAttribute('data-chmore') === 'b') st.expandedB = true; else st.expandedC = true;
    chRestoreRender();
  }));
  const keep = document.getElementById('ch-restore-keep');
  if (keep) keep.addEventListener('click', closeCharRestoreSheet);
  const commit = document.getElementById('ch-restore-commit');
  if (commit) commit.addEventListener('click', chRestoreCommit);
  const done = document.getElementById('ch-restore-done');
  if (done) done.addEventListener('click', closeCharRestoreSheet);
  const view = document.getElementById('ch-restore-view');
  if (view) view.addEventListener('click', () => {
    const ctx = st.ctx, loserId = st.loserId;
    closeCharRestoreSheet();
    charLabSelectedId = loserId;
    charLabRender(ctx.body, ctx.works, ctx.chars);
    const detail = document.getElementById('ch-detail');
    if (detail && detail.scrollIntoView) detail.scrollIntoView({ behavior: 'smooth' });
  });
  const retry = document.getElementById('ch-restore-retry');
  if (retry) retry.addEventListener('click', () => {
    const loser = st.ctx.chars.find(c => c.id === st.loserId);
    const winner = loser ? st.ctx.chars.find(c => c.id === loser.duplicateOf) : null;
    if (!loser || !winner || !loser.mergeSnapshot) { closeCharRestoreSheet(); return; }
    st.preview = charUnmergePreview(loser, winner, st.ctx.chars);
    st.phase = 'preview'; st.outcome = null; st.err = null;
    st.expandedB = false; st.expandedC = false;
    chRestoreRender();
  });
}

export async function chRestoreCommit() {
  const st = chRestoreState;
  if (!st || st.busy) return;
  st.busy = true;
  chRestoreRender();
  const err = await charUnmerge(st.loserId, st.ctx.chars);
  // Re-read the work so the Lab behind the sheet (card count, grid) and
  // the movement count reflect the server, not the pre-restore copy.
  let fresh = null;
  try { fresh = await CharacterStore.listForWork(charLabWorkId); } catch (e) { fresh = null; }
  if (fresh) st.ctx.chars = fresh;
  charLabRender(st.ctx.body, st.ctx.works, st.ctx.chars);
  st.phase = 'result';
  st.err = err;
  st.outcome = err ? (fresh ? charUnmergeOutcome(st.preview, fresh) : null) : null;
  st.busy = false;
  chRestoreRender();
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its consumers — js/159-characters.js
   (CHAR_ROLE_LABELS) and js/199-admin.js (the renderCharacterLab
   dispatch) — still read this surface as globals at runtime, so the
   bridge republishes exactly the pre-conversion public surface on
   window. Bare-name lookups resolve through the global object, so the
   callers need no changes. Module scripts are deferred, so the bridge
   is in place before any consumer can run. Remove a name from this
   bridge only when its last window-reading caller has wired the read
   as an import (ADR-003). */
window.CHAR_ROLE_LABELS = CHAR_ROLE_LABELS;
window.charLabWorkId = charLabWorkId;
window.charLabRoleFilter = charLabRoleFilter;
window.charLabSelectedId = charLabSelectedId;
window.charLabShowBlocked = charLabShowBlocked;
window.charLabView = charLabView;
window.charLabCanonicalId = charLabCanonicalId;
window.renderCharacterLab = renderCharacterLab;
window.charLabRenderReview = charLabRenderReview;
window.charLabRenderRelationships = charLabRenderRelationships;
window.deleteWork = deleteWork;
window.charLabRenderInbox = charLabRenderInbox;
window.charLabWireViewToggle = charLabWireViewToggle;
window.charLabCanonDetail = charLabCanonDetail;
window.charLabRender = charLabRender;
window.charLabDetail = charLabDetail;
window.charMerge = charMerge;
window.charUnmerge = charUnmerge;
window.charUnmergeNameEq = charUnmergeNameEq;
window.charUnmergeRelKey = charUnmergeRelKey;
window.charUnmergePostRepointKeys = charUnmergePostRepointKeys;
window.charUnmergePreview = charUnmergePreview;
window.charUnmergeListWindow = charUnmergeListWindow;
window.charUnmergeOutcome = charUnmergeOutcome;
window.charUnmergeCounted = charUnmergeCounted;
window.charUnmergeResultModel = charUnmergeResultModel;
window.charMergeHistoryLine = charMergeHistoryLine;
window.chRestoreState = chRestoreState;
window.chRestoreToken = chRestoreToken;
window.openCharRestoreSheet = openCharRestoreSheet;
window.closeCharRestoreSheet = closeCharRestoreSheet;
window.chRestoreItemLines = chRestoreItemLines;
window.chRestorePreviewHtml = chRestorePreviewHtml;
window.chRestoreResultHtml = chRestoreResultHtml;
window.chRestoreRender = chRestoreRender;
window.chRestoreCommit = chRestoreCommit;
