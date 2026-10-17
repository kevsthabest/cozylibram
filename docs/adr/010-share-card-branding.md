# ADR-010 — Share cards carry the app mark and wordmark only — no URL, no QR
Date: 2026-10-15 · Status: active

## Context

Share cards are the app's only artifact that leaves the app — images posted
elsewhere — so they are its de-facto public branding. Cards had accumulated
divergent footers: emoji taglines, letter-spaced variants, bespoke per-card
branding inherited from a stale shared helper. And every card invites the
same suggestion — print a URL or QR code so viewers can find the app — but
the app has no custom domain; a raw hosting URL on a keepsake card is clutter
today and a stale pointer tomorrow.

## Decision

Every share card's footer is one standard: the app icon + the "Cozy Libram"
wordmark, drawn by a single shared helper (`cardFooter` in js/050; js/228's
`psFooter` delegates to it — no second implementation of the standard
remains). No emoji taglines. No URL and no QR code on any card until a
custom domain exists. Emoji and artwork that are card *content* (a book's
spice peppers, Wrapped's section icons) are untouched by this rule — it
governs the branding footer only. The icon loads lazily on first footer
use; a slow or failed icon load degrades to wordmark-only, never to a
missing footer.

## What we gave up

- Discoverability from shares: a card in the wild carries no path back to
  the app until a custom domain makes that path worth printing.
- Per-card branding personality: several cards had charming bespoke
  footers; uniformity won, deliberately.

## Evidence

- `js/228-portrait-share.js`, header line 6 — the standard as first
  implemented: "Branding: app icon + wordmark only. No emoji taglines,
  no URL/QR." (Reader Portrait share v2, shipped v500, PR #159,
  merged 2026-10-12.)
- PR #247 (merged 2026-10-15, v573) — the standard made uniform: every
  canvas card's footer routed to the shared `cardFooter`; the PR's footer
  inventory lists each renderer's before → after, including the Year text
  summary's closing line as the text twin of a share card.
- `docs/reader-portrait-share-v2-spec.md` — the wordmark treatment the
  standard came from: "Recognizable, quiet, no emoji."
