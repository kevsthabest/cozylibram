# CONSTRAINTS.md — Cozy Libram (booktok)

**Repo:** kevsthabest/cozylibram (`~/workspace/booktok`)
**Created:** 2026-10-14 · **Baseline measured:** 2026-10-14, main @ `2f5c59d` (APP_VERSION v537)

Maintained per the `constraint-driven` skill. **Any change to a number or rule in this file is a named decision** — it happens in its own reviewed change, with the reason stated, never folded silently into a fix.

---

## Pre-existing test-failure baseline

The suite is 178 files in `.test/`, each run standalone with `node`. Measured serially on the checkout above, exactly **6 files fail**:

| # | File | Failing assertion (as reported) |
|---|---|---|
| 1 | `.test/community-corpus.test.js` | version bumped past v474 |
| 2 | `.test/modal-flairs.test.js` | signature table matches the approved mapping (23 themes) |
| 3 | `.test/security-v194.test.js` | sw: vendor precache list present |
| 4 | `.test/settings-groups.test.js` | subsections exist inside groups; v416 theme gallery replaced the th-theme dropdown |
| 5 | `.test/tropelab-review.test.js` | ▲ vote button wired per trope |
| 6 | `.test/v398-features.test.js` | wrapped total pages |

**Reconciliation (2026-10-14):** this matches the latest recorded baseline of exactly 6 failures. The "7 baseline failures" figure quoted in the 2026-10-14 skills audit was **not reproduced** — the measured count is 6.

**Measurement rule:** run the suite serially (or treat parallel failures as suspects). Under 6-way parallel load, `.test/cover-adoption-closure.test.js`, `.test/import.test.js`, and `.test/orbitcapture.test.js` fail on timeouts but pass serially — they are **not** baseline failures.

These 6 are baseline: they pre-date your change, they are not yours to fix in passing, and a run is "green" when it shows exactly these 6 and no new failures.

## Standing rules

1. **BOOKTOK_DIR outside the main checkout.** Test suites default their ROOT to the main checkout. When running tests from a worktree or branch checkout, `export BOOKTOK_DIR=<that worktree>` first — otherwise you have tested main, not your change, and the result proves nothing.
2. **Version pairing.** `APP_VERSION` (`js/181-appversion.js`) and the `CACHE` name in `sw.js` bump together, in the same change, to the same version. Tests pin the pair; a mismatch is a failure you introduced.
3. **Frozen settings keys.** Existing `user_state` / settings keys are never renamed or repurposed. New behavior gets a new key; old keys keep their meaning for every already-synced device.
4. **No drive-by test fixes.** Never weaken, skip, delete, or re-baseline a test — and never move a threshold, count, or config value — to make a run green. Baseline failures stay as listed above until a named decision (see header) changes them. If your change genuinely requires a test or threshold to move, that movement is a separate, explicitly reviewed decision, stated in the PR.
5. **Security Advisor gate before merge.** No merge to main without the Security Advisor's verdict. PASS / PASS_WITH_RISK proceeds (on the auto-ship lane, for qualifying bug fixes); BLOCKED escalates to Kevin.
