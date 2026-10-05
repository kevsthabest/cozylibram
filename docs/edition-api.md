# Cozy Libram Edition Repository API

## GET /api/editions/{isbn}

Returns public canonical metadata for one physical ISBN edition.

The response contains edition metadata, canonical physical thickness when a calibrated measurement exists, and canonical face assets grouped by appearance:face. Each face includes its immutable asset ID, dimensions, SHA-256, quality score, verification state, and public Storage URL.

Only the current canonical, non-rejected asset is exposed. Candidate submissions and rejected assets are not part of the public response.

Example request: `GET /api/editions/9780143127748`

Thickness is measured with a known physical reference, currently an ID-1 card width of 85.60 mm, rather than inferred directly from page count. Page count is validation/context only.

Asset storage is content-addressed by SHA-256. Replacing a canonical image does not destroy the prior candidate record.
