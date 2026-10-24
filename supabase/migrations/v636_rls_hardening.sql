-- RLS hardening for the filed policy/RPC holes #340–#343.
-- Rulings of record (User, 2026-10-18): the four fixes approved as a
-- class; #340's insert arm gets a trigger-set provenance column
-- (option (i)); #343 gets its WITH CHECK tightened to the app's own
-- auto-publish rule now, with the server-side confirmed-writer as a
-- named follow-up. Advisor full review gates this file before apply;
-- post-apply, the original #341/#342 demonstration probes must fail
-- against the live state.
--
-- Gate: Security Advisor full review PASS, 2026-10-24, verified
-- against live state (their marker MARKER-RLS-GATE-20261024). Two
-- conditions, both met in this PR: the confirmed-writer follow-up
-- issue also names the claims DELETE arm below, and the two new
-- trigger functions revoke PUBLIC execute in-file rather than
-- joining the #357 sweep population.
--
-- Operational note: repairs run through the Management API arrive
-- as postgres with no JWT, so auth.role() is not 'service_role'
-- there and the #340 update guard DOES apply to sb-query repair
-- UPDATEs on book_tropes — a tally/identity repair must disable
-- book_tropes_update_guard in its session or run via service role.
--
-- Re-runnable posture (v618 idiom): create-or-replace for functions,
-- drop-if-exists for the replaced policy and triggers, add-column-if-
-- not-exists. No data is touched; existing book_tropes rows keep
-- created_by NULL, which reads correctly as "predates provenance".

-- ------------------------------------------------------------------
-- #341: handle_available must refuse unauthenticated callers.
-- Handle availability is authenticated-only by standing ruling; the
-- body read auth.uid() only to nuance the 90-day quarantine and so
-- answered anonymous callers. No legitimate anon caller exists (the
-- signup form deliberately never checks availability).
-- ------------------------------------------------------------------
create or replace function public.handle_available(p_handle text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_owner uuid;
  v_rel timestamptz;
begin
  if v_me is null then return false; end if;
  if v_h !~ '^[a-z0-9_]{3,20}$' then return false; end if;
  if public.handle_screen_hit(v_h, 'handle') is not null then return false; end if;
  if exists (select 1 from public.profiles where lower(handle) = v_h) then
    return false;
  end if;
  select owner_id, released_at into v_owner, v_rel
    from public.handle_history
   where handle = v_h
   order by released_at desc
   limit 1;
  if v_rel is not null and v_rel > now() - interval '90 days'
     and (v_me is null or v_owner <> v_me) then
    return false;
  end if;
  return true;
end;
$function$;

revoke execute on function public.handle_available(text) from anon;

-- ------------------------------------------------------------------
-- #342: buddy_reading_state must refuse unauthenticated callers.
-- As filed, the SECURITY DEFINER body takes the target user as a
-- plain argument and never looks at the caller, so anyone holding
-- the publishable key could read any user's per-book reading status.
-- The app has no caller for this function (the buddy UI uses
-- buddy_states); signed-in posture matches its sibling RPCs.
-- ------------------------------------------------------------------
create or replace function public.buddy_reading_state(p_user uuid, p_key text)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select case
    when auth.uid() is null then null
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'read'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'finished'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'reading'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'reading'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' in ('tbr', 'wishlist')
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'not_started'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'dnf'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'set_aside'
    else null
  end;
$function$;

revoke execute on function public.buddy_reading_state(uuid, text) from anon;

-- ------------------------------------------------------------------
-- #340: book_tropes — provenance on insert, identity/tally guard on
-- update. The write policies are deliberately open (the app's
-- inference dual-write and the admin curation flows all write as
-- plain authenticated users), so the holes close at the row level:
-- a forged 'llm' insert cannot be prevented without rerouting a
-- shipped flow, but it can be made attributable (created_by is set
-- by trigger, never by the caller), and an UPDATE can no longer
-- reassign a row's identity (book_key, trope_id) or rewrite its
-- vote tallies (no client flow writes tallies; votes live in
-- trope_votes). Admins and the service role are exempt — curation
-- and the pipeline keep their full write path.
-- ------------------------------------------------------------------
alter table public.book_tropes
  add column if not exists created_by uuid;

create or replace function public.book_tropes_set_created_by()
returns trigger
language plpgsql
as $function$
begin
  new.created_by := auth.uid();
  return new;
end;
$function$;

drop trigger if exists book_tropes_created_by on public.book_tropes;
create trigger book_tropes_created_by
  before insert on public.book_tropes
  for each row execute function public.book_tropes_set_created_by();

-- Trigger functions need no caller EXECUTE grant (firing does not
-- check it); without this revoke they would sit in the anon/PUBLIC-
-- executable population the #357 sweep exists to eliminate.
revoke execute on function public.book_tropes_set_created_by() from public;

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
  return new;
end;
$function$;

drop trigger if exists book_tropes_update_guard on public.book_tropes;
create trigger book_tropes_update_guard
  before update on public.book_tropes
  for each row execute function public.book_tropes_guard_update();

revoke execute on function public.book_tropes_guard_update() from public;

-- ------------------------------------------------------------------
-- #343: book_trope_claims — the auto-confirmed insert policy trusted
-- a flag inside caller-supplied JSON, so any signed-in user could
-- mint 'confirmed' corpus rows at any confidence with no evidence.
-- The tightened check encodes the app's own auto-publish rule
-- (confidence >= 0.85 plus at least one evidence quote), which every
-- legitimate writer already satisfies. This enforces self-consistency
-- — quotes and confidence remain client-asserted; the durable fix
-- (a server-side confirmed-writer) is a named follow-up.
-- ------------------------------------------------------------------
drop policy if exists "claims: user insert ai auto-confirmed" on public.book_trope_claims;
create policy "claims: user insert ai auto-confirmed"
  on public.book_trope_claims
  for insert to authenticated
  with check (
    status = 'confirmed'
    and source_type = 'ai'
    and (evidence ->> 'auto_confirmed') = 'true'
    and confidence >= 0.85
    and jsonb_typeof(evidence -> 'evidence') = 'array'
    and jsonb_array_length(evidence -> 'evidence') > 0
  );
