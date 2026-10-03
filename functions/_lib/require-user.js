// v225: sign-in gate for every same-origin /api/* Pages Function.
//
// The client sends the Supabase session JWT as `Authorization: Bearer <token>`
// (see apiFetch() in js/050-helpers.js). authedUser() validates that token
// against the Supabase Auth API and returns the user object; anything else
// (missing header, missing env, network error, Supabase 401) returns null.
// It never throws — callers treat null as "reject with 401".
//
// v246: banned users are rejected with 403. The ban lookup runs with the
// caller's own JWT so the "banned_users: users see own" RLS policy applies —
// no service key needed. A failed lookup fails open (returns the user); the
// client-side sign-out check is the other enforcement point.
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
    if (!u || !u.id) return null;
    // v246: banned users are rejected with 403. The ban lookup runs with the
    // caller's own JWT so the "banned_users: users see own" RLS policy applies
    // — no service key needed. It has a short timeout and fails open (returns
    // the user); the client-side sign-out check is the other enforcement point.
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, 4000);
      let b;
      try {
        b = await fetch(supaUrl + '/rest/v1/banned_users?user_id=eq.' + encodeURIComponent(u.id) + '&select=user_id', {
          headers: { apikey: key, Authorization: 'Bearer ' + m[1] },
          signal: ctl.signal,
        });
      } finally { clearTimeout(timer); }
      if (b.ok) {
        const rows = await b.json().catch(() => []);
        if (rows && rows.length) return Object.assign({}, u, { banned: true });
      }
    } catch { /* fail open — client-side check still applies */ }
    return u;
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

export function forbiddenBanned() {
  return new Response(JSON.stringify({ error: 'account suspended' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
