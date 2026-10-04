-- v283: pool self-healing — a bad contribution can never get permanently stuck.
--
-- Rule: only the original contributor can change their pool image.
--   * Rescanning or enhancing a face you contributed auto-replaces the pool copy.
--   * Removing a contributed face can withdraw it from the pool.
-- First-writer-wins still holds between different users (and for unattributed rows).

-- The uploading user may overwrite their own objects at the same path.
drop policy if exists "edition-images owner update" on storage.objects;
create policy "edition-images owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'edition-images' and owner = auth.uid())
  with check (bucket_id = 'edition-images' and owner = auth.uid());

-- Contributors may touch their own pool rows (updated_at on replace).
drop policy if exists "edition_images contributor update" on public.edition_images;
create policy "edition_images contributor update" on public.edition_images
  for update to authenticated
  using (uploaded_by = auth.uid())
  with check (uploaded_by = auth.uid());

-- Contributors may withdraw their own pool rows.
drop policy if exists "edition_images contributor delete" on public.edition_images;
create policy "edition_images contributor delete" on public.edition_images
  for delete to authenticated
  using (uploaded_by = auth.uid());
