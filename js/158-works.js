'use strict';

/* ---------------- Work / Edition resolution (v205) ----------------
   Identity moved from ISBN-keyed to Work-keyed. A Work is the underlying
   book (title + authors); an Edition is one published version (ISBN,
   publisher, format…). Tropes live on the Work, so every edition of the
   same book shares one trope set instead of fragmenting across ISBNs.

   resolveWork(book) -> work uuid or null. Find-or-create against the
   shared tables:
     1. SELECT works by (title_norm, author_norm).
     2. Missing: upsert on the UNIQUE(title_norm, author_norm) constraint
        (the constraint makes concurrent creators converge on one row).
     3. Best-effort: register the edition by ISBN
        (insert, ignoreDuplicates — an ISBN never changes works).
   Never throws: offline, signed-out, and RLS denials all resolve null,
   and callers fall back to the legacy book_key path. Resolved ids are
   cached per session keyed by the book's stable key.

   v205 requires the "works: user insert" / "editions: user insert" RLS
   policies (metadata-staging/v205_01_claims_user_inserts.sql); without
   them only admins can create works and everyone else resolves null. */

/* Pure: identity keys for a book. Returns null when the book has no
   usable title — such a book cannot resolve to a work. Norms use
   tropeNormIdent (js/157), the client mirror of SQL norm_ident(). */
function workKeysFor(book) {
  book = book || {};
  const title = String(book.title || '').trim();
  const titleNorm = (typeof tropeNormIdent === 'function' ? tropeNormIdent : String)(title);
  if (!titleNorm) return null;
  let authors = book.authors;
  if (typeof authors === 'string') authors = [authors];
  if (!Array.isArray(authors)) authors = [];
  authors = authors.map(a => String(a == null ? '' : a).trim()).filter(Boolean);
  const authorNorm = (typeof tropeNormIdent === 'function' ? tropeNormIdent : String)(authors.join(' ')) || '';
  const digits = String(book.isbn || '').replace(/[^0-9]/g, '');
  const isbn = (digits.length === 10 || digits.length === 13) ? digits : null;
  let series = null;
  try {
    if (book.series && book.series.name) {
      series = { name: String(book.series.name),
                 position: book.series.position == null ? null : book.series.position };
    } else if (typeof book.series === 'string' && book.series.trim()) {
      series = { name: book.series.trim(), position: null };
    }
  } catch (e) { series = null; }
  return { title, titleNorm, authors, authorNorm, isbn, series };
}

const WorkStore = {
  _cache: {}, // stable book key -> work id (or null)

  _cacheKey(book, keys) {
    try {
      if (book && book.id) return 'id:' + book.id;
    } catch (e) {}
    return 'k:' + (keys.isbn || keys.titleNorm + '|' + keys.authorNorm);
  },

  invalidate(book) {
    try {
      const keys = workKeysFor(book);
      if (keys) delete this._cache[this._cacheKey(book, keys)];
    } catch (e) {}
  },

  clear() { this._cache = {}; },

  /* Resolve (finding or creating) the shared work for a book.
     opts.getClient injects the Supabase client (tests); otherwise
     cloudClient() is used. Never throws — returns null on any failure. */
  async resolve(book, opts) {
    opts = opts || {};
    let keys = null;
    try { keys = workKeysFor(book); } catch (e) { keys = null; }
    if (!keys) return null;
    const ck = this._cacheKey(book, keys);
    if (Object.prototype.hasOwnProperty.call(this._cache, ck)) return this._cache[ck];
    let sb = null;
    try { sb = opts.getClient ? await opts.getClient() : await cloudClient(); }
    catch (e) { sb = null; }
    if (!sb) return null;
    try {
      let id = await this._selectId(sb, keys);
      if (!id) {
        const { data, error } = await sb.from('works').upsert({
          title: keys.title,
          title_norm: keys.titleNorm,
          authors: keys.authors,
          author_norm: keys.authorNorm,
          series: keys.series,
        }, { onConflict: 'title_norm,author_norm' }).select('id').maybeSingle();
        if (error) throw error;
        id = (data && data.id) || await this._selectId(sb, keys);
      }
      if (id && keys.isbn) {
        // Edition registration is best-effort and never reassigns an ISBN.
        try {
          await sb.from('editions').upsert(
            { work_id: id, isbn: keys.isbn },
            { onConflict: 'isbn', ignoreDuplicates: true });
        } catch (e) { /* an unregistered edition doesn't block the work */ }
      }
      // v272: work identity hub — fold provider IDs the book already
      // carries (Hardcover id from enrichment, OL work key) into
      // works.provider_ids. Best-effort; identity capture never blocks
      // resolution.
      try { await this._mergeProviderIds(sb, id, providerIdsFromBook(book)); }
      catch (e) { /* pre-migration DBs lack the column — ignore */ }
      this._cache[ck] = id || null;
      return id || null;
    } catch (e) {
      // RLS denial, network blip, schema mismatch — session-cache the miss
      // so one failure doesn't retry on every book view; the legacy
      // book_key path keeps the UI working.
      this._cache[ck] = null;
      return null;
    }
  },

  async _selectId(sb, keys) {
    const { data, error } = await sb.from('works')
      .select('id')
      .eq('title_norm', keys.titleNorm)
      .eq('author_norm', keys.authorNorm)
      .maybeSingle();
    if (error) throw error;
    return (data && data.id) || null;
  },

  /* v313: fetch the work-level spice baseline for a book. Returns
     { detected, manual } (ints or null), or null when the work can't be
     resolved or the query fails. Never throws. */
  async getSpice(book, opts) {
    opts = opts || {};
    try {
      const id = await this.resolve(book, opts);
      if (!id) return null;
      let sb = null;
      try { sb = opts.getClient ? await opts.getClient() : await cloudClient(); }
      catch (e) { sb = null; }
      if (!sb) return null;
      const { data, error } = await sb.from('works')
        .select('spice_detected, spice_manual').eq('id', id).maybeSingle();
      if (error || !data) return null;
      const det = Number(data.spice_detected);
      const man = Number(data.spice_manual);
      return {
        detected: Number.isFinite(det) && det >= 0 && det <= 5 ? det : null,
        manual: Number.isFinite(man) && man >= 0 && man <= 5 ? man : null,
      };
    } catch (e) { return null; }
  },

  /* v402: fetch chapter-level metadata for progressive disclosure.
     Returns { triggerChapters, chapterSpice, avgDialogueRatio } (nulls when
     absent), or null when the work can't be resolved. Never throws. */
  async getChapterMeta(book, opts) {
    opts = opts || {};
    try {
      const id = await this.resolve(book, opts);
      if (!id) return null;
      let sb = null;
      try { sb = opts.getClient ? await opts.getClient() : await cloudClient(); }
      catch (e) { sb = null; }
      if (!sb) return null;
      const { data, error } = await sb.from('works')
        .select('trigger_chapters, chapter_spice, avg_dialogue_ratio')
        .eq('id', id).maybeSingle();
      if (error || !data) return null;
      return {
        triggerChapters: (data.trigger_chapters && typeof data.trigger_chapters === 'object') ? data.trigger_chapters : null,
        chapterSpice: Array.isArray(data.chapter_spice) ? data.chapter_spice : null,
        avgDialogueRatio: (typeof data.avg_dialogue_ratio === 'number' && isFinite(data.avg_dialogue_ratio)) ? data.avg_dialogue_ratio : null,
      };
    } catch (e) { return null; }
  },

  /* v272: merge provider IDs into a work's provider_ids JSONB. Only fills
     keys that are absent or different — a capture never clobbers a
     previously stored identity. No-op when there's nothing to merge. */
  async _mergeProviderIds(sb, workId, ids) {
    ids = ids || {};
    const keys = Object.keys(ids).filter(k => ids[k] != null && ids[k] !== '');
    if (!sb || !workId || !keys.length) return;
    const { data, error } = await sb.from('works')
      .select('provider_ids').eq('id', workId).maybeSingle();
    if (error) throw error;
    const cur = (data && data.provider_ids) || {};
    const merged = { ...cur };
    let changed = false;
    for (const k of keys) {
      if (merged[k] !== ids[k]) { merged[k] = ids[k]; changed = true; }
    }
    if (!changed) return;
    const { error: uErr } = await sb.from('works')
      .update({ provider_ids: merged }).eq('id', workId);
    if (uErr) throw uErr;
  },
};

/* Convenience wrapper used by the trope read path. Guards for contexts
   (older tests, cached pages) where js/158 hasn't loaded. */
async function resolveWork(book, opts) {
  try {
    if (typeof WorkStore === 'undefined' || !WorkStore) return null;
    return await WorkStore.resolve(book, opts);
  } catch (e) { return null; }
}

/* v272: provider IDs a book already carries, keyed by the works.provider_ids
   conventions (see supabase/migrations/v272_work_provider_ids.sql).
   Pure — safe to call anywhere. */
function providerIdsFromBook(book) {
  const ids = {};
  try {
    book = book || {};
    if (book.hcId != null && String(book.hcId) !== '') ids.hardcover_id = String(book.hcId);
    const wk = String(book.workKey || '');
    if (/^\/works\/OL\d+W$/i.test(wk)) ids.openlibrary_id = wk;
  } catch (e) {}
  return ids;
}

/* v272: best-effort attach of provider IDs to a book's work. Never throws
   and never blocks the caller — identity capture is advisory. Used by
   flows (like Hardcover enrichment) that learn a provider ID after the
   work was already resolved. */
async function workAttachProviderIds(book, ids) {
  try {
    if (typeof WorkStore === 'undefined' || !WorkStore) return;
    const keys = ids && Object.keys(ids).filter(k => ids[k] != null && ids[k] !== '');
    if (!keys || !keys.length) return;
    const id = await resolveWork(book);
    if (!id) return;
    let sb = null;
    try { sb = await cloudClient(); } catch (e) { return; }
    if (!sb) return;
    await WorkStore._mergeProviderIds(sb, id, ids);
  } catch (e) {}
}
