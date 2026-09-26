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
Hardcover personal token and Google Books API key in it. server-config.json
is read by this server only — it is never sent to clients.
"""
import ipaddress
import json
import os
import re
import socket
import urllib.parse
import urllib.request
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


def load_gb_key():
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return (json.load(f).get('google_books_key') or '').strip()
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
    gbk = load_gb_key()
    if gbk and internal:
        payload['googleBooksKey'] = gbk
    if internal:
        cc = load_cloud_cfg()
        if cc['supabaseUrl'] and cc['supabaseAnonKey']:
            payload['supabaseUrl'] = cc['supabaseUrl']
            payload['supabaseAnonKey'] = cc['supabaseAnonKey']
    return ('window.SPICY_CONFIG = %s;' % json.dumps(payload)).encode('utf-8')


def cover_proxy_host_blocked(host):
    """SSRF guard for /cover-proxy: True when the host must not be fetched —
    DNS failure, or every resolved address being private, loopback,
    link-local, multicast, or reserved."""
    try:
        addrs = socket.getaddrinfo(host, None)
    except OSError:
        return True
    for info in addrs:
        try:
            ip = ipaddress.ip_address(info[4][0].split('%')[0])
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or \
                ip.is_multicast or ip.is_reserved:
            return True
    return False


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
        if path == '/cover-proxy':
            self.handle_cover_proxy()
            return
        super().do_GET()

    def handle_cover_proxy(self):
        """Fetch a cover image server-side and return its bytes same-origin.

        Lets the app read cover pixels (favorites spine colors) from hosts
        that don't send CORS headers (e.g. Google Books). Guards: only
        http(s) URLs, 4 MB cap, must be an image, and the host must not
        resolve to a private/loopback/link-local address (SSRF guard).
        """
        try:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = (qs.get('url') or [''])[0].strip()[:2000]
            if not re.match(r'^https?://', url, re.I):
                self.send_error(400, 'need an http(s) url')
                return
            host = urllib.parse.urlparse(url).hostname or ''
            if cover_proxy_host_blocked(host):
                self.send_error(403, 'private hosts are blocked')
                return
            req = urllib.request.Request(
                url, headers={'User-Agent': 'SpicyShelves/1.0 cover-proxy'})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read(4 * 1024 * 1024)
                ctype = r.headers.get('Content-Type', 'application/octet-stream')
            if not ctype.split(';')[0].strip().lower().startswith('image/'):
                self.send_error(502, 'not an image')
                return
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            try:
                self.send_error(502, 'cover fetch failed')
            except Exception:
                pass

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
