# Cozy Libram 📚🌶️

Her dark little library — a mobile-first, installable web app (PWA) for tracking a
dark-romance book collection. The library lives on-device in `localStorage`
(works fully offline); book metadata comes from the free Google Books API
(public ratings are blended with Open Library's via a count-weighted average)
(with Open Library as a cover fallback). Optional Supabase login adds per-user
cloud backup + multi-device sync — see `supabase/README.md`.

## Run it locally

No backend to install — it's static files.

**Windows (easiest):** copy this folder to your PC, install Python 3.12 free from the
Microsoft Store, then double-click `start-server.bat`. It opens the app at
`http://localhost:8000`. Keep the black window open while using it.

**Any machine with Python:** `python server.py` inside the folder.

**Phone on the same Wi-Fi:** open `http://<your-PC's-IP>:8000` on the phone
(find the IP with `ipconfig` on Windows). Note: live camera barcode scanning needs
HTTPS or localhost, so on the phone over plain HTTP use the "Snap a barcode photo"
button or title search instead.

## Cloudflare Pages hosting

The repo also deploys to Cloudflare Pages (no build step, root output directory):

- `functions/config.js.js` serves `/config.js` from Pages environment variables.
  Since v89 it carries **no secrets** — only `hardcover`/`gbooks` capability
  flags plus the Supabase URL/anon key (public by design).
- `functions/api/hardcover.js` serves `POST /api/hardcover`: forwards GraphQL
  queries to Hardcover with `HARDCOVER_TOKEN` attached server-side.
- `functions/api/gbooks/[[path]].js` serves `GET /api/gbooks/books/v1/volumes`:
  forwards to Google Books with `GOOGLE_BOOKS_KEY` attached server-side
  (only the volumes endpoint is allowed).
- `functions/cover-proxy.js` serves `/cover-proxy`, restricted to known cover hosts.
- `_headers` keeps `/sw.js` out of edge caching so updates propagate.
- `server.py` stays for local development (it mirrors the `/api/*` proxies
  using `server-config.json`); it is not used on Pages.

Pages env vars to set: `HARDCOVER_TOKEN`, `GOOGLE_BOOKS_KEY`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`. Because the secrets never reach the browser, no
Cloudflare Access allowlist is needed to keep them private — though Access
is still a fine extra layer if you want the whole site login-gated.

### API keys (server-side since v89)

Put your Hardcover token and Google Books key in `server-config.json` (local:
copy `server-config.example.json`) or in the Pages environment variables
(`HARDCOVER_TOKEN`, `GOOGLE_BOOKS_KEY`). The keys stay on the server and are
attached to API calls by the `/api/*` proxies — browsers only ever see
capability flags, so no device ever needs a key pasted into Settings and
there is nothing worth stealing in `/config.js`.

Security notes: the keys never leave the server at all — browsers only see
capability flags. If a token was ever
pasted anywhere public (chat logs, screenshots), revoke it at hardcover.app and
make a fresh one for `server-config.json`. Never commit `server-config.json`
anywhere.

## v1 features

- **Three ways to add books**
  - 📷 Barcode scan with the phone camera (native `BarcodeDetector`, Quagga2 fallback, manual ISBN as last resort)
  - 🔍 Search by title/author via Google Books
  - ⌨️ Manual ISBN entry
- **Shelves**: To Be Read · Currently Reading · Read · Did Not Finish
- **Auto-pulled metadata**: cover, description, page count, publish year, public star rating + rating count (Google Books primary, Open Library automatic fallback), plus starter trope tags seeded from subject data — all editable
- **Personal layer**: genre-aware intensity ratings 🌶️👻😰⚔️ (1–5, auto-detected per book — Spice for romance, Scare for horror, Suspense for thrillers, Adventure for fantasy/sci-fi/LitRPG), personal ♥ rating (1–5), tropes tags, page progress, notes, dates
- **Filter chips + live search** across title, author, and tropes
- **List/grid view toggle** (cover grid is very BookTok), staggered card animations
- **TBR Roulette** (🎲 Pick tab): set your mood — genre chips, trope/tag search, minimum spice — then spin. Slot-machine animation lands on a winner with cover, description, and one-tap **Start reading**
- **Responsive**: phone-first, but opens up on tablets (2 columns) and desktops (3 columns, nav moves to a top bar)
- **Stats tab**: books read this year, pages devoured, avg spice, shelf distribution, top tropes, currently-reading progress
- **One-tap JSON backup**: export / import (import merges by ISBN, skips duplicates)
- **Installable**: manifest + service worker, Add to Home Screen on iOS/Android

## Run it locally

```bash
cd booktok
python3 -m http.server 8080
# open http://localhost:8080 on your phone (same Wi-Fi)
# camera scanning needs https or localhost — use plain browsing over http,
# or host it somewhere with https for the full experience
```

Or just double-click `index.html` — everything works except the camera and
offline install, which need a real server.

## Put it on her phone (free hosting)

Easiest: **Netlify Drop** — drag the `booktok` folder onto https://app.netlify.com/drop
and you get an `https://` link instantly. Then on her iPhone: Share → Add to Home
Screen. Camera scanning works because it's https.

Alternatives: Cloudflare Pages, GitHub Pages, Vercel — all free for static sites.

## Roadmap

### v2
- [ ] Bookmory backup import (one-click: books, statuses, ratings)
- [ ] Bulk ISBN import (paste a list, we look them all up)
- [ ] Goodreads / StoryGraph CSV import
- [ ] Recommendation roulette (bring back the classic)

### Later
- [ ] **The Sommelier**: mood-based chat agent that curates from her own TBR
- [ ] Cloud sync (Supabase) so the library survives device changes
- [ ] Reading-pace predictions ("you'll finish this Thursday")

## Tech notes

- Single-page vanilla JS — no build step, no framework to rot.
- `normalizeVolume()` maps Google Books API → our book schema; swap in another
  metadata source (Open Library, Hardcover) by writing a second normalizer.
- Book schema: `id, isbn, title, authors[], cover, description, pageCount,
  publishedDate, categories[], publicRating, ratingsCount, status, spice,
  myRating, tropes[], progress, dateAdded, dateFinished, notes`,
  plus optional Hardcover enrichment: `series{name, position}, contentWarnings[],
  moods[], hcEnriched`
- Backup format: `{ app: 'spicy-shelves', version: 1, exported, books: [...] }`

### Hardcover (optional enrichment)

- Paste a free personal token (hardcover.app → Account settings → API) in
  Settings → Hardcover. The token is stored in `localStorage` on the device only.
- New books are enriched in the background after adding; "Enrich all books"
  backfills the existing library (paced to stay under 60 req/min).
- Enrichment adds: series name + position, content warnings (collapsible),
  mood chips, extra genres, and blends the Hardcover community rating into
  the public rating. ISBN match is verified against the returned ISBNs;
  otherwise it falls back to title + author matching.
