// Cloudflare Pages Function: POST /api/hardcover
//
// Forwards a GraphQL query to Hardcover with the server-side token attached.
// The token never reaches the browser — this is what lets the site stay
// public-without-Cloudflare-Access: there is no secret in /config.js to steal.
//
// Guards: POST only, JSON body with a string `query` (max 8 KB) and an
// optional string `token` — a user's personal Hardcover token, used instead
// of the server token when present (v103: library import). The user token is
// only forwarded upstream, never stored. The upstream HTTP status is
// forwarded untouched so the client's 401/403/429 handling keeps working.

const HC_API = 'https://api.hardcover.app/v1/graphql';
const MAX_QUERY = 8000;
const MAX_TOKEN = 512;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
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
  const userToken = body && typeof body.token === 'string' ? body.token.trim() : '';
  if (userToken.length > MAX_TOKEN) {
    return new Response('bad request', { status: 400 });
  }
  const token = userToken || (env.HARDCOVER_TOKEN || '').trim();
  if (!token) {
    return new Response(JSON.stringify({ errors: [{ message: 'hardcover not configured on this server' }] }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
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
