-- v381: User relationship suggestions with admin approval
-- Users can INSERT pending suggestions; only admins can confirm/reject.
-- Applied live 2026-10-08; this file is the audit record.

-- Drop the admin-only policy from v377/v378
DROP POLICY IF EXISTS "relationships: admin write" ON character_relationships;

-- Users can suggest (pending only, own ID only)
DROP POLICY IF EXISTS "relationships: user suggest" ON character_relationships;
CREATE POLICY "relationships: user suggest" ON character_relationships
  FOR INSERT TO authenticated
  WITH CHECK (
    review_status = 'pending'
    AND created_by = auth.uid()
  );

-- Admins can do everything
DROP POLICY IF EXISTS "relationships: admin all" ON character_relationships;
CREATE POLICY "relationships: admin all" ON character_relationships
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Users can retract their own pending suggestions
DROP POLICY IF EXISTS "relationships: user retract own pending" ON character_relationships;
CREATE POLICY "relationships: user retract own pending" ON character_relationships
  FOR DELETE TO authenticated
  USING (
    created_by = auth.uid()
    AND review_status = 'pending'
  );
