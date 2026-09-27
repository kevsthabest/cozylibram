// Cloudflare Pages Function serving GET /cover-proxy?url=<https url>
//
// Same-origin cover fetch so the app can read cover pixels (favorites spine
// colors) from hosts that don't send CORS headers. Mirrors server.py's
// /cover-proxy contract: image bytes, 4 MB cap, must be an image.
//
// Guards: only https, and the host must be on the known-cover-host allowlist
// below (tight allowlist replaces server.py's DNS-based SSRF check — a
// non-listed host can never be fetched, so private/loopback targets are
// unreachable by construction).
//
// Add a host here if a new cover provider is ever adopted.

const ALLOWED_HOSTS = new Set([
  'covers.openlibrary.org', // Open Library covers
  'books.google.com',       // Google Books thumbnails
  'hardcover.app',          // Hardcover image CDN
  'archive.org',            // Open Library cover redirects
]);

const MAX_BYTES = 4 * 1024 * 1024;

export async function onRequest(context) {
  const raw = (new URL(context.request.url).searchParams.get('url') || '').trim().slice(0, 2000);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response('need an https url', { status: 400 });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    return new Response('host not allowed', { status: 403 });
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'CozyLibram/1.0 cover-proxy' },
    });
  } catch {
    return new Response('upstream fetch failed', { status: 502 });
  }

  const ctype = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!upstream.ok || !ctype.startsWith('image/')) {
    return new Response('not an image', { status: 502 });
  }

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return new Response('image too large', { status: 502 });
  }

  return new Response(buf, {
    headers: {
      'Content-Type': ctype,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
