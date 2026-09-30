'use strict';

/* ---------------- Trope inference client (v152) ----------------
   Provider-agnostic LLM trope tagger. Every supported provider
   (OpenRouter, Gemini, Groq, Ollama, any custom OpenAI-compatible
   endpoint) speaks the OpenAI chat-completions wire format, so one
   client covers all of them.

   The API key NEVER touches this file: the browser POSTs to the
   same-origin /api/trope-infer proxy (server.py locally,
   functions/api/trope-infer.js on Cloudflare Pages), which attaches
   the key server-side. /config.js only tells the client whether a
   key is configured, plus the provider/model names for display.

   Core (prompt building, parsing, validation) has no DOM dependencies
   so it stays unit-testable. TropeQueue paces calls (one at a time,
   4s apart) and persists its cursor in localStorage so a backfill
   survives reloads and tab closes. */

const TROPE_INFER_TIMEOUT_MS = 90000;
const TROPE_QUEUE_DELAY_MS = 4000;
const TROPE_QUEUE_STORE_KEY = 'cozylibram.tropequeue.v1';
/* v156: raised from 1200 — free reasoning models can spend 1000+ tokens on
   chain-of-thought before emitting the JSON, which truncated output
   (finish_reason: length) and produced "unparseable model output". */
const TROPE_MAX_TOKENS = 2000;

/* Informational: where the server proxy sends requests per provider.
   The client never calls these directly. */
const TROPE_PROVIDERS = {
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1',
  custom: null, // admin-supplied base URL, server-side only
};

/* Pure: is trope inference configured on this server? */
function tropeInferenceConfigured() {
  try {
    return !!(window.SPICY_CONFIG && window.SPICY_CONFIG.trope);
  } catch (e) { return false; }
}

/* Pure: display info about the configured provider (names only, no secrets).
   v160: reflects the shared provider/model override when one is set. */
function tropeProviderInfo() {
  try {
    const c = window.SPICY_CONFIG || {};
    const ov = (typeof tropeProviderCache !== 'undefined' && tropeProviderCache) || null;
    return {
      provider: (ov && ov.provider) || c.tropeProvider || '',
      model: (ov && ov.model) || c.tropeModel || '',
      overridden: !!(ov && ov.provider && ov.model),
    };
  } catch (e) { return { provider: '', model: '' }; }
}

/* ---------------- Live taxonomy (v157) ----------------
   The shared `tropes` table is the source of truth at runtime: Trope Lab
   approvals land there immediately, and this layer merges them over the
   bundled js/156-trope-taxonomy.js file (which remains the offline
   fallback and the initial seed). Inference prompts, id validation, and
   duplicate checks all read the MERGED list, so an approved trope is
   inferable the moment it is approved — no file edit, no redeploy.

   `taxonomy_meta.rev` bumps on every approval; book_tropes rows stamp the
   rev they were inferred under, so Trope Lab can mark books stale when the
   taxonomy grows. The last-known live taxonomy is cached in localStorage
   so an offline device keeps inferring with it. Never throws. */

const TROPE_TAXONOMY_STORE_KEY = 'cozylibram.tropetaxonomy.v1';

const TropeTaxonomy = {
  _db: null,   // array of {id,name,description,genres} from the shared table
  _rev: 1,     // taxonomy_meta rev last seen
  _ready: false,

  /* Merged list: bundled file first, DB rows override/add by id. */
  list() {
    if (!this._db || !this._db.length) return TROPES;
    const byId = {};
    TROPES.forEach(t => { byId[t.id] = t; });
    this._db.forEach(t => { byId[t.id] = t; });
    return Object.keys(byId).map(k => byId[k]);
  },

  /* Live id lookup: DB additions first, then the bundled file. */
  byId(id) {
    if (!id) return null;
    if (this._db) {
      for (const t of this._db) if (t.id === id) return t;
    }
    return tropeById(id);
  },

  /* v207: resolve a free-text term to a canonical id (alias-aware).
     Exact ids win; known aliases map to their canonical id; excluded
     or unknown terms return null. Only canonical ids ever come back —
     validation and storage stay on the catalog. Works over the merged
     live list, so DB rows may carry their own aliases/exclusions. */
  resolveId(term) {
    return tropeResolveId(term, this.list());
  },

  forGenres(genres) {
    return tropesForGenres(genres, this.list());
  },

  rev() { return this._rev; },

  _persist() {
    try {
      localStorage.setItem(TROPE_TAXONOMY_STORE_KEY,
        JSON.stringify({ db: this._db || [], rev: this._rev }));
    } catch (e) {}
  },

  _restore() {
    try {
      const raw = localStorage.getItem(TROPE_TAXONOMY_STORE_KEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.db)) return false;
      this._db = o.db.filter(t => t && t.id && t.name);
      this._rev = o.rev > 0 ? o.rev : 1;
      this._ready = true;
      return true;
    } catch (e) { return false; }
  },

  /* Pull the shared taxonomy + rev. Restores the cached copy when offline
     or signed out. Tolerates a pre-v157 database (no taxonomy_meta yet):
     the live rows still merge, rev just stays 1. Resolves true when the
     live table was reached. */
  async refresh() {
    let sb = null;
    try { sb = await cloudClient().catch(() => null); } catch (e) { sb = null; }
    if (!sb) { if (!this._ready) this._restore(); return false; }
    try {
      const tropesRes = await sb.from('tropes')
        .select('id, name, description, genres').limit(5000);
      if (tropesRes.error) throw tropesRes.error;
      const rows = (tropesRes.data || []).filter(t => t && t.id && t.name);
      // Only adopt the live table when it actually has the seed in it;
      // an empty table means the admin hasn't seeded yet — keep the file.
      if (!rows.length) {
        if (!this._ready) this._restore();
        return false;
      }
      let rev = 1;
      try {
        const metaRes = await sb.from('taxonomy_meta')
          .select('rev').eq('id', 1).maybeSingle();
        if (metaRes && metaRes.data && metaRes.data.rev > 0) rev = metaRes.data.rev;
      } catch (e) { /* pre-v157 database: rev stays 1 */ }
      this._db = rows.map(t => ({
        id: t.id, name: t.name, description: t.description || '',
        genres: Array.isArray(t.genres) ? t.genres : [],
      }));
      this._rev = rev;
      this._ready = true;
      this._persist();
      return true;
    } catch (e) { /* fall through to cache */ }
    if (!this._ready) this._restore();
    return false;
  },

  /* Called right after a Trope Lab approval so the new trope is live
     instantly, without waiting for the next refresh. */
  noteApproved(trope, rev) {
    trope = trope || {};
    if (!trope.id || !trope.name) return;
    const db = (this._db || []).filter(t => t.id !== trope.id);
    db.push({ id: trope.id, name: trope.name,
      description: trope.description || '',
      genres: Array.isArray(trope.genres) ? trope.genres : [] });
    this._db = db;
    if (rev > 0) this._rev = rev;
    this._ready = true;
    this._persist();
  },
};

/* Map the app's free-form category strings onto taxonomy genres. */
const TROPE_GENRE_ALIASES = [
  [/dark[\s-]*romance/, 'dark-romance'],
  [/romance/, 'romance'],
  [/fantas/, 'fantasy'],
  [/science[\s-]*fiction|sci[\s-]*fi/, 'sci-fi'],
  [/mystery|thriller|suspense|\bcrime\b/, 'mystery-thriller'],
  [/horror/, 'horror'],
  [/histor/, 'historical'],
  [/contemporary|literary fiction|general fiction/, 'contemporary'],
  [/non[\s-]*fiction|biography|memoir/, 'non-fiction'],
];

/* Pure: app categories -> TROPE_GENRES subset. */
function appGenresToTropeGenres(categories) {
  const out = new Set();
  (categories || []).forEach(c => {
    const s = String(c).toLowerCase();
    TROPE_GENRE_ALIASES.forEach(([re, g]) => { if (re.test(s)) out.add(g); });
  });
  return [...out];
}

const TROPE_SYSTEM_PROMPT = [
  'You are a fiction metadata tagger for a book catalog. Read the book\'s',
  'title, author, genres, and description, then tag it with tropes from the',
  'fixed taxonomy below.',
  '',
  'STRICT RULES',
  '1. You may ONLY use trope ids from the TAXONOMY list. Never invent,',
  '   rename, merge, or paraphrase ids. If none fit well, return an empty list.',
  '   Copy each id character-for-character from the list — never emit the',
  '   display name or a reworded variant ("enemies to lovers" is wrong;',
  '   "enemies-to-lovers" is right). Anything that is not exactly an id',
  '   from the list is discarded.',
  '2. Reply with JSON ONLY. No markdown fences, no commentary, no extra keys,',
  '   no reasoning text, no explanations:',
  '   {"tropes": [{"id": "trope-id", "confidence": 0.85,',
  '                "evidence": ["exact quote from the description",',
  '                             "second supporting quote"]}]}',
  '3. Tag 0-8 tropes. Fewer is better than guessing; an empty list is a valid answer.',
  '4. Confidence is 0.0-1.0 and must be grounded in the description: 0.9+ means',
  '   stated outright in the description; 0.7-0.89 means strongly implied by',
  '   description details; 0.5-0.69 means plausible from description evidence.',
  '   Never tag from the title, author, or genre alone — if the description',
  '   does not support it, omit it. Below 0.5, omit the trope.',
  '5. Prefer the most specific fitting trope over a generic one.',
  '6. This is cataloging of published fiction. Tag dark, violent, or sexual',
  '   themes factually where they apply; do not moralize, warn, or refuse.',
  '7. If the description is missing or too thin to tag confidently,',
  '   return {"tropes": []}.',
  '8. For EVERY trope, quote 1-2 SHORT excerpts from the description above',
  '   that support the tag. Quote exactly — never invent, paraphrase, or',
  '   quote the title/author/genres. A trope with no quotable support in',
  '   the description must be omitted, not tagged on a hunch.',
  '',
  'TAXONOMY (id: name — what it means)',
  '{taxonomy_lines}',
].join('\n');

/* Pure: build the { system, user } prompt for a book. Only tropes whose
   genres intersect the book's genres are included — keeps the prompt
   small and kills cross-genre noise. */
function buildTropePrompt(book) {
  book = book || {};
  const genres = appGenresToTropeGenres(book.categories);
  const pool = TropeTaxonomy.forGenres(genres);
  const lines = pool.map(t => t.id + ': ' + t.name + ' — ' + t.description);
  const system = TROPE_SYSTEM_PROMPT.replace('{taxonomy_lines}', lines.join('\n'));
  const authors = Array.isArray(book.authors) ? book.authors.join(', ')
    : String(book.authors || '');
  const user = 'BOOK\nTitle: ' + String(book.title || '') +
    '\nAuthor: ' + authors +
    '\nGenres: ' + (genres.join(', ') || (book.categories || []).join(', ')) +
    '\nDescription: ' + String(book.description || '');
  return { system, user, genres, tropeCount: pool.length };
}

/* Pure: normalize one identifier string for book keys. */
function tropeNormIdent(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^the\s+/, '');
}

/* Pure: stable per-work cache key. ISBN-13 when available, else
   t:<normalized-title>:<normalized-author>. Trope data is about the
   work, not the user's library row, so one inference serves everyone. */
function bookKeyFor(book) {
  book = book || {};
  const digits = String(book.isbn || '').replace(/[^0-9]/g, '');
  if (digits.length === 13) return 'isbn:' + digits;
  const authors = Array.isArray(book.authors) ? book.authors.join(' ') : book.authors;
  return 't:' + tropeNormIdent(book.title) + ':' + tropeNormIdent(authors);
}

/* Pure: defensively parse model output into a raw [{id, confidence}] array.
   Accepts {"tropes":[...]} or a bare array; tolerates markdown fences and
   JSON embedded in reasoning prose. Throws on unparseable output — the
   caller treats that as a failed inference, never as "no tropes". */
function parseTropeResponse(text) {
  if (text == null || String(text).trim() === '') throw new Error('empty response');
  let t = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  /* Candidate spans, most to least specific: the whole text, then the
     greediest {...} block, then the greediest [...] block. The first span
     that parses AND yields a tropes array wins — this handles JSON buried
     in reasoning prose and bare arrays in prose (where the {...} span
     would grab just one inner object and yield no array). */
  const spans = [t];
  const mObj = t.match(/\{[\s\S]*\}/);
  if (mObj && mObj[0] !== t) spans.push(mObj[0]);
  const mArr = t.match(/\[[\s\S]*\]/);
  if (mArr && mArr[0] !== t) spans.push(mArr[0]);
  for (const s of spans) {
    let obj;
    try { obj = JSON.parse(s); } catch (e) { continue; }
    const arr = Array.isArray(obj) ? obj : obj.tropes;
    if (Array.isArray(arr)) return arr;
  }
  throw new Error('unparseable JSON');
}

/* Pure: clean a model's evidence quotes — at most 2, trimmed, capped at
   200 chars each, whitespace-collapsed. Non-array input yields []. */
function cleanEvidence(ev) {
  const out = [];
  for (const q of Array.isArray(ev) ? ev : []) {
    if (out.length >= 2) break;
    const s = String(q == null ? '' : q).replace(/\s+/g, ' ').trim();
    if (s.length >= 4) out.push(s.slice(0, 200));
  }
  return out;
}

/* v208: confidence tiers (single source of truth). High-confidence claims
   WITH quoted evidence auto-publish; everything else stays a candidate
   for human correction. Thresholds are starting points, not permanent. */
const TROPE_CONFIDENCE_TIERS = { high: 0.85, medium: 0.60 };

/* Pure: which tier a validated trope falls in. */
function tropeClaimTier(t) {
  const c = t && isFinite(t.confidence) ? t.confidence : 0;
  if (c >= TROPE_CONFIDENCE_TIERS.high) return 'high';
  if (c >= TROPE_CONFIDENCE_TIERS.medium) return 'medium';
  return 'low';
}

/* Pure: may this validated trope auto-publish? Only high-confidence
   claims with quoted evidence — the human review queue is for
   corrections, not approvals. */
function tropeAutoPublish(t) {
  return tropeClaimTier(t) === 'high' &&
    Array.isArray(t && t.evidence) && t.evidence.length > 0;
}

/* Pure: is this stored claim regenerable AI output (safe to replace on
   re-inference)? AI candidates always; AI auto-confirmed rows too (they
   carry evidence.auto_confirmed). Human/community confirmations and
   rejections are never regenerable. */
function isRegenerableClaim(row) {
  if (!row || row.source_type !== 'ai') return false;
  if (row.status === 'candidate') return true;
  return row.status === 'confirmed' &&
    !!(row.evidence && row.evidence.auto_confirmed === true);
}

/* Pure: stable input hash for the reprocess cache — the same book input
   classified under the same taxonomy version/rev never needs a second API
   call. The model is compared separately (see _pump): with a client model
   override the stored model must match; without one the server default is
   assumed stable. cyrb53, hex; a cache key, not a security hash. */
function tropeInputHash(book) {
  book = book || {};
  const authors = Array.isArray(book.authors) ? book.authors.join(' ')
    : String(book.authors || '');
  const cats = Array.isArray(book.categories) ? book.categories.join(' ')
    : String(book.categories || '');
  const s = [
    tropeNormIdent(book.title), tropeNormIdent(authors),
    String(book.description || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    String(cats).toLowerCase(),
    TROPE_TAXONOMY_VERSION, TropeTaxonomy.rev(),
  ].join('\\x1f');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') +
         (h1 >>> 0).toString(16).padStart(8, '0');
}

/* Pure: validate raw model output against the taxonomy. Unknown ids are
   dropped (the main defense against invented labels), known aliases are
   resolved to their canonical id, confidence is clamped to 0-1,
   duplicates removed, capped at 8.
   v157: validates against the LIVE merged taxonomy, so freshly approved
   community tropes are accepted without a file update.
   v207: alias-aware — the model often emits the display name or a
   synonym ("reverse harem"); those now map to the catalog id instead of
   being silently dropped. Only canonical ids leave this function.
   v208: evidence-aware — each trope carries 1-2 cleaned evidence quotes;
   a trope with no usable evidence loses 0.15 confidence and is dropped
   below 0.5 (unverifiable guesses don't publish). */
function validateTropeResults(raw) {
  const out = [], seen = new Set();
  for (const r of raw || []) {
    if (out.length >= 8) break;
    if (!r || typeof r !== 'object') continue;
    const id = TropeTaxonomy.resolveId(r.id);
    if (!id || seen.has(id)) continue;
    let c = Number(r.confidence);
    if (!isFinite(c)) continue;
    const evidence = cleanEvidence(r.evidence);
    if (!evidence.length) c -= 0.15;
    if (c < 0.5) continue;
    c = Math.min(1, Math.max(0, c));
    seen.add(id);
    out.push({ id, confidence: Math.round(c * 100) / 100, evidence });
  }
  return out;
}

/* Error type for inference failures. `fatal` means "stop the queue"
   (bad key); anything else is per-book and retried later. */
function TropeInferError(message, opts) {
  const e = new Error(message);
  e.name = 'TropeInferError';
  e.fatal = !!(opts && opts.fatal);
  e.status = opts && opts.status;
  return e;
}

/* Pure: backoff delay for attempt n (0-based), honoring Retry-After. */
function tropeBackoffMs(attempt, retryAfterSecs) {
  if (retryAfterSecs != null && isFinite(retryAfterSecs) && retryAfterSecs >= 0) {
    return Math.min(120000, Math.round(retryAfterSecs * 1000));
  }
  return [1000, 4000, 16000][Math.min(attempt, 2)];
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* Infer tropes for one book via the same-origin proxy. Returns
   { tropes, model }. An empty tropes array is a legitimate result;
   any failure throws TropeInferError (fatal=true means "stop the
   queue and tell the admin to check the key"). fetchFn is injectable
   for tests. */
async function inferBookTropes(book, opts) {
  opts = opts || {};
  const fetchFn = opts.fetchFn || fetch;
  const delayFn = opts.delayFn || sleepMs;
  const { system, user } = buildTropePrompt(book);
  /* v156: mutable — truncation/unparseable retries double the budget.
     Reasoning models can burn 1000+ tokens on chain-of-thought, so a fixed
     small budget turned into "unparseable model output" with no recovery. */
  let maxTokens = Math.min(4000, Math.max(100, opts.maxTokens || TROPE_MAX_TOKENS));
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  /* v160: shared provider/model override (Trope Lab picker). When set, the
     proxy routes to that provider with the per-provider server-side key. */
  let providerOverride = null;
  try { providerOverride = await tropeProviderGet(); } catch (e) { providerOverride = null; }
  const reqBodyBase = { messages, max_tokens: maxTokens };
  if (providerOverride && providerOverride.provider && providerOverride.model) {
    reqBodyBase.provider = providerOverride.provider;
    reqBodyBase.model = providerOverride.model;
  }
  let lastErr = null;
  let nudged = false;

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TROPE_INFER_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetchFn('/api/trope-infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, reqBodyBase, { max_tokens: maxTokens })),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw TropeInferError('inference timed out');
      throw TropeInferError('network error: ' + (e && e.message || e));
    }
    clearTimeout(timer);

    const retryAfter = resp.headers && resp.headers.get
      ? Number(resp.headers.get('retry-after')) : NaN;

    if (resp.status === 401 || resp.status === 403) {
      throw TropeInferError('provider rejected the request (HTTP ' + resp.status +
        ') - check the API key', { fatal: true, status: resp.status });
    }
    /* v156/v158: the proxy converts finish_reason:length into a 502 with
       {error:'truncated'}. That is recoverable — retry immediately with a
       bigger budget instead of burning backoff cycles on the same budget.
       v158: a 502 carrying any other body is the provider itself failing,
       so surface the upstream message instead of a bare status code; and
       truncation that persists at the max budget fails fast with a clear
       reason instead of masquerading as a provider outage. */
    if (resp.status === 502) {
      let bodyErr = null;
      try { bodyErr = await resp.json(); } catch (e) { bodyErr = null; }
      const errVal = bodyErr && bodyErr.error;
      if (errVal === 'truncated') {
        if (maxTokens < 4000) {
          maxTokens = Math.min(4000, maxTokens * 2);
          continue;
        }
        throw TropeInferError(
          'model truncated its response at the max token budget (4000) — ' +
          'it burned the budget on reasoning before emitting JSON',
          { status: 502 });
      }
      const upMsg = typeof errVal === 'string' ? errVal
        : (errVal && errVal.message ? String(errVal.message) : '');
      lastErr = TropeInferError('provider HTTP 502' +
        (upMsg ? ': ' + upMsg.slice(0, 160) : ' (upstream gave no reason)'),
        { status: 502 });
      if (attempt >= 3) break;
      await delayFn(tropeBackoffMs(attempt, retryAfter));
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = TropeInferError('provider HTTP ' + resp.status, { status: resp.status });
      if (attempt >= 3) break;
      await delayFn(tropeBackoffMs(attempt, retryAfter));
      continue;
    }
    if (!resp.ok) {
      throw TropeInferError('proxy HTTP ' + resp.status, { status: resp.status });
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw TropeInferError('bad proxy response');
    }
    const text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!text) throw TropeInferError('empty model response');

    let raw;
    try {
      raw = parseTropeResponse(text);
    } catch (e) {
      /* v156: one recovery attempt — nudge JSON-only AND double the token
         budget. Unparseable output is usually a reasoning model that spent
         the whole budget on chain-of-thought, so a text nudge alone (the
         old behavior) just failed the same way again. */
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'user',
          content: 'Reply with JSON only, no other text. Do not explain your reasoning.' });
        if (maxTokens < 4000) maxTokens = Math.min(4000, maxTokens * 2);
        continue;
      }
      throw TropeInferError('unparseable model output');
    }
    return {
      tropes: validateTropeResults(raw),
      model: (data && data.model) || '',
    };
  }
  throw lastErr || TropeInferError('inference failed');
}
/* ---------------- Paced background queue ----------------
   One book at a time, TROPE_QUEUE_DELAY_MS apart. State persists in
   localStorage so a backfill survives reloads; pause/resume is manual.
   The queue never touches the books table or sync — it only upserts
   into book_tropes via the injected upsertRows. */

/* ---------------- Admin all-libraries backfill (v159) ----------------
   Trope Lab (admin-only) can backfill every user's books, not just the
   local library. The admin book list is a minimal projection ({key, book});
   all-libraries jobs are keyed by book_key (stable across users), and the
   queue resolver falls back to the projection when the local library has
   no such id. Cleared together with the queue.
   v202: the projection is no longer persisted to localStorage (it duplicated
   the library). It lives in memory for the scan session and is rebuilt on
   demand from the in-memory library when empty. Consequence: after a reload,
   a resumed backfill can only resolve books in the local library — jobs for
   other users' books are dropped as deleted. Re-run the scan to rebuild the
   full projection. */

const TROPE_ADMIN_BOOKS_KEY = 'cozylibram.tropeadminbooks.v1'; // v202: legacy key, removed on first load
let tropeAdminBookCache = null; // null = not built yet
let tropeAdminLegacyDropped = false;

/* Rebuild the {key, book} projection from the in-memory library. Same
   minimal bibliographic shape the admin scan builds from Supabase rows. */
function tropeAdminBooksRebuild() {
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  return lib.filter(b => b).map(b => ({
    key: bookKeyFor(b),
    book: {
      title: b.title || '',
      authors: b.authors || [],
      categories: b.categories || [],
      isbn: b.isbn || '',
      description: String(b.description || '').slice(0, 2000),
    },
  }));
}

function tropeAdminBooksLoad() {
  if (!tropeAdminLegacyDropped) {
    tropeAdminLegacyDropped = true;
    try { localStorage.removeItem(TROPE_ADMIN_BOOKS_KEY); } catch (e) {}
  }
  if (tropeAdminBookCache === null) tropeAdminBookCache = tropeAdminBooksRebuild();
  return tropeAdminBookCache;
}

/* Minimal book projection for inference, looked up by book_key. */
function tropeAdminBookById(id) {
  if (!id) return null;
  const list = tropeAdminBooksLoad();
  for (const b of list) if (b && b.key === id) return b.book || null;
  return null;
}

/* Keep the admin projection in memory for the scan session (v202: no
   localStorage persistence). */
function tropeAdminBooksSave(list) {
  tropeAdminBookCache = Array.isArray(list) ? list : [];
}

function tropeAdminBooksClear() {
  tropeAdminBookCache = null;
}

/* ---------------- Provider/model override (v160) ----------------
   The admin picks the inference provider + model in Trope Lab; the choice
   lives in the shared trope_provider_settings row and applies to all
   devices. Empty = use the server env defaults (backward compatible).
   Keys stay server-side: the proxy holds one key per provider
   (TROPE_KEY_<PROVIDER>) and the client only names the provider. */

const TROPE_PROVIDER_SETTINGS_KEY = 'cozylibram.tropeprovider.v1';
const TROPE_PROVIDER_SUGGESTIONS = {
  openrouter: ['nvidia/nemotron-nano-9b-v2:free', 'qwen/qwen3-32b:free', 'google/gemma-3-27b-it:free'],
  gemini: ['gemini-3.8-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  ollama: ['llama3.1', 'qwen3'],
  custom: [],
};
let tropeProviderCache = null; // null = not loaded yet
let tropeModelListCache = {}; // v164: provider -> [{id, name}], session cache

/* v164: live model list for the Trope Lab picker. Asks the same-origin
   /api/trope-models proxy (the key stays server-side) for the provider's
   real, currently-available models. Resolves [{id, name}]; rejects when the
   list can't be loaded, and the caller falls back to the hardcoded
   TROPE_PROVIDER_SUGGESTIONS. */
async function tropeModelList(provider) {
  provider = String(provider || '').trim().toLowerCase();
  if (!provider) throw new Error('no provider');
  if (tropeModelListCache[provider]) return tropeModelListCache[provider];
  const r = await fetch('/api/trope-models?provider=' + encodeURIComponent(provider));
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
  const models = (body && Array.isArray(body.models) ? body.models : [])
    .filter(m => m && m.id)
    .map(m => ({ id: String(m.id), name: String(m.name || m.id) }));
  tropeModelListCache[provider] = models;
  return models;
}

/* {provider, model} — either may be '' meaning "server default". */
async function tropeProviderGet() {
  if (tropeProviderCache) return tropeProviderCache;
  let row = null;
  try {
    const sb = await cloudClient().catch(() => null);
    if (sb) {
      const res = await sb.from('trope_provider_settings')
        .select('provider, model').eq('id', 1).maybeSingle();
      if (res && res.data) row = res.data;
    }
  } catch (e) {}
  if (!row) {
    try { row = JSON.parse(localStorage.getItem(TROPE_PROVIDER_SETTINGS_KEY) || 'null'); }
    catch (e) { row = null; }
  }
  tropeProviderCache = {
    provider: String((row && row.provider) || '').trim().toLowerCase(),
    model: String((row && row.model) || '').trim(),
  };
  try { localStorage.setItem(TROPE_PROVIDER_SETTINGS_KEY, JSON.stringify(tropeProviderCache)); }
  catch (e) {}
  return tropeProviderCache;
}

/* Admin-only (RLS enforces). Clears the override when both are empty. */
async function tropeProviderSet(provider, model) {
  provider = String(provider || '').trim().toLowerCase();
  model = String(model || '').trim();
  const sb = await cloudClient().catch(() => null);
  if (!sb) throw new Error('not signed in');
  const { error } = await sb.from('trope_provider_settings').upsert(
    { id: 1, provider, model, updated_at: new Date().toISOString() },
    { onConflict: 'id' });
  if (error) throw error;
  tropeProviderCache = { provider, model };
  try { localStorage.setItem(TROPE_PROVIDER_SETTINGS_KEY, JSON.stringify(tropeProviderCache)); }
  catch (e) {}
  return tropeProviderCache;
}

const TropeQueue = {
  _state: null,
  _pumping: false,
  _resolveBook: null, // id -> book (set by the app)
  _upsertRows: null,  // async (rows) -> void (set by the app)
  _upsertClaims: null, // v206: async (workId, tropes, meta) -> void (set by the app)
  _getClaimHashes: null, // v208: async (workId) -> [input_hash] (set by the app)
  _onEvent: null,     // (state) -> void, UI refresh hook

  _blank() {
    return { jobs: [], failed: {}, running: false, paused: false,
             done: 0, total: 0, fatalError: '', startedAt: 0 };
  },

  _load() {
    try {
      const raw = localStorage.getItem(TROPE_QUEUE_STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.jobs)) { this._state = Object.assign(this._blank(), s); return; }
      }
    } catch (e) {}
    this._state = this._blank();
  },

  _save() {
    try { localStorage.setItem(TROPE_QUEUE_STORE_KEY, JSON.stringify(this._state)); }
    catch (e) {}
  },

  _emit() {
    try { if (this._onEvent) this._onEvent(this.snapshot()); } catch (e) {}
  },

  configure({ resolveBook, upsertRows, upsertClaims, getClaimHashes, onEvent } = {}) {
    if (!this._state) this._load();
    if (resolveBook) this._resolveBook = resolveBook;
    if (upsertRows) this._upsertRows = upsertRows;
    if (upsertClaims) this._upsertClaims = upsertClaims;
    if (getClaimHashes) this._getClaimHashes = getClaimHashes;
    if (onEvent) this._onEvent = onEvent;
  },

  snapshot() {
    if (!this._state) this._load();
    const s = this._state;
    return { pending: s.jobs.length, failed: Object.keys(s.failed).length,
             running: s.running, paused: s.paused, done: s.done, total: s.total,
             fatalError: s.fatalError, failedDetail: Object.assign({}, s.failed) };
  },

  /* ids: local library book ids. opts.force bypasses the v208 input-hash
     reprocess cache (used by explicit "re-infer" actions). Returns number
     enqueued. */
  enqueue(ids, opts) {
    if (!this._state) this._load();
    const force = !!(opts && opts.force);
    const have = new Set(this._state.jobs.map(j => j.id));
    let n = 0;
    (ids || []).forEach(id => {
      if (id && !have.has(id)) {
        this._state.jobs.push({ id, force }); have.add(id); n++;
      }
    });
    this._state.total += n;
    this._state.fatalError = '';
    this._save(); this._emit();
    return n;
  },

  clearFailed() {
    if (!this._state) this._load();
    const ids = Object.keys(this._state.failed);
    this._state.failed = {};
    this._save(); this._emit();
    return ids;
  },

  reset() {
    this._state = this._blank();
    try { tropeAdminBooksClear(); } catch (e) {}
    this._save(); this._emit();
  },

  start() {
    if (!this._state) this._load();
    if (!this._state.jobs.length || this._pumping) return false;
    this._state.running = true;
    this._state.paused = false;
    this._state.fatalError = '';
    if (!this._state.startedAt) this._state.startedAt = Date.now();
    this._save();
    this._pump();
    return true;
  },

  pause() {
    if (!this._state) this._load();
    this._state.paused = true;
    this._state.running = false;
    this._save(); this._emit();
  },

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this._state.running && !this._state.paused && this._state.jobs.length) {
        const job = this._state.jobs[0];
        let book = null;
        try { book = this._resolveBook ? this._resolveBook(job.id) : null; } catch (e) { book = null; }
        if (!book) {
          this._state.jobs.shift(); // book deleted since enqueue; drop silently
        } else {
          const key = bookKeyFor(book);
          try {
            /* v208: resolve the work first — the input-hash reprocess
               cache (§26) skips the API call when this exact input was
               already classified under the current taxonomy and model.
               Forced jobs (explicit re-infer) always run. */
            let workId = null;
            try { workId = (typeof resolveWork === 'function') ? await resolveWork(book) : null; }
            catch (e) { workId = null; }
            let skipInference = false;
            if (!job.force && workId && this._getClaimHashes) {
              try {
                /* v208: getClaimHashes -> [{input_hash, model}]. Skip when
                   this exact input was classified under the current
                   taxonomy; with a client model override the model must
                   match too, otherwise the server default is assumed. */
                const seen = await this._getClaimHashes(workId) || [];
                const ov = await tropeProviderGet().catch(() => null);
                const ovModel = (ov && ov.model) || '';
                const want = tropeInputHash(book);
                skipInference = seen.some(r => r && r.input_hash === want &&
                  (!ovModel || r.model === ovModel));
              } catch (e) { skipInference = false; }
            }
            if (skipInference) {
              this._state.done++;
              delete this._state.failed[key];
            } else {
            const res = await inferBookTropes(book);
            /* v206: claims write path — the work is the identity now.
               Resolve it, then record the AI's tropes as candidate claims
               (the writer filters out rejected/confirmed tropes, so
               re-inference can never resurrect a rejection or demote a
               confirmation). The legacy book_tropes write stays as the
               fallback for books whose work can't be resolved.
               v208: high-confidence claims with quoted evidence
               auto-publish (status confirmed, source ai); the writer
               decides per trope. */
            if (workId && this._upsertClaims) {
              await this._upsertClaims(workId,
                res.tropes.map(t => ({ trope_id: t.id, confidence: t.confidence,
                                       evidence: t.evidence || [] })),
                { model: res.model || null,
                  inputHash: tropeInputHash(book) });
              try { TropeStore.invalidate('w:' + workId); } catch (e) {}
            } else {
              const rows = res.tropes.map(t => ({
                book_key: key, trope_id: t.id, source: 'llm',
                confidence: t.confidence, model: res.model || null,
                taxonomy_version: TROPE_TAXONOMY_VERSION,
                taxonomy_rev: TropeTaxonomy.rev(),
                updated_at: new Date().toISOString(),
              }));
              // Empty inference is a legitimate result — but per the plan we
              // never cache "no tropes", so zero rows = nothing to upsert.
              if (rows.length && this._upsertRows) await this._upsertRows(rows);
            }
            this._state.done++;
            delete this._state.failed[key];
            } // end v208 skipInference else
          } catch (e) {
            if (e && e.fatal) {
              this._state.running = false;
              this._state.fatalError = e.message;
              break;
            }
            this._state.failed[key] = (e && e.message) || 'inference failed';
          }
          this._state.jobs.shift();
        }
        this._save(); this._emit();
        if (this._state.jobs.length && this._state.running && !this._state.paused) {
          await sleepMs(this._delayMs != null ? this._delayMs : TROPE_QUEUE_DELAY_MS);
        }
      }
    } finally {
      this._pumping = false;
    }
    if (!this._state.jobs.length) this._state.running = false;
    this._save(); this._emit();
  },
};

/* ---------------- Read-path store (v153) ----------------
   Best-available tropes for a book: memory cache → Supabase
   book_tropes (ordered by confidence) → heuristic tropesAuto meanwhile.
   A cache miss with no DB rows enqueues a background inference (online
   + provider configured) so the next view has real data. Never touches
   the books table or sync logic — purely additive metadata. */

const TROPE_CACHE_TTL_MS = 10 * 60 * 1000;

/* ---------------- Claim resolution (v205) ----------------
   Pure: reduce a work's book_trope_claims rows to the display list.
   The client resolution rule: when candidate and rejected claims coexist
   for the same Work/trope, REJECTED WINS — the trope is hidden, never
   resurrected by a stale candidate. Otherwise confirmed beats candidate
   (a community/admin confirmation outranks the AI's guess); among equal
   statuses the highest confidence wins. Unknown statuses (e.g. disputed)
   stay hidden until reviewed. Unknown trope ids are dropped. */
function resolveClaims(claims) {
  const byTrope = {};
  for (const c of claims || []) {
    if (!c || !c.trope_id) continue;
    (byTrope[c.trope_id] = byTrope[c.trope_id] || []).push(c);
  }
  const out = [];
  for (const tid of Object.keys(byTrope)) {
    const group = byTrope[tid];
    if (group.some(c => c.status === 'rejected')) continue; // rejected wins
    const confirmed = group.filter(c => c.status === 'confirmed');
    const pool = (confirmed.length ? confirmed
      : group.filter(c => c.status === 'candidate'));
    if (!pool.length) continue;
    pool.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
    const best = pool[0];
    const trope = (typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy)
      ? TropeTaxonomy.byId(tid) : (typeof tropeById === 'function' ? tropeById(tid) : null);
    if (!trope) continue;
    const conf = Number(best.confidence);
    out.push({
      id: trope.id, name: trope.name,
      confidence: isFinite(conf) ? conf : 0.5,
      source: best.source_type === 'community' ? 'community' : 'ai',
      status: best.status,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

const TropeStore = {
  _cache: {},      // book_key -> { tropes, at }
  _readRows: null, // async (bookKey) -> rows (injected)
  _readClaims: null, // v205: async (workId) -> claim rows (injected)

  configure({ readRows, readClaims } = {}) {
    if (readRows) this._readRows = readRows;
    if (readClaims) this._readClaims = readClaims;
  },

  invalidate(bookKey) {
    if (bookKey) delete this._cache[bookKey];
    else this._cache = {};
  },

  async getBookTropes(book) {
    book = book || {};
    ensureTropeQueueWired();
    const key = bookKeyFor(book);
    /* v205: Work-keyed claims first. Every edition of the same book shares
       one trope set; the resolution rule (rejected wins) is applied by
       resolveClaims. A work with no claims falls through to the legacy
       book_tropes read so nothing disappears mid-migration. */
    let workId = null;
    try {
      workId = (typeof resolveWork === 'function') ? await resolveWork(book) : null;
    } catch (e) { workId = null; }
    if (workId && this._readClaims) {
      const ck = 'w:' + workId;
      const hit = this._cache[ck];
      if (hit && Date.now() - hit.at < TROPE_CACHE_TTL_MS) {
        return { tropes: hit.tropes, origin: 'db' };
      }
      let claims = null;
      try { claims = await this._readClaims(workId); } catch (e) { claims = null; }
      if (claims && claims.length) {
        const tropes = resolveClaims(claims);
        this._cache[ck] = { tropes, at: Date.now() };
        return { tropes, origin: 'db' };
      }
      // No claims for this work (yet) — fall through to the legacy read.
    }
    const hit = this._cache[key];
    if (hit && Date.now() - hit.at < TROPE_CACHE_TTL_MS) {
      return { tropes: hit.tropes, origin: 'db' };
    }
    let rows = null;
    try { rows = this._readRows ? await this._readRows(key) : null; }
    catch (e) { rows = null; }
    if (rows && rows.length) {
      const tropes = rows
        .map(r => ({ trope: TropeTaxonomy.byId(r.trope_id), confidence: r.confidence, source: r.source }))
        .filter(x => x.trope)
        .sort((a, b) => b.confidence - a.confidence)
        .map(x => ({ id: x.trope.id, name: x.trope.name,
                     confidence: x.confidence, source: x.source }));
      this._cache[key] = { tropes, at: Date.now() };
      return { tropes, origin: 'db' };
    }
    // No DB data yet: kick off a background inference (nonblocking) and
    // return the heuristic suggestions meanwhile. Offline or unconfigured:
    // heuristics only, zero behavior change.
    try {
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (tropeInferenceConfigured() && online && book.id) {
        TropeQueue.enqueue([book.id]);
        TropeQueue.start();
      }
    } catch (e) {}
    const heur = (book.tropesAuto || [])
      .map(name => ({ id: null, name: String(name), confidence: 0, source: 'heuristic' }));
    return { tropes: heur, origin: 'heuristics' };
  },
};

/* Wire the queue + store for app-wide use (modal read-path and Trope Lab
   both call this; Trope Lab then adds its own onEvent). Idempotent. */
let tropeQueueWiredForApp = false;

function ensureTropeQueueWired() {
  /* v157: actually honor the idempotency this function always claimed —
     without it, the taxonomy refresh below would fire on every book read. */
  if (tropeQueueWiredForApp) return;
  const resolveBook = id => {
    try {
      const lib = (typeof library !== 'undefined' ? library : []);
      const local = lib.find(b => b.id === id);
      if (local) return local;
    } catch (e) {}
    /* v159: all-libraries backfill jobs are keyed by book_key — resolve
       them from the persisted admin projection. */
    try { return tropeAdminBookById(id); } catch (e) { return null; }
  };
  const upsertRows = async rows => {
    const sb = await cloudClient().catch(() => null);
    if (!sb) throw new Error('cloud unavailable');
    const { error } = await sb.from('book_tropes')
      .upsert(rows, { onConflict: 'book_key,trope_id' });
    if (error) throw error;
  };
  /* v206: claims writer with rejection persistence. Re-inference replaces
     this work's AI candidates wholesale (delete-then-insert), but:
     - a REJECTED trope is never re-inserted (rejections survive
       re-inference — the read path's rejected-wins rule is the backstop);
     - a human/COMMUNITY CONFIRMED trope is never demoted back to candidate.
     Only regenerable AI rows are deleted — candidates plus AI
     auto-confirmed rows (isRegenerableClaim). Human confirmations,
     rejections, and community rows are never touched (RLS wouldn't allow
     it anyway).
     v208: evidence-backed auto-publishing — high-confidence tropes with
     quoted evidence are written as confirmed (source ai,
     evidence.auto_confirmed=true) instead of candidates; the Trope Lab
     queue becomes corrections-only. */
  const upsertClaims = async (workId, tropes, meta) => {
    const sb = await cloudClient().catch(() => null);
    if (!sb) throw new Error('cloud unavailable');
    let existing = [];
    try {
      const r = await sb.from('book_trope_claims')
        .select('id, trope_id, status, source_type, evidence').eq('work_id', workId);
      if (r.error) throw r.error;
      existing = r.data || [];
    } catch (e) { existing = []; }
    const rejected = new Set(), confirmed = new Set(), regenIds = [];
    for (const c of existing) {
      if (!c || !c.trope_id) continue;
      if (c.status === 'rejected') rejected.add(c.trope_id);
      else if (c.status === 'confirmed' && !isRegenerableClaim(c)) confirmed.add(c.trope_id);
      if (isRegenerableClaim(c) && c.id) regenIds.push(c.id);
    }
    const fresh = (tropes || []).filter(t => t && t.trope_id &&
      !rejected.has(t.trope_id) && !confirmed.has(t.trope_id));
    if (regenIds.length) {
      const del = await sb.from('book_trope_claims').delete().in('id', regenIds);
      if (del.error) throw del.error;
    }
    if (!fresh.length) return;
    const rows = fresh.map(t => {
      const auto = tropeAutoPublish({ confidence: t.confidence,
                                      evidence: t.evidence || [] });
      return {
        work_id: workId, trope_id: t.trope_id,
        status: auto ? 'confirmed' : 'candidate',
        confidence: t.confidence, source_type: 'ai',
        model: (meta && meta.model) || null, model_version: null,
        evidence: { taxonomy_version: TROPE_TAXONOMY_VERSION,
                    taxonomy_rev: TropeTaxonomy.rev(),
                    evidence: t.evidence || [],
                    input_hash: (meta && meta.inputHash) || null,
                    auto_confirmed: auto || undefined },
      };
    });
    const ins = await sb.from('book_trope_claims').insert(rows);
    if (ins.error) throw ins.error;
  };
  /* v208: input hashes + models of existing claims for one work, for the
     queue's reprocess cache. Never throws. */
  const getClaimHashes = async workId => {
    const sb = await cloudClient().catch(() => null);
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_trope_claims')
        .select('evidence, model').eq('work_id', workId).limit(200);
      if (error || !data) return [];
      const out = [];
      for (const r of data) {
        const h = r && r.evidence && r.evidence.input_hash;
        if (typeof h === 'string' && h) out.push({ input_hash: h, model: r.model || '' });
      }
      return out;
    } catch (e) { return []; }
  };
  const readRows = async bookKey => {
    const sb = await cloudClient().catch(() => null);
    if (!sb) return null;
    const { data, error } = await sb.from('book_tropes')
      .select('trope_id, confidence, source')
      .eq('book_key', bookKey)
      .order('confidence', { ascending: false });
    if (error) throw error;
    return data || [];
  };
  /* v205: work-keyed claim read for the new resolution path. */
  const readClaims = async workId => {
    const sb = await cloudClient().catch(() => null);
    if (!sb) return null;
    const { data, error } = await sb.from('book_trope_claims')
      .select('trope_id, status, confidence, source_type')
      .eq('work_id', workId)
      .order('confidence', { ascending: false });
    if (error) throw error;
    return data || [];
  };
  TropeQueue.configure({ resolveBook, upsertRows, upsertClaims, getClaimHashes });
  TropeStore.configure({ readRows, readClaims });
  TropeVotes.configure({ getClient: async () => cloudClient().catch(() => null) });
  TropeProposals.configure({ getClient: async () => cloudClient().catch(() => null) });
  /* v157: pull the live taxonomy in the background; the last-known copy is
     cached for offline. Never blocks boot. */
  try { TropeTaxonomy.refresh().catch(() => {}); } catch (e) {}
  tropeQueueWiredForApp = true;
}
/* v153: trope-intelligence chips. Pure HTML builder (unit-tested). DB tropes
   get a subtle ✦ source indicator + confidence tooltip; heuristics render
   as plain chips. v154: signed-in users get ▲▼ vote buttons on DB chips;
   `votes` is { tropeId: { up, down, mine } }. `esc` comes from
   js/050-helpers.js at runtime. */
function dbTropeChipsHTML(tropes, origin, votes) {
  if (!tropes || !tropes.length) {
    return '<p class="note">No trope data yet.</p>';
  }
  const ai = origin === 'db';
  votes = votes || {};
  const votable = ai && typeof TropeVotes !== 'undefined' && TropeVotes.canVote();
  return tropes.map(t => {
    const v = votes[t.id] || { up: 0, down: 0, mine: 0 };
    const net = v.up - v.down;
    let title = '';
    if (ai) {
      title = 'AI-inferred · ' + Math.round(tropeDisplayConfidence(t.confidence, v) * 100) + '% confidence';
      if (net !== 0) title += ' · community ' + (net > 0 ? '+' : '') + net;
    }
    let h = '<span class="chip dbtrope' + (ai ? ' ai' : '') + '"' +
      (title ? ' title="' + title + '"' : '') + '>' +
      (ai ? '✦ ' : '') + esc(t.name) + '</span>';
    if (votable && t.id) {
      h = '<span class="tgvote">' + h +
        '<button class="tvbtn' + (v.mine === 1 ? ' on' : '') + '" data-tv="1" data-tid="' + esc(t.id) + '"' +
        ' aria-label="This trope fits">▲</button>' +
        '<button class="tvbtn' + (v.mine === -1 ? ' on' : '') + '" data-tv="-1" data-tid="' + esc(t.id) + '"' +
        ' aria-label="This trope does not fit">▼</button>' +
        (net ? '<span class="tvnet">' + (net > 0 ? '+' : '') + net + '</span>' : '') +
        '</span>';
    }
    return h;
  }).join('') +
    (ai ? '<p class="note">✦ inferred from the book\u2019s description' +
      (votable ? ' — tap ▲▼ to agree or disagree' : '') + '</p>' : '');
}

/* ---------------- Community voting (v154) ----------------
   One vote (+1/-1) per user per (book, trope), stored in the trope_votes
   table (RLS: anyone signed in can read; users can only write their own
   rows). Votes never rewrite the stored LLM confidence — they only nudge
   what's displayed, bounded so a pile-on can't flip a result. */

/* Display-time confidence: base LLM confidence nudged ±0.04 per net vote,
   clamped to [0.05, 0.99]. Safe because the stored value is untouched and
   the nudge saturates — ten extra downvotes can't push a 0.9 below 0.5. */
function tropeDisplayConfidence(base, votes) {
  const b = typeof base === 'number' && isFinite(base) ? base : 0.5;
  const net = ((votes && votes.up) || 0) - ((votes && votes.down) || 0);
  return Math.min(0.99, Math.max(0.05, b + 0.04 * net));
}

const TropeVotes = {
  _getClient: null, // async () -> supabase client (injected)
  _cache: {},       // book_key -> { tropeId: { up, down, mine } }

  configure({ getClient } = {}) {
    if (getClient) this._getClient = getClient;
  },

  _uid() {
    try { return (typeof localUid !== 'undefined' && localUid) || null; }
    catch (e) { return null; }
  },

  canVote() { return !!this._uid(); },

  invalidate(bookKey) {
    if (bookKey) delete this._cache[bookKey];
    else this._cache = {};
  },

  /* Aggregate votes for a book: { tropeId: { up, down, mine } }. `mine` is
     the current user's vote (1, -1, or 0). Signed-out users get counts with
     mine always 0 — reading is allowed, writing isn't. */
  async getVotes(bookKey) {
    const hit = this._cache[bookKey];
    if (hit) return hit;
    const agg = {};
    try {
      const sb = this._getClient ? await this._getClient() : null;
      if (!sb) { this._cache[bookKey] = agg; return agg; }
      const { data, error } = await sb.from('trope_votes')
        .select('trope_id, vote, user_id').eq('book_key', bookKey);
      if (error) throw error;
      const uid = this._uid();
      for (const r of data || []) {
        const e = agg[r.trope_id] || (agg[r.trope_id] = { up: 0, down: 0, mine: 0 });
        if (r.vote === 1) e.up++;
        else if (r.vote === -1) e.down++;
        if (uid && r.user_id === uid) e.mine = r.vote;
      }
    } catch (e) {}
    this._cache[bookKey] = agg;
    return agg;
  },

  /* Set the final vote state: 1 (fits), -1 (doesn't fit), 0/null (retract).
     Returns the fresh aggregate entry for the trope. */
  async vote(bookKey, tropeId, vote) {
    const sb = this._getClient ? await this._getClient() : null;
    const uid = this._uid();
    if (!sb || !uid) throw new Error('sign in to vote on tropes');
    if (vote === 1 || vote === -1) {
      const { error } = await sb.from('trope_votes').upsert(
        { book_key: bookKey, trope_id: tropeId, user_id: uid, vote },
        { onConflict: 'book_key,trope_id,user_id' });
      if (error) throw error;
    } else {
      const { error } = await sb.from('trope_votes').delete()
        .eq('book_key', bookKey).eq('trope_id', tropeId).eq('user_id', uid);
      if (error) throw error;
    }
    this.invalidate(bookKey);
    const agg = await this.getVotes(bookKey);
    return agg[tropeId] || { up: 0, down: 0, mine: 0 };
  },

  /* Tap-again-to-retract toggle used by the chip buttons. */
  async toggleVote(bookKey, tropeId, want) {
    const agg = await this.getVotes(bookKey);
    const cur = (agg[tropeId] || { mine: 0 }).mine;
    return this.vote(bookKey, tropeId, cur === want ? 0 : want);
  },
};

/* ---------------- Claim moderation (v206) ----------------
   Admin-only curation of book_trope_claims. Confirming a candidate makes
   it outrank future AI guesses (the resolution rule prefers confirmed);
   rejecting hides the trope work-wide AND makes the rejection persistent
   — the claims writer filters rejected tropes, so re-inference can never
   resurrect them. RLS enforces the admin-only part; these helpers just
   shape the calls. */

const TropeClaims = {
  _sb() {
    return cloudClient().catch(() => null);
  },

  /* Works with AI claims awaiting review, grouped with taxonomy names
     resolved. Returns
     [{ workId, title, authors, tropes: [{id, name, confidence, auto}] }].
     v208: includes AI auto-published claims (auto=true) alongside
     candidates — the queue is corrections-only now, and a wrong
     auto-published tag is exactly what needs a human ✕. Never throws —
     returns [] when signed out or on error. */
  async listCandidates(limit) {
    let sb = null;
    try { sb = await this._sb(); } catch (e) { sb = null; }
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('book_trope_claims')
        .select('work_id, trope_id, confidence, source_type, status, evidence, works(title, authors)')
        .eq('source_type', 'ai')
        .in('status', ['candidate', 'confirmed'])
        .order('updated_at', { ascending: false })
        .limit(limit || 500);
      if (error) throw error;
      const byWork = {};
      for (const r of data || []) {
        if (r.status === 'confirmed' &&
            !(r.evidence && r.evidence.auto_confirmed === true)) continue;
        const t = (typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy)
          ? TropeTaxonomy.byId(r.trope_id) : null;
        if (!t) continue;
        const e = byWork[r.work_id] || (byWork[r.work_id] = {
          workId: r.work_id,
          title: (r.works && r.works.title) || r.work_id,
          authors: ((r.works && r.works.authors) || []).join(', '),
          tropes: [],
        });
        if (e.tropes.some(x => x.id === t.id)) continue;
        const conf = Number(r.confidence);
        e.tropes.push({ id: t.id, name: t.name,
          confidence: isFinite(conf) ? conf : 0.5,
          auto: r.status === 'confirmed' });
      }
      return Object.keys(byWork).map(k => {
        const e = byWork[k];
        e.tropes.sort((a, b) => b.confidence - a.confidence);
        return e;
      });
    } catch (e) { return []; }
  },

  /* Confirm or reject an AI claim. Candidates move either way; AI
     auto-published claims (evidence.auto_confirmed) can be rejected —
     that is the corrections workflow. Human/community confirmations are
     never touched here. Throws on error (RLS denial included) so the UI
     can report it. */
  async setStatus(workId, tropeId, status) {
    if (status !== 'confirmed' && status !== 'rejected')
      throw new Error('status must be confirmed or rejected');
    const sb = await this._sb();
    if (!sb) throw new Error('cloud unavailable');
    const cur = await sb.from('book_trope_claims')
      .select('status, source_type, evidence')
      .eq('work_id', workId).eq('trope_id', tropeId).limit(1);
    if (cur.error) throw cur.error;
    const row = (cur.data || [])[0];
    if (!row || row.source_type !== 'ai')
      throw new Error('only AI claims can be moderated here');
    const auto = row.status === 'confirmed' &&
      !!(row.evidence && row.evidence.auto_confirmed === true);
    if (row.status !== 'candidate' && !(auto && status === 'rejected'))
      throw new Error('claim is not reviewable');
    const { error } = await sb.from('book_trope_claims').update({ status })
      .eq('work_id', workId).eq('trope_id', tropeId);
    if (error) throw error;
    try { TropeStore.invalidate('w:' + workId); } catch (e) {}
  },
};

/* ---------------- User-proposed tropes (v155) ----------------
   Anyone signed in can propose a trope (name, one-line definition, genres,
   optional originating book). Proposals are deduplicated client-side at
   submit, voted on by the coven (normalized per-user rows in
   trope_proposal_votes — counts are always derived), and reviewed by an
   admin in Trope Lab: approve / reject / mark duplicate.
   v157: approval writes the canonical row to the shared `tropes` table and
   bumps `taxonomy_meta.rev` — the live taxonomy layer picks it up
   immediately, so the new trope is inferable with one tap. No file edit,
   no snippet, no redeploy. */

function tropeGenreLabel(g) {
  return String(g).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const TropeProposals = {
  _getClient: null, // async () -> supabase client (injected)

  configure({ getClient } = {}) {
    if (getClient) this._getClient = getClient;
  },

  _uid() {
    try { return (typeof localUid !== 'undefined' && localUid) || null; }
    catch (e) { return null; }
  },

  canPropose() { return !!this._uid(); },

  /* Client-side duplicate check at submit time, against the LIVE merged
     taxonomy (so a recently approved trope is caught too). Returns
     { kind: 'exact'|'similar', trope } or null. */
  checkDuplicate(name) {
    const key = tropeNameKey(name);
    if (!key) return null;
    const pool = TropeTaxonomy.list();
    const exact = pool.find(t => tropeNameKey(t.name) === key);
    if (exact) return { kind: 'exact', trope: exact };
    const sim = findSimilarTrope(name, pool);
    return sim && sim.score >= 0.5
      ? { kind: 'similar', trope: sim.trope, score: sim.score }
      : null;
  },

  async submit({ name, description, genres, bookKey }) {
    const sb = this._getClient ? await this._getClient() : null;
    const uid = this._uid();
    if (!sb || !uid) throw new Error('Sign in to propose a trope.');
    name = String(name || '').trim().replace(/\s+/g, ' ');
    description = String(description || '').trim().replace(/\s+/g, ' ');
    genres = (genres || []).filter(g => TROPE_GENRES.includes(g));
    if (name.length < 3 || name.length > 60)
      throw new Error('Name must be 3–60 characters.');
    if (description.length < 10 || description.length > 160)
      throw new Error('Definition must be 10–160 characters (one line).');
    if (!genres.length) throw new Error('Pick at least one genre.');
    const dup = this.checkDuplicate(name);
    if (dup && dup.kind === 'exact')
      throw new Error('“' + dup.trope.name + '” already exists in the taxonomy.');
    const { data, error } = await sb.from('trope_proposals').insert({
      name, name_key: tropeNameKey(name), description, genres,
      book_key: bookKey || null, proposed_by: uid, status: 'pending',
    }).select('id').single();
    if (error) throw error;
    return data.id;
  },

  /* Pending proposals with derived vote counts + my vote, best first. */
  async listPending() {
    const sb = this._getClient ? await this._getClient() : null;
    if (!sb) return [];
    const { data: props, error } = await sb.from('trope_proposals')
      .select('id, name, description, genres, book_key, proposed_by, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!props || !props.length) return [];
    const { data: votes, error: verr } = await sb.from('trope_proposal_votes')
      .select('proposal_id, vote, user_id')
      .in('proposal_id', props.map(p => p.id));
    if (verr) throw verr;
    const uid = this._uid();
    const byId = {};
    for (const v of votes || []) {
      const e = byId[v.proposal_id] || (byId[v.proposal_id] = { up: 0, down: 0, mine: 0 });
      if (v.vote === 1) e.up++;
      else if (v.vote === -1) e.down++;
      if (uid && v.user_id === uid) e.mine = v.vote;
    }
    return props
      .map(p => ({ ...p,
        votes: byId[p.id] || { up: 0, down: 0, mine: 0 },
        mine: !!uid && p.proposed_by === uid }))
      .sort((a, b) => (b.votes.up - b.votes.down) - (a.votes.up - a.votes.down));
  },

  /* Tap-again-to-retract toggle. Returns the new final state (1/-1/0). */
  async toggleVote(proposalId, want) {
    const sb = this._getClient ? await this._getClient() : null;
    const uid = this._uid();
    if (!sb || !uid) throw new Error('Sign in to vote.');
    let cur = 0;
    try {
      const { data } = await sb.from('trope_proposal_votes')
        .select('vote').eq('proposal_id', proposalId).eq('user_id', uid)
        .maybeSingle();
      cur = data ? data.vote : 0;
    } catch (e) {}
    const next = cur === want ? 0 : want;
    if (next === 1 || next === -1) {
      const { error } = await sb.from('trope_proposal_votes').upsert(
        { proposal_id: proposalId, user_id: uid, vote: next },
        { onConflict: 'proposal_id,user_id' });
      if (error) throw error;
    } else if (cur !== 0) {
      const { error } = await sb.from('trope_proposal_votes').delete()
        .eq('proposal_id', proposalId).eq('user_id', uid);
      if (error) throw error;
    }
    return next;
  },

  /* ---- admin review (Trope Lab) ---- */

  /* Collision-safe canonical slug: base from the name, suffixed while
     taken in the live merged taxonomy. Refreshes first so a just-approved
     trope on another device can't collide. */
  async slugFor(name) {
    try { await TropeTaxonomy.refresh(); } catch (e) {}
    const taken = new Set(TropeTaxonomy.list().map(t => t.id));
    return tropeSlugFor(name, taken);
  },

  /* Approve: canonical row in the shared taxonomy table, taxonomy rev
     bumped, proposal marked approved, originating book auto-tagged
     (source 'community'). The new trope is live for inference immediately
     — one tap, no file edit. Returns { slug, proposal, rev }. */
  async approve(id, { tagBook = true } = {}) {
    const sb = this._getClient ? await this._getClient() : null;
    if (!sb) throw new Error('Cloud unavailable.');
    const { data: p, error: perr } = await sb.from('trope_proposals')
      .select('id, name, description, genres, book_key')
      .eq('id', id).single();
    if (perr || !p) throw perr || new Error('Proposal not found.');
    const slug = await this.slugFor(p.name);
    const { error: terr } = await sb.from('tropes').upsert({
      id: slug, name: p.name, description: p.description,
      genres: p.genres, version: TROPE_TAXONOMY_VERSION,
    }, { onConflict: 'id' });
    if (terr) throw terr;
    /* Bump the taxonomy rev so every device marks its tagged books stale
       and the next backfill can pick up the new trope. */
    let rev = TropeTaxonomy.rev();
    try {
      const { data: meta } = await sb.from('taxonomy_meta')
        .select('rev').eq('id', 1).maybeSingle();
      rev = (meta && meta.rev > 0 ? meta.rev : rev) + 1;
      const { error: rerr } = await sb.from('taxonomy_meta')
        .update({ rev, updated_at: new Date().toISOString() }).eq('id', 1);
      if (rerr) throw rerr;
    } catch (e) {
      throw new Error('The trope was saved, but the taxonomy rev could not be bumped (' +
        ((e && e.message) || e) + '). Re-run supabase/tropes.sql, then approve again.');
    }
    const { error: serr } = await sb.from('trope_proposals')
      .update({ status: 'approved' }).eq('id', id);
    if (serr) throw serr;
    if (tagBook && p.book_key) {
      const { error: berr } = await sb.from('book_tropes').upsert({
        book_key: p.book_key, trope_id: slug, source: 'community',
        confidence: 0.85, taxonomy_version: TROPE_TAXONOMY_VERSION,
        taxonomy_rev: rev,
      }, { onConflict: 'book_key,trope_id' });
      if (berr) throw berr;
      TropeStore.invalidate(p.book_key);
    }
    /* Live instantly on this device too — no refresh round-trip needed. */
    TropeTaxonomy.noteApproved(
      { id: slug, name: p.name, description: p.description, genres: p.genres }, rev);
    return { slug, proposal: p, rev };
  },

  async reject(id) {
    const sb = this._getClient ? await this._getClient() : null;
    if (!sb) throw new Error('Cloud unavailable.');
    const { error } = await sb.from('trope_proposals')
      .update({ status: 'rejected' }).eq('id', id);
    if (error) throw error;
  },

  async markDuplicate(id, canonicalId) {
    const sb = this._getClient ? await this._getClient() : null;
    if (!sb) throw new Error('Cloud unavailable.');
    if (!TropeTaxonomy.byId(canonicalId)) throw new Error('Unknown canonical trope.');
    const { error } = await sb.from('trope_proposals')
      .update({ status: 'duplicate', duplicate_of: canonicalId }).eq('id', id);
    if (error) throw error;
  },
};


