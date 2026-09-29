// Shared in-memory sliding-window rate limiter for Pages Functions.
//
// v194 (security): the /api/* proxies spend server-side quota/credits
// (LLM tokens, Hardcover, Google Books) and are reachable from the public
// internet with no auth. This blunts single-source abuse: each caller IP
// gets `limit` requests per `windowMs` per endpoint, then 429s.
//
// Limitation: state is per-isolate, and Cloudflare runs many isolates, so
// a distributed attacker still gets through. Pair this with a Cloudflare
// dashboard rate-limiting rule on /api/* for a global guarantee.

const buckets = new Map(); // key -> array of request timestamps (ms)

function clientIp(request) {
  return (request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0] ||
    'unknown').trim().slice(0, 64);
}

// Returns a 429 Response when over the limit, or null when the request
// may proceed. `name` scopes the bucket to one endpoint.
export function rateLimit(request, name, limit, windowMs) {
  const now = Date.now();
  const key = name + '|' + clientIp(request);
  let hits = buckets.get(key);
  if (!hits) {
    hits = [];
    buckets.set(key, hits);
  }
  while (hits.length && now - hits[0] >= windowMs) hits.shift();
  if (hits.length >= limit) {
    const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
    return new Response('rate limited', {
      status: 429,
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': String(Math.max(1, retryAfter)),
      },
    });
  }
  hits.push(now);
  // Occasional prune so the map can't grow without bound.
  if (buckets.size > 5000 && Math.random() < 0.01) {
    for (const [k, v] of buckets) {
      while (v.length && now - v[0] >= windowMs) v.shift();
      if (!v.length) buckets.delete(k);
    }
  }
  return null;
}
