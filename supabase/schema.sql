-- Spicy Shelves: per-user book storage.
-- Run once in your Supabase project: Dashboard → SQL Editor → paste → Run.
--
-- One row per book per user. The whole book object lives in `data` (jsonb),
-- so the app can evolve without schema migrations. Row Level Security makes
-- sure every user can only ever see their own rows.

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text not null,
  isbn text,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, book_id)
);

create index if not exists books_user_isbn on books (user_id, isbn);

alter table books enable row level security;

drop policy if exists "own rows" on books;
create policy "own rows" on books
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Shared metadata cache: one row per ISBN, readable by every signed-in user.
-- The first user to look up a book pays the API cost (Google Books / Open
-- Library); everyone after that reads the cached metadata from here instead.
-- User-specific fields (shelf, ratings, progress, notes) are never stored here.
create table if not exists book_meta (
  isbn text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  -- v194 (security): write attribution. The app legitimately overwrites rows
  -- (enriched upsert seconds after the lookup put; stale refresh after 30
  -- days), so the table can't be insert-only — but a stranger must not be
  -- able to silently deface anyone's cached metadata.
  created_by uuid,
  updated_by uuid
);

alter table book_meta enable row level security;

drop policy if exists "read meta" on book_meta;
create policy "read meta" on book_meta
  for select
  using (auth.role() = 'authenticated');

drop policy if exists "write meta" on book_meta;
create policy "write meta" on book_meta
  for insert
  with check (auth.role() = 'authenticated');

-- v194: a row may be overwritten only by its creator (covers the app's
-- lookup-put → enriched-upsert flow, same user, seconds apart) or via a
-- genuine stale refresh (>30 days, the app's META_TTL_MS). Everyone else's
-- UPDATE is rejected. Legacy rows (created_by null, pre-v194) stay
-- writable until first touched, when the trigger below claims them.
drop policy if exists "refresh meta" on book_meta;
create policy "refresh meta" on book_meta
  for update
  using (auth.role() = 'authenticated' and (
    created_by is null
    or created_by = auth.uid()
    or fetched_at < now() - interval '30 days'
  ))
  with check (auth.role() = 'authenticated');

-- v194: the trigger owns the attribution columns — clients can't spoof them.
-- A genuine stale refresh transfers ownership to the refresher; otherwise
-- ownership never changes hands.
create or replace function book_meta_guard() returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    NEW.created_by := auth.uid();
    NEW.updated_by := auth.uid();
    return NEW;
  end if;
  NEW.updated_by := auth.uid();
  if OLD.fetched_at < now() - interval '30 days' then
    NEW.created_by := auth.uid();
  else
    NEW.created_by := coalesce(OLD.created_by, auth.uid());
  end if;
  return NEW;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists book_meta_guard_trg on book_meta;
create trigger book_meta_guard_trg
  before insert or update on book_meta
  for each row execute function book_meta_guard();

-- Deletion tombstones: when a book is deleted on one device, the deletion
-- must propagate instead of the book resurrecting on the next sync.
-- One row per deleted book per user; RLS mirrors the books table.
create table if not exists deleted_books (
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text not null,
  deleted_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table deleted_books enable row level security;

drop policy if exists "own deletions" on deleted_books;
create policy "own deletions" on deleted_books
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Profile: display name + avatar choice, synced across the user's devices.
-- One row per user. Uploaded photos stay on-device (too big for a text
-- column and they don't need to roam); the cloud keeps the themed avatar id
-- as the cross-device fallback.
create table if not exists profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  gender text not null default '',
  avatar_id text not null default '',
  updated_at timestamptz not null default now()
);
-- v178: existing databases re-running this file gain the gender column
alter table profiles add column if not exists gender text not null default '';

alter table profiles enable row level security;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Profile photos live in Supabase Storage (bucket `avatars`), one file per
-- user; the profiles row just points at it with avatar_path. The bucket is
-- private — the app downloads with the signed-in user's own session.
-- RLS: each user owns the folder named after their user id.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

alter table profiles add column if not exists avatar_path text not null default '';

drop policy if exists "own avatar files" on storage.objects;
create policy "own avatar files" on storage.objects
  for all
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============ Circle (v96): social reading with loved ones ============
-- Friend links. One row per request; friendship is mutual once accepted.
-- The tight per-action policies below matter: without them a user could
-- accept their own request and read a stranger's shelves.
create table if not exists circle_links (
  requester_id uuid not null references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

alter table circle_links enable row level security;

drop policy if exists "read own links" on circle_links;
create policy "read own links" on circle_links
  for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- v526: there is deliberately NO direct-insert policy on circle_links.
-- Link creation has been RPC-only since v240 (accept_circle_invite,
-- below); the old "send requests" policy was a REST door that could
-- not enforce blocking silently (a policy subquery reads blocks under
-- the caller's RLS and sees only their own blocker rows). Dropped in
-- migrations/v526_blocks.sql; do not re-add.
drop policy if exists "send requests" on circle_links;

drop policy if exists "answer requests" on circle_links;
create policy "answer requests" on circle_links
  for update
  using (auth.uid() = addressee_id and status = 'pending')
  with check (
    auth.uid() = addressee_id and status in ('accepted', 'declined')
    -- v526: an answerer who blocked the requester can't answer their
    -- way back into a link (own blocker rows are visible to them; the
    -- sever guarantees no pending row survives a block either way).
    and not exists (
      select 1 from public.blocks b
       where b.blocker_id = auth.uid()
         and b.blocked_id = circle_links.requester_id
    )
  );

drop policy if exists "remove links" on circle_links;
create policy "remove links" on circle_links
  for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- Invite codes: 12-char URL-safe crypto-random tokens (72 bits, unguessable)
-- that double as the invite-link slug: #/invite/<code>. Codes are
-- public-by-design (any authenticated user can read them) but not
-- enumerable; only the code and the user id live here. Rotate the code to
-- kill a shared link. Acceptance is one-sided via accept_circle_invite():
-- the token proves the inviter's consent, so the invitee's Accept creates
-- the friendship immediately.
create table if not exists circle_invites (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

alter table circle_invites enable row level security;

drop policy if exists "read codes" on circle_invites;
create policy "read codes" on circle_invites
  for select
  using (auth.role() = 'authenticated');

drop policy if exists "own code" on circle_invites;
create policy "own code" on circle_invites
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The only link-creation path (v240; v526 adds the block check, which
-- raises the SAME 'invite not found' an unknown token gets, so a
-- refused redemption is indistinguishable from a rotated code).
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
  -- v527: already friends — the invite is honoured by the link that
  -- stands. Return without touching it.
  if exists (
    select 1 from circle_links
     where status = 'accepted'
       and ((requester_id = v_me and addressee_id = v_them)
         or (requester_id = v_them and addressee_id = v_me))
  ) then
    delete from circle_links
     where status <> 'accepted'
       and ((requester_id = v_me and addressee_id = v_them)
         or (requester_id = v_them and addressee_id = v_me));
    return v_them;
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

-- ============ Blocking (v526) ============
-- A block severs a circle pair and keeps it severed — silently. The
-- full contract (sever / silent / sticky / invisible) and the silence
-- argument are in migrations/v526_blocks.sql. Load-bearing shapes:
-- the ONLY read policy on blocks is "rows I created" (the blocked
-- party can read nothing about the block, not even existence), and
-- there is deliberately no pair_blocked() helper — a caller-invokable
-- boolean over a chosen pair would be an existence oracle. The
-- both-directions check is inlined where owner rights already apply:
-- the circle_profiles view and circle_book_visible() (both below),
-- and accept_circle_invite() above.
create table if not exists public.blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocks enable row level security;

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
-- (No UPDATE policy: a block is created or deleted, never edited.)

-- Sever on insert, in the same transaction, whichever path created
-- the row. The link deletions fire the v525 unfriend trigger, which
-- removes the pair's moment reactions.
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

-- The owner's own blocked list for Settings (names/avatars live in
-- profiles, unreadable for other users since v522). Returns ONLY
-- rows where the caller is the blocker — who blocked YOU is not
-- representable in its result.
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

-- Circle privacy controls on the profile: a master share switch plus
-- per-shelf hiding (e.g. keep the DNF shelf to yourself).
alter table profiles add column if not exists share_library boolean not null default true;
alter table profiles add column if not exists hidden_shelves text[] not null default '{}';

-- v522 — Circle permissions Phase 1. Two more sharing controls plus the
-- content they govern: bio / favourite genres (share_bio, default true so
-- existing accounts keep today's de-facto exposure) and reading activity —
-- recently finished / ratings / Reader Portrait — (share_activity, default
-- false: opt-in for everyone). See migrations/v522_circle_projection.sql.
alter table profiles add column if not exists bio text not null default '';
alter table profiles add column if not exists fav_genres text[] not null default '{}';
alter table profiles add column if not exists share_bio boolean not null default true;
alter table profiles add column if not exists share_activity boolean not null default false;

-- v550: the profile handle — a unique, findable chosen identity.
-- handle_changed_at stamps the last claim/change/clear (the rename
-- cooldown reads it); findable is the separate opt-in to being looked
-- up by handle, default OFF for everyone. The format CHECK, the
-- case-insensitive unique index, the claim/lookup RPCs and the write
-- guards live in the v550 section at the end of this file. See
-- migrations/v550_handles.sql.
alter table profiles add column if not exists handle text;
alter table profiles add column if not exists findable boolean not null default false;
alter table profiles add column if not exists handle_changed_at timestamptz;

-- v522: friends no longer read base profiles rows at all (RLS is row-level,
-- so the old policy handed over gender / hidden_shelves / updated_at to any
-- circle partner who asked PostgREST directly). Every other-user profile
-- read goes through the circle_profiles view further below, which projects
-- only identity + posture flags + toggled-on fields. The books policy's
-- share test moves into this SECURITY DEFINER helper, which returns only a
-- boolean and never exposes the hidden-shelves list it checks against. It
-- answers true for a status only when the owner actually has a book in
-- it, so an RPC probe reveals nothing beyond what loading the shelf
-- shows (a hidden shelf with no books is indistinguishable from an empty
-- one; in the policy path the row under test satisfies that condition).
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

-- Friends can read each other's books, minus hidden shelves and only when
-- the owner shares with the circle. Write access stays owner-only.
drop policy if exists "circle reads shared shelves" on books;
create policy "circle reads shared shelves" on books
  for select
  using (
    auth.uid() = user_id
    or (
      exists (
        select 1 from circle_links cl
        where cl.status = 'accepted'
          and ((cl.requester_id = books.user_id and cl.addressee_id = auth.uid())
            or (cl.addressee_id = books.user_id and cl.requester_id = auth.uid()))
      )
      and public.circle_book_visible(books.user_id, books.data->>'status')
    )
  );

-- v522: the public projection every circle surface reads through. Runs
-- with the view owner's rights, so the WHERE clause is the access control:
-- self, or a user linked to the caller (accepted or pending — pending so
-- an invite shows who it's from). bio / fav_genres cross only when the
-- owner has share_bio on; gender, hidden_shelves and updated_at are never
-- projected, for anyone.
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
         case when p.share_bio then p.fav_genres end as fav_genres,
         p.handle
  from profiles p
  where p.user_id = auth.uid()
     or exists (
       select 1 from circle_links cl
       where cl.status in ('accepted', 'pending')
         and ((cl.requester_id = p.user_id and cl.addressee_id = auth.uid())
           or (cl.addressee_id = p.user_id and cl.requester_id = auth.uid()))
         -- v526: blocked pairs are excluded even if a link row exists.
         and not exists (
           select 1 from public.blocks b
           where (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
              or (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
         )
     );
revoke all on public.circle_profiles from anon;
grant select on public.circle_profiles to authenticated;

-- v522: base profiles rows are owner-only from here on (the "own profile"
-- FOR ALL policy above stays); dropping the circle policy is what makes
-- the projection a hard boundary instead of a convention.
drop policy if exists "circle reads profiles" on profiles;

-- Friends may view (not upload/delete) each other's avatar photos.
drop policy if exists "own avatar files" on storage.objects;
drop policy if exists "circle avatar views" on storage.objects;
create policy "circle avatar views" on storage.objects
  for select
  using (
    bucket_id = 'avatars'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or exists (
        select 1 from circle_links cl
        where cl.status = 'accepted'
          and ((cl.requester_id::text = (storage.foldername(name))[1] and cl.addressee_id = auth.uid())
            or (cl.addressee_id::text = (storage.foldername(name))[1] and cl.requester_id = auth.uid()))
      )
    )
  );
drop policy if exists "own avatar uploads" on storage.objects;
create policy "own avatar uploads" on storage.objects
  for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "own avatar changes" on storage.objects;
create policy "own avatar changes" on storage.objects
  for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "own avatar deletes" on storage.objects;
create policy "own avatar deletes" on storage.objects
  for delete
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============ Reactions on moments (v525, Social build #1) ============
-- Moments (a circle member finishing a book) are computed client-side
-- from the digest's book lists; reactions to them live here. The full
-- rationale — the no-counts rule, the RPC-gated write path, and the
-- unfriend semantics — is in migrations/v525_moment_reactions.sql.
-- A reaction row is readable ONLY by its giver or the moment's owner
-- (a third friend cannot enumerate, so no tally can be computed over
-- other people's reactions); writes go through react_to_moment(),
-- which re-validates friendship, the owner's current activity opt-in,
-- read-shelf visibility, and the book's real finish at write time.
-- There are deliberately no insert/update policies.
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

-- v532: the giver branch additionally requires the owner's CURRENT
-- sharing posture (moment_owner_sharing — share_activity on AND
-- circle_book_visible(owner, 'read'), the same two facts the write
-- RPC checks). The owner branch stays ungated; see
-- migrations/v532_reactions_read_posture.sql.
create or replace function public.moment_owner_sharing(p_owner uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
           select 1 from public.profiles p
            where p.user_id = p_owner
              and p.share_activity
         )
         and public.circle_book_visible(p_owner, 'read');
$$;
revoke all on function public.moment_owner_sharing(uuid) from public;
grant execute on function public.moment_owner_sharing(uuid) to authenticated;

drop policy if exists "giver or owner reads reactions" on public.moment_reactions;
create policy "giver or owner reads reactions" on public.moment_reactions
  for select
  using (
    auth.uid() = owner_id
    or (auth.uid() = giver_id and public.moment_owner_sharing(owner_id))
  );

drop policy if exists "giver removes own reaction" on public.moment_reactions;
create policy "giver removes own reaction" on public.moment_reactions
  for delete
  using (auth.uid() = giver_id);

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

-- ============ Thought of you (v527, Social build #2) ============
-- Directed recommendations: a reader sends one of their own books
-- to a circle friend with an optional short note; it lands as a card
-- in the friend's Hearth. The full rationale — server-built
-- snapshots, un-phone-home-able covers, fire-and-forget outcomes
-- indistinguishable in return value, exact caps, dismissal
-- tombstones, the receive_recos consent switch (deliberately NOT in
-- the circle_profiles projection), and the #190 invite fix — is in
-- migrations/v527_thought_of_you.sql. A card is readable ONLY by its
-- recipient, only while the friendship stands and the card is
-- unexpired; writes go through send_thought_of_you(), which
-- re-validates friendship, blocks, consent, ownership and caps at
-- write time. The sender has no read or delete policy at all.
alter table public.profiles
  add column if not exists receive_recos boolean not null default true;

create or replace function public.toy_book_key(p_isbn text, p_title text, p_first_author text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_isbn, '') <> '' then 'isbn:' || p_isbn
    else 'ta:' || lower(btrim(coalesce(p_title, ''))) || '|' || lower(btrim(coalesce(p_first_author, '')))
  end;
$$;
revoke all on function public.toy_book_key(text, text, text) from public;
grant execute on function public.toy_book_key(text, text, text) to authenticated;

create or replace function public.toy_cover_ok(p_url text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_url is null or p_url = '' then true
    when left(p_url, 11) = 'data:image/' and length(p_url) <= 204800 then true
    when length(p_url) > 1000 then false
    when p_url ~ '^https://dvhimjkrroxuatthiizc\.supabase\.co/storage/v1/object/public/covers/[0-9a-f]{64}\.(jpg|jpeg|png|webp|gif|avif)$' then true
    when exists (
      select 1
      from unnest(array[
        'covers.openlibrary.org', 'books.google.com', 'assets.hardcover.app',
        'img.hardcover.app', 'images-na.ssl-images-amazon.com', 'm.media-amazon.com',
        'archive.org', 'hardcover.app', 'i.gr-assets.com',
        'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
        'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'
      ]) as h(host)
      where p_url ~ ('^https://' || replace(h.host, '.', '\.') || '(:[0-9]+)?([/?#]|$)')
    ) then true
    else false
  end;
$$;
revoke all on function public.toy_cover_ok(text) from public;
grant execute on function public.toy_cover_ok(text) to authenticated;

create table if not exists public.thought_of_you (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  sender_book_id text not null,
  book_key text not null,
  book jsonb not null,
  note text not null default '' check (char_length(note) <= 140),
  created_at timestamptz not null default now(),
  unique (sender_id, recipient_id, book_key),
  check (sender_id <> recipient_id)
);
create index if not exists thought_of_you_recipient_idx
  on public.thought_of_you (recipient_id, created_at desc);

create table if not exists public.toy_send_log (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists toy_send_log_sender_idx
  on public.toy_send_log (sender_id, created_at);

create table if not exists public.toy_dismissals (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  created_at timestamptz not null default now(),
  primary key (sender_id, recipient_id, book_key)
);

alter table public.thought_of_you enable row level security;
alter table public.toy_send_log enable row level security;
alter table public.toy_dismissals enable row level security;

revoke all on public.toy_send_log from public, anon, authenticated;
revoke all on public.toy_dismissals from public, anon, authenticated;

drop policy if exists "recipient reads recommendations" on public.thought_of_you;
create policy "recipient reads recommendations" on public.thought_of_you
  for select
  using (
    auth.uid() = recipient_id
    and created_at > now() - interval '60 days'
    and exists (
      select 1 from public.circle_links cl
      where cl.status = 'accepted'
        and ((cl.requester_id = sender_id and cl.addressee_id = recipient_id)
          or (cl.requester_id = recipient_id and cl.addressee_id = sender_id))
    )
    and not exists (
      select 1 from public.blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = sender_id
    )
  );

drop policy if exists "recipient deletes recommendations" on public.thought_of_you;
create policy "recipient deletes recommendations" on public.thought_of_you
  for delete
  using (auth.uid() = recipient_id);

-- The only write path. SECURITY DEFINER (the react_to_moment
-- pattern): validates the whole claim in a pinned order, builds the
-- snapshot from the sender's own book row, and answers with the
-- indistinguishable outcomes described in the header.
create or replace function public.send_thought_of_you(p_recipient uuid, p_book_id text, p_note text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_data jsonb;
  v_title text;
  v_authors jsonb;
  v_first_author text;
  v_isbn text;
  v_cover text;
  v_key text;
  v_snap jsonb;
  v_recv boolean;
  v_inserted boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  -- One sender's sends are serialised, so the cap counts below are
  -- exact rather than racy (check-then-insert under READ COMMITTED
  -- would let concurrent calls both pass).
  perform pg_advisory_xact_lock(hashtextextended('toy-send:' || v_uid::text, 0));
  if char_length(coalesce(p_note, '')) > 140 then
    raise exception 'note too long';
  end if;
  -- The book must be the sender's own (the server owns the book).
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  v_data := coalesce(v_row.data, '{}'::jsonb);
  v_title := left(coalesce(v_data ->> 'title', ''), 300);
  if btrim(v_title) = '' then raise exception 'no such book'; end if;
  -- Friendship, with blocks folded into the same generic refusal
  -- (v526: a blocked pair is indistinguishable from an unlinked one).
  if p_recipient = v_uid
     or not exists (
       select 1 from public.circle_links cl
       where cl.status = 'accepted'
         and ((cl.requester_id = v_uid and cl.addressee_id = p_recipient)
           or (cl.addressee_id = v_uid and cl.requester_id = p_recipient))
     )
     or exists (
       select 1 from public.blocks b
       where (b.blocker_id = v_uid and b.blocked_id = p_recipient)
          or (b.blocker_id = p_recipient and b.blocked_id = v_uid)
     )
  then raise exception 'not circle friends'; end if;
  -- Recipient posture, read only after the friendship gate: a
  -- missing profile row is treated as opted out (silent), so this
  -- function is not a user-existence oracle.
  select p.receive_recos into v_recv from public.profiles p where p.user_id = p_recipient;
  if not found or v_recv is distinct from true then return 'ok'; end if;

  -- The sender's own caps: the one distinct outcome (see header).
  -- Checked BEFORE the silent outcomes below, deliberately: an
  -- over-cap sender must hear 'slow_down' uniformly, so the answer
  -- reports only the sender's own volume. Were the silent checks
  -- first, a dismissed (or duplicate, or already-owned) book would
  -- answer 'ok' while a fresh book answered 'slow_down' — and that
  -- differential would resolve to a dismissal receipt.
  if (select count(*) from public.toy_send_log l
       where l.sender_id = v_uid and l.recipient_id = p_recipient
         and l.created_at >= date_trunc('day', now())) >= 5
     or (select count(*) from public.toy_send_log l
       where l.sender_id = v_uid
         and l.created_at >= date_trunc('day', now())) >= 20
  then return 'slow_down'; end if;

  -- Snapshot: a fresh object built from whitelisted scalars only.
  v_authors := (
    select coalesce(jsonb_agg(a order by ord), '[]'::jsonb)
    from (
      select left(a, 120) as a, ord
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_data -> 'authors') = 'array' then v_data -> 'authors'
          when jsonb_typeof(v_data -> 'authors') = 'string' then jsonb_build_array(v_data ->> 'authors')
          else '[]'::jsonb
        end
      ) with ordinality as t(a, ord)
      where btrim(a) <> ''
      limit 8
    ) s
  );
  v_first_author := coalesce(v_authors ->> 0, '');
  v_isbn := upper(regexp_replace(coalesce(nullif(v_data ->> 'isbn', ''), v_row.isbn, ''), '[^0-9Xx]', '', 'g'));
  if length(v_isbn) not in (10, 13) then v_isbn := ''; end if;
  v_cover := coalesce(v_data ->> 'cover', '');
  if not public.toy_cover_ok(v_cover) then v_cover := ''; end if;
  v_key := public.toy_book_key(v_isbn, v_title, v_first_author);
  v_snap := jsonb_build_object(
    'title', v_title,
    'authors', v_authors,
    'isbn', v_isbn,
    'cover', v_cover,
    'coverColor', case when coalesce(v_data ->> 'coverColor', '') ~ '^#[0-9a-fA-F]{6}$'
                       then v_data ->> 'coverColor' else '' end,
    'series', case when jsonb_typeof(v_data -> 'series') = 'object'
                        and btrim(coalesce(v_data -> 'series' ->> 'name', '')) <> ''
                   then jsonb_build_object(
                     'name', left(v_data -> 'series' ->> 'name', 200),
                     'position', left(coalesce(v_data -> 'series' ->> 'position', ''), 20))
                   else null end,
    'seriesPos', left(coalesce(v_data ->> 'seriesPos', ''), 20),
    'genres', (
      select coalesce(jsonb_agg(g order by ord), '[]'::jsonb)
      from (
        select left(g, 60) as g, ord
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_data -> 'genres') = 'array' then v_data -> 'genres' else '[]'::jsonb end
        ) with ordinality as t(g, ord)
        where btrim(g) <> ''
        limit 12
      ) s
    ),
    'categories', (
      select coalesce(jsonb_agg(g order by ord), '[]'::jsonb)
      from (
        select left(g, 60) as g, ord
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_data -> 'categories') = 'array' then v_data -> 'categories' else '[]'::jsonb end
        ) with ordinality as t(g, ord)
        where btrim(g) <> ''
        limit 12
      ) s
    ),
    'description', left(coalesce(v_data ->> 'description', ''), 2000),
    'pageCount', case when coalesce(v_data ->> 'pageCount', '') ~ '^[0-9]+$'
                      then least((v_data ->> 'pageCount')::int, 100000) else 0 end,
    'publishedDate', case when coalesce(v_data ->> 'publishedDate', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                          then left(v_data ->> 'publishedDate', 10) else '' end
  );

  -- Silent outcomes (all plain 'ok'): dismissal tombstone (1 year),
  -- duplicate still sitting in the inbox, already on the
  -- recipient's shelves.
  if exists (
    select 1 from public.toy_dismissals d
    where d.sender_id = v_uid and d.recipient_id = p_recipient and d.book_key = v_key
      and d.created_at > now() - interval '1 year'
  ) then return 'ok'; end if;
  if exists (
    select 1 from public.thought_of_you t
    where t.sender_id = v_uid and t.recipient_id = p_recipient and t.book_key = v_key
  ) then return 'ok'; end if;
  if exists (
    select 1 from public.books rb
    where rb.user_id = p_recipient
      and public.toy_book_key(
            case when length(upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                 then upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))
                 else '' end,
            rb.data ->> 'title',
            case when jsonb_typeof(rb.data -> 'authors') = 'array' then rb.data -> 'authors' ->> 0
                 when jsonb_typeof(rb.data -> 'authors') = 'string' then rb.data ->> 'authors'
                 else '' end
          ) = v_key
  ) then return 'ok'; end if;

  insert into public.thought_of_you (sender_id, recipient_id, sender_book_id, book_key, book, note)
  values (v_uid, p_recipient, p_book_id, v_key, v_snap, btrim(coalesce(p_note, '')))
  on conflict (sender_id, recipient_id, book_key) do nothing;
  v_inserted := found;
  if not v_inserted then return 'ok'; end if;
  insert into public.toy_send_log (sender_id, recipient_id) values (v_uid, p_recipient);

  -- Opportunistic prune (bounded, indexed): the log keeps 2 days,
  -- tombstones a year, expired inbox rows are reaped here since
  -- read-time expiry alone would leave them forever.
  delete from public.toy_send_log where created_at < now() - interval '2 days';
  delete from public.toy_dismissals where created_at < now() - interval '1 year';
  delete from public.thought_of_you where created_at < now() - interval '60 days';
  return 'ok';
end;
$$;
revoke all on function public.send_thought_of_you(uuid, text, text) from public;
grant execute on function public.send_thought_of_you(uuid, text, text) to authenticated;

-- Dismiss: the recipient says no — tombstone first, then delete.
-- Always 'ok': an already-gone card is the same answer.
create or replace function public.dismiss_thought_of_you(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sender uuid;
  v_key text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select sender_id, book_key into v_sender, v_key
    from public.thought_of_you
   where id = p_id and recipient_id = v_uid;
  if not found then return 'ok'; end if;
  insert into public.toy_dismissals (sender_id, recipient_id, book_key)
  values (v_sender, v_uid, v_key)
  on conflict (sender_id, recipient_id, book_key)
  do update set created_at = now();
  delete from public.thought_of_you where id = p_id and recipient_id = v_uid;
  return 'ok';
end;
$$;
revoke all on function public.dismiss_thought_of_you(uuid) from public;
grant execute on function public.dismiss_thought_of_you(uuid) to authenticated;

-- Recall: a mis-sent book can be taken back. Always 'ok', whether
-- or not a row existed — the answer must not become the receipt
-- the sender-delete policy would have been.
create or replace function public.recall_thought_of_you(p_recipient uuid, p_book_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.thought_of_you
   where sender_id = auth.uid()
     and recipient_id = p_recipient
     and sender_book_id = p_book_id;
  return 'ok';
end;
$$;
revoke all on function public.recall_thought_of_you(uuid, text) from public;
grant execute on function public.recall_thought_of_you(uuid, text) to authenticated;

-- Unfriend cleanup (the v525 pattern): when a circle link is
-- deleted and no accepted link remains between the pair, their
-- recommendations die in both directions. Block inserts sever
-- links (v526), which fires this — a blocked pair's pending cards
-- are removed by the same machinery.
create or replace function public.thought_of_you_unfriend()
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
    delete from public.thought_of_you
    where (sender_id = old.requester_id and recipient_id = old.addressee_id)
       or (sender_id = old.addressee_id and recipient_id = old.requester_id);
  end if;
  return old;
end;
$$;
drop trigger if exists thought_of_you_unfriend_cleanup on public.circle_links;
create trigger thought_of_you_unfriend_cleanup
  after delete on public.circle_links
  for each row execute function public.thought_of_you_unfriend();

-- ============ Buddy reads (v528, Social build #3) ============
-- The full argument — key-only rows (no snapshot), presence as a
-- per-book grant served by buddy_states() as a bare enum, the
-- inviter's fire-and-forget read surface, anti-oracle invite gate,
-- caps/tombstones/expiry machinery, and the unfriend cleanup — is
-- in migrations/v528_buddy_reads.sql. Writes go only through
-- buddy_invite() / buddy_respond() / buddy_end(), which re-validate
-- friendship, blocks and ownership at write time; a buddy row is
-- readable by its recipient (pendings + actives) and by its inviter
-- (actives only), only while the friendship stands.
alter table public.profiles
  add column if not exists receive_buddy_invites boolean not null default true;

create table if not exists public.buddy_reads (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references auth.users (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  status text not null default 'pending' check (status in ('pending', 'active')),
  created_at timestamptz not null default now(),
  unique (inviter_id, invitee_id, book_key),
  check (inviter_id <> invitee_id)
);
create index if not exists buddy_reads_invitee_idx
  on public.buddy_reads (invitee_id, status);
create index if not exists buddy_reads_inviter_idx
  on public.buddy_reads (inviter_id, status);

create table if not exists public.buddy_send_log (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists buddy_send_log_sender_idx
  on public.buddy_send_log (sender_id, created_at);

create table if not exists public.buddy_dismissals (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  created_at timestamptz not null default now(),
  primary key (sender_id, recipient_id, book_key)
);

alter table public.buddy_reads enable row level security;
alter table public.buddy_send_log enable row level security;
alter table public.buddy_dismissals enable row level security;

-- Machinery tables: nobody reads or writes them directly, ever.
revoke all on public.buddy_send_log from public, anon, authenticated;
revoke all on public.buddy_dismissals from public, anon, authenticated;

-- Read surface. The recipient reads rows addressed to them
-- (pendings + actives); the inviter reads only ACTIVE rows — a
-- pending is fire-and-forget, so no inviter query can enumerate,
-- count, or watch their outgoing invitations. Both halves
-- re-require the friendship right now, the recipient-placed block
-- check a policy can honestly see (the v526 trap: policy subqueries
-- read blocks under the caller's RLS; the other direction is
-- covered by the sever + cleanup trigger), and pending expiry.
drop policy if exists "pair reads buddy reads" on public.buddy_reads;
create policy "pair reads buddy reads" on public.buddy_reads
  for select
  using (
    (auth.uid() = invitee_id or (auth.uid() = inviter_id and status = 'active'))
    and (status = 'active' or created_at > now() - interval '60 days')
    and exists (
      select 1 from public.circle_links cl
      where cl.status = 'accepted'
        and ((cl.requester_id = inviter_id and cl.addressee_id = invitee_id)
          or (cl.requester_id = invitee_id and cl.addressee_id = inviter_id))
    )
    and not exists (
      select 1 from public.blocks b
      where b.blocker_id = auth.uid()
        and b.blocked_id = (case when auth.uid() = inviter_id then invitee_id else inviter_id end)
    )
  );

-- (Deliberately NO insert/update/delete policies: buddy_invite(),
-- buddy_respond() and buddy_end() are the only write doors.)

-- One side's reading state for one book key, as the bare enum.
-- Status only — a copy's CURRENT shelf fact. (The digest elsewhere
-- counts status='read' OR a finish date as finished; presence uses
-- the status alone, so a re-read in progress reads 'reading', not
-- 'finished'.) Precedence across duplicate copies: a finished copy
-- outranks a reading one, which outranks a waiting one, which
-- outranks a set-aside one. No copy with the key → null.
-- Private machinery: revoked from everyone; only the SECURITY
-- DEFINER buddy_states() below (running as owner) calls it.
create or replace function public.buddy_reading_state(p_user uuid, p_key text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case
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
$$;
revoke all on function public.buddy_reading_state(uuid, text) from public;

-- The presence read. Either party to an ACTIVE buddy read may ask;
-- the answer is recomputed from both sides' own book rows at call
-- time, so both clients render the same shared truth, and ending
-- the read (or the friendship) stops the answers immediately.
-- Anything else — not a party, not active, no longer friends,
-- blocked — answers with both states null: there is no error shape
-- to probe with, and null is also the honest answer for "no state".
create or replace function public.buddy_states(p_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_r record;
  v_other uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select inviter_id, invitee_id, book_key, status into v_r
    from public.buddy_reads
   where id = p_id and (inviter_id = v_uid or invitee_id = v_uid);
  if not found or v_r.status <> 'active' then
    return jsonb_build_object('mine', null, 'theirs', null);
  end if;
  v_other := case when v_r.inviter_id = v_uid then v_r.invitee_id else v_r.inviter_id end;
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = v_uid and cl.addressee_id = v_other)
        or (cl.addressee_id = v_uid and cl.requester_id = v_other))
  ) or exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_other)
       or (b.blocker_id = v_other and b.blocked_id = v_uid)
  ) then
    return jsonb_build_object('mine', null, 'theirs', null);
  end if;
  return jsonb_build_object(
    'mine', public.buddy_reading_state(v_uid, v_r.book_key),
    'theirs', public.buddy_reading_state(v_other, v_r.book_key)
  );
end;
$$;
revoke all on function public.buddy_states(uuid) from public;
grant execute on function public.buddy_states(uuid) to authenticated;

-- The only invite path. The client names its own book by id and a
-- friend; the server computes the key and validates the whole
-- claim in a pinned order (see header). Answers: 'ok' for a landed
-- invite AND for every refusal the inviter must not be able to
-- distinguish; 'slow_down' only for the sender's own caps.
create or replace function public.buddy_invite(p_friend uuid, p_book_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_data jsonb;
  v_isbn text;
  v_key text;
  v_recv boolean;
  v_ex record;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  -- One pair's writes are serialised, so the caps and the
  -- existing-row checks below are exact rather than racy.
  perform pg_advisory_xact_lock(hashtextextended(
    'buddy:' || least(v_uid, p_friend)::text || ':' || greatest(v_uid, p_friend)::text, 0));
  -- The book must be the inviter's own (the server owns the key).
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  v_data := coalesce(v_row.data, '{}'::jsonb);
  if btrim(coalesce(v_data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- Friendship, with blocks folded into the same generic refusal
  -- (v526/v527: a blocked pair is indistinguishable from an
  -- unlinked one).
  if p_friend = v_uid
     or not exists (
       select 1 from public.circle_links cl
       where cl.status = 'accepted'
         and ((cl.requester_id = v_uid and cl.addressee_id = p_friend)
           or (cl.addressee_id = v_uid and cl.requester_id = p_friend))
     )
     or exists (
       select 1 from public.blocks b
       where (b.blocker_id = v_uid and b.blocked_id = p_friend)
          or (b.blocker_id = p_friend and b.blocked_id = v_uid)
     )
  then raise exception 'not circle friends'; end if;
  -- Recipient posture, read only after the friendship gate: a
  -- missing profile row is treated as opted out (silent), so this
  -- function is not a user-existence oracle.
  select p.receive_buddy_invites into v_recv from public.profiles p where p.user_id = p_friend;
  if not found or v_recv is distinct from true then return 'ok'; end if;

  v_isbn := upper(regexp_replace(coalesce(nullif(v_data ->> 'isbn', ''), v_row.isbn, ''), '[^0-9Xx]', '', 'g'));
  if length(v_isbn) not in (10, 13) then v_isbn := ''; end if;
  v_key := public.toy_book_key(
    v_isbn,
    v_data ->> 'title',
    case when jsonb_typeof(v_data -> 'authors') = 'array' then v_data -> 'authors' ->> 0
         when jsonb_typeof(v_data -> 'authors') = 'string' then v_data ->> 'authors'
         else '' end
  );

  -- The inviter's own caps: the one distinct outcome, checked
  -- BEFORE the silent outcomes, deliberately (the v527 order) — an
  -- over-cap inviter hears 'slow_down' uniformly, whether or not
  -- this particular invite would have landed.
  if (select count(*) from public.buddy_send_log l
       where l.sender_id = v_uid and l.recipient_id = p_friend
         and l.created_at >= date_trunc('day', now())) >= 5
     or (select count(*) from public.buddy_send_log l
       where l.sender_id = v_uid
         and l.created_at >= date_trunc('day', now())) >= 20
  then return 'slow_down'; end if;

  -- Silent outcomes (all plain 'ok'): a decline tombstone within
  -- the year; a row that already stands between this pair for this
  -- book (an active read, or my own pending); their pending invite
  -- to me for the same book, which my invite accepts (mutual
  -- intent); and the anti-oracle gate — no copy of the invitee's
  -- with this key on a shelf I may already browse.
  if exists (
    select 1 from public.buddy_dismissals d
    where d.sender_id = v_uid and d.recipient_id = p_friend and d.book_key = v_key
      and d.created_at > now() - interval '1 year'
  ) then return 'ok'; end if;
  select id, status, inviter_id into v_ex
    from public.buddy_reads
   where book_key = v_key
     and ((inviter_id = v_uid and invitee_id = p_friend)
       or (inviter_id = p_friend and invitee_id = v_uid))
   order by (status = 'active') desc
   limit 1;
  if found then
    if v_ex.status = 'active' or v_ex.inviter_id = v_uid then return 'ok'; end if;
    update public.buddy_reads set status = 'active' where id = v_ex.id;
    return 'ok';
  end if;
  if not exists (
    select 1 from public.books rb
    where rb.user_id = p_friend
      and public.toy_book_key(
            case when length(upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                 then upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))
                 else '' end,
            rb.data ->> 'title',
            case when jsonb_typeof(rb.data -> 'authors') = 'array' then rb.data -> 'authors' ->> 0
                 when jsonb_typeof(rb.data -> 'authors') = 'string' then rb.data ->> 'authors'
                 else '' end
          ) = v_key
      and public.circle_book_visible(p_friend, rb.data ->> 'status')
  ) then return 'ok'; end if;

  insert into public.buddy_reads (inviter_id, invitee_id, book_key)
  values (v_uid, p_friend, v_key)
  on conflict (inviter_id, invitee_id, book_key) do nothing;
  if not found then return 'ok'; end if;
  insert into public.buddy_send_log (sender_id, recipient_id) values (v_uid, p_friend);

  -- Opportunistic prune (bounded, indexed): the log keeps 2 days,
  -- tombstones a year, stale pendings fall away (actives end only
  -- by an explicit end or the friendship ending).
  delete from public.buddy_send_log where created_at < now() - interval '2 days';
  delete from public.buddy_dismissals where created_at < now() - interval '1 year';
  delete from public.buddy_reads where status = 'pending' and created_at < now() - interval '60 days';
  return 'ok';
end;
$$;
revoke all on function public.buddy_invite(uuid, text) from public;
grant execute on function public.buddy_invite(uuid, text) to authenticated;

-- Accept or decline a pending invite. Decline is final and quiet:
-- the row dies and a machinery tombstone remembers the answer for
-- a year; the inviter has no surface where either fact is visible.
-- Accept re-validates the founding facts that can have changed
-- (friendship, blocks, the invitee still owning the book).
create or replace function public.buddy_respond(p_id uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid;
  v_b uuid;
  v_r record;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select inviter_id, invitee_id into v_a, v_b from public.buddy_reads where id = p_id;
  if not found then return 'ok'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'buddy:' || least(v_a, v_b)::text || ':' || greatest(v_a, v_b)::text, 0));
  -- Re-read under the lock: a stale decline must not be able to
  -- delete a read that was accepted meanwhile, and an accept on a
  -- row that is gone is a no-op, never a resurrection.
  select id, inviter_id, invitee_id, book_key, status into v_r
    from public.buddy_reads
   where id = p_id
   for update;
  if not found then return 'ok'; end if;
  if v_r.invitee_id <> v_uid or v_r.status <> 'pending' then return 'ok'; end if;
  -- The pair fell apart since the invite (unfriended or blocked —
  -- the cleanup should already have taken the row; if it somehow
  -- stands, it dies here, with no tombstone: the answer belongs to
  -- a friendship that no longer exists).
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = v_r.inviter_id and cl.addressee_id = v_uid)
        or (cl.addressee_id = v_r.inviter_id and cl.requester_id = v_uid))
  ) or exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_r.inviter_id)
       or (b.blocker_id = v_r.inviter_id and b.blocked_id = v_uid)
  ) then
    delete from public.buddy_reads where id = p_id;
    return 'ok';
  end if;
  if not coalesce(p_accept, false) then
    insert into public.buddy_dismissals (sender_id, recipient_id, book_key)
    values (v_r.inviter_id, v_uid, v_r.book_key)
    on conflict (sender_id, recipient_id, book_key)
    do update set created_at = now();
    delete from public.buddy_reads where id = p_id;
    return 'ok';
  end if;
  -- Accept: the invitee must still own a copy with this key (any
  -- status — it is their current shelf fact, checked directly; the
  -- inviter's copy is not re-gated: their state simply reads null
  -- in buddy_states() if they have since removed it).
  if not exists (
    select 1 from public.books rb
    where rb.user_id = v_uid
      and public.toy_book_key(
            case when length(upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                 then upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))
                 else '' end,
            rb.data ->> 'title',
            case when jsonb_typeof(rb.data -> 'authors') = 'array' then rb.data -> 'authors' ->> 0
                 when jsonb_typeof(rb.data -> 'authors') = 'string' then rb.data ->> 'authors'
                 else '' end
          ) = v_r.book_key
  ) then
    delete from public.buddy_reads where id = p_id;
    return 'ok';
  end if;
  update public.buddy_reads set status = 'active' where id = p_id;
  return 'ok';
end;
$$;
revoke all on function public.buddy_respond(uuid, boolean) from public;
grant execute on function public.buddy_respond(uuid, boolean) to authenticated;

-- End a buddy read (or withdraw a pending invite) — either party,
-- any time, silently. Always 'ok': whether a row existed is the
-- caller's own business only.
create or replace function public.buddy_end(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid;
  v_b uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select inviter_id, invitee_id into v_a, v_b from public.buddy_reads where id = p_id;
  if not found then return 'ok'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'buddy:' || least(v_a, v_b)::text || ':' || greatest(v_a, v_b)::text, 0));
  delete from public.buddy_reads
   where id = p_id and (inviter_id = v_uid or invitee_id = v_uid);
  return 'ok';
end;
$$;
revoke all on function public.buddy_end(uuid) from public;
grant execute on function public.buddy_end(uuid) to authenticated;

-- Unfriend cleanup (the v525/v527 pattern): when a circle link is
-- deleted and no accepted link remains between the pair, their
-- buddy reads die in both directions, whatever their status. Block
-- inserts sever links (v526), which fires this — a blocked pair's
-- buddy reads are removed by the same machinery.
create or replace function public.buddy_reads_unfriend()
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
    delete from public.buddy_reads
    where (inviter_id = old.requester_id and invitee_id = old.addressee_id)
       or (inviter_id = old.addressee_id and invitee_id = old.requester_id);
  end if;
  return old;
end;
$$;
drop trigger if exists buddy_reads_unfriend_cleanup on public.circle_links;
create trigger buddy_reads_unfriend_cleanup
  after delete on public.circle_links
  for each row execute function public.buddy_reads_unfriend();

-- ============ Remediation Batch A (v532) ============
-- Sender outbox RPCs + invite-inviter naming. Full rationale in
-- migrations/v532_sent_outbox.sql and v532_invite_inviter.sql.
-- Caller-scoped SECURITY DEFINER reads of the caller's OWN sends;
-- the underlying tables gain no new policies, and no
-- recipient-side state is returned (my_sent_buddy_invites does not
-- return the buddy row's status at all).

create or replace function public.my_sent_thoughts()
returns table (
  id uuid,
  recipient_id uuid,
  recipient_name text,
  sender_book_id text,
  book jsonb,
  note text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select t.id,
         t.recipient_id,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         t.sender_book_id,
         t.book,
         t.note,
         t.created_at
    from public.thought_of_you t
    left join public.profiles p on p.user_id = t.recipient_id
   where t.sender_id = auth.uid()
   order by t.created_at desc
   limit 50;
$$;
revoke all on function public.my_sent_thoughts() from public;
grant execute on function public.my_sent_thoughts() to authenticated;

create or replace function public.my_sent_buddy_invites()
returns table (
  id uuid,
  invitee_id uuid,
  invitee_name text,
  book_key text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select r.id,
         r.invitee_id,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         r.book_key,
         r.created_at
    from public.buddy_reads r
    left join public.profiles p on p.user_id = r.invitee_id
   where r.inviter_id = auth.uid()
   order by r.created_at desc
   limit 50;
$$;
revoke all on function public.my_sent_buddy_invites() from public;
grant execute on function public.my_sent_buddy_invites() to authenticated;

create or replace function public.invite_inviter_name(p_token text)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_them uuid;
  v_name text;
begin
  if auth.uid() is null then return null; end if;
  select user_id into v_them from public.circle_invites where code = p_token;
  if v_them is null or v_them = auth.uid() then return null; end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = auth.uid() and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = auth.uid())
  ) then
    return null;
  end if;
  select coalesce(
           case when p.handle is not null and p.handle <> '' then '@' || p.handle end,
           nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''))
    into v_name
    from public.profiles p
   where p.user_id = v_them;
  return v_name;
end;
$$;
revoke all on function public.invite_inviter_name(text) from public;
grant execute on function public.invite_inviter_name(text) to authenticated;

-- =====================================================================
-- v550 — Handles (mirror of supabase/migrations/v550_handles.sql).
-- The profiles columns (handle / findable / handle_changed_at) are
-- added with the other profile columns above, the circle_profiles
-- view above carries p.handle, and invite_inviter_name above prefers
-- the handle — everything else from the migration lives here: the
-- format CHECK + unique index, the tombstone and lookup-budget
-- tables, the content screen, the write guards, and the RPCs.
-- The migration file is the design record; read its header first.
-- =====================================================================

-- Format is a hard constraint, not a convention: lowercase a-z, 0-9
-- and underscore, 3–20 chars (the charset admits no Unicode
-- confusables, so homoglyph impersonation is dead by construction).
do $$
begin
  alter table public.profiles
    add constraint profiles_handle_format
    check (handle is null or handle ~ '^[a-z0-9_]{3,20}$');
exception when duplicate_object then null;
end $$;

-- Uniqueness is case-insensitive by construction (handles store
-- lowercase — the format check admits nothing else — and the index
-- lower()s regardless, so the invariant holds even if a future write
-- path forgets to normalize).
create unique index if not exists profiles_handle_unique
  on public.profiles (lower(handle))
  where handle is not null;

-- Tombstones: one row per release (clear or rename-away). RPC/definer
-- access only — RLS is on and there are deliberately NO policies, so
-- no client query can enumerate who used to hold what.
create table if not exists public.handle_history (
  handle text not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  released_at timestamptz not null default now()
);
create index if not exists handle_history_handle_idx
  on public.handle_history (handle, released_at desc);
create index if not exists handle_history_owner_idx
  on public.handle_history (owner_id, released_at desc);
alter table public.handle_history enable row level security;

-- Lookup budget: one row per lookup/request attempt. Same posture —
-- RLS on, no policies; only the definer RPCs touch it. Rows are
-- pruned to the rolling window by the RPCs themselves.
create table if not exists public.handle_lookups (
  caller_id uuid not null references auth.users (id) on delete cascade,
  looked_at timestamptz not null default now()
);
create index if not exists handle_lookups_caller_idx
  on public.handle_lookups (caller_id, looked_at desc);
alter table public.handle_lookups enable row level security;

-- ---------- the screen: one canonical list, two halves ----------
-- Mirrored token-for-token in js/237-handles.js (HANDLE_SCREEN_SLURS /
-- HANDLE_SCREEN_RESERVED); the handles test suite asserts agreement.
create or replace function public.handle_screen_slurs()
returns text[]
language sql
immutable
security definer
set search_path = public
as $$
  select array[
    'arsehole', 'asshole', 'bastard', 'beaner', 'bitch', 'chink',
    'cunt', 'faggot', 'fuck', 'gook', 'jigaboo', 'kike', 'nigger',
    'nigga', 'pedophile', 'porchmonkey', 'raghead', 'rapist',
    'retard', 'shit', 'slut', 'tranny', 'wetback', 'whore'
  ]::text[];
$$;
revoke all on function public.handle_screen_slurs() from public;

create or replace function public.handle_screen_reserved()
returns text[]
language sql
immutable
security definer
set search_path = public
as $$
  select array[
    'admin', 'administrator', 'cozylibram', 'libram', 'luna', 'mod',
    'moderator', 'official', 'owner', 'root', 'staff', 'support',
    'system', 'team'
  ]::text[];
$$;
revoke all on function public.handle_screen_reserved() from public;

-- Leetspeak + case normalization shared by every screen check.
create or replace function public.handle_normalize(p_text text)
returns text
language sql
immutable
security definer
set search_path = public
as $$
  select translate(lower(coalesce(p_text, '')), '0134578@$!+', 'oieastbasit');
$$;
revoke all on function public.handle_normalize(text) from public;

-- handle_screen_hit(text, mode) → the listed term hit, or null.
-- Modes: 'handle' (slur substring + reserved '_'-token), 'name'
-- (slur whole-token + reserved whole-token), 'bio' (slur whole-token
-- only). Checks run against both the leet-normalized text and the
-- plain lowercase text, so neither spelling lane escapes.
create or replace function public.handle_screen_hit(p_text text, p_mode text)
returns text
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  v_raw text := lower(coalesce(p_text, ''));
  v_norm text := public.handle_normalize(p_text);
  v_term text;
  v_tok text;
  v_tokens text[];
begin
  if p_mode = 'handle' then
    foreach v_term in array public.handle_screen_slurs() loop
      if strpos(v_norm, v_term) > 0 or strpos(v_raw, v_term) > 0 then
        return v_term;
      end if;
    end loop;
    -- Reserved: a whole '_'-delimited token. Digits are stripped per
    -- token on the raw lane ('admin1' → 'admin'); the normalized lane
    -- already decodes leet ('4dm1n' → 'admin').
    foreach v_term in array public.handle_screen_reserved() loop
      foreach v_tok in array regexp_split_to_array(v_norm, '_') loop
        if v_tok = v_term then return v_term; end if;
      end loop;
      foreach v_tok in array regexp_split_to_array(v_raw, '_') loop
        if regexp_replace(v_tok, '[0-9]+$', '') = v_term then return v_term; end if;
      end loop;
    end loop;
    return null;
  end if;
  -- 'name' and 'bio': whole-token equality on whitespace/punctuation
  -- splits — a flagged SUBSTRING inside a longer token never hits.
  v_tokens := regexp_split_to_array(v_norm, '[^a-z0-9]+')
           || regexp_split_to_array(v_raw, '[^a-z0-9]+');
  foreach v_term in array public.handle_screen_slurs() loop
    if v_term = any (v_tokens) then return v_term; end if;
  end loop;
  if p_mode = 'name' then
    foreach v_term in array public.handle_screen_reserved() loop
      if v_term = any (v_tokens) then return v_term; end if;
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function public.handle_screen_hit(text, text) from public;

-- ---------- write-path guards ----------
-- The handle (and its change stamp) may only move via claim_handle /
-- clear_handle, which set a transaction-local flag first. A direct
-- PostgREST write that tries to change either is rejected, so the
-- screen / quarantine / cooldown cannot be bypassed by hand.
create or replace function public.profiles_handle_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.handle_claim', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.handle is not null then
      raise exception 'handles are set via claim_handle' using errcode = '42501';
    end if;
  else
    if new.handle is distinct from old.handle
       or new.handle_changed_at is distinct from old.handle_changed_at then
      raise exception 'handles are set via claim_handle' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_handle_guard() from public;

drop trigger if exists profiles_handle_guard on public.profiles;
create trigger profiles_handle_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_handle_guard();

-- Name/bio screen: fires on INSERT and on any UPDATE that CHANGES a
-- screened field (an unchanged legacy value re-syncing is not a new
-- act of naming and is never blocked).
create or replace function public.profiles_content_screen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.first_name is distinct from old.first_name then
    if public.handle_screen_hit(new.first_name, 'name') is not null then
      raise exception 'profile content screened: first_name' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' or new.last_name is distinct from old.last_name then
    if public.handle_screen_hit(new.last_name, 'name') is not null then
      raise exception 'profile content screened: last_name' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' or new.bio is distinct from old.bio then
    if public.handle_screen_hit(new.bio, 'bio') is not null then
      raise exception 'profile content screened: bio' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_content_screen() from public;

drop trigger if exists profiles_content_screen on public.profiles;
create trigger profiles_content_screen
  before insert or update on public.profiles
  for each row execute function public.profiles_content_screen();

-- ---------- claim / clear ----------
-- Typed results, never raw exceptions, so the client can message
-- honestly: { ok:true, handle } or { ok:false, error: 'invalid' |
-- 'screened' | 'reserved' | 'taken' | 'quarantined' | 'cooldown' |
-- 'not_signed_in', days_remaining? }.
create or replace function public.claim_handle(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_new text := lower(trim(coalesce(p_handle, '')));
  v_cur text;
  v_changed timestamptz;
  v_hit text;
  v_owner uuid;
  v_rel timestamptz;
  v_reclaim boolean := false;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  if v_new !~ '^[a-z0-9_]{3,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select handle, handle_changed_at into v_cur, v_changed
    from public.profiles where user_id = v_me;
  if v_cur is not null and v_cur = v_new then
    return jsonb_build_object('ok', true, 'handle', v_new, 'unchanged', true);
  end if;
  v_hit := public.handle_screen_hit(v_new, 'handle');
  if v_hit is not null then
    if v_hit = any (public.handle_screen_reserved()) then
      return jsonb_build_object('ok', false, 'error', 'reserved');
    end if;
    return jsonb_build_object('ok', false, 'error', 'screened');
  end if;
  select user_id into v_owner
    from public.profiles
   where lower(handle) = v_new and user_id <> v_me;
  if v_owner is not null then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  -- Quarantine: the latest release of this handle governs.
  select owner_id, released_at into v_owner, v_rel
    from public.handle_history
   where handle = v_new
   order by released_at desc
   limit 1;
  if v_rel is not null and v_rel > now() - interval '90 days' then
    if v_owner <> v_me then
      return jsonb_build_object('ok', false, 'error', 'quarantined');
    end if;
    v_reclaim := true; -- my own handle coming back: always allowed
  end if;
  -- Rename cooldown: 30 days between identity changes. Reclaiming
  -- your own quarantined handle is exempt.
  if not v_reclaim and v_changed is not null
     and v_changed > now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'cooldown',
      'days_remaining',
      greatest(1, ceil(extract(epoch from
        (v_changed + interval '30 days' - now())) / 86400)::int));
  end if;
  perform set_config('app.handle_claim', 'on', true);
  begin
    if v_cur is not null then
      insert into public.handle_history (handle, owner_id) values (v_cur, v_me);
    end if;
    insert into public.profiles as pr (user_id, handle, handle_changed_at)
    values (v_me, v_new, now())
    on conflict (user_id) do update
      set handle = excluded.handle,
          handle_changed_at = excluded.handle_changed_at;
  exception when unique_violation then
    -- Lost a simultaneous claim race: the index held; say so plainly.
    return jsonb_build_object('ok', false, 'error', 'taken');
  end;
  return jsonb_build_object('ok', true, 'handle', v_new);
end;
$$;
revoke all on function public.claim_handle(text) from public;
grant execute on function public.claim_handle(text) to authenticated;

-- Clearing is always allowed (a privacy exit is never gated by the
-- cooldown); the released handle tombstones like any other release.
create or replace function public.clear_handle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_cur text;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  select handle into v_cur from public.profiles where user_id = v_me;
  if v_cur is null then
    return jsonb_build_object('ok', true, 'cleared', false);
  end if;
  perform set_config('app.handle_claim', 'on', true);
  insert into public.handle_history (handle, owner_id) values (v_cur, v_me);
  update public.profiles
     set handle = null, handle_changed_at = now()
   where user_id = v_me;
  return jsonb_build_object('ok', true, 'cleared', true);
end;
$$;
revoke all on function public.clear_handle() from public;
grant execute on function public.clear_handle() to authenticated;

-- ---------- lookup / availability / request ----------
-- The shared budget spend: prune this caller's rows to the rolling
-- hour, record the attempt, and report whether the cap is blown.
-- Attempts count even when they return nothing — that's what makes
-- probing expensive.
create or replace function public.handle_lookup_budget()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent int;
begin
  delete from public.handle_lookups
   where caller_id = auth.uid()
     and looked_at <= now() - interval '1 hour';
  insert into public.handle_lookups (caller_id) values (auth.uid());
  select count(*) into v_recent
    from public.handle_lookups
   where caller_id = auth.uid()
     and looked_at > now() - interval '1 hour';
  return v_recent <= 30;
end;
$$;
revoke all on function public.handle_lookup_budget() from public;

-- Exact-match lookup. Minimal shape — handle, avatar, and the
-- share_bio-gated content, exactly the projection's gates. NEVER
-- first_name / last_name. No row for: unknown handle, findable off,
-- a block in either direction, the caller's own handle, a blown
-- budget, or a signed-out caller — all indistinguishable.
create or replace function public.lookup_handle(p_handle text)
returns table (
  handle text,
  avatar_id text,
  avatar_path text,
  bio text,
  fav_genres text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
begin
  if v_me is null then return; end if;
  if not public.handle_lookup_budget() then return; end if;
  return query
  select p.handle, p.avatar_id, p.avatar_path,
         case when p.share_bio then p.bio end,
         case when p.share_bio then p.fav_genres end
    from public.profiles p
   where lower(p.handle) = v_h
     and p.findable is true
     and p.user_id <> v_me
     and not exists (
       select 1 from public.blocks b
        where (b.blocker_id = v_me and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = v_me)
     );
end;
$$;
revoke all on function public.lookup_handle(text) from public;
grant execute on function public.lookup_handle(text) to authenticated;

-- Boolean only: claimable-by-me right now (format + screen + not
-- held + not quarantined-by-another). No owner information of any
-- kind rides along. My own current handle reports false (it is
-- taken — by me; the editor words that case itself).
create or replace function public.handle_available(p_handle text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_owner uuid;
  v_rel timestamptz;
begin
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
$$;
revoke all on function public.handle_available(text) from public;
grant execute on function public.handle_available(text) to authenticated;

-- Add by handle: creates a PENDING link (see the header — never an
-- instant friendship). Every refusal is the same { ok:false,
-- error:'unavailable' }: unknown, not findable, blocked either way,
-- already linked, duplicate pending, self, signed out, over budget.
create or replace function public.request_by_handle(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_them uuid;
  v_fail jsonb := jsonb_build_object('ok', false, 'error', 'unavailable');
begin
  if v_me is null then return v_fail; end if;
  if not public.handle_lookup_budget() then return v_fail; end if;
  select user_id into v_them
    from public.profiles
   where lower(handle) = v_h and findable is true;
  if v_them is null or v_them = v_me then return v_fail; end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = v_me and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = v_me)
  ) then return v_fail; end if;
  if exists (
    select 1 from public.circle_links cl
     where ((cl.requester_id = v_me and cl.addressee_id = v_them)
         or (cl.requester_id = v_them and cl.addressee_id = v_me))
       and cl.status in ('accepted', 'pending')
  ) then return v_fail; end if;
  -- A declined row from an earlier round is replaced by the fresh
  -- request (minds change; the block is the abuse answer, as ever).
  delete from public.circle_links
   where ((requester_id = v_me and addressee_id = v_them)
       or (requester_id = v_them and addressee_id = v_me))
     and status = 'declined';
  insert into public.circle_links (requester_id, addressee_id, status)
  values (v_me, v_them, 'pending');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.request_by_handle(text) from public;
grant execute on function public.request_by_handle(text) to authenticated;

-- Block from the lookup card: the card's shape carries no user_id
-- (by design), so the block resolves server-side under the same
-- gates as the lookup itself — an unresolvable handle fails with
-- the same indistinguishable shape. The insert fires the v526
-- sever trigger, exactly like the client-side block insert.
create or replace function public.block_by_handle(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_them uuid;
  v_fail jsonb := jsonb_build_object('ok', false, 'error', 'unavailable');
begin
  if v_me is null then return v_fail; end if;
  select user_id into v_them
    from public.profiles
   where lower(handle) = v_h and findable is true;
  if v_them is null or v_them = v_me then return v_fail; end if;
  insert into public.blocks (blocker_id, blocked_id)
  values (v_me, v_them)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.block_by_handle(text) from public;
grant execute on function public.block_by_handle(text) to authenticated;

-- Report from the lookup card: same server-side resolution, same
-- reason vocabulary and table as the v246 client flow.
create or replace function public.report_by_handle(p_handle text, p_reason text, p_details text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_them uuid;
  v_fail jsonb := jsonb_build_object('ok', false, 'error', 'unavailable');
begin
  if v_me is null then return v_fail; end if;
  if p_reason not in ('spam', 'harassment', 'inappropriate', 'fake_account', 'other') then
    return v_fail;
  end if;
  select user_id into v_them
    from public.profiles
   where lower(handle) = v_h and findable is true;
  if v_them is null or v_them = v_me then return v_fail; end if;
  insert into public.user_reports (reporter_id, reported_user_id, reason, details)
  values (v_me, v_them, p_reason, left(coalesce(p_details, ''), 1000));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.report_by_handle(text, text, text) from public;
grant execute on function public.report_by_handle(text, text, text) to authenticated;

-- "Formerly @…": the friend's most recent released handle, while
-- its quarantine still runs. Linkage-gated (accepted circle members
-- only) and null for everything else — self, strangers, no history,
-- expired quarantine, or a handle they've since reclaimed (that one
-- is current, not former).
create or replace function public.friend_formerly(p_user uuid)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_h text;
begin
  if auth.uid() is null or auth.uid() = p_user then return null; end if;
  if not exists (
    select 1 from public.circle_links cl
     where cl.status = 'accepted'
       and ((cl.requester_id = auth.uid() and cl.addressee_id = p_user)
         or (cl.addressee_id = auth.uid() and cl.requester_id = p_user))
  ) then return null; end if;
  select h.handle into v_h
    from public.handle_history h
   where h.owner_id = p_user
     and h.released_at > now() - interval '90 days'
   order by h.released_at desc
   limit 1;
  if v_h is null then return null; end if;
  if exists (select 1 from public.profiles
              where user_id = p_user and handle = v_h) then
    return null;
  end if;
  return v_h;
end;
$$;
revoke all on function public.friend_formerly(uuid) from public;
grant execute on function public.friend_formerly(uuid) to authenticated;


-- ============ Marginalia (v574) ============
-- The full argument — fraction positions computed server-side
-- from the author's own copy, locked notes absent from the only
-- read door's payload (no friend SELECT policy exists, by
-- design), shelf-visibility composition at read time, the
-- profiles opt-out with server teeth, screen + report-with-
-- snapshot + admin removal wired before visibility, exact caps
-- under an advisory lock — is in
-- migrations/v574_marginalia.sql. Writes and reads go only
-- through the marginalia_* RPCs below.

alter table public.profiles
  add column if not exists marginalia_enabled boolean not null default true;

create table if not exists public.marginalia_notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  frac double precision not null check (frac > 0 and frac <= 1),
  page integer not null check (page >= 1),
  page_count integer not null check (page_count >= 1),
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists marginalia_notes_book_idx
  on public.marginalia_notes (book_key, frac);
create index if not exists marginalia_notes_author_idx
  on public.marginalia_notes (author_id, created_at);

create table if not exists public.marginalia_send_log (
  author_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists marginalia_send_log_author_idx
  on public.marginalia_send_log (author_id, created_at);

alter table public.marginalia_notes enable row level security;
alter table public.marginalia_send_log enable row level security;

-- Machinery table: nobody reads or writes it directly, ever.
revoke all on public.marginalia_send_log from public, anon, authenticated;

-- Notes table: reads exist only through marginalia_for_book() and
-- the admin policy below. Direct INSERT/UPDATE/DELETE grants are
-- revoked so no PostgREST path can bypass the RPC doors; SELECT
-- stays granted but is row-gated by the lone admin policy — a
-- non-admin's direct select returns zero rows.
revoke insert, update, delete on public.marginalia_notes from authenticated;
revoke all on public.marginalia_notes from anon;

-- The Observatory's read (and the only SELECT policy on the table).
drop policy if exists "admins read marginalia notes" on public.marginalia_notes;
create policy "admins read marginalia notes" on public.marginalia_notes
  for select
  using (is_admin());

-- (Deliberately NO other policies: marginalia_add(),
-- marginalia_for_book(), marginalia_delete(), marginalia_report(),
-- marginalia_mine() and marginalia_admin_remove() are the only
-- doors, and the read door is fraction-gated.)

-- ---------- private machinery (definer-called only) ----------

-- A numeric-ish jsonb field: JSON numbers and numeric strings
-- count; anything else is null. Never raises (books.data is
-- client-written free-form jsonb — see header).
create or replace function public.marginalia_num(p_data jsonb, p_key text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_data is null then null
    when jsonb_typeof(p_data -> p_key) = 'number' then (p_data ->> p_key)::numeric
    when jsonb_typeof(p_data -> p_key) = 'string'
         and (p_data ->> p_key) ~ '^[0-9]+(\.[0-9]+)?$' then (p_data ->> p_key)::numeric
    else null
  end;
$$;
revoke all on function public.marginalia_num(jsonb, text) from public;

-- ISBN-10 → ISBN-13 (978 prefix + recomputed check digit); a
-- 13-digit input passes through; anything else returns ''.
create or replace function public.marginalia_isbn13(p_isbn text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := coalesce(p_isbn, '');
  v12 text;
  v_sum int := 0;
  v_i int;
begin
  if length(v) = 13 then return v; end if;
  if length(v) <> 10 then return ''; end if;
  v12 := '978' || left(v, 9);
  for v_i in 1..12 loop
    v_sum := v_sum + (substr(v12, v_i, 1)::int) * (case when v_i % 2 = 1 then 1 else 3 end);
  end loop;
  return v12 || ((10 - (v_sum % 10)) % 10)::text;
end;
$$;
revoke all on function public.marginalia_isbn13(text) from public;

-- The feature's book key: toy_book_key (v527) over an
-- ISBN-13-normalized ISBN, computed from a books row's data exactly
-- as v528 computes it (data.isbn first, the column as fallback;
-- first author from the array-or-string field). Both marginalia
-- RPCs use this and only this, so writer and viewer always agree.
create or replace function public.marginalia_book_key(p_data jsonb, p_isbn_col text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_isbn text;
begin
  v_isbn := upper(regexp_replace(coalesce(nullif(p_data ->> 'isbn', ''), p_isbn_col, ''), '[^0-9Xx]', '', 'g'));
  if length(v_isbn) not in (10, 13) then v_isbn := ''; else v_isbn := public.marginalia_isbn13(v_isbn); end if;
  return public.toy_book_key(
    v_isbn,
    p_data ->> 'title',
    case when jsonb_typeof(p_data -> 'authors') = 'array' then p_data -> 'authors' ->> 0
         when jsonb_typeof(p_data -> 'authors') = 'string' then p_data ->> 'authors'
         else '' end
  );
end;
$$;
revoke all on function public.marginalia_book_key(jsonb, text) from public;

-- One copy's HISTORICAL read fraction (see header): 1 for a copy
-- the reader has finished by any recorded evidence, else the
-- clamped progress fraction, else 0.
create or replace function public.marginalia_copy_frac(p_data jsonb)
returns double precision
language plpgsql
immutable
set search_path = public
as $$
declare
  v_prog numeric := public.marginalia_num(p_data, 'progress');
  v_pc numeric := public.marginalia_num(p_data, 'pageCount');
begin
  if coalesce(p_data ->> 'status', '') = 'read'
     or nullif(btrim(coalesce(p_data ->> 'dateFinished', '')), '') is not null
     or coalesce(public.marginalia_num(p_data, 'readCount'), 0) >= 1
     or coalesce(p_data ->> 'previouslyRead', '') = 'true'
  then return 1; end if;
  if v_pc is null or v_pc <= 0 or v_prog is null or v_prog <= 0 then return 0; end if;
  return least(1, v_prog / v_pc)::double precision;
end;
$$;
revoke all on function public.marginalia_copy_frac(jsonb) from public;

-- ---------- the write door ----------

-- Leave a note. The client names its own book by id and (only) a
-- page + text; the server owns the key, the fraction, the
-- eligibility and the caps. Answers: 'ok', 'slow_down' (the daily
-- cap — the author's own fact, safe to name), 'off' (the author's
-- own switch). Validation failures raise honest errors — they are
-- all facts about the CALLER's own book and note, never about
-- anyone else.
create or replace function public.marginalia_add(p_book_id text, p_page integer, p_body text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_key text;
  v_on boolean;
  v_prog numeric;
  v_pc numeric;
  v_cur integer;
  v_pci integer;
  v_page integer;
  v_body text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  -- One author's writes are serialised, so the caps below are
  -- exact rather than racy (the v527 discipline).
  perform pg_advisory_xact_lock(hashtextextended('marginalia:' || v_uid::text, 0));
  -- The book must be the author's own (the server owns the key).
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  if btrim(coalesce(v_row.data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- The author's own switch, checked before any other work.
  select p.marginalia_enabled into v_on from public.profiles p where p.user_id = v_uid;
  if found and v_on is distinct from true then return 'off'; end if;

  v_prog := public.marginalia_num(v_row.data, 'progress');
  v_pc := public.marginalia_num(v_row.data, 'pageCount');
  v_cur := coalesce(floor(v_prog)::integer, 0);
  if v_cur < 1 then raise exception 'no progress yet'; end if;
  if v_pc is null or v_pc < 1 then raise exception 'page count needed'; end if;
  v_pci := floor(v_pc)::integer;
  v_page := coalesce(p_page, v_cur);
  if v_page < 1 or v_page > v_cur then raise exception 'pin outside your progress'; end if;

  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) < 1 or char_length(v_body) > 280 then raise exception 'note length'; end if;
  -- The v550 slur screen ('bio' lane: whole-token). A hit refuses
  -- with a generic shape; the term is never echoed back.
  if public.handle_screen_hit(v_body, 'bio') is not null then raise exception 'note refused'; end if;

  v_key := public.marginalia_book_key(v_row.data, v_row.isbn);

  -- Caps, under the lock: 50/day per author (the one distinct
  -- outcome), 20 live notes per (author, book).
  if (select count(*) from public.marginalia_send_log l
       where l.author_id = v_uid
         and l.created_at >= date_trunc('day', now())) >= 50
  then return 'slow_down'; end if;
  if (select count(*) from public.marginalia_notes n
       where n.author_id = v_uid and n.book_key = v_key) >= 20
  then raise exception 'too many notes on this book'; end if;

  insert into public.marginalia_notes (author_id, book_key, frac, page, page_count, body)
  values (v_uid, v_key, v_page::double precision / v_pci::double precision, v_page, v_pci, v_body);
  insert into public.marginalia_send_log (author_id) values (v_uid);

  -- Opportunistic prune (bounded, indexed): the log keeps 2 days.
  delete from public.marginalia_send_log where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;
revoke all on function public.marginalia_add(text, integer, text) from public;
grant execute on function public.marginalia_add(text, integer, text) to authenticated;

-- ---------- the read door (fraction-gated) ----------

-- The notes for one of the caller's own books, gated by the
-- caller's own progress (see header). Returns a jsonb array of
-- {id, author_id, frac, page, page_count, body, created_at} ordered
-- by position. Anything not returned does not exist as far as the
-- payload is concerned: no count, no placeholder, no error shape
-- distinguishing "locked notes exist" from "no notes".
create or replace function public.marginalia_for_book(p_book_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_key text;
  v_on boolean;
  v_frac double precision;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  if btrim(coalesce(v_row.data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- The viewer's own switch: off means no notes, full stop.
  select p.marginalia_enabled into v_on from public.profiles p where p.user_id = v_uid;
  if found and v_on is distinct from true then return '[]'::jsonb; end if;

  v_key := public.marginalia_book_key(v_row.data, v_row.isbn);
  select coalesce(max(public.marginalia_copy_frac(b.data)), 0) into v_frac
    from public.books b
   where b.user_id = v_uid
     and public.marginalia_book_key(b.data, b.isbn) = v_key;

  return coalesce((
    select jsonb_agg(row_to_json(t) order by t.frac asc, t.created_at asc)
    from (
      select n.id, n.author_id, n.frac, n.page, n.page_count, n.body, n.created_at
        from public.marginalia_notes n
       where n.book_key = v_key
         and (
           n.author_id = v_uid
           or (
             n.frac <= v_frac
             -- The author's switch: off withdraws their notes.
             and coalesce((select p.marginalia_enabled from public.profiles p
                            where p.user_id = n.author_id), true)
             -- The author's matched copy is visible to me through
             -- the shelf gates (link + share_library +
             -- hidden_shelves + the copy still exists), composed
             -- per copy status like the buddy gate.
             and exists (
               select 1 from public.books ab
                where ab.user_id = n.author_id
                  and public.marginalia_book_key(ab.data, ab.isbn) = v_key
                  and public.circle_book_visible(n.author_id, ab.data ->> 'status')
             )
             -- No block in either direction (belt over the link
             -- sever + the visibility helper's own blocked branch).
             and not exists (
               select 1 from public.blocks bl
                where (bl.blocker_id = v_uid and bl.blocked_id = n.author_id)
                   or (bl.blocker_id = n.author_id and bl.blocked_id = v_uid)
             )
           )
         )
       order by n.frac asc, n.created_at asc
       limit 500
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.marginalia_for_book(text) from public;
grant execute on function public.marginalia_for_book(text) to authenticated;

-- ---------- the author's own doors ----------

-- Delete one of my notes. Always 'ok': whether a row existed is
-- the caller's own business only.
create or replace function public.marginalia_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  delete from public.marginalia_notes
   where id = p_id and author_id = v_uid;
  return 'ok';
end;
$$;
revoke all on function public.marginalia_delete(uuid) from public;
grant execute on function public.marginalia_delete(uuid) to authenticated;

-- My notes, all of them, for the "My margin notes" list — the
-- author's enumeration that survives losing the book copy (see
-- header: deleting a copy must not strand its notes beyond the
-- author's reach). Caller-scoped by construction.
create or replace function public.marginalia_mine()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(t) order by t.created_at desc)
    from (
      select n.id, n.book_key, n.frac, n.page, n.page_count, n.body, n.created_at
        from public.marginalia_notes n
       where n.author_id = v_uid
       order by n.created_at desc
       limit 200
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.marginalia_mine() from public;
grant execute on function public.marginalia_mine() to authenticated;

-- ---------- moderation doors ----------

-- Report a note. The server snapshots the note (id, key, position,
-- body) into the report's details, so the Observatory reviews the
-- actual text. Reasons are the user_reports CHECK list; anything
-- else files as 'other'. Reporting your own note, or a note that
-- doesn't exist, is a silent 'ok' — the reporter's business only.
create or replace function public.marginalia_report(p_note_id uuid, p_reason text, p_details text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n record;
  v_reason text := coalesce(p_reason, 'other');
  v_details text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if v_reason not in ('spam', 'harassment', 'inappropriate', 'fake_account', 'other') then
    v_reason := 'other';
  end if;
  select id, author_id, book_key, frac, body into v_n
    from public.marginalia_notes where id = p_note_id;
  if not found or v_n.author_id = v_uid then return 'ok'; end if;
  v_details := left(coalesce(p_details, ''), 500)
    || '\n— Margin note ' || v_n.id::text
    || ' (book key ' || v_n.book_key
    || ', position ' || round((v_n.frac * 100)::numeric)::text || '% in): "'
    || v_n.body || '"';
  insert into public.user_reports (reporter_id, reported_user_id, reason, details)
  values (v_uid, v_n.author_id, v_reason, v_details);
  return 'ok';
end;
$$;
revoke all on function public.marginalia_report(uuid, text, text) from public;
grant execute on function public.marginalia_report(uuid, text, text) to authenticated;

-- Admin removal (the Observatory's delete). A non-admin call is a
-- silent no-op — the function's existence is public, its effect is
-- not probeable.
create or replace function public.marginalia_admin_remove(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not is_admin() then return 'ok'; end if;
  delete from public.marginalia_notes where id = p_id;
  return 'ok';
end;
$$;
revoke all on function public.marginalia_admin_remove(uuid) from public;
grant execute on function public.marginalia_admin_remove(uuid) to authenticated;
