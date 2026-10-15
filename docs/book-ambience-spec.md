# Ambience That Matches the Book — Spec

**Status:** Approved by the User (2026-10-15, from the wow-features brainstorm). One PR.
**Rubric snapshot:** Reader value — the app joins the reading ritual itself, not just the bookkeeping around it; readers already seek out ambiance audio while reading. Brief-fit — pass (optional, ambient, no tracking/pressure; never autoplay). Moat-fit — medium (the recipe is chosen from the book's corpus tropes/setting, not a generic playlist). Scope — **M**. Placement — **Free** (procedurally generated audio has no per-play cost; later curated sound packs could be a premium extension — not this spec). Displaced surface — none; one entry point on the book page, plus a mini-control while playing.

## 1. What

From a book's page, one tap plays an ambient soundscape matched to that book: rain on castle windows for the gothic, a low ship's hum for the space opera, waves and gulls for the coastal romance, a crackling fireplace for the cozy.

- **Procedural audio.** Soundscapes are synthesized with WebAudio (filtered noise beds, gentle oscillators, slow LFO movement). **Zero audio assets**: nothing to license, nothing to download, fully offline-capable, no additions to the precache.
- **Recipe selection.** A recipe is chosen from the book's actual signals — setting tags first, then tropes, then genre — and labeled as inspired-by ("Rain over the moor · from this book's setting"). If signals are thin, the sheet offers the generic house set (Rain, Fireplace, Library, Night) **without** book-specific claims.
- **Controls.** Play/pause, volume, the current recipe's name, and "a different mood" (cycles the other recipes this book's signals plausibly support). Ambience keeps playing across in-app navigation with a small persistent mini-control; it never autoplays, and it stops cleanly when the app closes.

## 2. Who

The cozy reader — the app's core. Reading-with-ambiance is already an established behaviour in this audience (ambiance videos/channels); this brings it inside the app, matched to the book automatically.

## 3. Why now

User-approved from the wow brainstorm. Procedural generation removes the two blockers that would normally kill an audio feature (licensing + asset weight), and the trope/setting signals it keys off are already in the corpus.

## 4. Scope

- WebAudio soundscape engine + a v1 recipe catalogue (recommend ~8 recipes: rain, storm, fireplace, ocean, forest, night insects, café murmur, ship hum, library quiet — pick 8 in the PR).
- Book-signal → recipe mapping (setting > trope > genre), with the honest thin-data fallback.
- Book-page entry point + persistent mini-control + volume persistence (a user detail — roams with settings).

## 5. Dependencies

- Trope/setting/genre fields (live).
- No server work; no assets; no sync beyond the volume/toggle preference.

## 6. Explicitly out of scope

- No recorded/licensed audio, no streaming, no user uploads.
- No per-chapter or progress-reactive ambience changes in v1 (the recipe follows the book, not the page).
- No sleep timer in v1 — a timer UI invites the productivity framing the brief avoids; if readers ask, revisit deliberately.

## 7. Open questions

- Entry point: book page only (recommend), or also a shortcut on the Currently Reading card? Recommend book page first; add the shortcut if it earns it.
- Recipe catalogue final 8 — Builder proposes in the PR with short descriptions; User vetoes by ear.
