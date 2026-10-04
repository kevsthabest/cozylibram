-- v272: work identity hub — provider IDs on works.
--
-- The work is the identity hub (claims, tropes, and soon spines hang off
-- it). provider_ids folds exact provider identities into the work row so
-- enrichment can do direct fetches instead of fuzzy re-resolution:
--
--   hardcover_id   — Hardcover book id (numeric, stored as text)
--   openlibrary_id — Open Library work key, e.g. "/works/OL123W"
--   inventaire_id  — Inventaire entity URI, e.g. "wd:Q123"
--   google_books_id — Google Books volume id
--
-- Edition-level provider IDs live on editions.provider_ids (already exists).
-- Edition attributes (spine photos, sprayed edges) hang off editions/isbn.
-- Keys are merged, never clobbered: a new capture only fills keys that are
-- absent or different. Additive migration — no existing data touched.
ALTER TABLE works ADD COLUMN IF NOT EXISTS provider_ids JSONB NOT NULL DEFAULT '{}';

-- Exact provider lookups: works?provider_ids->>'hardcover_id' = '123'
CREATE INDEX IF NOT EXISTS works_provider_ids_gin ON works USING GIN (provider_ids);
