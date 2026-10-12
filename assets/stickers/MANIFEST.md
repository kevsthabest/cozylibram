# Sticker sets — manifest & production notes

## System
- One set per theme: **2 sheets (A/B) × 12 stickers** = 24 illustrated stickers
  per theme, so cards can rotate art and stay fresh.
- Core motifs (in every set, re-paletted): dragon, cat on books, crescent
  moon, candle, open book with sparkles, potion bottle, teacup, book stack,
  crystal ball, quill & inkwell + 2 theme-special motifs per set.
- Style lock: detailed watercolor, thick white die-cut border, subtle drop
  shadow, plain solid pale-grey background (for the cutting pipeline),
  NO text/words/letters (text stickers are vector, generated from data).
- Freshness: card composition picks stickers by seeded rotation
  (reader id + month), so repeat shares don't repeat the same art.

## Layout
- Sheets (raw generations): `assets/stickers/sheets/<theme>-<a|b>.webp`
- Cut stickers (production): `assets/stickers/cut/<theme>/<motif>-<1|2>.png`
  with alpha, produced by `scripts/cut-stickers.py` (flood-fill background
  removal + connected components + trim).

## Theme palettes
| theme | palette direction | specials |
|---|---|---|
| velvet | deep purple, violet, pink, gold | witch hat, arched window — SHEET A DONE (proof) |
| hearthside | ember, rust, cream, walnut brown | fireplace, knitted blanket & mug |
| midnight | indigo, silver, lavender | telescope, owl on book |
| candlelight | golden sepia, cream, warm ink | wax-seal letters, reading glasses |
| stormrider | slate navy, black, dark teal, burnished gold — DRAGON-RIDER ACADEMY (Fourth Wing-inspired, NOT weather): black + gold dragons, daggers, flight leathers, parapet, scale-cover book, signet lightning; cat is an ORANGE TABBY in rider gear | dragon pair, dragon-scale book |
| dark | plum-charcoal, violet night | raven, gothic arch |
| light | soft daylight pastels, ink | sunflower & books, iced coffee |
| twilight | deep blue dusk, periwinkle | fireflies jar, evening primrose |
| verdant | forest green, moss, botanical | fern & books, frog on book |
| abyss | deep teal, sea-glass, bioluminescent | jellyfish lantern, shell & book |
| frost | icy blue-white, silver | snow globe book, hot cocoa |
| briarthrone | violet-black, lilac, silver, dark rose — ACOTAR-inspired NIGHT COURT: starfall, mountain city, paint palette, bow, winged cat, night roses + thorns | star-crowned cat, painted book spines |
| voidsignal | near-black, navy, signal blue, teal — DAEMON / FREEDOM™-inspired DARKNET: network-node webs, AR glasses, circuit traces, data cores, chess knight, cornfields under digital skies, drones, servers (NOT outer space) | network dragon, sysadmin cat dome |
| wisp | pale ethereal cream, opal | will-o-wisp lights, white moth |
| wisp-night | dark ethereal violet, opal glow | will-o-wisp trail, moth & moon |
| haunt | halloween black/orange/purple | jack-o-lantern book, ghost reader |
| yuletide | pine green, cranberry, gold | ornament & book, gingerbread bookmark |
| fete | navy, gold, champagne | fireworks & book, masquerade mask |
| amour | blush pink, rose red, cream | love-letter & rose, heart bookmark |
| shamrock | emerald, cream, gold | clover & book, rainbow stack |
| pastel | spring pastels, lilac, mint | tulips & book, egg bookmark |
| harvest | amber, pumpkin, wheat | pumpkin stack books, pie & book |
| solstice | golden summer, sky blue | sunflower stack, lemonade & book |

## Status (2026-10-12)
- velvet A ✓ (proof) · hearthside A ✓ · midnight A ✓ · candlelight A ✓ —
  all visually verified, palettes on-theme, no text artifacts
- stormrider: FULLY REDONE 2026-10-12 (user's call) — the weather-literal
  take (rain clouds, umbrellas, teacup storms) was wrong; the theme is
  Fourth Wing-inspired dragon-rider academy. A + B regenerated: black &
  gold dragons, daggers, flight leathers, parapet, scale-cover book,
  signet lightning. ORANGE TABBY (Broccoli) in both sheets: A = rider
  harness + goggles; B = adventurer's backpack with rolled map + tiny
  book (user's split, 2026-10-12). Weather + cape versions archived in
  sheets/rejected/.
- dark A ✓ · light A ✓ · verdant A ✓ — verified clean
- twilight A ⚠️ — dragon + firefly-book rendered as rectangular washes,
  not die-cut contours; REGEN queued (strengthen "isolated subject,
  contour border" wording)
- abyss A ✓ · frost A ✓ · briarthrone A ✓ · voidsignal A ✓ — verified clean
- twilight A ✓ REGENERATED clean (old sheet kept as twilight B; its dragon
  + firefly-book stickers are rectangular washes — exclude at cutting)
- wisp A ✓ · wisp-night A ✓ · velvet B ✓ (variation poses) — verified clean
- ALL 15 standard/premium themes now have an A sheet (180 stickers)
- B sheets done: velvet ✓, stormrider ✓, hearthside ✓, midnight ✓,
  candlelight ✓, dark ✓, light ✓, verdant ✓, abyss ✓, frost ✓
  (variation poses; verdant/abyss spot-verified excellent)
- B sheets COMPLETE for all 15 themes (briarthrone, voidsignal, wisp,
  wisp-night verified in batch 7) — 30 sheets / 360 stickers total.
  Exception: twilight B is the flawed original sheet (10/12 usable).
- briarthrone A+B ✓ REDONE as ACOTAR Night Court (user's call
  2026-10-12); generic dark-fae versions in rejected/. Minor: B has one
  rectangular-wash sticker (paintbrush starfall).
- voidsignal A+B ✓ REDONE as Daemon/Freedom™ Darknet (user's call
  2026-10-12); cosmic versions in rejected/. Minor: A cornfield sticker
  is a scenic rectangle.
- seasonal: haunt ✓ · yuletide ✓ · fete ✓ · amour ✓ · shamrock ✓ ·
  pastel ✓ · harvest ✓ · solstice ✓ (one sheet each — ALL 38 SHEETS DONE)
- CUTTING COMPLETE (2026-10-12): 446 individual transparent PNGs in
  assets/stickers/cut/<theme>/ via scripts/cut-stickers.py + a
  fill-ratio fragment purge. Benign quirks: dark-a one fused pair;
  hearthside-b two fused pairs (read as composed stickers); five sheets
  yield 13 (a two-island design split in two). Twilight-b excluded by
  design. Bundle set: assets/stickers/cut-webp/ — WebP q90 via
  scripts/optimize-stickers.py, 13.1 MB vs 84.5 MB PNG (visually
  verified lossless-looking); PNG originals stay archived in cut/.
- Spec (docs/reader-portrait-share-v2-spec.md) updated with this asset
  workflow; Builder handoff awaits the user's build go-ahead.
