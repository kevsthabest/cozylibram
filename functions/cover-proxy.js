// Cloudflare Pages Function serving GET /cover-proxy?url=<https url>
//
// Same-origin cover fetch so the app can read cover pixels (favorites spine
// colors) from hosts that don't send CORS headers. Mirrors server.py's
// /cover-proxy contract: image bytes, 4 MB cap, must be an image.
//
// Guards: only https, and the host must be on the known-cover-host
// allowlist (tight allowlist replaces server.py's DNS-based SSRF check —
// a non-listed host can never be fetched, so private/loopback targets
// are unreachable by construction). The allowlist lives in
// functions/_lib/cover-hosts.js — a single source of truth since the
// endpoints' private copies diverged twice (v504, v518). (The other
// consumer, /api/cache-cover, was removed in v537.)

import { rateLimit } from './_lib/rate-limit.js';
import { COVER_PROXY_HOSTS as ALLOWED_HOSTS } from './_lib/cover-hosts.js';

const MAX_BYTES = 4 * 1024 * 1024;

export async function onRequest(context) {
  // v194 (security): unauthenticated internet-facing endpoint — cap it.
  const limited = rateLimit(context.request, 'cover-proxy', 120, 60 * 1000);
  if (limited) return limited;
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
  // (#345): image/svg+xml starts with image/ but is not a cover image — it
  // is an XML document that can carry script, and served from this origin a
  // top-level navigation to the proxy URL would run that script where the
  // app's session lives. Every allowlisted provider serves raster covers,
  // so SVG is refused with the non-images.
  if (!upstream.ok || !ctype.startsWith('image/') || ctype === 'image/svg+xml') {
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
      // (#345) defense in depth for any future document-like image type:
      // nosniff pins the declared type, and a sandboxed CSP makes a
      // top-level navigation to this URL land in an opaque origin with
      // script disabled. Subresource <img>/fetch use ignores both.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    },
  });
}
