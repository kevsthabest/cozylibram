-- v537: user_state seventh section — device prefs that are account
-- prefs (js/229): the analytics opt-out (spicyshelves.analytics) and
-- the reading-log remove-entry visibility (spicyshelves.logremove).
-- One additive column, same pattern as v520 (sections), v521 (shelf),
-- v524 (privacy), v536 (milestone). Payload shape { _at: <ms epoch>,
-- values: { key: raw localStorage string } } — release-style, written
-- and read only through js/229-user-state.js's per-section machinery.
-- They do NOT join the settings snapshot (that key list is frozen at
-- its v518 shape) and never touch profiles: user_state is
-- own-rows-only, so an opt-out is never projected to friends.
-- Additive and idempotent; until this runs, the sections pull errors
-- on the missing column and is caught — the prefs simply stay
-- device-local (fail-open, same as every prior section).
alter table public.user_state
  add column if not exists prefs_state jsonb not null default '{}'::jsonb;
