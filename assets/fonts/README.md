# Vendored webfonts

Vendored 2026-10-14 (v554) from the Google Fonts css2 API — the exact
families, weights, styles and unicode-range subsets the app previously
requested at runtime via a `fonts.googleapis.com` stylesheet link:

- **Inter** 400 / 500 / 600 (normal), latin + latin-ext subsets
  - Copyright 2016–2020 The Inter Project Authors (Rasmus Andersson)
  - SIL Open Font License 1.1 — https://openfontlicense.org
  - Upstream: https://github.com/rsms/inter
  - Served files: Inter v20 subsets (`inter-<subset>.woff2`)
- **Playfair Display** 500 / 700 (normal) + 500 italic, latin + latin-ext
  - Copyright 2017 The Playfair Display Project Authors
  - SIL Open Font License 1.1 — https://openfontlicense.org
  - Upstream: https://github.com/itfoundry/Playfair-Display
  - Served files: Playfair Display v40 subsets (`playfair-display-[italic-]<subset>.woff2`)

Both families arrive from the css2 API as **variable fonts** — one file
per family/style/subset covering the whole requested weight range (the
500-italic Playfair is the exception: a static file). The per-weight
`@font-face` rules in `styles.css` therefore share one file per subset and
declare their own weight, which the browser instantiates from the
variable font — the same arrangement the API's own stylesheet used.

The `@font-face` rules live at the top of `styles.css` (with
`font-display: swap`, matching the old `display=swap`), and sw.js precaches
every file here (the `FONTS` list) so first paint renders correctly
offline. 6 files, ~225 KB total.

To refresh: re-request the same css2 URL with a browser user agent, keep
only the `latin` and `latin-ext` `@font-face` blocks, and save one woff2
per family/style/subset under the names above.
