-- v520: user_state sections — warning prefs, Up Next, release state.
-- v518 created user_state with a single `settings` jsonb column. Three
-- more slices of per-user state now roam (js/229-user-state.js), each in
-- its own column with its own conflict clock (_at inside the payload), so
-- the sections sync independently and the settings snapshot keeps its
-- exact v518 shape — a constraint from the v518 security review: never
-- grow the settings key list under full-snapshot apply.
--
-- Payload shapes: warning_prefs { _at, value }, up_next { _at, value },
-- release_state { _at, values }. The defaults below ({} / []) are the
-- "never synced" markers the client seeds against; existing rows pick
-- them up automatically. No policy changes: the v518 "own state" FOR ALL
-- policy covers every column on the row.

alter table public.user_state
  add column if not exists warning_prefs jsonb not null default '{}'::jsonb;
alter table public.user_state
  add column if not exists up_next jsonb not null default '[]'::jsonb;
alter table public.user_state
  add column if not exists release_state jsonb not null default '{}'::jsonb;
