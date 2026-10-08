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
    let html = '<div class="view-head"><button class="btn sm ghost" onclick="goBack()">← Back</button>' +
      '<h2 class="serif">' + esc(data.name) + '</h2></div>' +
      '<p><span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[data.role] || data.role || '?') + '</span> ' +
      '<span class="note">in ' + esc(w.title || 'unknown book') + '</span></p>';
    if (data.description) html += '<p>' + esc(data.description) + '</p>';
    const rels = Array.isArray(data.relationships) ? data.relationships : [];
    if (rels.length) {
      html += '<h3 class="serif">Relationships</h3><p>';
      const byType = {};
      rels.forEach(r => {
        const t = charNormRelType(r.type);
        (byType[t] || (byType[t] = [])).push(r.to);
      });
      html += Object.keys(byType).sort().map(t =>
        '<b>' + esc(t) + ':</b> ' + byType[t].map(n => charRelLink(n, workChars)).join(', ')
      ).join('<br>');
      html += '</p>';
    }
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
  let html = '<div class="view-head"><button class="btn sm ghost" onclick="goBack()">← Back</button>' +
    '<h2 class="serif">' + esc(d.name) + '</h2></div>';
  if (d.description) html += '<p>' + esc(d.description) + '</p>';
  if (d.aliases && d.aliases.length)
    html += '<p class="note">Also known as: ' + esc(d.aliases.join(', ')) + '</p>';

  // Appears in
  html += '<h3 class="serif">Appears in (' + d.instances.length + ')</h3><div class="ch-list">';
  d.instances.forEach(inst => {
    html += '<div class="ch-card"><b>' + esc(inst.workTitle) + '</b> ' +
      '<span class="chip dbtrope">' + esc(CHAR_ROLE_LABELS[inst.role] || inst.role || '?') + '</span><br>' +
      '<span class="note">as "' + esc(inst.name) + '"</span></div>';
  });
  html += '</div>';

  // Relationships merged across books, labeled by source. v333: names are tappable.
  html += '<h3 class="serif">Relationships</h3>';
  let hasRels = false;
  for (const inst of d.instances) {
    if (!inst.relationships.length) continue;
    hasRels = true;
    // Fetch work characters for link resolution
    let wChars = [];
    try { wChars = await CharacterStore.listForWork(inst.workId); } catch (e) {}
    html += '<h4 class="serif">' + esc(inst.workTitle) + '</h4><p>';
    const byType = {};
    inst.relationships.forEach(r => {
      const t = charNormRelType(r.type);
      (byType[t] || (byType[t] = [])).push(r.to);
    });
    html += Object.keys(byType).sort().map(t =>
      '<b>' + esc(t) + ':</b> ' + byType[t].map(n => charRelLink(n, wChars)).join(', ')
    ).join('<br>');
    html += '</p>';
  }
  if (!hasRels) html += '<p class="note">No recorded relationships.</p>';

  // Per-user notes
  html += '<h3 class="serif">My notes</h3>' +
    '<textarea id="ch-note" class="text-input" rows="3" placeholder="Your thoughts on this character…">' +
    esc(d.userNote ? d.userNote.note : '') + '</textarea>' +
    '<p><button class="btn sm" id="ch-note-save">Save note</button> ' +
    '<span class="note" id="ch-note-msg"></span></p>';

  setView(html);
  wireCharRelLinks(document.getElementById('view'));
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
