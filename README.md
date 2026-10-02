# Cozy Libram 📚

A mobile-first, installable web app (PWA) for tracking a book collection —
built for a prolific dark-romance reader, now the household's shared
library. The library lives on-device in IndexedDB (fully offline-capable);
sign-in syncs it to Supabase for cloud backup, multi-device sync, and
social shelves.

![Library (desktop)](docs/screenshots/library.png) ![Library (mobile)](docs/screenshots/library-mobile.png)
*The Library tab — your shelves at a glance. Screenshots taken with a demo account, shown on desktop and mobile.*

## What it does

**Add books, three taps or less**
- 📷 Barcode scan with the phone camera (native `BarcodeDetector`,
  Quagga2 fallback, manual ISBN as backup)
- 🔍 Title/author search across Google Books, Open Library, and Hardcover
- ⌨️ Bulk ISBN import — paste a stack, paced lookup, one-tap add
- 📥 Import hub: Goodreads CSV, StoryGraph CSV, Hardcover CSV, ISBN
  lists, Bookmory backups (parsed in-browser, no server)

**Shelves & personal layer**
- Shelves: To Be Read · Currently Reading · Read · Did Not Finish, plus
  a Favorites bookshelf and a Wishlist with region-aware storefront links
  and coming-soon countdowns
- Personal ♥ rating (1–5) and genre-aware intensity axes — 🌶️ Spice for
  romance, 👻 Scare for horror, 😰 Suspense for thrillers, ⚔️ Adventure
  for fantasy/sci-fi — auto-detected per book, 1–5 each
- Trope tags (AI-assisted), page tracking with a daily reading log,
  calendar, streaks, notes, and saved quotes
- Hardcover enrichment in the background: series name + position,
  content warnings, mood chips, extra genres, and a blended community
  rating (ISBN-verified)

![Book detail (desktop)](docs/screenshots/book-modal.png) ![Book detail (mobile)](docs/screenshots/book-modal-mobile.png)
*Book detail — ratings, series info, tropes, and notes. Screenshots taken with a demo account.*

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
  stats explorer

![Discover (desktop)](docs/screenshots/discover.png) ![Discover (mobile)](docs/screenshots/discover-mobile.png)
*The Discover tab — recommendations, new releases, and TBR Roulette. Screenshots taken with a demo account.*

![Stats (desktop)](docs/screenshots/stats.png) ![Stats (mobile)](docs/screenshots/stats-mobile.png)
*Reading stats — the dashboard and detailed explorer. Screenshots taken with a demo account.*

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
- 10 themes, 12 accent colors, cohesive line-art icon set, 3-step
  onboarding, thoughtful empty states, full PWA (installable, offline
  covers via a size-capped cache)

## Run it locally

No build step, no dependencies — it's static files.

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

See `supabase/README.md`. Core: `books`, `deleted_books`, `profiles`
(per-user RLS), `circle_links`/`circle_invites` (Coven),
`analytics_events` + `app_admins` (first-party analytics, default-on
for signed-in users with a Settings → Privacy opt-out). Trope metadata:
`works`, `editions`, `book_trope_claims` (migrations v202–v208, applied
to the live database).

## Tech notes

- Single-page vanilla JS — 49 numbered classic scripts (`js/000-core.js`
  … `js/200-boot.js`), zero runtime dependencies, no build step.
- Book schema: `id, isbn, title, authors[], cover, description,
  pageCount, publishedDate, categories[], publicRating, ratingsCount,
  status, ratings{spice|scare|suspense|adventure}, myRating, tropes[],
  tropesAuto[], tropesAI[], axes[], progress, log[], quotes[], notes,
  series{}, contentWarnings[], moods[], owned, favorite`, plus sync
  (`_mtime`) and enrichment (`hcEnriched`) bookkeeping.
- Service worker precaches the app; bump `APP_VERSION`
  (`js/181-appversion.js`) **and** the `sw.js` cache name together to
  force a full asset refetch (paired by `appversion.test.js`).
- Test suite in `.test/` (117 files, jsdom — run with
  `node .test/<name>.test.js`; `package.json` has no test script) —
  one feature per version, tests green + committed + pushed is the
  definition of done.

## Direction

Two ongoing pillars: a **trope intelligence** layer (curated taxonomy,
LLM-seeded per-book tropes, discovery) and **sustained quality**
(one feature per version, tests green, data-safety invariants hold).
