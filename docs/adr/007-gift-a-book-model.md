# ADR-007 — Gift a Book: recipient-granted, claim-gated, addresses in an encrypted vault
Date: 2026-10-15 · Status: active

## Context

The Friend's Wishlist shelf let circle members *see* what a friend wants;
buying it for them stayed a research project, and two givers could buy the
same gift. Gifting needs the recipient's delivery details — a postal address
is the most sensitive data the app has ever held — so the feature's shape is
set by consent and disclosure limits, not checkout convenience. The app never
becomes a store: the retailer is always the seller; there is no in-app
payment, order data, or fulfillment anywhere in the design.

## Decision

- **Circle-only, per-friend opt-in grant.** Gifting exists only inside the
  Circle, and only where the recipient has granted that specific friend
  permission ("Allow <friend> to gift me", default OFF for every friendship).
  Without the grant the friend sees the plain wishlist — the feature is
  indistinguishable from absent — and the grant is evaluated server-side
  inside every claim, state, and reveal RPC.
- **Secret claims coordinate givers.** One tap creates a claim; at most one
  active claim per (recipient, book); claimer caps of 2 active claims per
  (claimer, recipient) and 10 per claimer globally. Other granted friends see
  only an anonymous "Claimed" state, served with a payload pinned to
  book + state. The recipient has no read path at all by default; an opt-in
  setting ("See claims on my wishlist", default OFF) opens a dedicated
  recipient RPC. Claims expire after 45 days unpurchased.
- **Field-scoped reveal.** Delivery details come only from one claim-gated
  SECURITY DEFINER RPC, only while an active claim grounds it: a print claim
  reveals the postal fields + phone; an ebook/audio claim reveals only the
  gift email — never the postal address. The first reveal between a pair
  requires the grounding claim to be ≥ 24 hours old. Reveals are budgeted
  (3 per claim; 10 per pair per rolling 30 days, not reset by claim-cycling).
  Every refusal returns the identical empty result and one generic line.
- **The address vault.** Addresses live in a dedicated table off `profiles`,
  owner-only RLS with no friend read policy, sharing toggle default OFF,
  hard delete with no history kept. Every reveal is logged; the owner sees
  the fact (count + timestamp) after 72 hours and the detail at claim
  resolution or 14 days, whichever first; admins read the log immediately.
  Address storage is disabled for teen accounts; for a teen friend, the
  recipient's per-friend grant *is* the consent act.
- **Encryption at build — pgcrypto, not pgsodium.** The vault's address,
  email, and phone columns are column-encrypted from the moment the table is
  created, keys in Supabase Vault, decryption only inside the reveal RPC.
  Advisor amendment A8 originally named pgsodium; its by-key functions
  require a role membership grantable only by `supabase_admin`, unreachable
  through every channel available to this project. The requirement is met
  instead by pgcrypto symmetric PGP encryption (AES-256, owner-bound), swapped
  in while the vault table was still empty (v584).

## What we gave up

- One-tap purity for new pairs: the 24-hour first-reveal wait is deliberate
  friction placed exactly where address harvesting would live.
- pgsodium's by-key-id AEAD design — set aside not on merit but because the
  platform cannot grant the role it requires here.
- A recipient who can watch their own wishlist's claims: surprise is the
  default, and claim state stays invisible unless the recipient opts in.

## Evidence

- `docs/gift-purchase-spec.md` — the full spec; its status line records the
  Advisor design review (AMEND A1–A10) folded in and the User's rulings of
  2026-10-15: claim expiry 45 days, A3 kept (24h first-reveal-per-pair),
  A5 at 72 hours, A8 do-it-now, and gifting opt-in per friend (§6–§7).
- `supabase/migrations/v584_gift_crypto_swap.sql` — the primitive
  substitution record, User-approved 2026-10-15, executed while the vault
  was empty; `gift_enc`/`gift_dec` kept names, signatures, and semantics.
