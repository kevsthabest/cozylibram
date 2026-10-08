-- v390: Add vitality column (alive/dead/unknown/missing)
-- status is already taken by v317 dedup workflow (candidate/confirmed/rejected/merged)
ALTER TABLE book_characters
ADD COLUMN IF NOT EXISTS vitality TEXT
CHECK (vitality IS NULL OR vitality IN ('alive', 'dead', 'unknown', 'missing'));
