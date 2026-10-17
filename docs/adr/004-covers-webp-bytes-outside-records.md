# ADR-004 — Covers are WebP; image bytes never live in book records
Date: 2026-10-12 · Status: active

## Context

Covers arrived as provider JPEGs of arbitrary size, and `data:` uploads
put image bytes inside book records — so bytes rode IndexedDB storage
and every sync payload, duplicated per user and per device. v216
(2026-09-30) built a canonical shared cover cache; the question PR B
settled was the stored format and where the bytes are allowed to exist.

## Decision

Covers are stored as WebP in the covers bucket, content-addressed by
the SHA-256 of the WebP bytes. Adoption is on-device:
`adoptCoverWebP` (`js/136-coverpicker.js`) loads the pixels, transcodes
to WebP (600px cap, quality 0.85, blob type verified — a non-WebP
encode is a failure, never a mislabelled object), hashes, and uploads
with the user's session; a 409 is a dedup hit.

Book records carry only the cover URL string. Image bytes never live in
book records, in IndexedDB, or in sync payloads. Serving covers is a
cache concern only: the service worker's image cache matches the bucket
path, not the extension, so the format change needed no service-worker
change. `data:` uploads convert too (Decision, 2026-10-12) — that is
what removes bytes from records and payloads.

Adoption never breaks a cover: any failure — proxy down, dead provider,
upload denied, signed out, offline — returns the original source, never
throws, never empties. A kill switch (`localStorage`
`cozylibram.coverWebp=off`) disables adoption.

## What we gave up

Original resolution and provider formats: 600px WebP is the ceiling for
adopted covers. The single canonicalizer went away too — adoption runs
at four call sites (picker, bulk fill, edition switch, metadata
correction). And by design, until the covers-bucket INSERT policy
migration was applied, uploads were denied and the fallback carried the
app; that degraded state was expected, not a bug.

## Evidence

- Commit `96f8eb1` — "Cover storage PR B: WebP adopter replaces the
  v216 canonicalizer" (v507, 2026-10-12), including the Decision note
  above; predecessor `1dff355` (v216 canonical cover cache,
  2026-09-30).
- `js/136-coverpicker.js` — `adoptCoverWebP`: transcode, type check,
  SHA-256 naming, bucket upload.
- `.test/cover-adoption-closure.test.js` — the adoption-closure pin
  (named in CONSTRAINTS.md's measurement rule).
