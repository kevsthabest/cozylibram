/* Cozy Libram service worker — caches the app shell so it installs & opens offline.
   Book metadata still needs internet (Google Books API). */



const CACHE = 'cozy-libram-v630';

const IMG_CACHE = 'cozy-libram-covers'; // v109: cover art, survives version bumps
// v500: Reader Portrait sticker artwork (assets/stickers/cut-webp/) is
// runtime-cached on first use, NEVER precached — the full library is
// 13.1 MB and must not block app install. Survives version bumps like
// the cover cache; count-capped (a theme's set is ~24 stickers).
const STICKER_CACHE = 'cozy-libram-stickers';
const STICKER_CACHE_MAX = 96;
const STICKERS_PATH = '/assets/stickers/cut-webp/';
// v558 (Decision on PR #225): the ZXing barcode-decoder files under
// js/vendor/zxing/ (~1 MB incl. the .wasm) are runtime-cached on first
// fallback use, NEVER precached — installs stay lean; the first scan on
// a browser without BarcodeDetector fetches them once over the network,
// later scans run offline. Survives version bumps like the cover and
// sticker caches — with one discipline: bump this name when the
// vendored zxing version changes, since the name is the only eviction
// lever for a stale decoder. The path is a closed set of three files
// (share.js,
// es/reader.js, zxing_reader.wasm), so no eviction cap is needed.
const ZXING_CACHE = 'cozy-libram-zxing';
const ZXING_PATH = '/js/vendor/zxing/';
// v585 (issue #214): the picker-sized avatar derivatives under
// img/avatars/thumb/ (22 files, ~160 KB) are runtime-cached on first
// picker use, NEVER precached — the same pattern as stickers and the
// ZXing decoder: installs stay lean (the 1600x1600 originals, 2,246 KB,
// are already the precache cost), and the closed file set needs no
// eviction cap. Survives version bumps like the other runtime caches.
const AVATAR_THUMB_CACHE = 'cozy-libram-avatar-thumbs';
const AVATAR_THUMBS_PATH = '/img/avatars/thumb/';
// v216: byte budget for the cover cache (was: 600-entry count cap). Bucket
// objects are CORS-clean with real Content-Length, so size-based eviction
// finally works.
const IMG_CACHE_MAX_BYTES = 150 * 1024 * 1024;
const COVERS_PATH = '/storage/v1/object/public/covers/';
const EDITION_IMAGES_PATH = '/storage/v1/object/public/edition-images/';
const EST_BYTES_PER_COVER = 300 * 1024; // fallback when Content-Length is absent
const JS = ['000-core.js', '002-log.js', '010-theming.js', '020-ratings.js', '030-storefront.js', '040-storage.js', '041-idb.js', '050-helpers.js', '055-sheetdrag.js', '056-discovery-match.js', '060-metadata.js', '061-gbooks-key.js', '062-inventaire.js', '062-tropes.js', '065-analytics.js', '070-hardcover.js', '080-pagecount.js', '090-sync.js', '092-metacache.js', '095-gate.js', '096-onboarding.js', '100-nav.js', '105-account.js', '110-library.js', '120-favorites.js', '130-add.js', '132-import.js', '133-bookmory.js', '134-verify.js', '135-vision.js', '136-coverpicker.js', '137-shelf.js', '138-editions.js', '139-import-concierge.js', '140-collections.js', '150-modal-discovery.js', '151-modal-flairs.js', '152-overlay-history.js', '154-characterstore.js', '155-authors.js', '156-trope-taxonomy.js', '157-trope-inference.js', '158-works.js', '159-characters.js', '160-roulette.js', '161-tropelab.js', '162-charlab.js', '163-analytics.js', '164-spinelab.js', '165-editionassets.js', '166-logs.js', '170-stats.js', '180-settings.js', '181-appversion.js', '182-tileguard.js', '190-wishlist.js', '195-coven.js', '196-recos.js', '197-social-stats.js', '198-discovery.js', '199-admin.js', '200-boot.js', '205-shelfview.js', '203-editionvision.js', '206-editioncapture.js', '207-book3d.js', '204-shelf3d-layout.js', '215-shelf3d.js', '216-shelf3d-theme.js', '217-shelf3d-view.js', '218-shelf3d-decor.js', '219-milestones.js', '220-share-moments.js', '221-trigger-check.js', '222-community-corpus.js', '223-community-corpus-ui.js', '224-curation-queue.js', '225-book-portrait.js', '226-dna-survey.js', '227-reading-nudges.js', '228-portrait-share.js', '229-user-state.js', '230-privacy.js', '231-reactions.js', '232-thought-of-you.js', '233-buddy-reads.js', '234-outbox.js', '235-reading-it-too.js', '236-sticker-picker.js', '237-handles.js', '238-book-candle.js', '239-finale.js', '240-book-dressing.js', '241-book-ambience.js', '242-marginalia.js', '244-gift-postal.js', '243-gifts.js', '211-yolo.js', '212-dna.js', '213-dnf.js', '214-wrapped.js', '208-editionassets.js', '209-editionquality.js', '210-editionmeasure.js'].map(f => './js/' + f);
// v544: all 22 registered avatar ids (Classics + Stormrider + Voidsignal) —
// keep in step with DEFAULT_AVATARS in js/105-account.js; the avatars suites
// pin the match.
const AVATARS = ['rose', 'moon', 'dragon', 'raven', 'book', 'crown', 'onyxdragon', 'golddragon', 'egg', 'daggers', 'goggles', 'parapet', 'ring', 'tabby', 'darknet', 'visor', 'daemon', 'cornsignal', 'drone', 'circuitkey', 'strands', 'silo'].map(id => './img/avatars/avatar-' + id + '.webp');
// v560: vendored webfonts (assets/fonts/). Precached like the rest of the
// shell: type is the first thing a reader sees, and a first offline paint in
// fallback fonts would be a visible regression. 6 files, ~225 KB — the css2
// API serves one variable font per family/style/subset, so the per-weight
// @font-face rules in styles.css share a file per subset.
const FONTS = ['inter-latin.woff2', 'inter-latin-ext.woff2', 'playfair-display-latin.woff2', 'playfair-display-latin-ext.woff2', 'playfair-display-italic-latin.woff2', 'playfair-display-italic-latin-ext.woff2'].map(f => './assets/fonts/' + f);
// v194 (security): vendored third-party libs, precached like first-party code.
// (The zxing decoder is the exception — runtime-cached, see ZXING_CACHE.)
const VENDOR = ['supabase.min.js', 'three.module.js'].map(f => './js/vendor/' + f).concat(['./vendor/d3.min.js']);
// v184: bespoke per-theme modal artwork, complete set (all ten themes)
// Batch 4 (issue #144): precache exactly the theme SVGs styles.css references
// (15 themes × divider/moon = 30). The 9 vine-*.svg entries and
// Asset/floral-right.svg were precached but referenced nowhere — dropped.
const THEME_ART = ['twilight', 'verdant', 'velvet', 'abyss', 'frost', 'dark', 'light', 'hearthside', 'candlelight', 'midnight', 'stormrider', 'briarthrone', 'voidsignal', 'wisp', 'wisp-night', 'haunt', 'yuletide', 'fete', 'amour', 'shamrock', 'pastel', 'harvest', 'solstice'].flatMap(t => ['divider', 'moon'].map(k => './Asset/themes/' + k + '-' + t + '.svg'));
const ASSETS = ['./', './index.html', './styles.css', './manifest.json', './icon.svg', './icon-512.png', './icon-maskable-512.png'].concat(JS, VENDOR, AVATARS, THEME_ART, FONTS);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE && k !== STICKER_CACHE && k !== ZXING_CACHE && k !== AVATAR_THUMB_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// v216: size-based LRU trim — Cache.keys() returns insertion order, so the
// oldest covers are evicted first. Sizes come from the stored response's
// Content-Length (bucket objects are CORS-clean, so it is real), falling
// back to a conservative estimate when absent. Defensive: any failure
// leaves the cache alone.
function trimImageCache(cache) {
  return cache.keys().then(async (keys) => {
    try {
      const sizes = [];
      let total = 0;
      for (const req of keys) {
        let size = EST_BYTES_PER_COVER;
        try {
          const res = await cache.match(req);
          const len = parseInt((res && res.headers.get('Content-Length')) || '', 10);
          if (Number.isFinite(len) && len > 0) size = len;
        } catch (e) {}
        sizes.push(size);
        total += size;
      }
      let i = 0;
      const dels = [];
      while (total > IMG_CACHE_MAX_BYTES && i < keys.length) {
        total -= sizes[i];
        dels.push(cache.delete(keys[i]));
        i++;
      }
      await Promise.all(dels);
    } catch (e) { /* leave the cache alone */ }
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.endsWith('/config.js')) return; // never cache: varies with server config
  if (url.pathname.startsWith('/api/')) return; // never cache: live API responses
  // v216: only canonical bucket covers get a runtime cache (cache-first, so
  // the library renders offline once covers are seen or pre-cached from
  // Settings → Offline). The old catch-all that cached EVERY image the
  // device ever rendered (~1 GB of picker candidates, edition art and
  // full-resolution files) is gone.
  if (e.request.destination === 'image' &&
      (url.pathname.indexOf(COVERS_PATH) === 0 || url.pathname.indexOf(EDITION_IMAGES_PATH) === 0)) {
    e.respondWith((async () => {
      const cache = await caches.open(IMG_CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && res.ok) {
          await cache.put(e.request, res.clone());
          trimImageCache(cache).catch(() => {});
        }
        return res;
      } catch (err) {
        return Response.error();
      }
    })());
    return;
  }
  // v500: portrait sticker artwork — cache-first with runtime fill, same
  // pattern as covers. Only the active theme's ~24 stickers ever land on a
  // device; the count cap evicts oldest-first if themes rotate heavily.
  if (url.origin === location.origin && url.pathname.indexOf(STICKERS_PATH) === 0) {
    e.respondWith((async () => {
      const cache = await caches.open(STICKER_CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && res.ok) {
          await cache.put(e.request, res.clone());
          const keys = await cache.keys();
          if (keys.length > STICKER_CACHE_MAX) {
            await Promise.all(keys.slice(0, keys.length - STICKER_CACHE_MAX).map(k => cache.delete(k)));
          }
        }
        return res;
      } catch (err) {
        return Response.error();
      }
    })());
    return;
  }
  // v558: ZXing decoder files — cache-first with runtime fill, same
  // pattern as stickers. Both request shapes land here as same-origin
  // GETs under ZXING_PATH: the dynamic import() of es/reader.js (and its
  // share.js dependency) and the locateFile fetch of the .wasm. The
  // generic same-origin branch below only matches, never stores, so
  // without this rule the decoder would re-download on every scan.
  if (url.origin === location.origin && e.request.method === 'GET' && url.pathname.indexOf(ZXING_PATH) === 0) {
    e.respondWith((async () => {
      const cache = await caches.open(ZXING_CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && res.ok) {
          await cache.put(e.request, res.clone());
        }
        return res;
      } catch (err) {
        return Response.error();
      }
    })());
    return;
  }
  // v585 (issue #214): avatar picker derivatives — cache-first with
  // runtime fill, same pattern as stickers/zxing. The generic
  // same-origin branch below only matches, never stores, so without
  // this rule the thumbs would re-download on every picker open.
  if (url.origin === location.origin && e.request.method === 'GET' && url.pathname.indexOf(AVATAR_THUMBS_PATH) === 0) {
    e.respondWith((async () => {
      const cache = await caches.open(AVATAR_THUMB_CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && res.ok) {
          await cache.put(e.request, res.clone());
        }
        return res;
      } catch (err) {
        return Response.error();
      }
    })());
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
