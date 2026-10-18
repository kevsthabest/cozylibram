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
//
// Redirects are followed manually, hop by hop, and every hop target is
// re-validated against the same admission rule before it is fetched —
// with the platform's default redirect handling the initial check alone
// decides nothing, because a listed host can redirect anywhere (issue
// #344 demonstrated an everyday Open Library cover fetching two
// unlisted hosts). Admission is exact-match against the allowlist, plus
// subdomains of archive.org: Open Library covers land on per-item
// ia*.us.archive.org storage hosts that cannot be enumerated in an
// exact list, and archive.org is already trusted as an entry host, so
// the suffix admit extends trust only to archive-controlled storage
// nodes (Decision, 2026-10-18). Every other host stays exact-match.

import { rateLimit } from './_lib/rate-limit.js';
import { COVER_PROXY_HOSTS as ALLOWED_HOSTS } from './_lib/cover-hosts.js';

const MAX_BYTES = 4 * 1024 * 1024;
// Legitimate cover chains are short (Open Library's is two hops); the
// bound exists so a redirect loop or an over-long chain is refused by
// this endpoint's own policy instead of running into the platform's
// fetch cap in a shape nobody chose.
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// The one admission rule, applied to the requested URL and to every
// redirect hop alike: exact allowlist match, or a subdomain of
// archive.org (see the header for why the suffix admit exists).
// archive.org itself is an exact allowlist entry; the dot boundary
// keeps lookalikes (archive.org.evil.com, evilarchive.org) out.
function hostAdmitted(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.has(host) || host.endsWith('.archive.org');
}

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
  if (target.protocol !== 'https:' || !hostAdmitted(target.hostname)) {
    return new Response('host not allowed', { status: 403 });
  }

  // Fetch with redirect handling off and follow the chain by hand, so
  // each hop target passes hostAdmitted (and stays https) before it is
  // fetched. A hop that fails validation is refused unfetched — that is
  // what makes the header's "a non-listed host can never be fetched"
  // true for the whole chain, not just its first URL.
  let upstream;
  let current = target;
  try {
    for (let redirects = 0; ; redirects++) {
      upstream = await fetch(current.toString(), {
        headers: { 'User-Agent': 'CozyLibram/1.0 cover-proxy' },
        redirect: 'manual',
      });
      const location = upstream.headers.get('Location');
      if (!REDIRECT_STATUSES.has(upstream.status) || !location) break;
      if (redirects >= MAX_REDIRECTS) {
        return new Response('too many redirects', { status: 502 });
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        return new Response('bad redirect', { status: 502 });
      }
      if (next.protocol !== 'https:' || !hostAdmitted(next.hostname)) {
        return new Response('host not allowed', { status: 403 });
      }
      current = next;
    }
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
