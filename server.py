#!/usr/bin/env python3
"""Spicy Shelves server.

Serves the app's static files, plus a dynamic /config.js that hands the
Hardcover API token ONLY to clients on the local network (loopback, private
LAN, or link-local addresses). Anyone connecting from an unknown/external IP
gets an empty config and must enter the token manually in Settings.

The same LAN-only mechanism can share Supabase credentials (supabase_url and
supabase_anon_key in server-config.json) so home-network devices get cloud
sync with zero setup.

Setup: copy server-config.example.json to server-config.json and paste your
Hardcover personal token in it. server-config.json is read by this server
only — it is never sent to clients.
"""
import ipaddress
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, 'server-config.json')
PORT = int(os.environ.get('PORT', '8000'))


def load_token():
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return (json.load(f).get('hardcover_token') or '').strip()
    except Exception:
        return ''


def client_is_internal(addr):
    """True for loopback, private LAN, and link-local addresses.

    Uses explicit ranges — ipaddress's is_private is too broad (it also
    matches documentation/test ranges like 203.0.113.0/24).
    """
    host = addr.split('%')[0].strip().lower()
    if host == 'localhost':
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    internal_nets = [
        ipaddress.ip_network('127.0.0.0/8'),    # loopback v4
        ipaddress.ip_network('10.0.0.0/8'),      # private LAN
        ipaddress.ip_network('172.16.0.0/12'),   # private LAN
        ipaddress.ip_network('192.168.0.0/16'),  # private LAN
        ipaddress.ip_network('169.254.0.0/16'),  # link-local v4
        ipaddress.ip_network('::1/128'),         # loopback v6
        ipaddress.ip_network('fc00::/7'),        # unique-local v6
        ipaddress.ip_network('fe80::/10'),       # link-local v6
    ]
    return any(ip in net for net in internal_nets)


def load_cloud_cfg():
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            d = json.load(f)
            return {'supabaseUrl': (d.get('supabase_url') or '').strip(),
                    'supabaseAnonKey': (d.get('supabase_anon_key') or '').strip()}
    except Exception:
        return {'supabaseUrl': '', 'supabaseAnonKey': ''}


def config_js_body(client_addr):
    """The /config.js payload for one client: secrets only for internal IPs."""
    internal = client_is_internal(client_addr)
    payload = {}
    token = load_token()
    if token and internal:
        payload['hardcoverToken'] = token
    if internal:
        cc = load_cloud_cfg()
        if cc['supabaseUrl'] and cc['supabaseAnonKey']:
            payload['supabaseUrl'] = cc['supabaseUrl']
            payload['supabaseAnonKey'] = cc['supabaseAnonKey']
    return ('window.SPICY_CONFIG = %s;' % json.dumps(payload)).encode('utf-8')


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/health':
            body = b'{"status":"ok","service":"spicy-shelves"}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/config.js':
            body = config_js_body(self.client_address[0])
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):  # keep the console window quiet
        pass


def main():
    token = load_token()
    cc = load_cloud_cfg()
    print('[Spicy Shelves] Serving at http://localhost:%d' % PORT)
    print('[Spicy Shelves] On your home network, also reachable at this PC\'s LAN IP.')
    if token:
        print('[Spicy Shelves] Hardcover token loaded — shared with home-network devices only.')
    if cc['supabaseUrl'] and cc['supabaseAnonKey']:
        print('[Spicy Shelves] Supabase config loaded — shared with home-network devices only.')
    if not token and not (cc['supabaseUrl'] and cc['supabaseAnonKey']):
        print('[Spicy Shelves] No secrets in server-config.json — each device must enter')
        print('[Spicy Shelves] them in Settings. To auto-share on your home network, copy')
        print('[Spicy Shelves] server-config.example.json to server-config.json and fill it in.')
    print('[Spicy Shelves] Keep this window open. Close it to stop.\n')
    ThreadingHTTPServer(('0.0.0.0', PORT), partial(Handler, directory=BASE_DIR)).serve_forever()


if __name__ == '__main__':
    main()
