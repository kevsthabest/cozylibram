-- v345: pipeline-supplied character fields for richer wiki
-- aliases: nicknames/titles from Call A (e.g. "Violence" for Violet)
-- first_appearance_chapter: min chapter the character appears in
-- appearance: physical description from Call A prompt
-- status: alive/dead/unknown/missing at end of book
ALTER TABLE book_characters
  ADD COLUMN IF NOT EXISTS aliases text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS first_appearance_chapter int,
  ADD COLUMN IF NOT EXISTS appearance text,
  ADD COLUMN IF NOT EXISTS status text
    CHECK (status IS NULL OR status IN ('alive', 'dead', 'unknown', 'missing'));

-- NOTE (v390): The `status` column above collided with v317's dedup workflow
-- (candidate/confirmed/rejected/merged). The ADD COLUMN IF NOT EXISTS silently
-- skipped it. Use `vitality` for alive/dead/unknown/missing instead.
-- See: supabase/migrations/v390_character_vitality.sql
