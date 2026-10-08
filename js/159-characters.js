'use strict';

/* ---------------- Character wiki (v322) ----------------
   User-facing character pages: shared canonical data + per-user notes.
   - Shared: characters, book_characters, character_links (canonical identity)
   - Per-user: character_notes (personal annotations)
   Linked from the book modal's Cast section. Read-only shared data in v1;
   edit suggestions come later. */

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
      const tier1 = visible.filter(c => c.role === 'protagonist' || c.role === 'antagonist');
      const tier2 = visible.filter(c => c.role === 'supporting');
      const tier3 = visible.filter(c => c.role === 'minor');
      return { tier1, tier2, tier3, total: visible.length };
    } catch (e) { return { tier1: [], tier2: [], tier3: [], total: 0 }; }
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
  characterViewId = charId;
  view = 'character';
  animateIn = true;
  render();
  window.scrollTo(0, 0);
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

  // Relationships merged across books, labeled by source
  html += '<h3 class="serif">Relationships</h3>';
  let hasRels = false;
  d.instances.forEach(inst => {
    if (!inst.relationships.length) return;
    hasRels = true;
    html += '<h4 class="serif">' + esc(inst.workTitle) + '</h4><p>';
    const byType = {};
    inst.relationships.forEach(r => {
      const t = charNormRelType(r.type);
      (byType[t] || (byType[t] = [])).push(r.to);
    });
    html += Object.keys(byType).sort().map(t =>
      '<b>' + esc(t) + ':</b> ' + byType[t].map(n => esc(n)).join(', ')
    ).join('<br>');
    html += '</p>';
  });
  if (!hasRels) html += '<p class="note">No recorded relationships.</p>';

  // Per-user notes
  html += '<h3 class="serif">My notes</h3>' +
    '<textarea id="ch-note" class="text-input" rows="3" placeholder="Your thoughts on this character…">' +
    esc(d.userNote ? d.userNote.note : '') + '</textarea>' +
    '<p><button class="btn sm" id="ch-note-save">Save note</button> ' +
    '<span class="note" id="ch-note-msg"></span></p>';

  setView(html);
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
