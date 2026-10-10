-- v402: Chapter-level metadata from ebook processor
-- Adds columns for progressive disclosure of chapter-level data.
-- All nullable; UI hides sections when data is absent.
-- Applied: 2026-10-10

ALTER TABLE works
  ADD COLUMN IF NOT EXISTS trigger_chapters JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS chapter_spice JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS avg_dialogue_ratio NUMERIC DEFAULT NULL;

-- trigger_chapters: {"murder": [1, 3, 7], "violence": [2, 5]} — chapter numbers per trigger
-- chapter_spice: [0, 1, 3, 2, ...] — per-chapter spice level (0-5)
-- avg_dialogue_ratio: 0.68 — fraction of book that is dialogue (0.0-1.0)

COMMENT ON COLUMN works.trigger_chapters IS 'Ebook processor: which chapters contain each trigger. Powers "Ch. 1, 3, 7" warnings.';
COMMENT ON COLUMN works.chapter_spice IS 'Ebook processor: per-chapter spice levels (0-5). Powers Spice Forecast sparkline.';
COMMENT ON COLUMN works.avg_dialogue_ratio IS 'Ebook processor: fraction of book that is dialogue (0.0-1.0). Powers writing-style stat.';
