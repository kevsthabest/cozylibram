-- v653: server-side catalogue registration for works/editions
-- (#363) — a SECURITY DEFINER register_work() replaces the
-- presence-only user INSERT policies.
--
-- DRAFT — not applied. Gate: Security Advisor FULL review, then
-- the User's named approval to apply. Drafted 2026-11-12 against
-- the live database (policies and schemas re-read the same day;
-- the gap below is verbatim, not remembered).
-- The v653 number is a draft allocation and renames cleanly if
-- the landing sequence changes it.
--
-- *** CLIENT-VISIBLE CONTRACT CHANGE — READ BEFORE APPLY ***
-- This file drops the "works: user insert" and "editions: user
-- insert" policies. From the moment it applies, the ONLY way a
-- signed-in client can register a work or edition is
-- public.register_work() below. The current client does not call
-- it yet: WorkStore.resolve() (js/158) upserts works and editions
-- directly. A COMPANION CLIENT CHANGE IS REQUIRED — resolve()
-- must call register_work (and retire _mergeProviderIds' direct
-- provider_ids UPDATE, which this design absorbs server-side) —
-- and per the v643 rollout pattern the tolerant client ships
-- FIRST: it should prefer the RPC and fall back to the direct
-- upserts while the policies still exist. Do NOT apply this file
-- before that client release is live. If it were applied early,
-- resolve() would fail closed (it already returns null on any
-- error and the legacy book_key path keeps the UI working), but
-- corpus resolution would stall for every user until the client
-- caught up.
--
-- The gap: the two user INSERT policies check presence only —
-- works asks title_norm non-empty, editions asks work_id + isbn
-- non-empty. Any signed-in user can therefore register a work
-- under any title/author pair with provider_ids and spice fields
-- pre-filled, and squat any ISBN by attaching it to a work of
-- their choosing (editions.isbn is UNIQUE, so the first
-- registration wins the ISBN for the whole corpus). Nothing
-- validates the ISBN's shape or check digit, nothing owns the
-- pipeline columns, and once a poisoned row exists there is no
-- correction path short of an admin.
--
-- What register_work() does instead (one call, the js/158
-- resolve() contract):
--   * Caller gate: auth.uid() is required; the function never
--     reads an owner from its arguments (there is none to read).
--   * Identity validation: title and title_norm must be non-empty;
--     authors must be a jsonb array of strings (empty is allowed —
--     anonymous/traditional works are real); series, when present,
--     must be an object with a non-empty name. What the server
--     still cannot validate: that title_norm/author_norm are the
--     client's canonical normalisation — that convention lives in
--     the client's normaliser (tropeNormIdent) and porting it
--     server-side is a different piece of work. The server owns
--     shape and uniqueness, not spelling.
--   * Find-or-create the work on its natural key
--     (title_norm, author_norm) — the table's UNIQUE pair — so a
--     registration can never duplicate or hijack an existing
--     work's identity; a second registrant gets the same id.
--   * provider_ids move to server ownership: the client PROPOSES,
--     the server disposes. Only the two keys the corpus uses are
--     accepted (hardcover_id, any non-empty string; openlibrary_id,
--     only in its canonical /works/OL…W shape — the exact
--     conventions of providerIdsFromBook in js/158); anything else
--     is dropped, never stored. On an existing work the merge is
--     fill-missing only: a registration can attach a provider id
--     the work lacks, never overwrite one it carries. (Today the
--     client's direct UPDATE for this silently no-ops for
--     non-admins — there is no user UPDATE policy on works — so
--     this also makes the v272 identity hub actually function.)
--   * The spice columns (spice_detected, spice_manual) and the
--     analysis fields are never written by registration: a new
--     work is born with them NULL, owned by the pipeline and by
--     admin writes, exactly as the works_spice_range CHECK era
--     intended. The old insert policy let a registrant pre-fill
--     them; that is the poisoning this closes.
--   * The edition leg is strict where squatting lives: the ISBN
--     is normalised (the client's digit-strip convention, plus
--     the ISBN-10 X) and must pass isbn_is_valid() — shape, 978/
--     979 prefix for ISBN-13, and the real check digit. An
--     invalid ISBN does NOT sink the registration: the work still
--     registers and the result reports isbn = 'rejected' (a bad
--     scan is a client data problem, not a catalogue event). A
--     valid ISBN registers the edition to THIS work — unless the
--     ISBN is already taken by another work's edition, in which
--     case it is never reassigned (the rule the client already
--     states) and the result reports isbn = 'conflict' WITHOUT
--     returning the other work's edition id.
--   * Returns jsonb: { work_id, edition_id, created_work,
--     created_edition, isbn } with isbn one of absent / rejected /
--     registered / existing / conflict, so the companion client
--     can tell exactly what happened — the server-side mirror of
--     resolve()'s current silent-best-effort outcomes.
--
-- Correction of already-poisoned rows: deliberately unchanged.
-- The pre-existing "works: admin write" / "editions: admin write"
-- policies (ALL, is_admin()) already give admins full UPDATE /
-- DELETE on both tables, and the Labs surfaces use them. This
-- draft creates no non-admin correction path; whether one should
-- exist (a definer correction RPC with provenance, say) is a
-- product question named here for the User, not answered here.
--
-- Pipeline note: the ebook processor writes works/editions over
-- its own database connection, not through these policies or this
-- RPC, so tightening the client surface does not touch it.
--
-- Grants (the #357/#420 lesson, applied): this database grants
-- EXECUTE explicitly per role, so every grant and revoke names
-- its roles. register_work is authenticated-only. isbn_is_valid
-- is a pure helper in the book_canonical_json mould — NO client
-- role may execute it, so it is revoked from PUBLIC, anon, AND
-- authenticated explicitly (default privileges would otherwise
-- hand it to authenticated on creation).
--
-- Re-runnable posture (v618/v647 idiom): create-or-replace for
-- both functions, drop-if-exists for the two policies,
-- grants/revokes idempotent. The drops are nonetheless a one-way
-- door in effect: re-creating the user insert policies is a
-- decision, not an accident of re-running this file. No existing
-- data is touched.

-- ------------------------------------------------------------------
-- isbn_is_valid(text): shape + check digit, corpus conventions.
-- Immutable and locked down: a validation helper, not a surface.
-- ------------------------------------------------------------------

create or replace function public.isbn_is_valid(p_isbn text)
returns boolean
language plpgsql
immutable
as $function$
declare
  s text := upper(regexp_replace(coalesce(p_isbn, ''), '[^0-9Xx]', '', 'g'));
  total int := 0;
  i int;
begin
  if length(s) = 13 then
    if s !~ '^[0-9]{13}$' then return false; end if;
    if left(s, 3) not in ('978', '979') then return false; end if;
    for i in 1..13 loop
      total := total + (substr(s, i, 1)::int) * (case when i % 2 = 1 then 1 else 3 end);
    end loop;
    return total % 10 = 0;
  elsif length(s) = 10 then
    if s !~ '^[0-9]{9}[0-9X]$' then return false; end if;
    for i in 1..10 loop
      total := total + (case when substr(s, i, 1) = 'X' then 10 else substr(s, i, 1)::int end) * (11 - i);
    end loop;
    return total % 11 = 0;
  end if;
  return false;
end;
$function$;

revoke execute on function public.isbn_is_valid(text) from public;
revoke execute on function public.isbn_is_valid(text) from anon;
revoke execute on function public.isbn_is_valid(text) from authenticated;

-- ------------------------------------------------------------------
-- register_work(...): find-or-create a work (and its edition)
-- with the validation and ownership rules in the header.
-- ------------------------------------------------------------------

create or replace function public.register_work(
  p_title text,
  p_title_norm text,
  p_authors jsonb,
  p_author_norm text,
  p_series jsonb,
  p_isbn text,
  p_provider_ids jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
  v_work_id uuid;
  v_edition_id uuid;
  v_existing_work uuid;
  v_created_work boolean := false;
  v_created_edition boolean := false;
  v_isbn text;
  v_isbn_state text := 'absent';
  v_ids jsonb := '{}'::jsonb;
  v_val text;
begin
  if v_me is null then
    raise exception 'register_work: an authenticated caller is required';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'register_work: a title is required';
  end if;
  if p_title_norm is null or btrim(p_title_norm) = '' then
    raise exception 'register_work: a normalised title is required';
  end if;
  if p_authors is null or jsonb_typeof(p_authors) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_authors) as e(val)
                 where jsonb_typeof(e.val) <> 'string') then
    raise exception 'register_work: authors must be an array of strings';
  end if;
  if p_series is not null
     and (jsonb_typeof(p_series) <> 'object'
          or coalesce(btrim(p_series ->> 'name'), '') = '') then
    raise exception 'register_work: series must be an object with a name';
  end if;

  -- Provider ids: only the two corpus keys, each in its
  -- conventional shape; anything else is dropped, never stored.
  if p_provider_ids is not null and jsonb_typeof(p_provider_ids) = 'object' then
    v_val := p_provider_ids ->> 'hardcover_id';
    if v_val is not null and btrim(v_val) <> '' then
      v_ids := v_ids || jsonb_build_object('hardcover_id', btrim(v_val));
    end if;
    v_val := p_provider_ids ->> 'openlibrary_id';
    if v_val is not null and v_val ~ '^/works/OL[0-9]+W$' then
      v_ids := v_ids || jsonb_build_object('openlibrary_id', v_val);
    end if;
  end if;

  -- Find-or-create on the natural key. DO NOTHING + select is the
  -- race-honest shape: the UNIQUE pair arbitrates, never the
  -- client's timing.
  insert into public.works (title, title_norm, authors, author_norm, series, provider_ids)
  values (btrim(p_title), btrim(p_title_norm), p_authors,
          coalesce(p_author_norm, ''), p_series, v_ids)
  on conflict (title_norm, author_norm) do nothing
  returning id into v_work_id;

  if v_work_id is null then
    select id into v_work_id
      from public.works
     where title_norm = btrim(p_title_norm)
       and author_norm = coalesce(p_author_norm, '');

    -- Fill-missing only: attach provider ids the work lacks,
    -- never overwrite ones it already carries.
    if v_ids <> '{}'::jsonb then
      update public.works w
         set provider_ids = w.provider_ids || coalesce((
               select jsonb_object_agg(e.key, e.value)
                 from jsonb_each(v_ids) e
                where not (w.provider_ids ? e.key)
             ), '{}'::jsonb)
       where w.id = v_work_id
         and exists (select 1 from jsonb_each(v_ids) e
                      where not (w.provider_ids ? e.key));
    end if;
  else
    v_created_work := true;
  end if;

  -- The edition leg: strict, because editions.isbn is the
  -- squattable asset. A bad ISBN never sinks the work.
  if p_isbn is not null and btrim(p_isbn) <> '' then
    v_isbn := upper(regexp_replace(p_isbn, '[^0-9Xx]', '', 'g'));
    if not public.isbn_is_valid(v_isbn) then
      v_isbn_state := 'rejected';
    else
      insert into public.editions (work_id, isbn)
      values (v_work_id, v_isbn)
      on conflict (isbn) do nothing
      returning id into v_edition_id;

      if v_edition_id is not null then
        v_created_edition := true;
        v_isbn_state := 'registered';
      else
        select e.id, e.work_id into v_edition_id, v_existing_work
          from public.editions e
         where e.isbn = v_isbn;
        if v_existing_work = v_work_id then
          v_isbn_state := 'existing';
        else
          -- Never reassign an ISBN, and never hand the caller the
          -- other work's edition id to link against.
          v_edition_id := null;
          v_isbn_state := 'conflict';
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'work_id', v_work_id,
    'edition_id', v_edition_id,
    'created_work', v_created_work,
    'created_edition', v_created_edition,
    'isbn', v_isbn_state
  );
end;
$function$;

revoke execute on function public.register_work(text, text, jsonb, text, jsonb, text, jsonb) from public;
revoke execute on function public.register_work(text, text, jsonb, text, jsonb, text, jsonb) from anon;
grant execute on function public.register_work(text, text, jsonb, text, jsonb, text, jsonb) to authenticated;

-- ------------------------------------------------------------------
-- The one-way door: direct user inserts close. From here on,
-- register_work() is the only client registration path. Apply
-- ONLY with/after the companion client release (see header).
-- ------------------------------------------------------------------

drop policy if exists "works: user insert" on public.works;
drop policy if exists "editions: user insert" on public.editions;
