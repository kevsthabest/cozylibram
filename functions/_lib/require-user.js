// v225: sign-in gate for every same-origin /api/* Pages Function.
//
// The client sends the Supabase session JWT as `Authorization: Bearer <token>`
// (see apiFetch() in js/050-helpers.js). authedUser() validates that token
// against the Supabase Auth API and returns the user object; anything else
// (missing header, missing env, network error, Supabase 401) returns null.
// It never throws — callers treat null as "reject with 401".
//
// The token regex is intentionally loose: Supabase is the validator, so any
// non-space token is forwarded and judged there.

export async function authedUser(request, env) {
  try {
    const h = (request.headers && request.headers.get('authorization')) || '';
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m) return null;
    const supaUrl = String((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
    const key = (env && (env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY)) || '';
    if (!supaUrl || !key) return null;
    const r = await fetch(supaUrl + '/auth/v1/user', {
      headers: { apikey: key, Authorization: 'Bearer ' + m[1] },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: 'sign-in required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
