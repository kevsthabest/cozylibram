import { rateLimit } from '../_lib/rate-limit.js';
import { authedUser, unauthorized, forbiddenBanned } from '../_lib/require-user.js';

// Cloudflare Pages Function: POST /api/trope-infer
//
// Forwards a trope-tagging chat-completions request to the configured LLM
// provider with the server-side API key attached. The key, model, and base
// URL live in Pages environment variables (TROPE_API_KEY, TROPE_MODEL,
// TROPE_PROVIDER, TROPE_BASE_URL) — the browser never sees them, and the
// client cannot choose the provider or endpoint (that would be SSRF).
//
// v160: the client may NAME a provider + model (the Trope Lab picker), but
// it cannot choose the endpoint: the provider must be in the fixed
// PROVIDER_URLS allowlist below (custom needs the server-side
// TROPE_BASE_URL), and the key comes from TROPE_KEY_<PROVIDER>, falling
// back to TROPE_API_KEY when the provider is the env default. Unset =
// the env defaults, exactly as before.
//
// Supported providers (all speak the OpenAI chat-completions wire format):
//   openrouter (default), gemini, groq, ollama, custom (needs TROPE_BASE_URL).
//
// Guards: POST only, JSON body with a small `messages` array of
// role/content objects (max 20 messages, 20k chars each), max_tokens
// clamped to 100..4000, provider/model validated when supplied. The
// upstream HTTP status is forwarded untouched so the client's
// 401/403/429 handling keeps working.

const PROVIDER_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1',
};

/* v160: the model name travels inside the upstream JSON body, so a plain
   identifier charset is plenty — and keeps it from smuggling anything. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$/;

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 20000;

const jsonErr = (status, error) => new Response(JSON.stringify({ error }),
  { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // v225 (security): quota-spending endpoint — signed-in callers only.
  const user = await authedUser(request, env);
  if (!user) return unauthorized();
  if (user.banned) return forbiddenBanned(); // v246: suspended accounts
  // v194 (security): unauthenticated internet-facing LLM spend — cap it.
  const limited = rateLimit(request, 'trope-infer', 30, 60 * 1000);
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return new Response('bad request', { status: 400 });
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object' ||
        !['system', 'user', 'assistant'].includes(m.role) ||
        typeof m.content !== 'string' || m.content.length > MAX_CONTENT_CHARS) {
      return new Response('bad request', { status: 400 });
    }
  }
  let maxTokens = parseInt(body.max_tokens, 10);
  if (!Number.isFinite(maxTokens)) maxTokens = 1200;
  maxTokens = Math.min(4000, Math.max(100, maxTokens));

  /* v160: optional client-chosen provider + model. They must arrive as a
     pair; the provider is allowlisted and the key is always server-side. */
  const envProvider = (env.TROPE_PROVIDER || 'openrouter').trim().toLowerCase();
  const reqProvider = (body && typeof body.provider === 'string')
    ? body.provider.trim().toLowerCase() : '';
  const reqModel = (body && typeof body.model === 'string')
    ? body.model.trim() : '';
  let provider = envProvider;
  let model = (env.TROPE_MODEL || '').trim();
  if (reqProvider || reqModel) {
    if (!reqProvider || !reqModel) return new Response('bad request', { status: 400 });
    if (reqProvider !== 'custom' &&
        !Object.prototype.hasOwnProperty.call(PROVIDER_URLS, reqProvider)) {
      return new Response('bad request', { status: 400 });
    }
    if (!MODEL_RE.test(reqModel)) return new Response('bad request', { status: 400 });
    provider = reqProvider;
    model = reqModel;
  }
  /* Per-provider key, falling back to the default TROPE_API_KEY when the
     chosen provider is the env default (backward compatible). */
  const key = ((env['TROPE_KEY_' + provider.toUpperCase()] || '').trim()) ||
    (provider === envProvider ? (env.TROPE_API_KEY || '').trim() : '');
  /* No client override: keep the historical resolution (an explicit
     TROPE_BASE_URL wins). With an override, custom uses TROPE_BASE_URL
     and every other provider uses its fixed allowlist URL. */
  const explicitBase = (env.TROPE_BASE_URL || '').trim().replace(/\/+$/, '');
  const baseUrl = reqProvider
    ? (provider === 'custom' ? explicitBase : (PROVIDER_URLS[provider] || ''))
    : (explicitBase || PROVIDER_URLS[provider] || '');

  if (!key) {
    return jsonErr(503, 'no API key configured for provider \'' + provider +
      '\' (set TROPE_KEY_' + provider.toUpperCase() + ')');
  }
  if (!model || !baseUrl) {
    return jsonErr(503, 'trope inference not configured on this server');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + key,
    'User-Agent': 'CozyLibram/1.0 trope-proxy',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://cozylibram.pages.dev';
    headers['X-Title'] = 'Cozy Libram';
  }

  let upstream;
  /* v156: request low reasoning effort from OpenRouter — trope tagging is
     a classification task, and free reasoning models can otherwise burn
     the whole token budget on chain-of-thought (finish_reason: length),
     leaving no room for the JSON answer. Other providers ignore the
     extra field, so it is only sent for OpenRouter. */
  const upstreamBody = {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature: 0,
    max_tokens: maxTokens,
  };
  if (provider === 'openrouter') upstreamBody.reasoning = { effort: 'low' };
  try {
    upstream = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    return new Response('upstream fetch failed', { status: 502 });
  }

  const data = await upstream.arrayBuffer();
  const outHeaders = { 'Content-Type': 'application/json' };
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) outHeaders['Retry-After'] = retryAfter;
  /* v156: surface truncation as a distinct, recoverable signal. The client
     retries a truncated response with a bigger token budget instead of
     trying to parse cut-off JSON. */
  if (upstream.status === 200) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data));
      const fr = parsed && parsed.choices && parsed.choices[0] &&
        parsed.choices[0].finish_reason;
      if (fr === 'length') {
        return new Response(JSON.stringify({ error: 'truncated' }),
          { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
    } catch { /* not JSON — forward untouched */ }
  }
  return new Response(data, { status: upstream.status, headers: outHeaders });
}
