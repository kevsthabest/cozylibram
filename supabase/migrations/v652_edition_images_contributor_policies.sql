-- v652: edition_images contributor policies + edition_assets
-- sub-score ranges (#364).
--
-- DRAFT — not applied. Gate: Security Advisor review, then the
-- User's named approval to apply. Drafted 2026-11-12 against the
-- live database (policies and constraints re-read the same day;
-- the gap below is verbatim, not remembered).
-- The v652 number is a draft allocation and renames cleanly if the
-- landing sequence changes it.
--
-- The gap, arm 1 — edition_images trusts whatever a caller claims:
-- the table's only INSERT policy ("edition_images authenticated
-- insert") has WITH CHECK true, so any signed-in user can insert a
-- row with verified = true and uploaded_by set to SOMEONE ELSE.
-- The UPDATE and DELETE policies then key ownership on that same
-- self-asserted uploaded_by, so the forgery is load-bearing: plant
-- a row "owned" by another user, marked verified, and the table
-- believes both claims. edition_images is the legacy read model
-- every cover/3D surface still resolves through, so a planted
-- verified row is a planted cover.
--
-- The fix mirrors the posture edition_assets — the newer table —
-- already carries and this one never got: a contributor insert
-- must name the caller (uploaded_by = auth.uid()) and must arrive
-- unverified (verified = false). Once insert pins uploaded_by to
-- the caller, the column stops being an assertion and becomes a
-- fact the server stamped, which is what makes the existing
-- UPDATE/DELETE ownership qual meaningful. The UPDATE policy is
-- additionally tightened so a contributor can only touch their own
-- UNVERIFIED rows and can never produce a verified one — the same
-- shape edition_assets contributor update already uses. The
-- DELETE policy is deliberately left byte-identical: its qual
-- (uploaded_by = auth.uid()) becomes sound the moment insert is
-- pinned, and churning it would add review surface without closing
-- anything.
--
-- Legitimate flows, checked against the client before drafting:
--   * js/206's contributor mirror upsert sets uploaded_by to the
--     caller's own uid and never sets verified — passes the new
--     INSERT check, and its conflict-update leg targets the
--     caller's own unverified row — passes the new UPDATE policy.
--   * js/206's withdraw flow deletes only rows whose stored
--     uploaded_by equals the caller — the kept DELETE qual.
--   * js/165's admin canonical mirror sets verified from the
--     chosen asset. That write is an admin action and rides the
--     pre-existing "edition_images admin write" policy (ALL,
--     is_admin()), which this file does not touch — it does NOT
--     flow through the contributor policies being replaced.
--
-- The gap, arm 2 — edition_assets sub-scores have no ranges: of
-- the eight score columns only quality_score carries a CHECK
-- (0–100). The other seven (sharpness, exposure, perspective,
-- coverage, glare, resolution, stability) accept any numeric a
-- contributor asserts — and they are the quality evidence the
-- curation surfaces (js/165) present for each candidate, so an
-- out-of-range sub-score is a forged quality signal sitting next
-- to a range-checked quality_score. The analyzer that produces
-- them (js/206's editionAnalyzeDataUrl)
-- computes every sub-score on the same 0–100 scale as quality
-- (clamped 0..100 at the source), and the live rows agree
-- (2026-11-12 census: all seven sub-scores within 41–100 across
-- the 25 live rows), so each gets quality_score's exact CHECK
-- shape, NULL included — a capture that could not measure a
-- sub-score stays legitimate.
--
-- Judgment calls deliberately NOT made:
--   * No scrub of the 4 pre-existing edition_images rows. Their
--     uploaded_by values were self-asserted under the old policy
--     (all four are verified = false; three name one account, one
--     names another). Re-stamping or deleting them is a data
--     write with its own decision; this draft only stops new
--     assertions from being believed.
--   * No edition-link EXISTS check was added to the insert policy
--     (edition_assets carries one; edition_images rows can
--     legitimately predate their edition row in the legacy flow).
--     It is a plausible strengthening, named here so the Advisor
--     rules on it explicitly rather than finding it absent later.
--
-- Re-runnable posture (v618/v636 idiom): drop-if-exists +
-- create for the two replaced policies, add-constraint guarded by
-- IF NOT EXISTS semantics via the constraint names below (each
-- ALTER is written to be re-runnable by dropping the same-named
-- constraint first in the apply runbook if a partial apply ever
-- lands one). No existing data is touched.

-- ------------------------------------------------------------------
-- Arm 1: edition_images — pin the insert, tighten the update.
-- ------------------------------------------------------------------

drop policy if exists "edition_images authenticated insert" on public.edition_images;
create policy "edition_images contributor insert"
  on public.edition_images
  for insert
  to authenticated
  with check (uploaded_by = auth.uid() and verified = false);

drop policy if exists "edition_images contributor update" on public.edition_images;
create policy "edition_images contributor update"
  on public.edition_images
  for update
  to authenticated
  using (uploaded_by = auth.uid() and not verified)
  with check (uploaded_by = auth.uid() and verified = false);

-- ------------------------------------------------------------------
-- Arm 2: edition_assets — every sub-score gets quality_score's
-- 0–100 range, NULL still allowed (unmeasured is legitimate).
-- ------------------------------------------------------------------

alter table public.edition_assets
  add constraint edition_assets_sharpness_score_check
  check (sharpness_score is null or (sharpness_score >= 0 and sharpness_score <= 100));

alter table public.edition_assets
  add constraint edition_assets_exposure_score_check
  check (exposure_score is null or (exposure_score >= 0 and exposure_score <= 100));

alter table public.edition_assets
  add constraint edition_assets_perspective_score_check
  check (perspective_score is null or (perspective_score >= 0 and perspective_score <= 100));

alter table public.edition_assets
  add constraint edition_assets_coverage_score_check
  check (coverage_score is null or (coverage_score >= 0 and coverage_score <= 100));

alter table public.edition_assets
  add constraint edition_assets_glare_score_check
  check (glare_score is null or (glare_score >= 0 and glare_score <= 100));

alter table public.edition_assets
  add constraint edition_assets_resolution_score_check
  check (resolution_score is null or (resolution_score >= 0 and resolution_score <= 100));

alter table public.edition_assets
  add constraint edition_assets_stability_score_check
  check (stability_score is null or (stability_score >= 0 and stability_score <= 100));
