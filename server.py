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
import time
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


def load_vision_cfg():
    """Vision cover-reading config (v197; v198: Gemini, not OpenAI). All
    server-side: the browser only learns whether a key is configured, never
    the key itself.

    server-config.json keys: vision_api_key (dedicated), falling back to
    the already-configured trope_key_gemini; vision_model
    (default gemini-2.0-flash)."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            d = json.load(f)
        key = (d.get('vision_api_key') or '').strip() or \
            (d.get('trope_key_gemini') or '').strip()
        return {'key': key,
                'model': (d.get('vision_model') or 'gemini-2.0-flash').strip()}
    except Exception:
        return {'key': '', 'model': 'gemini-2.0-flash'}


VISION_PROMPT_SINGLE = (
    'You are reading a photo of a book cover. Return a JSON object with '
    'exactly these keys: "isbn" (the printed ISBN digits with no dashes or '
    'spaces, or null if no ISBN is printed \u2014 pre-1970 books have none), '
    '"title" (or null), "author" (or null). The ISBN is usually printed near '
    'the barcode on the back cover. Prefer the ISBN when one is visible. '
    'Reply with ONLY the JSON object, no other text.')


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


# v194 (security): light in-process rate limiting for the /api/* proxies and
# /cover-proxy. The home server is LAN-only by convention, but a runaway
# client (or a compromised LAN device) shouldn't burn LLM/API quota
# unchecked. Mirrors functions/_lib/rate-limit.js. ThreadingHTTPServer
# serves concurrent requests; dict/list ops are GIL-atomic, which is plenty
# precise for a rate limiter.
_RATE_BUCKETS = {}
_RATE_LIMITS = {
    'trope-infer': (30, 60),    # each hit can spend up to 4000 LLM tokens
    'read-cover': (20, 60),     # v197: vision calls cost more than text
    'hardcover': (120, 60),
    'gbooks': (120, 60),
    'trope-models': (60, 60),
    'cover-proxy': (120, 60),
}

def rate_limit_ok(name, ip):
    """Sliding-window check: True when the request may proceed."""
    limit, window = _RATE_LIMITS[name]
    now = time.time()
    key = '%s|%s' % (name, ip)
    hits = _RATE_BUCKETS.get(key)
    if hits is None:
        hits = []
        _RATE_BUCKETS[key] = hits
    while hits and now - hits[0] >= window:
        hits.pop(0)
    if len(hits) >= limit:
        return False
    hits.append(now)
    return True


class _SSRFRedirectHandler(urllib.request.HTTPRedirectHandler):
    """v194 (security): re-check every redirect hop against the SSRF guard.
    urllib follows redirects without re-validating, so a cover host could
    bounce to a private/loopback address unchecked."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        hop = urllib.parse.urljoin(req.full_url, newurl)
        hop_host = urllib.parse.urlparse(hop).hostname or ''
        if cover_proxy_host_blocked(hop_host):
            raise urllib.error.HTTPError(req.full_url, 403,
                                         'redirect to private host blocked',
                                         headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

_COVER_OPENER = urllib.request.build_opener(_SSRFRedirectHandler)


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
        if path == '/api/trope-models':
            self.handle_api_trope_models()
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
        if path == '/api/read-cover':
            self.handle_api_read_cover()
            return
        self.send_error(404)

    def _check_rate(self, name):
        """v194 (security): 429 when this client is over the per-endpoint budget."""
        if not rate_limit_ok(name, self.client_address[0]):
            try:
                self._send_json(429, {'error': 'rate limited'})
            except Exception:
                pass
            return False
        return True

    def handle_api_hardcover(self):
        """POST {query} → Hardcover GraphQL with the server-side token.

        Mirrors functions/api/hardcover.js. Hardcover's own HTTP status is
        forwarded so the client's 401/403 handling keeps working.
        """
        if not self._check_rate('hardcover'):
            return
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

    TROPE_MODELS_URLS = {
        'openrouter': 'https://openrouter.ai/api/v1/models',
        # v165: the native endpoint, not the OpenAI-compat one — the compat
        # /models list has no capability metadata and includes TTS / image /
        # video / embedding / live models that 404 on /chat/completions.
        'gemini': 'https://generativelanguage.googleapis.com/v1beta/models',
        'groq': 'https://api.groq.com/openai/v1/models',
        'ollama': 'http://localhost:11434/v1/models',
    }

    # v165: model families that support generateContent but are not text
    # chat on the OpenAI-compat endpoint.
    TROPE_GEMINI_NONCHAT_RE = re.compile(
        r'tts|image|video|veo|lyria|embed|robotics|computer-use|deep-research|'
        r'transcribe|aqa|antigravity|nano-banana|native-audio|live', re.IGNORECASE)

    @staticmethod
    def _map_gemini_models(parsed):
        """v165: native v1beta/models shape → [{id, name}], chat-capable only."""
        data = parsed.get('models') if isinstance(parsed, dict) else None
        models = []
        seen = set()
        for m in data if isinstance(data, list) else []:
            name = m.get('name') if isinstance(m, dict) else None
            if not name or not isinstance(name, str):
                continue
            methods = m.get('supportedGenerationMethods')
            if isinstance(methods, list) and 'generateContent' not in methods:
                continue
            mid = name[len('models/'):] if name.startswith('models/') else name
            if Handler.TROPE_GEMINI_NONCHAT_RE.search(mid):
                continue
            if mid in seen:
                continue
            seen.add(mid)
            label = m.get('displayName')
            if not isinstance(label, str) or not label:
                label = mid
            models.append({'id': mid, 'name': label})
            if len(models) >= 500:
                break
        return models

    def handle_api_trope_models(self):
        """GET /api/trope-models?provider=<id> → live model list.

        Mirrors functions/api/trope-models.js. Unlike the Pages edge, this
        server runs on the user's own machine, so ollama (localhost:11434)
        IS reachable and listed here. The key is resolved like
        handle_api_trope_infer and never leaves the server.
        """
        if not self._check_rate('trope-models'):
            return
        try:
            parts = self.path.split('?', 1)
            qs = urllib.parse.parse_qs(parts[1] if len(parts) > 1 else '')
            provider = (qs.get('provider', [''])[0] or '').strip().lower()
            if provider not in self.TROPE_MODELS_URLS:
                if provider == 'custom':
                    self._send_json(400, {'error': 'custom providers have no model list — type the model name'})
                else:
                    self._send_json(400, {'error': 'unknown provider'})
                return
            # Same key resolution as trope-infer. OpenRouter's list is public
            # and ollama is local/keyless — both work without a key.
            tc = load_trope_cfg()
            key = tc['keys'].get(provider) or \
                (tc['key'] if provider == tc['provider'] else '')
            if not key and provider not in ('openrouter', 'ollama'):
                self._send_json(503, {'error': "no API key configured for provider '%s' (set trope_key_%s)" % (provider, provider)})
                return
            headers = {'User-Agent': 'CozyLibram/1.0 trope-proxy'}
            if key:
                # v165: the native Gemini API takes the key in
                # x-goog-api-key (Bearer expects an OAuth token there).
                if provider == 'gemini':
                    headers['x-goog-api-key'] = key
                else:
                    headers['Authorization'] = 'Bearer ' + key
            req = urllib.request.Request(
                self.TROPE_MODELS_URLS[provider], headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    parsed = json.loads(r.read(2 * 1024 * 1024).decode('utf-8', 'replace'))
                    status = r.status
            except urllib.error.HTTPError as e:
                self._send_json(502, {'error': 'provider returned HTTP %d for the model list' % e.code})
                return
            if status != 200:
                self._send_json(502, {'error': 'provider returned HTTP %d for the model list' % status})
                return
            if provider == 'gemini':
                models = self._map_gemini_models(parsed)
            else:
                data = parsed.get('data') if isinstance(parsed, dict) else None
                models = []
                seen = set()
                for m in data if isinstance(data, list) else []:
                    mid = m.get('id') if isinstance(m, dict) else None
                    if not mid or not isinstance(mid, str):
                        continue
                    # Google's list returns canonical ids like
                    # "models/gemini-2.5-flash"; the chat endpoint takes the
                    # short name, so strip the prefix (and dedupe).
                    if mid.startswith('models/'):
                        mid = mid[len('models/'):]
                    if mid in seen:
                        continue
                    seen.add(mid)
                    name = m.get('name') if isinstance(m.get('name'), str) and m.get('name') else mid
                    models.append({'id': mid, 'name': name})
                    if len(models) >= 500:
                        break
            self._send_json(200, {'provider': provider, 'models': models})
        except Exception:
            try:
                self.send_error(502, 'model list fetch failed')
            except Exception:
                pass

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
        if not self._check_rate('trope-infer'):
            return
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

    def handle_api_read_cover(self):
        """POST /api/read-cover {image, mode:'single'} → vision model reads
        the printed ISBN (digits only), falling back to title/author when no
        ISBN is printed. Mirrors functions/api/read-cover.js. The Gemini key
        comes from server-config.json (vision_api_key, falling back to the
        already-configured trope_key_gemini) — the browser never sees it.
        v199 will add mode 'shelf' for bulk spine reading.

        Guards: POST only, mode allowlist, image is a capped data URL or raw
        base64 (the client downscales to ~1024px first). The client validates
        any returned ISBN's check digit before trusting it.
        """
        if not self._check_rate('read-cover'):
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 4 * 1024 * 1024)).decode(
                'utf-8', 'replace')
            body = json.loads(raw)
            if body.get('mode') != 'single':
                self.send_error(400, 'bad request')
                return
            image = body.get('image')
            if not isinstance(image, str) or not image or \
                    len(image) > 3500000:
                self.send_error(400, 'bad request')
                return
            if not image.startswith('data:'):
                image = 'data:image/jpeg;base64,' + image
            if not re.match(r'^data:image/(jpeg|png|webp);base64,', image):
                self.send_error(400, 'bad request')
                return
            vc = load_vision_cfg()
            if not vc['key']:
                self._send_json(503, {'error':
                    "cover reading isn't set up on this server "
                    "(set vision_api_key or trope_key_gemini)"})
                return
            if not TROPE_MODEL_RE.match(vc['model']):
                self._send_json(503, {'error': 'bad vision_model'})
                return
            upstream_obj = {
                'model': vc['model'],
                'temperature': 0,
                'max_tokens': 300,
                'response_format': {'type': 'json_object'},
                'messages': [{
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': VISION_PROMPT_SINGLE},
                        {'type': 'image_url',
                         'image_url': {'url': image}},
                    ],
                }],
            }
            req = urllib.request.Request(
                'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
                data=json.dumps(upstream_obj).encode('utf-8'),
                headers={'Content-Type': 'application/json',
                         'Authorization': 'Bearer ' + vc['key'],
                         'User-Agent': 'CozyLibram/1.0 read-cover'})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read(256 * 1024)
                status = r.status
            if status == 200:
                data = json.dumps(
                    self._clean_vision_result(json.loads(data))).encode('utf-8')
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
                self.send_error(502, 'cover reading failed')
            except Exception:
                pass

    @staticmethod
    def _clean_vision_result(parsed):
        """Keep only the expected string fields; drop ISBN-shaped junk."""
        try:
            content = (parsed.get('choices') or [{}])[0].get(
                'message', {}).get('content')
            # v198: strip markdown fences in case the model wraps the JSON.
            content = re.sub(r'^```(?:json)?\s*', '',
                             str(content or '').strip(), flags=re.I)
            content = re.sub(r'\s*```$', '', content)
            obj = json.loads(content)
        except Exception:
            return {'isbn': None, 'title': None, 'author': None}

        def s(v):
            return v.strip()[:300] if isinstance(v, str) and v.strip() \
                else None
        isbn = s(obj.get('isbn')) if isinstance(obj, dict) else None
        if isbn:
            isbn = re.sub(r'[^0-9X]', '', isbn).upper()
            if not re.match(r'^(\d{13}|\d{10}|\d{9}X)$', isbn):
                isbn = None
        return {'isbn': isbn,
                'title': s(obj.get('title')) if isinstance(obj, dict) else None,
                'author': s(obj.get('author')) if isinstance(obj, dict)
                else None}

    def handle_api_gbooks(self):
        """GET /api/gbooks/books/v1/volumes?... → Google Books, key attached.

        Mirrors functions/api/gbooks/[[path]].js. Only the volumes endpoint
        is allowed; a client-supplied key param is stripped and replaced.
        """
        if not self._check_rate('gbooks'):
            return
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
        if not self._check_rate('cover-proxy'):
            return
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
            # v194: opener re-validates every redirect hop against the SSRF
            # guard (urllib would otherwise follow them unchecked).
            with _COVER_OPENER.open(req, timeout=15) as r:
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
