// Pages Functions tests: /config.js, /cover-proxy, /api/hardcover, /api/gbooks.
// The function files are ESM; load them with dynamic import.
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const configPayload = async (res) =>
  JSON.parse((await res.text()).replace(/^window\.SPICY_CONFIG = /, '').replace(/;$/, ''));

async function main() {
  const configFn = await import(path.resolve(__dirname, '../functions/config.js.js'));
  const proxyFn = await import(path.resolve(__dirname, '../functions/cover-proxy.js'));
  const ccFn = await import(path.resolve(__dirname, '../functions/api/cache-cover.js'));
  const hcFn = await import(path.resolve(__dirname, '../functions/api/hardcover.js'));
  const gbFn = await import(path.resolve(__dirname, '../functions/api/gbooks/[[path]].js'));
  const ruFn = await import(path.resolve(__dirname, '../functions/_lib/require-user.js'));
  const ctx = (env, url) => ({ env, request: new Request(url || 'https://app.test/') });

  // ---- /config.js: flags only, no secrets ----
  const full = await configFn.onRequest(ctx(
    { HARDCOVER_TOKEN: 'hc1', GOOGLE_BOOKS_KEY: 'gb1', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' },
    'https://app.test/config.js'));
  const fullText = await full.text();
  ok('config: 200', full.status === 200);
  ok('config: js content type', (full.headers.get('Content-Type') || '').includes('javascript'));
  ok('config: no-store', (full.headers.get('Cache-Control') || '').includes('no-store'));
  ok('config: SPICY_CONFIG global', fullText.startsWith('window.SPICY_CONFIG = '));
  const payload = JSON.parse(fullText.replace(/^window\.SPICY_CONFIG = /, '').replace(/;$/, ''));
  ok('config: hardcover flag true', payload.hardcover === true);
  ok('config: gbooks flag true', payload.gbooks === true);
  ok('config: no secrets in payload',
    !('hardcoverToken' in payload) && !('googleBooksKey' in payload) &&
    fullText.indexOf('hc1') === -1 && fullText.indexOf('gb1') === -1);
  ok('config: supabase pair', payload.supabaseUrl === 'https://x.supabase.co' && payload.supabaseAnonKey === 'sb1');

  const partial = await configPayload(await configFn.onRequest(ctx({ HARDCOVER_TOKEN: '  hc2  ' }, 'https://app.test/config.js')));
  ok('config: only hardcover flag when only token set', partial.hardcover === true && partial.gbooks === false);
  ok('config: supabase omitted when unset', !('supabaseUrl' in partial));
  const empty = await configPayload(await configFn.onRequest(ctx({}, 'https://app.test/config.js')));
  ok('config: empty env -> both flags false', empty.hardcover === false && empty.gbooks === false);

  // ---- /api/hardcover ----
  const realFetch = globalThis.fetch;
  const seenHc = [];
  const AUTH_URL = 'https://x.supabase.co/auth/v1/user';
  const authMock = (init) => {
    const tok = init && init.headers && init.headers.Authorization;
    return tok === 'Bearer good-token'
      ? new Response(JSON.stringify({ id: 'u1' }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 401 });
  };
  globalThis.fetch = async (url, init) => {
    seenHc.push({ url, init });
    if (String(url) === AUTH_URL) return authMock(init);
    if (url === 'https://api.hardcover.app/v1/graphql' &&
        init.headers['Authorization'] === 'Bearer realtoken') {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ errors: [{ message: 'blocked' }] }), { status: 403 });
  };
  // SEC-03: the proxy allowlists the query shapes the app actually sends.
  const HC_QUERY = 'query { search(query: "x", query_type: "Book", per_page: 5) { results } }';
  // v225: every /api/* call carries a session JWT; the env needs the Supabase pair.
  const hcEnv = (env) => Object.assign(
    { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' }, env);
  const hcCtx = (env, body) => ({
    env: hcEnv(env),
    request: new Request('https://app.test/api/hardcover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer good-token' },
      body: JSON.stringify(body === undefined ? { query: HC_QUERY } : body),
    }),
  });

  const hcOk = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 'realtoken' }));
  ok('hc: 200 on success', hcOk.status === 200);
  const hcUpstream = seenHc.find((c) => String(c.url) === 'https://api.hardcover.app/v1/graphql');
  ok('hc: token attached server-side, never echoed',
    !!hcUpstream && hcUpstream.init.headers['Authorization'] === 'Bearer realtoken' &&
    (await hcOk.text()).indexOf('realtoken') === -1);
  ok('hc: query forwarded in body',
    !!hcUpstream && JSON.parse(hcUpstream.init.body).query === HC_QUERY);
  // v225: the sign-in gate.
  ok('hc: session validated against Supabase auth',
    seenHc.some((c) => String(c.url) === AUTH_URL &&
      c.init.headers.Authorization === 'Bearer good-token'));
  const hcNoAuth = await hcFn.onRequest({
    env: hcEnv({ HARDCOVER_TOKEN: 't' }),
    request: new Request('https://app.test/api/hardcover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: HC_QUERY }),
    }),
  });
  ok('hc: missing auth header -> 401', hcNoAuth.status === 401);
  const hcBadTok = await hcFn.onRequest({
    env: hcEnv({ HARDCOVER_TOKEN: 't' }),
    request: new Request('https://app.test/api/hardcover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bad-token' },
      body: JSON.stringify({ query: HC_QUERY }),
    }),
  });
  ok('hc: invalid session token -> 401', hcBadTok.status === 401);

  const hcGet = await hcFn.onRequest({ env: { HARDCOVER_TOKEN: 't' }, request: new Request('https://app.test/api/hardcover') });
  ok('hc: GET rejected (405)', hcGet.status === 405);
  const hcBad = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' }, { nope: 1 }));
  ok('hc: missing query -> 400', hcBad.status === 400);
  const hcBig = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' }, { query: 'x'.repeat(9000) }));
  ok('hc: oversized query -> 400', hcBig.status === 400);
  const hcNone = await hcFn.onRequest(hcCtx({}, { query: HC_QUERY }));
  ok('hc: no token -> 503', hcNone.status === 503);
  const hcUp = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 'wrong' }, { query: HC_QUERY }));
  ok('hc: upstream 403 forwarded', hcUp.status === 403);
  // SEC-03 allowlist: anything outside the app's query shapes is rejected.
  const hcMut = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' },
    { query: 'mutation { update_books(_set: {title: "x"}) { affected_rows } }' }));
  ok('hc: mutation -> 403', hcMut.status === 403);
  const hcIntro = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' },
    { query: 'query { __schema { types { name } } }' }));
  ok('hc: introspection -> 403', hcIntro.status === 403);
  const hcRoot = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' },
    { query: 'query { users { id email } }' }));
  ok('hc: unknown root -> 403', hcRoot.status === 403);
  const hcNamed = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' },
    { query: 'query Foo { books { id } }' }));
  ok('hc: named operation -> 403', hcNamed.status === 403);
  const hcMulti = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' },
    { query: HC_QUERY + ' mutation { delete_books { affected_rows } }' }));
  ok('hc: smuggled second operation -> 403', hcMulti.status === 403);

  // ---- /api/gbooks ----
  const seenGb = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === AUTH_URL) return authMock(init);
    if (String(url).startsWith('https://x.supabase.co/rest/v1/banned_users'))
      return new Response(JSON.stringify([]), { status: 200 }); // v246: ban check — caller clean
    seenGb.push(url);
    return new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const gbCtx = (env, method) => ({
    env: hcEnv(env),
    params: { path: ['books', 'v1', 'volumes'] },
    request: new Request('https://app.test/api/gbooks/books/v1/volumes?q=isbn%3A123&key=CLIENTKEY',
      { method: method || 'GET', headers: { 'Authorization': 'Bearer good-token' } }),
  });

  const gbOk = await gbFn.onRequest(gbCtx({ GOOGLE_BOOKS_KEY: 'serverkey' }));
  ok('gb: 200', gbOk.status === 200);
  ok('gb: server key attached', seenGb[0].indexOf('key=serverkey') !== -1);
  ok('gb: client key stripped', seenGb[0].indexOf('CLIENTKEY') === -1);
  ok('gb: query preserved', seenGb[0].indexOf('q=isbn') !== -1);
  ok('gb: targets googleapis', seenGb[0].indexOf('https://www.googleapis.com/books/v1/volumes') === 0);
  // v225: the sign-in gate.
  const gbNoAuth = await gbFn.onRequest({
    env: hcEnv({ GOOGLE_BOOKS_KEY: 'serverkey' }),
    params: { path: ['books', 'v1', 'volumes'] },
    request: new Request('https://app.test/api/gbooks/books/v1/volumes?q=isbn%3A123'),
  });
  ok('gb: missing auth header -> 401', gbNoAuth.status === 401);

  const gbAnon = await gbFn.onRequest(gbCtx({}));
  ok('gb: forwards anonymously when no key', gbAnon.status === 200 && seenGb[1].indexOf('key=') === -1);

  const gbEvil = await gbFn.onRequest({
    env: hcEnv({ GOOGLE_BOOKS_KEY: 'serverkey' }),
    params: { path: ['books', 'v1', 'mylibrary', 'bookshelves'] },
    request: new Request('https://app.test/api/gbooks/books/v1/mylibrary/bookshelves',
      { headers: { 'Authorization': 'Bearer good-token' } }),
  });
  ok('gb: non-volumes path -> 404', gbEvil.status === 404);
  const gbPost = await gbFn.onRequest(gbCtx({ GOOGLE_BOOKS_KEY: 'k' }, 'POST'));
  ok('gb: POST rejected (405)', gbPost.status === 405);

  globalThis.fetch = realFetch;

  // ---- /api/cache-cover (v216: canonical cover cache) ----
  const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const BIG = new Uint8Array(5 * 1024 * 1024);
  const storageCalls = [];
  const fetchedUpstream = []; // v216 follow-up: records upstream fetch URLs to prove the http→https upgrade
  let storageMode = 'ok'; // 'ok' | 'duplicate'
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === AUTH_URL) return authMock(init); // v225: sign-in gate
    if (u === 'https://covers.openlibrary.org/b/id/1-L.jpg') {
      return new Response(IMG, { headers: { 'Content-Type': 'image/png' } });
    }
    if (u.startsWith('https://books.google.com/')) {
      fetchedUpstream.push(u);
      return new Response(IMG, { headers: { 'Content-Type': 'image/png' } });
    }
    if (u === 'https://covers.openlibrary.org/b/id/big.jpg') {
      return new Response(BIG, { headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (u === 'https://covers.openlibrary.org/b/id/notimage') {
      return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (u.startsWith('https://x.supabase.co/storage/v1/object/covers/')) {
      storageCalls.push({ url: u, headers: init.headers });
      if (storageMode === 'duplicate') {
        return new Response(JSON.stringify({
          statusCode: '400', error: 'Duplicate', message: 'The resource already exists',
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }
    throw new Error('network down');
  };
  const ccEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'svc1' };
  const ccReq = (body, method) => ({
    env: ccEnv,
    request: new Request('https://app.test/api/cache-cover', Object.assign(
      { method: method || 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer good-token' } },
      (method || 'POST') === 'GET' ? {} : {
        body: body === undefined
          ? JSON.stringify({ url: 'https://covers.openlibrary.org/b/id/1-L.jpg' })
          : body,
      })),
  });
  const ccGet = await ccFn.onRequest(ccReq(undefined, 'GET'));
  ok('cc: GET rejected (405)', ccGet.status === 405);
  // v225: the sign-in gate.
  const ccNoAuth = await ccFn.onRequest({
    env: ccEnv,
    request: new Request('https://app.test/api/cache-cover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://covers.openlibrary.org/b/id/1-L.jpg' }),
    }),
  });
  ok('cc: missing auth header -> 401', ccNoAuth.status === 401);
  const ccBadTok = await ccFn.onRequest({
    env: ccEnv,
    request: new Request('https://app.test/api/cache-cover', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bad-token' },
      body: JSON.stringify({ url: 'https://covers.openlibrary.org/b/id/1-L.jpg' }),
    }),
  });
  ok('cc: invalid session token -> 401', ccBadTok.status === 401);
  const ccNoEnv = await ccFn.onRequest({
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' },
    request: new Request('https://app.test/api/cache-cover', {
      method: 'POST', headers: { 'Authorization': 'Bearer good-token' },
    }),
  });
  ok('cc: missing service key -> 503', ccNoEnv.status === 503);
  const ccHttp = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'http://evil.test/x.jpg' })));
  ok('cc: http url -> 400', ccHttp.status === 400);
  // v216 follow-up: allowlisted http hosts are upgraded to https, non-allowlisted http still rejected
  const ccHttpGb = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'http://books.google.com/books/content?id=abc&printsec=frontcover&img=1' })));
  const ccHttpGbBody = await ccHttpGb.json();
  ok('cc: allowlisted http upgraded to https (200)', ccHttpGb.status === 200);
  ok('cc: upgraded fetch went out over https',
    fetchedUpstream.length === 1 && fetchedUpstream[0].startsWith('https://books.google.com/'));
  ok('cc: upgraded url returns the canonical bucket URL',
    /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/covers\/[0-9a-f]{64}\.png$/.test(ccHttpGbBody.coverUrl || ''));
  const ccHttpEvil = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'http://evil.example.com/x.jpg' })));
  ok('cc: non-allowlisted http still rejected (400)', ccHttpEvil.status === 400);
  storageCalls.length = 0; // the upgrade test above uploaded once; reset for the x-upsert assertions below
  const ccBadBody = await ccFn.onRequest({
    env: ccEnv,
    request: new Request('https://app.test/api/cache-cover', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer good-token' }, body: 'not json{',
    }),
  });
  ok('cc: unparseable body -> 400', ccBadBody.status === 400);
  const ccEvil = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'https://169.254.169.254/x.jpg' })));
  ok('cc: unlisted host rejected (SSRF, 403)', ccEvil.status === 403);
  const ccEvil2 = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'https://evil.example.com/x.jpg' })));
  ok('cc: unknown host rejected (403)', ccEvil2.status === 403);

  const ccOk = await ccFn.onRequest(ccReq());
  const ccBody = await ccOk.json();
  ok('cc: 200 on success', ccOk.status === 200);
  ok('cc: returns the public bucket URL',
    /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/covers\/[0-9a-f]{64}\.png$/.test(ccBody.coverUrl));
  ok('cc: upload used x-upsert false (dedup by construction)',
    storageCalls.length === 1 && storageCalls[0].headers['x-upsert'] === 'false');
  ok('cc: service key attached server-side, never echoed in the response',
    storageCalls[0].headers['Authorization'] === 'Bearer svc1' &&
    storageCalls[0].headers['apikey'] === 'svc1' &&
    JSON.stringify(ccBody).indexOf('svc1') === -1);

  // same bytes -> same object key (content-addressed)
  const ccOk2 = await ccFn.onRequest(ccReq());
  const ccBody2 = await ccOk2.json();
  ok('cc: same bytes map to the same canonical URL (dedup)',
    ccOk2.status === 200 && ccBody2.coverUrl === ccBody.coverUrl);

  // duplicate-object error from Storage is the dedup hit, not a failure
  storageMode = 'duplicate';
  const ccDup = await ccFn.onRequest(ccReq());
  const ccDupBody = await ccDup.json();
  ok('cc: duplicate upload still 200s with the canonical URL',
    ccDup.status === 200 && ccDupBody.coverUrl === ccBody.coverUrl);
  storageMode = 'ok';

  const ccNotImg = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'https://covers.openlibrary.org/b/id/notimage' })));
  ok('cc: non-image content-type -> 502', ccNotImg.status === 502);
  const ccBig = await ccFn.onRequest(ccReq(JSON.stringify({ url: 'https://covers.openlibrary.org/b/id/big.jpg' })));
  ok('cc: over-4MB image -> 502', ccBig.status === 502);
  // ---- functions/_lib/require-user (v225) ----
  // Reuse the hardcover fetch mock shape: auth URL answers from the token.
  globalThis.fetch = async (url, init) => {
    if (String(url) === AUTH_URL) return authMock(init);
    throw new Error('unexpected upstream ' + url);
  };
  const ruReq = (auth) => new Request('https://app.test/api/x', auth === undefined
    ? {}
    : { headers: { 'Authorization': auth } });
  const ruEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' };
  const ruUser = await ruFn.authedUser(ruReq('Bearer good-token'), ruEnv);
  ok('require-user: valid session -> user object', !!ruUser && ruUser.id === 'u1');
  ok('require-user: missing header -> null',
    await ruFn.authedUser(ruReq(), ruEnv) === null);
  ok('require-user: malformed header -> null',
    await ruFn.authedUser(ruReq('Token abc'), ruEnv) === null);
  ok('require-user: Supabase 401 -> null',
    await ruFn.authedUser(ruReq('Bearer bad-token'), ruEnv) === null);
  ok('require-user: missing env -> null',
    await ruFn.authedUser(ruReq('Bearer good-token'), {}) === null);
  ok('require-user: service key fallback works',
    !!await ruFn.authedUser(ruReq('Bearer good-token'),
      { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'svc1' }));
  const ruDenied = ruFn.unauthorized();
  ok('require-user: unauthorized() is a 401 JSON',
    ruDenied.status === 401 &&
    (ruDenied.headers.get('Content-Type') || '').includes('application/json') &&
    JSON.parse(await ruDenied.text()).error === 'sign-in required');

  // ---- v246: banned users are rejected ----
  // authMock answers u1 for 'Bearer good1' and 'Bearer banned1'.
  const banAuthMock = (init) => {
    const tok = init && init.headers && init.headers.Authorization;
    return tok === 'Bearer good-token' || tok === 'Bearer banned-token'
      ? new Response(JSON.stringify({ id: 'u1' }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 401 });
  };
  globalThis.fetch = async (url, init) => {
    if (String(url) === AUTH_URL) return banAuthMock(init);
    if (String(url).startsWith('https://x.supabase.co/rest/v1/banned_users')) {
      const tok = init && init.headers && init.headers.Authorization;
      const banned = tok === 'Bearer banned-token';
      return new Response(JSON.stringify(banned ? [{ user_id: 'u1' }] : []), { status: 200 });
    }
    throw new Error('unexpected upstream ' + url);
  };
  const bannedUser = await ruFn.authedUser(ruReq('Bearer banned-token'), ruEnv);
  ok('require-user: banned session -> user flagged banned',
    !!bannedUser && bannedUser.id === 'u1' && bannedUser.banned === true);
  const cleanUser = await ruFn.authedUser(ruReq('Bearer good-token'), ruEnv);
  ok('require-user: clean session -> user not flagged',
    !!cleanUser && cleanUser.id === 'u1' && !cleanUser.banned);
  const ruBanned = ruFn.forbiddenBanned();
  ok('require-user: forbiddenBanned() is a 403 JSON',
    ruBanned.status === 403 &&
    (ruBanned.headers.get('Content-Type') || '').includes('application/json') &&
    JSON.parse(await ruBanned.text()).error === 'account suspended');
  // Ban lookup failure fails open (the client-side sign-out is the other check).
  globalThis.fetch = async (url, init) => {
    if (String(url) === AUTH_URL) return banAuthMock(init);
    throw new Error('ban table unreachable');
  };
  const failOpenUser = await ruFn.authedUser(ruReq('Bearer banned-token'), ruEnv);
  ok('require-user: ban lookup failure fails open',
    !!failOpenUser && failOpenUser.id === 'u1' && !failOpenUser.banned);
  // End-to-end: a banned caller gets 403 from a quota endpoint.
  globalThis.fetch = async (url, init) => {
    if (String(url) === AUTH_URL) return banAuthMock(init);
    if (String(url).startsWith('https://x.supabase.co/rest/v1/banned_users')) {
      const tok = init && init.headers && init.headers.Authorization;
      return new Response(JSON.stringify(tok === 'Bearer banned-token' ? [{ user_id: 'u1' }] : []), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
  const hcBannedCtx = {
    env: hcEnv({ HARDCOVER_TOKEN: 'realtoken' }),
    request: new Request('https://app.test/api/hardcover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer banned-token' },
      body: JSON.stringify({ query: HC_QUERY }),
    }),
  };
  const hcBanned = await hcFn.onRequest(hcBannedCtx);
  ok('hardcover: banned caller -> 403', hcBanned.status === 403);

  // ---- v246: /api/admin-users (delete_user) ----
  const admFn = await import(path.resolve(__dirname, '../functions/api/admin-users.js'));
  const admCalls = [];
  const ADM_AUTH = 'https://x.supabase.co/auth/v1/user';
  const admFetch = (opts) => async (url, init) => {
    const u = String(url);
    admCalls.push({ url: u, method: (init && init.method) || 'GET' });
    if (u === ADM_AUTH) return new Response(JSON.stringify({ id: opts.caller }), { status: 200 });
    if (u.startsWith('https://x.supabase.co/rest/v1/banned_users'))
      return new Response(JSON.stringify([]), { status: 200 }); // caller not banned
    if (u.startsWith('https://x.supabase.co/rest/v1/app_admins')) {
      const m = /user_id=eq\.([^&]+)/.exec(u);
      const uid = m ? decodeURIComponent(m[1]) : '';
      const isAdmin = (opts.admins || []).indexOf(uid) !== -1;
      return new Response(JSON.stringify(isAdmin ? [{ user_id: uid }] : []), { status: 200 });
    }
    if (u.startsWith('https://x.supabase.co/auth/v1/admin/users?'))
      return new Response(JSON.stringify({ users: [
        { id: 'u1', email: 'a@x.y', created_at: '2026-01-01T00:00:00Z', last_sign_in_at: null },
        { id: 'u2', email: 'b@x.y', created_at: '2026-01-02T00:00:00Z', last_sign_in_at: '2026-02-01T00:00:00Z' },
      ] }), { status: 200 }); // v248: list_users
    if (u.startsWith('https://x.supabase.co/auth/v1/admin/users/'))
      return new Response(JSON.stringify(opts.authDeleteOk === false ? { msg: 'nope' } : {}),
        { status: opts.authDeleteOk === false ? 500 : 200 });
    if ((init && init.method) === 'DELETE')
      return new Response(JSON.stringify([]), { status: 200 }); // wipe
    throw new Error('unexpected upstream ' + u);
  };
  const admEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1', SUPABASE_SERVICE_KEY: 'svc1' };
  const admReq = (body) => new Request('https://app.test/api/admin-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer good-token' },
    body: JSON.stringify(body),
  });
  // Non-admin caller -> 403.
  globalThis.fetch = admFetch({ caller: 'mallory', admins: ['kevin'] });
  const admDenied = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'delete_user', target_user_id: 'victim' }) });
  ok('admin-users: non-admin -> 403', admDenied.status === 403);
  // Admin cannot delete themself.
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin'] });
  const admSelf = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'delete_user', target_user_id: 'kevin' }) });
  ok('admin-users: self-delete refused', admSelf.status === 400);
  // Admin cannot delete another admin.
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin', 'wifey'] });
  const admTarget2 = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'delete_user', target_user_id: 'wifey' }) });
  ok('admin-users: admin target refused', admTarget2.status === 400);
  // Happy path: wipe + auth delete.
  admCalls.length = 0;
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin'] });
  const admOk = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'delete_user', target_user_id: 'victim' }) });
  const admOkJson = JSON.parse(await admOk.text());
  const wiped = ['books', 'profiles', 'deleted_books', 'circle_invites', 'circle_links', 'user_reports', 'banned_users', 'analytics_events', 'trope_votes', 'trope_proposal_votes'];
  ok('admin-users: happy path -> 200 ok', admOk.status === 200 && admOkJson.ok === true);
  ok('admin-users: all per-user tables wiped',
    wiped.every(t => admCalls.some(c => c.method === 'DELETE' && c.url.indexOf('/rest/v1/' + t + '?') !== -1)));
  ok('admin-users: auth user deleted via admin API',
    admCalls.some(c => c.method === 'DELETE' && c.url === 'https://x.supabase.co/auth/v1/admin/users/victim'));
  // Auth deletion failure -> 500.
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin'], authDeleteOk: false });
  const admFail = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'delete_user', target_user_id: 'victim' }) });
  ok('admin-users: auth delete failure -> 500', admFail.status === 500);
  // Missing service key -> 500 misconfigured.
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin'] });
  const admNoKey = await admFn.onRequest({
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' },
    request: admReq({ action: 'delete_user', target_user_id: 'victim' }),
  });
  ok('admin-users: no service key -> 500', admNoKey.status === 500);
  // v248: list_users — admin-only user directory.
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin'] });
  const admList = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'list_users' }) });
  const admListJson = JSON.parse(await admList.text());
  ok('admin-users: list_users -> 200 with the directory',
    admList.status === 200 && Array.isArray(admListJson.users) && admListJson.users.length === 2 &&
    admListJson.users[0].user_id === 'u1' && admListJson.users[0].email === 'a@x.y' &&
    admListJson.users[1].last_sign_in_at === '2026-02-01T00:00:00Z');
  globalThis.fetch = admFetch({ caller: 'mallory', admins: ['kevin'] });
  const admListDenied = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'list_users' }) });
  ok('admin-users: list_users non-admin -> 403', admListDenied.status === 403);
  globalThis.fetch = admFetch({ caller: 'kevin', admins: ['kevin'] });
  const admUnknown = await admFn.onRequest({ env: admEnv, request: admReq({ action: 'nonsense' }) });
  ok('admin-users: unknown action -> 400', admUnknown.status === 400);

  // ---- /api/spine-search (v264) ----
  const ssFn = await import(path.resolve(__dirname, '../functions/api/spine-search.js'));
  const ssEnv = Object.assign({}, admEnv, { TROPE_KEY_GEMINI: 'gk1' });
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';
  const geminiOk = (text) => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://books.example/p/1', title: 'Example Books' } }] } }],
  }), { status: 200 });
  const ssFetch = (opts) => async (url, init) => {
    const u = String(url);
    if (u === ADM_AUTH) return new Response(JSON.stringify({ id: opts.caller || 'kevin' }), { status: 200 });
    if (u.startsWith('https://x.supabase.co/rest/v1/banned_users'))
      return new Response(JSON.stringify([]), { status: 200 });
    if (u.startsWith('https://x.supabase.co/rest/v1/app_admins')) {
      const m = /user_id=eq\.([^&]+)/.exec(u);
      const uid = m ? decodeURIComponent(m[1]) : '';
      const isAdmin = (opts.admins || []).indexOf(uid) !== -1;
      return new Response(JSON.stringify(isAdmin ? [{ user_id: uid }] : []), { status: 200 });
    }
    if (u === GEMINI) {
      if (opts.geminiStatus) return new Response('boom', { status: opts.geminiStatus });
      return geminiOk(opts.geminiText !== undefined ? opts.geminiText : JSON.stringify({ candidates: [
        { image_url: 'https://img.example/spine1.jpg', page_url: 'https://books.example/p/1', note: 'spine visible' },
        { image_url: 'https://img.example/spine1.jpg', page_url: 'https://books.example/p/1', note: 'duplicate' },
        { image_url: 'not a url', note: 'junk' },
        { image_url: 'https://img.example/cover.html', note: 'not an image' },
      ] }));
    }
    throw new Error('unexpected upstream ' + u);
  };
  const ssReq = (body, auth) => new Request('https://app.test/api/spine-search', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth === false ? {} : { Authorization: 'Bearer good' }),
    body: JSON.stringify(body === undefined ? { title: 'Dune', author: 'Frank Herbert' } : body),
  });
  const ssGet = new Request('https://app.test/api/spine-search', { method: 'GET' });
  ok('spine-search: GET -> 405', (await ssFn.onRequest({ env: ssEnv, request: ssGet })).status === 405);
  globalThis.fetch = ssFetch({ caller: 'kevin', admins: ['kevin'] });
  ok('spine-search: no auth -> 401',
    (await ssFn.onRequest({ env: ssEnv, request: ssReq(undefined, false) })).status === 401);
  globalThis.fetch = ssFetch({ caller: 'mallory', admins: ['kevin'] });
  ok('spine-search: non-admin -> 403',
    (await ssFn.onRequest({ env: ssEnv, request: ssReq() })).status === 403);
  globalThis.fetch = ssFetch({ caller: 'kevin', admins: ['kevin'] });
  ok('spine-search: missing title -> 400',
    (await ssFn.onRequest({ env: ssEnv, request: ssReq({ title: '  ' }) })).status === 400);
  const ssRes = await ssFn.onRequest({ env: ssEnv, request: ssReq() });
  const ssJson = await ssRes.json();
  ok('spine-search: 200 with cleaned candidates',
    ssRes.status === 200 && ssJson.candidates.length === 1 &&
    ssJson.candidates[0].image_url === 'https://img.example/spine1.jpg');
  ok('spine-search: grounding sources passed through',
    ssJson.sources.length === 1 && ssJson.sources[0].uri === 'https://books.example/p/1');
  globalThis.fetch = ssFetch({ caller: 'kevin', admins: ['kevin'], geminiStatus: 500 });
  ok('spine-search: upstream 500 -> 502',
    (await ssFn.onRequest({ env: ssEnv, request: ssReq() })).status === 502);
  globalThis.fetch = ssFetch({ caller: 'kevin', admins: ['kevin'], geminiText: 'not json at all https://img.example/a.png' });
  const ssFb = await (await ssFn.onRequest({ env: ssEnv, request: ssReq() })).json();
  ok('spine-search: non-JSON answer falls back to URL scraping',
    ssFb.candidates.length === 1 && ssFb.candidates[0].image_url === 'https://img.example/a.png');
  ok('cleanSpineSearchCandidates caps at 5',
    ssFn.cleanSpineSearchCandidates([1, 2, 3, 4, 5, 6, 7].map(i =>
      ({ image_url: 'https://img.example/' + i + '.jpg' }))).length === 5);

  // ---- /api/spine-search via Brave image search (v268) ----
  // (Google's Custom Search JSON API is closed to new customers, so Brave is
  // the working image-search backend.)
  ok('spineSearchQuery quotes the title', ssFn.spineSearchQuery('Dune', 'Frank Herbert') === '"Dune" Frank Herbert book spine');
  const braveResults = [
    { title: 'Dune spine', url: 'https://books.example/dune', properties: { url: 'https://img.example/spine-a.jpg' } },
    { title: 'dup', url: 'https://books.example/dune2', properties: { url: 'https://img.example/spine-a.jpg' } },
    { title: 'not an image', url: 'https://books.example/x', properties: { url: 'https://img.example/page.html' } },
    { title: 'junk', url: 'https://books.example/y', properties: { url: 'not a url' } },
    { title: 'side view', url: 'https://books.example/z', properties: { url: 'https://img.example/spine-b.png' } },
  ];
  const braveClean = ssFn.cleanSpineBraveCandidates(braveResults);
  ok('cleanSpineBraveCandidates keeps image URLs, dedupes, maps page URL',
    braveClean.length === 2 &&
    braveClean[0].image_url === 'https://img.example/spine-a.jpg' &&
    braveClean[0].page_url === 'https://books.example/dune' &&
    braveClean[0].note === 'Dune spine' &&
    braveClean[1].note === 'side view');
  ok('cleanSpineBraveCandidates caps at 5',
    ssFn.cleanSpineBraveCandidates([1, 2, 3, 4, 5, 6, 7].map(i =>
      ({ properties: { url: 'https://img.example/' + i + '.jpg' } }))).length === 5);
  const BRAVE = 'https://api.search.brave.com/res/v1/images/search';
  const braveFetch = (opts) => async (url, init) => {
    const u = String(url);
    if (u === ADM_AUTH) return new Response(JSON.stringify({ id: 'kevin' }), { status: 200 });
    if (u.startsWith('https://x.supabase.co/rest/v1/app_admins')) return new Response(JSON.stringify([{ user_id: 'kevin' }]), { status: 200 });
    if (u.startsWith('https://x.supabase.co/rest/v1/banned_users')) return new Response(JSON.stringify([]), { status: 200 });
    if (u.startsWith(BRAVE)) {
      if (opts.braveStatus) return new Response('nope', { status: opts.braveStatus });
      if (!u.includes('safesearch=strict') || (init.headers || {})['X-Subscription-Token'] !== 'b1')
        throw new Error('bad Brave request: ' + u);
      return new Response(JSON.stringify({ results: braveResults }), { status: 200 });
    }
    throw new Error('unexpected upstream ' + u);
  };
  const braveEnv = Object.assign({}, admEnv, { BRAVE_SEARCH_API_KEY: 'b1', TROPE_KEY_GEMINI: 'gk1' });
  globalThis.fetch = braveFetch({});
  const braveRes = await ssFn.onRequest({ env: braveEnv, request: ssReq() });
  const braveJson = await braveRes.json();
  ok('spine-search: Brave path returns candidates without touching Gemini',
    braveRes.status === 200 && braveJson.via === 'brave' && braveJson.candidates.length === 2 &&
    braveJson.candidates[0].image_url === 'https://img.example/spine-a.jpg');
  globalThis.fetch = braveFetch({ braveStatus: 401 });
  const brave401 = await (await ssFn.onRequest({ env: braveEnv, request: ssReq() })).json();
  ok('spine-search: Brave 401 -> 502 key message', /key/i.test(brave401.error || ''));
  globalThis.fetch = braveFetch({ braveStatus: 429 });
  ok('spine-search: Brave 429 -> 502',
    (await ssFn.onRequest({ env: braveEnv, request: ssReq() })).status === 502);

  // ---- geminiFetch retry (v265) ----
  const { geminiFetch } = await import(path.resolve(__dirname, '../functions/_lib/gemini.js'));
  let tries = 0;
  globalThis.fetch = async () => {
    tries++;
    return new Response('slow down', { status: tries < 3 ? 429 : 200 });
  };
  const gr = await geminiFetch('https://x.test/', {});
  ok('geminiFetch retries 429 then succeeds', gr.ok === true && tries === 3);
  tries = 0;
  globalThis.fetch = async () => { tries++; return new Response('slow', { status: 429 }); };
  const gf = await geminiFetch('https://x.test/', {}, 2);
  ok('geminiFetch gives up after tries exhausted', gf.ok === false && gf.status === 429 && tries === 2);
  globalThis.fetch = async () => new Response('bad', { status: 400 });
  const g400 = await geminiFetch('https://x.test/', {});
  ok('geminiFetch does not retry 400', g400.ok === false && g400.status === 400);
  globalThis.fetch = async () => { throw new Error('down'); };
  const gnet = await geminiFetch('https://x.test/', {});
  ok('geminiFetch reports network errors', gnet.ok === false && gnet.networkError === true);

  globalThis.fetch = realFetch;

  // ---- public edition repository API (v288) ----
  const editionApiFn = await import(path.resolve(__dirname, '../functions/api/editions/[isbn].js'));
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/editions')
      return new Response(JSON.stringify([{
        id: 'ed1', isbn: '9780143127748', publisher: 'Test Pub', format: 'Hardcover',
        page_count: 500, publication_date: '2020-01-01', cover_url: 'https://x/cover.jpg',
        provider_ids: {}, thickness_mm: 28.4, thickness_source: 'measurement',
        thickness_confidence: 96, thickness_measured_at: '2026-10-04T00:00:00Z',
        updated_at: '2026-10-04T00:00:00Z'
      }]), { status: 200 });
    if (u.pathname === '/rest/v1/edition_asset_slots')
      return new Response(JSON.stringify([{
        face: 'spine', appearance: 'jacket', canonical_asset_id: 'a1',
        selection_method: 'quality', selected_at: '2026-10-04T00:00:00Z'
      }]), { status: 200 });
    if (u.pathname === '/rest/v1/edition_assets')
      return new Response(JSON.stringify([{
        id: 'a1', face: 'spine', appearance: 'jacket', bucket: 'edition-images',
        path: 'spine/jacket/abc.jpg', width: 500, height: 1200, format: 'image/jpeg',
        byte_size: 12345, sha256: 'abc', quality_score: 94.2, verified: true,
        created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z'
      }]), { status: 200 });
    if (u.pathname === '/rest/v1/edition_measurements')
      return new Response(JSON.stringify([{
        thickness_mm: 28.4, confidence: 96, verified: false,
        method: 'id1-card', created_at: '2026-10-04T00:00:00Z'
      }]), { status: 200 });
    throw new Error('unexpected API fetch ' + url);
  };
  const apiCtx = (isbn) => ({
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' },
    request: new Request('https://app.test/api/editions/' + isbn)
  });
  const apiRes = await editionApiFn.onRequest(apiCtx('9780143127748'));
  const apiJson = await apiRes.json();
  ok('edition API: 200 with canonical data', apiRes.status === 200 &&
    apiJson.isbn === '9780143127748' &&
    apiJson.faces['jacket:spine'].id === 'a1' &&
    apiJson.faces['jacket:spine'].verified === true &&
    apiJson.edition.dimensions.thickness_mm === 28.4);
  ok('edition API: public asset URL is content-addressed',
    apiJson.faces['jacket:spine'].url.endsWith('/edition-images/spine/jacket/abc.jpg'));
  const apiBad = await editionApiFn.onRequest(apiCtx('not-an-isbn'));
  ok('edition API: invalid ISBN -> 400', apiBad.status === 400);
  globalThis.fetch = realFetch;

  // ---- /cover-proxy (unchanged contract) ----
  globalThis.fetch = async (url) => {
    if (url === 'https://covers.openlibrary.org/b/id/1-M.jpg') {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    throw new Error('network down');
  };
  const prox = (u) => proxyFn.onRequest({ request: new Request('https://app.test/cover-proxy?url=' + encodeURIComponent(u)) });
  const good = await prox('https://covers.openlibrary.org/b/id/1-M.jpg');
  ok('proxy: 200 for allowed host', good.status === 200);
  const evil = await prox('https://169.254.169.254/latest/meta-data');
  ok('proxy: unlisted host rejected (SSRF)', evil.status === 403);
  globalThis.fetch = realFetch;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
