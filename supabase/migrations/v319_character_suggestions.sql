-- v319: pipeline-suggested character links + source tracking.
-- Additive only.
--
-- suggested_character_id: pipeline's normalized-name match proposal.
-- Separate from character_id (the human-confirmed FK) so suggestions
-- never auto-link. Reviewer accepts (copies to character_id) or rejects
-- (clears the suggestion).
alter table public.book_characters
  add column if not exists suggested_character_id uuid
  references public.characters (id) on delete set null;
create index if not exists idx_book_characters_suggested
  on public.book_characters (suggested_character_id);

-- source: how the canonical character was created.
-- 'manual' (reviewer created), 'pipeline-suggest' (from a suggestion),
-- 'merged' (from duplicate merge).
alter table public.characters
  add column if not exists source text not null default 'manual'
  check (source in ('manual', 'pipeline-suggest', 'merged'));
