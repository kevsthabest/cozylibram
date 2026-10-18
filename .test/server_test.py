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
import urllib.parse


class _StubSupa(_http_server.BaseHTTPRequestHandler):
    # Token map for /auth/v1/user; user-1 and user-4 are app admins,
    # user-2 is banned, user-3 is a plain signed-in user. The admin REST
    # endpoints answer only to the service-key bearer ('svc-stub').
    _USERS = {'Bearer good-token': ('user-1', 'one@example.com'),
              'Bearer banned-token': ('user-2', 'two@example.com'),
              'Bearer plain-token': ('user-3', 'three@example.com'),
              'Bearer admin2-token': ('user-4', 'four@example.com')}
    _ADMINS = {'user-1', 'user-4'}

    def _send(self, body, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        auth = self.headers.get('Authorization') or ''
        if self.path.startswith('/auth/v1/admin/users'):
            if auth != 'Bearer svc-stub':
                return self._send(b'{}', 401)
            return self._send(
                b'{"users": [{"id": "user-1", "email": "one@example.com",'
                b' "created_at": "2024-01-01T00:00:00Z",'
                b' "last_sign_in_at": null},'
                b' {"id": "user-3", "email": "three@example.com",'
                b' "created_at": "2024-02-01T00:00:00Z",'
                b' "last_sign_in_at": "2024-03-01T00:00:00Z"}]}')
        if self.path.startswith('/auth/v1/user'):
            who = self._USERS.get(auth)
            if who is None:
                return self._send(b'{}', 401)
            return self._send(json.dumps(
                {'id': who[0], 'email': who[1]}).encode('utf-8'))
        if self.path.startswith('/rest/v1/banned_users'):
            return self._send(b'[{"user_id": "user-2"}]'
                              if auth == 'Bearer banned-token' else b'[]')
        if self.path.startswith('/rest/v1/app_admins'):
            if auth != 'Bearer svc-stub':
                return self._send(b'{}', 401)
            uid = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query).get(
                'user_id', [''])[0].removeprefix('eq.')
            return self._send(b'[{"user_id": "%s"}]' % uid.encode('utf-8')
                              if uid in self._ADMINS else b'[]')
        return self._send(b'{}', 404)

    def do_DELETE(self):
        auth = self.headers.get('Authorization') or ''
        if auth != 'Bearer svc-stub':
            return self._send(b'{}', 401)
        return self._send(b'{}')

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
           '/%5cserver-config.json', '/..%5cserver-config.json',
           '/.git/config', '//.git/config', '/.git%5cconfig']:
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

# --- SEC-01a blocklist: backslash spellings (follow-up to issue #338) -----
# server.py's deployment machine is Windows, where a backslash separates
# path components for the filesystem at open time but means nothing to
# posixpath.normpath. Judged raw, a backslash spelling of a protected file
# looks like an ordinary filename to the checks above while Windows
# resolves it onto the real file. _path_blocked judges a backslash as a
# separator, so every spelling below must block exactly like its
# forward-slash twin in the #338 block.
for _p in ['/%5cserver-config.json', '/%5Cserver-config.json',
           '/..%5cserver-config.json', '/..\\server-config.json',
           '/x\\..\\server-config.json',
           '/.git\\config', '/.git%5cconfig',
           '/%5c.env', '/foo\\.env']:
    ok = _h._path_blocked(_p) is True
    print(('PASS' if ok else 'FAIL') + ' - blocklist blocks backslash spelling %r' % _p)
    if not ok:
        raise SystemExit(1)
# Legitimate backslash-free paths stay unaffected by the translation.
for _p in ['/index.html', '/config.js', '/js/181-appversion.js']:
    ok = _h._path_blocked(_p) is False
    print(('PASS' if ok else 'FAIL') + ' - blocklist still allows %r' % _p)
    if not ok:
        raise SystemExit(1)

# --- SEC-01a blocklist: bare-relative request targets (issue #399) -------
# translate_path does not resolve parent words, it drops them, so a
# request target with no leading slash at all — GET ../server-config.json —
# still lands on the served directory's file. The normalized judge kept
# the leading '..' that posixpath.normpath cannot resolve above the root
# and compared '/../server-config.json' against the protected set: no
# match, file served. The judge now applies translate_path's word
# filtering too, so every spelling below is judged as the path the
# resolver will actually serve.
for _p in ['../server-config.json', '../../server-config.json',
           '..%2fserver-config.json', '..%2Fserver-config.json',
           '../.git/config', '..%2f.git%2fconfig',
           '..\\server-config.json', '..%5cserver-config.json',
           '..\\.git\\config', '..%5c.git%5cconfig', '../.git\\config']:
    ok = _h._path_blocked(_p) is True
    print(('PASS' if ok else 'FAIL') + ' - blocklist blocks bare-relative %r' % _p)
    if not ok:
        raise SystemExit(1)
# Unchanged controls: spellings the earlier blocks already blocked stay
# blocked, and paths the resolver lands on unprotected files stay allowed
# — including the bare-relative spelling of one.
for _p in ['/../server-config.json', '//server-config.json']:
    ok = _h._path_blocked(_p) is True
    print(('PASS' if ok else 'FAIL') + ' - blocklist still blocks %r' % _p)
    if not ok:
        raise SystemExit(1)
for _p in ['/index.html', '/.gitignore', '../index.html']:
    ok = _h._path_blocked(_p) is False
    print(('PASS' if ok else 'FAIL') + ' - blocklist still allows %r' % _p)
    if not ok:
        raise SystemExit(1)

# Live, over a raw socket so the request target reaches the server byte
# for byte (an HTTP client may normalize a bare-relative target before
# sending): the pre-fix server answers 200 with the sentinel's contents;
# every spelling below must 404 without leaking a byte, while a
# bare-relative spelling of an ordinary file still serves.
import socket
_tmp3 = tempfile.mkdtemp(prefix='cozy-blocklist399-')
with open(os.path.join(_tmp3, 'server-config.json'), 'w') as _f:
    _f.write('SENTINEL-CONFIG')
os.mkdir(os.path.join(_tmp3, '.git'))
with open(os.path.join(_tmp3, '.git', 'config'), 'w') as _f:
    _f.write('SENTINEL-GIT')
with open(os.path.join(_tmp3, 'ok.txt'), 'w') as _f:
    _f.write('hello')
_srv3 = server.ThreadingHTTPServer(
    ('127.0.0.1', 0), partial(server.Handler, directory=_tmp3))
threading.Thread(target=_srv3.serve_forever, daemon=True).start()


def _raw(method, target):
    _s = socket.create_connection(
        ('127.0.0.1', _srv3.server_address[1]), timeout=5)
    _s.sendall(('%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\n'
                'Connection: close\r\n\r\n'
                % (method, target)).encode('latin-1'))
    _chunks = []
    while True:
        _d = _s.recv(65536)
        if not _d:
            break
        _chunks.append(_d)
    _s.close()
    _resp = b''.join(_chunks)
    return int(_resp.split(b' ', 2)[1]), _resp


for _t in ['../server-config.json', '..%2fserver-config.json',
           '../.git/config']:
    _st, _resp = _raw('GET', _t)
    ok = _st == 404 and b'SENTINEL' not in _resp
    print(('PASS' if ok else 'FAIL') + ' - live raw GET %r -> 404, no leak' % _t)
    if not ok:
        raise SystemExit(1)
_st, _resp = _raw('GET', '../ok.txt')
ok = _st == 200 and b'hello' in _resp
print(('PASS' if ok else 'FAIL') + ' - live raw GET ../ok.txt still serves (200)')
if not ok:
    raise SystemExit(1)
_st, _resp = _raw('GET', '/ok.txt')
ok = _st == 200 and b'hello' in _resp
print(('PASS' if ok else 'FAIL') + ' - live raw GET /ok.txt still serves (200)')
if not ok:
    raise SystemExit(1)
_srv3.shutdown()

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

# --- /api/read-cover 'spine' mode, v258 parity (issue #349) ---------------
# The mirror's mode allowlist predates v258: POSTing mode 'spine' (what
# js/205 spineDetectBox sends) got a 400 while production serves it. With
# no vision key configured, a spine request must now pass the mode gate
# and reach the documented 503; an unknown mode must still 400.
server.load_vision_cfg = lambda: {'key': '', 'model': 'gemini-3.8-flash'}
_check_api("read-cover: mode 'spine' passes the allowlist (503 no key)",
           _api('POST', '/api/read-cover',
                b'{"image":"data:image/jpeg;base64,AAAA","mode":"spine"}',
                'Bearer good-token'),
           503)
_check_api("read-cover: unknown mode still rejected (400)",
           _api('POST', '/api/read-cover',
                b'{"image":"data:image/jpeg;base64,AAAA","mode":"bogus"}',
                'Bearer good-token'),
           400)


def _spine(content):
    return server.Handler._clean_spine_result(
        {'choices': [{'message': {'content': content}}]})


ok = _spine('{"box": {"x0": 100.4, "y0": 50, "x1": 300, "y1": 950}}') == \
    {'box': {'x0': 100, 'y0': 50, 'x1': 300, 'y1': 950}}
print(('PASS' if ok else 'FAIL') + ' - spine cleaner: valid box rounded through')
if not ok:
    raise SystemExit(1)
ok = _spine('{"box": {"x0": -5, "y0": 0, "x1": 1200, "y1": 1000}}') == \
    {'box': {'x0': 0, 'y0': 0, 'x1': 1000, 'y1': 1000}}
print(('PASS' if ok else 'FAIL') + ' - spine cleaner: coordinates clamped to 0..1000')
if not ok:
    raise SystemExit(1)
ok = _spine('{"box": null}') == {'box': None} \
    and _spine('{"box": {"x0": 100, "y0": 50, "x1": 103, "y1": 950}}') == {'box': None} \
    and _spine('{"box": {"x0": 100, "y0": 50, "x1": 300, "y1": 60}}') == {'box': None} \
    and _spine('{"box": {"x0": 100, "y0": 50, "y1": 950}}') == {'box': None} \
    and _spine('not json at all') == {'box': None}
print(('PASS' if ok else 'FAIL') + ' - spine cleaner: null/thin/flat/incomplete/garbage -> box None')
if not ok:
    raise SystemExit(1)
ok = _spine('```json\n{"box": {"x0": 10, "y0": 20, "x1": 110, "y1": 420}}\n```') == \
    {'box': {'x0': 10, 'y0': 20, 'x1': 110, 'y1': 420}}
print(('PASS' if ok else 'FAIL') + ' - spine cleaner: markdown fences stripped')
if not ok:
    raise SystemExit(1)

# --- The three missing /api routes (issue #350) ----------------------------
# /api/enhance-face, /api/spine-search and /api/admin-users existed only
# on Pages — the mirror's do_POST had no branch for them, so LAN calls
# fell through to a static 404. From here the stub also plays the
# service-key side (admin checks, the Auth admin API): 'svc-stub'.
server.load_supabase_service_key = lambda: 'svc-stub'
server.load_brave_key = lambda: ''


def _expect(name, cond):
    print(('PASS' if cond else 'FAIL') + ' - ' + name)
    if not cond:
        raise SystemExit(1)


_EF_BODY = b'{"image":"data:image/jpeg;base64,AAAA","mode":"sharpen"}'
_check_api('enhance-face: route exists, body validated before auth (400)',
           _api('POST', '/api/enhance-face', b'{}'),
           400)
_check_api('enhance-face: signed-in caller, empty body -> 400',
           _api('POST', '/api/enhance-face', b'{}', 'Bearer good-token'),
           400)
_check_api('enhance-face: non-jpeg/png/webp data URL -> 400',
           _api('POST', '/api/enhance-face',
                b'{"image":"data:image/gif;base64,AAAA","mode":"sharpen"}',
                'Bearer good-token'),
           400)
_check_api("enhance-face: no vision key -> 503 (documented setup error)",
           _api('POST', '/api/enhance-face', _EF_BODY, 'Bearer good-token'),
           503, "face enhancement isn't set up on this server "
                "(set vision_api_key or trope_key_gemini)")

# Upstream calls (Gemini / Brave) are dispatched to fakes; loopback calls
# (the stub Supabase) pass through to the real urlopen.
import io
import urllib.error
import urllib.request
_real_urlopen = urllib.request.urlopen
_GEMINI_EF_OK = json.dumps({'candidates': [{'content': {'parts': [
    {'text': 'done'},
    {'inlineData': {'mimeType': 'image/png', 'data': 'QUJD'}}]}}]}
).encode('utf-8')
_BRAVE_OK = json.dumps({'results': [
    {'properties': {'url': 'https://img.example.com/spine.jpg'},
     'url': 'https://shop.example.com/book', 'title': 'A spine'}]}
).encode('utf-8')


class _FakeResp:
    def __init__(self, body, status=200):
        self._b = body
        self.status = status
        self.headers = {'Content-Type': 'application/json'}

    def read(self, *a):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_urlopen(req, timeout=None, **kw):
    url = getattr(req, 'full_url', '') or ''
    if 'generativelanguage.googleapis.com' in url:
        err = getattr(_fake_urlopen, 'gemini_error', None)
        if err:
            raise urllib.error.HTTPError(url, err, 'err', {},
                                         io.BytesIO(b'{}'))
        return _FakeResp(getattr(_fake_urlopen, 'gemini_body',
                                 _GEMINI_EF_OK))
    if 'api.search.brave.com' in url:
        return _FakeResp(_BRAVE_OK)
    if timeout is None:
        return _real_urlopen(req, **kw)
    return _real_urlopen(req, timeout=timeout, **kw)


urllib.request.urlopen = _fake_urlopen
server.load_vision_cfg = lambda: {'key': 'vision-stub',
                                  'model': 'gemini-3.8-flash'}

_st, _b = _api('POST', '/api/enhance-face',
               b'{"image":"data:image/jpeg;base64,AAAA","mode":"restore"}',
               'Bearer good-token')
_expect('enhance-face: upstream image returned as a data URL',
        _st == 200
        and json.loads(_b).get('image') == 'data:image/png;base64,QUJD')
_fake_urlopen.gemini_body = json.dumps(
    {'candidates': [{'content': {'parts': [{'text': 'no image'}]}}]}
).encode('utf-8')
_check_api('enhance-face: upstream returns no image -> 502',
           _api('POST', '/api/enhance-face', _EF_BODY, 'Bearer good-token'),
           502, 'enhance model returned no image')
_fake_urlopen.gemini_body = _GEMINI_EF_OK
_fake_urlopen.gemini_error = 503
_check_api('enhance-face: upstream 503 -> 502 temporarily unavailable',
           _api('POST', '/api/enhance-face', _EF_BODY, 'Bearer good-token'),
           502, 'enhance model temporarily unavailable (upstream 503)')
_fake_urlopen.gemini_error = None

_SS_BODY = b'{"title":"Dune","author":"Frank Herbert"}'
_check_api('spine-search: no Authorization -> 401',
           _api('POST', '/api/spine-search', _SS_BODY),
           401, 'sign-in required')
_check_api('spine-search: banned caller -> 403',
           _api('POST', '/api/spine-search', _SS_BODY, 'Bearer banned-token'),
           403, 'account suspended')
_check_api('spine-search: non-admin caller -> 403 admin only',
           _api('POST', '/api/spine-search', _SS_BODY, 'Bearer plain-token'),
           403, 'admin only')
_check_api('spine-search: admin, missing title -> 400',
           _api('POST', '/api/spine-search', b'{}', 'Bearer good-token'),
           400, 'title is required')
server.load_brave_key = lambda: 'brave-stub'
_st, _b = _api('POST', '/api/spine-search', _SS_BODY, 'Bearer good-token')
_d = json.loads(_b) if _st == 200 else {}
_expect("spine-search: Brave candidates served with via='brave'",
        _st == 200 and _d.get('via') == 'brave'
        and _d.get('candidates', [{}])[0].get('image_url')
        == 'https://img.example.com/spine.jpg'
        and _d.get('candidates', [{}])[0].get('page_url')
        == 'https://shop.example.com/book')
server.load_brave_key = lambda: ''
_fake_urlopen.gemini_body = json.dumps({'candidates': [
    {'content': {'parts': [{'text':
        '{"candidates": [{"image_url": "https://img.example.com/g.jpg",'
        ' "page_url": "https://p.example.com", "note": "found"}]}'}]},
     'groundingMetadata': {'groundingChunks': [
         {'web': {'uri': 'https://src.example.com', 'title': 'Src'}}]}}]}
).encode('utf-8')
_st, _b = _api('POST', '/api/spine-search', _SS_BODY, 'Bearer good-token')
_d = json.loads(_b) if _st == 200 else {}
_expect('spine-search: Gemini-grounded candidates + sources served',
        _st == 200
        and _d.get('candidates', [{}])[0].get('image_url')
        == 'https://img.example.com/g.jpg'
        and _d.get('sources', [{}])[0].get('uri')
        == 'https://src.example.com')
_fake_urlopen.gemini_body = _GEMINI_EF_OK

_check_api('admin-users: no Authorization -> 401',
           _api('POST', '/api/admin-users', b'{"action":"list_users"}'),
           401, 'sign-in required')
_check_api('admin-users: non-admin caller -> 403 admin only',
           _api('POST', '/api/admin-users', b'{"action":"list_users"}',
                'Bearer plain-token'),
           403, 'admin only')
_st, _b = _api('POST', '/api/admin-users', b'{"action":"list_users"}',
               'Bearer good-token')
_d = json.loads(_b) if _st == 200 else {}
_expect('admin-users: list_users maps the auth directory',
        _st == 200 and len(_d.get('users', [])) == 2
        and _d['users'][0].get('user_id') == 'user-1'
        and _d['users'][0].get('email') == 'one@example.com'
        and _d['users'][1].get('last_sign_in_at')
        == '2024-03-01T00:00:00Z')
_check_api('admin-users: unknown action -> 400',
           _api('POST', '/api/admin-users', b'{"action":"nope"}',
                'Bearer good-token'),
           400, 'unknown action')
_check_api('admin-users: delete without target -> 400',
           _api('POST', '/api/admin-users', b'{"action":"delete_user"}',
                'Bearer good-token'),
           400, 'target_user_id required')
_check_api('admin-users: cannot delete your own account -> 400',
           _api('POST', '/api/admin-users',
                b'{"action":"delete_user","target_user_id":"user-1"}',
                'Bearer good-token'),
           400, 'cannot delete your own account here')
_check_api('admin-users: cannot delete an admin account -> 400',
           _api('POST', '/api/admin-users',
                b'{"action":"delete_user","target_user_id":"user-1"}',
                'Bearer admin2-token'),
           400, 'cannot delete an admin account')
_st, _b = _api('POST', '/api/admin-users',
               b'{"action":"delete_user","target_user_id":"user-3"}',
               'Bearer good-token')
_expect('admin-users: delete_user wipes and deletes (ok:true)',
        _st == 200 and json.loads(_b).get('ok') is True)
server.load_supabase_service_key = lambda: ''
_check_api('admin-users: no service key configured -> 500 misconfigured',
           _api('POST', '/api/admin-users', b'{"action":"list_users"}',
                'Bearer good-token'),
           500, 'server misconfigured')
server.load_supabase_service_key = lambda: 'svc-stub'
urllib.request.urlopen = _real_urlopen

# --- /api/trope-infer: full-size legal bodies must not truncate (#351) ----
# The handler validates messages at up to 20 x 20,000 chars (the Pages
# contract, ~400 KB of text), but read the request body with a 64 KB cap:
# a legal 80 KB body was cut mid-JSON and failed downstream instead of
# reaching the provider. No trope key is configured here, so a body that
# survives validation must arrive at the documented 503.
server.load_trope_cfg = lambda: {'provider': 'gemini', 'model': 'gemini-x',
                                 'keys': {}, 'key': '', 'base_url': '',
                                 'base_url_explicit': ''}
_BIG_BODY = json.dumps({'messages': [
    {'role': 'user', 'content': 'x' * 20000} for _ in range(4)]
}).encode('utf-8')
_expect('trope-infer test body is legal-sized but over 64 KB (%d bytes)'
        % len(_BIG_BODY), 65536 < len(_BIG_BODY) < 400 * 1024)
_check_api('trope-infer: 80 KB legal body reaches the no-key 503',
           _api('POST', '/api/trope-infer', _BIG_BODY, 'Bearer good-token'),
           503, "no API key configured for provider 'gemini' "
                "(set trope_key_gemini)")
_check_api('trope-infer: oversize message content still rejected (400)',
           _api('POST', '/api/trope-infer',
                json.dumps({'messages': [
                    {'role': 'user', 'content': 'x' * 20001}]}
                ).encode('utf-8'), 'Bearer good-token'),
           400)

# --- /cover-proxy: oversize images rejected, never truncated (#352) ------
# The proxy read at most 4 MB and served whatever came back as a
# complete 200 with a matching Content-Length, so an oversize cover
# arrived silently cut off — and the favorites spine-colour sampler
# averaged a partial image without any error surfacing. Pages rejects
# oversize with 502 'image too large'. The upstream fetch is faked
# (a 5 MiB image body); DNS is the harness's public-IP fake.
class _FakeImgResp:
    def __init__(self, body, ctype='image/jpeg'):
        self._b = body
        self.headers = {'Content-Type': ctype}

    def read(self, n=-1):
        return self._b if n is None or n < 0 else self._b[:n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeImgOpener:
    def __init__(self, body, ctype='image/jpeg'):
        self._b = body
        self._ctype = ctype

    def open(self, req, timeout=None):
        return _FakeImgResp(self._b, self._ctype)


_COVER_URL = ('/cover-proxy?url=' + urllib.parse.quote(
    'https://covers.openlibrary.org/b/id/1-L.jpg', safe=''))
_real_opener = server._COVER_OPENER
_real_gai_cp = server.socket.getaddrinfo
_cp_fake_gai = fake_gai_factory(ips=['93.184.216.34'])


def _cp_gai(host, port, *a, **k):
    # The canned public-IP fake for the cover host, but loopback must
    # keep resolving for real — the test client itself connects via
    # 127.0.0.1 in this same process.
    if host in ('127.0.0.1', 'localhost', '::1'):
        return _real_gai_cp(host, port, *a, **k)
    return _cp_fake_gai(host, port, *a, **k)


server.socket.getaddrinfo = _cp_gai
try:
    server._COVER_OPENER = _FakeImgOpener(
        b'\xff\xd8' + b'x' * (5 * 1024 * 1024))
    _st, _b = _api('GET', _COVER_URL)
    ok = _st == 502
    print(('PASS' if ok else 'FAIL')
          + ' - cover-proxy: 5 MiB image -> 502, not a truncated 200')
    if not ok:
        raise SystemExit(1)
    # (#390, Pages #345 parity): image/svg+xml starts with image/ but is
    # an XML document that can carry script — refused with the
    # non-images, never served inline from this origin.
    server._COVER_OPENER = _FakeImgOpener(
        b'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'image/svg+xml')
    _st, _b = _api('GET', _COVER_URL)
    ok = _st == 502
    print(('PASS' if ok else 'FAIL')
          + ' - cover-proxy: SVG refused (502), not served inline')
    if not ok:
        raise SystemExit(1)
    _small = b'\xff\xd8' + b'y' * 1024
    server._COVER_OPENER = _FakeImgOpener(_small)
    _c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    _c.request('GET', _COVER_URL)
    _r = _c.getresponse()
    _b = _r.read()
    # (#390): served images also carry the Pages protective headers —
    # nosniff pins the declared type, sandboxed CSP neutralizes any
    # future document-like type reached by top-level navigation.
    ok = _r.status == 200 and _b == _small \
        and _r.getheader('X-Content-Type-Options') == 'nosniff' \
        and _r.getheader('Content-Security-Policy') == 'sandbox'
    _c.close()
    print(('PASS' if ok else 'FAIL')
          + ' - cover-proxy: under-cap image served complete, '
            'with protective headers')
    if not ok:
        raise SystemExit(1)
finally:
    server._COVER_OPENER = _real_opener
    server.socket.getaddrinfo = _real_gai_cp

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
              'embed', 'enhance-face', 'spine-search']:
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
