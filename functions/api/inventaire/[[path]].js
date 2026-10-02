// Cloudflare Pages Function: GET /api/inventaire/<path>?<query>
//
// Forwards to the Inventaire API (https://inventaire.io/api). Only the
// entities endpoint the app uses (ISBN lookup via by-uris) is allowed.
// No API key is needed — Inventaire's public read API asks only for an
// identifying User-Agent, which is set server-side here (browsers cannot
// set User-Agent themselves).
//
// v225 (security): quota-spending endpoint — signed-in callers only.

import { rateLimit } from '../../_lib/rate-limit.js';
import { authedUser, unauthorized } from '../../_lib/require-user.js';

const ALLOWED_PATHS = new Set(['entities']);

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }
  const user = await authedUser(request, env);
  if (!user) return unauthorized();
  const limited = rateLimit(request, 'inventaire', 120, 60 * 1000);
  if (limited) return limited;
  const path = (params.path || []).join('/');
  if (!ALLOWED_PATHS.has(path)) {
    return new Response('not found', { status: 404 });
  }

  const incoming = new URL(request.url);
  const target = new URL('https://inventaire.io/api/' + path);
  incoming.searchParams.forEach((v, k) => {
    target.searchParams.append(k, v);
  });

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'CozyLibram/1.0 inventaire-proxy' },
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
