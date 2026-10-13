-- v524: user_state privacy section — age band + content shield roam.
-- v518 created user_state with a single `settings` jsonb column; v520
-- added warning prefs, Up Next, and release state as sibling columns;
-- v521 added shelf state. The Circle permissions Phase 2 state (age
-- band + content shield, js/230-privacy.js) rides the same row in its
-- own column with its own conflict clock (_at inside the payload),
-- synced by js/229-user-state.js.
--
-- Payload shape: privacy_state { _at, value } — value is the privacy
-- object { band: 'teen'|'adult'|null, shield: bool,
-- teenDefaultsApplied: bool, bandSetAt: ms } (warning-style single
-- value, see v520).
--
-- The band lives ONLY here: never on profiles (circle friends read a
-- projection of those rows — an age band must not be inferable from
-- anything a friend can fetch), never displayed anywhere in the app.
-- user_state is own-rows-only (the v518 "own state" FOR ALL policy
-- covers every column on the row), so no other user can read it.
--
-- The {} default below is the "never synced" marker the client seeds
-- against; existing rows pick it up automatically. No policy changes.

alter table public.user_state
  add column if not exists privacy_state jsonb not null default '{}'::jsonb;
