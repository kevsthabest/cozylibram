-- First-party product analytics — Cozy Libram (v118)
--
-- Re-run safe: every statement is idempotent (create if not exists).
-- Run after the main schema.sql, in the Supabase SQL editor.
--
-- Privacy model: we measure HOW the app is used, never WHAT is inside
-- someone's library. The events table carries only event names, a small
-- fixed set of enum properties, and the app version. No titles, authors,
-- ISBNs, ratings, notes, or shelf contents — the client-side EVENT_DEFS
-- allowlist in js/065-analytics.js structurally prevents them from
-- ever being sent.

-- ── admin registry ─────────────────────────────────────────────
-- One row per administrator. Add yourself after running this:
--   insert into app_admins (user_id)
--   select id from auth.users where email = 'you@example.com';
create table if not exists app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table app_admins enable row level security;

-- Server-side admin check. SECURITY DEFINER so it can read app_admins
-- regardless of the caller's own policies; fixed search_path guards
-- against search-path attacks.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;

drop policy if exists "app_admins: admins can read" on app_admins;
create policy "app_admins: admins can read"
  on app_admins for select
  using (is_admin());
-- No insert/update/delete policies: the registry is managed from the
-- Supabase SQL editor by the project owner, never from the client.

-- ── events ─────────────────────────────────────────────────────
create table if not exists analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_name text not null,
  event_category text not null,
  properties jsonb not null default '{}'::jsonb,
  app_version text not null default 'unknown',
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_created
  on analytics_events (created_at desc);
create index if not exists analytics_events_admin_lookup
  on analytics_events (event_name, created_at desc);

alter table analytics_events enable row level security;

-- Regular users may INSERT only their own events. No select/update/delete:
-- nobody reads analytics except admins.
drop policy if exists "analytics: users insert own" on analytics_events;
create policy "analytics: users insert own"
  on analytics_events for insert
  with check (auth.uid() = user_id);

-- Admins may read everything (the Libram Observatory dashboard).
drop policy if exists "analytics: admins read all" on analytics_events;
create policy "analytics: admins read all"
  on analytics_events for select
  using (is_admin());
