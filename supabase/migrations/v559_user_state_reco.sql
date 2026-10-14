-- v559: user_state eighth section — Discover recommendation dismissals
-- (js/229): the 'hc:<id>' keys a reader has dismissed in Discover
-- (js/198), previously the one piece of user data with no cloud copy
-- (per-slot IDB kv + a localStorage fallback, per-device only).
-- One additive column, same pattern as v520 (sections), v521 (shelf),
-- v524 (privacy), v536 (milestone), v537 (prefs). Payload shape
-- { _at: <ms epoch>, value: [key, ...] } — warning/upnext-style,
-- written and read only through js/229-user-state.js's per-section
-- machinery. Merge is a UNION (dismissals are append-only), applied
-- client-side on pull and on push, capped to the newest 200 after
-- merging. It does NOT join the settings snapshot (that key list is
-- frozen at its v518 shape) and never touches profiles: user_state is
-- own-rows-only, so a dismissal list is never projected to friends.
-- Additive and idempotent; until this runs, the sections pull errors
-- on the missing column and is caught — the dismissals simply stay
-- device-local (fail-open, same as every prior section).
alter table public.user_state
  add column if not exists reco_state jsonb not null default '{}'::jsonb;
