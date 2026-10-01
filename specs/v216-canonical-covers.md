# v216 — Canonical cover cache (Supabase Storage)

**Status:** spec (drafted 2026-09-30). Build after v214 (recommender diversity) and v215 (modal swipe-to-close) land.
**Decision:** Kevin chose Supabase Storage canonical copies over source-thumbnails or per-device canvas downscaling, explicitly for scale (more users, 400+ more books incoming).

---

## 1. Goal

Today every book stores a remote cover URL (Google Books, Open Library, Apple Books, Hardcover CDN) and `sw.js` cache-first-caches **every image the device ever renders** (`cozy-libram-covers`, count-trimmed at 600 entries, opaque cross-origin responses with no usable size) — observed at ~1 GB on-device. Storage grows with **users × devices × books** and includes junk (picker candidates never adopted, edition art, full-resolution files).

v216 moves to **one canonical copy per unique cover in a Supabase Storage bucket**. Every client that adopts a cover sends the remote URL through a new server-side function; the function fetches the bytes, hashes them, stores once, and returns the canonical bucket URL that gets saved on the book. Storage is then **flat**: ~500 unique covers ≈ 150 MB total, shared by all users and devices, instead of ~1 GB per device.

### Scale math

| | Today (per device) | v216 (global) |
|---|---|---|
| 600-book library, ~500 unique covers | up to ~1 GB in `cozy-libram-covers` (full-res, opaque, count-capped) | ~150 MB in the bucket (500 × ~300 KB originals), deduped |
| +1 user / +1 device | full re-download, another ~1 GB | ~0 new bytes server-side; device cache is a small LRU |
| Source URL dies (Google/OL link rot) | cover breaks everywhere | unaffected — bytes are ours |
| Free-tier budget | n/a (client bandwidth) | 1 GB storage, 5 GB/mo egress → a full 150 MB device sync fits ~30×/mo. **$0** |

### Constraints

- Vanilla JS, zero dependencies, no build step. One feature per version.
- Keys stay server-side. The service key never enters the repo (Pages env var, like `HARDCOVER_TOKEN`).
- Reuse existing patterns: `functions/_lib/rate-limit.js`, the `cover-proxy.js` SSRF allowlist shape, same-origin `/api/*` POST-with-JSON client convention.
- Never lose a cover: any failure in the new pipeline falls back to the remote URL.
- `data:` URLs (user uploads) are **never** sent to the shared bucket — they stay local-only by design (privacy).
- Do not rewrite the sync architecture. `book.cover` remains a plain synced string field; rewriting remote → canonical bumps `_mtime` so it wins the merge like any other metadata edit. Cover URLs are regenerable, so a rewrite is always safe.

---

## 2. Bucket design

- **Bucket:** `covers` (id `covers`), **public read** (`public = true`).
- **Object key:** `covers/<sha256-hex-of-bytes>.<ext>` — content-addressed, so the same image from any source, adopted by any user, maps to one object. `ext` from the response Content-Type via a fixed map (`image/jpeg→jpg`, `image/png→png`, `image/webp→webp`, `image/gif→gif`, `image/avif→avif`; fallback `jpg`).
- **Writes:** server-side only, via a new `SUPABASE_SERVICE_KEY` Pages env var (Kevin adds it in the Cloudflare dashboard, same as he did the Workers AI binding). Service role bypasses RLS, so **no RLS policies are required**; public reads are handled by the bucket's `public` flag.
- **Auditable SQL** (save as `~/workspace/metadata-staging/v216_01_covers_bucket.sql`, additive — covered by Kevin's standing waiver):

```sql
insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do update set public = true;
```

- **server.py (home-PC dev server):** add `supabase_service_key` to `server-config.json` and a matching `/api/cache-cover` route mirroring the Pages Function (server.py already mirrors `/api/*` and `/cover-proxy`; keep local-dev parity). No `/config.js` flag needed — the client treats 503 as "not configured" and falls back silently.

> **Unknown to verify at build time:** exact `storage.buckets` column list on the live project (via `sb-query`) before running the migration.

---

## 3. New function: `functions/api/cache-cover.js`

`POST /api/cache-cover` with JSON body `{ "url": "<https cover url>" }`.

### Flow

1. **Method + rate limit.** POST only (405 otherwise). `rateLimit(request, 'cache-cover', 300, 60*1000)` → 429 when exceeded. (300/min chosen deliberately: the bulk flows below sustain ~150 req/min with their 400 ms politeness pacing; a 429 is always survivable — see client fallback.)
2. **Env check.** `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` must be set, else `503 {error:'cover cache not configured'}` (client keeps the remote URL).
3. **URL validation (SSRF).** Parse; require `https:`; require the lowercase hostname to be in the allowlist. Reuse the `cover-proxy.js` pattern (a `Set`, "not listed ⇒ unreachable by construction"). Allowlist for v216:
   - `covers.openlibrary.org` (Open Library)
   - `books.google.com` (Google Books thumbnails)
   - `is1-ssl.mzstatic.com` … `is5-ssl.mzstatic.com` (Apple Books artwork — **not** in `cover-proxy.js`'s list today; required here)
   - `img.hardcover.app` (Hardcover image CDN — see §10 unknowns; `cover-proxy.js` lists `hardcover.app`, which appears wrong)
   
   Reject anything else with `403 {error:'host not allowed'}`. Trim input to 2000 chars like `cover-proxy.js`.
4. **Server-side fetch** (avoids browser CORS taint entirely): `fetch(url, { headers: { 'User-Agent': 'CozyLibram/1.0 cache-cover' } })`. Require `res.ok` and `Content-Type: image/*`, else `502 {error:'not an image'}`. Cap at **4 MB** (`MAX_BYTES`, same as `cover-proxy.js`) → `502 {error:'image too large'}`.
5. **Hash + key.** `crypto.subtle.digest('SHA-256', bytes)` → hex → `<hex>.<ext>`.
6. **Upload with dedup.** `POST {SUPABASE_URL}/storage/v1/object/covers/<key>` with headers `apikey: <service key>`, `Authorization: Bearer <service key>`, `x-upsert: false`, `Content-Type: <ctype>`. If the object already exists (duplicate error), **treat as success** — that *is* the dedup hit. No separate existence check needed.
7. **Respond** `200 { "coverUrl": "<SUPABASE_URL>/storage/v1/object/public/covers/<key>" }`. The function builds the public URL (single source of truth; the client never constructs bucket URLs).

### Error contract (client keeps the remote URL on all of these — never a lost cover)

| Status | Meaning |
|---|---|
| 200 `{coverUrl}` | canonicalized (fresh upload or dedup hit) |
| 400 | not an https URL / unparseable body |
| 403 | host not on the allowlist |
| 429 | rate-limited — caller keeps remote URL and continues; backfill retries later |
| 502 | upstream fetch failed / not an image / over 4 MB |
| 503 | `SUPABASE_SERVICE_KEY` not configured on this server |

> **Unknowns to verify at build time:** (a) the real hostname in Hardcover `image.url` values (test fixture says `img.hardcover.app`; confirm against one live value before freezing the allowlist); (b) the exact duplicate-object error shape from the Storage REST API with `x-upsert: false`; (c) that public bucket objects serve `access-control-allow-origin: *` (expected — needed so `sw.js` gets non-opaque, measurable responses).

---

## 4. Client integration points

New shared helper in `js/136-coverpicker.js` (the cover domain file; loads before 138/180, classic scripts share globals):

```js
// Returns the canonical bucket URL for a remote cover, or the original URL
// on any failure. data: URLs (user uploads) and already-canonical URLs pass
// through untouched — uploads never leave the device.
async function canonicalizeCoverUrl(url) { /* … */ }
```

Rules inside: skip when `!url`, `url` starts with `data:`, or `url` already contains `/storage/v1/object/public/covers/`. Otherwise `POST /api/cache-cover {url}`; on `!res.ok`, non-JSON, or network error → return the original. Log via `AppLog` (info on canonicalize, error on unexpected shapes) — no toasts; this must be invisible.

**Adoption points to rewire** (every place a remote cover URL is *saved* onto a book):

1. **`chooseCover(bookId, url)`** — `js/136-coverpicker.js:132`. Becomes async: `b.cover = await canonicalizeCoverUrl(url)`. Callers: the upload handler (already async) and the picker grid click (make the listener async). `data:` uploads skip canonicalization by the helper's own rule.
2. **`downloadMissingCovers`** — `js/136-coverpicker.js:223` (bulk "Download missing covers", invoked from Settings). After `verify(url)` passes: `b.cover = await canonicalizeCoverUrl(url)`. The existing 400 ms politeness delay already paces the function calls; on 429 the helper returns the remote URL and the loop continues (the backfill in §5 picks up stragglers).
3. **`applyEdition(bookId, ed)`** — `js/138-editions.js` (already async): `b.cover = await canonicalizeCoverUrl(ed.cover)` in place of the direct assignment (keep the `data:`-upload guard — the helper double-covers it).
4. **Metadata-check adoption** — `js/134-verify.js:120` (`book.cover = meta.cover`): route through `canonicalizeCoverUrl` as well (same "adopt a remote cover" action). Make the surrounding flow await it.

**Explicitly NOT rewired:** `js/133-bookmory.js:387` (zip-extracted bytes → `data:` URL, local-only by design); `js/092-metacache.js:116` (snapshot restore — replays whatever is stored, canonical or remote, no new adoption); `js/150-modal-discovery.js` search-result covers (`r.cover` on transient result objects, never saved to the library).

---

## 5. Migration: backfill, not lazy

**Recommend a one-time backfill script** over lazy migration: covers render from stored URLs, so "canonicalize on view" would either rewrite on every render or need viewed-flags — both worse than a single pass.

- New `scripts/backfill-covers.js`: reads the signed-in user's books from Supabase (`books` table, `cover` column), and for each cover that is `http(s)` and not yet canonical and not `data:`, calls the **production** `/api/cache-cover` and writes back the canonical URL (bumping `updated_at`/`_mtime` per the table's convention so devices pull it). Paces itself (~2 req/s, well under the 300/min limit), logs progress, resumable (skips canonical/data:/empty).
- Existing remote URLs keep working if the backfill is partial or never runs — nothing breaks, those books just don't get the dedup/offline benefits until their cover is next adopted.
- Reuse the `backfill-embeddings.js` script shape (progress logging, resume) as the template.

---

## 6. `sw.js` changes

1. **Delete the catch-all.** Remove the `if (e.request.destination === 'image')` block that caches every image response. This is the ~1 GB bug.
2. **Bucket-only runtime cache.** Cache-first for requests whose URL path starts with `/storage/v1/object/public/covers/` (origin-agnostic path match — works for any Supabase project URL):
   ```js
   if (url.pathname.indexOf('/storage/v1/object/public/covers/') === 0) {
     // cache-first in IMG_CACHE ('cozy-libram-covers', keep the name — it
     // survives version bumps and the Settings clear button targets it)
   }
   ```
   Bucket objects are CORS-clean, so responses are **non-opaque with real `Content-Length`** — size-based eviction finally works.
3. **Size-based LRU trim.** Replace `IMG_CACHE_MAX = 600` (count) with a byte budget, e.g. `IMG_CACHE_MAX_BYTES = 150 * 1024 * 1024`. `trimImageCache` iterates keys oldest-first, sums sizes from the `Content-Length` header (fall back to a conservative 300 KB estimate when absent), and deletes until under budget. Keep it defensive: any failure → leave the cache alone.
4. **Offline story unchanged.** The Settings "Cache covers for offline" button (see §4 flow in `js/180-settings.js`) keeps working as-is — its `<img>` loads now populate the bucket-scoped cache with canonical URLs only. Update its note text to reflect the new behavior.

---

## 7. Settings Storage screen

Extend the **Offline** accordion group in `js/180-settings.js` (next to the existing "Cover cache" subsection):

- **Live usage readout** via `navigator.storage.estimate()`: "On this device: X MB total · Y covers cached" (count via `caches.open('cozy-libram-covers').keys()`).
- **"Clear cached covers"** button → `caches.delete('cozy-libram-covers')` + toast. Label it clearly: this clears *this device's* offline copies only — the canonical copies in the bucket (shared) are untouched.
- Keep the existing "Cache covers for offline" pre-cache button where it is.

---

## 8. Tests

- **Extend `.test/pages-functions.test.js`** (dynamic-import ESM pattern, mock `globalThis.fetch`): SSRF rejection for non-allowlisted host (403) and `http:` URL (400); same-bytes → same object key (hash naming); duplicate-upload error → still returns 200 with the canonical URL and performs no second upload (dedup-skip); missing `SUPABASE_SERVICE_KEY` → 503; non-`image/*` content-type → 502; >4 MB body → 502; POST-only (GET → 405); rate-limit helper already covered.
- **New `.test/canonical-covers.test.js`**: `canonicalizeCoverUrl` passes `data:` URLs through untouched; passes already-canonical bucket URLs through; returns the original URL on function 4xx/5xx/network failure (never throws, never returns empty); returns the canonical URL on 200. (Load `js/136-coverpicker.js` in the same vm/jsdom harness style the other client tests use; stub `fetch` and `AppLog`.)
- **Update `.test/offline-covers.test.js`**: arbitrary cross-origin image URLs are **not** cached anymore (catch-all removed); bucket-path URLs **are** cached cache-first; trim evicts oldest-first past the 150 MB budget (synthesize entries with `Content-Length` headers).
- Full suite green before commit, per the release bar.

---

## 9. Explicitly out of scope for v1

- **No downscaling / WebP conversion.** Originals are stored as fetched. The dedup math already fits the free tier; server-side image processing (no canvas in Workers) is a future optimization if the bucket ever approaches 1 GB.
- **No change to `cover-proxy.js`** (pixel reads for spine colors keep working as-is). Note: its allowlist's `hardcover.app` entry looks wrong next to the `img.hardcover.app` test fixture — file as a separate small fix, do not bundle it here.
- **No RLS policies** on the bucket (service-role writes bypass RLS; public flag covers reads).
- **No changes to book sync semantics** — `cover` stays a plain `_mtime`-resolved string field.
- **No user-upload pipeline changes** — `data:` covers never touch the function or bucket.

---

## 10. Rollout checklist (release-bar order)

1. **Spec review** — this file. Confirm version number at build time (v214/v215 were in flight when this was written; bump to whatever is next).
2. **Infra (Kevin):** create the `covers` bucket via the SQL in §2 (verify columns first); add `SUPABASE_SERVICE_KEY` to the Cloudflare Pages env vars; add `supabase_service_key` to `server-config.json` for local dev.
3. **Build:** `functions/api/cache-cover.js`, `canonicalizeCoverUrl` + the four rewired adoption points, backfill script, `sw.js` cache rewrite, Settings Storage screen, `server.py` route.
4. **Tests:** new + updated suites above; **full suite green** (`node` over `.test/*.test.js`, 0 failures).
5. **Version bump:** `APP_VERSION` in `js/181-appversion.js` + `CACHE` name in `sw.js` (forces a full asset refetch).
6. **Commit** (message explains the per-device → flat storage change), **push** to main.
7. **Package:** delete the previous release zip, keep only the newest `cozy-libram-vNNN.zip`.
8. **Production verify** (cache-busted fetches, never the Settings version number alone): `sw.js` returns the new cache name; `POST /api/cache-cover` with a disallowed host returns 403 (no side effects); then one real canonicalization of a known cover URL returns 200 with a `…/storage/v1/object/public/covers/<hash>.<ext>` URL and a second call dedups to the same URL. Confirm the object exists in the bucket via `sb-query`.
9. **Backfill:** run `scripts/backfill-covers.js` against production; confirm bucket size stays ≈150 MB.
10. **Kevin tap-through on his phone:** adopt a cover from the picker (should feel instant — fallback is invisible), check Settings → Offline shows usage, clear + re-pre-cache.

### Open unknowns for the builder (do not guess — verify)

- Real hostname in Hardcover `image.url` (fixture says `img.hardcover.app`).
- `storage.buckets` columns on the live project before running §2 SQL.
- Duplicate-object error shape from Storage REST with `x-upsert: false`.
- `access-control-allow-origin` on public bucket objects (needed for non-opaque SW entries).

## 11. v218 addendum — cover downscale sweep (2026-09-30)

The v216 backfill stored ORIGINAL cover bytes. Sampling found monsters like an
1800×2700 3.3MB JPEG displayed at ~104–160px wide — phones drop frames
decoding dozens of these during a fast fling (the residual scroll stutter
after v217's content-visibility fix). A second contributor: `.bottom-nav`
used `backdrop-filter: blur(10px)` while fixed on-screen during scroll.

- `scripts/downscale-covers.py`: one-shot sweep — downloads every `covers`
  object, downscales anything with an edge > 600px to max 600px long edge
  (PIL LANCZOS, JPEG q82), PUTs it back IN PLACE to the same key (same URL,
  smaller bytes, zero DB migration). Default is a dry run; `--upload` reads
  the service key from `server-config.json` (same convention as server.py)
  and must run on a machine that has it. Progress: `scripts/downscale-progress.jsonl`
  (resumable, mode-aware). Never deletes objects, never touches books data.
- v218 also removed the nav `backdrop-filter` and made all `--nav-bg` theme
  values opaque (alpha 1) so the look stays clean without the blur.
- New adoptions still store originals (function has no image pipeline in
  Workers). Re-run the sweep occasionally, or wire it into the backfill
  script later. A future optimization: downscale at adoption time.
