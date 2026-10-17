# ES Modules Migration Plan — Cozy Libram

**Status update (2026-10-16):** Approved by Decision 2026-10-16; fork gate (offline-reload device check) PASS; production series commissioned — this plan now lands on main as the program's record.

**Status:** PLAN ONLY. Written on `fork/es-modules`, refreshed onto
`origin/main` @ `b849e68` (APP_VERSION v592) on 2026-10-16. The v551 pilot
state is preserved under the tag **`fork-pilot-v551`** (pilot conversion of
js/213-dnf.js + its FORK.md record) and is reference, not substrate.
**This fork carries no production version claims:** no APP_VERSION, sw
CACHE, or version-pin changes anywhere in this program's fork work. A
conversion that ever lands on main ships under the normal version-pair rule
like any other change.
**Ground rules (User decision, 2026-10-16):** fork-first — nothing lands on
production main until the fork proves the approach and the User rules on
this plan plus first-slice evidence. Native ES modules only, **no build
step**: if any part of this plan turns out to require a bundler, that part
stops and goes back to the User as a separate proposal (§8).

---

## 0. Executive summary

The tree is far more convertible than its reputation suggests. A full AST
census of all 104 `js/` files (2,125 public names, 745 cross-file reference
edges) finds **only 5 edges where one file reads another file's globals at
eval time** — and all 5 land in the boot/storage/sync knot that every
ordering puts last anyway. Cross-file *writes* to another file's lexical
bindings — the one pattern a bridge conversion cannot carry — concentrate
in exactly **7 files** (js/000-core ×63 writes, js/040 ×8, js/163 ×7,
js/199 ×3, js/140 ×3, js/205 ×2, js/217 ×2). Everyone else is write-clean.

The migration therefore runs as a **bridge-everything first pass**: each
converted file becomes a real ES module that publishes its existing public
surface on `window` through a small explicit bridge block, while its ~100
classic consumers — and the test harness — keep working unchanged. No
first-party module imports another first-party module during this pass
(§3); real import wiring is a separate, later phase with its own harness
gate (§9.4). 41 files are convertible in phase 1 under this rule, 37 more
in phase 2, the shared machinery in phase 3, and the knot — gated on the
five forced decisions and on the Data & Sync seat's seam work — last.

Production already proves the runtime half of this: the app ships an
importmap (`three` → vendored module) and two classic scripts dynamically
`import()` vendored ES modules in production today (js/207, js/215, plus
the ZXing reader in js/130), all served through the same service worker.

---

## 1. The census (method and headline numbers)

Method: every `js/*.js` file parsed with a real JS parser (acorn,
`sourceType: script`); top-level declarations plus `window.NAME =`
publications at any depth were collected as each file's **public surface**;
every identifier reference to another file's public name was classified
**eval-time** (not inside any function body) or **runtime** (inside a
function), and assignments to another file's bare bindings were collected
as **write edges**. Locally shadowed names were suppressed; string-only
references (e.g. names inside generated HTML handler attributes) resolve
through `window` at runtime by construction and are covered by the bridge
rule, not counted as edges. All eval-time edges and the first-slice
candidates' edges were then hand-verified against the source (sites in
§5.1 and Appendix A). The census is re-runnable; each conversion step
re-runs it and prints the converted file's edge list in its PR — that list
*is* the file's implicit import list during the transition.

Headline numbers (v592, `b849e68`):

| Measure | Value |
|---|---|
| js files / script tags in index.html | 104 / 104 (+ config.js, 1 importmap, 2 inline) |
| Public names (top-level declarations + window publications) | 2,125 |
| Cross-file reference edges | 745 |
| Edges carrying any eval-time read | **5** (all into js/040, js/010, js/090) |
| Files receiving cross-file lexical writes | **7** (listed in §0) |
| Duplicate public names across files | 1 (`window.THREE`, published by both js/207 and js/215 as a shared cache slot) |
| Files with ≤2 consumers and no eval/write blockers | **41** (phase 1 pool) |

### 1.1 The tree has three file shapes

1. **Classic top-level** (the majority): top-level `function`/`const`/`let`
   declarations are the public surface; they become globals.
2. **Strict IIFE + window publishing** (js/215, 222–227, 238, 241, and kin):
   the file is already module-shaped by hand — internals private by
   construction, public surface published as `window.NAME = …`. These are
   the cheapest conversions in the tree (§4, recipe variant B).
3. **Namespace publishers** (js/151 `window.ModalFlairs`, js/216
   `window.Shelf3DTheme`, js/218 `window.Shelf3DDecor`): a single
   window-published namespace object from top level.

The tree has been drifting toward the bridge direction on its own: every
file written in the recent waves chose shape 2 or 3.

### 1.2 The convertibility rule

Under the bridge pattern (§3), a file F may convert when **all** hold:

- **C1 — no eval-time inbound:** no classic file reads F's names at eval
  time (a deferred module runs after all classic scripts, so an eval-time
  classic read of F would see `undefined`).
- **C2 — no inbound lexical writes:** no still-classic file assigns to F's
  lexical (non-`window`) bindings. After conversion those bindings are
  module-private; a classic writer's bare assignment would silently land
  on a fresh global-object property while the module reads its own copy —
  the one silent-divergence failure this program refuses to ship.
  (Writes to F's `window.*` publications are property writes and are
  identical in both worlds.)
- **C3 — F's own eval-time reads are safe:** F's eval-time reads target
  only files that remain classic at F's conversion step (already executed
  by the time any module runs), or are re-sequenced away. Only js/041,
  js/200, and js/208 have any eval-time outbound reads at all.
- **C4 — strict-safe:** F carries no sloppy-mode idioms a module would
  reject (undeclared assignments, top-level `this`, octal literals,
  duplicate parameter names). Verified per file in the recipe (§4, step 2).

Outbound *runtime* reads and writes are never blockers: modules share the
global lexical environment with classic scripts, so a module's free-variable
reads/writes of classic-owned globals resolve exactly as they do today
(the pilot proved this pattern; §3).

---

## 2. (a) Dependency order

Phases are ordered by blast radius, not by hard dependency — the bridge
makes most files independently convertible, so the order exists to prove
the pattern cheaply before it is trusted widely.

| Phase | Scope | Files | Gate |
|---|---|---|---|
| **1 — leaves** | Phase-1 pool: ≤2 consumers, C1–C4 clean | 41 | this plan + slice evidence |
| **2 — features & clusters** | 3–8 consumers; the admin, shelf-3D, and edition clusters as units | 37 | phase 1 evidence accepted |
| **3 — shared machinery** | >8 consumers: js/002, 020, 050, 055, 061, 065, 070, 100, 105, 120, 136, 150, 152, 170, 195, 205, 230 (17 of the 23 high-consumer files; the other 6 are phase 4) | 17 | pattern proven on ~78 files |
| **4 — the knot + boot** | js/000, 040, 041, 090, 095, 229, 200, 010, 208 | 9 | five forced decisions ruled (§2.3) **and** candidate-8 boundary (§10) |

(Totals: 41 + 37 + 17 + 9 = 104.)

### 2.1 Phase 1 (41 files)

- **1a — pure leaves, zero outbound references** (their exports depend on
  no globals at all): js/182-tileguard, js/203-editionvision,
  js/204-shelf3d-layout, js/209-editionquality, js/211-yolo,
  js/216-shelf3d-theme, js/218-shelf3d-decor, js/244-gift-postal.
- **1b — shape-2 IIFEs**: js/215-shelf3d*, js/222-community-corpus,
  js/223-community-corpus-ui, js/224-curation-queue, js/226-dna-survey,
  js/227-reading-nudges, js/238-book-candle, js/241-book-ambience.
  (*js/215 also co-publishes the `window.THREE` slot with js/207; the pair
  is a named mini-decision in phase 2 — the slot is a shared cache for the
  loaded library, and both files keep publishing it until js/207 converts.)
- **1c — guarded classic leaves**: js/096-onboarding, js/133-bookmory,
  js/137-shelf, js/151-modal-flairs, js/164-spinelab, js/165-editionassets,
  js/166-logs, js/190-wishlist, js/210-editionmeasure, js/213-dnf,
  js/214-wrapped, js/221-trigger-check, js/231-reactions, js/234-outbox,
  js/235-reading-it-too, js/236-sticker-picker, and the remaining
  ≤2-consumer C-clean files per the census (full list in Appendix A).
- **Held out of phase 1 despite low consumer counts:** js/163-analytics
  (7 inbound lexical writes from js/199/js/095 — converts with the admin
  cluster) and js/217-shelf3d-view (2 inbound writes from js/205 —
  converts with the shelf cluster).

### 2.2 Phase 2 clusters (convert as units)

- **Admin cluster** — js/161-tropelab, js/162-charlab, js/163-analytics,
  js/164–166 (phase 1c may take 164–166 early; they are write-clean),
  js/199-admin last within the cluster, js/224-curation-queue (1b).
  Internal coupling is real: js/199 writes js/163's caches at runtime and
  js/095 writes both files' state — js/095's admin write sites are
  re-expressed (or js/095 joins the cluster step) when the cluster
  converts. The cluster's internal references become the first candidate
  for real imports in the import-wiring phase (§9.4).
- **Shelf-3D cluster** — js/204 (1a), js/216/js/218 (1a), then js/215,
  js/217 (with js/205's `_shelf3dWebGLFailed`/`shelfGroup` write pair
  re-expressed), js/207 last (owns the `three` dynamic import and the
  shared `window.THREE` slot with js/215).
- **Edition cluster** — js/203/js/209 (1a), js/210 (1c), js/206, then
  **js/208 only in phase 4's slipstream**: js/208 wraps js/040's
  `setLocalUserIdb` at eval time (js/208:337–347) — that wrap must be
  re-homed into a seam-provided hook as part of knot work, never carried
  across a conversion.
- Everything else with 3–8 consumers (37 files total in phase, including
  the cluster members above): feature files in ascending consumer order.

### 2.3 Phase 4 — the knot, and the five forced decisions (updated numbers)

The pilot's five forced decisions stand; the census hardens three of
them:

1. **The `library` binding** (js/040-owned): cross-file assignment sites
   at v592 are js/090 (library, tombstones, tombstoneFloor) and js/180
   (library), plus js/040's own internal reassignments and js/041's
   eval-time `storageReady = storageInit()` assignment. Options unchanged
   (state module with get/set / never-reassign in-place mutation / window
   singleton). **This decision belongs to the Data & Sync seat's seam
   design (§10)** — the migration adopts whatever the seams settle.
2. **The 020⇄040⇄041 cycle** around migrateBook/trackBook and the v194
   choke point: stands, knot-phase design input (documented in
   js/README.md; Batch-3 candidate 11's cycle note).
3. **The 090⇄095 auth/gate cycle plus typeof-guarded optional hooks**
   (js/090 into js/229/219/195 and others): each hook adjudicated
   import-vs-callback-vs-event during knot design.
4. **js/000's shared UI state** — now census-hardened: **63 inbound
   lexical writes from 10 files** (view, sortBy, filter, query,
   searchQuery/searchResults, editingId/editingDraft, animateIn,
   heatSel/calM/calY, addTab, rouletteTimer, …). js/000 is the true core
   seam: it converts only with a ruled state shape (uiState object /
   setter module / relocation to owner modules).
5. **Boot sequencing** — the 5 eval-time edges (§5.1) are this decision's
   entire evidence base: js/041's storage kick, js/208's wrap, and
   js/200's orchestration become explicit `init()` calls from one module
   entry point in the end state (§5.3).

---

## 3. (b) Interop: ONE direction — modules publish to `window`; classics consume unchanged

**Decision: bridge-publishing.** A converted file becomes a real ES module,
exports its public surface with named `export`s, and ends with a small
explicit **bridge block** that assigns exactly its pre-conversion public
surface onto `window`. Classic files keep consuming bare names (resolved
through the global object / global lexical environment) with **zero
consumer edits**. A converted file keeps reading classic-owned globals as
free variables — sound because module scripts are deferred: by the time
any module evaluates, every classic script has already run.

**Convergence rule:** when a classic consumer of a bridged name converts,
it switches that read to a real `import` (allowed only in the
import-wiring phase, §9.4 — during the bridge-everything pass consumers
convert without changing how they read dependencies). A bridge assignment
is deleted when its last classic consumer is gone. The end state is pure
ESM with no bridges; every intermediate state is a working app.

Why this direction and not the reverse (modules importing a globals
bridge module):

1. **The census says the consumer side is the safe side to freeze.** 745
   edges, 740 of them runtime-only. Bridge-publishing touches exactly one
   file per step (the converted one); the reverse direction would make
   every converted module declare its global reads through an artificial
   bridge module *and still* couldn't serve classic consumers — a classic
   file cannot `import` at all, so module exports would have to be
   published on `window` anyway. The reverse direction contains this
   direction as a subset and adds a layer.
2. **The pilot proved it in production-shaped conditions** (js/213 at
   v551: real-browser verification by the UX Tester; the export surface,
   the bridge republishing identical objects, and both read and write
   paths exercised — record at tag `fork-pilot-v551`).
3. **The tree already chose it.** Every recent feature file (shape 2/3,
   §1.1) publishes on `window` by hand. The migration formalizes the
   idiom the codebase is already writing.
4. **Production already runs the runtime prerequisites:** an importmap
   and dynamic `import()` of vendored modules (three, ZXing) execute
   under the same service worker today.

The honest cost, stated: during the transition a module's classic-global
reads are *implicit* dependencies — no import list in the file header.
Mitigation is procedural and already budgeted: the census re-runs per
conversion, and the converted file's outbound edge list is printed in its
PR, serving as the recorded dependency list until the import-wiring phase
makes it syntactic.

---

## 4. The per-file conversion recipe (pilot recipe, updated)

For one file at a time; each conversion is independently shippable and
reversible (flip the tag back, drop the exports/bridge).

1. **Qualify** against C1–C4 (§1.2) with a fresh census run; print the
   file's inbound/outbound edge lists and its public surface.
2. **Strict audit:** grep + read for sloppy idioms (assignments to
   undeclared names, top-level `this`, octal literals, `with`,
   arguments-caller tricks). Fix nothing behaviourally; a file that needs
   a behaviour change to become strict-safe is reclassified, not forced.
3. **Export in place:** add `export` to the declarations that are the
   file's public surface. Named exports only — **no `export default`**
   (keeps the harness classicize transform trivially sound, §9.2). No
   restructuring, no renames, no behaviour change in the same step.
4. **Shape-2 variant:** drop the IIFE wrapper (the module scope replaces
   it); the file's existing `window.NAME = …` publications become the
   bridge (step 5) verbatim.
5. **Append the bridge:** one block at the end assigning exactly the
   pre-conversion public surface to `window` — the same names, the same
   objects. A name leaves the bridge only when its last classic consumer
   converts (§3 convergence rule).
6. **Keep dependencies as global reads** (bridge-everything pass): no
   `import` of first-party files. Dynamic `import()` of vendored modules
   (three/ZXing pattern) is untouched where it already exists.
7. **Flip the script tag, same position:**
   `<script type="module" src="js/NNN-name.js"></script>` in index.html.
   No renumbering, no list edits.
8. **Leave sw.js untouched.** Precaching is URL-based (§6).
9. **No version claims on the fork.** Landing on main (post-approval):
   the normal APP_VERSION + sw CACHE pair bump in the same change.
10. **Verify:** Node's ESM loader imports the converted file directly
    (export surface == census public surface; bridge republishes the
    identical objects); the harness evidence in §9.5; census re-run shows
    no edge changed kind. A conversion is a pure move — nothing changes
    but the wiring (exports added, bridge appended, tag flipped) — so
    correctness is carried by that identity evidence, backed by the
    full-suite baseline discipline (§9.5).

**Comments are carried verbatim.** A conversion touches no comment —
not even a mechanical or stale one. During migration PRs, a stale or
mechanical comment in a converted file is carried, not fixed, and is
**not a finding** at any gate. Comment cleanup is a separate, later
program (§13) that runs over the finished modular tree; it never rides
inside a conversion.

---

## 5. (c) index.html loading shape

### 5.1 What relies on parse-time execution order today — the complete list

Classic scripts execute in tag order during parsing; modules are deferred
to after parsing. The census found exactly **5 cross-file eval-time read
edges** in the whole tree (hand-verified):

| # | Site | Reads (owner) | Nature |
|---|---|---|---|
| E1 | js/041-idb.js:195 | `idbDisabled`, `storageReady`, `storageInit` (js/040) | the storage kick: `if (!idbDisabled) storageReady = storageInit();` — a comment at the site states it must run synchronously right after js/040; also an eval-time cross-file *assignment* |
| E2 | js/200-boot.js:32 | `applyTheme` (js/010) | top-level call in the boot orchestrator |
| E3 | js/200-boot.js:70–76 | `idbDisabled`, `storageReady` (js/040); `initCloud` (js/090) at :72 | the boot branch: storage-ready → `boot(); initCloud()` |
| E4 | js/208-editionassets.js:329–331 | `storageReady` (js/040) | top-level `storageReady.then(...)` migration hook |
| E5 | js/208-editionassets.js:337–347 | `setLocalUserIdb` (js/040) | top-level monkey-patch wrap of the slot-switch function (eval-time cross-file assignment) |

Every one of these involves a phase-4 file as reader or owner. **No
phase 1–3 conversion touches either side of any eval edge** — that is a
checked property of the phase assignment, not a hope. Handling, when the
knot phase arrives: E1/E3/E5 are re-expressed as explicit init calls from
the entry point (forced decision 5); E4 becomes a registered hook on the
storage seam; E2 is a plain import by then.

All other top-level side effects in the tree are order-insensitive
classes: `document`/`window` event-listener registrations (js/050, 105,
159, 160, 229 — listeners fire after parsing regardless of which deferred
moment registered them), IIFE self-executions whose bodies read globals
only at runtime, and files calling *their own* functions at top level
(js/105's `renderTopbar()`, js/120's cache load, js/134's load) — a
converting file's own top-level still runs after all classic scripts, so
its eval-time entry into its own functions reads a fully-initialized
classic environment.

Two things in index.html are **not** app js files and stay classic
forever: the pre-paint theme inline script (line 17 — it must run before
first paint; no module can ever do this job; it is a self-contained
localStorage mirror of js/010's theme keys, pinned by boot-theme.test.js)
and the service-worker-gate inline script (line 199 —
`window.cozyInNativeShell`, self-contained). `config.js` (server-generated
globals script) likewise stays a classic tag; modules read its globals as
free variables like everyone else.

### 5.2 Transition-state shape

index.html keeps its one-tag-per-file list in today's order. A converted
file's tag gains `type="module"` in place. Tag position becomes
documentation, not sequencing, for modules: a module executes after every
classic script regardless of where its tag sits, and (bridge-everything
pass) modules never import each other, so no inter-module ordering exists
to express. This is the transition's quiet superpower: **the tag list
never needs reordering during phases 1–3**, so index.html diffs stay
one-line-per-conversion.

### 5.3 End-state shape

After phase 4, index.html carries: the two inline classic scripts
(pre-paint theme, SW gate), `config.js`, the importmap (today: `three`
only — first-party code imports by relative path, so **no importmap
additions are needed for first-party modules**), and a small number of
module entry tags whose import graphs pull the converted tree in
dependency order. js/200-boot's orchestration becomes the main entry's
explicit `init()` sequence (forced decision 5). Whether any classic tags
remain at the end is a phase-4 design question; nothing in phases 1–3
prejudges it.

---

## 6. (d) Service worker

sw.js precaches an explicit filename array (`const JS = [...]` in sw.js,
`.map(f => './js/' + f)`) plus VENDOR/AVATARS/FONTS/THEME_ART lists, and
serves same-origin requests cache-first (`caches.match` else fetch).

**What changes under migration: nothing structural.** A converted module
is the same file at the same URL; the tag type is a property of the
requesting document, not of the cache entry (pilot recipe step 6, proven
at v551). The JS array, the CACHE name discipline, and the install/
activate flow are untouched by every conversion in phases 1–3.

**What becomes more load-bearing:** the set-equality discipline
(disk = index.html tags = sw.js JS array). Today, a classic file missing
from the precache degrades one feature offline. In the import-wiring
phase (§9.4), a module's static `import` of a non-precached file fails
the *entire module graph* offline — a hard, total failure, not a degraded
feature. The pin suites already enforce set equality (§9.3, R1 makes
their net *wider*, never narrower); during the import-wiring phase each
cluster conversion re-runs them as a named checklist item.

**Fork-preview wrinkle (fork-only, decided in slice 1):** conversions
don't change sw.js, and the fork carries no version bumps — so on the
fork preview origin a returning tester's service worker keeps serving the
*previous* cached bytes (cache-first fetch handler; the CACHE name never
changes). First-visit and fresh-profile passes are unaffected; repeat
passes on one profile can silently test stale code. Two handlings:
(i) slice evidence uses fresh profiles / cache-disabled passes only, or
(ii) the fork — and only the fork — suffixes its CACHE name once
(`cozy-libram-v592-fork`), forcing one clean re-precache for fork
testers; the suffix is fork hygiene, not a version claim, and never
lands on main (production conversions bump the real pair per §4 step 9).
The slice task picks one with the UX Tester; this plan recommends (ii)
because repeat Tester passes on a standing profile are the norm.
Production origins are unaffected either way: caches are origin-scoped,
so the fork preview (`fork-es-modules.cozylibram.pages.dev`) can never
contaminate production's cache, nor vice versa.

---

## 7. Reserved

(This section intentionally omitted — numbering follows the work order:
§8 is (e), §9 is (f), §10 is (g), §11 is (h), §12 is (i).)

## 8. (e) No build step — and the bundler question, settled by the census

Native ESM only. No part of the current tree needs a bundler, and the
census is the evidence: every cross-file dependency in the app is
name-level (global reads / window publications), which native modules +
the bridge express directly; the app's syntax already parses as modern
ES2022+ in every browser the app targets (optional chaining, classes,
async/await ship untranspiled today); the two vendored modules already
load natively (importmap + dynamic import). There is no TypeScript, no
JSX, no asset pipeline to reproduce.

**Escalation clause:** if a later phase's design concludes a bundler is
required for some part (e.g. a future wish to *reduce* request count by
concatenation, or a package that ships only transpiled sources), that
part stops. A bundler is a separate proposal to the User, not a plan
assumption, and nothing in phases 1–3 depends on one.

---

## 9. (f) The test harness — the migration's #1 risk

### 9.1 How the suites load code today (classified, all 205 suites)

| Class | Count | Mechanism | Examples |
|---|---|---|---|
| **loadApp** | 174 | `.test/harness.js` reads *every* `js/*.js` from disk (directory order) and injects each as a **classic script element** into a jsdom window | most behavioural suites |
| **vm-loader** | 16 | the suite builds a `vm` context with hand-picked stubs and evaluates a *named subset* of files with `vm.runInContext` | auto-publish, book-candle, book-dressing, book-portrait, gift-a-book, boot-theme, works, the trope-* family |
| **source-scanner** (primary) | 11 | no execution; assertions over source text (app files, index.html, sw.js, styles.css, assets) | community-corpus, modal-flairs, css, svg-safety, themed-art, yolo, zxing-decode |
| **standalone** | 4 | neither — pure logic/data or server-side surfaces | pages-functions, premium-packs, readcover-provider, enhance-face |

Orthogonally: **175 suites read index.html as text**, **25 read sw.js**,
**19 read styles.css**, and most loadApp suites *also* scan sources for
individual assertions — the classes overlap per-assertion, not per-file.
Two environmental facts matter for fork evidence: **134 suites hardcode
the main-checkout path** (`/home/hatch/workspace/booktok/...`) for at
least some reads, and only 42 are fully `BOOKTOK_DIR`-aware (harness.js
itself honours `BOOKTOK_DIR` — CONSTRAINTS rule 1). Consequences in §9.6.

### 9.2 The loadApp class (174) — the classicize transform, and its soundness boundary

jsdom cannot execute module scripts at all: a converted file injected as
classic script text is a `SyntaxError` at injection, its names never
land, and the suite fails on missing globals. The pilot's answer, which
this plan re-adopts as the harness shape for the whole bridge-everything
pass, is a **classicize transform in `.test/harness.js`** (fork-side
first; it lands on main only as part of an approved production PR):

- For each file the harness loads, if the source contains top-level
  `import`/`export` syntax, strip the module markers (`export` keywords
  on declarations; `export { … }` lists) and inject the identical body
  as a classic script. The file's own bridge block then publishes its
  surface on the jsdom window exactly as in production.
- **Soundness boundary, stated as a rule:** this transform is faithful
  *only because bridge-everything modules carry no static imports* —
  the stripped body plus its bridge reproduces the production surface
  exactly. The transform must **fail loudly** (throw, naming the file)
  if it ever meets a first-party static `import`, rather than silently
  stripping it. That failure is the tripwire that forces §9.4's real
  loader to exist before any import wiring begins.
- Named exports only (§4 step 3) keeps the transform a two-regex job
  with no semantic choices to make.

Under this shape, a phase 1–3 conversion changes **nothing** in any
loadApp suite: same names on the window, same order (directory order is
preserved by the harness), same assertions. The failing-baseline
signature (§9.5) must be byte-identical in kind.

### 9.3 Scanner assertions — the three repoint classes (named now, per CONSTRAINTS rule 4)

Scanners mostly don't care about module syntax — but three assertion
shapes do. Each is a named repoint class: **assertions identical, net
never narrower, disclosed in the conversion PR that triggers it**, ruled
under CONSTRAINTS rule 4 at that PR's gate. Naming them here means no
conversion PR ever "discovers" a test change mid-flight.

- **R1 — tag-shape enumeration.** `.test/appversion.test.js` enumerates
  classic tags with `/<script src="js\/([^"]+\.js)"><\/script>/g` and
  asserts every enumerated script is precached (and, in reverse, that
  every precached script exists on disk). A flipped tag
  (`<script type="module" src=…>`) does not match the classic pattern —
  the assertion would keep passing while its coverage silently shrank.
  **Repoint:** when the first tag flips, the enumeration extends to both
  tag forms; the assertion text and intent ("all index.html scripts are
  precached in sw.js") are unchanged and coverage strictly grows. Any
  other suite found enumerating tag shape joins R1 at its conversion.
- **R2 — declaration-pattern scanners.** Suites that locate code by
  anchored declaration patterns (`^function NAME`, `const NAME =` at line
  start) miss declarations that gain an `export ` prefix. **Repoint:**
  the pattern tolerates an optional `export ` prefix; the located code
  and the assertion are identical. (Unanchored substring scans — the
  majority — are unaffected and need nothing.)
- **R3 — vm-loader suites whose target file converts.** The 16 vm suites
  evaluate named files as classic scripts in a `vm` context; a converted
  target file needs the same classicize transform at the suite's load
  site. **Repoint:** the suite requires the harness's exported
  `classicize()` helper and applies it to the converted file's source
  before evaluation — loading plumbing only; assertions untouched. This
  is per-file and happens only when one of the suite's own files
  converts (slice 1 triggers it twice: book-candle.test.js for js/238,
  gift-a-book.test.js for js/244).

### 9.4 The deferred problem: real imports need a real loader

Bridge-everything deliberately defers the only hard harness problem.
When the import-wiring phase begins (post-migration cleanup: bridged
reads become `import`s, cluster by cluster), classicize is unsound by
construction and retires. The replacement, to be built and gated as its
own step *before* the first import lands: load modules with Node's
`vm.SourceTextModule` (the suites already run under Node; the flag is
`--experimental-vm-modules`) with a linker that resolves relative
specifiers to sibling files and evaluates the graph into the jsdom
window's context, preserving the harness's load-all-files contract.
jsdom executing modules itself is not an option (unsupported in jsdom
30). Until that loader exists and passes the full suite on an
all-classic tree, **no first-party static imports** — the tripwire in
§9.2 enforces it mechanically.

### 9.5 Baseline discipline through the migration

CONSTRAINTS baseline (main @ v592 lineage): exactly **6 failing files** —
community-corpus, modal-flairs, security-v194, settings-groups,
tropelab-review, v398-features. The rule for every conversion step, in
the fork and later in production PRs: a full serial run
(`BOOKTOK_DIR=<tree>`) must show **exactly those 6 files failing, on the
same assertions**, plus zero new failures. Anything else is a stop.
What conversion does to each baseline suite, individually:

| Baseline suite | Mechanism | Migration exposure |
|---|---|---|
| community-corpus | source-scanner (reads index/sw/css + 9 sources) | its failing assertion is a version pin ("version bumped past v474"); fork work bumps nothing, and js/222–223's phase-1b conversion changes declaration style, not the pinned text — signature must remain identical |
| modal-flairs | source-scanner (reads js/151's signature table) | js/151 converts in phase 1c; R2 may apply to its table-locating pattern; the failing assertion is table *content* (23-theme mapping) — unchanged by conversion; signature must remain identical |
| security-v194 | loadApp + reads index.html ("sw: vendor precache list present") | conversions never touch sw.js or the VENDOR list; unaffected |
| settings-groups | loadApp + reads index.html | behavioural; js/180-settings converts in phase 2 — the v416-gallery failing assertion is behavioural and must fail identically |
| tropelab-review | loadApp + reads index.html | js/161 converts with the admin cluster (phase 2); its failing assertion (▲ vote button wiring, source-located) may need R2 — named here so the cluster PR discloses it |
| v398-features | loadApp | the failing assertion is "wrapped total pages" (js/214 section); js/213's DNF assertions in this suite currently *pass* and must keep passing through slice 1; js/214 converts in phase 1c with the same constraint |

### 9.6 Fork-run evidence caveat (hardcoded paths)

Because 134 suites hardcode the main-checkout path for some reads, a
full-suite run against the fork (BOOKTOK_DIR=fork) executes fork *code*
through the harness but reads *main's* index.html/sw.js in those suites'
text assertions. Behavioural evidence is therefore valid; tag/sw
text-assertion evidence testifies about main, not the fork. Slice
evidence (§10.3) closes this gap directly with a fork-tree census check
(disk = index tags = sw JS array, computed on the fork tree itself).
On production PRs the caveat vanishes — the change is in the checkout
the hardcoded paths name.

---

## 10. (g) First slice — definition (a separate task builds it; this plan defines it)

### 10.1 The slice: three files, one per conversion shape that matters

| File | Lines | Shape | Public surface | Consumers (all runtime, typeof-guarded where checked) | Outbound |
|---|---|---|---|---|---|
| **js/213-dnf.js** | 127 | classic leaf | `DNF_REASONS`, `openDnfReasonSheet`, `saveDnfReason`, `dnfInsightsHTML` | js/150 (js/150:1957, `typeof`-guarded), js/170 (js/170:1360, guarded) | runtime reads of 7 files' globals (050, 055, 090, 152, 040, 002, 065) — the free-variable pattern's proof |
| **js/238-book-candle.js** | 512 | shape-2 IIFE | `bookCandle`, `candleCardHTML`, `candleName`, `candleTint`, `drawCandleCard`, `shareCandleCard` (window-published today) | js/150 (js/150:1279, `typeof`-guarded) | runtime reads of 6 files' globals from inside the IIFE |
| **js/244-gift-postal.js** | 429 | pure data + pure functions | `GIFT_COUNTRIES`, `GIFT_POSTAL_FORMATS`, `GIFT_NO_POSTAL`, `GIFT_FSA_*`, `giftPostalCheck`, `giftPostalCheckCA`, `giftCountryCodeFor`, … (15 names) | js/243-gifts (gift address flow) | **none** — zero outbound references; the control case |

All three: C1 ✓ (no eval-time inbound), C2 ✓ (no inbound lexical writes),
C3 ✓ (no eval-time outbound), ≤2 consumers. Together they prove the three
claims the whole program rests on: bridges serve guarded classic
consumers unchanged (213), an IIFE file unwraps into a module without
behaviour change (238), and a dependency-free module needs nothing but
its exports (244). js/213 also carries pilot continuity: the same file
was converted at v551, so the slice re-proves the pattern against
today's code (its consumer set and outbound reads have both grown since).

### 10.2 Harness/suite surface the slice exercises

- loadApp + classicize (new, fork-side): the full suite.
- R3 twice: book-candle.test.js (vm; js/238), gift-a-book.test.js (vm;
  js/244).
- R1 once: first tag flip (js/213's tag) triggers the appversion
  enumeration repoint — in the fork's copy of the suite, as the worked
  example of the repoint discipline.
- Baseline-sensitive: v398-features (js/213's DNF assertions pass today;
  its baseline failure is in js/214's section and must remain the
  suite's only failure), remediation-b and swipe-dismiss (DNF save-flow
  and sheet-wiring contracts, per the pilot record).

### 10.3 Evidence the slice must produce (all of it, or the slice failed)

1. **Fork deployment boots and the surfaces work** — UX Tester pass on
   the fork preview (`https://fork-es-modules.cozylibram.pages.dev`,
   which auto-deploys the branch; verified serving v592 code at plan
   time): app boots signed-in; DNF flow (mark a book DNF → reason sheet
   opens → reason saves; Stats shows the DNF Autopsy block); candle
   card renders on a book page; gift flow postal validation accepts a
   valid CA postal code and blocks a malformed one with the designed
   message. Plus the standing open item: **offline reload with module
   scripts under the service worker** (§12, Q1) attempted and reported
   either way.
2. **Suites:** full serial run on the fork tree shows exactly the 6
   baseline failures with identical failing assertions; targeted suites
   (v398-features, remediation-b, swipe-dismiss, book-candle,
   gift-a-book, appversion, shelfview) green apart from v398's known
   baseline assertion.
3. **Surface identity:** census re-run post-conversion shows each
   converted file's public surface identical to its pre-conversion
   census (names and objects), and Node's ESM loader imports each
   converted file directly with the expected export list.
4. **Set equality on the fork tree:** disk js files = index.html script
   tags (classic + module) = sw.js JS array, computed on the fork tree
   (closes §9.6's caveat for the slice).
5. **SW handling per §6** (fork CACHE suffix or fresh-profile protocol)
   documented in the slice's report, with the stale-cache behaviour
   observed, not assumed.

**Fallback:** if the three-file slice hits a snag that isn't quickly
diagnosable, shrink to js/213-dnf.js alone (the pilot-proven leaf) and
report the snag as slice evidence — a small clean proof plus a named
problem is a successful slice; three files with a mystery is not.

**Non-goals for the slice:** no changes land on main (the classicize
harness, the R1 repoint, and the conversions all live on the fork until
the User rules on the packaged proposal); no static imports; no
version-pair movement anywhere.

---

## 11. (h) Sequencing boundary — candidate 8 (Data & Sync knot seams)

**Boundary condition, binding on this plan's ordering:** the knot files —
js/040-storage.js, js/041-idb.js, js/090-sync.js — and js/229-user-state's
seam surface do not convert in any phase until the Data & Sync seat's
classic-script seam work (candidate 8 step 0: `replaceLibrary()` /
`clearLibrary()`, the `replaceUpNext(arr)` seam, the epoch counter,
post-await slot discipline in js/090) has **landed in production** and
that seat confirms the seams are ready to be designed against. The
migration order yields to seam readiness for these files, in both
directions: the migration does not pressure the seam schedule, and seam
design does not need to anticipate module shapes beyond what forced
decision 1 (§2.3) already frames — the seam outcomes (a ruled `library`
state shape, sanctioned mutators) are *inputs* to knot-phase design.
js/208's `setLocalUserIdb` wrap (§5.1, E5) is re-homed as part of that
same knot work, since the wrap exists only because js/040 is
seam-untouched today. If the knot seams slip, phases 1–3 proceed
unaffected — 95 of 104 files are not behind this boundary.

---

## 12. (i) Risks and open questions for the User's ruling

**Risks (owned by the plan, mitigations stated):**

- **R-1 Strict-mode surprises in later files.** Modules are strict;
  phase 1–2 files are audited per file (§4 step 2), but a sloppy idiom
  on a rarely-executed path could survive the audit and throw only in
  production. Mitigation: conversions land behind the full-suite +
  live-verification bar per PR, phases are ordered so the least-covered
  files convert latest, and every conversion is one-tag reversible.
- **R-2 Silent degradation of guarded leaves.** A converted leaf whose
  module fails to load degrades silently at `typeof`-guarded call sites
  (the pilot accepted this shape deliberately). Mitigation: the fork
  slice exercises each surface live; production conversions of guarded
  leaves carry a named live check of the guarded surface in their PR's
  verification, not just suite green.
- **R-3 The import-wiring phase's loader** (§9.4) is real future work,
  not a footnote: if `vm.SourceTextModule` proves unworkable in the
  suite environment, import wiring waits for a different loader design.
  The bridge-everything end state is nevertheless a complete, shippable
  outcome on its own — the migration does not *need* import wiring to
  have been worth doing (modules, strict mode, explicit surfaces,
  per-file encapsulation all arrive with the bridge pass).

**Open questions (the User rules; the plan recommends):**

- **Q1 — Offline reload of static module scripts under the SW.**
  Partially de-risked: production already loads vendored modules via
  dynamic `import()` through this service worker (three, ZXing). Static
  `<script type="module">` tags + cache-first SW is the standard PWA
  shape, but the v551 pilot could not verify offline reload in its
  harness (no real browser), and it remains the one unverified runtime
  behaviour. Slice 1's Tester pass (§10.3 item 1) is designed to close
  it; if offline reload misbehaves, phases pause and the finding comes
  back before any production PR. *No ruling needed unless it fails.*
- **Q2 — Fork CACHE suffix** (§6): adopt `cozy-libram-v592-fork` on the
  fork only (recommended), or fresh-profile protocol for all fork
  passes? *Recommendation: suffix — decided inside slice 1 with the UX
  Tester; flagged here so the User sees the fork's sw.js will differ
  from main by exactly that string while the program runs.*
- **Q3 — Request count.** Bridge-everything keeps today's shape: 104
  files, 104 requests, HTTP/2 multiplexed on Cloudflare Pages — no
  change, no action. If the User later wants fewer requests, that is a
  bundling proposal (§8 escalation), explicitly out of this program.
- **Q4 — Importmap growth.** None needed for first-party code (relative
  paths). Bare specifiers for future packages (the package candidates
  named when the migration was approved) would be added per-package
  through the normal gates when those proposals arrive; the existing
  `three` entry is the template.

---

## 13. Successor phase — the comment pass (after the migration)

(User decision, 2026-10-16, re-sequenced the same day: the comment
updates apply **after** the migration completes, not during it.
Conversions in this program are pure moves — comments are carried
verbatim, and a stale or mechanical comment in a converted file is
carried, not fixed, and is **not a finding** at any migration gate (§4).
This section is the seed text for the follow-on program — a comment
pass over the finished modular tree — whose scope and order are
specced once the migration completes. The standard itself already
stands as the convention for **new** code via AGENTS.md; nothing in
this program applies it retroactively.)

The standard (the successor phase's seed text):

- **Comments explain WHY, in plain human sentences:** the invariant
  being held, the ordering constraint, the failure mode being
  prevented, the decision that shaped the code. A reader who has never
  seen the file should understand the intent without archaeology.
- **WHAT-comments only where the mechanism is genuinely non-obvious**
  — a clever algorithm, an encoding, a protocol shape — and then they
  explain the mechanism, not narrate line by line.
- **No comment that merely restates the code.** And version tags stop
  being the comment: today's dominant anti-pattern — `// v217: async
  decode off the main thread` — records *that* something changed, not
  what the code does or why. A version reference may survive as a
  trailing detail where the history genuinely matters (a workaround for
  a named past bug), but the explanation comes first, in words.
- **Function-level headers for anything non-trivial:** purpose,
  inputs/outputs in prose, and the gotchas a caller must know.
- **Honest and current:** a file's stale or mechanical comments are
  rewritten or deleted in the same pass. A wrong comment is worse
  than none.
- **Prose for intent, precision for contracts.** The standard is
  deliberately model-friendly: rationale goes in plain sentences, but
  load-bearing facts — key formats (e.g. the gift book key shape),
  sentinel values, exact contract shapes, ordering requirements — are
  stated **precisely and exactly**, never paraphrased into flowery
  prose. This accuracy rule is doubly binding because agents weight
  comments as ground truth: a stale why-comment is exactly how a
  future agent talks itself into breaking an invariant.

**Why the sequencing matters:** keeping the comment pass out of the
conversions preserves this program's evidence discipline — pure moves
whose surfaces can be diffed and census-verified — while the wiring
changes underneath the whole tree. The comment pass then runs once,
coherently, over the tree's final shape, under its own spec and its
own review, instead of being smeared across hundreds of conversion
diffs where a wording change and a wiring change would be
indistinguishable in review.

---

## Appendix A — census detail (v592, `b849e68`)

**A.1 Eval-time edges (complete list; hand-verified sites in §5.1):**
041→040, 200→010, 200→040, 200→090, 208→040. No others exist.

**A.2 Files receiving cross-file lexical writes (complete list):**
js/000-core (63 writes, 10 writer files), js/040-storage (8: js/041
eval-time `storageReady`, js/208 eval-time `setLocalUserIdb` wrap,
js/090 ×3, js/120/js/229 `upNext`, js/180 `library`), js/163-analytics
(7, from js/199 + js/095), js/199-admin (3, from js/095), js/140-collections
(3), js/205-shelfview (2), js/217-shelf3d-view (2). All other files: zero
inbound lexical writes.

**A.3 Phase-1 clear pool (41):** the 8 pure leaves (§2.1 1a), the 8
shape-2 IIFEs (1b), and 25 further ≤2-consumer C-clean files including
js/062-inventaire, js/096, js/133, js/137, js/138-editions, js/139-import-
concierge, js/151, js/160-roulette, js/164, js/165, js/166, js/180-settings
is *not* in the pool (28 outbound files; phase 2 by blast radius despite
1 consumer — ordering is risk, not just counts), js/190, js/203–211 group
members not already listed, js/213, js/214, js/221, js/231, js/234,
js/235, js/236, js/242-marginalia, js/243-gifts is *not* in the pool
(it is js/244's consumer and a mid-size feature file; phase 2).
The machine-readable census (per-file consumers, inbound/outbound edge
lists, top-level side-effect inventory) is reproducible with the method
in §1; the slice and each conversion re-run it rather than trusting
this appendix.

**A.4 Highest-consumer files (phase 3/4 ordering input):**
js/050-helpers (76 consumers), js/040 (56), js/090 (44), js/000 (28),
js/200-boot (27), js/020 (25), js/065 (25), js/152 (24), js/002 (21),
js/070 (20), js/055 (18), js/100 (18), js/195 (17), js/150 (16).

**A.5 Top-level side-effect inventory (classes, §5.1):** event-listener
registrations — js/050 (×2), js/105 (×2), js/159 (×2), js/160, js/229;
own-function boot calls — js/002 (`AppLog._restore`), js/105
(`renderTopbar`), js/120, js/134, js/200 (`applyTheme` + boot branch);
IIFE self-executions — the shape-2 files; namespace publications —
js/151, js/216, js/218. Nothing else executes cross-file work at eval
time.

## Appendix B — the pilot record, carried forward

The v551 pilot (tag `fork-pilot-v551`, commit 692080d + FORK.md at
721a555) converted js/213-dnf.js on the v551 tree with this plan's recipe
in embryo: exports in place, dependencies kept as global reads, window
bridge appended, tag flipped in place, sw.js untouched, no version bump.
Its verification record: full serial suite before/after with the failing
set identical at the 6 baseline files; Node's ESM loader importing the
converted file directly (export surface exact, bridge republishing
identical objects, read and write paths exercised); static serving
returning the module tag and the module at 200 with a JavaScript content
type. Its one unverified item — real-browser/offline behaviour — was
subsequently covered by the UX Tester's real-browser fork pass (per the
program record), and §12 Q1 keeps the offline-reload check in slice 1's
evidence list regardless. The pilot's five forced decisions are §2.3 of
this plan, with census-updated numbers. Where the pilot and this plan
differ: the pilot's harness classicize is re-specified with a loud
failure tripwire (§9.2), and the pilot's phase sketch is replaced by
the census-derived phases (§2).

---

## Gate notes — PR #269 (v593)

Recorded from the Security Advisor's gate on the phase-1a PR, at the
program manager's direction. Two Low findings, both carried forward
as standing checks for later phases:

- **Low-1 — a bridge republishes a reassigned primitive's INITIAL
  value on window.** A bridge block assigns the export's value at
  module-eval time; if a converted file later reassigns one of its
  exported primitives internally, `window` keeps the initial value
  and a classic reader of the bare name would see stale data (a
  module reader of the export sees the live binding — the two
  surfaces would diverge). Later phases must therefore check any
  converted file for cross-file READ reassigned primitives and use
  a getter-style bridge, or a roster hold, for those files. In
  PR #269 the exposure was audited per file and proven zero readers
  for the two reassigned primitives in scope (js/182-tileguard's and
  js/211-yolo's session state): consumers read only
  functions/tables.
- **Low-2 — the classicize tripwire's line-anchored regexes can
  miss exotic import placements** (a no-whitespace `import"…"` or a
  mid-line import statement). The miss is not silent: the
  classicized text still fails loudly at parse time in acorn/vm, so
  the never-silent property the tripwire exists for holds. A
  token-level pre-scan is future harness work — noted, unscheduled.

---

## Gate notes — PR #270 (v594)

Recorded from the Security Advisor's gate on the phase-1b PR, at the
program manager's direction. One Low finding and one Nit, plus a
retro-check on the phase-1a files:

- **Low — classicize places unwrapped shape-2 internals in the
  shared loadApp global scope.** The harness's classicize turns a
  converted file back into a classic script for the suites, so an
  unwrapped file's internal (non-exported) helpers land in the one
  global scope every loadApp suite shares. js/238-book-candle and
  js/241-book-ambience share four internal helper names: three are
  byte-identical, and the fourth, `localTropeNames`, leaves
  js/241's null-tolerant variant in effect by load order — a
  behavioural superset of js/238's, so no suite exercises a weaker
  helper than production runs. Production is unaffected (real
  module scope keeps internals private); the harness impact is
  empirically bounded by the identical 200-pass / 6-baseline-file
  signature at this gate. Standing fidelity note for later phases:
  more shape-2 conversions mean more shared names in harness
  scope — watch for non-identical same-name helpers in future
  batches; a collision there is a harness-fidelity finding, not a
  production one.
- **Nit — js/215-shelf3d's new header comment contains a sentence
  splice** ("…keeps name resolution identical in both worlds / of
  this file…"). The mechanism the comment describes is correct;
  only the sentence is garbled. Fix opportunistically in the
  phase-2 shelf-cluster PR that next touches js/215.
- **Retro-check — PR #269's eight files are clean under corrected
  census handling.** Re-running the census with the shape-2
  eval-read blind spot (§5 / PR #270's lesson (a)) accounted for
  shows zero cross-file eval-scope reads in any of the eight
  phase-1a files: the blind spot endangers nothing already merged.

---

## Gate notes — PR #271 (v595)

Recorded from the Security Advisor's gate on the phase-1c batch-1 PR,
at the program manager's direction. No new finding classes: the gate
closed PASS_WITH_RISK on the standing Low alone, and confirmed two
classification calls from the batch.

- **Low-1 recurred in disclosed form — and only in that form.**
  Four of the batch's files export bindings that are reassigned
  in-module: js/137-shelf (`shelfBusy`, `shelfResults`,
  `shelfScanPhoto`), js/138-editions (`editionPickerToken`),
  js/139-import-concierge (`IC`, `icToken`, `icWorkLabel`,
  `icWorkFrac`), and js/160-roulette (`blindDate`, `blindPassed`).
  Their bridge lines publish the bindings' initial values, per the
  standing Low-1 mechanism. The gate grep-verified ZERO mentions of
  any of the ten names outside their owner files, so nothing
  observable diverges — the same proof shape as js/182/js/211 in
  PR #269. The standing caution is unchanged and binds every later
  batch: a future file whose reassigned exported binding HAS a
  cross-file reader needs a getter-style bridge or a roster hold,
  and no remaining file is assumed clear without the same grep.
- **js/151's IIFE-retained namespace variant was ruled sound.**
  The catalog IIFE's result is exported in place as a named const
  rather than unwrapped — the identical shape to the js/218
  phase-1a precedent, which the gate had already accepted: the
  namespace object is the same object in both worlds, and the
  bridge republishes that one object.
- **The modal-flairs R3 classification was confirmed honest.**
  PR #271 repointed modal-flairs.test.js as R3-in-substance (its
  load site classicizes js/151's source) where §9.5 had guessed R2.
  The gate confirmed no declaration-scan mechanism exists in that
  suite for R2 to attach to, and the suite's output — including its
  one baseline failure, on the identical assertion — is
  byte-identical to the pristine base.

---

## Gate notes — PR #272 (v596)

Recorded from the Security Advisor's gate on the phase-1c batch-2 PR,
at the program manager's direction. The gate closed PASS_WITH_RISK,
and ruled on the batch's repoint, provenance, and standing-pattern
items below.

- **R1 — the editioncapture §10 point tag-pin repoint was ruled
  sound under CONSTRAINTS rule 4.** The repointed assertion accepts
  either exact tag literal (the classic script tag or the module
  tag) and still fails on a missing, renamed, or mis-src'd tag, so
  the net is not narrower than the pin it replaced. No other suite
  pins any of the eight files' tags.
- **Provenance — shipped js/213 is body-identical to the fork
  slice-1 conversion.** The file that landed matches the fork
  conversion line for line: 112/112 stripped lines identical.
- **Low, standing pattern — bridge-published initial values in
  js/166 and js/206.** js/166's `adminLogFilter` and js/206's `EC`
  publish their initial values via their bridges, per the standing
  Low-1 mechanism. The gate graded EC as a var session state (the
  Low-1 class, not a const namespace) and grep-proved zero
  production readers for both names, so nothing observable
  diverges. The two js/206 suites' bare `EC` use runs against the
  harness's classicized copy, whose scope semantics are unchanged.
- **Nit — PR #272's body total said 94 names; its per-file counts
  sum to 96.** Identity was verified exact at 96/96, so the slip
  was in the body's arithmetic, not in the conversion. The
  count-check step this produced is now standard in Builder
  briefs, and was applied in PR 5 (138 names, verified two ways).

---

## Gate notes — PR #273 (v597)

Recorded from the Security Advisor's gate on the phase-1c batch-3 PR,
at the program manager's direction. The gate closed PASS_WITH_RISK.
**Phase 1 completed with this PR: 37 files converted at v597.**

- **Low, standing pattern — bridge snapshots of reassigned
  bindings recurred in disclosed form.** js/231's `rxTableMissing`,
  js/234's `sentUnsupported`, js/235's `ritShelvesCache`, and
  js/236's five picker bindings (`avatarPickerToken`,
  `apkCandidate`, `apkCurrent`, `apkItems`, `apkSavedScroll`)
  publish their initial values via their bridges, per the standing
  Low-1 mechanism. The gate grep-proved zero external mentions of
  any of the eight names, so nothing observable diverges. The
  caution is unchanged: a future reassigned binding WITH a
  cross-file reader needs a getter/accessor bridge or a roster
  hold — the mechanism PR #274 itself establishes for the admin
  cluster.
- **Nit, design note — the Math.max-of-two-forms ordering check
  in social-remediation-a has one theoretical widening.** The
  repointed ordering assertion (js/234 registers after js/233)
  would also pass if index.html ever carried BOTH tag forms for
  js/234 at once, with the classic form before js/233 and the
  module form after it. That state requires a duplicated script
  tag, which the series' one-for-one flips never produce and
  which the per-gate set-equality census (104 = 104 = 104)
  excludes. For future R1 ordering repoints, prefer
  single-position derivations where the suite's structure allows.

---

## Gate notes — PR #274 (v598)

Recorded from the Security Advisor's gate on the phase-2 admin
cluster PR (js/161, js/162, js/163, js/199), at the program
manager's direction. The gate closed PASS_WITH_RISK; merged as
8ee44a3. **Phase 2 opened with this PR.** Line tally at v598:
54,147 js lines (+1,258 cumulative against the 52,889 baseline).

- **The accessor-bridge mechanism is established.** All 10
  cross-file binding-reassignment writes into js/163 and js/199
  (from js/199 itself and from js/095's `leaveApp()`), plus
  js/161's `tropeProviderCache` (read cross-file by js/157), are
  published via `Object.defineProperty` get/set bridges that
  forward to the live module bindings — with ZERO writer or
  reader expression edits anywhere (js/095 and js/157
  untouched). The gate independently re-derived the write-site
  inventory (exactly 10 writes; exotic write channels swept
  clean), re-ran both two-realm proofs, and probe-proved the
  production-critical case: js/165's bare `isAppAdmin` read
  observing `refreshAdminStatus()` flips in both directions
  through the accessor, and js/157's `tropeProviderInfo()`
  returning the provider override — and null when none is set —
  against the converted js/161.
- **js/161's conversion followed a Builder STOP, ruled by the
  program manager.** The Builder held js/161 out of the first
  build because `tropeProviderCache` is reassigned in-module
  and read cross-file: a value bridge would have frozen it at
  `null`. The ruling applied this plan's own Low-1
  prescription — the one-name accessor bridge above — and the
  cluster converted as a unit in the same PR.
- **R3 repoints ×3 ruled SOUND.** trope-admin-backfill,
  trope-models, and trope-provider-picker apply `classicize()`
  at their vm load sites for js/161; assertions untouched.
- **Low, standing pattern — 15 value-bridged in-module
  reassigned bindings across js/161 and js/162.** AST-proven
  zero cross-file references, so nothing observable diverges.
  The caution is unchanged: the accessor mechanism now exists
  for any future reassigned binding that gains a cross-file
  reader.
- **Nit — one PR-body sentence initially overstated js/162's
  reassignment state.** The conversion itself was exact; the
  body wording was corrected post-merge.

---

## Gate notes — PR #275 (v599)

Recorded from the Security Advisor's gate on the phase-2
shelf-3D cluster PR (js/217, js/207), at the program manager's
direction. The gate closed PASS_WITH_RISK; merged as 4cdacc5.
Line tally at v599: 54,270 js lines (+1,381 cumulative against
the 52,889 baseline); 43 of 104 files converted. The PR also
carried the js/215 header-comment Nit fix from PR #270's gate
notes — comment-only.

- **The js/205 write pair split by ownership.**
  `_shelf3dWebGLFailed` is owned by js/217 and written by the
  still-classic js/205 (at :800/:819, read at :659): it is
  served by a one-name accessor bridge of the kind PR #274
  established, and js/205 is byte-identical and untouched.
  `shelfGroup` is owned by js/205 itself, so it needed no
  re-expression at all — a module writing to a classic file's
  lexical binding is sound, proven in the two-realm harness.
- **Gate verification was independent and mechanical.** The
  gate reproduced census A.2's whole-tree write inventory
  exactly, drove js/205's reset statements verbatim against
  the module realm, and confirmed `window.THREE` stays
  unexported, unbridged, and lazy — js/207 owns the `three`
  import and the shared slot exactly as before conversion.
- **R1 repoint ruled SOUND.** The book3d suite's js/207 tag
  pin was extended to accept the module tag form; the gate
  mutation-tested it four ways — missing tag FAIL, wrong src
  FAIL, attribute-swapped form FAIL, both exact literals
  PASS.
- **Low, standing pattern — six value-bridged in-module
  reassigned bindings** (js/207's `b3dThreePromise`; js/217's
  five state lets). AST-proven zero cross-file references, so
  nothing observable diverges. The caution is unchanged.
- **Nit — PR-body strip sizes were character counts labelled
  as bytes.** The conversions themselves were exact; the body
  figures were corrected post-merge.

## Gate notes — PR #276 (v600)

Recorded from the Security Advisor's gate on the phase-2
census batch 3 PR (js/056, js/062-tropes, js/110, js/135,
js/155, js/181, js/197), at the program manager's direction.
The gate closed PASS_WITH_RISK; merged as e75ddb7. Live at
v600 with 50 module tags. Line tally at v600: 54,475 js
lines (+205 this PR, +1,586 cumulative against the 52,889
baseline); 50 of 104 files converted.

- **The gate's census was fully independent.** The Advisor
  wrote its own census from §1's method and reproduced the
  Builder's with zero per-file diffs across all 104 files —
  surfaces, consumers, writers, and eval-consumers all
  identical. The phase-2 roster published in the PR body
  (34-file feature roster plus the js/180 named hold) is
  therefore a twice-derived fact, and the batch's claim to
  be the first seven files in ascending consumer order is
  verified, not asserted.
- **js/135 `visionBusy` accessor-bridged.** The binding is
  reassigned in-module by `visionSetBusy()` and read by the
  still-classic js/137's `shelfScan()` guard (:65), so it is
  served by the accessor bridge PR #274 established; js/137
  is untouched. The gate re-ran the Builder's two-realm
  proof firsthand and its own probe additionally proved the
  write direction through js/135's internal reader — a bare
  external `visionBusy = true` correctly blocks
  `visionReadCover()`'s guard, and clearing via the exported
  setter restores the flow.
- **js/181's load path makes the no-repoint claim sound.**
  No suite loads js/181 raw: every load goes through
  `.test/harness.js` `loadApp`, which applies `classicize()`
  to every file (the PR #269 R3-in-harness pattern), and the
  text consumers are all unanchored. Zero repoints were
  needed across all seven files in the batch.
- **js/180 reconciliation confirmed.** js/180-settings
  measures exactly one consumer (js/200-boot) on both
  censuses; its phase-2 membership rests on §9.5's named
  hold, and its settings-groups §9.5 obligation is
  explicitly deferred to whichever PR converts it — the
  final phase-2 PR, risk-ordered by its blast radius — not
  discharged by this PR.
- **Low, standing pattern — two value-bridged in-module
  reassigned bindings** (js/155's `authorView`, js/181's
  `bootVersionChecked`). AST-proven zero cross-file
  references of any kind, so nothing observable diverges.
  The caution is unchanged.
- **Nit — the PR body carried a stale "Draft — no version
  bump" sentence** predating the release step. Corrected
  post-merge by the program manager and verified by
  read-back.

## Gate notes — PR #277 (v601)

Recorded from the Security Advisor's gate on the phase-2
census batch 4 PR, at the program manager's direction.
The gate closed PASS_WITH_RISK; merged as ff15013. Live at
v601 with 57 module tags. Line tally at v601: 54,663 js
lines (+188 this PR, +1,774 cumulative against the 52,889
baseline); 57 of 104 files converted.

- **The gate's census was fully independent.** The Advisor
  wrote its own census and reproduced the Builder's with
  zero per-file diffs across all 104 files — the third
  consecutive PR with a zero-diff independent census.
- **All four repoints ruled SOUND and mutation-tested.**
  R1 ×3: the social-buddy-reads suite's js/233 tag pin; the
  social-remediation-a suite's js/233 position pin via
  `Math.max` of both tag forms, extending PR #273's js/234
  shape symmetrically — its theoretical both-tags-present
  widening is excluded by set equality; and the marginalia
  suite's js/242 tag pin. R3 ×1: book-portrait's vm loader
  classicizes js/225, its identity proven on classic loads.
- **Low, standing pattern — six value-bridged in-module
  reassigned bindings** (js/233's `buddyTableMissing`,
  `buddySupportKnown`, and `buddyRowsCache`; js/242's
  `margTableMissing`, `margSupportKnown`, and
  `margReconciled`). The value-bridge audit proved zero
  cross-file readers three ways — census inversion,
  after-census, and word-boundary grep — so nothing
  observable diverges. The caution is unchanged.
- **The disclosed converter trailing-newline incident on
  js/030/060/080 is confirmed ABSENT from the final tree.**
- **Two suites that flaked once in an ad-hoc loop were
  adjudicated transient** — community-curation-flow and
  icon-sweep each passed standalone (64/64 and 373/373).
- **js/225's `findBook` AST body is byte-identical across
  js/225, js/238, and js/241**, so the classicize pool claim
  holds.
- **Nit — the PR body mis-stated js/225's consumers**
  (js/150, js/160, and js/180, for the real js/150, js/226,
  and js/227). Patched post-merge.

## Gate notes — PR #278 (v602)

Recorded from the Security Advisor's gate on the phase-2
census batch 5 PR, at the program manager's direction.
The gate closed PASS_WITH_RISK; merged as 08d85ac. Live at
v602 with 64 module tags. Line tally at v602: 54,938 js
lines (+275 this PR, +2,049 cumulative against the 52,889
baseline); 64 of 104 files converted.

- **The gate's census was fully independent.** The Advisor
  wrote its own census and reproduced the Builder's with
  zero per-file diffs across all 104 files — the fourth
  consecutive PR with a zero-diff independent census.
  Census totals: 104 files / 745 edges / 2,264 names.
- **Low, standing pattern — eleven value-bridged
  in-module-reassigned bindings** (js/134's
  `metaConflicts`; js/159's `charNavStack`,
  `charModalReturn`, `characterViewId`, and
  `bookCharViewId`; js/219's `__msMergedUid`,
  `__msMergeRetryAt`, and `__msPushTimer`; js/232's
  `toyTableMissing` and `toySupportKnown`; js/239's
  `finaleCloseFn`). The value-bridge audit proved zero
  cross-file readers three ways, so nothing observable
  diverges. The caution is unchanged.
- **The one repoint ruled SOUND and mutation-tested.**
  R1 ×1: the social-thought-of-you suite's js/232 tag pin.
  Mutation-tested five ways — missing, wrong-src, and
  attribute-swapped forms FAIL; both literals PASS.
- **js/159's seven outbound writes into js/000 verified
  sound** — module→classic, with `view` ×4 and
  `animateIn` ×3, and js/000 byte-identical.
- **§9.5 A/B byte-identical for community-corpus**, the
  one baseline suite reading batch sources
  (js/154/159/219).
- **Whole-tree grep found zero remaining v601 pins**
  after the bump.
- **Nit — a stale "no version bump in this PR" sentence
  in the body's intro.** Patched post-merge and verified
  by read-back.

## Gate notes — PR #279 (v603)

Recorded from the Security Advisor's gate on the phase-2
census batch 6 PR, at the program manager's direction.
The gate closed PASS_WITH_RISK; merged as e8cc23f. Live at
v603 with 71 module tags. Line tally at v603: 55,283 js
lines (+345 this PR, +2,394 cumulative against the 52,889
baseline); 71 of 104 files converted.

- **js/140-collections accessor case verified
  end-to-end.** Its three inbound writes — js/120:701 and
  js/170:1396 writing `seriesReturn`, and js/229:175
  writing `seriesFilter` inside `applyRoamedViewState` —
  all target js/140-owned bindings, served by two accessor
  bridges on js/140 with every writer byte-untouched. The
  gate re-ran the two-realm proof and drove js/140's real
  `renderSeries` back handler against an external write.
- **Thirteen repoints ruled SOUND.** R3 ×12: classicize
  coverage across twelve suites. R1 ×1: the book-dressing
  suite's js/240 tag pin, mutation-tested.
- **Low, standing pattern — twelve value-bridged
  bindings** (js/243 ×2, js/198 ×9, js/240 ×1). Nothing
  observable diverges. The caution is unchanged.
- **js/222's unwrap added 15 IIFE-internal names to the
  census** (totals 2,264→2,279, edges unchanged).
- **The gate corrected its own initial suite figure
  on record** — 201/5 was misstated; the completed run
  was 200/6, all baselines A/B-identical.
- **Nit — a stale draft sentence in the body.** Patched
  post-merge.

## Gate notes — PR #280 (v604)

Recorded from the Security Advisor's gate on the final
phase-2 PR, at the program manager's direction. The gate
closed PASS_WITH_RISK; merged as 999c837. Live at v604
with 78 module tags. Line tally at v604: 55,521 js lines
(+238 this PR, +2,632 cumulative against the 52,889
baseline); 78 of 104 files converted — PHASE 2 COMPLETE.
Phase subtotals: phase 1 +1,047, phase 2 +1,585.

- **R4 RULED SOUND as a class.** A conversion may
  re-express a dynamic-import specifier when the class
  conditions are met: identical-URL resolution proven at
  runtime, the deviating line named in the strip proof,
  and old-spelling pins repointed as R1-class enumeration
  and disclosed. All three were met for js/130; the User
  ratified proceeding on 2026-10-16, and the gate's own
  js/130 loader proof ran 11/11 including the negative
  control (the old specifier from a module URL resolves
  to the /js/js/ 404 the hold prevented).
- **The security-v194:88 repoint RULED SOUND.** The
  zxing same-origin pin now accepts either exact quoted
  specifier (classic or module spelling) with assertion
  text and intent unchanged; the gate reproduced the
  6-way mutation battery, and the suite's output is
  byte-identical to pristine base.
- **js/180-settings §9.5 DISCHARGED.** The code-derived
  19-name surface was verified independently, and the
  settings-groups pristine A/B is byte-identical — the
  named hold's evidence obligation is closed.
- **js/157↔js/161 accessor proof 11/11** in both
  directions against the real converted files.
- **Low, standing pattern — eight value-bridged
  bindings** with zero cross-file readers proven. Nothing
  observable diverges. The caution is unchanged.
- **Nit — a stale Draft sentence in the body.** Patched
  post-merge.
- **One environmental adjudication on the gate run:**
  cloud.test.js produced a 0-byte log from the gate's
  own /tmp exhaustion; a standalone re-run passed 37/0
  and the net signature stood at 200/6.
