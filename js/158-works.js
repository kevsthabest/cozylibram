'use strict';

/* ---------------- Work / Edition resolution (v205) ----------------
   Identity moved from ISBN-keyed to Work-keyed. A Work is the underlying
   book (title + authors); an Edition is one published version (ISBN,
   publisher, format…). Tropes live on the Work, so every edition of the
   same book shares one trope set instead of fragmenting across ISBNs.

   resolveWork(book) -> work uuid or null. Find-or-create against the
   shared tables:
     1. Prefer the register_work() RPC (#363): one server-side call
        that finds or creates the work on (title_norm, author_norm),
        registers the edition under real ISBN validation, and merges
        provider ids fill-missing-only. A rejected ISBN (bad check
        digit) or a conflict ISBN (owned by another work) never sinks
        or hijacks the work — the RPC still returns its id, mirroring
        the silent best-effort outcomes the direct writes produced.
     2. RPC absent (the migration has not applied yet): SELECT works
        by (title_norm, author_norm); missing: upsert on the
        UNIQUE(title_norm, author_norm) constraint (the constraint
        makes concurrent creators converge on one row); best-effort:
        register the edition by ISBN (insert, ignoreDuplicates — an
        ISBN never changes works).
   Never throws: offline, signed-out, and RLS denials all resolve null,
   and callers fall back to the legacy book_key path. Resolved ids are
   cached per session keyed by the book's stable key.

   #363: the fallback in step 2 writes through the "works: user
   insert" / "editions: user insert" RLS policies, whose checks are
   presence-only. The v653 migration drops those policies and makes
   register_work() the only client registration path — which is why
   this client is tolerant in the v643 pattern (RPC preferred, direct
   writes while they still work) and ships FIRST: the migration must
   only apply once this client is live, or resolution would fail
   closed for every user until it caught up. */

/* Pure: identity keys for a book. Returns null when the book has no
   usable title — such a book cannot resolve to a work. Norms use
   tropeNormIdent (js/157), the client mirror of SQL norm_ident(). */
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export function workKeysFor(book) {
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

/* #363: PostgREST reports an unknown function as PGRST202 with a
   "could not find the function ... in the schema cache" message —
   the same discriminator the push guard uses (js/090). It is how
   resolve() tells "the v653 migration has not applied yet" (fall
   back to the direct writes) apart from a real registration error
   (fail closed). */
function registerWorkMissing(e) {
  const s = String((e && (e.code + ' ' + e.message)) || e || '');
  return /PGRST20[0-9]|schema cache|could not find|does not exist|404/i.test(s);
}

export const WorkStore = {
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
      // #363: the RPC is the preferred path (see _register). Provider
      // ids the book already carries (Hardcover id from enrichment,
      // OL work key) go up as proposals; the server merges them
      // fill-missing-only, which retires the direct provider_ids
      // UPDATE _mergeProviderIds used to issue — an UPDATE that
      // silently no-opped for non-admins anyway, since works has
      // never had a user UPDATE policy.
      const reg = await this._register(sb, keys, providerIdsFromBook(book));
      if (reg) {
        this._cache[ck] = reg.work_id;
        return reg.work_id;
      }
      // Pre-migration fallback: the direct writes below are what the
      // insert policies still allow. They carry no provider ids —
      // merging waits for the RPC rather than reviving the retired
      // UPDATE for the shrinking window before the migration lands.
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

  /* #363: one registration attempt through the register_work() RPC
     (supabase/migrations/v653_catalogue_registration_rpc.sql). The
     RPC performs the whole registration server-side — find-or-create
     on the natural key, the provider-id merge, edition registration
     under ISBN shape + check-digit validation — and answers
     { work_id, edition_id, created_work, created_edition, isbn }
     with isbn one of absent / rejected / registered / existing /
     conflict. Callers here only consume work_id: a rejected or
     conflicted ISBN still resolves the work, exactly as the old
     silent best-effort upserts behaved, so no outcome needs new
     handling or new UI.
     Returns the result object, or null when the function is not on
     the server yet (the PGRST202 class — see registerWorkMissing) so
     the caller falls back to the direct writes; a client without an
     rpc surface (a test fake) reads the same way. An answer without
     a work_id is not the function talking and also reads as missing.
     Any other RPC error throws: once the migration has applied the
     fallback cannot write anyway, and failing closed (resolve
     returns null; the legacy book_key path carries the UI) beats
     guessing at a half-applied registration. */
  async _register(sb, keys, providerIds) {
    if (!sb || typeof sb.rpc !== 'function') return null;
    const { data, error } = await sb.rpc('register_work', {
      p_title: keys.title,
      p_title_norm: keys.titleNorm,
      p_authors: keys.authors,
      p_author_norm: keys.authorNorm,
      p_series: keys.series,
      p_isbn: keys.isbn,
      p_provider_ids: providerIds || {},
    });
    if (error) {
      if (registerWorkMissing(error)) return null;
      throw error;
    }
    if (!data || typeof data !== 'object' || !data.work_id) return null;
    return data;
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

  /* v524: bulk, READ-ONLY work spice lookup for the content shield
     (js/230). Unlike resolve(), this never creates work rows — browsing
     a friend's shelves must not mutate the shared tables. One select
     for the whole list, matched on (title_norm, author_norm) in JS.
     Returns { 'titleNorm|authorNorm': spice } with the v313 baseline
     precedence (manual wins whenever set, else detected); works with
     no spice data are absent from the map. Never throws. */
  async spiceMapFor(books, opts) {
    opts = opts || {};
    const out = {};
    try {
      const keys = [];
      const seen = new Set();
      (books || []).forEach(b => {
        let k = null;
        try { k = workKeysFor(b); } catch (e) { k = null; }
        if (!k) return;
        const id = k.titleNorm + '|' + k.authorNorm;
        if (seen.has(id)) return;
        seen.add(id);
        keys.push({ id: id, titleNorm: k.titleNorm });
      });
      if (!keys.length) return out;
      let sb = null;
      try { sb = opts.getClient ? await opts.getClient() : await cloudClient(); }
      catch (e) { sb = null; }
      if (!sb) return out;
      const titles = Array.from(new Set(keys.map(k => k.titleNorm)));
      const { data, error } = await sb.from('works')
        .select('title_norm, author_norm, spice_detected, spice_manual')
        .in('title_norm', titles);
      if (error || !Array.isArray(data)) return out;
      const byKey = {};
      data.forEach(r => {
        if (!r) return;
        const man = (r.spice_manual == null) ? null : Number(r.spice_manual);
        const det = (r.spice_detected == null) ? null : Number(r.spice_detected);
        const v = (man != null && Number.isFinite(man) && man >= 0 && man <= 5) ? man
          : (det != null && Number.isFinite(det) && det >= 0 && det <= 5) ? det : null;
        if (v != null) byKey[String(r.title_norm) + '|' + String(r.author_norm)] = v;
      });
      keys.forEach(k => { if (byKey[k.id] != null) out[k.id] = byKey[k.id]; });
      return out;
    } catch (e) { return out; }
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

};

/* Convenience wrapper used by the trope read path. Guards for contexts
   (older tests, cached pages) where js/158 hasn't loaded. */
export async function resolveWork(book, opts) {
  try {
    if (typeof WorkStore === 'undefined' || !WorkStore) return null;
    return await WorkStore.resolve(book, opts);
  } catch (e) { return null; }
}

/* v272: provider IDs a book already carries, keyed by the works.provider_ids
   conventions (see supabase/migrations/v272_work_provider_ids.sql).
   Pure — safe to call anywhere. */
export function providerIdsFromBook(book) {
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
   work was already resolved.
   #363: the attach is a re-registration. register_work() converges on
   the same work (find-or-create on the natural key) and merges the
   proposed ids fill-missing-only, so proposing the newly learned ids
   IS the attach — and unlike resolve() it bypasses the session cache,
   because an attach exists precisely when resolution already happened.
   Before the v653 migration the RPC is absent and the attach is a
   no-op, which is also what the retired direct UPDATE amounted to for
   every non-admin caller: works has never had a user UPDATE policy,
   so it silently changed nothing. */
export async function workAttachProviderIds(book, ids) {
  try {
    if (typeof WorkStore === 'undefined' || !WorkStore) return;
    const keys = ids && Object.keys(ids).filter(k => ids[k] != null && ids[k] !== '');
    if (!keys || !keys.length) return;
    let wkeys = null;
    try { wkeys = workKeysFor(book); } catch (e) { wkeys = null; }
    if (!wkeys) return;
    let sb = null;
    try { sb = await cloudClient(); } catch (e) { return; }
    if (!sb) return;
    await WorkStore._register(sb, wkeys, ids);
  } catch (e) {}
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/070-hardcover.js, js/138-editions.js, js/150-modal-discovery.js, js/157-trope-inference.js, js/198-discovery.js, js/212-dna.js, js/225-book-portrait.js and js/230-privacy.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.workKeysFor = workKeysFor;
window.WorkStore = WorkStore;
window.resolveWork = resolveWork;
window.providerIdsFromBook = providerIdsFromBook;
window.workAttachProviderIds = workAttachProviderIds;
