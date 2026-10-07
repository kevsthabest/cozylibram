-- v289: Add spice columns to works table for TBR roulette filtering.
-- spice_detected: 0-5 value from the ebook extraction pipeline (local LLM).
-- spice_manual: manual override, wins over detected when set.
-- Roulette filters on COALESCE(spice_manual, spice_detected).
-- Both nullable: unprocessed/ungraded books have NULLs.
-- Additive only, no backfill.

ALTER TABLE works ADD COLUMN IF NOT EXISTS spice_detected INT NULL;
ALTER TABLE works ADD COLUMN IF NOT EXISTS spice_manual INT NULL;

-- Constrain to 0-5 range when set
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'works_spice_range') THEN
    ALTER TABLE works ADD CONSTRAINT works_spice_range CHECK (
      (spice_detected IS NULL OR (spice_detected >= 0 AND spice_detected <= 5)) AND
      (spice_manual IS NULL OR (spice_manual >= 0 AND spice_manual <= 5))
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_works_spice ON works (COALESCE(spice_manual, spice_detected));

COMMENT ON COLUMN works.spice_detected IS 'Spice level 0-5 detected by the ebook extraction pipeline (local LLM).';
COMMENT ON COLUMN works.spice_manual IS 'Manual spice level override 0-5; wins over spice_detected when set.';
