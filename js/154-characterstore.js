'use strict';

/* ---------------- Character store (v317) ----------------
   CharacterStore: the Supabase data layer for pipeline-extracted book
   characters (book_characters / characters / character_links), plus the
   pure character helpers shared by the character surfaces.
   Consumers: js/159-characters.js (character wiki), js/225-book-portrait.js,
   js/050-helpers.js (normName) and the Character Lab UI in js/199-admin.js.
   Data contract (from Ebook Processor):
   - book_characters: work_id, name, role (protagonist/antagonist/supporting/minor),
     description, relationships JSONB [{to: "<name>", type: "<type>"}]
   - Relationship `to` is a NAME string, not an ID — resolve defensively.
   - Relationship types: closed set of 10 (spouse/parent/child/sibling/friend/
     enemy/mentor/colleague/neighbor/other); unknown -> "other".
   - Each work's cast is isolated (no cross-book linking yet).
   - Unresolved targets shown, never dropped.
   Extracted from js/199-admin.js (architecture survey candidate 3):
   reader-facing files depended on a store homed in an admin screen.
   All names and behaviour unchanged; this file must load before
   js/159, js/199 and js/225. */

const CHAR_ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'];
const CHAR_REL_TYPES = ['spouse', 'parent', 'child', 'sibling', 'friend',
  'enemy', 'mentor', 'colleague', 'neighbor', 'other'];

const CharacterStore = {
  _sb() { return cloudClient().catch(() => null); },

  /* Works that have character data, with counts. */
  async listWorks() {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_characters')
        .select('work_id, works(title)')
        .limit(5000);
      if (error) throw error;
      const byWork = {};
      for (const r of data || []) {
        const w = byWork[r.work_id] || (byWork[r.work_id] = {
          workId: r.work_id,
          title: (r.works && r.works.title) || r.work_id.slice(0, 8),
          count: 0,
        });
        w.count++;
      }
      return Object.values(byWork).sort((a, b) => b.count - a.count);
    } catch (e) { return []; }
  },

  /* Normalize a name for canonical matching. Mirrors the pipeline's
     norm_name(): casefold, strip leading articles, collapse whitespace. */
  normName(n) {
    return String(n || '').trim().toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/^(the|a|an)\s+/, '')
      .replace(/\s+/g, ' ').trim();
  },

  /* All canonical characters, with linked work counts.
     v320: links live in character_links (audit trail), not the bare FK. */
  async listCanonical() {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('characters')
        .select('id, name, description, aliases, source, updated_at')
        .order('name');
      if (error) throw error;
      const { data: links, error: lerr } = await sb.from('character_links')
        .select('character_id, book_characters!inner(work_id, works(title))')
        .limit(5000);
      if (lerr) throw lerr;
      const byChar = {};
      for (const l of links || []) {
        const bc = l.book_characters;
        if (!bc) continue;
        const b = byChar[l.character_id] || (byChar[l.character_id] = {
          works: [], workIds: new Set(),
        });
        if (!b.workIds.has(bc.work_id)) {
          b.workIds.add(bc.work_id);
          b.works.push((bc.works && bc.works.title) || String(bc.work_id).slice(0, 8));
        }
      }
      return (data || []).map(c => ({
        id: c.id,
        name: c.name,
        description: c.description || '',
        aliases: Array.isArray(c.aliases) ? c.aliases : [],
        source: c.source || 'manual',
        works: (byChar[c.id] && byChar[c.id].works) || [],
        workCount: (byChar[c.id] && byChar[c.id].workIds.size) || 0,
      }));
    } catch (e) { return []; }
  },

  /* Full unified view: canonical character + all linked book rows with
     their per-work relationships. */
  /* v377 Phase 2: Edge table methods. */
  async listRelationships(characterId) {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('character_relationships')
        .select('id, character_a_id, character_b_id, relationship_type, direction, importance, review_status, source_work_id')
        .or(`character_a_id.eq.${characterId},character_b_id.eq.${characterId}`);
      if (error) throw error;
      return data || [];
    } catch (e) { console.warn('listRelationships failed', e); return []; }
  },

  async createRelationship(aId, bId, type, opts) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    opts = opts || {};
    try {
      const { data: { user } } = await sb.auth.getUser();
      const { data, error } = await sb.from('character_relationships').insert({
        character_a_id: aId,
        character_b_id: bId,
        relationship_type: String(type || 'friend').toLowerCase(),
        direction: opts.direction || 'mutual',
        importance: opts.importance || null,
        source_work_id: opts.workId || null,
        review_status: opts.review_status || 'confirmed',
        created_by: user ? user.id : null,
        notes: opts.notes || null,
        tags: opts.tags || null,
      }).select().single();
      if (error) throw error;
      return data;
    } catch (e) { throw e; }
  },

  async updateRelationship(id, updates) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    try {
      const { error } = await sb.from('character_relationships')
        .update(updates).eq('id', id);
      if (error) throw error;
    } catch (e) { throw e; }
  },

  async deleteRelationship(id) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    try {
      const { error } = await sb.from('character_relationships').delete().eq('id', id);
      if (error) throw error;
    } catch (e) { throw e; }
  },

  async getCanonicalDetail(charId) {
    const sb = await this._sb();
    if (!sb) return null;
    try {
      const { data: c, error } = await sb.from('characters')
        .select('id, name, description, aliases, source').eq('id', charId).maybeSingle();
      if (error || !c) return null;
      // v320: links via character_links (audit trail)
      const { data: links, error: lerr } = await sb.from('character_links')
        .select('book_character_id, linked_at, note, book_characters!inner(id, work_id, name, role, description, relationships, status, aliases, appearance, first_appearance_chapter, source_type, works(title, series))')
        .eq('character_id', charId);
      if (lerr) throw lerr;
      return {
        id: c.id, name: c.name, description: c.description || '',
        aliases: Array.isArray(c.aliases) ? c.aliases : [],
        source: c.source || 'manual',
        instances: (links || []).map(l => {
          const r = l.book_characters;
          const wSeries = (r.works && r.works.series) || null;
          return {
            id: r.id,
            workId: r.work_id,
            workTitle: (r.works && r.works.title) || String(r.work_id).slice(0, 8),
            series: wSeries,
            seriesPos: wSeries && wSeries.position != null ? wSeries.position : null,
            name: r.name,
            role: r.role,
            description: r.description || '',
            relationships: Array.isArray(r.relationships) ? r.relationships : [],
            status: r.status || null,
            aliases: Array.isArray(r.aliases) ? r.aliases : [],
            appearance: r.appearance || '',
            firstAppearance: r.first_appearance_chapter || null,
            sourceType: r.source_type || 'ai',
            linkedAt: l.linked_at,
            linkNote: l.note,
          };
        }),
      };
    } catch (e) { return null; }
  },

  /* Create a canonical character and link book rows to it.
     v320: links go in character_links with audit (who/when). */
  async createCanonical(name, description, bookRowIds, opts) {
    opts = opts || {};
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    const norm = this.normName(name);
    if (!norm) throw new Error('name required');
    // Find existing canonical by normalized name (no UNIQUE — reviewer decides)
    const { data: existing } = await sb.from('characters')
      .select('id').eq('name_norm', norm).limit(1);
    let charId = existing && existing[0] && existing[0].id;
    if (!charId) {
      const { data, error } = await sb.from('characters')
        .insert({ name: String(name).trim(), name_norm: norm,
          description: String(description || '').trim() || null,
          source: opts.source || 'manual' })
        .select('id').maybeSingle();
      if (error) throw error;
      charId = data.id;
    }
    // Create links with audit trail
    if (bookRowIds && bookRowIds.length) {
      let userId = null;
      try { const { data: { user } } = await sb.auth.getUser(); userId = user && user.id; } catch (e) {}
      const rows = bookRowIds.map(bid => ({
        book_character_id: bid,
        character_id: charId,
        linked_by: userId,
        note: opts.note || null,
      }));
      const { error: lerr } = await sb.from('character_links').upsert(rows,
        { onConflict: 'book_character_id', ignoreDuplicates: false });
      if (lerr) throw lerr;
    }
    return charId;
  },

  /* Unlink a book row from its canonical character. */
  async unlink(rowId) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    const { error } = await sb.from('character_links')
      .delete().eq('book_character_id', rowId);
    if (error) throw error;
  },

  /* v321: series-aware auto-link. Finds unlinked book_characters with
     identical normalized names in works by the SAME author in the SAME
     series, and links them to a shared canonical character.
     This is the safe automation: same author + same series + exact name
     is strong evidence (the Pete Sebeck case). Cross-author and
     cross-series matches are NEVER auto-linked.
     Returns {linked: n, groups: m} — counts of rows linked and canonicals
     created/touched. Never throws — returns {error} on failure. */
  async autoLinkSeries() {
    const sb = await this._sb();
    if (!sb) return { error: 'cloud unavailable' };
    try {
      // Get all unlinked characters with their work's author/series
      const { data, error } = await sb.from('book_characters')
        .select('id, name, work_id, works!inner(authors, series)')
        .is('duplicate_of', null)
        .neq('status', 'merged')
        .limit(5000);
      if (error) throw error;
      // Get already-linked row ids to exclude
      const { data: linked } = await sb.from('character_links')
        .select('book_character_id').limit(5000);
      const linkedIds = new Set((linked || []).map(l => l.book_character_id));

      // Group by (norm_name, author_key, series_key)
      const groups = {};
      for (const r of data || []) {
        if (linkedIds.has(r.id)) continue;
        const norm = this.normName(r.name);
        if (!norm) continue;
        const w = r.works || {};
        const authors = Array.isArray(w.authors) ? w.authors.join('|').toLowerCase() : '';
        const series = String(w.series || '').trim().toLowerCase();
        if (!authors || !series) continue; // need both for safe auto-link
        const key = norm + '||' + authors + '||' + series;
        (groups[key] || (groups[key] = [])).push({
          id: r.id, name: r.name, norm,
          workId: r.work_id,
        });
      }
      // Only groups with 2+ rows from DIFFERENT works qualify
      let linkedCount = 0, groupCount = 0;
      for (const key of Object.keys(groups)) {
        const g = groups[key];
        const groupKey = key;
        const workIds = new Set(g.map(x => x.workId));
        if (g.length < 2 || workIds.size < 2) continue;
        // Find or create canonical. v326: verify an existing canonical actually
        // belongs to this author+series before reusing it (John Smith problem).
        // The group's key already encodes author+series, so we check the
        // canonical's linked characters for a matching group.
        let charId = null;
        const { data: existing } = await sb.from('characters')
          .select('id').eq('name_norm', g[0].norm).limit(5);
        if (existing && existing.length) {
          for (const cand of existing) {
            const { data: candLinks } = await sb.from('character_links')
              .select('book_characters!inner(work_id, works!inner(authors, series))')
              .eq('character_id', cand.id).limit(10);
            const match = (candLinks || []).some(l => {
              const bc = l.book_characters || {};
              const w = bc.works || {};
              const authors = Array.isArray(w.authors) ? w.authors.join('|').toLowerCase() : '';
              const series = String(w.series || '').trim().toLowerCase();
              return (g[0].norm + '||' + authors + '||' + series) === groupKey;
            });
            if (match) { charId = cand.id; break; }
          }
        }
        if (!charId) {
          const { data: nc, error: cerr } = await sb.from('characters')
            .insert({ name: g[0].name, name_norm: g[0].norm, source: 'auto-series' })
            .select('id').maybeSingle();
          if (cerr) throw cerr;
          charId = nc.id;
        }
        // Link all rows in the group
        const rows = g.map(x => ({
          book_character_id: x.id,
          character_id: charId,
          linked_by: null, // system, not a human
          note: 'auto-series: same author + series + exact name',
        }));
        const { error: lerr } = await sb.from('character_links')
          .upsert(rows, { onConflict: 'book_character_id', ignoreDuplicates: true });
        if (lerr) throw lerr;
        linkedCount += g.length;
        groupCount++;
      }
      return { linked: linkedCount, groups: groupCount };
    } catch (e) { return { error: (e && e.message) || 'unknown error' }; }
  },

  /* All characters for a work. v320: character_id via character_links join. */
  async listForWork(workId) {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_characters')
        .select('id, name, role, description, relationships, confidence, status, suggested_character_id, duplicate_of, merge_snapshot, first_appearance_chapter, character_links(character_id)')
        .eq('work_id', workId)
        .order('name');
      if (error) throw error;
      return (data || []).map(c => {
        const link = Array.isArray(c.character_links) ? c.character_links[0] : c.character_links;
        return {
          id: c.id,
          name: c.name || 'Unnamed',
          role: CHAR_ROLES.includes(c.role) ? c.role : 'minor',
          description: c.description || '',
          relationships: Array.isArray(c.relationships) ? c.relationships : [],
          confidence: c.confidence,
          status: c.status || 'candidate',
          characterId: (link && link.character_id) || null,
          suggestedCharacterId: c.suggested_character_id || null,
          duplicateOf: c.duplicate_of || null,
          // v577: the merge snapshot charMerge recorded on a merged row
          // (null for active rows and for pre-v577 legacy merges).
          mergeSnapshot: c.merge_snapshot || null,
          // v402: first-appearance chapter from pipeline (null when unknown)
          firstAppearance: (c.first_appearance_chapter != null && c.first_appearance_chapter !== '') ? c.first_appearance_chapter : null,
        };
      });
    } catch (e) { return []; }
  },
};

/* Resolve a relationship target name to a character in the same work.
   Returns {character} or {unresolved: name}. Case-insensitive exact match
   first, then substring match (handles "Bodhi" -> "Bodhi Durran"). */
function charResolveTarget(name, chars) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return { unresolved: String(name || '') };
  let c = chars.find(x => String(x.name).trim().toLowerCase() === n);
  if (c) return { character: c };
  c = chars.find(x => {
    const cn = String(x.name).trim().toLowerCase();
    return cn.includes(n) || n.includes(cn);
  });
  if (c) return { character: c, fuzzy: true };
  return { unresolved: String(name || '').trim() };
}

function charNormRelType(t) {
  t = String(t || '').trim().toLowerCase();
  return CHAR_REL_TYPES.includes(t) ? t : 'other';
}

/* v317: quality gates (per Trope Review Agent).
   BLOCKED: generic kinship terms and obvious non-names — hidden by default.
   Duplicates: substring/similar names flagged for merge review. */
const CHAR_BLOCKED_NAMES = ['dad', 'mom', 'mother', 'father', 'parent',
  'parents', 'brother', 'sister', 'son', 'daughter', 'child', 'children',
  'friend', 'friends', 'enemy', 'enemies', 'someone', 'somebody', 'nobody',
  'everyone', 'man', 'woman', 'boy', 'girl', 'child', 'baby'];

function charIsBlocked(c) {
  const n = String(c.name || '').trim().toLowerCase();
  return CHAR_BLOCKED_NAMES.includes(n) || n.length < 2;
}

/* Find likely duplicates: names where one contains the other and they
   share the same role, or normalized names match. Returns pairs. */
function charFindDuplicates(chars) {
  const pairs = [];
  const norm = s => String(s || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = chars[i], b = chars[j];
      const na = norm(a.name), nb = norm(b.name);
      if (!na || !nb || na === nb) {
        if (na === nb && na) pairs.push([a, b, 'exact']);
        continue;
      }
      if ((na.includes(nb) || nb.includes(na)) && a.role === b.role) {
        pairs.push([a, b, 'substring']);
      }
    }
  }
  return pairs;
}
