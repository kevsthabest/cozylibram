// Cloudflare Pages Function: GET /api/gbooks/<path>?<query>
//
// Forwards to the Google Books API with the server-side key attached. The key
// never reaches the browser. Only the volumes endpoint the app uses is
// allowed; a client-supplied `key` param is stripped and replaced.
//
// If no key is configured, the request is forwarded without one (same as the
// old anonymous behavior) so the app keeps working.

import { rateLimit } from '../../_lib/rate-limit.js';

const ALLOWED_PATHS = new Set(['books/v1/volumes']);

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }
  // v194 (security): unauthenticated internet-facing quota spend — cap it.
  const limited = rateLimit(request, 'gbooks', 120, 60 * 1000);
  if (limited) return limited;
  const path = (params.path || []).join('/');
  if (!ALLOWED_PATHS.has(path)) {
    return new Response('not found', { status: 404 });
  }

  const incoming = new URL(request.url);
  const target = new URL('https://www.googleapis.com/' + path);
  incoming.searchParams.forEach((v, k) => {
    if (k !== 'key') target.searchParams.append(k, v);
  });
  const key = (env.GOOGLE_BOOKS_KEY || '').trim();
  if (key) target.searchParams.set('key', key);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'CozyLibram/1.0 gbooks-proxy' },
    });
  } catch {
    return new Response('upstream fetch failed', { status: 502 });
  }
  const data = await upstream.arrayBuffer();
  return new Response(data, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}
