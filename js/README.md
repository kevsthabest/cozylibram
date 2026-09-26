# Spicy Shelves — client JS modules

The app is plain, dependency-free JavaScript split into one file per feature.
Files are classic scripts (no `import`/`export`, no build step) loaded in
numeric order by `index.html`. They share one global scope, exactly as if
they were still a single `app.js` — so load order matters: keep the zero-padded numeric
prefixes (lexicographic sort must equal numeric order) and don't create circular top-level dependencies.

| File | Contents |
|---|---|
| `000-core.js` | Global state, constants, `'use strict'` |
| `010-theming.js` | Dark/light themes + accent colors |
| `020-ratings.js` | Genre-aware rating axes |
| `030-storefront.js` | Region-aware "where to buy" retailer links |
| `040-storage.js` | localStorage load/save, book migration |
| `050-helpers.js` | Small shared helpers (`esc`, `toast`, …) |
| `060-metadata.js` | Book lookup: Google Books → Open Library |
| `061-gbooks-key.js` | Optional Google Books API key (quota) |
| `070-hardcover.js` | Hardcover enrichment (series, moods, …) |
| `080-pagecount.js` | Page-count lookup + backfill |
| `090-sync.js` | Supabase auth + cloud sync (optional) |
| `095-gate.js` | Sign-in gate + per-user on-device libraries |
| `100-nav.js` | Bottom-nav wiring |
| `110-library.js` | Library tab |
| `120-favorites.js` | Favorites bookshelf + spine pull-out animation |
| `130-add.js` | Add tab: ISBN scan, title search, manual entry |
| `140-collections.js` | Author/series sheets from your own shelves |
| `150-modal-discovery.js` | Book detail modal + external discovery |
| `160-roulette.js` | TBR "pick for me" roulette |
| `170-stats.js` | Stats tab: reading log, calendar, streaks |
| `180-settings.js` | Settings tab: backup, page counts, keys, sync |
| `190-wishlist.js` | Wishlist tab |
| `200-boot.js` | `applyTheme(); boot(); initCloud();` |

Conventions:
- New feature → new numbered file (pick the next free number in its area).
- Tests live in `.test/` and load every file in sorted order via `.test/harness.js`.
- After any JS change: `node --check js/<file>.js`, then run the test suite.
- The service worker (`sw.js`) precaches these files — add new ones to `ASSETS`.
