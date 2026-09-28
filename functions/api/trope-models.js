// Cloudflare Pages Function: GET /api/trope-models?provider=<id>
//
// Returns the live model list for a trope-inference provider so the Trope
// Lab picker can offer real, currently-available models instead of
// hardcoded suggestions (which rot — e.g. gemini-2.0-flash was retired).
//
// The provider's API key stays server-side: it is resolved exactly like
// /api/trope-infer (TROPE_KEY_<PROVIDER>, falling back to TROPE_API_KEY
// when the provider is the env default). The response carries only model
// ids and display names — never key material.
//
// Guards: GET only. `provider` must name a provider in the MODELS_URLS
// allowlist below, so the client cannot steer the fetch anywhere else
// (no SSRF). `custom` has no listable endpoint and `ollama` lives on the
// user's LAN, unreachable from the Pages edge — both answer 400 with a
// clear message, and the picker falls back to its suggestion list.
// OpenRouter's /models endpoint is public, so it works even without a key;
// gemini/groq need theirs (503 when missing, same wording as trope-infer).

const MODELS_URLS = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
  groq: 'https://api.groq.com/openai/v1/models',
};

const jsonErr = (status, error) => new Response(JSON.stringify({ error }),
  { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }

  let provider = '';
  try {
    provider = (new URL(request.url).searchParams.get('provider') || '')
      .trim().toLowerCase();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (!Object.prototype.hasOwnProperty.call(MODELS_URLS, provider)) {
    return jsonErr(400,
      provider === 'custom'
        ? 'custom providers have no model list — type the model name'
        : provider === 'ollama'
          ? 'ollama runs on your own machine, unreachable from this server — type the model name'
          : 'unknown provider');
  }

  /* Same key resolution as /api/trope-infer. OpenRouter's list is public,
     so it works keyless; gemini/groq need a key. */
  const envProvider = (env.TROPE_PROVIDER || 'openrouter').trim().toLowerCase();
  const key = ((env['TROPE_KEY_' + provider.toUpperCase()] || '').trim()) ||
    (provider === envProvider ? (env.TROPE_API_KEY || '').trim() : '');
  if (!key && provider !== 'openrouter') {
    return jsonErr(503, 'no API key configured for provider \'' + provider +
      '\' (set TROPE_KEY_' + provider.toUpperCase() + ')');
  }

  let upstream;
  try {
    const headers = { 'User-Agent': 'CozyLibram/1.0 trope-proxy' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    upstream = await fetch(MODELS_URLS[provider], { headers });
  } catch {
    return new Response('upstream fetch failed', { status: 502 });
  }
  if (!upstream.ok) {
    return jsonErr(502, 'provider returned HTTP ' + upstream.status +
      ' for the model list');
  }
  let parsed;
  try {
    parsed = await upstream.json();
  } catch {
    return jsonErr(502, 'provider returned an unparsable model list');
  }
  /* Google's OpenAI-compat list returns canonical ids like
     "models/gemini-2.5-flash"; the chat endpoint takes the short name, so
     strip the prefix (and dedupe) before sending the list down. */
  const seen = new Set();
  const rows = [];
  for (const m of (parsed && Array.isArray(parsed.data) ? parsed.data : [])) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const id = m.id.startsWith('models/') ? m.id.slice('models/'.length) : m.id;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name: typeof m.name === 'string' && m.name ? m.name : id });
    if (rows.length >= 500) break;
  }
  return new Response(JSON.stringify({ provider, models: rows }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
