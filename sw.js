/* Cozy Libram service worker — caches the app shell so it installs & opens offline.
   Book metadata still needs internet (Google Books API). */
const CACHE = 'cozy-libram-v405';
const IMG_CACHE = 'cozy-libram-covers'; // v109: cover art, survives version bumps
// v216: byte budget for the cover cache (was: 600-entry count cap). Bucket
// objects are CORS-clean with real Content-Length, so size-based eviction
// finally works.
const IMG_CACHE_MAX_BYTES = 150 * 1024 * 1024;
const COVERS_PATH = '/storage/v1/object/public/covers/';
const EDITION_IMAGES_PATH = '/storage/v1/object/public/edition-images/';
const EST_BYTES_PER_COVER = 300 * 1024; // fallback when Content-Length is absent
const JS = ['000-core.js', '002-log.js', '010-theming.js', '020-ratings.js', '030-storefront.js', '040-storage.js', '041-idb.js', '050-helpers.js', '060-metadata.js', '061-gbooks-key.js', '062-inventaire.js', '062-tropes.js', '065-analytics.js', '070-hardcover.js', '080-pagecount.js', '090-sync.js', '092-metacache.js', '095-gate.js', '096-onboarding.js', '100-nav.js', '105-account.js', '110-library.js', '120-favorites.js', '130-add.js', '132-import.js', '133-bookmory.js', '134-verify.js', '135-vision.js', '136-coverpicker.js', '137-shelf.js', '138-editions.js', '140-collections.js', '150-modal-discovery.js', '152-overlay-history.js', '155-authors.js', '156-trope-taxonomy.js', '157-trope-inference.js', '158-works.js', '159-characters.js', '160-roulette.js', '170-stats.js', '180-settings.js', '181-appversion.js', '182-tileguard.js', '190-wishlist.js', '195-coven.js', '196-recos.js', '197-social-stats.js', '198-discovery.js', '199-admin.js', '200-boot.js', '205-shelfview.js', '206-editioncapture.js', '207-book3d.js', '211-yolo.js', '212-dna.js', '213-dnf.js', '214-wrapped.js', '208-editionassets.js', '209-editionquality.js', '210-editionmeasure.js'].map(f => './js/' + f);
const AVATARS = ['rose', 'moon', 'dragon', 'raven', 'book', 'crown'].map(id => './img/avatars/avatar-' + id + '.webp');
// v194 (security): vendored third-party libs, precached like first-party code.
const VENDOR = ['supabase.min.js', 'quagga.min.js', 'three.min.js'].map(f => './js/vendor/' + f).concat(['./vendor/d3.min.js']);
// v184: bespoke per-theme modal artwork, complete set (all ten themes)
const THEME_ART = ['twilight', 'verdant', 'velvet', 'abyss', 'frost', 'dark', 'light', 'hearthside', 'candlelight'].flatMap(t => ['vine', 'divider', 'moon'].map(k => './Asset/themes/' + k + '-' + t + '.svg'));
const ASSETS = ['./', './index.html', './styles.css', './manifest.json', './icon.svg', './icon-512.png', './icon-maskable-512.png', './Asset/floral-right.svg'].concat(JS, VENDOR, AVATARS, THEME_ART);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))))
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
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
