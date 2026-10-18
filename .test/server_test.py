"""server.py tests: /config.js flags (no secrets since v89) + /api/* proxies + cover proxy."""
import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    'spicy_server',
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server.py')))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

failed = 0

# /config.js carries flags only — the token never reaches the client
server.load_token = lambda: 'tok_secret_999'
server.load_gb_key = lambda: ''
body = server.config_js_body().decode('utf-8')
ok = ('"hardcover": true' in body and '"gbooks": false' in body
      and 'tok_secret_999' not in body and 'hardcoverToken' not in body)
print(('PASS' if ok else 'FAIL') + ' - /config.js carries flags, never the token')
failed += 0 if ok else 1

# Nothing configured -> both flags false
server.load_token = lambda: ''
server.load_gb_key = lambda: ''
ok = server.config_js_body() == b'window.SPICY_CONFIG = {"hardcover": false, "gbooks": false};'
print(('PASS' if ok else 'FAIL') + ' - empty config when nothing set')
failed += 0 if ok else 1

print('\n%d failed' % failed)
if failed:
    raise SystemExit(1)

# Live HTTP checks
import http.client
import json
import threading

srv = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
conn.request('GET', '/health')
r = conn.getresponse()
body = r.read()
ok = r.status == 200 and b'"status":"ok"' in body
print(('PASS' if ok else 'FAIL') + ' - /health returns 200 {"status":"ok"}')
if not ok:
    raise SystemExit(1)

server.load_token = lambda: 'tok_secret_999'
server.load_gb_key = lambda: 'gbkey_123'
server.load_cloud_cfg = lambda: {'supabaseUrl': 'https://xyz.supabase.co', 'supabaseAnonKey': 'anon123'}
conn.request('GET', '/config.js')
r = conn.getresponse()
cfg_body = r.read().decode('utf-8')
payload = json.loads(cfg_body.replace('window.SPICY_CONFIG = ', '').rstrip(';'))
ok = (payload.get('hardcover') is True and payload.get('gbooks') is True
      and 'tok_secret_999' not in cfg_body and 'gbkey_123' not in cfg_body
      and payload.get('supabaseAnonKey') == 'anon123'
      and 'no-store' in (r.getheader('Cache-Control') or ''))
print(('PASS' if ok else 'FAIL') + ' - /config.js: flags + supabase, no secrets, no-store')
if not ok:
    raise SystemExit(1)

# --- Stub Supabase for the /api/* auth gate (issue #339) -------------------
# authed_user() validates the caller's JWT against
# <supabaseUrl>/auth/v1/user and checks banned_users with the caller's own
# token. This stub plays that API on loopback: 'good-token' -> user-1,
# 'banned-token' -> user-2 (who is on banned_users), anything else -> 401.
import http.server as _http_server


class _StubSupa(_http_server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization') or ''
        body, status = b'{}', 200
        if self.path.startswith('/auth/v1/user'):
            if auth == 'Bearer good-token':
                body = b'{"id": "user-1", "email": "one@example.com"}'
            elif auth == 'Bearer banned-token':
                body = b'{"id": "user-2", "email": "two@example.com"}'
            else:
                status = 401
        elif self.path.startswith('/rest/v1/banned_users'):
            body = (b'[{"user_id": "user-2"}]'
                    if auth == 'Bearer banned-token' else b'[]')
        else:
            status = 404
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_supa_srv = server.ThreadingHTTPServer(('127.0.0.1', 0), _StubSupa)
threading.Thread(target=_supa_srv.serve_forever, daemon=True).start()
_STUB_URL = 'http://127.0.0.1:%d' % _supa_srv.server_address[1]
server.load_cloud_cfg = lambda: {'supabaseUrl': _STUB_URL,
                                 'supabaseAnonKey': 'anon-stub'}
server.load_supabase_service_key = lambda: ''
_GOOD = {'Authorization': 'Bearer good-token'}

# /api/hardcover guards (no upstream network needed). Since the v225-parity
# gate (issue #339) these requests carry a signed-in caller; the
# unauthenticated cases live in the auth section below.
conn.request('GET', '/api/hardcover')
ok = conn.getresponse().status == 405
print(('PASS' if ok else 'FAIL') + ' - /api/hardcover GET -> 405')
if not ok:
    raise SystemExit(1)

conn.request('POST', '/api/hardcover', body=b'{"nope":1}',
             headers={'Content-Type': 'application/json', **_GOOD})
ok = conn.getresponse().status == 400
print(('PASS' if ok else 'FAIL') + ' - /api/hardcover bad body -> 400')
if not ok:
    raise SystemExit(1)

server.load_token = lambda: ''
# Probe with a shape-valid query: since SEC-03 an out-of-allowlist root
# field is rejected 403 before the token check, so the no-token 503 is only
# reachable with an allowed shape. (Harness probe fix — the assertion,
# "no token -> 503", is unchanged.)
conn.request('POST', '/api/hardcover', body=b'{"query":"query { search }"}',
             headers={'Content-Type': 'application/json', **_GOOD})
r = conn.getresponse()
ok = r.status == 503
print(('PASS' if ok else 'FAIL') + ' - /api/hardcover no token -> 503')
if not ok:
    raise SystemExit(1)

# /api/gbooks guards (no upstream network needed)
conn.request('GET', '/api/gbooks/books/v1/mylibrary/bookshelves',
             headers=_GOOD)
ok = conn.getresponse().status == 404
print(('PASS' if ok else 'FAIL') + ' - /api/gbooks non-volumes path -> 404')
if not ok:
    raise SystemExit(1)

# /cover-proxy: SSRF guard + image validation (live)
import urllib.parse
def proxy_get(target):
    conn.request('GET', '/cover-proxy?url=' + urllib.parse.quote(target, safe=''))
    r = conn.getresponse()
    body = r.read()
    return r.status, r.getheader('Content-Type'), body

st, _, _ = proxy_get('not a url')
ok = st == 400
print(('PASS' if ok else 'FAIL') + ' - /cover-proxy rejects non-http(s) url (400)')
if not ok:
    raise SystemExit(1)

st, _, _ = proxy_get('http://127.0.0.1:9/internal')
ok = st == 403
print(('PASS' if ok else 'FAIL') + ' - /cover-proxy blocks private hosts (403)')
if not ok:
    raise SystemExit(1)

# SSRF guard unit tests (monkeypatched DNS — no network needed)
_real_gai = server.socket.getaddrinfo
def fake_gai_factory(ips=None, exc=None):
    def fake(host, port, *a, **k):
        if exc:
            raise exc
        return [(2, 1, 6, '', (ip, 0)) for ip in ips]
    return fake
server.socket.getaddrinfo = fake_gai_factory(ips=['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
ok = server.cover_proxy_host_blocked('example.com') is False
print(('PASS' if ok else 'FAIL') + ' - SSRF guard allows public IPs')
if not ok:
    raise SystemExit(1)
for bad_ip in ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.10.20', '::1']:
    server.socket.getaddrinfo = fake_gai_factory(ips=[bad_ip])
    ok = server.cover_proxy_host_blocked('x') is True
    print(('PASS' if ok else 'FAIL') + ' - SSRF guard blocks %s' % bad_ip)
    if not ok:
        raise SystemExit(1)
server.socket.getaddrinfo = fake_gai_factory(exc=OSError('no dns'))
ok = server.cover_proxy_host_blocked('x') is True
print(('PASS' if ok else 'FAIL') + ' - SSRF guard blocks on DNS failure')
if not ok:
    raise SystemExit(1)
server.socket.getaddrinfo = _real_gai

# Live fetch tests need real DNS; this sandbox proxies all DNS to 198.18/15.
def sandbox_dns_poisoned():
    try:
        ips = [i[4][0] for i in _real_gai('example.com', None)]
        return all(ip.startswith('198.18.') for ip in ips)
    except OSError:
        return True
if sandbox_dns_poisoned():
    print('SKIP - live cover fetch tests (sandbox DNS proxies all hosts)')
else:
    st, _, _ = proxy_get('https://example.com/')
    ok = st == 502
    print(('PASS' if ok else 'FAIL') + ' - /cover-proxy rejects non-image content (502)')
    if not ok:
        raise SystemExit(1)

    st, ct, body = proxy_get('https://covers.openlibrary.org/b/id/12345-L.jpg')
    ok = st == 200 and (ct or '').startswith('image/') and len(body) > 1000
    print(('PASS' if ok else 'FAIL') + ' - /cover-proxy fetches a real cover image (200)')
    if not ok:
        raise SystemExit(1)

# --- SEC-01a blocklist vs path normalization (issue #338) ------------------
# _path_blocked must judge the path translate_path() will resolve — the
# unquoted, posixpath-normalized form. Against the raw request path,
# duplicate-slash / dot-segment / parent-segment spellings of a protected
# file slip past the exact-string checks and are served.
_h = server.Handler.__new__(server.Handler)
for _p in ['/server-config.json', '//server-config.json',
           '/./server-config.json', '/x/../server-config.json',
           '/a/../../server-config.json', '/%2e%2e/server-config.json',
           '/server-config.json/', '/server-config.json?x=1',
           '/.git', '/.git/config', '//.git/config', '/.git//HEAD',
           '/x/../../.git/config',
           '/.env', '/foo/.env', '/.env.local',
           '/cert.pem', '/a/../key.key']:
    ok = _h._path_blocked(_p) is True
    print(('PASS' if ok else 'FAIL') + ' - blocklist blocks %r' % _p)
    if not ok:
        raise SystemExit(1)
for _p in ['/index.html', '/config.js', '/js/181-appversion.js',
           '/.gitignore', '/styles.css']:
    ok = _h._path_blocked(_p) is False
    print(('PASS' if ok else 'FAIL') + ' - blocklist allows %r' % _p)
    if not ok:
        raise SystemExit(1)

# Live: a served directory holding the real files; every spelling must 404
# without leaking a byte, for GET and HEAD, while normal files still serve.
import tempfile
from functools import partial
_tmp = tempfile.mkdtemp(prefix='cozy-blocklist-')
with open(os.path.join(_tmp, 'server-config.json'), 'w') as _f:
    _f.write('SENTINEL-CONFIG')
os.mkdir(os.path.join(_tmp, '.git'))
with open(os.path.join(_tmp, '.git', 'config'), 'w') as _f:
    _f.write('SENTINEL-GIT')
with open(os.path.join(_tmp, 'ok.txt'), 'w') as _f:
    _f.write('hello')
_srv2 = server.ThreadingHTTPServer(
    ('127.0.0.1', 0), partial(server.Handler, directory=_tmp))
threading.Thread(target=_srv2.serve_forever, daemon=True).start()
_conn2 = http.client.HTTPConnection(
    '127.0.0.1', _srv2.server_address[1], timeout=5)


def _req2(method, p):
    _conn2.request(method, p)
    _r = _conn2.getresponse()
    return _r.status, _r.read()


for _p in ['/server-config.json', '//server-config.json',
           '/./server-config.json', '/x/../server-config.json',
           '/%2e%2e/server-config.json',
           '/.git/config', '//.git/config']:
    _st, _body = _req2('GET', _p)
    ok = _st == 404 and b'SENTINEL' not in _body
    print(('PASS' if ok else 'FAIL') + ' - live GET %r -> 404, no leak' % _p)
    if not ok:
        raise SystemExit(1)
_st, _body = _req2('HEAD', '//server-config.json')
ok = _st == 404 and b'SENTINEL' not in _body
print(('PASS' if ok else 'FAIL') + ' - live HEAD //server-config.json -> 404')
if not ok:
    raise SystemExit(1)
_st, _body = _req2('GET', '/ok.txt')
ok = _st == 200 and _body == b'hello'
print(('PASS' if ok else 'FAIL') + ' - live GET /ok.txt still serves (200)')
if not ok:
    raise SystemExit(1)
_srv2.shutdown()

# --- /api/* caller authentication, v225 parity (issue #339) ----------------
# Every /api/* handler must reject unauthenticated callers with the Pages
# functions' 401 (and banned callers with 403) before any rate budget or
# upstream quota is spent; a valid session passes through to the handler's
# own responses. Fresh connection per call: pre-fix, some of these paths
# drop or hang the shared connection.
def _api(method, path, body=None, auth=None):
    _c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    _headers = {'Content-Type': 'application/json'}
    if auth is not None:
        _headers['Authorization'] = auth
    try:
        _c.request(method, path, body=body, headers=_headers)
        _r = _c.getresponse()
        return _r.status, _r.read()
    except Exception:
        return None, b''
    finally:
        _c.close()


def _check_api(name, got, want_status, want_error=None):
    _st, _body = got
    _ok = _st == want_status
    if want_error is not None:
        try:
            _ok = _ok and json.loads(_body).get('error') == want_error
        except Exception:
            _ok = False
    print(('PASS' if _ok else 'FAIL') + ' - ' + name)
    if not _ok:
        raise SystemExit(1)


_HC_BODY = b'{"query":"query { search }"}'
_check_api('auth: hardcover, no Authorization -> 401 sign-in required',
           _api('POST', '/api/hardcover', _HC_BODY),
           401, 'sign-in required')
_check_api('auth: hardcover, junk token -> 401',
           _api('POST', '/api/hardcover', _HC_BODY, 'Bearer junk'),
           401, 'sign-in required')
_check_api('auth: hardcover, token without Bearer scheme -> 401',
           _api('POST', '/api/hardcover', _HC_BODY, 'good-token'),
           401, 'sign-in required')
_check_api('auth: hardcover, trailing junk after token -> 401',
           _api('POST', '/api/hardcover', _HC_BODY, 'Bearer good-token x'),
           401, 'sign-in required')
_check_api('auth: hardcover, banned caller -> 403 account suspended',
           _api('POST', '/api/hardcover', _HC_BODY, 'Bearer banned-token'),
           403, 'account suspended')
_check_api('auth: hardcover, valid session passes gate (503 no HC token)',
           _api('POST', '/api/hardcover', _HC_BODY, 'Bearer good-token'),
           503)
_check_api('auth: trope-infer, no Authorization -> 401',
           _api('POST', '/api/trope-infer', b'{}'),
           401, 'sign-in required')
_check_api('auth: trope-infer, valid session passes gate (400 bad body)',
           _api('POST', '/api/trope-infer', b'{}', 'Bearer good-token'),
           400)
_check_api('auth: read-cover, no Authorization -> 401',
           _api('POST', '/api/read-cover', b'{}'),
           401, 'sign-in required')
_check_api('auth: read-cover, valid session passes gate (400 bad body)',
           _api('POST', '/api/read-cover', b'{}', 'Bearer good-token'),
           400)
_check_api('auth: trope-models, no Authorization -> 401',
           _api('GET', '/api/trope-models?provider=nope'),
           401, 'sign-in required')
_check_api('auth: trope-models, valid session passes gate (400 provider)',
           _api('GET', '/api/trope-models?provider=nope', None,
                'Bearer good-token'),
           400)
_check_api('auth: cache-cover, no Authorization -> 401',
           _api('POST', '/api/cache-cover',
                b'{"url":"https://covers.openlibrary.org/b/id/1-L.jpg"}'),
           401, 'sign-in required')
_check_api('auth: cache-cover, valid session passes gate (503 unconfigured)',
           _api('POST', '/api/cache-cover',
                b'{"url":"https://covers.openlibrary.org/b/id/1-L.jpg"}',
                'Bearer good-token'),
           503, 'cover cache not configured')
_check_api('auth: embed, no Authorization -> 401 (gate precedes handler)',
           _api('POST', '/api/embed', b'{"texts":["x"]}'),
           401, 'sign-in required')
_check_api('auth: gbooks, no Authorization -> 401',
           _api('GET', '/api/gbooks/books/v1/volumes?q=x'),
           401, 'sign-in required')
_check_api('auth: inventaire, no Authorization -> 401',
           _api('GET', '/api/inventaire/entities?uris=isbn:9780141030319'),
           401, 'sign-in required')

# authed_user() unit checks against the stub (same values as the live API)
_u = server.authed_user({'Authorization': 'Bearer good-token'})
ok = isinstance(_u, dict) and _u.get('id') == 'user-1' and not _u.get('banned')
print(('PASS' if ok else 'FAIL') + ' - authed_user: good token -> user-1')
if not ok:
    raise SystemExit(1)
_u = server.authed_user({'Authorization': 'Bearer banned-token'})
ok = isinstance(_u, dict) and _u.get('id') == 'user-2' and _u.get('banned') is True
print(('PASS' if ok else 'FAIL') + ' - authed_user: banned token -> banned user')
if not ok:
    raise SystemExit(1)
ok = server.authed_user({'Authorization': 'Bearer junk'}) is None \
    and server.authed_user({}) is None \
    and server.authed_user({'Authorization': 'good-token'}) is None
print(('PASS' if ok else 'FAIL') + ' - authed_user: junk/missing/schemaless -> None')
if not ok:
    raise SystemExit(1)

# --- /api/embed: the documented 503 must be reachable (issue #348) --------
# handle_api_embed opens with _check_rate('embed'), but _RATE_LIMITS had no
# 'embed' key and rate_limit_ok indexes it unguarded — every POST raised
# KeyError outside the handler's try and dropped the connection, instead of
# returning the documented "always 503" the client degrades around.
ok = 'embed' in server._RATE_LIMITS
print(('PASS' if ok else 'FAIL') + " - _RATE_LIMITS has an 'embed' entry")
if not ok:
    raise SystemExit(1)
ok = server._RATE_LIMITS['embed'] == (30, 60)
print(('PASS' if ok else 'FAIL') + " - 'embed' limit matches Pages (30/60s)")
if not ok:
    raise SystemExit(1)
for _name in ['trope-infer', 'read-cover', 'hardcover', 'gbooks',
              'inventaire', 'trope-models', 'cover-proxy', 'cache-cover',
              'embed']:
    ok = _name in server._RATE_LIMITS
    print(('PASS' if ok else 'FAIL') + ' - rate-limit name %r defined' % _name)
    if not ok:
        raise SystemExit(1)
_check_api('embed: valid session -> documented 503, not a dropped connection',
           _api('POST', '/api/embed', b'{"texts":["hello"]}',
                'Bearer good-token'),
           503, 'embeddings not set up: add a Workers AI binding named AI '
                'to this Pages project (Settings \u2192 Functions \u2192 '
                'Workers AI bindings)')
_supa_srv.shutdown()

srv.shutdown()
print('ALL SERVER TESTS PASSED')
