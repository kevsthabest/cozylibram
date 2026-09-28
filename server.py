#!/usr/bin/env python3
"""Cozy Libram server.

Serves the app's static files, plus:
- /config.js: capability flags (which server-side keys are configured) and
  Supabase credentials. Carries NO secrets since v89 — the Hardcover token
  and Google Books key stay in server-config.json and are attached
  server-side by the /api/* proxies below.
- /api/hardcover: POST {query} → Hardcover GraphQL with the server token.
- /api/gbooks/...: GET → Google Books API with the server key.
- /api/trope-infer: POST {messages, max_tokens} → LLM chat completions
  with the server-side trope API key (OpenRouter/Gemini/Groq/Ollama/custom).
- /cover-proxy: same-origin cover fetches for pixel reads.

Setup: copy server-config.example.json to server-config.json and paste your
Hardcover personal token and Google Books API key in it. server-config.json
is read by this server only — it is never committed to git.
"""
import ipaddress
import json
import os
import re
import socket
import urllib.error
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


def load_cloud_cfg():
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            d = json.load(f)
            return {'supabaseUrl': (d.get('supabase_url') or '').strip(),
                    'supabaseAnonKey': (d.get('supabase_anon_key') or '').strip()}
    except Exception:
        return {'supabaseUrl': '', 'supabaseAnonKey': ''}


TROPE_PROVIDER_URLS = {
    'openrouter': 'https://openrouter.ai/api/v1',
    'gemini': 'https://generativelanguage.googleapis.com/v1beta/openai',
    'groq': 'https://api.groq.com/openai/v1',
    'ollama': 'http://localhost:11434/v1',
}


def load_trope_cfg():
    """Trope-inference LLM config (v152). All server-side: the browser only
    learns whether a key is configured (via /config.js), never the key.

    v160: per-provider keys (trope_key_<provider> in server-config.json);
    trope_api_key remains the fallback for the default provider."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            d = json.load(f)
        provider = (d.get('trope_provider') or 'openrouter').strip().lower()
        base_url_explicit = (d.get('trope_base_url') or '').strip().rstrip('/')
        base_url = base_url_explicit or TROPE_PROVIDER_URLS.get(provider, '')
        keys = {}
        for p in list(TROPE_PROVIDER_URLS) + ['custom']:
            k = (d.get('trope_key_' + p) or '').strip()
            if k:
                keys[p] = k
        return {'provider': provider,
                'model': (d.get('trope_model') or '').strip(),
                'key': (d.get('trope_api_key') or '').strip(),
                'base_url': base_url,
                'base_url_explicit': base_url_explicit,
                'keys': keys}
    except Exception:
        return {'provider': 'openrouter', 'model': '', 'key': '',
                'base_url': '', 'base_url_explicit': '', 'keys': {}}


TROPE_MODEL_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$')


def config_js_body():
    """The /config.js payload: capability flags, not secrets.

    Since v89 the Hardcover token and Google Books key never leave the
    server — the /api/* proxies attach them. Clients only learn whether
    each integration is configured.
    """
    payload = {'hardcover': bool(load_token()),
               'gbooks': bool(load_gb_key())}
    cc = load_cloud_cfg()
    if cc['supabaseUrl'] and cc['supabaseAnonKey']:
        payload['supabaseUrl'] = cc['supabaseUrl']
        payload['supabaseAnonKey'] = cc['supabaseAnonKey']
    tc = load_trope_cfg()
    if tc['key'] and tc['model'] and tc['base_url']:
        payload['trope'] = True
        payload['tropeProvider'] = tc['provider']
        payload['tropeModel'] = tc['model']
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
            body = config_js_body()
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
        if path == '/api/hardcover':
            self.send_error(405, 'use POST')
            return
        if path.startswith('/api/gbooks/'):
            self.handle_api_gbooks()
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/api/hardcover':
            self.handle_api_hardcover()
            return
        if path == '/api/trope-infer':
            self.handle_api_trope_infer()
            return
        self.send_error(404)

    def handle_api_hardcover(self):
        """POST {query} → Hardcover GraphQL with the server-side token.

        Mirrors functions/api/hardcover.js. Hardcover's own HTTP status is
        forwarded so the client's 401/403 handling keeps working.
        """
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 65536)).decode('utf-8', 'replace')
            query = json.loads(raw).get('query') or ''
            if not isinstance(query, str) or not query or len(query) > 8000:
                self.send_error(400, 'bad request')
                return
            token = load_token()
            if not token:
                body = b'{"errors":[{"message":"hardcover not configured on this server"}]}'
                self.send_response(503)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            req = urllib.request.Request(
                'https://api.hardcover.app/v1/graphql',
                data=json.dumps({'query': query}).encode('utf-8'),
                headers={'Content-Type': 'application/json',
                         'Authorization': 'Bearer ' + token,
                         'User-Agent': 'CozyLibram/1.0 hc-proxy'})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read(2 * 1024 * 1024)
                status = r.status
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read(256 * 1024)
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            try:
                self.send_error(502, 'hardcover fetch failed')
            except Exception:
                pass

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_api_trope_infer(self):
        """POST /api/trope-infer {messages, max_tokens} → LLM chat completions.

        Mirrors functions/api/trope-infer.js. The API key, model, and base
        URL come from server-config.json — the browser never sees them.
        v160: the client may NAME a provider + model (Trope Lab picker);
        the provider is allowlisted and the key is per-provider server-side.
        Guards: POST only, messages is a small array of role/content objects,
        max_tokens clamped to 100..4000. The upstream HTTP status is
        forwarded so the client's 401/403/429 handling keeps working.
        """
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 65536)).decode('utf-8', 'replace')
            body = json.loads(raw)
            messages = body.get('messages')
            if not isinstance(messages, list) or not messages or len(messages) > 20:
                self.send_error(400, 'bad request')
                return
            for m in messages:
                if not isinstance(m, dict) or m.get('role') not in (
                        'system', 'user', 'assistant') or not isinstance(
                        m.get('content'), str) or len(m['content']) > 20000:
                    self.send_error(400, 'bad request')
                    return
            try:
                max_tokens = int(body.get('max_tokens') or 1200)
            except (TypeError, ValueError):
                max_tokens = 1200
            max_tokens = min(4000, max(100, max_tokens))

            # v160: optional client-chosen provider + model (must be a pair).
            tc = load_trope_cfg()
            env_provider = tc['provider']
            req_provider = body.get('provider')
            req_provider = req_provider.strip().lower() \
                if isinstance(req_provider, str) else ''
            req_model = body.get('model')
            req_model = req_model.strip() \
                if isinstance(req_model, str) else ''
            provider, model = env_provider, tc['model']
            if req_provider or req_model:
                if not req_provider or not req_model or \
                        (req_provider != 'custom' and
                         req_provider not in TROPE_PROVIDER_URLS) or \
                        not TROPE_MODEL_RE.match(req_model):
                    self.send_error(400, 'bad request')
                    return
                provider, model = req_provider, req_model
            key = tc['keys'].get(provider) or \
                (tc['key'] if provider == env_provider else '')
            if req_provider:
                base_url = tc['base_url_explicit'] if provider == 'custom' \
                    else TROPE_PROVIDER_URLS.get(provider, '')
            else:
                base_url = tc['base_url']
            if not key:
                self._send_json(
                    503, {'error': "no API key configured for provider '%s' "
                                   "(set trope_key_%s)" % (provider, provider)})
                return
            if not model or not base_url:
                self._send_json(
                    503, {'error': 'trope inference not configured on this server'})
                return
            url = base_url + '/chat/completions'
            # v156: low reasoning effort for OpenRouter (trope tagging is a
            # classification task; free reasoning models otherwise burn the
            # token budget on chain-of-thought and truncate the JSON).
            upstream_obj = {
                'model': model,
                'messages': [{'role': m['role'], 'content': m['content']}
                             for m in messages],
                'temperature': 0,
                'max_tokens': max_tokens,
            }
            if provider == 'openrouter':
                upstream_obj['reasoning'] = {'effort': 'low'}
            upstream_body = json.dumps(upstream_obj).encode('utf-8')
            headers = {'Content-Type': 'application/json',
                       'Authorization': 'Bearer ' + key,
                       'User-Agent': 'CozyLibram/1.0 trope-proxy'}
            if provider == 'openrouter':
                headers['HTTP-Referer'] = 'https://cozylibram.pages.dev'
                headers['X-Title'] = 'Cozy Libram'
            req = urllib.request.Request(url, data=upstream_body, headers=headers)
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read(256 * 1024)
                status = r.status
            # v156: surface truncation as a distinct, recoverable signal so
            # the client retries with a bigger budget instead of parsing
            # cut-off JSON.
            if status == 200:
                try:
                    fr = (json.loads(data).get('choices') or [{}])[0].get(
                        'finish_reason')
                    if fr == 'length':
                        data = json.dumps({'error': 'truncated'}).encode('utf-8')
                        status = 502
                except Exception:
                    pass
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read(256 * 1024)
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            try:
                self.send_error(502, 'trope inference failed')
            except Exception:
                pass

    def handle_api_gbooks(self):
        """GET /api/gbooks/books/v1/volumes?... → Google Books, key attached.

        Mirrors functions/api/gbooks/[[path]].js. Only the volumes endpoint
        is allowed; a client-supplied key param is stripped and replaced.
        """
        try:
            parts = self.path.split('?', 1)
            subpath = parts[0][len('/api/gbooks/'):]
            if subpath != 'books/v1/volumes':
                self.send_error(404)
                return
            qs = urllib.parse.parse_qs(parts[1] if len(parts) > 1 else '')
            qs.pop('key', None)
            key = load_gb_key()
            if key:
                qs['key'] = [key]
            url = ('https://www.googleapis.com/' + subpath + '?' +
                   urllib.parse.urlencode(qs, doseq=True))
            req = urllib.request.Request(
                url, headers={'User-Agent': 'CozyLibram/1.0 gbooks-proxy'})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read(2 * 1024 * 1024)
                ctype = r.headers.get('Content-Type', 'application/json')
                status = r.status
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read(256 * 1024)
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            try:
                self.send_error(502, 'gbooks fetch failed')
            except Exception:
                pass

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
    print('[Cozy Libram] Serving at http://localhost:%d' % PORT)
    print('[Cozy Libram] On your home network, also reachable at this PC\'s LAN IP.')
    if token:
        print('[Cozy Libram] Hardcover token loaded — attached server-side (/api/hardcover).')
    tc = load_trope_cfg()
    if tc['key'] and tc['model'] and tc['base_url']:
        print('[Cozy Libram] Trope inference ready — %s / %s (/api/trope-infer).'
              % (tc['provider'], tc['model']))
    if cc['supabaseUrl'] and cc['supabaseAnonKey']:
        print('[Cozy Libram] Supabase config loaded — served to every client (/config.js).')
    if not token and not (cc['supabaseUrl'] and cc['supabaseAnonKey']):
        print('[Cozy Libram] No secrets in server-config.json — each device must enter')
        print('[Cozy Libram] them in Settings. To auto-share with every device, copy')
        print('[Cozy Libram] server-config.example.json to server-config.json and fill it in.')
    print('[Cozy Libram] Keep this window open. Close it to stop.\n')
    ThreadingHTTPServer(('0.0.0.0', PORT), partial(Handler, directory=BASE_DIR)).serve_forever()


if __name__ == '__main__':
    main()
