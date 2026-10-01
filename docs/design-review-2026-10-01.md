# Cozy Libram — Design Review (2026-10-01)

Art-director pass over `styles.css` (2,226 lines), the theme system, the icon set,
and the per-theme SVG art. No repo source was modified; all proposals below are
concrete CSS/snippets for Kevin to approve before implementation.

## Verdict

The system is in better shape than most hand-grown stylesheets: one variable
vocabulary, one radius scale, one line-art icon set, and genuinely bespoke
per-theme art for vines and dividers. The problems are concentrated in three
places: **(1)** small-text contrast was fixed for `dark` in v224 but is broken
on all three light themes; **(2)** a handful of components bypass the variable
system with hardcoded colors, so they clash on non-default themes; **(3)** the
moon art is a recolor, not subject-specific art — the one place the current
work violates Kevin's standing bar. Everything else is polish.

---

## A. Coherence findings (ranked)

### A1. [High] `--faint` fails contrast on all three light themes
`styles.css:22–168`. v224 (UX-16) raised dark's `--faint` to ≈4.6:1 but left the
others. Measured small-text ratios (faint on bg):

| theme | current | ratio | theme | current | ratio |
|---|---|---|---|---|---|
| light | `#a08fa9` | **2.76** | twilight | `#6e7492` | 4.09 |
| candlelight | `#ab9573` | **2.52** | midnight | `#7e7b9f` | 4.24 |
| frost | `#98a3b8` | **2.24** | velvet | `#8f6f7c` | 4.12 |
| hearthside | `#8d6f52` | 4.06 | dark/verdant/abyss | — | ≥4.8 ✓ |

The three light themes are unreadable for labels, notes, and taglines — the
exact class of text v224 set out to fix.

### A2. [High] Calendar heatmap is a hardcoded rose ramp
`styles.css:883–915`. `.cal-day.l1–l4` (`#3d2230 → #e5488f`) and
`.heat-cell.l1–l4` (`#5c2b41 → #e5488f`) ignore every theme variable. On
verdant (botanical green), abyss (deep teal), and twilight (celestial indigo)
a pink activity heatmap fights the theme instead of belonging to it. The
`.heat-cell.sel` outline is hardcoded `#fff`, invisible on light themes.

### A3. [Medium] Dead CSS variables (5 references, 0 definitions)
`--text` (`styles.css:869`, `.pq-label b`), `--bg3` (`:1560`,
`.st-avatar.letter`), `--chip` (`:1578`, `:1586`, `:1594` — observatory +
log viewer). Consequences: the settings avatar letter-tile renders with a
**transparent background**, and the observatory/log fallbacks (`#2a2a33`,
`rgba(255,255,255,0.05)`) are dark-only values that look wrong on
light/candlelight/frost.

### A4. [Medium] Favorite heart + reading blue + star gold bypass the accent system
- `.fav-btn.on .ticon`, `.card-fav .ticon`, `.d-fav2.on` hardcode `#ff5d7e`
  (`styles.css:1470, 1741, 2068–2069`) — the heart stays pink when the user
  picks the ocean/teal/sage accent.
- `.badge.status-reading` and `.bt-statusbar.status-reading` hardcode
  `#6aa8e5` (`:426, :1744`).
- `.pub-rating` uses `var(--gold)` but `.cr-stars` hardcodes `#f5a623`
  (`:1891`) — two golds for the same "rating" signal.

### A5. [Medium] `.up-pill` text color breaks on light themes
`styles.css:1575`: `color: var(--bg); background: var(--accent)`. On light
themes that's near-white 12px-bold text on `#e5488f` — measured **3.42:1**,
fails AA. (White `#fff` is 3.71:1 — also fails. The fix is darkening the
pill background, not the text; see B4.)

### A6. [Medium] Moon art is a recolor, not bespoke art
`Asset/themes/moon-*.svg`: diffed twilight vs verdant — **identical geometry**,
only stroke colors differ (plus sparkle-vs-dot fills). The vines
(`vine-twilight` = crescent + constellations; `vine-verdant` = fern fronds +
berries) and the dividers (moon-phases vs fern-sprig) are genuinely
subject-specific — the moons are the one asset family that violates the
standing "never mere palette swaps" bar.

### A7. [Low] Card radius split
`.book-card` uses `var(--radius)` (14px); `.book-tile` hardcodes `18px`
(`:798`). Grid and list views of the same library shouldn't round
differently. Unify on `var(--radius)`.

### A8. [Low] Toast emoji vs line-art icons
`js/070-hardcover.js:291` and `js/130-add.js:437` toast `"Already on your
shelves 📚"`. The icon set is line-art everywhere else (bottom nav, modal
chrome, empty states); the 📚 is the only emoji in user-facing UI. Drop it
or use `icon('covers')`.

### A9. [Low] Midnight reuses shared art
Every theme has bespoke `moon-<theme>.svg` / `divider-<theme>.svg` **except
midnight**, which falls back to the shared `Asset/moon-sparkle.svg` and
`Asset/divider-botanical.svg` (`styles.css:1733, 1744`). Inconsistent with
the per-theme art direction.

### A10. [Low] Heavy black shadows on light themes
`rgba(0,0,0,0.5–0.65)` drop shadows (`:281, :1072, :1097, :1219, :1238, :1247,
:1803, :1918`) are tuned for dark themes and land harsh on
light/candlelight/frost. A `--shadow` variable with softer light-theme
values would fix all of them at once.

### [Note] Default accent is identical on all 10 themes
Every `[data-theme]` block sets `--accent: #e5488f` — the rose brand color.
This is arguably correct (brand consistency), but it means twilight,
verdant, and abyss never get to feel like themselves until the user opens
the accent picker. See proposal B1.

Out of scope (awaiting Kevin's call, not a design issue): the
"Her dark little library" wording in `index.html` / `manifest.json`.

---

## B. Theme proposals (concrete, high-impact first)

### B1. Per-theme default accents (twilight / verdant / abyss)
Keep rose as the brand default for dark, light, hearthside, candlelight,
velvet, frost, midnight. Give the three most "subject" themes an accent
that matches their art direction — the values already exist as accent
options, so this only changes the *default*:

```css
[data-theme="twilight"] { --accent: #8b5cf6; --accent-deep: #6d3fd4; }
[data-theme="verdant"]  { --accent: #8aa864; --accent-deep: #687f4b; }
[data-theme="abyss"]    { --accent: #2fa39a; --accent-deep: #1f7a74; }
```

Implementation: move `--accent`/`--accent-deep` out of the shared defaults
and into each `[data-theme]` block. The `[data-accent="…"]` overrides are
defined later at equal specificity, so an explicit user pick still wins.
Effect: twilight finally feels celestial-violet, verdant feels botanical,
abyss feels deep-teal — out of the box, no settings visit.

### B2. Fix `--faint` on every theme (verified ≥ 4.5:1)
Drop-in replacements (ratios verified computationally):

```css
[data-theme="light"]       { --faint: #75657e; } /* 4.93 */
[data-theme="candlelight"] { --faint: #82643e; } /* 4.77 */
[data-theme="frost"]       { --faint: #5f6c84; } /* 4.67 */
[data-theme="hearthside"]  { --faint: #967850; } /* 4.57 */
[data-theme="twilight"]    { --faint: #79809f; } /* 4.82 */
[data-theme="midnight"]    { --faint: #8784a9; } /* 4.79 */
[data-theme="velvet"]      { --faint: #987888; } /* 4.68 */
```

### B3. Theme-aware heatmap via `color-mix` (no per-theme values needed)
Replace the hardcoded rose ramp with accent-derived steps — automatically
coherent on every theme *and* every user accent:

```css
.cal-day.l1, .heat-cell.l1 { background: color-mix(in srgb, var(--accent) 22%, var(--card)); }
.cal-day.l2, .heat-cell.l2 { background: color-mix(in srgb, var(--accent) 45%, var(--card)); }
.cal-day.l3, .heat-cell.l3 { background: color-mix(in srgb, var(--accent) 72%, var(--card)); }
.cal-day.l4, .heat-cell.l4 { background: var(--accent); }
.heat-cell.sel { outline: 2px solid var(--ink); }
```

(`color-mix` is already used in this codebase — `.disc-ic`, `.chip.dbtrope.ai`.)

### B4. Semantic variables + small fixes (one block)
```css
:root {
  --info: #6aa8e5;            /* reading-status blue */
  --shadow: 0 18px 50px rgba(0,0,0,.5);
}
[data-theme="light"], [data-theme="candlelight"], [data-theme="frost"] {
  --shadow: 0 14px 34px rgba(60,45,20,.18);   /* softer, warm-tinted */
}
/* then: */
.badge.status-reading, .bt-statusbar.status-reading
  { border-color: var(--info); color: var(--info); background: var(--info); }
.fav-btn.on .ticon, .card-fav .ticon, .d-fav2.on .ticon
  { fill: var(--accent); stroke: var(--accent); }
.d-fav2.on { color: var(--accent); border-color: var(--accent); }
.cr-stars { color: var(--gold); }              /* was hardcoded #f5a623 */
.up-pill { background: var(--accent-deep); color: #fff; }  /* 5.10:1 */
.book-tile { border-radius: var(--radius); }  /* was 18px */
.pq-label b { color: var(--ink); }            /* was dead var(--text) */
.st-avatar.letter { background: var(--card2); }
.ob-progress, .log-row, .log-badge.info { background: var(--card2); }
```

### B5. Bespoke moon art (art-production task, spec only)
Redraw the ten `moon-*.svg` as subject-specific scenes at the same 300×300
viewBox, line-art style, single theme stroke color:
- twilight: crescent moon + scattered starfield (closest to current — keep, refine)
- verdant: full moon half-hidden behind monstera leaves
- hearthside: ember-orange moon over wheat stalks
- candlelight: candle-flame moon with rising sparks
- abyss: moon over deep-water waves with bubbles
- frost: pale moon with snowflake crystals
- velvet: wine-dark moon with rose petals
- midnight: gold-ringed moon with tiny constellations (also replaces the
  shared `moon-sparkle.svg` fallback — fixes A9)
- dark / light: keep current garden/laurel direction, redrawn to match the
  new scenes' line weight.

---

## C. Mockups — what before/after previews would show

`docs/design-preview.html` (built alongside this review) renders the current
state: book card + tile, chips, buttons, badges, a mini modal sheet, heat
cells, toast, empty-state divider, and the Discover moon — each in
**dark / twilight / verdant** panels side by side, all from the live
`styles.css`. Use it to see today's baseline.

The after-mockups (to build once Kevin approves B1–B4):
1. **Accent-defaults mockup** — the same three panels with B1 applied:
   twilight's buttons/chips/nav-active turn violet, verdant's turn sage,
   dark stays rose. One glance shows whether per-theme defaults feel like
   identity or feel like brand dilution.
2. **Light-theme legibility mockup** — light/candlelight/frost panels with
   B2 applied, showing tagline, `.note` text, and field labels at the fixed
   ratios next to the current washed-out values.
3. **Heatmap mockup** — the stats calendar under verdant + abyss with B3:
   green/teal intensity ramps instead of the current pink one.
4. **Moon art round** — the ten redrawn moons in a grid (art pipeline task,
   not CSS).

## Files
- This review: `docs/design-review-2026-10-01.md`
- Current-state preview: `docs/design-preview.html`
