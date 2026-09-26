"""server.py tests: LAN-only token gating."""
import importlib.util

spec = importlib.util.spec_from_file_location('spicy_server', '/home/hatch/workspace/booktok/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

cases = [
    ('127.0.0.1', True), ('::1', True), ('localhost', True),
    ('192.168.1.50', True), ('192.168.0.1', True),
    ('10.0.0.5', True), ('10.200.1.1', True),
    ('172.16.4.2', True), ('172.31.255.255', True),
    ('169.254.10.20', True),  # link-local
    ('8.8.8.8', False), ('203.0.113.7', False), ('1.1.1.1', False),
    ('172.32.0.1', False),  # just outside 172.16/12
]
failed = 0
for addr, expected in cases:
    got = server.client_is_internal(addr)
    status = 'PASS' if got == expected else 'FAIL'
    if got != expected:
        failed += 1
    print('%s - client_is_internal(%r) = %s' % (status, addr, got))

# Token is served to LAN clients only
server.load_token = lambda: 'tok_secret_999'
lan_body = server.config_js_body('192.168.1.50').decode('utf-8')
wan_body = server.config_js_body('8.8.8.8').decode('utf-8')
ok = 'tok_secret_999' in lan_body
print(('PASS' if ok else 'FAIL') + ' - LAN client receives token')
failed += 0 if ok else 1
ok = wan_body == 'window.SPICY_CONFIG = {};'
print(('PASS' if ok else 'FAIL') + ' - external client gets empty config')
failed += 0 if ok else 1

# No token configured -> empty for everyone
server.load_token = lambda: ''
ok = server.config_js_body('192.168.1.50').decode('utf-8') == 'window.SPICY_CONFIG = {};'
print(('PASS' if ok else 'FAIL') + ' - empty config when no token set')
failed += 0 if ok else 1

print('\n%d failed' % failed)
if failed:
    raise SystemExit(1)

# Live HTTP checks: /health and LAN-only /config.js
import http.client
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
server.load_cloud_cfg = lambda: {'supabaseUrl': 'https://xyz.supabase.co', 'supabaseAnonKey': 'anon123'}
conn.request('GET', '/config.js')
r = conn.getresponse()
cfg_body = r.read().decode('utf-8')
ok = ('tok_secret_999' in cfg_body and 'anon123' in cfg_body
      and 'no-store' in (r.getheader('Cache-Control') or ''))
print(('PASS' if ok else 'FAIL') + ' - localhost /config.js carries secrets, no-store')
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
