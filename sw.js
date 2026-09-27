/* Spicy Shelves service worker — caches the app shell so it installs & opens offline.
   Book metadata still needs internet (Google Books API). */
const CACHE = 'spicy-shelves-v78';
const JS = ['000-core.js', '010-theming.js', '020-ratings.js', '030-storefront.js', '040-storage.js', '050-helpers.js', '060-metadata.js', '061-gbooks-key.js', '070-hardcover.js', '080-pagecount.js', '090-sync.js', '092-metacache.js', '095-gate.js', '100-nav.js', '105-account.js', '110-library.js', '120-favorites.js', '130-add.js', '132-import.js', '133-bookmory.js', '134-verify.js', '136-coverpicker.js', '140-collections.js', '150-modal-discovery.js', '155-authors.js', '160-roulette.js', '170-stats.js', '180-settings.js', '181-appversion.js', '182-tileguard.js', '190-wishlist.js', '200-boot.js'].map(f => './js/' + f);
const AVATARS = ['rose', 'moon', 'dragon', 'raven', 'book', 'crown'].map(id => './img/avatars/avatar-' + id + '.webp');
const ASSETS = ['./', './index.html', './styles.css', './manifest.json', './icon.svg'].concat(JS, AVATARS);

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
