// Cloudflare Pages Function serving POST /api/cache-cover
//
// v216: canonical cover cache. The client sends a remote cover URL; the
// function fetches the bytes server-side (no browser CORS taint), hashes
// them with SHA-256, stores one content-addressed copy in the Supabase
// Storage `covers` bucket, and returns the public bucket URL. The same
// bytes from any source, adopted by any user, map to one object — storage
// is flat instead of growing per device.
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (Pages env vars, Kevin-owned —
// same as the Workers AI binding). Without them the function 503s and the
// client keeps the remote URL. Keys never enter the repo.
//
// Guards: POST only; per-IP rate limit; https-only + tight host allowlist
// (SSRF: a non-listed host can never be fetched — same "not listed ⇒
// unreachable by construction" shape as cover-proxy.js); 4 MB cap; must
// be an image. Every failure mode answers non-200 and the client falls
// back to the remote URL — a cover is never lost here.

import { rateLimit } from '../_lib/rate-limit.js';

// Hosts we adopt covers from. Verified against live library data 2026-09-30
// (real hostnames, not guesses): assets.hardcover.app is Hardcover's image
// CDN; the Amazon hosts serve Goodreads cover art (images-na... paths embed
// compressed.photo.goodreads.com). Apple hosts are included for picker
// adoptions even though none are stored yet.
const ALLOWED_HOSTS = new Set([
  'covers.openlibrary.org',           // Open Library covers
  'books.google.com',                // Google Books thumbnails
  'assets.hardcover.app',            // Hardcover image CDN
  'images-na.ssl-images-amazon.com', // Goodreads-via-Amazon CDN
  'm.media-amazon.com',              // Amazon media CDN
  'i.gr-assets.com',                 // Goodreads images
  'archive.org',                     // Open Library cover redirects
  'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com', // Apple Books artwork
]);

const MAX_BYTES = 4 * 1024 * 1024;

const EXT_BY_CTYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function hexOf(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Supabase Storage answers a duplicate upload (x-upsert: false) with a 400
// whose body names the conflict. That response IS the dedup hit — treat it
// as success. The shape is matched loosely on purpose: an unverified guess
// at the exact error contract must never turn a dedup hit into a 502.
function isDuplicateError(status, bodyText) {
  if (status !== 400 && status !== 409) return false;
  return /duplicate|already exists/i.test(String(bodyText || ''));
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // 300/min: the bulk backfill paces itself at ~150 req/min; a 429 is always
  // survivable (the client keeps the remote URL and moves on).
  const limited = rateLimit(request, 'cache-cover', 300, 60 * 1000);
  if (limited) return limited;

  const supaUrl = String((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
  const svcKey = (env && env.SUPABASE_SERVICE_KEY) || '';
  if (!supaUrl || !svcKey) {
    return json(503, { error: 'cover cache not configured' });
  }

  let url;
  try {
    const body = await request.json();
    url = String((body && body.url) || '').trim().slice(0, 2000);
  } catch {
    return json(400, { error: 'unparseable body' });
  }
  let target;
  try {
    target = new URL(url);
  } catch {
    return json(400, { error: 'not an https url' });
  }
  if (target.protocol !== 'https:') {
    return json(400, { error: 'not an https url' });
  }
  if (!ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    return json(403, { error: 'host not allowed' });
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'CozyLibram/1.0 cache-cover' },
    });
  } catch {
    return json(502, { error: 'upstream fetch failed' });
  }
  const ctype = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!upstream.ok || !ctype.startsWith('image/')) {
    return json(502, { error: 'not an image' });
  }
  let bytes;
  try {
    bytes = new Uint8Array(await upstream.arrayBuffer());
  } catch {
    return json(502, { error: 'could not read image bytes' });
  }
  if (bytes.byteLength > MAX_BYTES) {
    return json(502, { error: 'image too large' });
  }

  const key = hexOf(await crypto.subtle.digest('SHA-256', bytes)) + '.' + (EXT_BY_CTYPE[ctype] || 'jpg');

  let upRes = null;
  let upText = '';
  try {
    upRes = await fetch(supaUrl + '/storage/v1/object/covers/' + key, {
      method: 'POST',
      headers: {
        apikey: svcKey,
        Authorization: 'Bearer ' + svcKey,
        'Content-Type': ctype,
        'x-upsert': 'false',
      },
      body: bytes,
    });
    upText = await upRes.text();
  } catch {
    return json(502, { error: 'cover store unreachable' });
  }
  if (!upRes.ok && !isDuplicateError(upRes.status, upText)) {
    return json(502, { error: 'cover store rejected the upload' });
  }

  return json(200, { coverUrl: supaUrl + '/storage/v1/object/public/covers/' + key });
}
