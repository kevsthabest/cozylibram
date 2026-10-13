-- v521: user_state shelf section — shelf state roams.
-- v518 created user_state with a single `settings` jsonb column; v520
-- added warning prefs, Up Next, and release state as sibling columns.
-- Shelf state now rides the same row in its own column with its own
-- conflict clock (_at inside the payload), synced by
-- js/229-user-state.js: the 2D shelf order doc (per-group manual
-- order, layout, format, season, 2D decorations), the 3D decorations
-- per bookcase, the dressed-theme state, the 3D arrange and spines
-- modes, and the shelf view mode.
--
-- Payload shape: shelf_state { _at, values } — values maps fixed piece
-- names (order, deco, dressed, arrange, spines, viewmode) to the raw
-- strings those pieces live in on-device. The {} default below is the
-- "never synced" marker the client seeds against; existing rows pick
-- it up automatically. No policy changes: the v518 "own state" FOR ALL
-- policy covers every column on the row.

alter table public.user_state
  add column if not exists shelf_state jsonb not null default '{}'::jsonb;
