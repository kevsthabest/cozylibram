# ADR-015 — Tuned adoption: brand locks as detector ignores, token contrast as a standing CI gate
Date: 2026-10-24 · Status: active

## Context

The Tuned adoption (spec: `~/workspace/prototypes/tuned-adoption-spec-2026-10-24.md`,
User-approved 2026-10-24) took the parts of the Impeccable design
review that fit this app and made four of its rulings standing
rather than one-off fixes. This record exists so the rulings are
found where the team gates, not only in the spec, which lives
outside the repo.

The spec's §0 locks three brand items: the gradient-gold wordmark
(`.app-header h1`), Inter as the house typeface, and the gold
side-tab on the currently-reading card. Every detector scan flagged
all three, plus the inlined stale CSS in `docs/design-preview.html`
— noise that trained readers to skim past the scan's real findings.

The contrast work exposed a measurement gap: the v228/v588 audits
checked text tokens against `--card` only. Measured against all
three surfaces (`--card`, `--card2`, `--bg`), 18 of 23 themes had
a `--faint` (and one `--muted`) under WCAG AA's 4.5:1 — worst on
`--card2`, the surface nobody had measured.

## Decision

**The locks are encoded, not re-argued.** `.impeccable/config.json`
(shared scope, written by the Impeccable v4.7 CLI) carries scoped
ignores for `gradient-text`, `overused-font` (value `inter`) and
`side-tab`, and excludes `docs/design-preview.html` as a file. A
scan of the tuned tree returns only unruled findings.

One schema caveat, recorded because it widens the draft: v4.7's
`ignoreValues` have **no selector scoping** — a `selector` key is
silently ignored by the engine (verified against the shipped
binary). Suppression is rule + value + files, so the gradient-text
ignore covers all of styles.css rather than only `.app-header h1`,
and a second entry covers index.html, where the detector attributes
the same rules resolved through the page's linked stylesheet (the
wordmark again, plus `.nav-brand-name` — the same gradient wordmark
in the wide-layout nav). The selectors the draft intended are named
in each entry's `reason` for human readers. If a future detector
version gains selector scoping, narrow the entries to match.

**Token contrast is a standing gate.** `scripts/check-theme-contrast.mjs`
(zero-dependency) parses the theme token blocks in styles.css and
fails when any `--ink`/`--muted`/`--faint` pair against `--card`,
`--card2` or `--bg` falls under 4.5:1 in any theme; it runs as a
leg of `scripts/run-ci.mjs`. Token values may only move toward
their theme's own `--ink` to satisfy it — the bar does not move.

**The glow defect is drift, not glow.** The ISBN scan-line's glow
stays; what was wrong was its literal fallback `var(--gold, #e8b4a0)`
— a rose-gold matching no theme's `--gold`. Every `#e8b4a0` fallback
is re-tied to `var(--gold)`. Same-pattern fallbacks with other
literals (`.ic-bar`'s `#d4a574`, the marginalia notes' `#c9a227`)
are not glows and were left for a separate ruling.

**Geometry rules stand after this build.** Interactive chips,
pills and segmented controls floor at 44px on flagship surfaces;
one `h2` per view (the view title), sections `h3`, card titles
`h4`, sheets/dialogs carrying their own `h2`. Two spec premises
did not survive contact with the tree and are recorded so they
are not re-litigated: the `.seg` family already met the floor
(v590's `min-height`), and the Library view's filter/status chips
already render at view level — no nested-card instance exists on
the current tree for G2 to move.

## What we gave up

Detector coverage of `gradient-text` inside styles.css/index.html
beyond the wordmark: the file-scoped suppression also silences the
gold-foil `.spine-title` gradient (styles.css scan) — accepted
collateral of the missing selector scoping, named above so a
future narrowing restores it. The `.empty h3` size restatement and
the other demotion-companion CSS rules are deliberate duplication:
heading level is semantics, size is presentation, and the ladder
fix was not allowed to shrink any rendered heading.

## Evidence

- Contrast gate on the pre-Tuned tree: 37 failing pairs across
  exactly the 18 themes the evidence matrix named; on the tuned
  tree: `23/23 themes pass — all 207 text/surface pairs >= 4.5:1`.
- Detector: 70 findings pre-config (20 of them low-contrast, all
  in the preview's inlined CSS) → 14 with the config landed, all
  unruled signal (broken-image in the capture templates,
  bounce-easing, border-accent-on-rounded, the §4-ruled scan glow
  as dark-glow, the candle-flame radial-halo, repeating-stripes).
- Tap targets measured on rendered surfaces (headless Chromium,
  360px and 1280px): `.d-tab` 39→44, `.sv-chip` 31→44,
  `.view-toggle button` 34→44, `.sv-cam` 42→44, `.seg button` 44
  (unchanged). Screenshots and outlines under
  `docs/pr-shots/tuned-adoption/`.
- The ruling: the User's approved Tuned spec, 2026-10-24.
