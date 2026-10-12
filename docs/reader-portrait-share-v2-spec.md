# Reader Portrait share card v2 — build spec

Status: DRAFT — awaiting approval to build. Copy banks are drafts for veto.
Supersedes: v1 card (v487 Midnight/Hearthside) in js/212-dna.js.
Prototypes: ~/workspace/prototypes/reader-portrait-v2-2026-10-12.html (A/B),
reader-portrait-v2-merged-2026-10-12.html (merged takes),
reader-portrait-v2-stickerpack-2026-10-12.html (C).

## What ships

Three share-card styles generated from one portrait object, presented in a
swipeable share sheet. Reader picks a style and shares it.

- **A — Editorial.** Quiet serif portrait, light or dark per theme.
- **B — Cover Story.** The portrait as a novel cover; tropes as praise blurbs;
  favourite covers as an "Also on these shelves" strip.
- **C — Sticker Pack.** The portrait as the back of a sticker-bombed e-reader.
  Archetype sticker as focal point; decorative fillers to composition
  balance (see composition rules, no fixed count).

All cards: 1080×1920 canvas, palette from the active theme's semantic tokens
(--bg, --ink, --muted, --accent, --gold). Reuse the v399 cardCanvas() helper.

## Share sheet UI

- Opens from the existing Share action on the Reader Portrait.
- Bottom sheet, three cards in a horizontal scroll-snap carousel, dot
  indicator, style name under the active card.
- Share button acts on the centered card: Web Share API (files) where
  supported, PNG download fallback.
- Cards render on sheet open (client-side, no network).

## Branding

- **No emoji taglines.** The "Tracked with Cozy Libram 🌶️🖤" style footer is
  retired on all three styles.
- Footer branding = the app icon (`icon.svg`) drawn small beside the
  "Cozy Libram" wordmark. Recognizable, quiet, no emoji.
- Future: the icon mark becomes an onboarding link once a custom domain
  exists. **Out of scope for v2** — do not print the Cloudflare Pages URL
  (or any URL/QR) on cards yet; leave the branding slot sized so a link
  element can join it later.

## Portrait data rules (the honesty layer)

1. **Archetype (hybrid).** Headline from the reader's dominant genre cluster
   (title bank below). Supported by trope content — never by counted badges.
2. **Tropes as quotes.** Top tropes render as praise-quote lines (bank below).
   Counts appear only inside attributions, softened ("48 books' worth of
   evidence"). No "Trope × N" badges anywhere.
3. **Rank + floor.** A trope qualifies only if it appears in 2+ read books.
   Show fewer quotes rather than padding.
   **Counts are distinct read books** containing the trope — never raw
   claim occurrences, imported metadata records, or duplicate editions of
   the same work. Attribution wording: "and counting" only when the trope
   appears in a book finished within the last 90 days (history actively
   growing); otherwise static forms ("books deep", "books' worth of
   evidence").
4. **Appetite ladder.** The appetite line comes from the first axis with
   evidence: (1) spice — needs 10+ spice-rated read books; (2) top trope;
   (3) genre tagline. If none fire, no appetite line. Never guessed.
5. **Soft mode.** If fewer than 3 tropes qualify, no archetype is claimed:
   headline becomes a soft-mode line ("A story still being written") with
   whatever genres/tropes exist, gently presented.
6. **Celebration stats.** Pages read is the hero number. Completed books are
   celebrated as finishing ("stories seen through to their ending").
   Longest streak appears only reframed as a memory ("that one 23-day
   reading cocoon"). Top author as a personal fact. No score framing,
   no current-streak pressure.
7. **Covers.** Recently read first: covers from the most recently finished
   books (newest first). Favourites (5★ or favourited) are the fallback —
   they fill any remaining slots when recent reads run short. B uses up to
   4; C uses 1 polaroid (most recent read, else top favourite).
8. **Spice section** hides entirely when no spice evidence exists.

## Sticker Pack composition (C)

- **One focal point:** the archetype sticker is the largest and most
  distinctive element. Everything else supports it.
- **3–5 data-backed elements:** archetype (focal), appetite pill, top-trope
  quote bubble, pages starburst, finished-count strip, top-author fan-club
  sticker, up to 2 milestone stickers, 1 recent-read cover polaroid,
  genre sticker — choose the strongest 3–5 beyond the focal sticker.
- **Flexible decorative layer:** phrase-bank stickers are added until the
  composition feels complete — visual balance, not a fixed count.
- **Protected text zones:** rotation and overlap must never reduce
  legibility, cover data, or collide with the device frame.
- **Theme-aware materials:** the theme palette influences the device shell,
  sticker borders, paper textures, and accents — contrast always preserved.
- Fillers must never contradict data (no spice sticker when spice is
  unknown, etc.). "BOOKS > PEOPLE" is an optional-tier filler, not a
  default.

## Sticker artwork — illustrated asset library (decided 2026-10-12)

Decorative stickers are NOT drawn in code. Flat SVG/CSS icons read as
clinical next to real die-cut stickers; the approved workflow is
AI-illustrated watercolor sticker sheets, generated per theme and cut
into individual transparent PNGs.

- **Sets:** every theme has an A sheet + B (variation) sheet of 12
  stickers — 24 per theme; seasonal themes have one sheet each.
  38 sheets / 456 stickers total. Full inventory: `assets/stickers/MANIFEST.md`.
- **Style lock:** detailed watercolor, thick white die-cut border
  following the subject contour, plain uniform background, NO text in
  the art (text stickers are rendered from data, never baked in).
- **Motif system:** 10 shared motifs re-paletted per theme (dragon, cat
  on books, crescent moon, candle, open book, potion, teacup, book
  stack, crystal ball, quill & inkwell) + theme-special motifs.
  Stormrider's cat is an orange tabby in both sheets (user's call).
- **Pipeline:** `scripts/cut-stickers.py` flood-fills the sheet
  background, splits connected components, and writes
  `assets/stickers/cut/<theme>/<sheet>-<NN>.png` with feathered alpha.
  Verified on Velvet (12/12 clean cuts).
- **Freshness:** composers pick from the theme's 24 stickers by seeded
  rotation (reader id + month), so repeat shares rotate artwork.
- **In-app materials:** theme-aware rule above still applies to the
  device shell, text-sticker borders, and paper textures — the
  illustrated stickers themselves are fixed artwork per theme.

## Copy banks — DRAFT for veto

**Variant pools beat single picks.** Where copy has tasteful variants,
keep the pool and select by the same seeded rotation used for stickers
and quotes (reader id + month): a reader's card stays stable for a
share, but the wording freshens over time. Do not collapse a pool to one
winner unless the user vetoes the others.

### Archetype titles (by dominant genre cluster)
- Romantasy → Romantasy Royalty
- Dark Romance → rotating pool: Dark Romance Darling · Dark Romance
  Devotee · Dark Romance Romantic · Dark Romance Shadow Romantic ·
  Dark Romance Midnight Romantic
- Romance (contemporary) → Hopeless Romantic
- Fantasy → Fantasy Worldwalker
- Sci-Fi → Star Voyager
- LitRPG → Dungeon Delver
- Horror → Horror Devotee
- Mystery / Thriller → Plot Twist Hunter
- Historical Fiction → Time Traveller
- Cozy Mystery → Cozy Detective
- Paranormal → Paranormal Devotee
- Literary Fiction → Literary Wanderer
- Memoir / Biography → Life Story Collector
- No dominant cluster → Genre Hopper (said with love)

### Appetite taglines (spice axis, by average)
- 4.0+ → "a dragonfire palate — no regrets"
- 3.0–3.9 → "brings the heat, keeps the heart"; "a slow burn with teeth"
  ONLY when Slow Burn is itself a qualifying trope (spice level and
  slow-burn preference are not interchangeable)
- 2.0–2.9 → "soft spot for the sweeter side" (low spice ≠ less adventurous)
- 0.1–1.9 → "a sweet tooth, proudly"
- (genre-axis fallback examples) Romantasy → "here for the courts and the chaos";
  Sci-Fi → "here for the stars and the strange"; LitRPG → "here for the grind
  and the loot"; Mystery → "here for the twist, every time"

### Trope quotes (top tropes → quote; attribution appended from data)
- Enemies to Lovers → "Devastating taste in enemies-to-lovers."
- Forced Proximity → "One bed? Say less."
- Morally Grey → "Here for the morally grey, every time."
- Grumpy × Sunshine → "Grumpy meets sunshine? Already seated."
- Found Family → "Found family finds them, every time."
- Slow Burn → "Patience of a saint, payoff of a sinner." (slow burn)
- Fated Mates → "Fate keeps setting them up."
- Touch Her and Die → "Protective to a fault — theirs."
- Who Hurt You → "Who hurt you? Wrong answers only." (tender books)
- Second Chance → "Believes in the second chance."
- Friends to Lovers → "It was never just friendship."
- Forbidden Love → "Rules were made to be broken."
- Secret Identity → "Loves a double life."
- Possessive → "Mine, said the book boyfriend."
- Billionaire → "Old money, new problems."
Attribution patterns: "— {n} books' worth of evidence" / "— {n} books deep" /
"— {n} books and counting" (last one ONLY per the actively-growing rule in
Portrait rule 3). {n} is always distinct read books. Rotate patterns
deterministically per reader.

### Sticker phrase bank (C fillers; identity, never data claims)
BOOKTOK MADE ME DO IT · JUST ONE MORE CHAPTER ·
PLOT TWIST MENACE (neutral set ships; no gendered variants) ·
EMOTIONAL SUPPORT BOOK · PROFESSIONAL TBR BUILDER · IN MY READING ERA ·
WARNING: EASILY DISTRACTED BY BOOKS · HEAD LIBRARIAN (cat) ·
MY OTHER RIDE IS A DRAGON (fantasy clusters only) ·
DO NOT DISTURB: AT THE CLIMAX
Optional tier (not default fillers): BOOKS > PEOPLE

## Implementation notes

- New file js/228-portrait-share.js (three-touchpoint rule: file +
  index.html + sw.js precache). Portrait computation can stay in
  js/212-dna.js; renderers + sheet UI in the new file.
- drawDnaImage() is replaced; keep the old function reachable behind a flag
  until v2 verifies live.
- Deterministic per-reader variation: hash of user id seeds quote/sticker
  selection so a reader's card is stable between shares.
- Tests: portrait rules (floor, ladder, soft mode) unit-tested; renderers
  smoke-tested (canvas non-blank per style per theme class).

## Out of scope
- Public-profile pages, share links/URLs (PNG share only).
- Animated/video cards.
- Per-style user preference memory (sheet opens on Editorial... or last-used;
  decide during build).
