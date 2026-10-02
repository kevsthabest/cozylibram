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

drop policy if exists "send requests" on circle_links;
create policy "send requests" on circle_links
  for insert
  with check (auth.uid() = requester_id and status = 'pending');

drop policy if exists "answer requests" on circle_links;
create policy "answer requests" on circle_links
  for update
  using (auth.uid() = addressee_id and status = 'pending')
  with check (auth.uid() = addressee_id and status in ('accepted', 'declined'));

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

-- Circle privacy controls on the profile: a master share switch plus
-- per-shelf hiding (e.g. keep the DNF shelf to yourself).
alter table profiles add column if not exists share_library boolean not null default true;
alter table profiles add column if not exists hidden_shelves text[] not null default '{}';

-- Friends can see each other's names, avatars, and privacy flags (needed to
-- render the circle and to enforce shelf visibility). Pending handshakes are
-- included so an incoming request shows who it's from.
drop policy if exists "circle reads profiles" on profiles;
create policy "circle reads profiles" on profiles
  for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from circle_links cl
      where cl.status in ('accepted', 'pending')
        and ((cl.requester_id = profiles.user_id and cl.addressee_id = auth.uid())
          or (cl.addressee_id = profiles.user_id and cl.requester_id = auth.uid()))
    )
  );

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
      and coalesce((select p.share_library from profiles p where p.user_id = books.user_id), true)
      and not (coalesce(books.data->>'status', '') = any (
        coalesce((select p.hidden_shelves from profiles p where p.user_id = books.user_id), '{}')))
    )
  );

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
