// Cloudflare Pages Function: POST /api/hardcover
//
// Forwards a GraphQL query to Hardcover with the server-side token attached.
// The token never reaches the browser — this is what lets the site stay
// public-without-Cloudflare-Access: there is no secret in /config.js to steal.
//
// Guards: POST only, JSON body with a string `query` (max 8 KB), and the
// query must match the app's known shapes (anonymous `query {` with a
// search/books/editions/series root — see hcQueryAllowed). The upstream
// HTTP status is forwarded untouched so the client's 401/403/429 handling
// keeps working.

import { rateLimit } from '../_lib/rate-limit.js';
import { authedUser, unauthorized, forbiddenBanned } from '../_lib/require-user.js';

const HC_API = 'https://api.hardcover.app/v1/graphql';
const MAX_QUERY = 8000;

// SEC-03 (2026-10-01): allowlist the query shapes the app actually sends.
// The proxy previously forwarded any GraphQL verbatim on the owner's token.
// Every app query is an anonymous `query { <root>(...) { ... } }` whose root
// field is one of these (js/070-hardcover.js and its callers); anything else
// is rejected with 403. A single anonymous query operation is read-only by
// construction (a mutation needs the `mutation` operation keyword), and
// introspection is blocked explicitly.
const HC_ALLOWED_ROOTS = new Set(['search', 'books', 'editions', 'series']);

function hcQueryAllowed(query) {
  const q = String(query || '');
  if (!/^\s*query\s*\{/.test(q)) return false;
  // Strip string literals first: a book titled "Mutation" must neither trip
  // the keyword checks nor hide an attack inside a string.
  const stripped = q.replace(/"(?:[^"\\]|\\.)*"/g, '""').toLowerCase();
  if (stripped.includes('__schema') || stripped.includes('__type')) return false;
  if (/\b(mutation|subscription)\b/i.test(stripped)) return false;
  if (/\}\s*(query|mutation|subscription)\b/i.test(stripped)) return false;
  const m = /^\s*query\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(q);
  return !!m && HC_ALLOWED_ROOTS.has(m[1]);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // v225 (security): quota-spending endpoint — signed-in callers only.
  const user = await authedUser(request, env);
  if (!user) return unauthorized();
  if (user.banned) return forbiddenBanned(); // v246: suspended accounts
  // v194 (security): unauthenticated internet-facing quota spend — cap it.
  const limited = rateLimit(request, 'hardcover', 120, 60 * 1000);
  if (limited) return limited;
  const token = (env.HARDCOVER_TOKEN || '').trim();
  if (!token) {
    return new Response(JSON.stringify({ errors: [{ message: 'hardcover not configured on this server' }] }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const query = body && typeof body.query === 'string' ? body.query : '';
  if (!query || query.length > MAX_QUERY) {
    return new Response('bad request', { status: 400 });
  }
  if (!hcQueryAllowed(query)) {
    return new Response('query shape not allowed', { status: 403 });
  }

  let upstream;
  try {
    upstream = await fetch(HC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'CozyLibram/1.0 hc-proxy',
      },
      body: JSON.stringify({ query }),
    });
  } catch {
    return new Response('upstream fetch failed', { status: 502 });
  }
  const data = await upstream.arrayBuffer();
  return new Response(data, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
