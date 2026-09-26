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
srv.shutdown()
print('ALL SERVER TESTS PASSED')
