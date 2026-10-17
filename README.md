# Cozy Libram 📚

A mobile-first, installable web app (PWA) for tracking a book collection —
built for a prolific dark-romance reader, now the household's shared
library. The library lives on-device in IndexedDB (fully offline-capable);
sign-in syncs it to Supabase for cloud backup, multi-device sync, and
social shelves.

## Start Here

New to this repo — human or agent, arriving cold? Read in this order:

1. **[CONSTRAINTS.md](CONSTRAINTS.md)** — the quality bar. Read it before
   changing anything: the test baseline, the run discipline, and the rules
   that never bend silently.
2. **[GLOSSARY.md](GLOSSARY.md)** — the app's naming language: what the
   features and concepts are called, so the code's words mean what you
   think they mean.
3. **[docs/repo-legibility-spec.md](docs/repo-legibility-spec.md)** — the
   Repo Legibility Standard: the standard this repo is being brought up
   to, and the programme building it, layer by layer.
4. **[docs/es-modules-migration-plan.md](docs/es-modules-migration-plan.md)**
   — the ES-modules migration record; its appended gate notes are the
   decision history of the modular tree.
5. **[docs/runbook.md](docs/runbook.md)** — operations: how deploys,
   versions, diagnosis, database work, and incidents are handled. Read it
   when something is broken or about to be shipped.
6. **[js/README.md](js/README.md)** — module conventions and the per-file
   table for the client code under `js/`.

More routes join this block as each layer of the Legibility Standard
lands — it only ever points at documents that exist.

## What it does

**Add books, three taps or less**
- 📷 Barcode scan with the phone camera (native `BarcodeDetector`,
  vendored ZXing (zxing-wasm) fallback, manual ISBN as backup)
- 🔍 Title/author search across Google Books, Open Library, and Hardcover
- ⌨️ Bulk ISBN import — paste a stack, paced lookup, one-tap add
- 📥 Import hub: Goodreads CSV, StoryGraph CSV, Hardcover CSV, ISBN
  lists, Bookmory backups (parsed in-browser, no server) — plus a guided
  **Import Concierge** (`js/139-import-concierge.js`) that walks through
  the import with a match report and retry for misses

**Shelves & personal layer**
- Shelves: To Be Read · Currently Reading · Read · Did Not Finish, plus
  a Favorites bookshelf and a Wishlist with region-aware storefront links
  and coming-soon countdowns. DNF gets a 3-tap reason sheet (DNF Autopsy,
  `js/213-dnf.js`)
- Personal ♥ rating (1–5) and genre-aware intensity axes — 🌶️ Spice for
  romance, 👻 Scare for horror, 😰 Suspense for thrillers, ⚔️ Adventure
  for fantasy/sci-fi — auto-detected per book, 1–5 each
- Trope tags (AI-assisted), page tracking with a daily reading log,
  calendar, streaks, notes, and saved quotes
- Character wiki (`js/159-characters.js`): principal characters with
  cross-book identity, relationships between them, and a per-book cast —
  plus per-user character notes. Character add/correct/merge suggestions
  feed the community corpus (`docs/community-corpus.md`)
- Gentle trigger check (`js/221-trigger-check.js`): a one-time heads-up
  before starting a TBR book that has content warnings — a heads-up, never
  a gate; the reader always decides
- Hardcover enrichment in the background: series name + position,
  content warnings, mood chips, extra genres, and a blended community
  rating (ISBN-verified)

**Shelf tab**
- A 2.5D bookshelf (`js/205-shelfview.js`): deterministic spine colors
  and geometry, TBR/Reading/Read chips, tap-to-open, device-local drag
  reordering, layouts (My order / By series / By genre), four display
  formats, and a 3D book view. A decorations tray (plant, candle, mug,
  fairy lights) dresses the shelf up via the **Decorate** button, and
  seasonal shelf themes swap in for the holidays. Decoration layouts save
  in a versioned format that migrates old saves forward.
- Spine-photo capture (`js/206-editioncapture.js`) feeds the shared
  spine-image pool (`edition_images`).

**Discovery**
- **Discover tab**: new releases from your authors (checked automatically
  weekly via a silent sweep), "More like this" strips, series collections
  with "owns X of Y" progress badges and missing-in-series lookup,
  plus an Authors view with missing-by-author lookup
- 🎲 **TBR Roulette**: set your mood — genre, tropes, minimum spice —
  and spin; slot-machine animation lands a winner with one-tap
  **Start reading**

**Stats**
- Dashboard: books finished, pages devoured, average rating, shelf
  distribution, top tropes, current-read progress — plus a detailed
  stats explorer, a shareable Year in Books / Reading Wrapped
  (`js/214-wrapped.js`), and a Reading DNA card (`js/212-dna.js`)
- **Shareable moments** (`js/220-share-moments.js`): one-tap share cards
  for milestones, Reading DNA, and 3D shelf "shelfies"

**Milestones** (`js/219-milestones.js`)
- Quiet celebrations for reading life: TBR archaeology (books that waited
  years), series completion (all owned books in a series read — re-earns
  when the collection grows), Lorekeeper (quotes, notes, characters,
  relationships), the Ugly Cry Club, firsts in new genres, solstice
  stories — plus hidden discoveries that stay secret until unlocked.
  Accepted community-corpus contributions earn their own Lorekeeper
  milestones. No timers, no pace pressure, no reading goals.

**Coven (private social)**
- Invite-code friends, read-only shelf browsing, per-shelf privacy
  controls ("share my shelves" + hide individual shelves)
- "You'd love this" recommendations from friends' 4★+ books
- Soulmate scores, monthly leaderboard, buddy reads, now-reading feed

**Sync & safety**
- Supabase cloud sync: pull-merge-push with last-write-wins conflict
  resolution, deletion tombstones (a deleted book stays deleted),
  per-user on-device partitions, realtime updates across devices
- Quiet by design: background syncs pulse a small dot instead of
  toasting; manual syncs report what changed

**Feel**
- 23 themes, 12 accent colors (the `THEMES` / `ACCENTS` registries in
  `js/010-theming.js` are the source of truth), cohesive
  line-art icon set, 3-step
  onboarding, thoughtful empty states, full PWA (installable, offline
  covers via a size-capped cache)
- Startup validates the saved theme before applying it (a corrupt theme
  falls back to default instead of breaking the UI); custom SVG uploads
  pass a safety gate; the Home tab's Up Next and Favorites strips have
  "View all" links; a quiet banner appears when an update is available

## Run it locally

It's static files today — no build step, no runtime dependencies. Stack policy (User decision, 2026-10-16): frameworks, packages, and build tooling may be adopted where they unlock a capability the current stack can't; production adoption is per-proposal, fork-first. Offline is a resilience requirement, not a hosting ban — the core loop works fully offline; hosted services are allowed where a capability requires them, degrading cleanly when the connection drops.

```bash
cd cozylibram
python3 server.py        # serves on http://localhost:8000
```

On Windows, double-click `start-server.bat`. On the same Wi-Fi, open
`http://<your-PC's-IP>:8000` on a phone (camera barcode scanning needs
HTTPS or localhost — over plain HTTP use the photo/scan fallback or
title search).

## API keys (server-side)

Metadata providers need keys, and they never touch the browser:

- **Local**: copy `server-config.example.json` → `server-config.json`
  and fill in `HARDCOVER_TOKEN` + `GOOGLE_BOOKS_KEY`. `server.py`
  serves `/config.js` from it and proxies `/api/*` with the keys
  attached server-side. Never commit `server-config.json`.
- **Cloudflare Pages** (production: https://cozylibram.pages.dev):
  set `HARDCOVER_TOKEN`, `GOOGLE_BOOKS_KEY`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` as environment variables. `functions/api/*`
  attach the secrets server-side; `/config.js` carries only capability
  flags plus the public Supabase anon key.

If a token was ever pasted anywhere public (chat logs, screenshots),
revoke it at hardcover.app and make a fresh one.

## Supabase tables

See `supabase/README.md`. Grouped by domain, with the SQL file that
creates each:

- `schema.sql` — `books`, `deleted_books`, `profiles` (per-user RLS),
  `circle_links`/`circle_invites` (Coven), `book_meta` (shared per-ISBN
  metadata cache: the first lookup pays the API cost, everyone after reads
  from Supabase)
- `analytics.sql` — `analytics_events` + `app_admins` (first-party
  analytics, default-on for signed-in users with a Settings → Privacy
  opt-out)
- `works.sql` — `works` (canonical book identity; v289 adds
  `spice_detected`/`spice_manual` for roulette filtering) and `editions`
- `claims.sql` — `book_trope_claims` (work-keyed trope claims with
  provenance)
- `anthologies.sql` — `edition_works` (edition → works junction table)
- `tropes.sql` — `tropes`, `book_tropes`, `trope_votes`, `trope_proposals`
  (+ proposal votes, taxonomy metadata)
- `ebook-extraction.sql` — `book_characters`, `book_trigger_claims`
  (ebook processor output)
- `realtime.sql` — adds the sync tables to the realtime publication
- `migrations/` — `spine_photos` (v259, shared spine-image pool),
  `edition_images` (v273), `edition_assets` + `edition_asset_slots`
  (v284), `edition_measurements` (v287), `user_reports` + `banned_users`
  (v246, moderation), `dnf_reasons` (v398),
  `v399_community_corpus_v1.sql` — `character_suggestions`,
  `trigger_taxonomy` (30-entry seed), `trigger_suggestions`,
  `community_votes`, `community_tiers` (see `docs/community-corpus.md`)

## Tech notes

- Single-page vanilla JS — numbered modules under `js/`, one file per
  feature area (running `js/000-core.js` … `js/244-gift-postal.js` today;
  the per-file table lives in `js/README.md`), zero runtime dependencies,
  no build step (current state; see the stack-policy note under
  "Run it locally" above).
- Book schema: `id, isbn, title, authors[], cover, description,
  pageCount, publishedDate, categories[], publicRating, ratingsCount,
  status, ratings{spice|scare|suspense|adventure}, myRating, tropes[],
  tropesAuto[], tropesAI[], axes[], progress, log[], quotes[], notes,
  series{}, contentWarnings[], moods[], owned, favorite`, plus sync
  (`_mtime`) and enrichment (`hcEnriched`) bookkeeping.
- Service worker precaches the app; bump `APP_VERSION`
  (`js/181-appversion.js`) **and** the `sw.js` cache name together to
  force a full asset refetch (paired by `appversion.test.js`).
- Test suite in `.test/` (run with `node .test/<name>.test.js`;
  `package.json` has no test script) — the suite's size, its baseline of
  tolerated failures, and the run discipline live in `CONSTRAINTS.md`, not
  here. One feature per version; tests green + committed + pushed is the
  definition of done.

## Direction

Three ongoing pillars: a **trope intelligence** layer (curated taxonomy,
LLM-seeded per-book tropes, discovery), a **community corpus** (users
refine characters, tropes, and trigger warnings through suggestion flows;
Kevin curates — see `docs/community-corpus.md`), and **sustained quality**
(one feature per version, tests green, data-safety invariants hold).
