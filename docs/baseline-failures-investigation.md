# Baseline failures investigation — the six named failures in CONSTRAINTS.md

**Commissioned by:** work order from the User, 2026-10-17 — investigate and
propose only. This report changes no code and no tests; nothing in it takes
effect on its own. Under CONSTRAINTS.md rule 4 and
[ADR-012](adr/012-named-test-baseline.md), every fix proposed here is a
named decision, in its own reviewed change, per file.

**Method.** Each suite was run fresh, standalone, on `origin/main` @
`3e96697` (APP_VERSION v607), serially, with
`COZYLIBRAM_DIR=<investigation worktree>` per CONSTRAINTS rule 1. Every
mechanism below was traced into the app code, specs, or git records cited;
where a number is quoted (a rendered count, a computed total), it comes
from a probe run against the current tree, not from inference.

**Fresh-run signature (2026-10-17):** community-corpus 76 pass / 1 fail ·
modal-flairs 31 / 1 · security-v194 49 / 1 · settings-groups 13 / 1 ·
tropelab-review 11 pass / 1 fail, then a fatal crash that prevents the
remaining 9 of its 21 assertions from executing · v398-features 23 / 1.

## Summary

| File | Failing assertion | Verdict | Recommended change | Headline risk |
|---|---|---|---|---|
| `.test/community-corpus.test.js` | version bumped past v474 | Stale test | Test: parse the version number and compare `> 474` instead of substring-matching `"v48"` | None to fix; the line currently guards nothing |
| `.test/modal-flairs.test.js` | signature table matches the approved mapping (23 themes) | Stale test | Test: one mapping entry — `wisp-night` → `wisp-night-vine` | A real signature regression would hide behind the known-red line |
| `.test/security-v194.test.js` | sw: vendor precache list present | Stale test (two layers) | Test: evaluate the `VENDOR` expression and deep-compare the derived list; record movement #4 in the file's own history comment | The security suite's precache pin is red, so a genuine precache regression is invisible |
| `.test/settings-groups.test.js` | v416: theme gallery replaced the th-theme dropdown | Stale test | Test: replace the magic count `18` with the renderer's own rule (a card per theme except `wisp-night`) | Gallery regressions (a theme losing its card) are invisible while the count is already wrong |
| `.test/tropelab-review.test.js` | ▲ vote button wired per trope | **Split:** stale test as written; **product wrong** underneath | Product decision first (restore per-trope voting in the review queue on the current tap-to-confirm model, or formally retire it there); then the test follows the decision, and section D's crash is guarded | Admins cannot vote per trope in the review queue although the UI says they can; 9 of the suite's 21 assertions never run |
| `.test/v398-features.test.js` | wrapped total pages | Stale test | Test fixture only: give the two fixture books reading-log entries summing to their pageCounts; the `=== 550` assertion is untouched | The only assertion exercising log-based page accounting is red, so a regression there passes unnoticed |

Five of the six are assertions pinned to facts that later, legitimate,
recorded decisions changed — the exact population ADR-012 describes. One
(tropelab-review) is that, plus a real product gap the red line has been
covering. Details per file follow, in the CONSTRAINTS table's order.

---

## 1. `.test/community-corpus.test.js` — "version bumped past v474"

**The failing assertion** (fresh run: `FAIL - version bumped past v474`;
76 passed, 1 failed). At `.test/community-corpus.test.js:179`, in the
touchpoints block:

```js
const av = fs.readFileSync(path.join(ROOT, 'js/181-appversion.js'), 'utf8');
ok('version bumped past v474', av.indexOf("v48") >= 0);
```

**Why it fails.** The assertion substring-matches the app-version file
for `"v48"` — it can only pass while APP_VERSION is in the v480s.
APP_VERSION today is `v607` (`js/181-appversion.js:21`), and `"v607"`
does not contain `"v48"`. The git history shows this is a recurring trap,
not a one-off: the line began as `av.indexOf("v474")` ("version bumped to
v474") and commit `4552418` (2026-10-12, "Fix tests: stale version, …")
hand-bumped the probe to `"v48"` when the app passed v474 — buying
exactly one decade of versions. Nothing in the app reads, or ever read,
the string `"v48"`; the corpus behaviour the suite actually tests (rate
limiter, obscurity weighting, taxonomy, touchpoints) all passes.

**Verdict: stale test.** The product intentionally moved past the
version era the probe encodes; the assertion is a shipping-marker
tripwire for the v459/v474 corpus-refinement releases, expressed in a
form guaranteed to rot at the next decade boundary — and it already has.

**Recommended fix (test only).** Replace line 179 with a numeric
comparison that states the original intent and cannot rot:

```js
const avn = parseInt((av.match(/v(\d+)/) || [])[1] || '0', 10);
ok('version bumped past v474', avn > 474);
```

The assertion's name and meaning are unchanged; only the probe becomes
decade-proof. No app code changes.

**Risk.** Of the fix: negligible — one line, intent-preserving, verified
against the suite's other 76 assertions by a normal gate run. Of leaving
it: a permanent red line that reads like a version gate but gates
nothing, and a demonstrated pattern (it has already been hand-bumped
once) of future agents "fixing" it by bumping the substring again.

---

## 2. `.test/modal-flairs.test.js` — "signature table matches the approved mapping (23 themes)"

**The failing assertion** (fresh run: 31 passed, 1 failed). The suite's
own diagnostic line, printed immediately before the failure:

```
SIG MISMATCH wisp-night got wisp-night-vine want wisp-vine
FAIL - signature table matches the approved mapping (23 themes)
```

The assertion is `.test/modal-flairs.test.js:93`, checked against the
expected-signature table at lines 76–88, whose `wisp-night` entry
(line 86) reads `'wisp-night': 'wisp-vine'`.

**Why it fails.** When the table was written, the flair catalog shared
one signature between the two Wisp themes: the `wisp-vine` entry carried
`themes: ["wisp", "wisp-night"]`. Commit `d8cfd17` (2026-10-11,
"Premium theme art 3/6: flair catalog updates") deliberately split them:
`wisp-vine` narrowed to `themes: ["wisp"]`, and a dedicated entry was
added — `wisp-night-vine`, "Wisp Night firefly vine", `signature: true`,
`themes: ["wisp-night"]` (`js/151-modal-flairs.js:378–379`), with its own
asset (`Asset/packs/wisp-night-vine.svg`, present on disk). The other 22
themes in the table still match the catalog exactly; a product regression
does not present as one theme gaining a named, asset-backed signature
inside a catalog-art commit. The test's "approved mapping" is the
pre-split mapping; the approval moved and the table didn't.

**Verdict: stale test.** The product change was intentional, recorded,
and shipped; the pin was not updated in that change (an ADR-012
"legitimate assertion update that waited" case).

**Recommended fix (test only).** One entry, `.test/modal-flairs.test.js:86`:

```js
voidsignal: 'voidsignal-vine', wisp: 'wisp-vine', 'wisp-night': 'wisp-night-vine',
```

No app code changes. (For completeness: `js/180-settings.js`'s gallery
also treats `wisp-night` specially — see §4 — but by a different rule,
one card per pack; the two are independent decisions.)

**Risk.** Of the fix: none identified — the corrected table was verified
entry-by-entry by the fresh run's mismatch output (exactly one mismatch
exists). Of leaving it: the signature table is the only guard that a
theme's signature asset matches its approved art; while it is red for a
known reason, a real mismatch (wrong asset wired to a theme) produces
the same red line and is indistinguishable from baseline noise.

---

## 3. `.test/security-v194.test.js` — "sw: vendor precache list present"

**The failing assertion** (fresh run: `FAIL - sw: vendor precache list
present`; 49 passed, 1 failed). At `.test/security-v194.test.js:128`:

```js
ok('sw: vendor precache list present', /VENDOR = \['supabase\.min\.js', 'three\.min\.js'\]/.test(sw));
```

**Why it fails — two layers of staleness.**

1. *The filename.* The pin was written at v194 (commit `fc70542`,
   "security hardening") against a literal `VENDOR = ['supabase.min.js',
   'three.min.js']` in `sw.js`. The Three.js UMD→ES-module migration
   (commit `219e422`) renamed the bundle to `three.module.js`. For a
   window the **app** carried the bug — `sw.js` precached a nonexistent
   `three.min.js` — until commit `4552418` (2026-10-12) fixed the
   precache to the real filename. The test pin was not updated then, by
   the record: the movement-history comment in the test itself
   (lines 113–126) documents movements #1–#3 (PR #225, v553–v558), each
   re-verifying the expected precache set and noting the pin "still
   fails only on the pre-existing three.min.js baseline element".
2. *The shape.* At v279 (commit `c8f38a8`, "3D edition viewer") the
   literal list became a computed expression, and v369/v370 added the
   D3 concat. Today `sw.js:56` reads:

   ```js
   const VENDOR = ['supabase.min.js', 'three.module.js'].map(f => './js/vendor/' + f).concat(['./vendor/d3.min.js']);
   ```

   A regex written against the literal form cannot match this regardless
   of the filename question.

The underlying security intent is intact, verified firsthand: the
expression derives exactly `['./js/vendor/supabase.min.js',
'./js/vendor/three.module.js', './vendor/d3.min.js']`, all three files
exist on disk, and the suite's neighbouring pins pass — "vendor files in
ASSETS" (the `.concat(JS, VENDOR, AVATARS, …)` composition), the zxing
absence-from-precache pins, and the zxing runtime-cache pins. (The
related phase-2 gate ruling in `docs/es-modules-migration-plan.md` —
the `security-v194:88` zxing repoint "RULED SOUND", suite output
byte-identical to pristine base — was re-read and is consistent with
this picture: conversions never touched `sw.js` or the VENDOR list's
contents.) Nothing about the service worker's actual precache set is
wrong; the pin describes a source text that has legitimately not
existed since v279.

**Verdict: stale test.** Both layers are recorded, intentional product
history; one of them was even a real app bug whose fix the pin never
absorbed.

**Recommended fix (test only).** Replace the regex at line 128 with an
evaluation of the actual `VENDOR` statement, deep-compared against the
derived list — the same literal strictness, applied to the computed
value instead of the source text:

```js
const vendorList = new Function(
  sw.match(/const VENDOR = [^\n]*\n/)[0].replace('const VENDOR =', 'return'))();
ok('sw: vendor precache list present', JSON.stringify(vendorList) === JSON.stringify(
  ['./js/vendor/supabase.min.js', './js/vendor/three.module.js', './vendor/d3.min.js']));
```

(Exact harness mechanics are the executing Builder's to settle; the
requirements are: evaluate, don't substring — a looser check such as
"all three filenames appear somewhere in `sw.js`" would be a weakening
and is explicitly not recommended — and deep-compare against the three
paths above.) In the same named change, the file's movement-history
comment gains its movement #4 entry recording this, per the file's own
convention. No app code changes.

**Risk.** Of the fix: the new pin must be written to fail on a changed
derived list (an added, dropped, or renamed entry) exactly as the old
one failed on a changed literal — the gate for that change should
mutation-test it (rename one entry in a scratch copy of `sw.js` and
confirm the assertion fails). Of leaving it: this is the security
suite's precache pin; the bug class it exists to catch — the precache
naming a file that isn't there, or silently dropping a vendor bundle —
already happened once (the `three.min.js` window) and would currently
be invisible behind the baseline.

---

## 4. `.test/settings-groups.test.js` — "v416: theme gallery replaced the th-theme dropdown"

**The failing assertion** (fresh run: `FAIL - v416: theme gallery
replaced the th-theme dropdown`; 13 passed, 1 failed). At
`.test/settings-groups.test.js:92–93`:

```js
ok('v416: theme gallery replaced the th-theme dropdown',
  !doc().getElementById('th-theme') && doc().querySelectorAll('.tcard').length === 18);
```

**Why it fails.** The assertion is a conjunction, and the two halves
have diverged. A probe replicating the suite's own setup (load the app,
`renderSettings()`) against the current tree prints:

- `#th-theme` element present: **false** — the first conjunct holds;
  the v416 change (gallery replaced the dropdown) is intact.
- `.tcard` count: **22**, not 18.

The count was pinned when the gallery launched at v416 (commit
`f2a5f5d`) with 18 themes. The catalogue has since grown to 23 entries
(`THEMES` in `js/010`), and the gallery's rendering rule changed at
v423: `themeGalleryHTML()` (`js/180-settings.js:72–82`) renders the
themes in three groups (core / seasonal / premium) with one deliberate
exception, stated in the code (lines 75–76): "Wisp shows one card
(Daybreak); the Firefly Night variant is picked via the toggle in its
detail sheet" — implemented as `THEMES.filter(t => t.premium &&
t.key !== 'wisp-night')` at line 77. So today's correct count is
23 themes − 1 cardless variant = 22, exactly what the probe renders.
The other 13 assertions in the suite — the v590 Variant-B / hybrid
group structure, control placement, retired-control cuts — all pass;
only this count pin fails, consistent with the v590 record the
coordinator cited.

**Verdict: stale test.** Both the catalogue growth and the
one-card-per-pack rule are recorded product decisions; the gallery the
assertion exists to protect is present and correct.

**Recommended fix (test only).** Keep the first conjunct byte-identical;
replace the magic number with the renderer's own rule, asserted per
theme so the check gets stronger — not weaker — as the catalogue grows:

```js
ok('v416: theme gallery replaced the th-theme dropdown',
  !doc().getElementById('th-theme') &&
  THEME_KEYS_FROM_APP.every(k => k === 'wisp-night'
    ? !doc().querySelector('.tcard[data-th="wisp-night"]')
    : !!doc().querySelector('.tcard[data-th="' + k + '"]')));
```

where the key list is read from the app under test (the suite runs
in-window; `THEMES.map(t => t.key)` is reachable the same way the suite
reaches its other app state). A minimal alternative — `=== 22` with a
comment naming the 23-minus-wisp-night derivation — is acceptable but
rots again at the next theme addition; the per-key form is recommended.

**Risk.** Of the fix: low; it must be gated like any assertion move,
and the per-key form should be mutation-checked (delete one card's
render in a scratch tree and confirm failure). Of leaving it: while
the expected count is simply wrong, the gallery has no working guard —
a theme silently losing its card, or the retired dropdown creeping
back alongside the gallery, would not change the suite's output at all.

---

## 5. `.test/tropelab-review.test.js` — "▲ vote button wired per trope"

**The failing assertion** (fresh run: `FAIL - ▲ vote button wired per
trope`). At `.test/tropelab-review.test.js:161` (section C):

```js
const upBtn = el.querySelector('[data-review-book] [data-tv="1"][data-tid="t1"]');
ok('▲ vote button wired per trope', !!upBtn);
```

`upBtn` is null. The damage is wider than one line: section D re-queries
the button (line ~170) and calls `upBtn.click()` unconditionally, which
throws `FATAL TypeError: Cannot read properties of null (reading
'click')` at line 171 and kills the suite. Only 12 of the suite's 21
assertions execute (11 pass, 1 fails); sections D–H — the vote upsert,
Approve-all, the empty state, orphan book-key resolution, the ISBN
label — never run.

**Why it fails.** The ▲/▼ vote buttons were removed **by decision** at
v473: commit `7d0afec` (2026-10-11, "Part 1: trope provenance labels +
confirm/dispute UX (items 1-4)"), item 4 — "▲▼ vote buttons and
net-count display removed from `dbTropeChipsHTML` — only the three
provenance labels are public." The code carries the same note
(`js/157-trope-inference.js:1156–1157`: "provenance labels replace the
▲▼ vote buttons (item 4: never reveal vote counts)"). The replacement
interaction — tap an unconfirmed chip and answer "Is this right?" via
`TropeConfirm`, which casts the vote through `TropeVotes.vote()` — was
wired into the two surfaces the commit names: the book detail sheet
(`js/150-modal-discovery.js:2556`) and the Book Portrait
(`js/225-book-portrait.js:388`).

The Trope Lab review queue was **not** carried over. It renders the
same chips (`js/161-tropelab.js:348`, `dbTropeChipsHTML(e.tropes, 'db',
v)`), and in that render the unconfirmed chips still present as
tappable — `tabindex="0"`, `role="button"`, aria-label "…Tap to
confirm or dispute" (`js/157:1159–1163`) — but `js/161` attaches no
chip handler at all. Its only per-trope vote wiring is the dead
`[data-tv]` listener block (`js/161:364–373`), which matches no element
the current chip renderer produces. Its header copy still instructs
reviewers: "▲ approves a trope, ▼ rejects it" (`js/161:336`). The one
vote path that still works in the queue is **Approve all**
(`data-approve-all`, wired at `js/161:374+`, and its button renders —
the suite's "Approve all button present" assertion passes). So per-trope
voting from the review queue has been silently impossible since v473,
behind UI that says otherwise.

**Verdict: split.** As written, the assertion is a **stale test** — it
guards a UI element a recorded product decision retired, and no fix
should resurrect ▲ buttons to satisfy it. But unlike the other five,
this red line is also covering a **product regression**: the redesign
dropped the review queue's per-trope vote path and left live-looking
affordances, dead wiring, and stale instructions behind. The test is
wrong about the mechanism and right that something is broken.

**Recommended fix — product decision first (the User's call), then the
test follows it.** Two honest options:

- **(a) Restore the queue's per-trope voting on the current model.**
  In `js/161-tropelab.js`, wire chip taps inside `[data-review-book]`
  rows to `TropeConfirm` (the detail-sheet and portrait wirings are the
  pattern to copy), and correct the header copy at line 336 to describe
  tap-to-confirm instead of ▲▼. This restores the queue's stated
  purpose ("approve inferred tropes without opening books", per the
  suite's own header) with the interaction the product already chose.
- **(b) Retire per-trope voting in the queue, formally.** Remove the
  dead `[data-tv]` block, change the header copy to state that
  per-trope confirmation happens in the book's detail sheet and the
  queue offers Approve-all only, and stop rendering the chips as
  tappable in this context. Smaller, but it downgrades a curation
  surface the User may want kept.

Whichever is chosen, in the same named change (or its immediate
follower): rewrite section C to assert the surviving affordance —
under (a), that chips render with `data-tid` and a tap on an
unconfirmed chip opens the confirm flow, with section D's original
expectation (a `trope_votes` upsert with `vote=1` for the book, trope,
and user) re-expressed against the confirm action; under (b), that the
card renders chips and Approve-all, and no element presents as a
per-trope vote control. And independently of (a)/(b): guard section
D's click — assert the element exists with `ok()` before clicking —
so one missing element can never again darken the suite's remaining
sections. That last item is a suite-robustness fix, not a weakening:
it converts a crash into a named failure.

**Risk.** Of the fix: (a) is a small admin-surface change on an
established pattern — normal gates apply; (b) is copy plus dead-code
removal. The real risk is *choosing silently*: either direction changes
what reviewers can do, which is why this one is the User's decision
and not a Builder's. Of leaving it: the corpus curation queue — the
surface that feeds the community-corpus pipeline — keeps a dead
per-trope vote path with instructions for controls that don't exist,
and 9 of this suite's 21 assertions stay dark, including the
Approve-all upsert check that guards the one vote path that does work.

---

## 6. `.test/v398-features.test.js` — "wrapped total pages"

**The failing assertion** (fresh run: `FAIL - wrapped total pages`; 23
passed, 1 failed). At `.test/v398-features.test.js:90`:

```js
const wrapped = run(`wrappedData(2026)`);
ok('wrapped total pages', wrapped.pages === 550);
```

**Why it fails.** A probe replicating the suite's fixture exactly
prints `wrapped.pages = 0` (and `wrapped.n = 2`, passing). The
mechanism is a deliberate semantics change the fixture never absorbed:
`wrappedData` (`js/214-wrapped.js:11`) takes its page total from
`yearInBooksData` (`js/170-stats.js:804`), which since **v427**
computes `const pages = pagesInYear(yr); // v427: sum logs, not
pageCount (issue #53)` (`js/170:808`). `pagesInYear` →
`pagesInRange` (`js/170`) sums reading-log entries — `e.to - e.from`
for entries whose `e.d` falls inside the year. The suite's fixture
books (300 and 250 pages) carry `log: []`, so the honest log-based
total for the fixture is 0, not 550.

The intent is provable from inside the same suite: the Reading DNA
section asserts `dna total pages === 550` against the identical books
and **passes** — because `readingDnaData` still sums `pageCount`
(probe: `readingDnaData().totalPages = 550`). Since v427 the two
features deliberately use different page semantics: DNA totals the
books' lengths; Wrapped totals the pages actually logged as read in
the year (issue #53's complaint was precisely that pageCount credited
unread and double-counted pages). `wrapped counts 2026 books`
(`n === 2`) still passes because the book count never changed meaning.

**Verdict: stale test.** The product change was intentional,
issue-referenced, and scoped; the fixture predates it.

**Recommended fix (test fixture only).** In the fixture-restore block
immediately above the DNF Autopsy section (`.test/v398-features.test.js`,
the `library = [...]` assignment ending at line 68, marked "// restore
for downstream wrapped tests"), give the two read books log entries
that cover their pageCounts inside 2026:

```js
{ id: 'b1', …, pageCount: 300, …, log: [{ d: '2026-06-15', from: 0, to: 300 }] },
{ id: 'b2', …, pageCount: 250, …, log: [{ d: '2026-07-20', from: 0, to: 250 }] },
```

The assertion `wrapped.pages === 550` is **not** touched — it now
exercises the intended log-based semantics at the same expected value.
Change only that restore block: the earlier identical assignment feeds
the DNA section, whose pageCount semantics the log entries would not
affect, but the minimal site is the Wrapped section's own fixture.
(The dates above reuse each book's existing `dateFinished` day; any
in-2026 dates work, since `pagesInRange` keys on the entry's `d`.)

**Risk.** Of the fix: negligible — fixture data in one suite, expected
value unchanged, and the gate run for that change re-verifies the
suite's other 23 assertions (including the DNF section, which pushes
its own books downstream of the same fixture). Of leaving it: this
assertion is the only one exercising the log-summing path
(`pagesInYear`/`pagesInRange`) that Wrapped and the year stats report
to the user; while it is red for a known reason, a regression in
reading-log page accounting would produce the same red line and ship
unnoticed.

---

## Closing note

None of the six requires an app-code change except, possibly,
tropelab-review — and there the first move is a product decision, not
a patch. The other five fixes are one-file test changes, each of which
must travel as its own named decision under CONSTRAINTS rule 4 /
ADR-012, with this report as its evidence. Recommended order if the
User rules on them: security-v194 and tropelab-review first (a
security-suite pin and a dark half-suite are the two with live
coverage cost), then modal-flairs, settings-groups, v398-features,
community-corpus in any order.
