#!/usr/bin/env python3
"""Cover re-conversion sweep: stored originals -> WebP (cover-storage spec).

The v216 backfill stored original cover bytes (JPEG/PNG) in the `covers`
bucket. The app-side adopter (v507/v508) stores new covers as WebP; this
script converts the stored corpus the same way: download each referenced
non-WebP object, transcode with PIL to WebP q85 (600px long-edge cap,
re-asserted from the v218 sweep), upload under the SHA-256 of the WebP
bytes, then repoint every book whose cover names the old object
(jsonb_set of data.cover + _mtime bump — the backfill-covers.js pattern),
so all devices converge through normal sync.

Modes (default is a dry run — downloads + transcodes, writes nothing):
    python3 scripts/reconvert-covers-webp.py              # dry run + map
    python3 scripts/reconvert-covers-webp.py --upload     # upload + repoint
    python3 scripts/reconvert-covers-webp.py --verify     # post-run counts
    python3 scripts/reconvert-covers-webp.py --orphans    # list unreferenced
    python3 scripts/reconvert-covers-webp.py --delete-orphans FILE
        # deletes exactly the objects named in a --orphans output file;
        # run ONLY after the user confirms that exact list.

The service key is fetched transiently from the Supabase Management API
using the stored custom.supabase credential (falling back to
server-config.json, the downscale-covers.py discipline). It is never
logged, printed, or persisted. Progress + the old->new map land in
scripts/reconvert-progress.jsonl / scripts/reconvert-map.json (no secrets).
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

from PIL import Image

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")

REF = 'dvhimjkrroxuatthiizc'
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROGRESS = os.path.join(APP, 'scripts', 'reconvert-progress.jsonl')
MAPFILE = os.path.join(APP, 'scripts', 'reconvert-map.json')
PUBLIC_BASE = f'https://{REF}.supabase.co/storage/v1/object/public/covers/'
LIST_URL = f'https://{REF}.supabase.co/storage/v1/object/list/covers'
OBJ_URL = f'https://{REF}.supabase.co/storage/v1/object/covers/'
MAX_EDGE = 600
WEBP_Q = 85
PACE_S = 0.4
UA = {'User-Agent': 'cozy-libram-reconvert/1.0'}


def load_service_key():
    """Transient: Management API via the stored credential surrogate."""
    try:
        from dynamic_credentials import (add_surrogate_to_request,
                                         read_json_response)
        req = urllib.request.Request(
            f'https://api.supabase.com/v1/projects/{REF}/api-keys',
            headers=dict(UA))
        add_surrogate_to_request(req, 'custom.supabase',
                                 allowed_hosts=('api.supabase.com',))
        with urllib.request.urlopen(req, timeout=30) as r:
            keys = read_json_response(r)
        for k in keys:
            if k.get('name') == 'service_role' and k.get('api_key'):
                return k['api_key']
    except Exception as e:
        print(f'management-api key fetch failed ({e}); trying server-config')
    cfg = os.path.join(APP, 'server-config.json')
    if os.path.exists(cfg):
        key = (json.load(open(cfg)).get('supabase_service_key') or '').strip()
        if key:
            return key
    sys.exit('ERROR: no service key available (management API or '
             'server-config.json). Refusing to continue.')


def sql(query):
    from dynamic_credentials import (add_surrogate_to_request,
                                     read_json_response)
    body = json.dumps({'query': query}).encode()
    req = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{REF}/database/query',
        data=body, method='POST',
        headers={**UA, 'Content-Type': 'application/json'})
    add_surrogate_to_request(req, 'custom.supabase',
                             allowed_hosts=('api.supabase.com',))
    with urllib.request.urlopen(req, timeout=60) as r:
        return read_json_response(r)


def log(entry):
    with open(PROGRESS, 'a') as f:
        f.write(json.dumps(entry) + '\n')


def list_objects(key):
    names = {}
    offset = 0
    while True:
        body = json.dumps({'prefix': '', 'limit': 100,
                           'offset': offset}).encode()
        req = urllib.request.Request(
            LIST_URL, data=body, method='POST',
            headers={'apikey': key, 'Authorization': 'Bearer ' + key,
                     'Content-Type': 'application/json', **UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.loads(r.read())
        if not page:
            break
        for o in page:
            meta = o.get('metadata') or {}
            names[o['name']] = meta.get('size')
        offset += len(page)
    return names


def referenced():
    """object name -> number of books whose cover points at it."""
    rows = sql(
        "select data->>'cover' as cover, count(*)::int as n from books "
        f"where data->>'cover' like '%/storage/v1/object/public/covers/%' "
        "group by 1")
    out = {}
    marker = '/storage/v1/object/public/covers/'
    for r in rows:
        cover = r['cover'] or ''
        if marker in cover:
            name = cover.split(marker, 1)[1].split('?')[0]
            out[name] = out.get(name, 0) + r['n']
    return out


def download(name):
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(PUBLIC_BASE + name,
                                         headers=dict(UA))
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # IncompleteRead / dropped conn: retry
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def transcode(data):
    """Bytes -> WebP bytes (q85, 600px long-edge cap). Raises on bad input."""
    img = Image.open(io.BytesIO(data))
    img.load()
    w, h = img.size
    if max(w, h) > MAX_EDGE:
        scale = MAX_EDGE / max(w, h)
        img = img.resize((max(1, round(w * scale)),
                          max(1, round(h * scale))), Image.LANCZOS)
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGBA' if 'transparency' in img.info else 'RGB')
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=WEBP_Q)
    return buf.getvalue()


def build_map(key):
    bucket = list_objects(key)
    refs = referenced()
    todo = {n: refs[n] for n in refs
            if not n.lower().endswith('.webp') and n in bucket}
    missing = [n for n in refs if n not in bucket]
    mapping, failed = {}, []
    for i, name in enumerate(sorted(todo), 1):
        try:
            raw = download(name)
            webp = transcode(raw)
            new = hashlib.sha256(webp).hexdigest() + '.webp'
            mapping[name] = {'new': new, 'books': todo[name],
                             'old_bytes': len(raw), 'new_bytes': len(webp),
                             'exists': new in bucket}
            print(f'[{i}/{len(todo)}] {name} ({len(raw)}B, '
                  f'{todo[name]} books) -> {new} ({len(webp)}B)')
            log({'old': name, 'new': new, 'stage': 'mapped'})
        except Exception as e:
            failed.append({'old': name, 'error': str(e)[:200]})
            print(f'[{i}/{len(todo)}] {name}: FAILED {e}')
            log({'old': name, 'stage': 'failed', 'error': str(e)[:200]})
        time.sleep(PACE_S)
    unref = sorted(set(bucket) - set(refs))
    report = {'bucket_total': len(bucket), 'referenced': len(refs),
              'todo': len(todo), 'mapped': len(mapping), 'failed': failed,
              'missing_from_bucket': missing,
              'already_webp_refs': sum(1 for n in refs
                                       if n.lower().endswith('.webp')),
              'unreferenced_objects': len(unref),
              'old_bytes': sum(v['old_bytes'] for v in mapping.values()),
              'new_bytes': sum(v['new_bytes'] for v in mapping.values())}
    with open(MAPFILE, 'w') as f:
        json.dump({'report': report, 'map': mapping}, f, indent=1)
    return report, mapping, bucket, refs


def upload_one(name, data, key):
    req = urllib.request.Request(
        OBJ_URL + name, data=data, method='POST',
        headers={'Authorization': 'Bearer ' + key,
                 'Content-Type': 'image/webp', 'x-upsert': 'false', **UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status
    except urllib.error.HTTPError as e:
        if e.code in (400, 409):  # already exists = dedup success
            return 'exists'
        raise


def do_upload(key, mapping):
    done = 0
    for i, (old, v) in enumerate(sorted(mapping.items()), 1):
        new = v['new']
        if not v['exists']:
            webp = transcode(download(old))
            assert hashlib.sha256(webp).hexdigest() + '.webp' == new
            upload_one(new, webp, key)
            log({'old': old, 'new': new, 'stage': 'uploaded'})
        ms = int(time.time() * 1000)
        old_url = PUBLIC_BASE + old
        new_url = PUBLIC_BASE + new
        sql("update books set data = jsonb_set(jsonb_set(data, '{cover}', "
            f"to_jsonb('{new_url}'::text)), '{{_mtime}}', "
            f"to_jsonb({ms}::bigint)), updated_at = now() "
            f"where data->>'cover' = '{old_url}'")
        log({'old': old, 'new': new, 'stage': 'repointed'})
        done += 1
        print(f'[{i}/{len(mapping)}] repointed {v["books"]} book(s): '
              f'{old} -> {new}')
        time.sleep(PACE_S)
    print(f'repointed {done} objects')


def do_verify():
    rows = sql(
        "select count(*)::int as n from books where data->>'cover' like "
        "'%/storage/v1/object/public/covers/%' and data->>'cover' not like "
        "'%.webp%'")
    rows_w = sql(
        "select count(*)::int as n from books where data->>'cover' like "
        "'%/storage/v1/object/public/covers/%.webp%'")
    print(f'books on bucket covers: non-WebP references = {rows[0]["n"]}, '
          f'WebP references = {rows_w[0]["n"]}')


def do_orphans(key, out_path):
    bucket = list_objects(key)
    refs = referenced()
    orphans = [{'name': n, 'bytes': bucket[n]}
               for n in sorted(set(bucket) - set(refs))]
    total = sum(o['bytes'] or 0 for o in orphans)
    with open(out_path, 'w') as f:
        json.dump({'objects': orphans, 'total_bytes': total}, f, indent=1)
    print(f'{len(orphans)} unreferenced objects, {total} bytes total -> '
          f'{out_path}')


def do_delete_orphans(key, list_path):
    with open(list_path) as f:
        names = [o['name'] for o in json.load(f)['objects']]
    body = json.dumps({'prefixes': names}).encode()
    req = urllib.request.Request(
        f'https://{REF}.supabase.co/storage/v1/object/covers',
        data=body, method='DELETE',
        headers={'apikey': key, 'Authorization': 'Bearer ' + key,
                 'Content-Type': 'application/json', **UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        deleted = json.loads(r.read())
    print(f'deleted {len(deleted)} of {len(names)} listed objects')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--orphans', action='store_true')
    ap.add_argument('--delete-orphans', metavar='FILE')
    args = ap.parse_args()
    if args.verify:
        do_verify()
        return
    key = load_service_key()
    if args.delete_orphans:
        do_delete_orphans(key, args.delete_orphans)
        return
    if args.orphans:
        do_orphans(key, os.path.join(
            APP, 'scripts', 'reconvert-orphans.json'))
        return
    report, mapping, _bucket, _refs = build_map(key)
    print(json.dumps(report, indent=1))
    if args.upload:
        do_upload(key, mapping)
        do_verify()


if __name__ == '__main__':
    main()
