'use strict';

/* ---------------- Character wiki (v322) ----------------
   User-facing character pages: shared canonical data + per-user notes.
   - Shared: characters, book_characters, character_links (canonical identity)
   - Per-user: character_notes (personal annotations)
   Linked from the book modal's Cast section. Read-only shared data in v1;
   edit suggestions come later. */

/* v331: back navigation for character pages — returns to library
   (no character index exists yet to return to) */
function goBack() { try { go('library'); } catch (e) { try { history.back(); } catch (err) {} } }

let characterViewId = null;

const CharacterWiki = {
  _sb() { return cloudClient().catch(() => null); },

  /* Full character page data: canonical + instances + notes. */
  async getPage(charId) {
    const sb = await this._sb();
    if (!sb) return null;
    try {
      const detail = await CharacterStore.getCanonicalDetail(charId);
      if (!detail) return null;
      // Per-user note
      let note = null;
      try {
        const { data: { user } } = await sb.auth.getUser();
        if (user) {
          const { data } = await sb.from('character_notes')
            .select('note, updated_at').eq('character_id', charId)
            .eq('user_id', user.id).maybeSingle();
          if (data) note = data;
        }
      } catch (e) {}
      detail.userNote = note;
      return detail;
    } catch (e) { return null; }
  },

  /* Characters for a work, grouped by role tier for the Cast section. */
  async getCast(workId) {
    try {
      const chars = await CharacterStore.listForWork(workId);
      // Filter to confirmed/candidate, hide merged/blocked
      const visible = chars.filter(c =>
        c.status !== 'merged' && c.status !== 'rejected' &&
        (typeof charIsBlocked === 'undefined' || !charIsBlocked(c)));
      // v329: strict role order — protagonists first, then antagonists
      const roleOrder = { protagonist: 0, antagonist: 1, supporting: 2, minor: 3 };
      visible.sort((a, b) => (roleOrder[a.role] ?? 4) - (roleOrder[b.role] ?? 4) ||
        String(a.name).localeCompare(String(b.name)));
      const tier1 = visible.filter(c => c.role === 'protagonist');
      const tier1b = visible.filter(c => c.role === 'antagonist');
      const tier2 = visible.filter(c => c.role === 'supporting');
      const tier3 = visible.filter(c => c.role === 'minor');
      return { tier1, tier1b, tier2, tier3, total: visible.length };
    } catch (e) { return { tier1: [], tier1b: [], tier2: [], tier3: [], total: 0 }; }
  },

  /* v336: fetch quotes for a canonical character (via linked book_characters)
     or for a single book_character. Returns array of {quote, context, workTitle}. */
  async getQuotesForCanonical(charId) {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      // Get linked book_character ids
      const { data: links } = await sb.from('character_links')
        .select('book_character_id').eq('character_id', charId);
      const bcIds = (links || []).map(l => l.book_character_id).filter(Boolean);
      if (!bcIds.length) return [];
      const { data, error } = await sb.from('book_quotes')
        .select('quote, context, speaker_name, works(title)')
        .in('book_character_id', bcIds)
        .order('created_at').limit(10);
      if (error) throw error;
      return (data || []).map(q => ({
        quote: q.quote, context: q.context,
        workTitle: (q.works || {}).title || '',
      }));
    } catch (e) { return []; }
  },

  async getQuotesForBookCharacter(bookCharId) {
    const sb = await this._sb();
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_quotes')
        .select('quote, context, speaker_name')
        .eq('book_character_id', bookCharId)
        .order('created_at').limit(10);
      if (error) throw error;
      return (data || []).map(q => ({ quote: q.quote, context: q.context }));
    } catch (e) { return []; }
  },

  /* Fallback: quotes matched by speaker name within a work (when
     book_character_id wasn't set by the pipeline). */
  async getQuotesBySpeaker(workId, speakerName) {
    const sb = await this._sb();
    if (!sb || !speakerName) return [];
    try {
      // v337: escape LIKE wildcards in the speaker name
      const safeName = String(speakerName).trim().replace(/[\\%_]/g, m => '\\' + m);
      const { data, error } = await sb.from('book_quotes')
        .select('quote, context')
        .eq('work_id', workId)
        .ilike('speaker_name', '%' + safeName + '%')
        .order('created_at').limit(10);
      if (error) throw error;
      return (data || []).map(q => ({ quote: q.quote, context: q.context }));
    } catch (e) { return []; }
  },

  /* v337: quotes for a work (book-level, regardless of speaker attribution). */
  async getQuotesForWork(workId) {
    const sb = await this._sb();
    if (!sb || !workId) return [];
    try {
      const { data, error } = await sb.from('book_quotes')
        .select('quote, context, speaker_name')
        .eq('work_id', workId)
        .order('created_at').limit(8);
      if (error) throw error;
      return (data || []).map(q => ({
        quote: q.quote, context: q.context, speaker: q.speaker_name,
      }));
    } catch (e) { return []; }
  },

  async saveNote(charId, text) {
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('not signed in');
    const t = String(text || '').trim();
    if (!t) {
      const { error } = await sb.from('character_notes')
        .delete().eq('character_id', charId).eq('user_id', user.id);
      if (error) throw error;
      return;
    }
    const { error } = await sb.from('character_notes').upsert({
      character_id: charId, user_id: user.id, note: t,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,character_id' });
    if (error) throw error;
  },
};

function openCharacter(charId) {
  // v332: close the book modal first — click its close button so the
  // overlay token, scroll lock, and history entry are cleaned up properly
  try { const x = document.getElementById('m-x'); if (x) x.click(); } catch (e) {}
  try { const mr = document.getElementById('modal-root'); if (mr) mr.innerHTML = ''; } catch (e) {}
  characterViewId = charId;
  view = 'character';
  animateIn = true;
  render();
  window.scrollTo(0, 0);
}

/* v334: premium character wiki — visual identity helpers */

/* Role-themed avatar medallion. Returns HTML for a circular badge with
   the character's initials, colored by their primary role. */
function charAvatar(name, role, size) {
  size = parseInt(size, 10) || 64;
  const initials = String(name || '?').trim().split(/\s+/)
    .map(w => [...w][0]).join('').slice(0, 2).toUpperCase() || '?';
  const themes = {
    protagonist: 'background:linear-gradient(135deg,#c9a227,#f5d76e);color:#2a1f00;',
    antagonist: 'background:linear-gradient(135deg,#8b0000,#e74c3c);color:#fff;',
    supporting: 'background:linear-gradient(135deg,#2c5f8a,#6aa8e5);color:#fff;',
    minor: 'background:linear-gradient(135deg,#5a5a5a,#9a9a9a);color:#fff;',
  };
  const style = themes[role] || themes.minor;
  return '<div class="ch-avatar" style="width:' + size + 'px;height:' + size + 'px;' + style + '">' +
    esc(initials) + '</div>';
}

/* Determine a character's primary role across all instances
   (protagonist > antagonist > supporting > minor). */
function charPrimaryRole(instances) {
  const order = { protagonist: 0, antagonist: 1, supporting: 2, minor: 3 };
  let best = 'minor', bestRank = 4;
  (instances || []).forEach(inst => {
    const r = order[inst.role];
    if (r != null && r < bestRank) { bestRank = r; best = inst.role; }
  });
  return best;
}

/* v336: render pull quotes section. Returns HTML (empty string if none). */
function charQuotesHTML(quotes) {
  if (!quotes || !quotes.length) return '';
  let h = '<h3 class="serif">Memorable quotes</h3><div class="ch-quotes">';
  quotes.slice(0, 5).forEach(q => {
    h += '<blockquote class="ch-quote"><p>"' + esc(q.quote) + '"</p>' +
      (q.context ? '<cite>' + esc(q.context) + '</cite>' : '') +
      (q.workTitle ? '<span class="note"> — ' + esc(q.workTitle) + '</span>' : '') +
      '</blockquote>';
  });
  h += '</div>';
  return h;
}

/* v339: Phase C — interactive SVG relationship constellation.
   Renders the character at center with relationship nodes arranged in a
   circle. Nodes are tappable (navigate to character pages). Edges are
   colored by relationship type. Caps at 14 nodes for readability. */
function charGraphHTML(grouped, workChars, centerName, centerRole) {
  if (!grouped || !grouped.length) return '';
  const MAX = 14;
  const nodes = grouped.slice(0, MAX);
  const extra = grouped.length - nodes.length;

  const W = 340, H = 340, cx = W / 2, cy = H / 2, R = 120;
  const typeColors = {
    spouse: '#e74c3c', parent: '#c9a227', child: '#f5d76e',
    sibling: '#9b59b6', friend: '#2ecc71', enemy: '#8b0000',
    mentor: '#3498db', colleague: '#6aa8e5',
  };

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ch-graph" style="width:100%;max-width:380px;height:auto;display:block;margin:0 auto;">';

  // Edges (behind nodes)
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i / nodes.length) - Math.PI / 2;
    const x = cx + R * Math.cos(angle), y = cy + R * Math.sin(angle);
    const color = typeColors[n.types[0]] || '#888';
    svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '"' +
      ' stroke="' + color + '" stroke-width="1.5" opacity="0.5"/>';
  });

  // Nodes
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i / nodes.length) - Math.PI / 2;
    const x = cx + R * Math.cos(angle), y = cy + R * Math.sin(angle);
    const color = typeColors[n.types[0]] || '#888';
    const initials = String(n.name).trim().split(/\s+/).map(w => [...w][0]).join('').slice(0, 2).toUpperCase();
    // Resolve tap target
    let tapAttr = '';
    try {
      if (typeof charResolveTarget !== 'undefined' && workChars) {
        const res = charResolveTarget(n.name, workChars);
        if (res.character) {
          const c = res.character;
          tapAttr = c.characterId
            ? ' data-chwiki="' + esc(c.characterId) + '"'
            : ' data-chbook="' + esc(c.id) + '"';
        }
      }
    } catch (e) {}
    const label = esc(n.name.length > 14 ? n.name.slice(0, 13) + '…' : n.name);
    svg += '<g' + tapAttr + (tapAttr ? ' class="ch-graph-node" style="cursor:pointer"' : '') + '>' +
      '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="22" fill="' + color + '" opacity="0.85"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + 5).toFixed(1) + '" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">' + esc(initials) + '</text>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + 36).toFixed(1) + '" text-anchor="middle" fill="var(--text)" font-size="9">' + label + '</text>' +
      '</g>';
  });

  // Center node
  const centerInitials = String(centerName || '?').trim().split(/\s+/).map(w => [...w][0]).join('').slice(0, 2).toUpperCase();
  const centerColor = { protagonist: '#c9a227', antagonist: '#8b0000', supporting: '#2c5f8a', minor: '#5a5a5a' }[centerRole] || '#5a5a5a';
  svg += '<circle cx="' + cx + '" cy="' + cy + '" r="30" fill="' + centerColor + '"/>' +
    '<text x="' + cx + '" y="' + (cy + 6) + '" text-anchor="middle" fill="#fff" font-size="14" font-weight="700">' + esc(centerInitials) + '</text>';
  svg += '</svg>';

  let h = '<div class="ch-graph-wrap">' + svg;
  if (extra > 0) h += '<p class="note" style="text-align:center">+' + extra + ' more connections listed below</p>';
  // Legend
  const usedTypes = [...new Set(nodes.map(n => n.types[0]))];
  h += '<div class="ch-graph-legend">' + usedTypes.map(t =>
    '<span><i style="background:' + (typeColors[t] || '#888') + '"></i>' + esc(t) + '</span>'
  ).join('') + '</div></div>';
  return h;
}

/* v338: group relationships by person, resolving contradictions.
   If the same person appears as both parent and child (pipeline error),
   keep only 'parent' (the more commonly correct direction) and flag it.
   Returns [{name, types: [], contradicted: bool}]. */
function charGroupRelationships(relationships) {
  const byPerson = {};
  (relationships || []).forEach(r => {
    const name = String(r.to || '').trim();
    if (!name) return;
    const type = charNormRelType(r.type);
    const key = name.toLowerCase();
    if (!byPerson[key]) byPerson[key] = { name, types: new Set(), contradicted: false };
    byPerson[key].types.add(type);
  });
  // Resolve parent/child contradictions
  Object.values(byPerson).forEach(p => {
    if (p.types.has('parent') && p.types.has('child')) {
      p.types.delete('child');
      p.contradicted = true;
    }
  });
  return Object.values(byPerson).map(p => ({
    name: p.name,
    types: [...p.types].sort(),
    contradicted: p.contradicted,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/* v333: render a relationship target name as a tappable link when it
   resolves to a known character, plain text otherwise. */
function charRelLink(name, workChars) {
  const escName = esc(String(name || ''));
  if (typeof charResolveTarget === 'undefined' || !workChars) return escName;
  try {
    const res = charResolveTarget(name, workChars);
    if (res.character) {
      const c = res.character;
      const attr = c.characterId
        ? 'data-chwiki="' + esc(c.characterId) + '"'
        : 'data-chbook="' + esc(c.id) + '"';
      return '<button class="taplink" ' + attr + '>' + escName + '</button>';
    }
  } catch (e) {}
  return escName;
}

/* Wire tap handlers for relationship links in a container. */
function wireCharRelLinks(box) {
  if (!box) return;
  box.querySelectorAll('[data-chwiki]').forEach(b => b.addEventListener('click', () => {
    openCharacter(b.getAttribute('data-chwiki'));
  }));
  box.querySelectorAll('[data-chbook]').forEach(b => b.addEventListener('click', () => {
    openBookCharacter(b.getAttribute('data-chbook'));
  }));
}

/* v329: detail view for a single book_character row (unlinked characters).
   Shows book-specific description and relationships. */
let bookCharViewId = null;
function openBookCharacter(bookCharId) {
  // v332: close the book modal first — click its close button so the
  // overlay token, scroll lock, and history entry are cleaned up properly
  try { const x = document.getElementById('m-x'); if (x) x.click(); } catch (e) {}
  try { const mr = document.getElementById('modal-root'); if (mr) mr.innerHTML = ''; } catch (e) {}
  bookCharViewId = bookCharId;
  view = 'bookcharacter';
  animateIn = true;
  render();
  window.scrollTo(0, 0);
}

async function renderBookCharacterPage() {
  const sb = await CharacterWiki._sb();
  if (!sb || !bookCharViewId) {
    setView('<div class="view-head"><h2 class="serif">Not found</h2><button class="btn sm" onclick="goBack()">← Back</button></div>');
    return;
  }
  try {
    const { data, error } = await sb.from('book_characters')
      .select('id, name, role, description, relationships, work_id, works(title)')
      .eq('id', bookCharViewId).maybeSingle();
    if (error || !data) throw error || new Error('not found');
    const w = data.works || {};
    // v333: fetch work characters for relationship link resolution
    let workChars = [];
    try { workChars = await CharacterStore.listForWork(data.work_id); } catch (e) {}
    // v334: premium hero for book character page too
    const relCount = (Array.isArray(data.relationships) ? data.relationships : []).length;
    let html = '<div class="view-head"><button class="btn sm ghost" onclick="goBack()">← Back</button></div>' +
      '<div class="ch-hero">' +
      charAvatar(data.name, data.role, 72) +
      '<div class="ch-hero-info"><h2 class="serif">' + esc(data.name) + '</h2>' +
      '<span class="chip dbtrope ch-role-' + esc(data.role || 'minor') + '">' + esc(CHAR_ROLE_LABELS[data.role] || data.role || '?') + '</span><br>' +
      '<span class="note">in ' + esc(w.title || 'unknown book') + '</span></div></div>' +
      '<div class="stat-row ch-stats">' +
      '<div class="stat"><div class="n">' + relCount + '</div><div class="l">Connections</div></div></div>';
    if (data.description) html += '<p class="ch-desc">' + esc(data.description) + '</p>';
    const rels = Array.isArray(data.relationships) ? data.relationships : [];
    if (rels.length) {
      html += '<h3 class="serif">Relationships</h3><p>';
      const byType = {};
      // v338: dedupe parent/child contradictions (pipeline sometimes writes both)
      const seenParents = new Set();
      rels.forEach(r => {
        const t = charNormRelType(r.type);
        if (t === 'parent') seenParents.add(String(r.to || '').trim().toLowerCase());
      });
      rels.forEach(r => {
        const t = charNormRelType(r.type);
        const nameKey = String(r.to || '').trim().toLowerCase();
        if (t === 'child' && seenParents.has(nameKey)) return; // contradictory, skip
        (byType[t] || (byType[t] = [])).push(r.to);
      });
      html += Object.keys(byType).sort().map(t =>
        '<b>' + esc(t) + ':</b> ' + byType[t].map(n => charRelLink(n, workChars)).join(', ')
      ).join('<br>');
      html += '</p>';
    }
    // v336: memorable quotes (by character id, fallback to speaker name)
    try {
      let quotes = await CharacterWiki.getQuotesForBookCharacter(bookCharViewId);
      if (!quotes.length && data.work_id) {
        quotes = await CharacterWiki.getQuotesBySpeaker(data.work_id, data.name);
      }
      html += charQuotesHTML(quotes);
    } catch (e) {}
    html += '<p class="note">Not yet linked to a canonical character. ' +
      'Link it in the Observatory → Characters to connect across books.</p>';
    setView(html);
    wireCharRelLinks(document.getElementById('view'));
  } catch (e) {
    setView('<div class="view-head"><h2 class="serif">Could not load</h2><button class="btn sm" onclick="goBack()">← Back</button></div>');
  }
}

async function renderCharacterPage() {
  const d = await CharacterWiki.getPage(characterViewId);
  if (!d) {
    setView('<div class="view-head"><h2 class="serif">Character not found</h2>' +
      '<button class="btn sm" onclick="goBack()">← Back</button></div>');
    return;
  }
  // v334: premium hero — avatar, name, role badge, at-a-glance stats
  const primaryRole = charPrimaryRole(d.instances);
  const relCount = d.instances.reduce((n, inst) => n + (inst.relationships || []).length, 0);
  // "Closest to" — most frequent relationship target
  const targetCounts = {};
  d.instances.forEach(inst => (inst.relationships || []).forEach(r => {
    const t = String(r.to || '').trim();
    if (t) targetCounts[t] = (targetCounts[t] || 0) + 1;
  }));
  const closest = Object.entries(targetCounts).sort((a, b) => b[1] - a[1])[0];
  // v335: collect all work characters for closest-to link resolution
  let allWorkChars = [];
  try {
    for (const inst of d.instances) {
      if (inst.workId) {
        const wc = await CharacterStore.listForWork(inst.workId);
        allWorkChars = allWorkChars.concat(wc);
      }
    }
  } catch (e) {}

  let html = '<div class="view-head"><button class="btn sm ghost" onclick="goBack()">← Back</button></div>' +
    '<div class="ch-hero">' +
    charAvatar(d.name, primaryRole, 84) +
    '<div class="ch-hero-info"><h2 class="serif">' + esc(d.name) + '</h2>' +
    '<span class="chip dbtrope ch-role-' + esc(primaryRole) + '">' + esc(CHAR_ROLE_LABELS[primaryRole] || primaryRole) + '</span>' +
    (d.aliases && d.aliases.length ? '<p class="note">Also known as: ' + esc(d.aliases.join(', ')) + '</p>' : '') +
    '</div></div>' +
    '<div class="stat-row ch-stats">' +
    '<div class="stat"><div class="n">' + d.instances.length + '</div><div class="l">' + (d.instances.length === 1 ? 'Book' : 'Books') + '</div></div>' +
    '<div class="stat"><div class="n">' + relCount + '</div><div class="l">Connections</div></div>' +
    (closest ? '<div class="stat"><div class="n" style="font-size:0.9em;line-height:1.2">' + charRelLink(closest[0], allWorkChars) + '</div><div class="l">Closest to</div></div>' : '') +
    '</div>';
  if (d.description) html += '<p class="ch-desc">' + esc(d.description) + '</p>';

  // Appears in — cover cards. v335: exact normalized title lookup
  // (Security Advisor: fuzzy includes() caused wrong covers)
  const normTitle = t => String(t || '').toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
  const coverByTitle = new Map();
  try {
    for (const b of (typeof library !== 'undefined' ? library : []) || []) {
      if (b && b.title && b.cover) {
        const k = normTitle(b.title);
        if (k && !coverByTitle.has(k)) coverByTitle.set(k, b.cover);
      }
    }
  } catch (e) {}
  html += '<h3 class="serif">Appears in</h3><div class="ch-books">';
  for (const inst of d.instances) {
    const cover = coverByTitle.get(normTitle(inst.workTitle)) || '';
    html += '<div class="ch-book-card">' +
      (cover ? '<img src="' + esc(cover) + '" alt="" loading="lazy">' : '<div class="ch-book-nocover">' + esc(String(inst.workTitle || '?')[0]) + '</div>') +
      '<div class="ch-book-meta"><b>' + esc(inst.workTitle) + '</b><br>' +
      '<span class="chip dbtrope sm">' + esc(CHAR_ROLE_LABELS[inst.role] || inst.role || '?') + '</span>' +
      (inst.name !== d.name ? '<br><span class="note">as "' + esc(inst.name) + '"</span>' : '') +
      '</div></div>';
  }
  html += '</div>';

  // Relationships: v339 Phase C graph + text lists below
  html += '<h3 class="serif">Relationships</h3>';
  try {
    // Collect all relationships across instances for the graph
    const allRels = [];
    const graphWorkChars = [];
    for (const inst of d.instances) {
      (inst.relationships || []).forEach(r => allRels.push(r));
      try {
        if (inst.workId) {
          const wc = await CharacterStore.listForWork(inst.workId);
          graphWorkChars.push(...wc);
        }
      } catch (e) {}
    }
    const grouped = charGroupRelationships(allRels);
    const primaryRole = charPrimaryRole(d.instances);
    html += charGraphHTML(grouped, graphWorkChars, d.name, primaryRole);
  } catch (e) {}
  let hasRels = false;
  for (const inst of d.instances) {
    if (!inst.relationships.length) continue;
    hasRels = true;
    // Fetch work characters for link resolution
    let wChars = [];
    try { wChars = await CharacterStore.listForWork(inst.workId); } catch (e) {}
    html += '<h4 class="serif">' + esc(inst.workTitle) + '</h4><p>';
    const byType = {};
    // v338: dedupe parent/child contradictions
    const seenParents = new Set();
    inst.relationships.forEach(r => {
      if (charNormRelType(r.type) === 'parent')
        seenParents.add(String(r.to || '').trim().toLowerCase());
    });
    inst.relationships.forEach(r => {
      const t = charNormRelType(r.type);
      if (t === 'child' && seenParents.has(String(r.to || '').trim().toLowerCase())) return;
      (byType[t] || (byType[t] = [])).push(r.to);
    });
    html += Object.keys(byType).sort().map(t =>
      '<b>' + esc(t) + ':</b> ' + byType[t].map(n => charRelLink(n, wChars)).join(', ')
    ).join('<br>');
    html += '</p>';
  }
  if (!hasRels) html += '<p class="note">No recorded relationships.</p>';

  // v336: memorable quotes
  try {
    const quotes = await CharacterWiki.getQuotesForCanonical(characterViewId);
    html += charQuotesHTML(quotes);
  } catch (e) {}

  // Per-user notes
  html += '<h3 class="serif">My notes</h3>' +
    '<textarea id="ch-note" class="text-input" rows="3" placeholder="Your thoughts on this character…">' +
    esc(d.userNote ? d.userNote.note : '') + '</textarea>' +
    '<p><button class="btn sm" id="ch-note-save">Save note</button> ' +
    '<span class="note" id="ch-note-msg"></span></p>';

  setView(html);
  wireCharRelLinks(document.getElementById('view'));
  // Wire graph nodes (they use the same data attributes)
  document.querySelectorAll('.ch-graph-node[data-chwiki]').forEach(b =>
    b.addEventListener('click', () => openCharacter(b.getAttribute('data-chwiki'))));
  document.querySelectorAll('.ch-graph-node[data-chbook]').forEach(b =>
    b.addEventListener('click', () => openBookCharacter(b.getAttribute('data-chbook'))));
  document.getElementById('ch-note-save').addEventListener('click', async (e) => {
    const btn = e.target, msg = document.getElementById('ch-note-msg');
    const text = document.getElementById('ch-note').value;
    btn.disabled = true;
    try {
      await CharacterWiki.saveNote(characterViewId, text);
      if (msg) msg.textContent = 'Saved.';
    } catch (err) { if (msg) msg.textContent = 'Failed: ' + ((err && err.message) || err); }
    btn.disabled = false;
  });
}
