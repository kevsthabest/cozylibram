-- v565: user_state eighth section — The Finale keepsakes (js/238).
-- One additive column, same pattern as v520 (sections), v521 (shelf),
-- v524 (privacy), v536 (milestone pin), v537 (prefs). Payload shape
-- { _at: <ms epoch>, value: <series key -> finale record map> } — the
-- reader's series-finish keepsakes, written and read only through
-- js/229-user-state.js's per-section machinery. It does NOT join the
-- settings snapshot (that key list is frozen at its v518 shape) and
-- never touches profiles: user_state is own-rows-only, so a finale is
-- never projected to friends. Additive and idempotent; until this
-- runs, the sections pull errors on the missing column and is caught —
-- the keepsakes simply stay device-local (fail-open, same as every
-- prior section).
alter table public.user_state
  add column if not exists finale_state jsonb not null default '{}'::jsonb;
