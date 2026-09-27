// Cloudflare Pages Function serving GET /config.js
//
// File is named config.js.js on purpose: Pages strips only the final ".js",
// so this serves the /config.js route the app already requests (index.html).
//
// Since v89 this carries NO secrets — only capability flags. The Hardcover
// token and Google Books key live in Pages environment variables and are
// attached server-side by the /api/hardcover and /api/gbooks proxy Functions,
// so there is nothing here worth stealing and no Cloudflare Access allowlist
// is needed to keep the site private-ish. (The Supabase anon key is public by
// design; row-level security is the boundary there.)

export async function onRequest(context) {
  const env = context.env || {};
  const payload = {
    hardcover: !!(env.HARDCOVER_TOKEN || '').trim(),
    gbooks: !!(env.GOOGLE_BOOKS_KEY || '').trim(),
  };

  const sbUrl = (env.SUPABASE_URL || '').trim();
  const sbKey = (env.SUPABASE_ANON_KEY || '').trim();
  if (sbUrl && sbKey) {
    payload.supabaseUrl = sbUrl;
    payload.supabaseAnonKey = sbKey;
  }

  return new Response('window.SPICY_CONFIG = ' + JSON.stringify(payload) + ';', {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Same as server.py: never cache — flags change when env vars change.
      'Cache-Control': 'no-store',
    },
  });
}
