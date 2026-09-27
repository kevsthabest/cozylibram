// Cloudflare Pages Function serving GET /config.js
//
// File is named config.js.js on purpose: Pages strips only the final ".js",
// so this serves the /config.js route the app already requests (index.html).
// Reads secrets from Pages environment variables — never commit them.
//
// Required env vars (Pages dashboard → Settings → Environment variables):
//   HARDCOVER_TOKEN, GOOGLE_BOOKS_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
//
// Mirrors server.py's /config.js payload: window.SPICY_CONFIG = {...}

export async function onRequest(context) {
  const env = context.env || {};
  const payload = {};

  const hcToken = (env.HARDCOVER_TOKEN || '').trim();
  if (hcToken) payload.hardcoverToken = hcToken;

  const gbKey = (env.GOOGLE_BOOKS_KEY || '').trim();
  if (gbKey) payload.googleBooksKey = gbKey;

  const sbUrl = (env.SUPABASE_URL || '').trim();
  const sbKey = (env.SUPABASE_ANON_KEY || '').trim();
  if (sbUrl && sbKey) {
    payload.supabaseUrl = sbUrl;
    payload.supabaseAnonKey = sbKey;
  }

  return new Response('window.SPICY_CONFIG = ' + JSON.stringify(payload) + ';', {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Same as server.py: never cache — secrets rotate and perms change.
      'Cache-Control': 'no-store',
    },
  });
}
