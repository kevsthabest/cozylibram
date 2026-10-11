-- v474: milestones table for cross-device milestone sync.
-- Milestones were local-only (localStorage) through v473; they now sync via
-- Supabase so achievements follow the reader across devices. Milestones are
-- never un-earned, so the sync is upsert-only — no deletes, no tombstones.
-- Merge rule (in js/219-milestones.js): union of achieved milestones,
-- earliest achieved_at wins, seen is OR.

create table if not exists public.milestones (
  user_id uuid not null references auth.users (id) on delete cascade,
  milestone_id text not null,
  achieved_at timestamptz,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, milestone_id)
);

create index if not exists idx_milestones_user on public.milestones (user_id);

alter table public.milestones enable row level security;

drop policy if exists "milestones: read own" on public.milestones;
create policy "milestones: read own" on public.milestones
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "milestones: insert own" on public.milestones;
create policy "milestones: insert own" on public.milestones
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "milestones: update own" on public.milestones;
create policy "milestones: update own" on public.milestones
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "milestones: admin all" on public.milestones;
create policy "milestones: admin all" on public.milestones
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- No "delete own" policy: milestones are never un-earned, so the sync is
-- upsert-only. Users cannot delete their own rows; admins manage via the
-- "admin all" policy above.
