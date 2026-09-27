"""server.py tests: /config.js flags (no secrets since v89) + /api/* proxies + cover proxy."""
import importlib.util

spec = importlib.util.spec_from_file_location('spicy_server', '/home/hatch/workspace/booktok/server.py')
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

# /api/hardcover guards (no upstream network needed)
conn.request('GET', '/api/hardcover')
ok = conn.getresponse().status == 405
print(('PASS' if ok else 'FAIL') + ' - /api/hardcover GET -> 405')
if not ok:
    raise SystemExit(1)

conn.request('POST', '/api/hardcover', body=b'{"nope":1}',
             headers={'Content-Type': 'application/json'})
ok = conn.getresponse().status == 400
print(('PASS' if ok else 'FAIL') + ' - /api/hardcover bad body -> 400')
if not ok:
    raise SystemExit(1)

server.load_token = lambda: ''
conn.request('POST', '/api/hardcover', body=b'{"query":"query { x }"}',
             headers={'Content-Type': 'application/json'})
r = conn.getresponse()
ok = r.status == 503
print(('PASS' if ok else 'FAIL') + ' - /api/hardcover no token -> 503')
if not ok:
    raise SystemExit(1)

# /api/gbooks guards (no upstream network needed)
conn.request('GET', '/api/gbooks/books/v1/mylibrary/bookshelves')
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

srv.shutdown()
print('ALL SERVER TESTS PASSED')
