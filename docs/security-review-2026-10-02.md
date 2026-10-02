# Security Review — Cozy Libram (`kevsthabest/cozylibram`)

**Date:** 2026-10-02
**Scope:** Read-only review of `~/workspace/booktok` (app v239) in preparation for making the repository **public**. This is a fresh pass under a new threat model — the 2026-10-01 review assumed a private repo and a 2-user service; this one assumes the code, docs, issue tracker, and API surface are visible to the internet. No code was changed, no credentials touched, nothing committed.
**Method:** Static review of all client JS, Pages Functions, Supabase SQL, service worker, `server.py`, live header/policy checks, and a full 285-commit git-history secrets sweep. Read-only Supabase checks via `sb-query` (postgres role). No secrets are reproduced in this report.

## Threat model

- **Attacker:** anyone on the internet. They can read every line of code (including RLS policies, API shapes, rate-limit parameters, and the prior security review), call every `/api/*` endpoint, create an account if signup stays open, and file issues/PRs.
- **Assets:** the owner's paid API quota (OpenRouter/Gemini/Hardcover/Google), the Supabase project (data integrity + storage bill), users' private libraries (wife/family), and the owner's identity/privacy.
- **Out of scope (owner's standing decisions):** `server.py` is a home-PC dev server, not the production path (Cloudflare Pages is); the owner is not self-hosting. One brief note only (§7).

## Executive summary

The codebase is in genuinely good shape for a public launch. Every finding from the 2026-10-01 review that had a code fix is **verified present and effective** (§2): the two stored-XSS holes are closed, all `/api/*` endpoints require a validated Supabase session, the Hardcover proxy enforces a real query-shape allowlist, the security headers are live, `server.py` blocks its sensitive paths, and the covers bucket has no client write path. The 285-commit history is clean of secrets.

What changes under the public threat model is not the code's correctness but **who gets to be a user**. The one decision that materially moves risk is the signup posture (§6): with open signup, any stranger gets an authenticated session, and several *by-design* affordances for a 2-user app become abuse surfaces — world-readable invite codes (`supabase/schema.sql:201`), first-writer-wins shared caches (`book_meta`, `editions`, `works`), and mass-deletable shared AI trope claims. None of these leak private libraries (RLS holds), but they allow quota burn, cache defacement, and social spam. The report ranks these and lays out open vs. closed vs. hardened-middle postures honestly; the call is the owner's.

The other notable gap is **process, not code**: three live tables (`editions`, `works`, `book_trope_claims`) have RLS policies in production but no SQL in `supabase/` — the auditable record the project promises itself is incomplete, and policy drift is now undetectable.

---

## 1. Prior-review fixes — verified present and effective

| Prior ID | Status | Evidence |
|---|---|---|
| SEC-12/SEC-13 (stored XSS, Year-in-Books) | **Fixed, verified** | `js/170-stats.js:617` → `esc(d.longest.title.slice(0, 22))`; `:619` → `esc(d.topAuthor[0].slice(0, 22))` |
| SEC-02 (`/api/*` behind sign-in, v225) | **Fixed, verified** | `authedUser()` gate on `functions/api/hardcover.js:51`, `trope-infer.js:51`, `read-cover.js:97`, `embed.js:56`, `cache-cover.js:75`, `gbooks/[[path]].js:21`, `trope-models.js:74`. Token validated server-side against Supabase Auth (`functions/_lib/require-user.js`) |
| SEC-03 (Hardcover query allowlist) | **Fixed, verified** | `hcQueryAllowed()` (`functions/api/hardcover.js:31-46`): anonymous `query {` only, string literals stripped before keyword checks, `__schema`/`__type`/`mutation`/`subscription` rejected, multi-operation rejected, first root field must be in `{search, books, editions, series}`; enforced at `:70-72` before forwarding |
| SEC-06 (headers) | **Fixed, verified live** | `curl -sI https://cozylibram.pages.dev/` returns `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` |
| SEC-01 (server.py serves secrets) | **Fixed, verified** | `_path_blocked()` (`server.py:303-310`) blocks `/server-config.json`, `/.git` + `/.git/` prefix, `*.pem`/`*.key`, `.env*` in both `do_GET` and `do_HEAD`, returning 404 (not 403) |
| SEC-09 (covers bucket RLS) | **Resolved, verified live** | RLS enabled on `storage.objects`; all 4 storage policies are `bucket_id='avatars'`-scoped; **no** policy grants INSERT/UPDATE/DELETE on `covers` → default-deny. Bucket is `public=true` (read-only CDN behavior, intended); writes only via service-role proxy |
| SEC-11 ("her dark little library") | **Fixed, verified** | Zero matches in `index.html`, `manifest.json`, `js/` |
| SEC-15 (analytics `kind` enum) | **Fixed, verified** | `js/065-analytics.js:88-90` — `kind` now in `PROP_VALUES`; no new `track()` calls since v222 |
| book_meta v194 attribution | **Live, verified** | `book_meta_guard_trg` present on INSERT+UPDATE; policies `read meta`/`write meta`/`refresh meta` match `supabase/schema.sql:36-60` |

## 2. Secrets sweep — clean

Swept all 285 commits (1793 blobs) for: `sk-live/proj/test-*`, `sbp_*`, `AIza*`, `ghp_*`, `xox*`, JWT-shaped strings, email addresses, `service_role` values, keystore extensions.
- **No keys, tokens, or JWTs anywhere in history or working tree.** Only hit: the fake fixture email `r@x.com` in `.test/auth.test.js:27`.
- No `.jks`/keystore files, no `server-config.json` in the tree; `server-config.json` is gitignored (`.gitignore:4`) and `scripts/downscale-covers.py:92-99` loads the service key from that gitignored local file at runtime — owner tooling, nothing committed.
- `scripts/` (backfill-covers, backfill-embeddings, downscale-covers, reclassify-tropes) contain the live Supabase **project ref** (`dvhimjkrroxuatthiizc`) — not a secret, but it identifies the backing project to the world (see PUB-06).
- The old review doc (`docs/security-review-2026-10-01.md`) will become public with the repo. It describes past vulnerabilities (now fixed) and names the attack surface explicitly — normal for open source, but the owner should know it's in the published docs.

## 3. New findings (public-launch threat model)

### PUB-01 [High] Open signup turns 2-user affordances into stranger abuse surfaces
`js/090-sync.js:356-364` (`cloudSignUp` — no invite gate, no allowlist). With the repo public, the signup path is one click away for anyone, and an authenticated stranger gets:
- **Invite-code enumeration** — `supabase/schema.sql:201` (`read codes`: `using (auth.role() = 'authenticated')`) lets any signed-in user list *every* invite code. Combined with open signup, a stranger can spam friend requests to all users; on acceptance they read shared shelves (bounded by `share_library`/`hidden_shelves`, `supabase/schema.sql:238-258`).
- **Shared-cache writes** — `book_meta` "write meta" (`schema.sql:51-54`) is first-writer-wins per ISBN (prior SEC-05, still live by design); `editions`/`works` "user insert" policies require only non-empty `isbn`/`title_norm` (verified live); `book_trope_claims` lets any authenticated user DELETE shared AI claims (`claims: user replace ai regenerable` — verified live, no per-user scoping).
- **Quota burn** — `/api/*` now requires auth, but per-IP rate limits are per-isolate (`functions/_lib/rate-limit.js`); a stranger with N accounts × M IPs multiplies the allowance. No CAPTCHA/bot protection on Supabase Auth observed.

Private libraries themselves hold: `books`/`deleted_books`/`profiles` are strict `auth.uid() = user_id`, and the circle read paths were re-verified live. Impact is integrity/availability/cost, not confidentiality of shelves. **Mitigations are a posture choice — see §6.**

### PUB-02 [High] Auditable SQL record is incomplete — 3 live tables have no repo SQL
`editions`, `works`, and `book_trope_claims` exist in production with RLS enabled and active policies (listed live), but have **no** `create table` / policy statements anywhere in `supabase/` (only `schema.sql`, `tropes.sql`, `analytics.sql`, `realtime.sql`, `migrations/v194_book_meta_ownership.sql` exist). The project's own rule ("keep supabase/*.sql as the auditable record", skill operating rule #6) is violated, and with a public repo + public issue tracker, policy drift on these tables is now undetectable by reviewers. The live policies were inspected for this review (user-insert checks are minimal but sane; claims DELETE is broad — see PUB-03) and RLS is on, so this is a process/control gap rather than a live hole — but it should be closed before inviting external scrutiny.

### PUB-03 [Medium] Any authenticated user can mass-delete shared AI trope claims
Live policy `claims: user replace ai regenerable` on `book_trope_claims` (DELETE, `authenticated`): `USING (source_type='ai' AND (status='candidate' OR (status='confirmed' AND evidence->>'auto_confirmed'='true')))`. No per-user scoping — a single stranger account can wipe the shared trope corpus. Regenerable via re-inference (nuisance + the owner's OpenRouter bill, not data loss), but under open signup this is a one-click griefing primitive. Consider scoping deletes to claims the deleter's account generated, or admin-only delete with user-triggered re-inference as the path.

### PUB-04 [Medium] `editions`/`works` inserts are minimally constrained
Verified live: `editions: user insert` CHECK is only `(work_id IS NOT NULL AND isbn IS NOT NULL AND isbn <> '')`; `works: user insert` CHECK is only `(title_norm IS NOT NULL AND title_norm <> '')`. Same defacement class as `book_meta` (prior SEC-05): a stranger can squat works/editions with bogus metadata every other user then reads. Acceptable for 2 users; questionable with open signup.

### PUB-05 [Medium] Public code removes the obscurity layer — endpoint/API shape enumeration is free
With the repo public, attackers get the `/api/*` route list, exact rate-limit parameters, the Hardcover query allowlist (and thus its precise bypass constraints), RLS policy logic, bucket names, and the analytics event catalog without probing. The defenses are real (auth gates, allowlists, RLS), but review them as if the attacker has read them — because they have. Concrete consequence: the `hcQueryAllowed` regexes (`functions/api/hardcover.js:31-46`) should be treated as the *entire* security boundary for the Hardcover token (they are — verified sound: fragment definitions can't smuggle operations, block-string/comment smuggling only causes false-positive rejects, not bypasses).

### PUB-06 [Medium] `scripts/` identify the live Supabase project and assume owner context
`scripts/backfill-covers.js:25`, `backfill-embeddings.js:27`, `downscale-covers.py:34`, `reclassify-tropes.js:27` hardcode the production project ref. Not secrets — but combined with the public-by-design anon key (served in `/config.js` to anyone), they hand the world the exact project to poke at. For a public repo, move the ref to an env var / documented placeholder and note these scripts are owner-operational.

### PUB-07 [Low] Unescaped `data-pid` in trope proposal rows (SEC-14 class)
`js/195-coven.js:489,491` — `data-pid="' + p.id + '"` interpolates the proposal id raw. Not exploitable today (ids are server-minted UUIDs), but `esc(p.id)` costs nothing and the file already escapes `p.name`/`p.description` at `:483-484`. Same normalization applies to the `b.id` interpolations flagged in prior SEC-14 (still present, still unexploitable — `uid()` charset is `[a-z0-9]`).

### PUB-08 [Low] README misstates the scanner dependency; vendored Quagga is unmaintained
`README.md` advertises "Quagga2 fallback" but `js/vendor/quagga.min.js` is QuaggaJS **0.12.1** (archived upstream ~2021; `js/vendor/SOURCES.txt`). Prior review confirmed no applicable CVEs (the "quagga" CVE hits are the unrelated BGP daemon; a JS image parser is memory-safe by construction). For a public repo this is hygiene + a doc inaccuracy: either vendor `@ericblade/quagga2` or fix the README.

### PUB-09 [Low] `specs/v216-canonical-covers.md` is tracked despite the no-specs convention
`git ls-files specs` shows one tracked spec file. Harmless content, but the workspace rule is "never stage `specs/`" — decide whether specs belong in the public repo at all.

### PUB-10 [Info] Supabase Auth dashboard settings need a pre-launch check (not verifiable from repo)
Confirm in the Supabase dashboard before going public: (a) "Allow new users to sign up" matches the intended posture (§6); (b) email confirmation required (else disposable-email account farming); (c) Site URL + redirect allowlist include only the production origin (password-reset and Google OAuth `redirectTo` values derive from `location`, and Supabase enforces the allowlist — verify it's tight); (d) consider enabling CAPTCHA (Turnstile/hCaptcha) on auth endpoints if signup stays open.

### PUB-11 [Info] Google Books attribution is a ToS requirement for public launch
Per the owner's 2026-10-02 ToS research (now in MEMORY.md): Google Books ToS require "Powered by Google" attribution adjacent to results plus prominent links to Google Books pages, and forbid charging users without Google's written permission (collides with any future paid tier). The attribution/links are not yet in the app. Not a vulnerability — but a public launch without it is a compliance gap, and the charging restriction affects the open-core plan.

### PUB-12 [Info] `server.py` still binds `0.0.0.0` with no LAN gating
Owner's explicit v53 decision; he is not self-hosting and production is Cloudflare Pages. The sensitive-path blocklist (§1, SEC-01) is in place. No action — noted once per the brief.

## 4. XSS re-sweep (v223–v239 delta)

The prior review covered the tree through v222 exhaustively. New/changed render paths since then were re-checked:
- **v236 trope autocomplete** (`js/160-roulette.js`): suggestion names via `esc(s.name)`; counts are integers. Clean.
- **v239 manual series editor** (`js/150-modal-discovery.js:seriesEditHTML`): `esc()` on name, position, and every datalist option. Clean. (Note: `seriesManual` flag correctly blocks enrichment overwrite — `js/070-hardcover.js:114-121`.)
- **v234 Recommended banner, v235 axis labels, v230 taglines**: static strings or internal constants (`RATING_AXES`, `TAGLINES`), escaped at render. Clean.
- **v224 remove-friend sheet** (`js/195-coven.js:519-546`): `esc(friendName)`; friend id flows to `circleRemove` (API call, not HTML). Clean.
- **Trope proposal rows** (`js/195-coven.js:480-493`): `esc()` on name/description/genre labels; only `data-pid` raw (PUB-07).
- No new `eval`/`new Function`/`postMessage`/`javascript:`/open-redirect sinks in the delta. `toast()` still uses `textContent`.

## 5. Auth flows (re-verified)

Standard Supabase Auth, unchanged since the prior review: email/password + Google OAuth (PKCE `exchangeCodeForSession`, `js/090-sync.js:414`), mandatory sign-in gate (`js/095-gate.js`, `js/200-boot.js`), password reset via Supabase with non-enumerating UI copy (`js/095-gate.js:140-155` — always "Reset link sent"). Signup error text surfaces `error.message` through `toast()` (textContent — no XSS; Supabase's obfuscated signup responses avoid account enumeration **only if** email confirmation is enabled — see PUB-10). Session JWT is sent as `Authorization: Bearer` to `/api/*` and validated server-side per request (`functions/_lib/require-user.js`) — never trusted client-side.

## 6. The signup question — open vs. closed vs. hardened (assess, not decide)

The owner has not decided whether signup stays open. Both postures laid out honestly:

**A. Open signup (status quo).** *Risks:* PUB-01 in full — any stranger gets an authenticated session: invite-code enumeration + friend-request spam, shared-cache defacement (`book_meta` first-writer-wins, `editions`/`works` inserts, trope-claim deletes), multiplied `/api/*` quota burn (per-account + per-IP rate limits, no CAPTCHA observed), and a public issue tracker that social-engineers trust ("I'm a user, help me debug" → support-load + phishing surface). Private libraries stay private (RLS verified). *Benefits:* zero friction for family/future users; no owner bottleneck; matches the current code.

**B. Closed signup (Supabase "Allow new users to sign up" OFF, owner invites accounts).** *Risks:* collapse to near-zero — every authenticated user is known; PUB-01/03/04 become non-issues; quota burn requires a compromised known account. *Costs:* the owner becomes the account desk (dashboard invites per user); any future legitimate user waits on him; "public launch" becomes repo-public/service-private, which may confuse contributors filing issues they can't reproduce without an account.

**C. Hardened middle (recommended if the service is meant to grow).** Keep signup open, but: enable email confirmation + CAPTCHA on auth (PUB-10); scope `circle_invites` "read codes" to friends/pending-handshakes instead of all authenticated users; add a per-user rate-limit trigger on `book_meta`/`editions`/`works` inserts; scope trope-claim DELETE to admin or self-generated claims (PUB-03); keep the admin dashboard as the abuse monitor it already is. Effort is small; it preserves zero-friction signup while removing the one-click griefing primitives.

## 7. Pre-public checklist (no code changed by this review)

1. **Decide the signup posture** (§6) — the single highest-leverage decision.
2. **Backfill `supabase/` SQL** for `editions`, `works`, `book_trope_claims` (PUB-02) — export live definitions, review, commit.
3. **Dashboard check** (PUB-10): signup toggle, email confirmation, Site URL/redirect allowlist, CAPTCHA.
4. **Scope `circle_invites` reads** and trope-claim deletes (PUB-01/03) if signup stays open.
5. **Google Books attribution + links** (PUB-11) for ToS compliance.
6. **Replace the `docs/screenshots/` set** — current shots are the owner's live library (the parent agent's screenshot task covers this).
7. **Decide on `preview/`** (11 old mockups) and `specs/` (PUB-09) — keep, refresh, or drop from the public tree.
8. **Fix the README's "Quagga2" claim** or vendor quagga2 (PUB-08).
9. **Know that `docs/security-review-2026-10-01.md` goes public** with the repo — it narrates the (fixed) attack surface in detail.

## 8. What's solid (keep doing)

Per-user RLS is strict and re-verified live on all 18 tables; circle/social reads correctly honor `share_library` + `hidden_shelves`; the `/api/*` auth gates + Hardcover query allowlist + SSRF host allowlists are genuinely well built; `esc()` discipline holds across the whole client including the v223–v239 delta; analytics remains enum-only with the `kind` gap closed; the service worker keeps `/config.js` and `/api/*` out of cache; secrets stay server-side and out of git across the full rewritten history.
