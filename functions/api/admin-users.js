// v246: admin-only user management (Observatory → Users).
//
// POST { action: 'delete_user', target_user_id }
//   Fully removes a user: wipes their per-user rows, deletes their
//   user_reports (as reporter or reported), then deletes the auth user via
//   the Auth admin API. The caller must be an app admin; admins and the
//   caller themself can never be deleted through this endpoint.
//
// Auth: the caller's JWT is validated with authedUser(), then admin status
// is checked with the service-role key against app_admins (RLS is bypassed,
// so is_admin()'s auth.uid() wouldn't see the caller).
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (Pages env vars, Kevin-owned).

import { authedUser, unauthorized, forbiddenBanned } from '../_lib/require-user.js';

const PER_USER_TABLES = [
  'analytics_events',
  'banned_users',
  'books',
  'circle_invites',
  'deleted_books',
  'profiles',
  'trope_proposal_votes',
  'trope_votes',
];

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const caller = await authedUser(request, env);
  if (!caller) return unauthorized();
  if (caller.banned) return forbiddenBanned();
  const supaUrl = String((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
  const svcKey = (env && env.SUPABASE_SERVICE_KEY) || '';
  if (!supaUrl || !svcKey) return json(500, { error: 'server misconfigured' });

  const body = await request.json().catch(() => null);
  const action = body && body.action;
  const target = body && String(body.target_user_id || '');
  if (action !== 'delete_user' || !target) return json(400, { error: 'action=delete_user and target_user_id required' });
  if (target === caller.id) return json(400, { error: 'cannot delete your own account here' });

  const svcHeaders = { apikey: svcKey, Authorization: 'Bearer ' + svcKey, 'Content-Type': 'application/json' };
  const rest = (path, opts) => fetch(supaUrl + '/rest/v1/' + path, Object.assign({ headers: svcHeaders }, opts || {}));

  // Caller must be an admin.
  const adm = await rest('app_admins?user_id=eq.' + encodeURIComponent(caller.id) + '&select=user_id');
  if (!adm.ok) return json(500, { error: 'admin check failed' });
  if (!(await adm.json().catch(() => [])).length) return json(403, { error: 'admin only' });

  // Never delete another admin through this endpoint.
  const tgtAdm = await rest('app_admins?user_id=eq.' + encodeURIComponent(target) + '&select=user_id');
  if (tgtAdm.ok && (await tgtAdm.json().catch(() => [])).length)
    return json(400, { error: 'cannot delete an admin account' });

  // 1. Wipe per-user rows.
  for (const t of PER_USER_TABLES) {
    const r = await rest(t + '?user_id=eq.' + encodeURIComponent(target), { method: 'DELETE' });
    if (!r.ok) return json(500, { error: 'wipe failed on ' + t });
  }
  // circle_links uses requester_id / addressee_id instead of user_id.
  for (const col of ['requester_id', 'addressee_id']) {
    const r = await rest('circle_links?' + col + '=eq.' + encodeURIComponent(target), { method: 'DELETE' });
    if (!r.ok) return json(500, { error: 'wipe failed on circle_links' });
  }
  // user_reports references the target as reporter or reported.
  for (const col of ['reporter_id', 'reported_user_id']) {
    const r = await rest('user_reports?' + col + '=eq.' + encodeURIComponent(target), { method: 'DELETE' });
    if (!r.ok) return json(500, { error: 'wipe failed on user_reports' });
  }

  // 2. Delete the auth user itself.
  const del = await fetch(supaUrl + '/auth/v1/admin/users/' + encodeURIComponent(target), {
    method: 'DELETE',
    headers: svcHeaders,
  });
  if (!del.ok) {
    const detail = await del.text().catch(() => '');
    return json(500, { error: 'auth deletion failed', detail: detail.slice(0, 200) });
  }
  return json(200, { ok: true });
}
