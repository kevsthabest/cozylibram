/* Spicy Shelves service worker — caches the app shell so it installs & opens offline.
   Book metadata still needs internet (Google Books API). */
const CACHE = 'spicy-shelves-v29';
const JS = ['00-core.js', '10-theming.js', '20-ratings.js', '30-storefront.js', '40-storage.js', '50-helpers.js', '60-metadata.js', '61-gbooks-key.js', '70-hardcover.js', '80-pagecount.js', '90-sync.js', '100-nav.js', '110-library.js', '120-favorites.js', '130-add.js', '140-collections.js', '150-modal-discovery.js', '160-roulette.js', '170-stats.js', '180-settings.js', '190-wishlist.js', '200-boot.js'].map(f => './js/' + f);
const ASSETS = ['./', './index.html', './styles.css', './manifest.json', './icon.svg'].concat(JS);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.endsWith('/config.js')) return; // never cache: varies per client IP
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
