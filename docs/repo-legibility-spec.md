# Repo Legibility Standard — Cozy Libram

**Status:** APPROVED by the User 2026-10-17 · the of-record copy. Build proceeds per §9 as amended by the Reviewer seat's re-grounding note (2026-10-17), including the combined successor phase (note §7).
**Grounded against:** `origin/main` @ `fd3a052` (APP_VERSION v607, ES-modules phases 1–3 COMPLETE) — re-grounding detail in the Codebase Reviewer seat's note, `~/workspace/codebase-reviewer/2026-10-17-legibility-regrounding.md`
**Supersedes:** the full-tree comment-rewrite framing of the 2026-10-16 comment
standard (see `docs/es-modules-migration-plan.md` §13, which anticipated this
spec). The comment standard's rules for NEW code stand unchanged.

---

## 1. Charter — the "anyone" test

The repo is designed so that **anyone who accesses it — a human or an AI
agent, arriving cold, with no access to any agent's memory, chat history, or
workspace files outside this repo — can understand:**

1. **What is this?** (what the app does, what each part is for)
2. **Why is it built this way?** (the decisions, and what was given up)
3. **How do I change it safely?** (the contracts, the tests, the process)
4. **What do I do when it breaks?** (diagnosis and recovery procedures)

This is an acceptance test, not an aspiration. A legibility claim that depends
on knowledge living in `~/AGENTS.md`, a workspace skill, a side chat, or an
agent's memory **does not count** — if it isn't in the repo, it doesn't exist
for the next reader. Every layer below exists to move one class of knowledge
from outside the repo into it, in the form that class of knowledge survives in.

A cold reader's first 10 minutes are the design target (§4.3).

---

## 2. Current state (verified 2026-10-16; re-verified 2026-10-17, origin/main @ v607)

What the repo already has:

- `CONSTRAINTS.md` — the quality bar, in-repo: the 6 named baseline test
  failures, COZYLIBRAM_DIR discipline (renamed from BOOKTOK_DIR, PR #285), version pairing, frozen settings keys,
  no-drive-by-test-fixes, the Advisor gate. This is the model the other
  layers imitate.
- `GLOSSARY.md` — the app's naming language, in-repo.
- `docs/` — feature specs (candle, blind date, gift, marginalia, finale…),
  two security reviews, and `docs/es-modules-migration-plan.md`, whose
  appended per-PR gate notes — a complete phases 1–3 record at v607 — are
  an accidental prototype of the decision layer: dated, evidence-carrying,
  never rewritten.
- `supabase/README.md` — a *setup* guide (create project, create tables, get
  credentials). It is not an operations runbook: no migration-apply
  procedure, no verification discipline, no troubleshooting.
- Test-pinned contracts: version pairing and several invariants are enforced
  by suites, not just described.

What is stale or missing — the gap this standard closes:

- **README numbers have drifted.** The Tech-notes bullet still says "73
  numbered scripts (`js/000-core.js` … `js/224-curation-queue.js`)"; the tree
  has 104 top-level `js/*.js` files running to `js/244-gift-postal.js`. README
  says 17 themes; the tree has 23. README says the suite is 153 files;
  `CONSTRAINTS.md` says 178; `.test/` actually holds 206 `*.test.js` files.
  Three in-repo sources, three different numbers — every hardcoded count in a
  hand-maintained doc is a future lie.
- **`js/README.md` is a hand-maintained module map, and it has already
  rotted.** Its table stops at `js/200-boot.js` and its preamble still states
  all files are classic scripts loaded in numeric order — while the served
  `index.html` at v607 carries 95 `type="module"` tags (its all-classic
  claim is now wrong for 95 of 104 files). This is the direct
  evidence for §4: maps are generated or they are wrong.
- **No decision records.** The *why* of the load-bearing choices — wishlist
  one-way door, id-keyed sync merges, WebP-only covers, bridge-publishing —
  lives in PR bodies, a workspace rulebook (`~/workspace/booktok-rulebook/`,
  outside the repo), and agent memory.
- **No runbook.** Deploy mechanics, the "live only after reading the deployed
  version string" rule, stale-cache doctrine, and the Supabase
  migration-apply/verify procedure exist only in `~/AGENTS.md` and the
  workspace supabase skill.
- **No entry path.** README is a feature catalogue; nothing routes a cold
  reader map → decisions → runbook. There is no `.github/` PR template.

---

## 3. Layer 1 — Code (comments & headers)

**Contains.** Two things only:

- **Prose header on every non-trivial file:** purpose in plain sentences,
  what the file owns, its public surface, inputs/outputs, and caller gotchas.
  `js/244-gift-postal.js`'s header (vendored data, pure functions, *nothing
  here makes a network call, and why*) is the model instance already in the
  tree.
- **Short local comments at the spot:** the invariant being held, the
  ordering constraint, the failure being prevented, the decision that shaped
  those lines. One or two lines. Where a local choice traces to a big
  decision, the comment is a pointer: `// See ADR-014`.

**Precision rule (unchanged from the standing standard).** Prose for intent,
precision for contracts: key formats, sentinel values, exact payload shapes,
and ordering requirements are stated exactly, never paraphrased. Agents
weight comments as ground truth — a stale why-comment is how a future reader
talks itself into breaking an invariant.

**Format & location.** In the files themselves. Headers are also the map
layer's data source (§4): the generator lifts each file's purpose line from
its header, so a missing header shows up as a hole in the map — the standard
enforces itself.

**Maintained by.** Whoever touches the file, in the same change (the standing
AGENTS.md rule). The post-migration successor phase (§8) brings existing
files up to standard — **headers + local whys only**. There is no full-tree
prose rewrite; a file's comments are rewritten when the file is next
substantively touched or in the successor phase's batches, whichever first.

**Must never become.** A changelog (version tags are never the comment — a
version reference may trail a real explanation where the history matters); a
restatement of the code; a home for the big *why* (that is Layer 2's job — if
a comment needs a paragraph of history, it needs an ADR and a pointer).

## 4. Layer 2 — Decisions (`docs/adr/`)

**Contains.** One short record per consequential decision: architecture and
data-model choices, rejected alternatives, incident-driven rules, product
boundaries. The record answers "why this way, not the obvious way" — the
question code comments cannot carry.

**Format.** `docs/adr/NNN-short-slug.md`, four sections, target ≤ 1 page:

```markdown
# ADR-014 — Sync merges are keyed by book id, never by title
Date: 2026-10-16 · Status: active (supersedes ADR-xxx / superseded by ADR-yyy)

## Context        — the situation and the forces in it
## Decision       — what was decided, stated exactly
## What we gave up — the rejected alternative and its cost, honestly
## Evidence       — links: PRs, tests, incident records, measurements
```

**Rules.** Records are **immutable once merged** — a correction, reversal, or
refinement is a *new* record that supersedes the old one; the old record's
Status line is the only edit ever made to it, and that edit lands in the same
PR as its successor. Code that implements a recorded decision carries the
one-line pointer (`// See ADR-014`). A PR that reverses a recorded decision
without a superseding ADR fails conformance (§9).

**Initial set — mined, not written from scratch** (~10–12 records). Sources:
`~/workspace/booktok-rulebook/RULEBOOK.md` (75 verified rules; the durable
decisions move in, the workspace copy becomes a pointer), `CONSTRAINTS.md`,
PR records and gate notes, the security reviews, and incident records.
Seed list:

1. Wishlist model: `status==='tbr' && owned==='tobuy'`; the old `wishlist`
   status is a one-way door (v559 + server parity migration).
2. Sync merges keyed by book id end to end, never by title (2026-10-16
   title-write diagnosis: the tree's only book assign is id-resolved).
3. Bridge-publishing interop for the ES-modules migration + the convergence
   rule (bridges delete as consumers convert); no build step.
4. Covers are WebP; image bytes never live in book records, IndexedDB, or
   sync payloads; covers are a cache concern only.
5. Offline is a resilience requirement, not a hosting ban: the core loop is
   local-first and fully offline; hosted services only where a capability
   requires them, degrading cleanly (2026-10-16 stack-policy decision).
6. user_state roaming: all user details sync between devices; only
   sync-engine internals, disposable caches, and navigation transients stay
   local; settings keys are frozen once shipped.
7. Gift a Book: circle-only, per-friend opt-in grant, field-scoped reveal,
   pgcrypto/Vault encryption (and why pgsodium was swapped out, v584).
8. Handles: findability is a separate opt-in, default off; lookup never
   returns a real name; released handles quarantine (v550/v551).
9. Swipe-down-to-dismiss on every sheet/modal via the shared helper.
10. Share cards carry favicon + wordmark only — no URLs/QR until a custom
    domain exists.
11. Migration discipline: pure moves, comments carried verbatim; the comment
    pass is a successor phase, never smeared into conversion diffs.
12. The test baseline itself: 6 named failures, movable only by named
    decision (points at CONSTRAINTS.md rather than duplicating it).

**Maintained by.** Whoever makes or reverses a decision, in the PR that does
it. Mining the seed set is a one-time program (§8).

**Must never become.** Meeting notes, a changelog, or a second copy of
CONSTRAINTS/GLOSSARY content — records *point at* the living documents and
explain the decision behind them; they never fork the facts.

## 5. Layer 3 — Map (generated module map)

**Contains.** For every top-level `js/*.js` file: purpose (lifted from its
header), public surface (exports, or window-published names via bridges),
consumers (which files import it / which tags load it), and load shape
(module vs classic). Plus a tree-level summary: counts and the phase-4 knot
list, generated — never typed by hand.

**Format & location.** `docs/module-map.md`, first line:
`<!-- GENERATED by scripts/module-map.mjs — do not edit; regenerate. -->`
The generator is `scripts/module-map.mjs` (Node, no dependencies): it derives
surfaces from named `export` statements and bridge blocks and consumers from a
cross-file name-reference census — the finished tree has no import graph
(bridge-publishing; zero first-party static imports) until the successor
phase's combined pass wires one (§9), after which it reads the import graph.
It reads `index.html`'s
tag list for load order/shape, and extracts purpose lines from file headers.
Classic stragglers (the 9 phase-4 knot files, until their own proposal lands)
are listed as `classic — see header`, with surface taken from the census
(classic files carry no bridge declarations).

**Workflow.** The generator runs (a) in any PR that adds, removes, renames,
or re-surfaces a js file — the regenerated map rides in that PR; (b) at the
end of the migration program, to produce the first complete edition. A test
(`.test/module-map.test.js`) regenerates the map in-memory and fails on any
diff with the committed copy — staleness becomes a red suite, not a
discovery someone makes in six months. `js/README.md` keeps its conventions
section; its hand table is replaced by a pointer to the generated map.

### 5.1 A cold reader's first 10 minutes (the design target)

- **0–2 min:** README's Start Here (§7) — what the app is, how to run it.
- **2–5 min:** the module map — find the file that owns the thing you care
  about, see its surface and who consumes it.
- **5–8 min:** that file's header — purpose, ownership, gotchas — and its
  `See ADR-NNN` pointers for the choices that look odd.
- **8–10 min:** the pinning test suite named in the header or the map —
  the behaviour, stated executable.

**Must never become.** Hand-edited (one hand edit and it is js/README.md
again); a prose document (judgment lives in headers and ADRs — the map
carries only mechanical facts plus the lifted purpose line); or a second
census that disagrees with the tree (the freshness test exists precisely to
make disagreement impossible).

## 6. Layer 4 — Behaviour (tests as documentation)

**Contains.** The suite itself, read as the executable statement of what the
app must do — plus the small amount of framing a reader needs to use it that
way.

**Format & location.** `.test/*.test.js`, one suite per behaviour area,
named for the behaviour (`title-write-keying`, `gift-a-book`,
`user-state`). The framing lives in `CONSTRAINTS.md` (already in-repo):
suites run standalone with `node .test/<name>.test.js`; **COZYLIBRAM_DIR must
point at the checkout under test** (suites default ROOT to the main checkout
— running them from a worktree without it tests the wrong tree); runs are
judged serially, against the **baseline of exactly 6 named pre-existing
failures**; a run is green when it shows those 6 and nothing new.

**The rule.** A behaviour worth explaining in prose is worth pinning in a
test where feasible. The title-write incident is the pattern: a frightening
prose claim was settled by an automated case (3 same-title records, edit
through the real path, assert only the edited record changes in memory,
store, and push payload), and the case — not the incident write-up — is what
stays in the repo as `.test/title-write-keying.test.js`. The idb-storage
suite is the companion lesson: its harness binding pointed by absolute path
at a stale checkout, so it passed for its whole life while not testing what
it claimed — a suite's binding is part of its claim (diagnosed during the
ES-modules migration; fixed as PR #284).

**Maintained by.** Builders, per the TDD discipline already in force; the
baseline moves only by named decision in CONSTRAINTS.md itself.

**Must never become.** Weakened, skipped, or re-baselined to make a run green
(CONSTRAINTS rule 4); or documentation theatre — tests written to describe
rather than to fail when the behaviour breaks.

## 7. Layer 5 — Operations (`docs/runbook.md`)

**Contains.** How the running system is operated and fixed. Today almost all
of this lives in `~/AGENTS.md` and agent memory — it is the largest single
gap against the charter. One file, sectioned:

1. **Deploys.** Cloudflare Pages auto-deploys every push to `main`
   (`cozylibram.pages.dev`). There are no release zips. A change is "live"
   **only after the deployed version string is read back from the production
   URL** (`js/181-appversion.js` as served) — a merged PR is not a live app.
   Branch previews exist per branch (e.g. the ES-modules fork preview).
2. **Version discipline.** `APP_VERSION` (`js/181-appversion.js`) and the
   `CACHE` name in `sw.js` bump together, to the same version, in the same
   change; the pairing is test-pinned. Version numbers allocate from
   `origin/main`'s current version + 1 at a branch's pre-PR rebase. New JS
   files need all three touchpoints: the file, an `index.html` tag, and the
   `sw.js` precache list.
3. **Stale-cache doctrine** (the default suspect for any device-only
   failure): a Settings version reading does **not** guarantee fresh assets.
   Recovery is: close **all** tabs for the origin, open fresh, hard-reload.
   Service worker does `skipWaiting()` + `clients.claim()`; an already-open
   session keeps its loaded JS until a fresh launch.
4. **When a user reports "it does nothing":** check the server-side gate
   with `curl` before reading client code (the cover-proxy lesson); check
   the deployed version before debugging the reported behaviour.
5. **Database (Supabase).** Project ref and dashboard pointers (no secrets —
   §7.6). Migrations live in `supabase/migrations/`, apply **after** the PR
   merges, then are verified by spot-checks. Finding-grade database claims
   require the marker discipline: one atomic statement reconciling known
   production counts before trusting any result (the verification preamble —
   the procedure is written out here in full; today it exists only in a
   workspace skill). RLS-faithful spot-check recipe (temp table, `set local
   role authenticated`, JWT claims, rollback) written out in full.
6. **Secrets.** Never in the repo, never in docs, never in screenshots.
   Where each credential *lives* is stated (server-side env vars on
   Cloudflare; `server-config.json` locally, gitignored; Supabase keys via
   the stored-credential path) — locations, never values. A token pasted
   anywhere public is revoked and replaced (README already says this; the
   runbook keeps the pointer).
7. **Incidents.** Where postmortems live (`docs/incidents/`), the blameless
   format, and the standing rule: an incident that changes a rule produces
   an ADR (Layer 2) and, where feasible, a pinning test (Layer 4) — the
   write-up alone is not the fix. Seed entries: the depollute incident
   (v568), the title-write misdiagnosis (2026-10-16).

**Maintained by.** Whoever changes an operational procedure, in the same PR
that changes it — a procedure that changed without its runbook section is an
incomplete change.

**Must never become.** A duplicate of CONSTRAINTS.md (point, don't copy); a
home for credential values; or a diary — procedures and pointers, dated when
a fact is time-sensitive ("verified on" stamps, as the README's API-key
section already models).

## 8. Layer 6 — Entry (README as front door)

**Contains.** What the app is (the existing overview, kept — it is good),
how to run and test it locally, and a **Start Here** block near the top that
routes the cold reader in order:

1. **Map** — `docs/module-map.md`: what every part is and how it connects.
2. **Decisions** — `docs/adr/`: why it is built this way.
3. **Runbook** — `docs/runbook.md`: how to operate and fix it.
4. Plus standing pointers: `CONSTRAINTS.md` before changing anything,
   `GLOSSARY.md` for the naming language, `docs/es-modules-migration-plan.md`
   while the migration runs.

**Fixes that ride the entry PR.** The stale Tech-notes bullet (73 scripts /
js/224 → the real shape, stated without a hardcoded file count — "104
numbered modules, see the module map"); the theme count; the suite count.
The durable fix is the discipline, not the numbers: **README never hardcodes
a count that a generated or constraint document owns** — it points at the
map for file counts, at CONSTRAINTS.md for the baseline, and says "23
themes" only where a count cannot drift silently (or drops the number).

**Must never become.** A second spec, a changelog, or a marketing page. It
routes; it does not duplicate what it routes to.

---

## 9. Sequencing & rough cost

The migration's phases 1–3 are complete (v607) and the User's HOLD on
parallel starts is discharged; all steps are unblocked. In this order:

| Step | Work | Gate | Cost |
|---|---|---|---|
| 1 | **Entry PR** — README Start Here + stale-number fixes | none (docs only) | 1 PR |
| 2 | **Runbook PR** — `docs/runbook.md` written from AGENTS.md + skills, reviewed against reality | none | 1–2 PRs |
| 3 | **ADR mining** — seed set (§4, ~12 records) in 2 batches; rulebook cross-checked so nothing durable is left workspace-only | none | 2–3 PRs |
| 4 | **Successor phase** — headers + local whys over the finished modular tree, batched by migration phase; replaces plan §13's rewrite framing | migration phases 1–3 complete | ~4–6 PRs |
| 5 | **Map generator** — `scripts/module-map.mjs` + freshness suite + first generated map; js/README table retires | migration phases 1–3 complete (needs the real import graph) | 1–2 PRs |
| 6 | **Conformance plumbing** — PR template + docs-sweep audit line (§10) | none | 1 PR |

Under the User's HOLD, nothing started during the migration. Steps 4–5 are
the migration's successor phase, as the User already sequenced the comment
work — and per the User's 2026-10-17 sequencing addendum, step 4's per-file
pass also carries import-wiring (bridge burn-down), so the map (step 5) is
generated after it against a real import graph; see the Reviewer seat's
re-grounding note §7 for the combined shape and its four constraints. Total programme: ~9–13 small PRs,
all docs/tooling except step 4's comment edits.

## 10. Conformance (light-touch, by design)

- **PR template** (`.github/pull_request_template.md` — the repo has none
  today): three checkboxes added to the existing five-part body discipline —
  *headers/comments touched files comply with Layer 1* · *decision made or
  reversed → ADR added/superseded and linked* · *js files added/removed/
  re-surfaced → module map regenerated*. Unchecked-but-inapplicable is
  stated, not silently skipped.
- **Advisor gate** already reviews every PR; the gate checklist gains one
  line: legibility conformance as declared, spot-checked against the diff.
- **Monthly docs sweep** (existing scheduled review) gains a legibility
  audit: sample 5 files for header quality, verify no ADR has been edited
  post-merge, verify the map freshness suite is green, grep README for
  hardcoded counts. Findings file as docs issues, not gate blocks.
- **No new standing process beyond this.** If conformance needs more than a
  checklist + a monthly sample to hold, the standard is too heavy and should
  be simplified, not enforced harder.

## 11. Questions for the User — RULED 2026-10-17

1. **ADR granularity:** one record per decision (the seed list's shape —
   precise, more files) or one record per topic area (sync, covers, social
   — fewer, longer files)? The spec assumes per-decision.
   **RULED: per-decision** — one decision per record; superseded records are never edited.
2. **The map's home:** `docs/module-map.md` replacing the `js/README.md`
   table (spec's assumption), or generated *into* `js/README.md` so the map
   sits beside the code it describes?
   **RULED: docs/module-map.md** — js/README.md keeps its hand-written notes behind a pointer to the map.
3. **Runbook scope:** app operations only, or should the agent-team
   operating protocol (branch naming, merge model, gate flow) also move
   in-repo, e.g. as `CONTRIBUTING.md` — currently it lives only in a
   workspace skill, which the charter's "anyone" test arguably fails too?
   **RULED: BOTH** — docs/runbook.md for app operations AND CONTRIBUTING.md carrying the agent-team protocol as the canonical in-repo copy (the workspace skill reduces to a pointer when the CONTRIBUTING PR lands).
4. **Incidents:** postmortems in-repo under `docs/incidents/` (spec's
   assumption — the depollute and title-write records currently live outside
   the repo), or summaries in-repo with full records kept in the workspace?
   **RULED: summaries in-repo** under docs/incidents/; full postmortems stay in the workspace.
