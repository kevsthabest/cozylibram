-- v518: user_state table — the server home for roaming per-user state.
-- Through v517, themes and taste settings lived only in per-device
-- localStorage, so the PC and the phone drifted apart (different theme,
-- different accent, opt-outs re-asking). The settings section syncs via
-- js/229-user-state.js; future sections (warning prefs, Up Next, release
-- state, shelf state) become sibling jsonb columns on this same table.
--
-- Deliberately a dedicated table, NOT columns on profiles: profiles
-- carries the "circle reads profiles" policy and RLS is row-level, so any
-- prefs column there would be readable by every circle friend. This table
-- is own-rows only.

create table if not exists public.user_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

drop policy if exists "own state" on public.user_state;
create policy "own state" on public.user_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
