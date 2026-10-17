# Runbook — Cozy Libram operations

How the running system is operated and fixed: deploys, version discipline,
diagnosis order, database procedure, secrets locations, incidents.

This is Layer 5 of the Repo Legibility Standard
(`docs/repo-legibility-spec.md` §7). It carries procedures and pointers —
the quality bar itself lives in `CONSTRAINTS.md` and is pointed at, never
copied. Whoever changes an operational procedure updates this file in the
same PR; a procedure that changed without its runbook section is an
incomplete change.

*Verified against `origin/main` @ `0a9ec04` (APP_VERSION v607), 2026-10-17.*

## 1. Deploys

- Cloudflare Pages (project `cozylibram`) auto-deploys **every push to
  `main`**. Production is https://cozylibram.pages.dev. There are no
  release zips (retired 2026-10-01) — installs run from git pull or Pages.
- Every pushed branch also gets a Pages preview deployment; the ES-modules
  fork pilot was gated on its branch preview, and a change that needs a
  device pass before merge uses one.
- A merged PR is **not** a live app. A change is "live" only after the
  deployed version string has been read back from the production URL —
  fetch the served `js/181-appversion.js` (or the `CACHE` name in the
  served `sw.js`; they are the pinned pair, §2) and confirm it reads the
  new version. Edge propagation can serve the new version string with
  stale assets for a short window; if the pair disagrees with the page,
  re-check before concluding anything.
- Docs-only changes do not bump the version (§2), so a docs merge leaves
  the production version string where it was — that is expected, not a
  failed deploy.

## 2. Version discipline

- `APP_VERSION` (`js/181-appversion.js`) and the `CACHE` name in `sw.js`
  bump **together, to the same version, in the same change**
  (`CONSTRAINTS.md` rule 2). The pairing is test-pinned
  (`.test/appversion.test.js` parses both files and compares them, and
  several suites pin the literal pair).
- The next version number is allocated from `origin/main`'s current
  version + 1, taken at the branch's pre-PR rebase — not when the branch
  was cut. If another PR lands first and takes the number, renumber at
  rebase (precedent: PR #242 renumbered v567 → v568 at rebase).
- A change to served code bumps the pair. A docs-only change does not
  allocate a version (Legibility programme rule).
- **New JS file = three touchpoints:** the file under `js/`, a script tag
  in `index.html`, and the `sw.js` precache list. The pin is enforced:
  `.test/appversion.test.js` fails if any script in `index.html` is
  missing from the precache list — an omission silently breaks offline
  use and updates.

## 3. Stale-cache doctrine

The default suspect for any device-only failure is a stale cache, not a
code defect — confirm the device actually runs the version being tested
before debugging anything.

- A Settings version reading does **not** guarantee fresh CSS or assets:
  the page can report the new version while running cached files.
- Force a genuine reload first. If a hard reload still shows a **mix** of
  old and new code (a partial service-worker update), close **all** tabs
  for the origin, then open fresh and hard-reload — that cleared a mixed
  old/new state on 2026-10-10 where hard reload alone kept serving stale
  files.
- The service worker calls `skipWaiting()` on install and
  `clients.claim()` on activate (`sw.js`), so a new worker takes over
  promptly — but an already-open session keeps the JS it loaded until a
  fresh launch. "The new worker is active" is not "this tab runs the new
  code."

## 4. Diagnosis order

Work these in order; each step is cheaper than the next.

1. **Read the deployed version first** (§1). A report against a version
   that is not what production serves is not a bug report yet.
2. **When a feature "does nothing," test the server-side gate with
   `curl` before reading client code.** The cover-proxy lesson: the
   client was fine while `functions/cover-proxy.js`'s host allowlist had
   diverged from what the client asked for, and the failure presented as
   a dead feature. Client features that call `functions/api/*` or the
   cover proxy have a server-side half — probe it directly.
3. **Verify the tree you are testing is the tree you mean** — the
   stale-checkout doctrine. Version state is read from `origin/main`,
   never from a working tree: the main checkout sat at v537 while
   `origin/main` advanced to v607 (~70 versions) through the ES-modules
   programme, and exactly one suite noticed (its loader was bound to the
   stale checkout — `docs/incidents/` has the companion case in §7's
   second seed). Run suites with `COZYLIBRAM_DIR` pointed at the checkout
   under test (`CONSTRAINTS.md` rule 1); a suite run against the wrong
   tree proves nothing, however green.

Suite running discipline — serial runs, the 6-failure baseline, what
"green" means — lives in `CONSTRAINTS.md`; this runbook does not restate
it.

## 5. Database (Supabase)

**Pointers (no values — §6).** Project "Spicy", ref
`dvhimjkrroxuatthiizc`, region us-west-2. Dashboard:
https://supabase.com/dashboard/project/dvhimjkrroxuatthiizc — sign in via
"Continue with GitHub". The in-repo record is `supabase/schema.sql` plus
`supabase/migrations/` (kept as the auditable record even when a change
is applied directly); `supabase/README.md` is the setup guide (project
creation, tables, credentials).

**Migrations.** Migration files (`supabase/migrations/vNNN_*.sql`) land
in the PR; they are **applied after the PR merges**, then verified by
spot-checks against production (below). A merged migration file is not
an applied migration — confirm application, don't assume it.

**Access paths — name which one produced every result.**

- **Management API SQL** (`sb-query`,
  `~/workspace/custom-connectors/custom.legacy-supabase/bin/sb-query`):
  `sb-query <project-ref>` with SQL on stdin (or as an argument). Runs as
  `postgres`, so **RLS does not apply**; multi-statement stdin returns
  only the last result set.
- **PostgREST** (the app's path): runs as `anon` / `authenticated`;
  **RLS applies**.

A Management API count proves rows exist; it says nothing about what a
user can see. Never present one path's result as evidence about the
other.

**Verification preamble — step zero, before any finding-grade query.**
A query session can be silently pointed at the wrong database, or its
outputs can mix with another session's — every result internally valid,
none of it attributable. Before drafting any finding from database work,
prove the session is describing production:

1. Run **one atomic statement** carrying a unique marker (a literal
   string in the SELECT list) that reconciles, in a single output:
   - the known production row counts for the tables in question, and
   - a namespace/schema fingerprint (`current_database()`, the schema
     list, the extension set).
2. Run it in a **quiet window** — no other query sessions of yours in
   flight — so the output has exactly one possible source.
3. Completion criterion: marker, counts, and fingerprint in one output,
   all consistent with production. Anything incoherent or unattributable
   means the verdict is **"no data"** — stop, re-verify, and never draft
   findings from an unverified session. Findings already drafted from one
   are withdrawn, not defended.

Every finding-grade query after the preamble names the access path it
used and the preamble it rests on.

**RLS-faithful spot-check — what a real user actually sees.** To test a
read or write the way a user experiences it, run the app's exact
statement inside a transaction, under the user's role and claims:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"<user-uuid>","role":"authenticated"}', true);
-- copy fixture rows into a temp table or use existing test rows;
-- run the exact SELECT / INSERT / UPDATE the app runs;
ROLLBACK;
```

`SET LOCAL ROLE` plus the `request.jwt.claims` GUC makes `auth.uid()`
and every RLS policy evaluate as that user, while the `sb-query`
`postgres` connection supplies the session. Completion criterion: the
statement returns exactly the rows that user is entitled to — no more
(leak), no fewer (broken policy) — and the transaction is rolled back,
leaving production untouched.

**Writes.** Verify with a read-only query before any write. Destructive
statements (DROP, TRUNCATE, DELETE, schema rewrites) need the User's
explicit approval naming the exact statement and target.

## 6. Secrets

Never in the repo, never in docs, never in screenshots. Locations only:

- **Production (Cloudflare Pages):** environment variables on the Pages
  project (`HARDCOVER_TOKEN`, `GOOGLE_BOOKS_KEY`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` — names are public in `README.md`, values are not).
  `functions/api/*` attach them server-side; the served `/config.js`
  carries only capability flags plus the public Supabase anon key.
- **Local development:** `server-config.json` at the repo root —
  gitignored (`.gitignore`), copied from `server-config.example.json`.
  `server.py` serves `/config.js` from it and proxies `/api/*` with the
  keys attached server-side. Never commit it.
- **Supabase access:** through the stored connector credential
  (`custom.supabase`) used by the `sb-query` tooling — never a raw key
  pasted in chat, a secret environment variable, or a hand-written auth
  file. Dashboard access is via GitHub sign-in (§5).
- A token pasted anywhere public (chat logs, screenshots) is **revoked
  and replaced** — `README.md`'s API-keys section keeps the per-provider
  pointer (revoke at hardcover.app, make a fresh one).

## 7. Incidents

- Summaries live in `docs/incidents/`, blameless and summary-length: what
  happened, what the evidence showed, what changed as a result. Full
  postmortems stay in the workspace (User's ruling, 2026-10-17).
- An incident that changes a rule produces an ADR (Layer 2,
  `docs/adr/`) and, where feasible, a pinning test (Layer 4) — the
  write-up alone is not the fix. Incident-class findings also spawn a
  postmortem once the fix ships (agent-team protocol).
- Seed entries:
  - [The depollute repair, retired at v568](incidents/2026-10-15-depollute.md)
    — a self-healing repair that deleted legitimately shared books; the
    fix is retired code plus a regression pin of the exact scenario.
  - [The title-write misdiagnosis, 2026-10-16](incidents/2026-10-16-title-write-misdiagnosis.md)
    — a frightening claim settled by an automated case: the write path
    was innocent; historical data was not.

## 8. Continuous integration

- **What runs.** `.github/workflows/ci.yml` fires on every pull request
  to `main` and every push to `main`: `npm ci`, then
  `node scripts/run-ci.mjs`. The runner executes the full suite
  serially (the baseline's measurement condition — `CONSTRAINTS.md`),
  then the version-pair check below. Job timeout is 45 minutes.
- **The baseline rule.** The job is green only when the failing set
  **equals** `.test/baseline-failures.txt` exactly. A new failure fails
  it; a baseline file starting to pass also fails it — the list moves
  only by named decision, never by drift. The runner's log prints the
  suite counts, the failing set, the baseline status, and both
  version-check results.
- **The version-pair check.** In the same run: `APP_VERSION` must equal
  the `CACHE` version (§2); and when a PR changes served app code
  (the exact set is defined in `scripts/run-ci.mjs` — `js/`,
  `index.html`, `sw.js`, `styles.css`, `assets/`, `img/`, `vendor/`,
  `functions/`, and the root manifest/header/icon files), the pair must
  differ from the PR base's pair. The check never demands a specific
  number — numbers are allocated at rebase (§2) — only that the pair
  moved. Docs-only and test-only PRs are exempt from the "moved" half.
- **Updating the baseline.** Only as a named decision (ADR-012): one
  PR updates the `CONSTRAINTS.md` table and
  `.test/baseline-failures.txt` together, with the reason stated. A CI
  run reporting "baseline now passing" is the prompt to open that PR —
  never to edit the list inside an unrelated change.
- **CI is not the merge gate.** Merges still run on the merge model
  (tests at baseline + Security Advisor PASS — `CONTRIBUTING.md`). A
  green CI job is evidence for the gate, not a substitute for it.
