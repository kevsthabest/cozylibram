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
         case when p.share_bio then p.fav_genres end as fav_genres
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

drop policy if exists "giver or owner reads reactions" on public.moment_reactions;
create policy "giver or owner reads reactions" on public.moment_reactions
  for select
  using (auth.uid() = giver_id or auth.uid() = owner_id);

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
      where b.user_id = p_user and b.data ->> 'status' = 'tbr'
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
