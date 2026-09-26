# Spicy Shelves — Agent Handoff Prompt

Copy everything below the line into your new AI agent to continue this project.

---

You are continuing development of **Spicy Shelves**, a mobile-first book-library PWA I built with a previous AI assistant for my wife. She is a prolific reader (several hundred books, large TBR) — mostly dark romance, but also horror/thriller (Stephen King), LitRPG (Dungeon Crawler Carl), fantasy, and more. The app must handle all genres gracefully, not just romance.

## Who I am

My name is Kevin. I have minimal coding experience but some — I build by collaborating with AI. I value practical, maintainable solutions over clever complexity. When you finish work, show me what changed and prove it works (screenshots, tests) rather than just describing it.

## Project location and stack

- Files live in `~/workspace/booktok/` (adjust the path if my setup moved): `index.html`, `styles.css`, `js/` (22 numbered modules — see `js/README.md`), `manifest.json`, `sw.js`, `icon.svg`, `README.md`
- Preview screenshots in `preview/` (numbered, e.g. `1-shelves-list.png`) — look at these to understand the visual direction
- **Vanilla HTML/CSS/JS, no build system, no backend.** Storage is browser `localStorage`. Metadata comes from the free Google Books API (covers fall back to Open Library); public ratings blend Google Books + Open Library via a count-weighted average (`enrichRatings()` in `js/60-metadata.js`). No API keys needed for the basics; an optional free Hardcover token (Settings tab) adds series info, content warnings, and moods.
- Installable PWA (manifest + service worker). Camera barcode scanning requires HTTPS or localhost.
- The app is **fully responsive**: phone-first, 2-column layouts on tablets, 3-column + top nav bar on desktop.

## Current v1 feature set

- **Shelves tab**: TBR / Currently Reading / Read / DNF shelves with counts, text search (title/author/trope), list ↔ cover-grid toggle (persisted)
- **Add tab**: barcode scan (camera), title/author search, manual ISBN entry — all with automatic metadata/cover/rating lookup
- **Pick tab (TBR Roulette)**: filter by genre chips (auto-derived from book metadata), trope/tag text search, and minimum intensity; slot-machine animation picks a winner; one-tap "Start reading" moves it to Currently Reading
- **Stats tab**: books read this year, total read, pages, per-axis average intensity, shelf distribution, trope cloud, currently-reading progress
- **Settings tab**: one-tap JSON export, import with ISBN/title duplicate detection, wipe. **Backups matter** — the original app this replaces was lost, which is why we're rebuilding.
- **Appearance**: 🌙 Dark / ☀️ Light themes with 4 accent colors (Rose, Violet, Gold, Teal), set in Settings → Appearance. Stored on-device.
- **Hardcover enrichment (optional)**: paste a free Hardcover API token in Settings → Hardcover to auto-pull series name/position, content warnings, mood tags, extra genres, and community ratings. New books enrich in the background; "Enrich all books" backfills the library.
- **Book detail editor**: shelf, ratings, tropes, notes, page progress, dates

## Genre-aware rating system (important)

Books have genre-appropriate rating axes instead of one-size-fits-all spice:

| Axis | Emoji | Genres |
|---|---|---|
| Spice | 🌶️ | romance, erotica (default) |
| Scare | 👻 | horror |
| Suspense | 😰 | thriller, mystery, crime, suspense |
| Adventure | ⚔️ | fantasy, sci-fi, LitRPG |

- Axes auto-detect per book from its categories + tropes + title (`autoDetectAxes()`), toggleable per book in the editor (`b.axes`)
- Ratings stored as `b.ratings = { spice: 4, scare: 3 }`; old `b.spice` data auto-migrates on load (`migrateBook()`)
- The ❤️ personal rating is separate and universal

## Book data model

```js
{
  id, isbn, title, authors[], cover, description, pageCount, publishedDate,
  categories[],            // raw Google Books categories, e.g. ["Fiction / Romance / Contemporary"]
  publicRating,            // blended Google Books + Open Library average
  ratingsCount,            // summed count from both sources
  status,                  // 'tbr' | 'reading' | 'read' | 'dnf'
  ratings: { spice?, scare?, suspense?, adventure? },  // 1–5, only rated axes present
  axes: ['spice', ...],    // enabled rating axes for this book
  myRating,                // 1–5 personal rating
  tropes[], progress, dateAdded, dateFinished, notes
}
```

## Roadmap (v2 and beyond, in rough priority order)

1. **Bookmory import** — my wife currently tracks books in the Bookmory app, which has a backup/export feature. I haven't obtained the file yet. When I provide it: inspect the format first, then build a one-click importer. Do not promise compatibility before seeing a real file.
2. **Mood-based "book sommelier"** — recommend from her TBR only, based on mood input
3. **Supabase auth + cloud sync** — data is device-local until then; keep the JSON backup flow working regardless
4. **Reading-pace predictions** ("you'll finish this in ~4 days")
5. **AI spice/intensity estimates from reviews** — hard problem, needs review-text analysis; park until the AI plumbing from #2 exists

## How to work on this project

1. **Keep it simple and dependency-free** unless there's a strong reason otherwise. No frameworks, no build step.
2. **Verify everything visually**: use a headless browser (Playwright/Chromium) to screenshot changed views at phone (390×844) and desktop (1440×900) sizes. If you need sample data, inject it temporarily via a `?demo` query-param hook — then **remove the hook completely** before finishing and confirm with `grep` that no demo code remains.
3. **Syntax-check** with `node --check js/<file>.js` after every JS change.
4. **Update `README.md`** when features change, and save key screenshots to `preview/`.
5. **Never break the data model** without a migration path — her library data is precious. Old backups must keep importing.
6. Explain what you changed in plain language, show screenshots, and ask before starting anything destructive or that adds a backend/account.

## Current state

v1 is feature-complete as described above and visually verified. Nothing is deployed yet — deployment to a free static host is a likely next step when I ask for it. There are no known bugs; the next work is my call.
