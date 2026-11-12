-- v654: book_tropes write policies + guard completion (#358).
--
-- DRAFT — not applied. Gate: Security Advisor review, then the
-- User's named approval to apply. Drafted 2026-11-12 against the
-- live database (policies, trigger bodies, constraints and row
-- census re-read the same day; the gap below is current, not
-- remembered).
-- The v654 number is a draft allocation and renames cleanly if
-- the landing sequence changes it.
--
-- The gap: v636 guarded book_tropes with a trigger
-- (book_tropes_update_guard) that freezes the identity columns
-- (book_key, trope_id) and the vote tallies for non-admin
-- writers, and stamps created_by on insert — but the UPDATE
-- policy's qual is still `true`. Any signed-in user can therefore
-- UPDATE every row's confidence, model, taxonomy_version,
-- taxonomy_rev, source, or created_by at will: re-badge the whole
-- llm corpus as 'community' (the source readers trust most),
-- rewrite the model provenance, or pin confidence wherever they
-- like on other people's books. The INSERT policy is no better:
-- it checks only that source is 'llm' or 'community', so a fake
-- row is born at confidence 1.0 with arbitrary vote tallies
-- already attached.
--
-- What already binds, said plainly so the delta is reviewable:
-- table CHECKs already hold confidence to 0–1 and source to the
-- two values (book_tropes_confidence_check,
-- book_tropes_source_check), and trope_id has an FK to the
-- taxonomy. What they cannot express is a rule about a row's
-- BIRTH (tallies must start at zero — votes accrue in
-- trope_votes, never at insert) or about WHO may move a row
-- between sources. Those are policy/trigger rules; they are this
-- file.
--
-- The three moves:
--   1. INSERT ("book_tropes: seed upsert"): WITH CHECK gains
--      upvotes = 0 and downvotes = 0 (a fresh row is born
--      voteless — every legitimate writer already does this: the
--      js/157 seeding rows and both approval upserts omit the
--      tallies entirely and take the column defaults), and the
--      'community' source is reserved to admins (source = 'llm'
--      OR is_admin()). A row may not be BORN community from a
--      non-admin caller.
--   2. UPDATE ("book_tropes: seed update"): qual `true` becomes
--      (source = 'llm' OR is_admin()) — a community row is
--      admin-only to update, full stop — and WITH CHECK gains
--      (source = 'llm' OR is_admin()) on the new row, so a
--      non-admin update can neither flip a row to 'community'
--      nor keep editing one.
--   3. The guard trigger learns the two columns v636 left out:
--      created_by is frozen for non-admin writers (it is the
--      provenance stamp; the insert trigger sets it, nobody
--      rewrites it), and a 'community' row's source cannot change
--      under a non-admin writer at all (no demotion) — the
--      trigger-level belt to the policy's braces, in the same
--      function, keeping its service_role/is_admin() bypass.
--   Plus the tally ranges the table never had: upvotes and
--   downvotes get CHECK (>= 0), binding every writer including
--   future ones. Confidence and source ranges are NOT
--   re-added — their CHECKs already exist (named above).
--
-- Legitimate flows, checked against the client before drafting:
--   * js/157's inference seeding (upsertRows): upserts
--     source = 'llm' rows carrying confidence/model/taxonomy,
--     never tallies. Insert leg: llm + default-zero tallies pass.
--     Conflict-update leg on an existing llm row: qual sees the
--     old row's source = 'llm', WITH CHECK sees the new row's —
--     both pass, and the guard already froze identity/tallies
--     for this flow in v636.
--   * The two community approval upserts (js/157 taxonomy
--     approval at confidence 0.85, js/224 curation console at
--     0.7): both are admin surfaces, and admins pass every new
--     clause via is_admin().
--   * Votes: unaffected. trope_votes keeps its own policies; the
--     book_tropes tallies are written by no client flow today
--     (live census: all 225 rows sit at 0/0).
--
-- Known interaction, stated rather than discovered later: a
-- NON-admin re-inference upsert whose batch touches a book that
-- has a community row for the same (book_key, trope_id) now
-- fails that row's update leg instead of silently demoting it
-- back to 'llm' — the demotion IS the bug being closed, and the
-- failure is the safe side. Today there are ZERO community rows
-- in the live table (all 225 are 'llm'), so nothing changes on
-- day one; if the pattern ever bites in practice, the client-side
-- refinement is to exclude community-held pairs from seeding
-- batches. Flagged here for the Advisor; not solved in SQL.
--
-- Judgment call, named and severable: reserving the 'community'
-- source (at insert, and via the update rules) to admins rests on
-- the evidence that the only two writers of community rows in the
-- client are the admin surfaces named above. If the Advisor
-- knows a legitimate non-admin community flow, dropping the
-- three (source = 'llm' OR is_admin()) clauses still leaves the
-- zero-tally birth rule, the created_by freeze, the demotion
-- freeze and the tally CHECKs standing — the file is written so
-- those clauses lift out cleanly.
--
-- Live-data check (2026-11-12): 225 rows; zero rows violate the
-- new CHECKs (no negative tallies; confidence already
-- range-bound by its existing CHECK), so the ALTERs validate
-- immediately. created_by is NULL on 219 legacy rows — the
-- freeze compares with IS DISTINCT FROM, so NULL stays writable
-- to NULL and the legacy rows are not stranded.
--
-- Re-runnable posture (v618/v636 idiom): create-or-replace for
-- the guard function, drop-if-exists + create for the two
-- policies. The two CHECK constraints are plain ADDs (their
-- names are the record; a partial-apply re-run drops the
-- same-named constraint first, per the apply runbook pattern).
-- No existing data is touched.

-- ------------------------------------------------------------------
-- 1 + 2: the policies.
-- ------------------------------------------------------------------

drop policy if exists "book_tropes: seed upsert" on public.book_tropes;
create policy "book_tropes: seed upsert"
  on public.book_tropes
  for insert
  to authenticated
  with check (
    source = any (array['llm', 'community'])
    and upvotes = 0
    and downvotes = 0
    and (source = 'llm' or public.is_admin())
  );

drop policy if exists "book_tropes: seed update" on public.book_tropes;
create policy "book_tropes: seed update"
  on public.book_tropes
  for update
  to authenticated
  using (source = 'llm' or public.is_admin())
  with check (
    source = any (array['llm', 'community'])
    and (source = 'llm' or public.is_admin())
  );

-- ------------------------------------------------------------------
-- 3: the guard learns created_by and community-source demotion.
-- Everything v636 froze stays frozen, verbatim.
-- ------------------------------------------------------------------

create or replace function public.book_tropes_guard_update()
returns trigger
language plpgsql
as $function$
begin
  if auth.role() = 'service_role' or public.is_admin() then
    return new;
  end if;
  if new.book_key is distinct from old.book_key
     or new.trope_id is distinct from old.trope_id
     or new.upvotes is distinct from old.upvotes
     or new.downvotes is distinct from old.downvotes then
    raise exception 'book_tropes: identity columns and vote tallies are not client-writable';
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'book_tropes: created_by is server-stamped provenance and is not client-writable';
  end if;
  if old.source = 'community' and new.source is distinct from old.source then
    raise exception 'book_tropes: a community row cannot be demoted by a non-admin writer';
  end if;
  return new;
end;
$function$;

-- ------------------------------------------------------------------
-- The tally ranges (confidence and source already carry theirs).
-- ------------------------------------------------------------------

alter table public.book_tropes
  add constraint book_tropes_upvotes_check
  check (upvotes >= 0);

alter table public.book_tropes
  add constraint book_tropes_downvotes_check
  check (downvotes >= 0);
