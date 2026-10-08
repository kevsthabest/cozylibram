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

/* v339: Phase C — relationship graph.
   v369: rebuilt with D3 force-directed layout (was hand-rolled SVG).
   Protagonist pinned at center, click to expand/collapse, drag to rearrange,
   pan/zoom via D3. Filters to important relationships. */

function charGraphHTML(grouped, workChars, centerName, centerRole) {
  if (!grouped || !grouped.length) return '';
  // v370: always emit markup — initD3Graph handles lazy-loading D3

  // v365: only important relationships — family, partners, or high importance
  const importantTypes = new Set(['spouse', 'parent', 'child', 'sibling', 'partner', 'fiance']);
  const important = grouped.filter(n => {
    if ((n.importance || 3) >= 4) return true;
    return (n.types || []).some(t => importantTypes.has(t));
  });
  const nodes = (important.length ? important : grouped).slice(0, 12);

  const uid = 'd3graph' + Math.random().toString(36).slice(2, 8);

  // Build D3 data structures
  // v370: include full relationship data for expansion
  const centerId = '__center__';
  const charData = {};
  charData[centerId] = { name: centerName, group: 'hero' };

  const typeToGroup = {
    spouse: 'romance', partner: 'romance', fiance: 'romance',
    parent: 'family', child: 'family', sibling: 'family',
    friend: 'friend', mentor: 'mentor', enemy: 'rival', rival: 'rival',
  };

  // Build a map of character name -> their relationships (for expansion)
  const relMap = {};
  if (workChars) {
    workChars.forEach(c => {
      const key = String(c.name || '').toLowerCase();
      if (key && c.relationships) {
        relMap[key] = c.relationships;
      }
    });
  }

  nodes.forEach((n, i) => {
    const id = 'n' + i;
    const primaryType = (n.types || [])[0] || 'friend';
    // v370: store this node's own relationships for expansion
    const ownRels = relMap[String(n.name || '').toLowerCase()] || [];
    charData[id] = {
      name: n.name,
      group: typeToGroup[primaryType] || 'friend',
      _rels: ownRels, // for expansion
      _orig: n, // for navigation
    };
  });

  const relations = nodes.map((n, i) => [centerId, 'n' + i, (n.types || [])[0] || 'friend']);

  // Store data for the D3 init
  const dataJson = JSON.stringify({ charData, relations, centerId, centerName }).replace(/</g, '\\u003c');

  let h = '<div class="ch-graph-wrap d3-graph-wrap">';
  h += '<div id="' + uid + '-hud" class="d3-hud">';
  h += '<div class="d3-hint">Tap a character to expand • Drag bubbles • Scroll/pinch to zoom</div>';
  h += '<div class="d3-legend" id="' + uid + '-legend"></div>';
  h += '</div>';
  h += '<svg id="' + uid + '" class="d3-graph" style="width:100%;height:400px;display:block;touch-action:none;"></svg>';
  h += '<script type="application/json" id="' + uid + '-data">' + dataJson + '</script>';
  h += '</div>';

  return h;
}

/* v369: Initialize D3 graph after render. Called from renderCharacterPage.
   v370: D3 lazy-loads on first use (not render-blocking). */
function initD3Graph(box) {
  if (!box) return;
  if (typeof d3 === 'undefined') {
    // Lazy-load D3
    const script = document.createElement('script');
    script.src = './vendor/d3.min.js';
    script.onload = () => initD3Graph(box);
    script.onerror = () => {
      box.querySelectorAll('.d3-graph-wrap').forEach(w => {
        w.innerHTML = '<p class="note">Relationship graph unavailable.</p>';
      });
    };
    document.head.appendChild(script);
    return;
  }
  box.querySelectorAll('.d3-graph-wrap').forEach(wrap => {
    const svgEl = wrap.querySelector('svg.d3-graph');
    if (!svgEl || svgEl.dataset.d3wired) return;
    svgEl.dataset.d3wired = '1';

    const uid = svgEl.id;
    const dataEl = document.getElementById(uid + '-data');
    if (!dataEl) return;

    let data;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }

    const { charData, relations, centerId } = data;
    const PROTAG = centerId;

    // Demo color scheme adapted to CozyLibram theme
    const groupColors = {
      hero: '#c9a227',
      family: '#e9a37b',
      friend: '#8fc1a3',
      romance: '#e68fa8',
      mentor: '#9aa7e0',
      rival: '#c9876f',
    };
    const typeToGroup = {
      spouse: 'romance', partner: 'romance', fiance: 'romance',
      parent: 'family', child: 'family', sibling: 'family',
      friend: 'friend', mentor: 'mentor', enemy: 'rival', rival: 'rival',
    };

    const LINK_DIST = { family: 95, friend: 120, romance: 100, mentor: 130, rival: 150 };

    const svg = d3.select(svgEl);
    const width = svgEl.clientWidth || 400;
    const height = 400;
    svg.attr('viewBox', '0 0 ' + width + ' ' + height);

    const root = svg.append('g');
    const linkLayer = root.append('g');
    const nodeLayer = root.append('g');

    let nodes = [], links = [];
    const expanded = new Set([PROTAG]);
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DUR = reduceMotion ? 0 : 500;

    const radius = d => (d.id === PROTAG ? 36 : expanded.has(d.id) ? 28 : 22);

    const sim = d3.forceSimulation()
      .velocityDecay(0.35)
      .alphaDecay(0.02)
      .on('tick', ticked);

    function applyForces() {
      sim
        .force('link', d3.forceLink(links).id(d => d.id)
          .distance(l => (LINK_DIST[l.type] || 110)).strength(0.55))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('collide', d3.forceCollide(d => radius(d) + 16).strength(0.9))
        .force('x', d3.forceX(width / 2).strength(0.04))
        .force('y', d3.forceY(height / 2).strength(0.04));
    }

    function pin() {
      const p = nodes.find(n => n.id === PROTAG);
      if (p) { p.fx = width / 2; p.fy = height / 2; }
    }

    function spawn(id, origin) {
      const o = origin || { x: width / 2, y: height / 2 };
      const a = Math.random() * Math.PI * 2;
      return { id, x: o.x + Math.cos(a) * 4, y: o.y + Math.sin(a) * 4 };
    }

    function update(origin) {
      console.log('[D3] update called, expanded:', [...expanded], 'relations:', relations.length);
      const ids = new Set(expanded);
      const nextLinks = [];
      for (const [a, b, type] of relations) {
        if (expanded.has(a) || expanded.has(b)) {
          ids.add(a); ids.add(b);
          nextLinks.push({ source: a, target: b, type });
        }
      }
      const old = new Map(nodes.map(n => [n.id, n]));
      nodes = [...ids].map(id => old.get(id) || spawn(id, origin));
      console.log('[D3] nodes after update:', nodes.length, 'ids:', [...ids]);
      links = nextLinks;
      sim.nodes(nodes);
      sim.force('link').links(links);
      pin();
      applyForces();

      // v374: join on .link-group (not .link) so labels exit with their lines
      const lsel = linkLayer.selectAll('.link-group').data(links, d => d.source.id + '|' + d.target.id);
      lsel.exit().transition().duration(DUR / 2).attr('opacity', 0).remove();
      // v373: edge labels showing relationship type
      const lenter = lsel.enter().append('g').attr('class', 'link-group');
      lenter.append('line').attr('class', 'link')
        .attr('stroke', d => groupColors[charData[d.source.id] ? charData[d.source.id].group : 'friend'] || '#888')
        .attr('stroke-opacity', 0);
      lenter.append('text').attr('class', 'link-label')
        .text(d => d.type || '')
        .style('font-size', '9px')
        .style('fill', textColor)
        .style('text-anchor', 'middle')
        .attr('pointer-events', 'none')
        .attr('opacity', 0);
      lenter.select('.link').transition().delay(DUR / 4).duration(DUR).attr('stroke-opacity', 0.55);
      lenter.select('.link-label').transition().delay(DUR / 4).duration(DUR).attr('opacity', 0.9);
      linkG = lenter.merge(lsel);

      const nsel = nodeLayer.selectAll('.node').data(nodes, d => d.id);
      nsel.exit().select('.bubble').transition().duration(DUR / 2)
        .attr('transform', 'scale(0)').on('end', function() { this.parentNode.remove(); });

      const nenter = nsel.enter().append('g').attr('class', 'node')
        .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')')
        .call(drag)
        .on('click', (e, d) => toggle(d));
      const bubble = nenter.append('g').attr('class', 'bubble').attr('transform', 'scale(0)');
      bubble.append('circle').attr('r', radius);
      bubble.append('text').attr('class', 'initials').attr('text-anchor', 'middle').attr('dy', '0.35em');
      bubble.append('text').attr('class', 'd3-name').attr('text-anchor', 'middle');
      bubble.transition().duration(DUR).attr('transform', 'scale(1)');

      nodeG = nenter.merge(nsel);
      styleNodes(300);
    }

    let nodeG = null, linkG = null;

    function styleNodes(dur) {
      if (!nodeG) return;
      nodeG.select('circle').transition().duration(dur).attr('r', radius)
        .attr('fill', d => groupColors[charData[d.id] ? charData[d.id].group : 'friend'] || '#888');
      nodeG.select('.initials')
        .text(d => {
          const name = charData[d.id] ? charData[d.id].name : '?';
          return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        })
        .style('font-size', d => radius(d) * 0.6 + 'px')
        .attr('fill', '#fff').attr('font-weight', '700')
        .attr('pointer-events', 'none');
      // v374: read --text from computed styles (works for all themes)
      const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#4a3b32';
      nodeG.select('.d3-name')
        .text(d => charData[d.id] ? charData[d.id].name : '')
        .attr('y', d => radius(d) + 15)
        .style('font-size', '11px')
        .style('fill', textColor)
        .attr('pointer-events', 'none');
    }

    function toggle(d) {
      if (d.id === PROTAG) return;
      // v370: expand with the node's own relationships
      if (expanded.has(d.id)) {
        expanded.delete(d.id);
      } else {
        expanded.add(d.id);
        // Add this node's relationships to the graph
        const nodeData = charData[d.id];
        if (nodeData && nodeData._rels) {
          nodeData._rels.forEach(r => {
            const targetName = String(r.to || '').trim();
            if (!targetName) return;
            // Find or create node for target
            let targetId = Object.keys(charData).find(id =>
              charData[id].name.toLowerCase() === targetName.toLowerCase());
            if (!targetId) {
              targetId = 'x' + Math.random().toString(36).slice(2, 8);
              const rType = String(r.type || 'friend').toLowerCase();
              charData[targetId] = {
                name: targetName,
                group: typeToGroup[rType] || 'friend',
                _rels: [],
              };
            }
            // Add relation if not already present
            const relType = String(r.type || 'friend').toLowerCase();
            if (!relations.some(rel =>
              (rel[0] === d.id && rel[1] === targetId) ||
              (rel[0] === targetId && rel[1] === d.id))) {
              relations.push([d.id, targetId, relType]);
            }
          });
        }
      }
      update(d);
      sim.alpha(0.7).restart();
      // Update legend with new groups
      const legendEl = document.getElementById(uid + '-legend');
      if (legendEl) {
        const usedGroups = [...new Set(Object.values(charData).map(c => c.group))];
        legendEl.innerHTML = usedGroups.map(g =>
          '<span style="--c:' + (groupColors[g] || '#888') + '">' + g + '</span>').join('');
      }
    }

    // v373: drag stops propagation so it doesn't trigger canvas pan
    const drag = d3.drag()
      .filter((e, d) => d.id !== PROTAG && !e.button)
      .on('start', (e, d) => {
        e.sourceEvent.stopPropagation();
        if (!e.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (e, d) => {
        e.sourceEvent.stopPropagation();
        d.fx = e.x; d.fy = e.y;
      })
      .on('end', (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });

    svg.call(d3.zoom().scaleExtent([0.4, 2.5])
      .on('zoom', e => root.attr('transform', e.transform)))
      .on('dblclick.zoom', null);

    function ticked() {
      if (!nodeG || !linkG) return;
      nodeG.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
      linkG.select('.link')
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      // v373: position labels at link midpoints
      linkG.select('.link-label')
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 4);
    }

    // Legend
    const legendEl = document.getElementById(uid + '-legend');
    if (legendEl) {
      const usedGroups = [...new Set(Object.values(charData).map(c => c.group))];
      legendEl.innerHTML = usedGroups.map(g =>
        '<span style="--c:' + (groupColors[g] || '#888') + '">' + g + '</span>').join('');
    }

    applyForces(); // v372: must run before first update() — sets up the link force
    update();
    sim.alpha(0.7).restart();
  });
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
function wireCharRelLinks(box, excludeSel) {
  if (!box) return;
  box.querySelectorAll('[data-chwiki]').forEach(b => b.addEventListener('click', () => {
    if (excludeSel && b.closest(excludeSel)) return;
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
    html += charGraphHTML(grouped, allWorkChars, d.name, primaryRole);
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
  initD3Graph(viewBox);
  // v367: wireCharRelLinks skips graph nodes (graph handler owns all taps)
  wireCharRelLinks(viewBox, '.ch-graph-wrap');
  // v369: graph nodes handled by D3 (see initD3Graph)
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
