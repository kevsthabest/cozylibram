# Cozy Libram — client JS modules

The app is plain, dependency-free JavaScript split into one file per feature.
Files load in numeric order by `index.html`: 95 are ES modules and 9 are
classic scripts (phases 1–3 of the ES-modules migration, complete at v607;
the record is `docs/es-modules-migration-plan.md`). Modules publish their
surface on `window` via bridge blocks, so the remaining classic consumers
see the same globals as before. They share one global scope, exactly as if
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
| `090-sync.js` | Supabase auth + cloud sync + deletion tombstones + password reset (optional) |
| `092-metacache.js` | Shared per-ISBN metadata cache (all signed-in users) |
| `095-gate.js` | Sign-in gate + per-user on-device libraries + password-reset views |
| `100-nav.js` | Bottom-nav wiring |
| `110-library.js` | Library tab |
| `120-favorites.js` | Favorites bookshelf + spine pull-out animation |
| `130-add.js` | Add tab: ISBN scan, title search, manual entry, bulk ISBN import |
| `132-import.js` | Unified import hub: format registry (Goodreads, StoryGraph, ISBN list), CSV parsing, preview + import |
| `140-collections.js` | Author/series sheets from your own shelves |
| `150-modal-discovery.js` | Book detail modal + external discovery |
| `160-roulette.js` | TBR "pick for me" roulette |
| `170-stats.js` | Stats tab: reading log, calendar, streaks |
| `180-settings.js` | Settings tab: backup, page counts, keys, sync |
| `190-wishlist.js` | Wishlist tab |
| `200-boot.js` | `applyTheme(); boot(); initCloud();` |

*This table is hand-maintained and incomplete (it stops at `js/200-boot.js`); the generated module map (`docs/module-map.md`) replaces it when the legibility programme's map step lands.*

Conventions:
- New feature → new numbered file (pick the next free number in its area).
- Tests live in `.test/` and load every file in sorted order via `.test/harness.js`.
- After any JS change: `node --check js/<file>.js`, then run the test suite.
- The service worker (`sw.js`) precaches these files — add new ones to `ASSETS`.
