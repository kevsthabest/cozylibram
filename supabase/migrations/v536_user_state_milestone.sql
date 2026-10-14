-- v536: user_state sixth section — the pinned milestone (js/219).
-- One additive column, same pattern as v520 (sections), v521 (shelf),
-- v524 (privacy). Payload shape { _at: <ms epoch>, value: <milestone id
-- string | null> } — a user preference (which earned milestone the
-- reader wears), written and read only through js/229-user-state.js's
-- per-section machinery. It does NOT join the settings snapshot (that
-- key list is frozen at its v518 shape) and never touches profiles:
-- user_state is own-rows-only, so the pin is never projected to
-- friends. Additive and idempotent; until this runs, the sections pull
-- errors on the missing column and is caught — the pin simply stays
-- device-local (fail-open, same as every prior section).
alter table public.user_state
  add column if not exists milestone_state jsonb not null default '{}'::jsonb;
