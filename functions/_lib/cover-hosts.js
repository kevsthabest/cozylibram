// Single source of truth for the cover-provider host allowlists used by
// functions/cover-proxy.js (same-origin pixel reads for spine colours) and
// functions/api/cache-cover.js (cover adoption into the storage bucket).
//
// The two endpoints each kept a private copy of the list and diverged
// twice: v504 (img.hardcover.app missing from cover-proxy, so spine
// colours silently failed) and v518 (assets.hardcover.app and the Amazon
// CDN hosts missing from cover-proxy — same silent failure on the
// successor host). Hosts BOTH endpoints fetch cover bytes from live in
// COVER_HOSTS_SHARED so they cannot drift again. Hosts only one endpoint
// needs are named separately below, with the reason — adding a shared
// cover host is a one-line change to COVER_HOSTS_SHARED.
//
// Hosts verified against live library data (2026-09-30 census, re-checked
// 2026-10-13): assets.hardcover.app is where Hardcover cover URLs point
// now; img.hardcover.app is the CDN named in doc.image.url
// (js/070-hardcover.js); the Amazon hosts serve Goodreads cover art
// (images-na paths embed compressed.photo.goodreads.com).

export const COVER_HOSTS_SHARED = new Set([
  'covers.openlibrary.org',          // Open Library covers
  'books.google.com',                // Google Books thumbnails
  'assets.hardcover.app',            // Hardcover image CDN — cover URLs point here now
  'img.hardcover.app',               // Hardcover's image CDN (doc.image.url, js/070-hardcover.js)
  'images-na.ssl-images-amazon.com', // Goodreads-via-Amazon CDN
  'm.media-amazon.com',              // Amazon media CDN
  'archive.org',                     // Open Library cover redirects
]);

// cover-proxy only: the bare Hardcover domain has been on the proxy's
// list since before v504. Adoption canonicalizes through the CDN hosts
// above, so the authenticated storage endpoint does not need it.
const COVER_PROXY_ONLY = [
  'hardcover.app',                   // Hardcover image CDN (legacy domain)
];

// cache-cover only: adoption sources whose covers land in the bucket.
// The spine-colour sampler reads the resulting bucket URLs (Supabase
// serves CORS on them, and bucket URLs bypass the proxy), and Apple
// artwork sends Access-Control-Allow-Origin: * so the sampler's direct
// CORS path reads it without the proxy — neither needs a proxy entry.
const CACHE_COVER_ONLY = [
  'i.gr-assets.com',                 // Goodreads images
  'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com', // Apple Books artwork
];

export const COVER_PROXY_HOSTS = new Set([...COVER_HOSTS_SHARED, ...COVER_PROXY_ONLY]);
export const CACHE_COVER_HOSTS = new Set([...COVER_HOSTS_SHARED, ...CACHE_COVER_ONLY]);
