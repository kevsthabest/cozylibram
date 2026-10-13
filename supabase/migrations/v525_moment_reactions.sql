-- v525 — Social build #1: reactions on moments.
--
-- A "moment" is a circle member finishing a book. Moments are computed
-- client-side from the book lists the circle digest already fetches,
-- and reactions to them live here. A moment is identified by the plain
-- concatenation owner_id || ':' || book_id || ':' || finish-day —
-- every part of it is already visible to the two parties who may read
-- a reaction row (the giver saw the shared book; the owner owns it),
-- so the key carries no secrecy and none is claimed for it. All
-- entitlement is enforced server-side, below.
--
-- The User's hard rule: NO counts or tallies of reactions anywhere.
-- The read side enforces the visibility half of that rule: a reaction
-- row is readable ONLY by its giver or by the moment's owner, so a
-- third friend cannot enumerate reactions on someone else's moment
-- and no client — ours or a hand-built PostgREST query — can compute
-- a tally over other people's reactions. The owner sees each reactor
-- as an individual person; a giver sees only their own reaction.
--
-- The write side goes through react_to_moment() and nowhere else
-- (there are deliberately NO insert/update policies): the function
-- re-validates, at write time, everything a reaction claims — an
-- accepted friendship, the owner's CURRENT activity opt-in, the read
-- shelf genuinely visible (circle_book_visible), and the book really
-- existing with status 'read' and that finish day, inside the
-- 90-day window. Turning activity off, unsharing, or hiding the read
-- shelf therefore stops new reactions immediately — the client-side
-- fetch discipline of the digest is not the boundary; this is.
-- Changing a reaction is delete + react again, so every change
-- re-runs the same validation.
--
-- Unfriending ends reactions: when a circle_links row is deleted and
-- no accepted link remains between the pair, the trigger below
-- removes their reactions in both directions — matching the promise
-- the remove-friend sheet already makes ("will lose access to your
-- shelves"). Editing a finish date re-keys a moment; the old key's
-- reactions stay behind, readable only by giver/owner (accepted
-- residual, bounded by real moments).

create table if not exists public.moment_reactions (
  moment_key text not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  giver_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('heart', 'sparkles', 'moon', 'trophy', 'smile')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (moment_key, giver_id),
  check (giver_id <> owner_id)
);

alter table public.moment_reactions enable row level security;

drop policy if exists "giver or owner reads reactions" on public.moment_reactions;
create policy "giver or owner reads reactions" on public.moment_reactions
  for select
  using (auth.uid() = giver_id or auth.uid() = owner_id);

drop policy if exists "giver removes own reaction" on public.moment_reactions;
create policy "giver removes own reaction" on public.moment_reactions
  for delete
  using (auth.uid() = giver_id);

-- The only write path. SECURITY DEFINER (the circle_book_visible /
-- accept_circle_invite pattern): validates the whole claim, computes
-- the moment key itself, and upserts the caller's one reaction.
create or replace function public.react_to_moment(p_owner uuid, p_book_id text, p_day text, p_kind text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date;
  v_key text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_kind not in ('heart', 'sparkles', 'moon', 'trophy', 'smile') then
    raise exception 'unknown reaction kind';
  end if;
  if v_uid = p_owner then raise exception 'cannot react to your own moment'; end if;
  begin
    v_day := p_day::date;
  exception when others then
    raise exception 'invalid moment day';
  end;
  -- The reaction window (the client renders a local-day 90-day window;
  -- a small skew allowance keeps timezone edges from refusing real
  -- moments — this bounds validity, it is not the display rule).
  if v_day < current_date - 92 or v_day > current_date + 1 then
    raise exception 'moment outside the reaction window';
  end if;
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = v_uid and cl.addressee_id = p_owner)
        or (cl.addressee_id = v_uid and cl.requester_id = p_owner))
  ) then raise exception 'not circle friends'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_owner and p.share_activity = true
  ) then raise exception 'owner is not sharing activity'; end if;
  if not public.circle_book_visible(p_owner, 'read') then
    raise exception 'read shelf is not shared';
  end if;
  if not exists (
    select 1 from public.books b
    where b.user_id = p_owner and b.book_id = p_book_id
      and b.data ->> 'status' = 'read'
      and left(b.data ->> 'dateFinished', 10) = p_day
  ) then raise exception 'no such moment'; end if;
  v_key := p_owner::text || ':' || p_book_id || ':' || p_day;
  insert into public.moment_reactions (moment_key, owner_id, giver_id, kind)
  values (v_key, p_owner, v_uid, p_kind)
  on conflict (moment_key, giver_id)
  do update set kind = excluded.kind, updated_at = now();
  return v_key;
end;
$$;
revoke all on function public.react_to_moment(uuid, text, text, text) from public;
grant execute on function public.react_to_moment(uuid, text, text, text) to authenticated;

-- Unfriend cleanup: reactions between a pair die with the friendship.
create or replace function public.moment_reactions_unfriend()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = old.requester_id and cl.addressee_id = old.addressee_id)
        or (cl.requester_id = old.addressee_id and cl.addressee_id = old.requester_id))
  ) then
    delete from public.moment_reactions
    where (owner_id = old.requester_id and giver_id = old.addressee_id)
       or (owner_id = old.addressee_id and giver_id = old.requester_id);
  end if;
  return old;
end;
$$;
drop trigger if exists moment_reactions_unfriend_cleanup on public.circle_links;
create trigger moment_reactions_unfriend_cleanup
  after delete on public.circle_links
  for each row execute function public.moment_reactions_unfriend();
