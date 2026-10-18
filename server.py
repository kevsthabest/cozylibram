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
- /api/cache-cover: POST {url} → canonical Supabase Storage cover URL (v216).

Setup: copy server-config.example.json to server-config.json and paste your
Hardcover personal token and Google Books API key in it. server-config.json
is read by this server only — it is never committed to git.
"""
import hashlib
import ipaddress
import json
import os
import posixpath
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


def load_supabase_service_key():
    """v216: service key for server-side writes to the `covers` bucket.
    Owner-supplied: paste into server-config.json (never committed). Without
    it /api/cache-cover answers 503 and clients keep the remote URL."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return (json.load(f).get('supabase_service_key') or '').strip()
    except Exception:
        return ''


_BEARER_RE = re.compile(r'^Bearer\s+(\S+)$')


def _supabase_get(path, token, apikey, timeout):
    """One GET against the configured Supabase project; parsed JSON, or
    None on any failure (HTTP error, network, bad JSON). Never raises:
    the auth checks built on this fail closed for the user lookup and
    open only where the Pages code does."""
    cc = load_cloud_cfg()
    base = (cc['supabaseUrl'] or '').rstrip('/')
    if not base or not token or not apikey:
        return None
    req = urllib.request.Request(
        base + path,
        headers={'apikey': apikey, 'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None
            return json.loads(r.read(256 * 1024).decode('utf-8', 'replace'))
    except Exception:
        return None


def authed_user(headers):
    """Mirror of functions/_lib/require-user.js (v225; ban check v246).

    The client sends its Supabase session JWT as
    `Authorization: Bearer <token>` (apiFetch in js/050-helpers.js); this
    validates it against the Auth API of the Supabase project configured
    in server-config.json and returns the user object — or None when
    the caller is not signed in (missing/malformed header, unconfigured
    server, Supabase rejecting the token). A caller on banned_users
    comes back with banned=True: that lookup runs with the caller's own
    JWT so the "users see own" RLS policy applies, has a short timeout,
    and fails open (returns the user) exactly like the Pages version —
    the client-side sign-out check is the other enforcement point.
    Never raises."""
    try:
        m = _BEARER_RE.match(headers.get('Authorization') or '')
        if not m:
            return None
        token = m.group(1)
        cc = load_cloud_cfg()
        apikey = (cc['supabaseAnonKey'] or '').strip() or \
            load_supabase_service_key()
        if not (cc['supabaseUrl'] or '').strip() or not apikey:
            return None
        user = _supabase_get('/auth/v1/user', token, apikey, 10)
        if not isinstance(user, dict) or not user.get('id'):
            return None
        rows = _supabase_get(
            '/rest/v1/banned_users?user_id=eq.' +
            urllib.parse.quote(str(user['id']), safe='') + '&select=user_id',
            token, apikey, 4)
        if isinstance(rows, list) and rows:
            user = dict(user)
            user['banned'] = True
        return user
    except Exception:
        return None


def _supabase_fetch(method, url, headers, timeout=30):
    """One raw HTTP call for the admin endpoints; returns (status, body
    text) and never raises — status 0 means the request never completed.
    Callers map statuses onto the Pages error bodies."""
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(4 * 1024 * 1024).decode(
                'utf-8', 'replace')
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read(64 * 1024).decode('utf-8', 'replace')
        except Exception:
            return e.code, ''
    except Exception:
        return 0, ''


def _gemini_generate(model, key, payload):
    """POST a native Gemini generateContent call (the v1beta endpoint
    the Pages enhance-face / spine-search functions use, key in the
    x-goog-api-key header — never in the URL where it would land in
    server logs). Returns (status, parsed, text); status 0 on a
    network failure, parsed None on an unparseable body. Never raises.
    Single attempt, like the mirror's other provider calls."""
    url = ('https://generativelanguage.googleapis.com/v1beta/models/' +
           model + ':generateContent')
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode('utf-8'), method='POST',
        headers={'Content-Type': 'application/json',
                 'x-goog-api-key': key,
                 'User-Agent': 'CozyLibram/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read(16 * 1024 * 1024).decode('utf-8', 'replace')
            try:
                return r.status, json.loads(text), text
            except Exception:
                return r.status, None, text
    except urllib.error.HTTPError as e:
        try:
            return e.code, None, e.read(64 * 1024).decode(
                'utf-8', 'replace')
        except Exception:
            return e.code, None, ''
    except Exception:
        return 0, None, ''


# --- /api/spine-search helpers (mirror of functions/api/spine-search.js) --
_SPINE_IMG_RE = re.compile(
    r'^https?://[^\s"\'<>]+?\.(?:jpg|jpeg|png|webp)'
    r'(?:\?[^\s"\'<>]*)?$', re.I)
_SPINE_URL_IN_TEXT_RE = re.compile(
    r'https?://[^\s"\'<>]+?\.(?:jpg|jpeg|png|webp)'
    r'(?:\?[^\s"\'<>]*)?', re.I)


def _spine_search_query(title, author):
    return '"' + title + '"' + \
        ((' ' + author) if author else '') + ' book spine'


def _spine_search_prompt(title, author):
    return (
        'Find a real photograph or product image of the physical SPINE '
        '(the bound edge, seen edge-on \u2014 not the front cover) of '
        'this exact book:\n'
        'Title: "' + title + '"' +
        (('\nAuthor: "' + author + '"') if author else '') +
        '\nSearch the web (bookstores, publisher pages, library '
        'catalogues, collector and marketplace listings, reviews, '
        'photos of the book on a shelf). Prefer a straight-on, '
        'well-lit spine photo where the full spine (top to bottom) is '
        'visible.\n'
        'Reply with ONLY a JSON object of the form '
        '{"candidates": [{"image_url": "<direct image URL>", '
        '"page_url": "<page the image is on>", "note": "<short note, '
        'e.g. publisher or edition>"}]} with up to 5 candidates, best '
        'first. image_url must end in .jpg, .jpeg, .png, or .webp. '
        'Never invent or guess a URL \u2014 only include an image_url '
        'that appeared in your search results. If you cannot find a '
        'spine image, reply {"candidates": []}.')


def _spine_candidate(img, page, note):
    return {
        'image_url': img[:500],
        'page_url': page[:500] if page.startswith('http') else None,
        'note': (note.strip()[:200] or None) if note else None,
    }


def _clean_spine_search_candidates(list_in):
    """Model-proposed candidates are untrusted: keep only direct image
    URLs on http(s), dedupe case-insensitively, cap the list."""
    out, seen = [], set()
    if not isinstance(list_in, list):
        return out
    for c in list_in:
        if len(out) >= 5:
            break
        if not isinstance(c, dict):
            continue
        img = str(c.get('image_url') or '').strip()
        if not _SPINE_IMG_RE.match(img) or img.lower() in seen:
            continue
        seen.add(img.lower())
        out.append(_spine_candidate(
            img, str(c.get('page_url') or '').strip(),
            str(c.get('note') or '')))
    return out


def _clean_brave_candidates(results):
    """Brave image results: properties.url is the direct image, url is
    the page it sits on, title is the note. Same distrust rules."""
    out, seen = [], set()
    if not isinstance(results, list):
        return out
    for r in results:
        if len(out) >= 5:
            break
        if not isinstance(r, dict):
            continue
        img = str((r.get('properties') or {}).get('url') or '').strip()
        if not _SPINE_IMG_RE.match(img) or img.lower() in seen:
            continue
        seen.add(img.lower())
        out.append(_spine_candidate(
            img, str(r.get('url') or '').strip(),
            str(r.get('title') or '')))
    return out


def _spine_search_sources(data):
    """Grounding sources behind a spine-search answer, for the result
    card's Sources list."""
    out = []
    try:
        chunks = (((data.get('candidates') or [{}])[0]
                   .get('groundingMetadata') or {})
                  .get('groundingChunks') or [])
    except Exception:
        return out
    for ch in chunks:
        web = (ch or {}).get('web') or {}
        uri = str(web.get('uri') or '').strip()
        if uri.startswith('http'):
            out.append({'uri': uri[:500],
                        'title': str(web.get('title') or '').strip()[:200]})
        if len(out) >= 8:
            break
    return out


def _spine_urls_from_text(text):
    """Fallback when the model didn't answer in JSON: salvage any
    direct image URLs out of its prose."""
    seen, urls = set(), []
    for m in _SPINE_URL_IN_TEXT_RE.finditer(text or ''):
        u = m.group(0)
        if u.lower() not in seen:
            seen.add(u.lower())
            urls.append(u)
        if len(urls) >= 5:
            break
    return urls


# --- /api/enhance-face prompts (verbatim from functions/api/enhance-face.js)
# Enhancement, never regeneration: the model may only work with what's
# in the photo. Every "do not invent" clause exists because an earlier
# build cheerfully re-lettered a cover with made-up text.
ENHANCE_PROMPTS = {
    'sharpen': (
        'Enhance this book cover photo. The photo shows a real book '
        'cover that is slightly soft, blurry, or out of focus. Sharpen '
        'the existing cover artwork and its printed text so edges and '
        'lettering are crisp. Work ONLY with what is already in the '
        'image: do not redraw, repaint, restyle, rearrange, add, or '
        'remove any element of the cover. Do not change colors, '
        'composition, wording, or lettering. Do not invent detail, '
        'texture, or background. If part of the cover is cut off, '
        'leave it cut off. The output must look like the exact same '
        'cover photographed in perfect focus.'),
    'restore': (
        'Restore this photo of a book cover. The photo may be blurry, '
        'skewed, glared, shadowed, or slightly faded. Produce a clean, '
        'straight-on, evenly lit, sharp version of the SAME cover: '
        'correct perspective, remove glare and shadows, restore faded '
        'color and contrast. Work ONLY with what is already in the '
        'image: do not redraw, repaint, restyle, rearrange, add, or '
        'remove any element of the cover. Keep the title, author name, '
        'artwork, and wording exactly as they are \u2014 never '
        're-letter, retype, or rewrite text; if text is unreadable, '
        'keep the original lettering rather than inventing words. Do '
        'not invent detail or background. If part of the cover is cut '
        'off, leave it cut off \u2014 do not reconstruct missing parts '
        'of the cover. The result must be recognizably the exact same '
        'edition of the same book, just photographed well.'),
}

# Per-user tables the admin delete_user action wipes, in the Pages order
# (functions/api/admin-users.js PER_USER_TABLES): every row owned by the
# user across these goes, then the auth user itself.
_ADMIN_PER_USER_TABLES = ('analytics_events', 'banned_users', 'books',
                          'circle_invites', 'deleted_books', 'profiles',
                          'trope_proposal_votes', 'trope_votes')


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
    (default gemini-3.8-flash)."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            d = json.load(f)
        key = (d.get('vision_api_key') or '').strip() or \
            (d.get('trope_key_gemini') or '').strip()
        return {'key': key,
                'model': (d.get('vision_model') or 'gemini-3.8-flash').strip()}
    except Exception:
        return {'key': '', 'model': 'gemini-3.8-flash'}


def load_enhance_model():
    """Image-edit model for /api/enhance-face (v281): server-config key
    enhance_model, default gemini-2.5-flash-image — the Pages function's
    ENHANCE_MODEL default."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return (json.load(f).get('enhance_model')
                    or 'gemini-2.5-flash-image').strip()
    except Exception:
        return 'gemini-2.5-flash-image'


def load_brave_key():
    """Brave image-search key for /api/spine-search (v268):
    server-config key brave_search_api_key. Without it the endpoint
    uses the Gemini-grounded search, as on Pages."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return (json.load(f).get('brave_search_api_key') or '').strip()
    except Exception:
        return ''


VISION_PROMPT_SINGLE = (
    'You are reading a photo of a book cover. Return a JSON object with '
    'exactly these keys: "isbn" (the printed ISBN digits with no dashes or '
    'spaces, or null if no ISBN is printed \u2014 pre-1970 books have none), '
    '"title" (or null), "author" (or null). The ISBN is usually printed near '
    'the barcode on the back cover. Prefer the ISBN when one is visible. '
    'Reply with ONLY the JSON object, no other text.')

# v199: bulk bookshelf spine scanning — spines left to right, readable
# title/author candidates for the client to look up and review.
VISION_PROMPT_SHELF = (
    'You are reading a photo of a bookshelf. List the books whose spines '
    'you can read, in left-to-right order. Return a JSON object with exactly '
    'one key, "books": an array (up to 30) of objects with "title", '
    '"author", and "confidence" ("high" for clearly legible spines, '
    '"medium" for partly legible or guessed letters, "low" for very '
    'uncertain). Use null for a title or author you cannot read; skip spines '
    'you cannot read at all. Vertical text, foil, and small print are common '
    '\u2014 transcribe carefully. Reply with ONLY the JSON object, no other '
    'text.')
# v258: single close-up spine photo -> tight bounding box, for the crop
# UI's pre-fit. Mirrors PROMPT_SPINE in functions/api/read-cover.js.
VISION_PROMPT_SPINE = (
    'You are looking at a close-up photo of one book spine (the photo '
    'may also show table, background, or neighboring spines at the '
    'edges). Find the single most prominent, centered book spine and '
    'return a JSON object with exactly one key, "box": an object with '
    '"x0", "y0", "x1", "y1" \u2014 the tight bounding box of that spine '
    'as integers from 0 to 1000 (fractions of image width/height), '
    'hugging the spine edges as closely as possible and excluding '
    'background. The spine is the physical book\u2019s bound edge: its '
    'top and bottom are where the BOOK ends \u2014 never extend the box '
    'upward into screens, monitors, walls, shelves, or other '
    'background, nor downward past the book. A glowing screen is never '
    'part of a book spine. The spine usually has title text running '
    'along its length. If no book spine is visible, return '
    '{"box": null}. Reply with ONLY the JSON object, no other text.')
VISION_MAX_SHELF_SPINES = 30


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

# v216: allowlist for /api/cache-cover — mirrors functions/api/cache-cover.js.
# Hosts we adopt covers from (verified against live library data 2026-09-30).
# Not listed ⇒ unreachable by construction (same SSRF shape as cover-proxy.js).
_CACHE_COVER_HOSTS = frozenset([
    'covers.openlibrary.org',
    'books.google.com',
    'assets.hardcover.app',
    'images-na.ssl-images-amazon.com',
    'm.media-amazon.com',
    'i.gr-assets.com',
    'archive.org',  # Open Library cover redirects
    'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
    'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com',  # Apple Books artwork
])
_COVER_EXT = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
              'image/gif': 'gif', 'image/avif': 'avif'}

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
    'inventaire': (120, 60),
    'trope-models': (60, 60),
    'embed': (30, 60),         # same numbers as functions/api/embed.js
    'enhance-face': (10, 60),  # same numbers as functions/api/enhance-face.js
    'spine-search': (10, 60),  # same numbers as functions/api/spine-search.js
    'cover-proxy': (120, 60),
    'cache-cover': (300, 60),   # v216: bulk backfill paces itself at ~150/min
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


# SEC-03 (2026-10-01): allowlist the Hardcover query shapes the app actually
# sends. Mirrors functions/api/hardcover.js. Every app query is an anonymous
# `query { <root>(...) { ... } }` whose root field is one of these
# (js/070-hardcover.js and its callers); anything else is rejected with 403.
# A single anonymous query operation is read-only by construction (a mutation
# needs the `mutation` operation keyword), and introspection is blocked
# explicitly.
_HC_ALLOWED_ROOTS = frozenset({'search', 'books', 'editions', 'series'})
_HC_QUERY_RE = re.compile(r'^\s*query\s*\{')
_HC_ROOT_RE = re.compile(r'^\s*query\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)')
_HC_STRING_RE = re.compile(r'"(?:[^"\\]|\\.)*"')
_HC_OP_KEYWORDS_RE = re.compile(r'\b(mutation|subscription)\b', re.IGNORECASE)
_HC_SECOND_OP_RE = re.compile(r'\}\s*(query|mutation|subscription)\b', re.IGNORECASE)

def hc_query_allowed(query):
    q = str(query or '')
    if not _HC_QUERY_RE.match(q):
        return False
    # Strip string literals first: a book titled "Mutation" must neither
    # trip the keyword checks nor hide an attack inside a string.
    stripped = _HC_STRING_RE.sub('""', q).lower()
    if '__schema' in stripped or '__type' in stripped:
        return False
    if _HC_OP_KEYWORDS_RE.search(stripped):
        return False
    if _HC_SECOND_OP_RE.search(stripped):
        return False  # multi-operation docs can't run without operationName anyway
    m = _HC_ROOT_RE.match(q)
    return bool(m) and m.group(1) in _HC_ALLOWED_ROOTS


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
    # SEC-01a (2026-10-01): never serve secrets or VCS internals, no matter
    # who reaches the port. The v53 LAN/WAN gating was removed at the owner's
    # request, so this blocklist is the remaining guard. 404 (not 403) so the
    # existence of these paths isn't confirmed.
    _BLOCKED_EXACT = {'/server-config.json', '/.git'}
    _BLOCKED_SUFFIXES = ('.pem', '.key')
    _BLOCKED_BASENAMES = {'.env'}

    def _path_blocked(self, raw_path):
        # Judge the path the file server will actually resolve, not the
        # raw request spelling: translate_path() unquotes the path and
        # posixpath-normalizes it (dot segments dropped, duplicate
        # separators collapsed, parent segments resolved) before joining
        # it under the served directory. Running the checks on the raw
        # path let spellings like //server-config.json or
        # /x/../server-config.json slip past the exact matches and land
        # on the real file (issue #338) — so normalize first, exactly as
        # translate_path does, then check. The leading-slash collapse is
        # the one extra step: posixpath.normpath preserves a leading '//'
        # (POSIX implementation-defined), translate_path's word filter
        # does not.
        p = urllib.parse.unquote(raw_path.split('?')[0])
        p = '/' + posixpath.normpath(p).lstrip('/')
        if p in self._BLOCKED_EXACT or p.startswith('/.git/'):
            return True
        base = p.rsplit('/', 1)[-1]
        if base in self._BLOCKED_BASENAMES or base.startswith('.env.'):
            return True
        return base.endswith(self._BLOCKED_SUFFIXES)

    def do_GET(self):
        path = self.path.split('?')[0]
        if self._path_blocked(path):
            self.send_error(404)
            return
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
        if path.startswith('/api/inventaire/'):
            self.handle_api_inventaire()
            return
        if path == '/api/trope-models':
            self.handle_api_trope_models()
            return
        super().do_GET()

    def do_HEAD(self):
        # Same blocklist as do_GET: SimpleHTTPRequestHandler serves HEAD
        # separately, and headers alone would confirm a secret file exists.
        if self._path_blocked(self.path.split('?')[0]):
            self.send_error(404)
            return
        super().do_HEAD()

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
        if path == '/api/embed':
            self.handle_api_embed()
            return
        if path == '/api/cache-cover':
            self.handle_api_cache_cover()
            return
        if path == '/api/enhance-face':
            self.handle_api_enhance_face()
            return
        if path == '/api/spine-search':
            self.handle_api_spine_search()
            return
        if path == '/api/admin-users':
            self.handle_api_admin_users()
            return
        self.send_error(404)

    def _require_auth(self):
        """v225 parity: /api/* is signed-in only, like the Pages
        functions — this mirror spent the same metered quotas (and, for
        cache-cover, service-key writes) for anyone who could reach the
        port (issue #339). 401 with no valid session, 403 for a banned
        account (v246); the JSON bodies match require-user.js."""
        user = authed_user(self.headers)
        if user is None:
            self._send_json(401, {'error': 'sign-in required'})
            return False
        if user.get('banned'):
            self._send_json(403, {'error': 'account suspended'})
            return False
        return True

    def _require_admin(self):
        """The caller's user id when they are a signed-in app admin,
        else None (the error response has already been sent). Shared by
        the admin endpoints (v246): the sign-in gate first, then the
        app_admins check with the service key — the client's is_admin
        flag is never trusted. Fails closed, as on Pages: an
        unconfigured server is a 500, a failed lookup is a 500, a
        non-admin is a 403."""
        user = authed_user(self.headers)
        if user is None:
            self._send_json(401, {'error': 'sign-in required'})
            return None
        if user.get('banned'):
            self._send_json(403, {'error': 'account suspended'})
            return None
        cc = load_cloud_cfg()
        svc = load_supabase_service_key()
        base = (cc['supabaseUrl'] or '').rstrip('/')
        if not base or not svc:
            self._send_json(500, {'error': 'server misconfigured'})
            return None
        status, text = _supabase_fetch(
            'GET', base + '/rest/v1/app_admins?user_id=eq.' +
            urllib.parse.quote(str(user['id']), safe='') +
            '&select=user_id',
            {'apikey': svc, 'Authorization': 'Bearer ' + svc})
        rows = None
        if status == 200:
            try:
                rows = json.loads(text)
            except Exception:
                rows = None
        if rows is None:
            self._send_json(500, {'error': 'admin check failed'})
            return None
        if not rows:
            self._send_json(403, {'error': 'admin only'})
            return None
        return str(user['id'])

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
        if not self._require_auth():
            return
        if not self._check_rate('hardcover'):
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 65536)).decode('utf-8', 'replace')
            query = json.loads(raw).get('query') or ''
            if not isinstance(query, str) or not query or len(query) > 8000:
                self.send_error(400, 'bad request')
                return
            if not hc_query_allowed(query):
                self.send_error(403, 'query shape not allowed')
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
        if not self._require_auth():
            return
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
        if not self._require_auth():
            return
        if not self._check_rate('trope-infer'):
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            # The read cap must cover the largest body the validation
            # below accepts — 20 messages x 20,000 chars, the Pages
            # contract (~400 KB of text). This was 64 KB, which cut
            # legal bodies off mid-JSON (issue #351); validation, not
            # the socket read, is the size guard. 4 MB matches the cap
            # read-cover uses in this file.
            raw = self.rfile.read(min(length, 4 * 1024 * 1024)).decode('utf-8', 'replace')
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

    def handle_api_embed(self):
        """POST /api/embed {texts} → text embeddings.

        The home server has no Workers AI binding, so embeddings are not
        available over LAN — the Cloudflare Pages Function serves them in
        production. Always 503 here; the client degrades to loved-author
        ranking instead of failing.
        """
        if not self._require_auth():
            return
        if not self._check_rate('embed'):
            return
        try:
            self._send_json(503, {'error': 'embeddings not set up: add a Workers AI binding ' +
                'named AI to this Pages project (Settings → Functions → Workers AI bindings)'})
        except Exception:
            pass

    def handle_api_cache_cover(self):
        """POST /api/cache-cover {url} → canonical bucket URL (v216).

        Mirrors functions/api/cache-cover.js for local-dev parity. Fetches
        the cover server-side, stores one content-addressed copy in the
        Supabase Storage `covers` bucket, and returns the public URL.
        Guards: POST only, rate limit, https + host allowlist (SSRF), 4 MB
        cap, must be an image. Needs supabase_service_key in
        server-config.json (owner-supplied) — without it → 503 and the client
        keeps the remote URL. Every failure falls back to the remote URL;
        a cover is never lost here.
        """
        if not self._require_auth():
            return
        if not self._check_rate('cache-cover'):
            return
        try:
            cc = load_cloud_cfg()
            svc = load_supabase_service_key()
            supa_url = (cc['supabaseUrl'] or '').rstrip('/')
            if not supa_url or not svc:
                self._send_json(503, {'error': 'cover cache not configured'})
                return
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 65536)).decode('utf-8', 'replace')
            body = json.loads(raw)
            url = str(body.get('url') or '').strip()[:2000]
            if not re.match(r'^https://', url, re.I):
                self._send_json(400, {'error': 'not an https url'})
                return
            host = (urllib.parse.urlparse(url).hostname or '').lower()
            if host not in _CACHE_COVER_HOSTS:
                self._send_json(403, {'error': 'host not allowed'})
                return
            req = urllib.request.Request(
                url, headers={'User-Agent': 'CozyLibram/1.0 cache-cover'})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read(4 * 1024 * 1024 + 1)
                ctype = r.headers.get('Content-Type',
                                      'application/octet-stream').split(';')[0].strip().lower()
            if not ctype.startswith('image/'):
                self._send_json(502, {'error': 'not an image'})
                return
            if len(data) > 4 * 1024 * 1024:
                self._send_json(502, {'error': 'image too large'})
                return
            key = hashlib.sha256(data).hexdigest() + '.' + _COVER_EXT.get(ctype, 'jpg')
            up = urllib.request.Request(
                supa_url + '/storage/v1/object/covers/' + key, data=data, method='POST',
                headers={'apikey': svc, 'Authorization': 'Bearer ' + svc,
                         'Content-Type': ctype, 'x-upsert': 'false'})
            try:
                urllib.request.urlopen(up, timeout=20).read()
            except urllib.error.HTTPError as e:
                eb = e.read(4096).decode('utf-8', 'replace')
                # Duplicate upload = dedup hit: the canonical copy already exists.
                if not (e.code in (400, 409) and
                        re.search(r'duplicate|already exists', eb, re.I)):
                    self._send_json(502, {'error': 'cover store rejected the upload'})
                    return
            self._send_json(200, {'coverUrl':
                supa_url + '/storage/v1/object/public/covers/' + key})
        except Exception:
            try:
                self._send_json(502, {'error': 'cover cache failed'})
            except Exception:
                pass

    def handle_api_enhance_face(self):
        """POST /api/enhance-face {image, mode} → enhanced photo (v281).
        Mirrors functions/api/enhance-face.js: an image-edit call on the
        native Gemini endpoint (the OpenAI-compatible endpoint cannot
        return images) that may only work with what's in the photo —
        glares/sharpens/restores, never regenerates. Ordering matches
        Pages: body validated first, then sign-in, then rate limit,
        then the key check."""
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            length = 0
        raw = self.rfile.read(min(length, 4 * 1024 * 1024)) \
            if length > 0 else b''
        try:
            body = json.loads(raw.decode('utf-8')) \
                if raw.strip() else None
        except Exception:
            body = None
        if not isinstance(body, dict):
            self.send_error(400, 'bad request')
            return
        mode = body.get('mode')
        image = body.get('image')
        if mode not in ('sharpen', 'restore') \
                or not isinstance(image, str) or not image \
                or len(image) > 3500000:
            self.send_error(400, 'bad request')
            return
        if not image.startswith('data:'):
            image = 'data:image/jpeg;base64,' + image
        if not re.match(r'^data:image/(jpeg|png|webp);base64,', image):
            self.send_error(400, 'bad request')
            return
        if not self._require_auth():
            return
        if not self._check_rate('enhance-face'):
            return
        vc = load_vision_cfg()
        if not vc['key']:
            self._send_json(503, {'error':
                "face enhancement isn't set up on this server "
                "(set vision_api_key or trope_key_gemini)"})
            return
        model = load_enhance_model()
        if not TROPE_MODEL_RE.match(model):
            self._send_json(503, {'error': 'bad enhance_model'})
            return
        payload = {
            'contents': [{'parts': [
                {'text': ENHANCE_PROMPTS[mode]},
                {'inlineData': {'mimeType': 'image/jpeg',
                                'data': image.split(',', 1)[1]}}]}],
            'generationConfig': {'responseModalities': ['TEXT', 'IMAGE']},
        }
        status, parsed, text = _gemini_generate(model, vc['key'], payload)
        if status == 0:
            self._send_json(502, {'error': 'enhance provider unreachable'})
            return
        if status == 503:
            self._send_json(502, {'error':
                'enhance model temporarily unavailable (upstream 503)'})
            return
        if status != 200:
            body_bytes = text.encode('utf-8') if text else b'{}'
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body_bytes)))
            self.end_headers()
            self.wfile.write(body_bytes)
            return
        parts = []
        if isinstance(parsed, dict):
            parts = (((parsed.get('candidates') or [{}])[0]
                      .get('content') or {}).get('parts') or [])
        out = None
        for part in parts:
            inline = (part or {}).get('inlineData') or {}
            if inline.get('data'):
                out = 'data:' + (inline.get('mimeType') or 'image/png') \
                    + ';base64,' + inline['data']
                break
        if not out:
            self._send_json(502, {'error':
                'enhance model returned no image'})
            return
        self._send_json(200, {'image': out})

    def handle_api_spine_search(self):
        """POST /api/spine-search {title, author?} → spine-photo
        candidates (v268). Mirrors functions/api/spine-search.js:
        admin-only (the client gate is a menu filter, not a check).
        Brave image search when a key is configured; otherwise a
        Gemini call with web grounding ON THIS SERVER's key. The
        model's candidate URLs are untrusted and are cleaned before
        they reach the client. Rate limit first, as on Pages."""
        if not self._check_rate('spine-search'):
            return
        if self._require_admin() is None:
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            length = 0
        raw = self.rfile.read(min(length, 64 * 1024)) \
            if length > 0 else b''
        try:
            body = json.loads(raw.decode('utf-8')) \
                if raw.strip() else {}
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        title = str(body.get('title') or '').strip()[:200]
        author = str(body.get('author') or '').strip()[:200]
        if not title:
            self._send_json(400, {'error': 'title is required'})
            return
        brave_key = load_brave_key()
        if brave_key:
            query = _spine_search_query(title, author)
            url = ('https://api.search.brave.com/res/v1/images/search'
                   '?q=' + urllib.parse.quote(query) +
                   '&count=8&safesearch=strict')
            req = urllib.request.Request(url, headers={
                'X-Subscription-Token': brave_key,
                'Accept': 'application/json',
                'User-Agent': 'CozyLibram/1.0 spine-search'})
            status, parsed, _t = 0, None, ''
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    _t = r.read(4 * 1024 * 1024).decode('utf-8', 'replace')
                    status = r.status
                parsed = json.loads(_t)
            except urllib.error.HTTPError as e:
                status = e.code
            except Exception:
                status = 0
            if status == 0:
                self._send_json(502, {'error': 'image search unreachable'})
                return
            if status == 429:
                self._send_json(502, {'error':
                    'image search is rate-limiting right now — '
                    'wait a minute and try again'})
                return
            if status in (401, 403):
                self._send_json(502, {'error':
                    'image search key rejected — '
                    'check the Brave API key'})
                return
            if status != 200:
                self._send_json(502, {'error':
                    'image search error (upstream %d)' % status})
                return
            if parsed is None:
                self._send_json(502, {'error':
                    'image search returned an unreadable answer'})
                return
            self._send_json(200, {
                'candidates':
                    _clean_brave_candidates(parsed.get('results')),
                'sources': [], 'via': 'brave'})
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
        payload = {
            'contents': [{'parts': [
                {'text': _spine_search_prompt(title, author)}]}],
            'tools': [{'google_search': {}}],
            'generationConfig': {
                'responseMimeType': 'application/json',
                'temperature': 0, 'maxOutputTokens': 1500},
        }
        status, parsed, _t = _gemini_generate(
            vc['model'], vc['key'], payload)
        if status == 0:
            self._send_json(502, {'error': 'vision provider unreachable'})
            return
        if status == 429:
            self._send_json(502, {'error':
                'Gemini is rate-limiting this key right now — '
                'wait a minute and try again'})
            return
        if status != 200:
            self._send_json(502, {'error':
                'vision provider error (upstream %d)' % status})
            return
        if parsed is None:
            self._send_json(502, {'error':
                'vision provider returned an unreadable answer'})
            return
        parts = (((parsed.get('candidates') or [{}])[0]
                  .get('content') or {}).get('parts') or [])
        text = ''.join(str((p or {}).get('text') or '') for p in parts)
        try:
            answer = json.loads(text)
            candidates = _clean_spine_search_candidates(
                answer.get('candidates'))
        except Exception:
            candidates = [{'image_url': u, 'page_url': None,
                           'note': 'scraped from answer text'}
                          for u in _spine_urls_from_text(text)]
        self._send_json(200, {'candidates': candidates,
                              'sources': _spine_search_sources(parsed)})

    def handle_api_admin_users(self):
        """POST /api/admin-users {action} → admin user management
        (v246). Mirrors functions/api/admin-users.js: list_users pages
        the Auth admin API into the id→email directory the Observatory
        renders with; delete_user wipes the target's per-user rows and
        deletes the auth user. Admin-only (see _require_admin), and an
        admin can never delete themself or another admin here."""
        caller = self._require_admin()
        if caller is None:
            return
        cc = load_cloud_cfg()
        svc = load_supabase_service_key()
        base = (cc['supabaseUrl'] or '').rstrip('/')
        svc_headers = {'apikey': svc, 'Authorization': 'Bearer ' + svc}
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            length = 0
        raw = self.rfile.read(min(length, 64 * 1024)) \
            if length > 0 else b''
        try:
            body = json.loads(raw.decode('utf-8')) \
                if raw.strip() else {}
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        action = body.get('action')
        if action == 'list_users':
            users = []
            for page in range(1, 51):
                status, text = _supabase_fetch(
                    'GET', base + '/auth/v1/admin/users?per_page=100'
                    '&page=%d' % page, svc_headers)
                batch = None
                if status == 200:
                    try:
                        data = json.loads(text)
                        batch = data.get('users') if isinstance(
                            data, dict) else data
                    except Exception:
                        batch = None
                if not isinstance(batch, list):
                    self._send_json(500, {'error': 'user list failed'})
                    return
                for u in batch:
                    if isinstance(u, dict) and u.get('id'):
                        users.append({
                            'user_id': u['id'],
                            'email': u.get('email'),
                            'created_at': u.get('created_at'),
                            'last_sign_in_at': u.get('last_sign_in_at')})
                if len(batch) < 100:
                    break
            self._send_json(200, {'users': users})
            return
        if action == 'delete_user':
            target = body.get('target_user_id')
            if not target or not isinstance(target, str):
                self._send_json(400, {'error':
                    'target_user_id required'})
                return
            if target == caller:
                self._send_json(400, {'error':
                    'cannot delete your own account here'})
                return
            status, text = _supabase_fetch(
                'GET', base + '/rest/v1/app_admins?user_id=eq.' +
                urllib.parse.quote(target, safe='') + '&select=user_id',
                svc_headers)
            rows = None
            if status == 200:
                try:
                    rows = json.loads(text)
                except Exception:
                    rows = None
            if rows:
                self._send_json(400, {'error':
                    'cannot delete an admin account'})
                return
            wipes = [(t, 'user_id') for t in _ADMIN_PER_USER_TABLES]
            wipes += [('circle_links', 'requester_id'),
                      ('circle_links', 'addressee_id'),
                      ('user_reports', 'reporter_id'),
                      ('user_reports', 'reported_user_id')]
            for table, col in wipes:
                status, _t = _supabase_fetch(
                    'DELETE', base + '/rest/v1/' + table + '?' + col +
                    '=eq.' + urllib.parse.quote(target, safe=''),
                    svc_headers)
                if not (200 <= status < 300):
                    self._send_json(500, {'error':
                        'wipe failed on ' + table})
                    return
            status, text = _supabase_fetch(
                'DELETE', base + '/auth/v1/admin/users/' +
                urllib.parse.quote(target, safe=''), svc_headers)
            if not (200 <= status < 300):
                self._send_json(500, {'error': 'auth deletion failed',
                                      'detail': (text or '')[:200]})
                return
            self._send_json(200, {'ok': True})
            return
        self._send_json(400, {'error': 'unknown action'})

    def handle_api_read_cover(self):
        """POST /api/read-cover {image, mode} → vision model.
        mode 'single' reads the printed ISBN (digits only), falling back to
        title/author when no ISBN is printed. mode 'shelf' (v199) reads
        bookshelf spines left-to-right and returns title/author candidates
        for the client to look up and review — nothing is added silently.
        mode 'spine' (v258) finds the one spine in a close-up photo and
        returns its bounding box for the crop UI's pre-fit.
        Mirrors functions/api/read-cover.js. The Gemini key
        comes from server-config.json (vision_api_key, falling back to the
        already-configured trope_key_gemini) — the browser never sees it.

        Guards: POST only, mode allowlist, image is a capped data URL or raw
        base64 (the client downscales to ~1024px first). The client validates
        any returned ISBN's check digit before trusting it.
        """
        if not self._require_auth():
            return
        if not self._check_rate('read-cover'):
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(min(length, 4 * 1024 * 1024)).decode(
                'utf-8', 'replace')
            body = json.loads(raw)
            mode = body.get('mode')
            if mode not in ('single', 'shelf', 'spine'):
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
            is_shelf = (mode == 'shelf')
            is_spine = (mode == 'spine')
            upstream_obj = {
                'model': vc['model'],
                'temperature': 0,
                'max_tokens': 2000 if is_shelf else 300,
                'response_format': {'type': 'json_object'},
                'messages': [{
                    'role': 'user',
                    'content': [
                        {'type': 'text',
                         'text': VISION_PROMPT_SHELF if is_shelf
                         else VISION_PROMPT_SPINE if is_spine
                         else VISION_PROMPT_SINGLE},
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
                parsed = json.loads(data)
                if is_shelf:
                    cleaned = self._clean_shelf_result(parsed)
                elif is_spine:
                    cleaned = self._clean_spine_result(parsed)
                else:
                    cleaned = self._clean_vision_result(parsed)
                data = json.dumps(cleaned).encode('utf-8')
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

    @staticmethod
    def _clean_shelf_result(parsed):
        """v199: sanitize a shelf-mode model answer into
        {'books': [{title, author, confidence}]} — capped, allowlisted."""
        try:
            content = (parsed.get('choices') or [{}])[0].get(
                'message', {}).get('content')
            content = re.sub(r'^```(?:json)?\s*', '',
                             str(content or '').strip(), flags=re.I)
            content = re.sub(r'\s*```$', '', content)
            obj = json.loads(content)
            arr = obj.get('books') if isinstance(obj, dict) else None
            if not isinstance(arr, list):
                return {'books': []}
        except Exception:
            return {'books': []}

        def s(v):
            return v.strip()[:300] if isinstance(v, str) and v.strip() \
                else None
        out = []
        for b in arr:
            if not isinstance(b, dict):
                continue
            title, author = s(b.get('title')), s(b.get('author'))
            if not title and not author:
                continue
            conf = b.get('confidence')
            if conf not in ('high', 'medium', 'low'):
                conf = 'low'
            out.append({'title': title, 'author': author,
                        'confidence': conf})
            if len(out) >= VISION_MAX_SHELF_SPINES:
                break
        return {'books': out}

    @staticmethod
    def _clean_spine_result(parsed):
        """v258: sanitize a spine-mode model answer into
        {'box': {x0, y0, x1, y1} | None} — mirrors cleanSpineResult in
        functions/api/read-cover.js. Coordinates are fractions of the
        image (0-1000, rounded, clamped); a box with a missing or
        non-numeric coordinate, or one implausibly thin (<5 wide or
        <20 tall), is dropped to None, never trusted blindly."""
        try:
            content = (parsed.get('choices') or [{}])[0].get(
                'message', {}).get('content')
            content = re.sub(r'^```(?:json)?\s*', '',
                             str(content or '').strip(), flags=re.I)
            content = re.sub(r'\s*```$', '', content)
            obj = json.loads(content)
            box = obj.get('box') if isinstance(obj, dict) else None
            if not isinstance(box, dict):
                return {'box': None}
        except Exception:
            return {'box': None}

        def c(v):
            # Number(v) semantics for JSON values, as in the Pages
            # cleaner: null -> 0, booleans -> 1/0, numeric strings
            # parse; anything else is NaN and makes the box unusable.
            if v is None:
                n = 0.0
            elif isinstance(v, bool):
                n = 1.0 if v else 0.0
            elif isinstance(v, (int, float)):
                n = float(v)
            elif isinstance(v, str):
                try:
                    n = float(v.strip())
                except ValueError:
                    return None
            else:
                return None
            if n != n or n in (float('inf'), float('-inf')):
                return None
            return max(0, min(1000, int(round(n))))

        x0, y0 = c(box.get('x0')), c(box.get('y0'))
        x1, y1 = c(box.get('x1')), c(box.get('y1'))
        if None in (x0, y0, x1, y1):
            return {'box': None}
        if x1 - x0 < 5 or y1 - y0 < 20:
            return {'box': None}
        return {'box': {'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1}}

    def handle_api_gbooks(self):
        """GET /api/gbooks/books/v1/volumes?... → Google Books, key attached.

        Mirrors functions/api/gbooks/[[path]].js. Only the volumes endpoint
        is allowed; a client-supplied key param is stripped and replaced.
        """
        if not self._require_auth():
            return
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

    def handle_api_inventaire(self):
        """GET /api/inventaire/entities?... → Inventaire API.

        Mirrors functions/api/inventaire/[[path]].js. Only the entities
        endpoint is allowed; no key needed — the identifying User-Agent
        Inventaire asks for is set server-side.
        """
        if not self._require_auth():
            return
        if not self._check_rate('inventaire'):
            return
        try:
            parts = self.path.split('?', 1)
            subpath = parts[0][len('/api/inventaire/'):]
            if subpath != 'entities':
                self.send_error(404)
                return
            qs = parts[1] if len(parts) > 1 else ''
            url = 'https://inventaire.io/api/entities' + ('?' + qs if qs else '')
            req = urllib.request.Request(
                url, headers={'User-Agent': 'CozyLibram/1.0 inventaire-proxy'})
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
                self.send_error(502, 'inventaire fetch failed')
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
