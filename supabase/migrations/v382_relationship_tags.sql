-- v382: Add tags array to character_relationships
-- Allows multiple labels like 'mistress', 'ex', 'secret' alongside primary type.
-- Applied live 2026-10-08.

ALTER TABLE character_relationships ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
