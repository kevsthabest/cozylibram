# Cozy Libram — client JS modules

The app is plain, dependency-free JavaScript split into one file per feature.
Files are loaded by script tags in `index.html` — most as ES modules, the
rest as classic scripts (the ES-modules migration record is
`docs/es-modules-migration-plan.md`). Modules publish their surface on
`window` via bridge blocks, so the remaining classic consumers see the same
globals as before, and some module-to-module reads are wired as real static
imports. Load order still matters: keep the zero-padded numeric
prefixes (lexicographic sort must equal numeric order) and don't create circular top-level dependencies.

## Module map

The per-file table that used to live here is replaced by the generated
module map: [docs/module-map.md](../docs/module-map.md) — every file's load
shape, purpose, static imports, and bridge publications, derived from the
tree by `scripts/module-map.mjs`. Do not edit the map by hand; regenerate
it with:

    node scripts/module-map.mjs

Conventions:
- New feature → new numbered file (pick the next free number in its area).
- Tests live in `.test/` and load every file in sorted order via `.test/harness.js`.
- After any JS change: `node --check js/<file>.js`, then run the test suite.
- The service worker (`sw.js`) precaches these files — add new ones to `ASSETS`.
