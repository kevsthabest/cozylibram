import { rateLimit } from '../_lib/rate-limit.js';
import { authedUser, unauthorized } from '../_lib/require-user.js';

// Cloudflare Pages Function: POST /api/embed
//
// Batched text-embedding proxy for the "Recommended for you" feature
// (v213). Forwards to the Workers AI binding (env.AI) — no API key, no
// second vendor, same request context as the Pages Function. The model is
// fixed server-side (@cf/baai/bge-m3, 1024 dims); the client cannot choose
// a model or endpoint.
//
// Guards: POST only, JSON body with a `texts` array (1..50 entries, each
// 1..4000 chars). Returns { vectors: number[][] } in input order.
// 503 with a clear message when the Workers AI binding is missing, so the
// client can explain setup instead of failing silently.

const MODEL = '@cf/baai/bge-m3';
const MAX_TEXTS = 50;
const MAX_TEXT_CHARS = 4000;

const jsonErr = (status, error) => new Response(JSON.stringify({ error }),
  { status, headers: { 'Content-Type': 'application/json' } });

/* Normalize the Workers AI embedding response to one vector. Accepts the
   batch shape { data: [[...], ...] } and the single shape { data: [...] }. */
function firstVector(res) {
  const d = res && res.data;
  if (!Array.isArray(d) || !d.length) return null;
  return Array.isArray(d[0]) ? d[0] : d;
}

async function embedBatch(AI, texts) {
  // Try the batch call first (bge-m3 accepts an array of strings).
  try {
    const res = await AI.run(MODEL, { text: texts });
    const d = res && res.data;
    if (Array.isArray(d) && d.length === texts.length && d.every(Array.isArray)) {
      return d;
    }
  } catch (e) { /* fall through to per-text calls */ }
  const out = [];
  for (const t of texts) {
    const v = firstVector(await AI.run(MODEL, { text: t }));
    if (!v) throw new Error('empty embedding response');
    out.push(v);
  }
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // v225 (security): quota-spending endpoint — signed-in callers only.
  const user = await authedUser(request, env);
  if (!user) return unauthorized();
  // v194 (security): same treatment as the other /api/* proxies — the
  // endpoint spends server-side inference quota and is publicly reachable.
  const limited = rateLimit(request, 'embed', 30, 60 * 1000);
  if (limited) return limited;

  if (!env.AI || typeof env.AI.run !== 'function') {
    return jsonErr(503, 'embeddings not set up: add a Workers AI binding ' +
      'named AI to this Pages project (Settings → Functions → ' +
      'Workers AI bindings)');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const texts = body && body.texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) {
    return new Response('bad request', { status: 400 });
  }
  for (const t of texts) {
    if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TEXT_CHARS) {
      return new Response('bad request', { status: 400 });
    }
  }

  let vectors;
  try {
    vectors = await embedBatch(env.AI, texts);
  } catch (e) {
    return jsonErr(502, 'embedding service failed: ' +
      (e && e.message ? String(e.message).slice(0, 200) : 'unknown error'));
  }
  if (!Array.isArray(vectors) || vectors.length !== texts.length ||
      !vectors.every(v => Array.isArray(v) && v.length > 0 &&
        v.every(n => typeof n === 'number' && Number.isFinite(n)))) {
    return jsonErr(502, 'embedding service returned an unexpected shape');
  }
  return new Response(JSON.stringify({ vectors }),
    { headers: { 'Content-Type': 'application/json' } });
}
