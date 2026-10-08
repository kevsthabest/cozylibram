'use strict';

/* ---------------- Character wiki (v322) ----------------
   User-facing character pages: shared canonical data + per-user notes.
   - Shared: characters, book_characters, character_links (canonical identity)
   - Per-user: character_notes (personal annotations)
   Linked from the book modal's Cast section. Read-only shared data in v1;
   edit suggestions come later. */

/* v331: back navigation for character pages — returns to library
   (no character index exists yet to return to) */
/* v342: character breadcrumb stack. When navigating character→character,
   push the current view so Back walks the chain. Empty stack → origin. */
let charNavStack = [];
/* v353: modal return target — when opening a character from a book modal,
   stash the book ID so Back can restore the modal (triage #9) */
let charModalReturn = null;
function charPushNav(targetId) {
  // v343: clear stale crumbs on fresh entry (Advisor HIGH)
  if (view === 'character' && characterViewId) {
    // v343 LOW: skip self-push (tapping link to current character)
    if (targetId && targetId === characterViewId) return;
    charNavStack.push({ type: 'canonical', id: characterViewId });
  } else if (view === 'bookcharacter' && bookCharViewId) {
    if (targetId && targetId === bookCharViewId) return;
    charNavStack.push({ type: 'book', id: bookCharViewId });
  } else {
    charClearNav();
  }
  if (charNavStack.length > 30) charNavStack = charNavStack.slice(-30);
}
function charPopNav() {
  const prev = charNavStack.pop();
  if (!prev) return false;
  if (prev.type === 'canonical') {
    characterViewId = prev.id;
    view = 'character';
  } else {
    bookCharViewId = prev.id;
    view = 'bookcharacter';
  }
  animateIn = true;
  render();
  return true;
}
function charClearNav() { charNavStack = []; }

function goBack() {
  // v342: walk the character breadcrumb first
  try { if (charPopNav()) return; } catch (e) {}
  // v353: restore book modal if we came from one (triage #9)
  try {
    if (charModalReturn && typeof openPreviewModal === 'function') {
      const bookId = charModalReturn;
      charModalReturn = null;
      const book = (typeof library !== 'undefined' ? library : []).find(b => b.id === bookId);
      if (book) { openPreviewModal(book); return; }
    }
  } catch (e) {}
  charModalReturn = null;
  try { go('library'); } catch (e) { try { history.back(); } catch (err) {} }
}

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
  // v353: stash modal return target before closing (triage #9)
  try {
    if (typeof previewOpenId !== 'undefined' && previewOpenId) {
      charModalReturn = previewOpenId;
    }
  } catch (e) {}
  // v332: close the book modal first — click its close button so the
  // overlay token, scroll lock, and history entry are cleaned up properly
  try { const x = document.getElementById('m-x'); if (x) x.click(); } catch (e) {}
  try { const mr = document.getElementById('modal-root'); if (mr) mr.innerHTML = ''; } catch (e) {}
  // v342: push current character to breadcrumb before navigating away
  try { charPushNav(charId); } catch (e) {}
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

/* v346: spoiler protection. Spoiler-gated content is blurred by default
   (per-device setting, default ON). Tap to reveal. */
function spoilersHidden() {
  try {
    const v = localStorage.getItem('cl_hide_spoilers');
    return v === null ? true : v === '1'; // default ON
  } catch (e) { return true; }
}
function setSpoilersHidden(hide) {
  try { localStorage.setItem('cl_hide_spoilers', hide ? '1' : '0'); } catch (e) {}
}
/* Wrap spoilerish HTML. When hidden, shows a blur + tap-to-reveal. */
function spoilerWrap(html, label) {
  if (!spoilersHidden()) return html;
  // v347: aria-hidden on blur so screen readers don't announce spoilers (Advisor MEDIUM)
  // v357: hint is eye icon + "Tap to reveal" (aria-label carries the context)
  return '<span class="spoiler" tabindex="0" role="button" aria-label="' + esc(label || 'Spoiler') + ' (hidden)">' +
    '<span class="spoiler-blur" aria-hidden="true">' + html + '</span>' +
    '<span class="spoiler-hint">' + icon('eye') + '<span>Tap to reveal</span></span>' +
    '</span>';
}
/* Wire spoiler tap-to-reveal (event delegation, works for dynamic content) */
function spoilerToggle(sp, reveal) {
  const blur = sp.querySelector('.spoiler-blur');
  if (reveal) {
    sp.classList.add('revealed');
    if (blur) blur.setAttribute('aria-hidden', 'false');
    sp.setAttribute('aria-label', sp.getAttribute('aria-label').replace(' (hidden)', ' (revealed)'));
  } else {
    sp.classList.remove('revealed');
    if (blur) blur.setAttribute('aria-hidden', 'true');
    sp.setAttribute('aria-label', sp.getAttribute('aria-label').replace(' (revealed)', ' (hidden)'));
  }
}
document.addEventListener('click', function(e) {
  const sp = e.target.closest && e.target.closest('.spoiler');
  if (!sp) return;
  if (!e.target.closest('a, button:not(.spoiler)')) {
    spoilerToggle(sp, !sp.classList.contains('revealed'));
  }
});
// v347: keyboard support for spoiler buttons (WCAG 2.1.1)
document.addEventListener('keydown', function(e) {
  const sp = e.target.closest && e.target.closest('.spoiler');
  if (!sp) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    spoilerToggle(sp, !sp.classList.contains('revealed'));
  }
});

/* v341: Phase D — story timeline. Horizontal journey across books showing
   the character's role evolution and key relationships per book.
   Instances are ordered by series position when available, else by title. */
function charTimelineHTML(instances, workCharsByWorkId) {
  if (!instances || instances.length < 2) return ''; // timeline needs 2+ books
  // Sort by series position if available, else alphabetically
  // v344: normalize positions (handles range strings like "0.1-0.5" via parseFloat)
  const posNum = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const sorted = [...instances].sort((a, b) => {
    const pa = posNum(a.seriesPos), pb = posNum(b.seriesPos);
    if (pa != null && pb != null) return pa - pb;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return String(a.workTitle || '').localeCompare(String(b.workTitle || ''));
  });

  let h = '<h3 class="serif">Story timeline</h3><div class="ch-timeline">';
  sorted.forEach((inst, i) => {
    const isLast = i === sorted.length - 1;
    const rels = (inst.relationships || []).slice(0, 3);
    // Resolve top relationship names to links
    const wChars = (workCharsByWorkId && inst.workId && workCharsByWorkId[inst.workId]) || [];
    const relLinks = rels.map(r => {
      const name = String(r.to || '');
      try {
        if (typeof charResolveTarget !== 'undefined' && wChars.length) {
          const res = charResolveTarget(name, wChars);
          if (res.character) {
            const c = res.character;
            const attr = c.characterId ? 'data-chwiki="' + esc(c.characterId) + '"' : 'data-chbook="' + esc(c.id) + '"';
            return '<button class="taplink sm" ' + attr + '>' + esc(name) + '</button>';
          }
        }
      } catch (e) {}
      return esc(name);
    }).join(' · ');

    h += '<div class="ch-tl-item' + (isLast ? ' last' : '') + '">' +
      '<div class="ch-tl-dot ch-role-' + esc(inst.role || 'minor') + '"></div>' +
      '<div class="ch-tl-content">' +
      '<b>' + esc(inst.workTitle) + '</b><br>' +
      '<span class="chip dbtrope sm">' + esc((typeof CHAR_ROLE_LABELS !== 'undefined' && CHAR_ROLE_LABELS[inst.role]) || inst.role || '?') + '</span>' +
      (inst.name ? '<br><span class="note">as "' + esc(inst.name) + '"</span>' : '') +
      (relLinks ? '<div class="ch-tl-rels">' + relLinks + '</div>' : '') +
      '</div></div>';
  });
  h += '</div>';
  return h;
}

/* v339: Phase C — interactive SVG relationship constellation.
   v365: rebuilt as zoomable/pannable canvas. Click a node to expand
   that character's own connections. Filters to important relationships
   (family/partners or importance >= 4).
   Renders the character at center with relationship nodes arranged in a
   circle. Nodes are tappable (navigate to character pages). Edges are
   colored by relationship type. */
function charGraphHTML(grouped, workChars, centerName, centerRole) {
  if (!grouped || !grouped.length) return '';
  // v365: only important relationships — family, partners, or high importance
  // v366: NULL importance treated as 3 (old default) so pre-v2.6.2 data isn't hidden
  const importantTypes = new Set(['spouse', 'parent', 'child', 'sibling', 'partner', 'fiance']);
  const important = grouped.filter(n => {
    if ((n.importance || 3) >= 4) return true;
    return (n.types || []).some(t => importantTypes.has(t));
  });
  const nodes = (important.length ? important : grouped).slice(0, 12);
  const extra = grouped.length - nodes.length;

  const W = 400, H = 400, cx = W / 2, cy = H / 2, R = 140;
  const typeColors = {
    spouse: '#e74c3c', partner: '#e74c3c', fiance: '#e74c3c',
    parent: '#c9a227', child: '#f5d76e',
    sibling: '#9b59b6', friend: '#2ecc71', enemy: '#8b0000',
    mentor: '#3498db', colleague: '#6aa8e5',
  };

  const uid = 'cg' + Math.random().toString(36).slice(2, 8);
  let svg = '<svg id="' + uid + '" viewBox="0 0 ' + W + ' ' + H + '" class="ch-graph" ' +
    'style="width:100%;max-width:420px;height:auto;display:block;margin:0 auto;touch-action:none;cursor:grab;" ' +
    'data-cx="' + cx + '" data-cy="' + cy + '">';

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
    const imp = n.importance || 3;
    const r = 16 + (imp * 2.5);
    const initials = String(n.name).trim().split(/\s+/).map(w => [...w][0]).join('').slice(0, 2).toUpperCase();
    let tapAttr = '';
    let expandAttr = '';
    try {
      if (typeof charResolveTarget !== 'undefined' && workChars) {
        const res = charResolveTarget(n.name, workChars);
        if (res.character) {
          const c = res.character;
          // v366: nodes get BOTH — tap expands, double-tap navigates to page
          // (Advisor HIGH: was either/or)
          const hasRels = c.relationships && c.relationships.length > 0;
          if (hasRels) expandAttr = ' data-expand="' + esc(n.name) + '"';
          tapAttr = c.characterId
            ? ' data-chwiki="' + esc(c.characterId) + '"'
            : ' data-chbook="' + esc(c.id) + '"';
        }
      }
    } catch (e) {}
    const label = esc(n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name);
    // v365: use style for fill (CSS vars don't work in presentation attributes)
    svg += '<g' + tapAttr + expandAttr + ' class="ch-graph-node" style="cursor:pointer">' +
      '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + color + '" opacity="0.9"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + 5).toFixed(1) + '" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">' + esc(initials) + '</text>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + r + 14).toFixed(1) + '" text-anchor="middle" style="fill:var(--text)" font-size="10">' + label + '</text>' +
      '</g>';
  });

  // Center node
  const centerInitials = String(centerName || '?').trim().split(/\s+/).map(w => [...w][0]).join('').slice(0, 2).toUpperCase();
  const centerColor = { protagonist: '#c9a227', antagonist: '#8b0000', supporting: '#2c5f8a', minor: '#5a5a5a' }[centerRole] || '#5a5a5a';
  svg += '<circle cx="' + cx + '" cy="' + cy + '" r="32" fill="' + centerColor + '"/>' +
    '<text x="' + cx + '" y="' + (cy + 6) + '" text-anchor="middle" fill="#fff" font-size="15" font-weight="700">' + esc(centerInitials) + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 50) + '" text-anchor="middle" style="fill:var(--text)" font-size="11" font-weight="600">' + esc(centerName || '') + '</text>';
  svg += '</svg>';

  let h = '<div class="ch-graph-wrap" data-graph="' + uid + '">' + svg;
  h += '<p class="note" style="text-align:center;font-size:11px">Drag to pan • Scroll/pinch to zoom • Tap a bubble to explore</p>';
  if (extra > 0) h += '<p class="note" style="text-align:center">+' + extra + ' more connections listed below</p>';
  const usedTypes = [...new Set(nodes.map(n => n.types[0]))];
  h += '<div class="ch-graph-legend">' + usedTypes.map(t =>
    '<span><i style="background:' + (typeColors[t] || '#888') + '"></i>' + esc(t) + '</span>'
  ).join('') + '</div></div>';

  return h;
}

/* v366: wire graph interactivity (pan/zoom/expand).
   Called after setView — inline scripts don't execute via innerHTML. */
function wireCharGraph(box) {
  if (!box) return;
  box.querySelectorAll('.ch-graph-wrap').forEach(wrap => {
    const svg = wrap.querySelector('svg.ch-graph');
    if (!svg || svg.dataset.wired) return;
    svg.dataset.wired = '1';
    const W = 400, H = 400;
    let vb = { x: 0, y: 0, w: W, h: H };
    let startVB = null, startPt = null, moved = 0;
    const setVB = () => svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
    const toPt = e => {
      const p = svg.createSVGPoint();
      p.x = e.clientX; p.y = e.clientY;
      return p.matrixTransform(svg.getScreenCTM().inverse());
    };
    svg.addEventListener('pointerdown', e => {
      startVB = { ...vb }; startPt = toPt(e); moved = 0;
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
      svg.style.cursor = 'grabbing';
    });
    svg.addEventListener('pointermove', e => {
      if (!startPt) return;
      const p = toPt(e);
      const dx = p.x - startPt.x, dy = p.y - startPt.y;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      vb.x = startVB.x - dx; vb.y = startVB.y - dy;
      setVB();
    });
    const endPan = () => { startPt = null; svg.style.cursor = 'grab'; };
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const s = e.deltaY > 0 ? 1.15 : 0.87;
      const p = toPt(e);
      vb.x = p.x - (p.x - vb.x) * s;
      vb.y = p.y - (p.y - vb.y) * s;
      vb.w *= s; vb.h *= s;
      vb.w = Math.max(100, Math.min(W * 2, vb.w));
      vb.h = Math.max(100, Math.min(H * 2, vb.h));
      setVB();
    }, { passive: false });
    // Tap: expand (single) vs navigate (double). Ignore if dragged.
    let lastTap = 0, lastTarget = null;
    svg.addEventListener('click', e => {
      if (moved > 8) return; // was a drag, not a tap
      const g = e.target.closest('[data-expand]');
      if (!g) return;
      const now = Date.now();
      const name = g.getAttribute('data-expand');
      if (now - lastTap < 400 && lastTarget === g) {
        // Double-tap: navigate to character page
        const wikiId = g.getAttribute('data-chwiki');
        const bookId = g.getAttribute('data-chbook');
        if (wikiId && typeof openCharacter === 'function') openCharacter(wikiId);
        else if (bookId && typeof openPreviewModal === 'function') {
          // find book by id — handled by existing wireCharRelLinks
        }
        lastTap = 0; lastTarget = null;
      } else {
        // Single tap: expand
        lastTap = now; lastTarget = g;
        setTimeout(() => {
          if (Date.now() - lastTap >= 400 && lastTarget === g) {
            const uid = svg.id;
            if (typeof charExpandGraph === 'function') charExpandGraph(name, uid);
            lastTap = 0; lastTarget = null;
          }
        }, 410);
      }
    });
  });
}

/* v365: expand a graph node to center on that character.
   v366: re-renders via charGraphHTML and re-wires with wireCharGraph. */
function charExpandGraph(name, svgId) {
  try {
    const wrap = document.querySelector('[data-graph="' + svgId + '"]');
    if (!wrap) return;
    const dataEl = document.getElementById(svgId + '-data');
    if (!dataEl) return;
    const allChars = JSON.parse(dataEl.textContent || '[]');
    const target = allChars.find(c =>
      String(c.name || '').toLowerCase() === String(name || '').toLowerCase());
    if (!target || !target.relationships) return;
    const grouped = charGroupRelationships(target.relationships);
    if (!grouped.length) {
      if (typeof toast === 'function') toast('No recorded relationships for ' + name);
      return;
    }
    // Re-render graph centered on the new character
    const newHTML = charGraphHTML(grouped, allChars, target.name, target.role);
    const tmp = document.createElement('div');
    tmp.innerHTML = newHTML;
    const newWrap = tmp.querySelector('.ch-graph-wrap');
    if (newWrap) {
      wrap.innerHTML = newWrap.innerHTML;
      wrap.appendChild(dataEl); // preserve data store
      // Re-wire interactivity
      wireCharGraph(wrap.parentElement || document);
      // Update the data-graph UID to the new SVG's ID
      const newSvg = wrap.querySelector('svg.ch-graph');
      if (newSvg) wrap.setAttribute('data-graph', newSvg.id);
    }
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    console.warn('charExpandGraph failed', e);
  }
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
    if (!byPerson[key]) byPerson[key] = { name, types: new Set(), contradicted: false, importance: 0 };
    byPerson[key].types.add(type);
    // v348: track max importance across duplicate entries
    const imp = parseInt(r.importance, 10);
    if (Number.isFinite(imp) && imp > byPerson[key].importance) byPerson[key].importance = imp;
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
    importance: p.importance || null,
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
  // v342: push current character to breadcrumb before navigating away
  try { charPushNav(bookCharId); } catch (e) {}
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
  // v340: fetch all work characters once (shared by closest-to, graph, timeline).
  // Parallel via Promise.all, deduped by workId.
  let allWorkChars = [];
  const workCharsByWorkId = {};
  try {
    const workIds = [...new Set(d.instances.map(i => i.workId).filter(Boolean))];
    const results = await Promise.all(workIds.map(wid =>
      CharacterStore.listForWork(wid).catch(() => [])));
    workIds.forEach((wid, idx) => { workCharsByWorkId[wid] = results[idx] || []; });
    allWorkChars = results.flat();
  } catch (e) {}

  let html = '<div class="view-head"><button class="btn sm ghost" onclick="goBack()">← Back</button></div>' +
    '<div class="ch-hero">' +
    charAvatar(d.name, primaryRole, 84) +
    '<div class="ch-hero-info"><h2 class="serif">' + esc(d.name) + '</h2>' +
    '<span class="chip dbtrope ch-role-' + esc(primaryRole) + '">' + esc(CHAR_ROLE_LABELS[primaryRole] || primaryRole) + '</span>' +
    (d.aliases && d.aliases.length ? '<p class="note">Also known as: ' + esc(d.aliases.join(', ')) + '</p>' : '') +
    (() => {
      // v348: appearance description from pipeline (first non-empty across instances)
      const app = d.instances.map(i => i.appearance).find(a => a && a.trim());
      return app ? '<p class="ch-appearance">' + esc(app) + '</p>' : '';
    })() +
    (() => {
      // v348: first appearance — earliest book by seriesPos (Advisor MEDIUM).
      // v349: null seriesPos → Infinity (deprioritize unknowns when seeking earliest),
      // opposite of v347's -1 for story-latest. Chapters aren't comparable across books.
      const withChap = d.instances.filter(i => i.firstAppearance != null);
      if (!withChap.length) return '';
      const first = [...withChap].sort((a, b) =>
        ((a.seriesPos == null ? Infinity : a.seriesPos) - (b.seriesPos == null ? Infinity : b.seriesPos)))[0];
      return '<p class="note">First appears: Chapter ' + first.firstAppearance +
        (withChap.length > 1 ? ' (' + esc(first.workTitle) + ')' : '') + '</p>';
    })() +
    (() => {
      // v346: character status is spoiler-gated (alive/dead is a spoiler)
      // v347: pick story-latest via seriesPos (Advisor MEDIUM); skip if all unknown
      const withStatus = d.instances.filter(i => i.status);
      if (!withStatus.length) return '';
      if (withStatus.every(i => i.status === 'unknown')) return '';
      const sorted = [...withStatus].sort((a, b) => ((b.seriesPos == null ? -1 : b.seriesPos) - (a.seriesPos == null ? -1 : a.seriesPos)));
      const latest = sorted[0].status;
      const label = { alive: 'Alive', dead: 'Deceased', unknown: 'Unknown', missing: 'Missing' }[latest] || latest;
      const cls = latest === 'dead' ? 'ch-status-dead' : latest === 'alive' ? 'ch-status-alive' : '';
      return '<p>' + spoilerWrap('<span class="chip dbtrope sm ' + cls + '">' + esc(label) + '</span>', 'Character status') + '</p>';
    })() +
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
  // v362: sort by (series name, position) — groups multi-series characters correctly.
  // v363: instances carry series name from works.series (added in v341 query)
  const sortedInstances = [...d.instances].sort((a, b) => {
    const sa = String((a.series && a.series.name) || '').toLowerCase();
    const sb = String((b.series && b.series.name) || '').toLowerCase();
    if (sa !== sb) return sa.localeCompare(sb);
    const pa = parseFloat(a.seriesPos), pb = parseFloat(b.seriesPos);
    const na = Number.isFinite(pa) ? pa : Infinity, nb = Number.isFinite(pb) ? pb : Infinity;
    if (na !== nb) return na - nb;
    return String(a.workTitle || '').localeCompare(String(b.workTitle || ''));
  });
  for (const inst of sortedInstances) {
    const cover = coverByTitle.get(normTitle(inst.workTitle)) || '';
    html += '<div class="ch-book-card">' +
      (cover ? '<img src="' + esc(cover) + '" alt="" loading="lazy">' : '<div class="ch-book-nocover"><span>' + esc(inst.workTitle || '?') + '</span></div>') +
      '<div class="ch-book-meta"><b>' + esc(inst.workTitle) + '</b><br>' +
      '<span class="chip dbtrope sm">' + esc(CHAR_ROLE_LABELS[inst.role] || inst.role || '?') + '</span>' +
      (inst.name !== d.name ? '<br><span class="note">as "' + esc(inst.name) + '"</span>' : '') +
      '</div></div>';
  }
  html += '</div>';

  // v341 Phase D: story timeline (needs 2+ books). Reuses workCharsByWorkId.
  try {
    if (d.instances.length >= 2) {
      html += charTimelineHTML(d.instances, workCharsByWorkId);
    }
  } catch (e) {}

  // Relationships: v339 Phase C graph + text lists below
  html += '<h3 class="serif">Relationships</h3>';
  try {
    // Collect all relationships across instances for the graph.
    // v340: reuses allWorkChars fetched above (no duplicate queries).
    const allRels = [];
    for (const inst of d.instances) {
      (inst.relationships || []).forEach(r => allRels.push(r));
    }
    const grouped = charGroupRelationships(allRels);
    const graphHTML = charGraphHTML(grouped, allWorkChars, d.name, primaryRole);
    // v365: store character data for graph expansion (hidden JSON)
    if (graphHTML && allWorkChars) {
      const uid = graphHTML.match(/id="(cg[a-z0-9]+)"/);
      if (uid) {
        const slim = allWorkChars.map(c => ({
          name: c.name, role: c.role,
          relationships: c.relationships || [],
        }));
        html += graphHTML.replace('</div>',
          '<script type="application/json" id="' + uid[1] + '-data">' +
          JSON.stringify(slim).replace(/</g, '\\u003c') + '</script></div>');
      } else {
        html += graphHTML;
      }
    } else {
      html += graphHTML;
    }
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
  const viewBox = document.getElementById('view');
  wireCharRelLinks(viewBox);
  wireCharGraph(viewBox);
  // Wire graph nodes (they use the same data attributes)
  document.querySelectorAll('.ch-graph-node[data-chwiki]').forEach(b =>
    b.addEventListener('click', () => openCharacter(b.getAttribute('data-chwiki'))));
  document.querySelectorAll('.ch-graph-node[data-chbook]').forEach(b =>
    b.addEventListener('click', () => openBookCharacter(b.getAttribute('data-chbook'))));
  // v341: wire timeline relationship links
  document.querySelectorAll('.ch-tl-rels [data-chwiki]').forEach(b =>
    b.addEventListener('click', () => openCharacter(b.getAttribute('data-chwiki'))));
  document.querySelectorAll('.ch-tl-rels [data-chbook]').forEach(b =>
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
