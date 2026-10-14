# ES Modules Fork — experiment record

**Branch:** `fork/es-modules` (off `origin/main` @ 4205325, v551).
**Status:** experiment. This branch never merges to main as-is; it exists so
the conversion pattern can be tried, measured, and reviewed in the open.
**Scope of this step:** ONE leaf module converted (`js/213-dnf.js`), a
documented repeatable recipe, and the decision list the full migration
must answer before it touches the data layer.

---

## 1. The pilot leaf: js/213-dnf.js (DNF Autopsy)

Picked against four criteria, evaluated against `js/237-handles.js` and
`js/219-milestones.js`:

| Criterion | js/213-dnf | js/237-handles | js/219-milestones |
|---|---|---|---|
| Inbound consumers | **2 files** (js/150, js/170), both `typeof`-guarded, runtime-only call sites | 7 files, 10+ API names (`friendDisplayName` ×8) | Hook target of js/090's sync |
| Shared knot-state writes | **None.** Reads `library` (filter only) and `cloudUser` (read-only); persists through the `saveLibrary()` seam; book mutation goes through the normal Proxy path | Mutates `cloudUser.user_metadata.handle` (js/237:473) — a property write on js/090's global | 23 knot-state references; owns sync push/pull + timers |
| Self-contained | 125 lines, own const catalog, no module-level mutable state | 523 lines, signup-stash state + DOM wiring into js/095/105 | 1,137 lines, merge/backoff state |
| Test coverage | v398-features (DNF section, all passing), remediation-b (save-flow contract), swipe-dismiss (sheet wiring) | **Best of the three** (handles + signup-handle suites) | milestones suite |

js/237 wins on test coverage alone; js/213 wins the other three criteria,
and its consumers being `typeof`-guarded, runtime-only call sites is
exactly the shape a first conversion needs: a bridge failure degrades one
feature sheet instead of breaking boot. js/219 is disqualified — it is
part of the sync knot, not a leaf.

## 2. The conversion pattern (the repeatable recipe)

For one leaf at a time:

1. **Qualify the leaf.** Few inbound consumers; no writes to shared knot
   state (the js/000 / js/040 / js/090 globals); no boot-path callers —
   every call site runs at interaction/render time. A leaf that fails any
   of these is not a phase-1 candidate.
2. **Export the existing public surface in place.** Add `export` to the
   declarations that were the file's public API (here: `DNF_REASONS`,
   `openDnfReasonSheet`, `saveDnfReason`, `dnfInsightsHTML`). No
   restructuring, no renames, no behaviour change in the same step.
3. **Keep its dependencies as global reads — for now.** The leaf still
   reads classic-script globals (`library`, `cloudUser`, `saveLibrary`,
   `esc`, `toast`, `track`, `wireSheetDrag`, …) as free variables.
   Function declarations resolve through the global object; `let`/`const`
   globals resolve through the global lexical environment, which modules
   share. This works because module scripts are *deferred*: by the time
   the module evaluates, every classic script has already run. Imports of
   other modules arrive in a later phase, once providers are converted.
4. **Append the compatibility bridge.** A module's top-level names are
   module-private, so republish exactly the pre-conversion public surface
   on `window` (see the bridge block at the bottom of js/213-dnf.js).
   Classic callers resolve bare names through the global object, so no
   caller changes. Rule: a name leaves the bridge only when its last
   classic caller is gone.
5. **Flip the script tag, same line, same position.**
   `<script type="module" src="js/213-dnf.js"></script>` in index.html.
   No renumbering, no list edits.
6. **Leave sw.js untouched.** Precaching is URL-based: the file stays in
   the JS precache array under the same URL, and the service worker
   returns the cached bytes regardless of how the requesting tag parses
   them. Module-vs-classic is a property of the tag, not the cache entry.
   (Registration tests tolerate the tag: `.test/shelfview.test.js` matches
   on the `src="js/…"` substring; `.test/appversion.test.js` enumerates
   *classic* tags by regex and asserts those are precached — the module
   tag correctly falls outside its scope.)
7. **No version bump on the fork.** This branch is not a release. A
   conversion that ever lands on main ships under the normal version-pair
   rule (APP_VERSION + SW CACHE together) like any other change.
8. **Adapt test harnesses, never test assertions.** jsdom cannot execute
   module scripts, so `.test/harness.js` (this branch only) emulates:
   for a file containing `export`/`import` syntax it strips the markers
   and injects the identical body as a classic script. This is sound
   only under the phase-1 rule — **converted modules carry no imports** —
   because then the stripped body plus its own window bridge reproduces
   the production surface exactly. The moment a converted module needs a
   real import, the harness needs a real module loader instead, and this
   emulation must be retired, not extended.

## 3. The five forced decisions

Recorded from the improve-architecture survey (2026-10-14). A full
migration cannot dodge any of these; each needs an explicit ruling
before the data layer is touched.

1. **The `library` binding** (reassigned in ≥9 places across 3 files;
   ESM importers cannot reassign an imported binding — options: state
   module with get/set, never-reassign in-place mutation, or window
   singleton).
2. **The 020⇄040 cycle** around migrateBook/trackBook, which relocates
   the v194 security choke point.
3. **The 090⇄095 auth/gate cycle plus ≥5 typeof-guarded optional hooks**
   (js/090 into js/229/219/195) — import vs injected callback vs event,
   each to be adjudicated.
4. **js/000's shared UI state** (view/filter/query/sortBy/editing*) —
   uiState object vs setters vs relocation to owner modules, sortBy
   sharpest because js/229 writes it during roaming apply.
5. **Boot sequencing** — side-effect boots (js/041 starting storageInit,
   eval-time localStorage reads in js/000) must become explicit init()
   calls from one entry point.

## 4. Suggested conversion order

Leaves first, data layer last. Each step is independently shippable and
reversible (flip the tag back, drop the exports).

1. **Phase 1 — guarded leaves** (this step): feature leaves whose call
   sites are runtime-only and `typeof`-guarded, carrying no imports.
   js/213-dnf.js is the template.
2. **Phase 2 — trapped shared machinery:** extract `wireSheetDrag`
   (js/150) and `CharacterStore` (js/199) into their own modules first
   (survey candidates 2–3), then convert remaining feature leaves whose
   consumers are unguarded, widening bridges as needed.
3. **Phase 3 — mid-tier features:** the giants' already-pure cores
   (js/215 packer/camera math, js/206 vision core, js/199 tab splits)
   convert as units once their hosts are split.
4. **Phase 4 — the knot:** js/000 / js/040 / js/090 last, only after the
   five forced decisions above are ruled on. Decision 1 (the `library`
   binding) gates everything in this phase.

## 5. Verified on this branch

- **Test suites:** full serial run (188 files, `BOOKTOK_DIR=<worktree>`)
  before the change: failing set is exactly the 6 known baseline files
  (community-corpus, modal-flairs, security-v194, settings-groups,
  tropelab-review, v398-features). Post-change run: see the branch's
  final commit message / handoff — the failing set must be identical.
  Targeted suites re-run individually after conversion: remediation-b,
  remediation-d, swipe-dismiss, shelfview, appversion all pass;
  v398-features fails only on its pre-existing baseline assertion
  ("wrapped total pages", in the js/214 section) with every DNF
  assertion passing — the same signature as before the change.
- **Real module execution:** Node's ESM loader imported the converted
  `js/213-dnf.js` directly (not the harness emulation): the export
  surface is exactly the four public names, the bridge republishes the
  identical objects on `window`, and both the read path
  (`dnfInsightsHTML` against the global `library`) and the write path
  (`saveDnfReason` stamping the book and calling the `saveLibrary()`
  seam) execute correctly. `node --check` on the file as `.mjs` passes.
- **Served over HTTP:** the worktree served statically returns
  index.html with `<script type="module" src="js/213-dnf.js">`, the
  module URL at 200 with a JavaScript content type, and sw.js still
  listing `'213-dnf.js'` in the precache array.

## 6. Unproven / residual risks

- **No real-browser run yet.** jsdom cannot execute modules and no
  headless browser was available in the sandbox, so in-browser module
  evaluation, service-worker install/activate with a module in the
  precache set, and the on-device experience are unverified. First
  manual check when trying the fork: sign in, mark a book DNF (reason
  sheet opens, reason saves), open Stats (DNF Autopsy block renders),
  and confirm the app installs/updates offline.
- **Silent-degradation shape.** Both pilot call sites are
  `typeof`-guarded: if the module ever failed to load, the DNF sheet
  would silently never open rather than throw. Acceptable for a guarded
  leaf; unguarded consumers in later phases will fail loudly instead —
  that asymmetry is deliberate, and it is why phase order matters.
- **Harness emulation divergence.** The `.test/harness.js` classicize
  step reproduces phase-1 modules faithfully but is not a module
  loader; it must not be extended to modules with imports (recipe
  step 8).
- **Strict mode.** Modules are strict-mode: the pilot file was already
  strict-safe (no undeclared assignments, no top-level `this`). Later
  conversions must re-check this per file — sloppy-mode idioms that
  classic scripts forgive will throw in a module.

*Files changed by the pilot: `js/213-dnf.js` (exports + bridge),
`index.html` (one tag), `.test/harness.js` (branch-only emulation),
this file. Nothing else — no sw.js change, no version bump, no caller
changes.*
