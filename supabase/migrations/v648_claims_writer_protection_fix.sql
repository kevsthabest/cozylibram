-- v648: write_trope_claims — protection classification fails closed.
--
-- Corrects one predicate in the v647 writer (applied 2026-11-04; the
-- correction was caught the same day by the apply probe pack, before
-- any production call). v647 classified a confirmed claim as protected
-- with `not (source_type = 'ai' and evidence.auto_confirmed = true)`.
-- Postgres three-valued logic defeats that shape: for the 27 live
-- confirmed ai claims whose evidence is the processor's chapter shape
-- (an object with no auto_confirmed key at all), the inner comparison
-- is NULL, the NOT is NULL, and the row fell out of the protected set —
-- a processor run would have inserted a duplicate beside it instead of
-- skipping it (the table has no (work_id, trope_id) uniqueness to
-- catch that). The delete set already used the provable form (only
-- equality with 'true' regenerates); the protected set now mirrors it
-- exactly: a confirmed claim is protected unless it is provably an
-- auto-confirmed ai row, so keyless, false, and non-ai evidence all
-- protect. Everything else is the v647 function verbatim.

create or replace function public.write_trope_claims(
  p_work_id uuid,
  p_claims jsonb,
  p_model text,
  p_input_hash text,
  p_taxonomy_version int,
  p_taxonomy_rev int
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
  v_written text[] := '{}';
  v_confirmed text[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_rejected text[] := '{}';
  v_protected text[] := '{}';
  v_claim jsonb;
  v_trope text;
  v_conf numeric;
  v_quotes jsonb;
  v_quote text;
  v_clean_quotes jsonb;
  v_auto boolean;
  v_seen text[] := '{}';
begin
  if v_me is null then
    raise exception 'write_trope_claims: sign-in required';
  end if;
  if p_work_id is null or not exists (select 1 from public.works w where w.id = p_work_id) then
    raise exception 'write_trope_claims: unknown work';
  end if;
  if p_claims is null or jsonb_typeof(p_claims) <> 'array' then
    raise exception 'write_trope_claims: claims must be an array';
  end if;
  if jsonb_array_length(p_claims) > 200 then
    raise exception 'write_trope_claims: batch too large';
  end if;

  -- The work's existing claims, classified once.
  select coalesce(array_agg(c.trope_id), '{}')
    into v_rejected
    from public.book_trope_claims c
   where c.work_id = p_work_id and c.status = 'rejected';
  select coalesce(array_agg(c.trope_id), '{}')
    into v_protected
    from public.book_trope_claims c
   where c.work_id = p_work_id and c.status = 'confirmed'
     and (c.source_type <> 'ai'
          or (c.evidence -> 'auto_confirmed') is distinct from 'true'::jsonb);

  -- The replace: delete exactly the ai regenerable set.
  delete from public.book_trope_claims c
   where c.work_id = p_work_id and c.source_type = 'ai'
     and (c.status = 'candidate'
          or (c.status = 'confirmed'
              and (c.evidence -> 'auto_confirmed') = 'true'::jsonb));

  for v_claim in select value from jsonb_array_elements(p_claims) loop
    v_trope := v_claim ->> 'trope_id';
    if v_trope is null or v_trope = '' then
      v_skipped := v_skipped || jsonb_build_object('trope_id', v_trope, 'reason', 'missing trope_id');
      continue;
    end if;
    if v_trope = any (v_seen) then
      continue; -- first proposal for a trope wins; duplicates are noise
    end if;
    v_seen := v_seen || v_trope;
    if v_trope = any (v_rejected) then
      v_skipped := v_skipped || jsonb_build_object('trope_id', v_trope, 'reason', 'rejected');
      continue;
    end if;
    if v_trope = any (v_protected) then
      v_skipped := v_skipped || jsonb_build_object('trope_id', v_trope, 'reason', 'already confirmed');
      continue;
    end if;
    if not exists (select 1 from public.tropes t where t.id = v_trope) then
      v_skipped := v_skipped || jsonb_build_object('trope_id', v_trope, 'reason', 'unknown trope');
      continue;
    end if;
    begin
      v_conf := (v_claim ->> 'confidence')::numeric;
    exception when others then
      v_conf := null;
    end;
    if v_conf is null or v_conf < 0 or v_conf > 1 then
      v_skipped := v_skipped || jsonb_build_object('trope_id', v_trope, 'reason', 'confidence out of range');
      continue;
    end if;
    -- Evidence quotes: an array of strings, trimmed, non-empty,
    -- count- and length-capped. Anything else is not evidence.
    v_clean_quotes := '[]'::jsonb;
    v_quotes := coalesce(v_claim -> 'evidence', '[]'::jsonb);
    if jsonb_typeof(v_quotes) = 'array' then
      for v_quote in select value #>> '{}' from jsonb_array_elements(v_quotes)
                      where jsonb_typeof(value) = 'string' loop
        if length(trim(v_quote)) > 0 and jsonb_array_length(v_clean_quotes) < 20 then
          v_clean_quotes := v_clean_quotes || jsonb_build_array(left(trim(v_quote), 1000));
        end if;
      end loop;
    end if;

    v_auto := v_conf >= 0.85 and jsonb_array_length(v_clean_quotes) > 0;

    insert into public.book_trope_claims
      (work_id, trope_id, status, confidence, source_type, source_id,
       model, model_version, evidence)
    values
      (p_work_id, v_trope, case when v_auto then 'confirmed' else 'candidate' end,
       v_conf, 'ai', v_me::text,
       left(p_model, 200), null,
       jsonb_build_object(
         'taxonomy_version', p_taxonomy_version,
         'taxonomy_rev', p_taxonomy_rev,
         'evidence', v_clean_quotes,
         'input_hash', left(p_input_hash, 200),
         'auto_confirmed', v_auto));

    v_written := v_written || v_trope;
    if v_auto then
      v_confirmed := v_confirmed || v_trope;
    end if;
  end loop;

  return jsonb_build_object(
    'written', to_jsonb(v_written),
    'confirmed', to_jsonb(v_confirmed),
    'skipped', v_skipped);
end;
$function$;

revoke execute on function public.write_trope_claims(uuid, jsonb, text, text, int, int) from public, anon;
grant execute on function public.write_trope_claims(uuid, jsonb, text, text, int, int) to authenticated, service_role;

-- ------------------------------------------------------------------
-- Direct inserts close — both of them. The writer is now the only
-- client path onto this table: the auto-confirmed policy's v636
-- shape check has nothing left to guard once no client insert may
-- carry 'confirmed', and the candidates policy's premise (other
-- flows write candidates directly) no longer exists — after this
-- change no flow in the tree inserts into book_trope_claims
-- directly, so keeping it would leave a dead-but-live write surface
-- that lets any signed-in user insert unbounded ai candidate rows
-- at will. (Gate condition, Security Advisor review of PR #421:
-- close it in this same migration.)
-- ------------------------------------------------------------------
drop policy if exists "claims: user insert ai auto-confirmed" on public.book_trope_claims;
drop policy if exists "claims: user insert ai candidates" on public.book_trope_claims;

-- ------------------------------------------------------------------
-- The DELETE arm narrows to candidates (#362's remaining half).
-- Confirmed claims become deletable only by admins (the is_admin
-- ALL policy) or by the writer itself during a replace cycle.
-- The policy keeps its name — it still governs client replacement
-- deletes — with the confirmed arm removed from its qual.
-- ------------------------------------------------------------------
drop policy if exists "claims: user replace ai regenerable" on public.book_trope_claims;
create policy "claims: user replace ai regenerable"
  on public.book_trope_claims
  for delete to authenticated
  using (source_type = 'ai' and status = 'candidate');
