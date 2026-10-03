-- v246: user abuse reports + app-level bans.
--
-- user_reports: filed by users against other users (spam friend requests,
-- harassment, …). Users can file and see their own; admins see and manage all.
-- banned_users: reversible app-level ban flag. Banned users are signed out
-- client-side (enterApp) and rejected by every /api/* function (403) via the
-- ban check in functions/_lib/require-user.js.

create table if not exists user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'fake_account', 'other')),
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,
  constraint user_reports_no_self_report check (reporter_id <> reported_user_id)
);

alter table user_reports enable row level security;

drop policy if exists "user_reports: users file own" on user_reports;
create policy "user_reports: users file own" on user_reports for insert
  with check (auth.uid() = reporter_id);

drop policy if exists "user_reports: users see own" on user_reports;
create policy "user_reports: users see own" on user_reports for select
  using (auth.uid() = reporter_id);

drop policy if exists "user_reports: admins manage all" on user_reports;
create policy "user_reports: admins manage all" on user_reports for all
  using (is_admin()) with check (is_admin());

create table if not exists banned_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text not null default '',
  banned_by uuid references auth.users(id) on delete set null,
  banned_at timestamptz not null default now()
);

alter table banned_users enable row level security;

-- A user can read their own ban row (the client shows the suspension notice).
drop policy if exists "banned_users: users see own" on banned_users;
create policy "banned_users: users see own" on banned_users for select
  using (auth.uid() = user_id);

drop policy if exists "banned_users: admins manage all" on banned_users;
create policy "banned_users: admins manage all" on banned_users for all
  using (is_admin()) with check (is_admin());
