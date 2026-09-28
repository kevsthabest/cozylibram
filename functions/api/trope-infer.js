// Cloudflare Pages Function: POST /api/trope-infer
//
// Forwards a trope-tagging chat-completions request to the configured LLM
// provider with the server-side API key attached. The key, model, and base
// URL live in Pages environment variables (TROPE_API_KEY, TROPE_MODEL,
// TROPE_PROVIDER, TROPE_BASE_URL) — the browser never sees them, and the
// client cannot choose the provider or endpoint (that would be SSRF).
//
// Supported providers (all speak the OpenAI chat-completions wire format):
//   openrouter (default), gemini, groq, ollama, custom (needs TROPE_BASE_URL).
//
// Guards: POST only, JSON body with a small `messages` array of
// role/content objects (max 20 messages, 20k chars each), max_tokens
// clamped to 100..4000. The upstream HTTP status is forwarded untouched
// so the client's 401/403/429 handling keeps working.

const PROVIDER_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1',
};

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 20000;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const provider = ((env.TROPE_PROVIDER || 'openrouter').trim().toLowerCase());
  const model = (env.TROPE_MODEL || '').trim();
  const key = (env.TROPE_API_KEY || '').trim();
  const baseUrl = ((env.TROPE_BASE_URL || '').trim().replace(/\/+$/, '')) ||
    PROVIDER_URLS[provider] || '';

  if (!key || !model || !baseUrl) {
    return new Response(
      JSON.stringify({ error: 'trope inference not configured on this server' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

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
