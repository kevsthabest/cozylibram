# Trope Intelligence — Implementation Plan

**Goal:** a trope-first book intelligence layer for Cozy Libram: a curated
multi-genre taxonomy, per-book trope data seeded by LLM inference and
refined by community votes, powering discovery no generic catalog offers.

**Non-goals:** replacing Hardcover/Google Books/Open Library as metadata
sources; a public API; real-time inference on every book view.

**Core insight:** every candidate provider (OpenRouter, Gemini, Groq,
Ollama, any self-hosted endpoint) speaks the OpenAI chat-completions wire
format. One HTTP client with a swappable `baseUrl` + key + model covers
all of them — no per-provider SDKs, no lock-in.

---

## 0. Design decisions (locked before coding)

1. **Taxonomy lives in the repo** (`js/150-trope-taxonomy.js`), versioned
   (`TROPE_TAXONOMY_VERSION`). It's curated, changes rarely, ships with
   the app, works offline, and self-hosters get it for free. The
   `tropes` Supabase table mirrors it (seeded by SQL) so community
   proposals and votes have something to reference. The taxonomy is
   **community-extensible**: users can propose new tropes; proposals go
   through dedup + admin approval before becoming canonical (see §6).
   The LLM only ever tags with canonical ids — never with proposals.
2. **Book identity for the trope cache is a `book_key`, not a book id.**
   `book_key` = ISBN-13 when available, else
   `t:<normalized-title>:<normalized-author>` (lowercase, NFKD-folded,
   punctuation/whitespace stripped). Trope data is *global* (about the
   work), unlike library rows which are per-user. One inference per
   book, cached for everyone.
3. **Inference is best-effort and never blocks.** If the provider fails,
   is rate-limited, or is unconfigured, the app silently falls back to
   the existing heuristic `tropesAuto`. A failed inference is retried
   later — never cached as "no tropes."
4. **Every trope id from an LLM is validated against the taxonomy.**
   Unknown ids are dropped, not stored. This is the main defense against
   invented near-duplicate labels ("forced closeness").
5. **Writes are idempotent upserts** on `(book_key, trope_id)`.
   Re-running inference or backfill never duplicates rows.

---

## 1. Data model (Supabase)

```sql
create table tropes (
  id text primary key,              -- stable slug: 'enemies-to-lovers'
  name text not null,
  description text not null,
  genres text[] not null default '{}',
  version int not null default 1
);

create table book_tropes (
  book_key text not null,
  trope_id text not null references tropes(id) on delete cascade,
  source text not null default 'llm',   -- 'llm' | 'community'
  confidence real not null default 0.5,
  upvotes int not null default 0,
  downvotes int not null default 0,
  model text,                            -- model that produced the seed
  taxonomy_version int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (book_key, trope_id)
);
create index book_tropes_trope_idx on book_tropes (trope_id);

create table trope_votes (
  book_key text not null,
  trope_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  vote smallint not null check (vote in (1, -1)),
  primary key (book_key, trope_id, user_id)
);

-- User-proposed tropes. Live here until approved into `tropes`.
create table trope_proposals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null,            -- normalized for dedup: lowercase, alnum only
  description text not null,
  genres text[] not null default '{}',
  book_key text,                     -- the book it was proposed from (nullable)
  proposed_by uuid not null references auth.users on delete cascade,
  upvotes int not null default 0,
  downvotes int not null default 0,
  status text not null default 'pending',  -- 'pending' | 'approved' | 'rejected' | 'duplicate'
  duplicate_of text references tropes(id),
  created_at timestamptz not null default now(),
  unique (name_key)
);
```

RLS: authenticated users can read all three tables; can insert/update
their own `trope_votes` rows; `book_tropes` upserts allowed for
`source='llm'` seeds and vote-driven confidence updates (via a single
audited RPC or constrained policy); `tropes` taxonomy edits are
admin-only (reuse the `app_admins` pattern from analytics).

`supabase/tropes.sql` ships the tables + RLS + a seed `INSERT` generated
from the repo taxonomy file (one node script, run once per taxonomy
bump — taxonomy changes are rare and deliberate).

---

## 2. Taxonomy file (`js/150-trope-taxonomy.js`)

Shape:

```js
const TROPE_TAXONOMY_VERSION = 1;
const TROPE_GENRES = ['romance','dark-romance','fantasy','sci-fi',
  'mystery-thriller','horror','historical','contemporary','non-fiction'];
const TROPES = [
  { id:'enemies-to-lovers', name:'Enemies to Lovers',
    description:'...', genres:['romance','dark-romance','fantasy'] },
  ...
];
function tropesForGenres(genres) { /* filter + return */ }
function tropeById(id) { /* validate */ }
```

Seed content per the roadmap (romance, dark romance, fantasy, sci-fi,
mystery/thriller, horror starter sets; expand later). Keep v1 to
~60–90 tropes — enough to be useful, small enough to curate by hand.

---

## 3. Provider-agnostic inference client (`js/151-trope-inference.js`)

No DOM dependencies in the core (pure functions) so the same file can
drive a node backfill script later if wanted.

```js
const TROPE_PROVIDERS = {
  openrouter: { baseUrl:'https://openrouter.ai/api/v1' },
  gemini:     { baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai/' },
  groq:       { baseUrl:'https://api.groq.com/openai/v1' },
  ollama:     { baseUrl:'http://<home-pc>:11434/v1' },
  custom:     { baseUrl: null }  // user-supplied
};
// Settings: tropeProvider, tropeModel, tropeKey (via /config.js,
// same plumbing as the Hardcover token — never in the repo).
```

`inferBookTropes(book)`:
1. Build prompt: system = "You are a trope tagger…" + the
   **genre-filtered** taxonomy (only tropes whose `genres` intersect the
   book's genres — keeps prompts small and kills cross-genre noise);
   user = title + author + description. Request strict JSON:
   `{"tropes":[{"id":"...","confidence":0.0-1.0}]}`.
2. `POST {baseUrl}/chat/completions` with `response_format:{type:'json_object'}`
   where supported, `temperature:0`, `max_tokens` generous (≥1000 —
   reasoning models spend tokens on chain-of-thought before producing
   `content`; a small cap truncates them mid-thought and yields empty
   content, observed live with qwen/qwen3.8-27b:free).
   `AbortController` timeout (30s).
3. Parse defensively: strip markdown fences, `JSON.parse` in try/catch,
   accept `{tropes:[...]}` or bare arrays; on parse failure → retry once
   with "reply with JSON only", then give up (mark failed, don't cache).
4. **Validate**: drop any id not in taxonomy, clamp confidence to
   0–1, cap at 8 tropes per book (keep the signal tight).
5. Retry policy: 429/5xx → exponential backoff (1s, 4s, 16s), max 3
   attempts; honor `Retry-After` when present. Free-tier 429s are
   per-model (observed live: qwen and gemma throttled while nemotron
   served fine), so a 429 on one model is not a reason to stop the
   queue — back off that model and continue. 401/403 → stop and
   surface "check your key" once (don't hammer a bad key).

Paced background queue (`TropeQueue`):
- Processes one book at a time with a configurable delay between calls
  (default: 4s — stays under every free tier's RPM).
- Persists cursor + pending list in localStorage → backfill survives
  reloads, app kills, tab closes. Pause/resume.
- Concurrency: 1. Always. (Free tiers punish bursts; throughput comes
  from patience, not parallelism.)

---

## 4. Backfill tool (Observatory → Trope Lab, admin-only)

Trope Lab lives in the Libram Observatory (`/#admin`), not in Settings —
at least to start. It's an operator tool: provider/model/key status,
backfill runs, and taxonomy health are admin concerns, and keeping it
behind the admin gate avoids confusing testers with half-built plumbing.

- Counts: books with trope data / without / failed.
- Provider + model pickers, key status (configured/missing).
- **Backfill** button: queues every book missing trope data, shows
  progress bar, pause/resume, per-book failures listed by title for
  retry. Runs paced in the background; the app stays fully usable.
- "Re-infer with newer taxonomy" option for taxonomy bumps (only
  re-runs books whose `taxonomy_version` is older).

---

## 5. Read-path integration

- New `getBookTropes(book)`: local memory cache → Supabase
  `book_tropes` (ordered by confidence) → if empty and online and
  provider configured, enqueue background inference → return
  heuristic `tropesAuto` meanwhile. Offline or unconfigured: heuristics
  only, zero behavior change.
- Book modal trope chips render DB tropes when present (with a subtle
  source indicator), heuristics otherwise. Existing UI, new data.
- "More like this" (v110) keeps working unchanged in v1 — it reads the
  same trope fields; the DB just makes them better.

## 6. Community voting + trope proposals (Coven)

- Up/down vote buttons on trope chips in the book modal (signed-in
  Coven users). One vote per user per (book, trope); tapping again
  removes it.
- `confidence` recomputed: `clamp(llm_seed*0.4 + (up-down normalized)*0.6)`.
  Simple, explainable, hard to game at this scale.
- **Propose a trope** (from the book modal or Trope Lab): name +
  one-line description + genres it applies to. Immediately checked
  client-side against the canonical taxonomy with normalized fuzzy
  matching ("forced closeness" → "did you mean *forced proximity*?");
  near-duplicates are redirected to voting on the existing trope
  instead of creating a proposal.
- Proposals sit in `trope_proposals` as `pending`. Coven users can
  upvote/downvote proposals; high-signal ones bubble to the top of the
  **review queue in Trope Lab** (Observatory, admin-only).
- Admin approves → slug generated from the name (collision-safe:
  `forced-proximity-2`), row inserted into `tropes`, proposal marked
  `approved`. If it was proposed from a book, that book is auto-tagged
  (`source='community'`). Admin rejects → `rejected` (kept for audit);
  or marks `duplicate` linking the canonical trope.
- The repo taxonomy file is re-exported on approval (one click in Trope
  Lab regenerates the seed SQL / taxonomy JS bump) so the canonical
  list stays in sync for offline/self-hosted users.

---

## 7. Robustness rules (apply to every phase)

- Inference failures are silent to the user; surfaced only in Trope Lab.
- Never write a "no tropes found" tombstone — absence of data just
  means "not inferred yet."
- Never touch the `books` table or sync logic — trope data is purely
  additive metadata.
- Keys via `/config.js` only; provider choice + model in Settings;
  nothing in the repo, nothing in localStorage.
- Every network call has a timeout; every loop has a backoff; every
  queue is resumable.

---

## 8. Testing

- **Taxonomy validity suite:** unique ids, slug format, every trope has
  ≥1 valid genre, descriptions non-empty, version bumped when changed.
- **Prompt builder:** genre filtering (a sci-fi book never sees romance
  tropes in its prompt), token-size sanity.
- **Response parser:** markdown fences, bare arrays, bad JSON, unknown
  ids dropped, confidence clamped, >8 tropes truncated.
- **book_key normalization:** diacritics, punctuation, "The" prefixes,
  ISBN-13 preferred over title/author.
- **Mock provider:** fake `fetch` returning canned responses → full
  client flow (retry, backoff, 429 handling) with no network or key.
- **Queue:** pause/resume across "reload" (localStorage round-trip),
  failure marking, no duplicate inference for the same book.
- **Proposals:** `name_key` normalization ("Forced Proximity!" →
  `forcedproximity`), near-duplicate redirect to the canonical trope,
  approval → slug generation with collision handling + auto-tag of the
  source book.
- **Live smoke test** (manual, opt-in, never in CI): one real inference
  against the configured provider.

---

## 10. System prompt (v1 draft)

The taxonomy is injected genre-filtered at call time; the model never
sees tropes from unrelated genres.

```
You are a fiction metadata tagger for a book catalog. Read the book's
title, author, genres, and description, then tag it with tropes from the
fixed taxonomy below.

STRICT RULES
1. You may ONLY use trope ids from the TAXONOMY list. Never invent,
   rename, merge, or paraphrase ids. If none fit well, return fewer
   tropes — or an empty list.
2. Reply with JSON ONLY. No markdown fences, no commentary, no extra keys:
   {"tropes": [{"id": "trope-id", "confidence": 0.85}]}
3. Tag 1–8 tropes. Fewer is better than guessing.
4. confidence is 0.0–1.0: 0.9+ = stated outright in the description;
   0.7–0.89 = strongly implied; 0.5–0.69 = plausible from genre/title
   signals. Below 0.5, omit the trope.
5. Prefer the most specific fitting trope over a generic one
   (e.g. "mafia" beats "crime" for a mafia romance).
6. This is cataloging of published fiction. Tag dark, violent, or sexual
   themes factually where they apply; do not moralize, warn, or refuse.
7. If the description is missing or too thin to tag confidently, return
   {"tropes": []}.

TAXONOMY (id: name — what it means)
{taxonomy_lines}

BOOK
Title: {title}
Author: {author}
Genres: {genres}
Description: {description}
```

---

## 9. Version split (one feature per version)

- **v151 — Taxonomy + tables.** `js/150-trope-taxonomy.js`,
  `supabase/tropes.sql`, validity suite. No UI, no network.
- **v152 — Inference client + Trope Lab.** `js/151-trope-inference.js`,
  paced queue, backfill tool, mock-provider suite. Trope data lands in
  Supabase; nothing reads it yet.
- **v153 — Read-path integration.** Modal/library render DB tropes
  with heuristic fallback. The feature becomes visible.
- **v154 — Community voting.** Vote UI + `trope_votes` + confidence
  recompute.

Each version is shippable alone; each leaves the app working if the
next never happens.
