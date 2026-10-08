-- v377: character_relationships edge table (Phase 2)
-- Moves relationships from JSON-embedded in book_characters to first-class edges.
-- Supports direction, importance, review status, and audit trail.

CREATE TABLE IF NOT EXISTS character_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The two characters in the relationship (book_characters IDs)
  character_a_id UUID NOT NULL REFERENCES book_characters(id) ON DELETE CASCADE,
  character_b_id UUID NOT NULL REFERENCES book_characters(id) ON DELETE CASCADE,
  -- Relationship type: spouse, parent, child, sibling, friend, enemy, etc.
  relationship_type TEXT NOT NULL,
  -- Direction: 'a_to_b', 'b_to_a', or 'mutual'
  direction TEXT NOT NULL DEFAULT 'mutual' CHECK (direction IN ('a_to_b', 'b_to_a', 'mutual')),
  -- Importance 1-5 (NULL = not set)
  importance INT CHECK (importance IS NULL OR (importance >= 1 AND importance <= 5)),
  -- Which work this relationship was observed in
  source_work_id UUID REFERENCES works(id) ON DELETE SET NULL,
  -- Review status: 'pending', 'confirmed', 'rejected'
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'confirmed', 'rejected')),
  -- Who created/confirmed this (NULL = pipeline)
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Prevent duplicate edges (same pair, same type, same direction)
  UNIQUE (character_a_id, character_b_id, relationship_type, direction)
);

-- Index for looking up all relationships for a character
CREATE INDEX IF NOT EXISTS idx_char_rel_a ON character_relationships(character_a_id);
CREATE INDEX IF NOT EXISTS idx_char_rel_b ON character_relationships(character_b_id);
CREATE INDEX IF NOT EXISTS idx_char_rel_work ON character_relationships(source_work_id);
CREATE INDEX IF NOT EXISTS idx_char_rel_status ON character_relationships(review_status);

-- RLS: same as book_characters (authenticated users can read, admins can write)
-- For now, mirror the book_characters policies
ALTER TABLE character_relationships ENABLE ROW LEVEL SECURITY;

-- Allow authenticated reads
CREATE POLICY "Allow authenticated read" ON character_relationships
  FOR SELECT TO authenticated USING (true);

-- Allow authenticated inserts (app will handle authorization)
CREATE POLICY "Allow authenticated insert" ON character_relationships
  FOR INSERT TO authenticated WITH CHECK (true);

-- Allow authenticated updates
CREATE POLICY "Allow authenticated update" ON character_relationships
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Allow authenticated deletes
CREATE POLICY "Allow authenticated delete" ON character_relationships
  FOR DELETE TO authenticated USING (true);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_char_rel_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS char_rel_updated_at ON character_relationships;
CREATE TRIGGER char_rel_updated_at
  BEFORE UPDATE ON character_relationships
  FOR EACH ROW EXECUTE FUNCTION update_char_rel_updated_at();
