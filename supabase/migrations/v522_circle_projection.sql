-- v522 — Circle permissions Phase 1: public projection for circle reads.
--
-- The problem: profiles rows were readable WHOLE by any circle partner via
-- the "circle reads profiles" policy. RLS is row-level, so even though the
-- app only ever selected name/avatar columns, a friend could query PostgREST
-- directly and receive gender, share_library, hidden_shelves (the list of
-- shelves hidden FROM them) and updated_at. The User's ruling: friends must
-- not RECEIVE fields the owner hasn't shared — UI-hiding is not enough.
--
-- The fix: every other-user profile read goes through the circle_profiles
-- view below, which projects ONLY identity (name, avatar — always shared),
-- the three posture flags (needed by clients to render and enforce sharing,
-- same role share_library already played), and the bio / favourite-genres
-- content when — and only when — the owner has share_bio on. The base-table
-- circle policy is dropped, so the projection is the only door: there is no
-- query a circle member can write against profiles that returns more.
--
-- New columns on profiles:
--   bio            text     default ''   — profile bio (new; empty until set)
--   fav_genres     text[]   default '{}' — favourite genres (new)
--   share_bio      boolean  default true  — existing accounts keep today's
--                    de-facto exposure for bio/genres; nothing tightens
--                    retroactively, users opt out.
--   share_activity boolean  default false — reading activity (recently
--                    finished / ratings / Reader Portrait) was never a
--                    distinct share before; it is opt-in for everyone.
-- share_library is NOT touched: existing values carry over verbatim as the
-- "My shelves & books" toggle's initial state.
--
-- Why the toggles live on profiles (not user_state): the projection view
-- must read them at query time, and share_library — the same kind of
-- posture flag — already lives here. They are safe on this table precisely
-- because this migration removes other-user access to the base rows; the
-- view deliberately includes the flags themselves (a posture flag is the
-- contract, like share_library before it) while never exposing the VALUES
-- they protect (hidden_shelves stays base-table only).

alter table public.profiles
  add column if not exists bio text not null default '';
alter table public.profiles
  add column if not exists fav_genres text[] not null default '{}';
alter table public.profiles
  add column if not exists share_bio boolean not null default true;
alter table public.profiles
  add column if not exists share_activity boolean not null default false;

-- The books policy below used to subquery profiles for share_library /
-- hidden_shelves, relying on the caller's own profiles access. With the
-- circle policy gone, that subquery would see no row and silently default
-- to "shared, nothing hidden" — a leak. This SECURITY DEFINER helper does
-- the whole visibility test inside the database and returns only a boolean:
-- it never hands the hidden-shelves list to any caller. A direct RPC call
-- learns nothing beyond what loading the shelf already reveals — the
-- trailing EXISTS makes the helper answer true for a status only when the
-- owner actually has a book in it, so probing a status with no books
-- cannot distinguish "hidden" from "empty". (In the policy path a row is
-- always under test, so that row itself satisfies the EXISTS and policy
-- behaviour is unchanged.)
create or replace function public.circle_book_visible(p_owner uuid, p_status text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select (case
    when auth.uid() is null then false
    when auth.uid() = p_owner then true
    when not exists (
      select 1 from public.circle_links cl
      where cl.status = 'accepted'
        and ((cl.requester_id = auth.uid() and cl.addressee_id = p_owner)
          or (cl.addressee_id = auth.uid() and cl.requester_id = p_owner))
    ) then false
    else coalesce((
      select p.share_library
         and not (coalesce(p_status, '') = any (coalesce(p.hidden_shelves, '{}'::text[])))
      from public.profiles p
      where p.user_id = p_owner
    ), true)
  end)
  and exists (
    select 1 from public.books b
    where b.user_id = p_owner
      and coalesce(b.data ->> 'status', '') = coalesce(p_status, '')
  );
$$;
revoke all on function public.circle_book_visible(uuid, text) from public;
grant execute on function public.circle_book_visible(uuid, text) to authenticated;

-- Circle members see a friend's books only when the friend shares their
-- library and the book's shelf isn't hidden (v163 + v522 helper).
drop policy if exists "circle reads shared shelves" on public.books;
create policy "circle reads shared shelves" on public.books
  for select
  using (
    auth.uid() = user_id
    or (
      exists (
        select 1 from public.circle_links cl
        where cl.status = 'accepted'
          and ((cl.requester_id = auth.uid() and cl.addressee_id = books.user_id)
            or (cl.addressee_id = auth.uid() and cl.requester_id = books.user_id))
      )
      and public.circle_book_visible(books.user_id, books.data ->> 'status')
    )
  );

-- The public projection. Runs with the view owner's rights, so the WHERE
-- clause IS the access control: self, or a user linked to the caller by an
-- accepted/pending circle link (pending included so an invite recipient can
-- see who invited them — same reach as the old policy). bio / fav_genres
-- cross only when share_bio is on; they are NULL otherwise, and the app
-- strips NULLs so its objects carry no key at all. gender, hidden_shelves
-- and updated_at are not projected, for anyone, ever.
create or replace view public.circle_profiles as
  select p.user_id,
         p.first_name,
         p.last_name,
         p.avatar_id,
         p.avatar_path,
         p.share_library,
         p.share_bio,
         p.share_activity,
         case when p.share_bio then p.bio end as bio,
         case when p.share_bio then p.fav_genres end as fav_genres
  from public.profiles p
  where p.user_id = auth.uid()
     or exists (
       select 1 from public.circle_links cl
       where cl.status in ('accepted', 'pending')
         and ((cl.requester_id = p.user_id and cl.addressee_id = auth.uid())
           or (cl.addressee_id = p.user_id and cl.requester_id = auth.uid()))
     );
revoke all on public.circle_profiles from anon;
grant select on public.circle_profiles to authenticated;

-- The base table is owner-only from here on ("own profile" FOR ALL policy
-- stays). Dropping the circle policy is what makes the projection a hard
-- boundary instead of a convention.
drop policy if exists "circle reads profiles" on public.profiles;
