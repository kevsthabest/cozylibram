# ADR-001 — The Wishlist is a derived pair, not a status
Date: 2026-10-14 · Status: active

## Context

The Wishlist has been represented three ways. Before v529 it was the
`owned === 'tobuy'` facet at any status. At v529 (2026-10-13) it became a
shelf of its own — a `status === 'wishlist'` value. Two signals carrying
one concept meant every consumer (shelves, storefront links, Circle
visibility) had to know which representation a given row used, and a
book's wishlist-ness could be stated by its facet and its status at the
same time.

## Decision

From v559 the Wishlist is derived, never stored: a book is a wishlist
book exactly when `status === 'tbr' && owned === 'tobuy'`, computed by
`isWishlistBook` (`js/000`). No `wishlist` status value exists.

The move runs through one-time transforms in `js/020-ratings.js`
(`wishlistShelfTransform` at v529, `wishlistUnifyTransform` at v559),
each running once per library partition and never again. The read path
(`migrateBook`, same file) degrades a stray stored `wishlist` status to
`tbr` and never invents ownership — the transforms are the only place a
stored facet is set. The door is one-way: no current code writes the
`wishlist` status, so a row still carrying it can only be a stale write
from a pre-v559 client.

Server parity followed the client: migration v578 (PR #250, merged
2026-10-15) taught `circle_book_visible` the derived pair, so a hidden
wishlist hides exactly the `tbr` + `tobuy` set and nothing else.

## What we gave up

A shelf you can see in the data. Wishlist-ness is now computed, so raw
rows never say "wishlist"; every query, consumer, and policy must
reproduce the pair — the v578 migration is that cost, paid once. The
v529 status model also lasted a day, and re-deciding it cost a second
one-time transform plus the stale-write degradation rule above.

## Evidence

- `js/020-ratings.js` — the v529/v559 transform headers and the
  `migrateBook` degradation comment; `js/000` — `isWishlistBook`.
- Commits `5e386f4` (v529 shelf, 2026-10-13) and `b789e86` (v559
  unification, "re-decides the v529 status model", 2026-10-14).
- `supabase/migrations/v578_wishlist_server_parity.sql`; PR #250
  (merged 2026-10-15).
