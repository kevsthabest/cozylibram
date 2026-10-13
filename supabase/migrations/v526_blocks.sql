-- v526 — Blocking (Social follow-up; the Public Follow prerequisite).
--
-- The problem: unlinking a circle member doesn't stick. Invite codes
-- are standing bearer tokens, so someone you removed can redeem your
-- code again and be back in your circle — and the future Public Follow
-- layer is specced "does not ship without a block feature". Blocking
-- closes both: it severs the pair and keeps them severed.
--
-- The contract (the User's design, via the follow addendum):
-- - SEVER: inserting a block deletes any circle link between the pair
--   (accepted or pending, both directions), immediately, in the same
--   transaction — a trigger does it, so NO insert path can skip it.
--   The link deletions fire the v525 unfriend trigger, so the pair's
--   moment reactions are cleaned up by that existing machinery.
-- - SILENT: the blocked person is never notified, and what they
--   experience is indistinguishable from an ordinary unlink. The
--   load-bearing half of that promise: they cannot LEARN they are
--   blocked from any query. The blocks table's only read policy is
--   "rows I created" — there is no policy under which a row is visible
--   to the person it blocks, not even their own blocked-by rows, so
--   direct selects, counts, and existence probes all return nothing.
-- - STICKY: while a block stands in EITHER direction, no circle link
--   can be created between the pair. Enforcement points, all in the
--   database:
--     * accept_circle_invite() checks the pair and raises the SAME
--       'invite not found' error as an unknown/rotated token — the
--       failure shape is identical, so redemption can't be used to
--       distinguish "blocked" from "code changed".
--     * The vestigial "send requests" INSERT policy on circle_links
--       is DROPPED. Link creation has been RPC-only since v240 (the
--       app and the edge functions never insert directly — verified),
--       and a policy cannot make the both-directions check silently:
--       a policy subquery reads blocks under the CALLER's RLS, which
--       shows only the caller's own blocker rows — the "they blocked
--       me" half is invisible there by design. Leaving that door open
--       would leave the invariant unenforceable; closing it leaves
--       exactly one creation path, and it checks.
--     * The "answer requests" UPDATE policy gains the half of the
--       check a policy CAN see: the answerer must not have blocked
--       the requester (their own blocker rows are visible to them).
--       The other half needs no check — a pending row between a
--       blocked pair cannot exist (the sever deleted it, and new
--       rows can't be created).
-- - INVISIBLE: even if a link row somehow existed between a blocked
--   pair, the blocked person gets nothing through it: the
--   circle_profiles view and circle_book_visible() both exclude
--   blocked pairs outright.
--
-- Why there is deliberately NO pair_blocked() helper function: a
-- boolean a caller can invoke with a chosen pair is an existence
-- oracle — the blocked party could call it and convert suspicion
-- into certainty, breaking silence (the v522 rule: a helper's answer
-- must reveal nothing the caller couldn't already see). So the
-- both-directions EXISTS is inlined in exactly the three places that
-- run with owner rights and take no caller-chosen input beyond what
-- the flow already carries: the view (owner context), and the two
-- SECURITY DEFINER functions below.

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocks enable row level security;

-- Own rows ONLY: you can read, create and delete the blocks YOU made.
-- Nothing — no policy, no view — exposes a row to its blocked party.
drop policy if exists "read own blocks" on public.blocks;
create policy "read own blocks" on public.blocks
  for select
  using (auth.uid() = blocker_id);

drop policy if exists "block a reader" on public.blocks;
create policy "block a reader" on public.blocks
  for insert
  with check (auth.uid() = blocker_id);

drop policy if exists "unblock a reader" on public.blocks;
create policy "unblock a reader" on public.blocks
  for delete
  using (auth.uid() = blocker_id);
-- (Deliberately no UPDATE policy: a block row is created or deleted,
-- never edited.)

-- Sever on block: any insert deletes the pair's links in the same
-- transaction. SECURITY DEFINER so the delete isn't limited by the
-- caller's circle_links policies (they could delete their own links
-- anyway — this makes it atomic and unconditional). The deletions
-- fire moment_reactions_unfriend_cleanup (v525), so reactions
-- between the pair are removed by that trigger, not by a second
-- mechanism here.
create or replace function public.blocks_sever_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.circle_links
   where (requester_id = new.blocker_id and addressee_id = new.blocked_id)
      or (requester_id = new.blocked_id and addressee_id = new.blocker_id);
  return new;
end;
$$;
revoke all on function public.blocks_sever_links() from public;

drop trigger if exists blocks_sever on public.blocks;
create trigger blocks_sever
  after insert on public.blocks
  for each row execute function public.blocks_sever_links();

-- The owner's blocked list (Settings → Circle & privacy). Names and
-- avatars come from profiles, which the owner cannot read directly
-- for other users (v522) — hence this SECURITY DEFINER reader. It
-- only ever returns rows where the CALLER is the blocker: your own
-- list, nobody else's, and never the inverse (who blocked you is
-- not representable in its result).
create or replace function public.my_blocked_readers()
returns table (
  user_id uuid,
  first_name text,
  last_name text,
  avatar_id text,
  avatar_path text,
  blocked_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select b.blocked_id, p.first_name, p.last_name, p.avatar_id, p.avatar_path, b.created_at
    from public.blocks b
    join public.profiles p on p.user_id = b.blocked_id
   where b.blocker_id = auth.uid()
   order by b.created_at desc;
$$;
revoke all on function public.my_blocked_readers() from public;
grant execute on function public.my_blocked_readers() to authenticated;

-- Sticky, part 1: invite redemption refuses blocked pairs with the
-- identical error an unknown token gets (v240 body + the pair check).
create or replace function public.accept_circle_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_them uuid;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;
  select user_id into v_them from circle_invites where code = p_token;
  if v_them is null then
    raise exception 'invite not found';
  end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = v_me and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = v_me)
  ) then
    raise exception 'invite not found';
  end if;
  if v_them = v_me then
    raise exception 'own invite';
  end if;
  delete from circle_links
   where (requester_id = v_me and addressee_id = v_them)
      or (requester_id = v_them and addressee_id = v_me);
  insert into circle_links (requester_id, addressee_id, status)
  values (v_me, v_them, 'accepted');
  return v_them;
end;
$$;
revoke all on function public.accept_circle_invite(text) from public;
grant execute on function public.accept_circle_invite(text) to authenticated;

-- Sticky, part 2: close the direct-insert door (see header). Link
-- creation is RPC-only from here on.
drop policy if exists "send requests" on public.circle_links;

-- Sticky, part 3: an answerer who has blocked the requester cannot
-- accept (or decline) their way back into a link. The check reads
-- the answerer's OWN blocker rows — visible under blocks RLS — which
-- is the half a policy can honestly make; the sever guarantees no
-- pending row survives a block from the other direction.
drop policy if exists "answer requests" on public.circle_links;
create policy "answer requests" on public.circle_links
  for update
  using (auth.uid() = addressee_id and status = 'pending')
  with check (
    auth.uid() = addressee_id and status in ('accepted', 'declined')
    and not exists (
      select 1 from public.blocks b
       where b.blocker_id = auth.uid()
         and b.blocked_id = circle_links.requester_id
    )
  );

-- Invisible, part 1: the projection excludes blocked pairs even if a
-- link row somehow exists (v522 view + the pair exclusion).
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
         and not exists (
           select 1 from public.blocks b
           where (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
              or (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
         )
     );
revoke all on public.circle_profiles from anon;
grant select on public.circle_profiles to authenticated;

-- Invisible, part 2: book visibility answers false for a blocked
-- pair before any link/share test (v522 helper + the pair check —
-- a plain false, indistinguishable from unshared, hidden, unlinked,
-- or empty, exactly like every other false this helper returns).
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
    -- v526: a blocked pair (either direction) sees nothing — a plain
    -- false, indistinguishable from every other false this returns.
    when exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = p_owner)
         or (b.blocker_id = p_owner and b.blocked_id = auth.uid())
    ) then false
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
