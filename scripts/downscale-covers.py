#!/usr/bin/env python3
"""One-shot cover downscale sweep (v218).

The v216 backfill stored ORIGINAL cover bytes in the `covers` bucket — some
are 1800x2700 3MB monsters displayed at ~104-160px wide, and phones drop
frames decoding dozens of them during a fast fling. This script downscales
every oversized object to max 600px on the long edge (JPEG q82) and uploads
it IN PLACE to the same key: same URL, smaller bytes, zero DB migration.

Modes (default is a dry run — nothing is written anywhere):
    python3 scripts/downscale-covers.py                 # dry run: report only
    python3 scripts/downscale-covers.py --write-local DIR  # save downscaled files to DIR (no upload)
    python3 scripts/downscale-covers.py --upload        # downscale + PUT in place (needs the service key)

--upload reads the key from server-config.json (repo root, gitignored — the
same file server.py uses, key `supabase_service_key`). It is used transiently
for the PUT and never logged or persisted. Run --upload on a machine that has
server-config.json (e.g. the home PC), NOT by pasting the key anywhere.

Safety: never deletes objects, never touches books data, only uploads when the
downscaled bytes are smaller than the original. Progress is logged per file to
scripts/downscale-progress.jsonl so runs are resumable (skip unless --redo).
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.request

from PIL import Image

REF = 'dvhimjkrroxuatthiizc'
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROGRESS = os.path.join(APP, 'scripts', 'downscale-progress.jsonl')
PUBLIC_BASE = f'https://{REF}.supabase.co/storage/v1/object/public/covers/'
API_BASE = f'https://{REF}.supabase.co/storage/v1/object/covers/'
MAX_EDGE = 600
JPEG_Q = 82
PACE_S = 0.4


def list_objects(key):
    """Portable bucket listing via the Storage list API (works on any OS —
    no local sb-query binary needed)."""
    names = []
    offset = 0
    while True:
        body = json.dumps({'prefix': '', 'limit': 100, 'offset': offset}).encode()
        req = urllib.request.Request(
            f'https://{REF}.supabase.co/storage/v1/object/list/covers',
            data=body, method='POST',
            headers={'apikey': key,
                     'Authorization': 'Bearer ' + key,
                     'Content-Type': 'application/json',
                     'User-Agent': 'cozy-libram-downscale/1.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.loads(r.read())
        if not page:
            break
        names.extend(o['name'] for o in page)
        offset += len(page)
    return sorted(names)


def download(name):
    req = urllib.request.Request(PUBLIC_BASE + name, headers={'User-Agent': 'cozy-libram-downscale/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def downscale(data):
    """Return (new_bytes, w, h) if downscaled, else (None, w, h)."""
    img = Image.open(io.BytesIO(data))
    w, h = img.size
    if max(w, h) <= MAX_EDGE:
        return None, w, h
    scale = MAX_EDGE / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    img = img.convert('RGB').resize((nw, nh), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=JPEG_Q, optimize=True)
    return buf.getvalue(), nw, nh


def log(entry):
    with open(PROGRESS, 'a') as f:
        f.write(json.dumps(entry) + '\n')


def load_service_key():
    cfg = os.path.join(APP, 'server-config.json')
    if not os.path.exists(cfg):
        sys.exit('ERROR: server-config.json with supabase_service_key not found '
                 '(same file server.py uses). Refusing to continue.')
    key = (json.load(open(cfg)).get('supabase_service_key') or '').strip()
    if not key:
        sys.exit('ERROR: supabase_service_key missing/empty in server-config.json.')
    return key


def put_object(name, data, key):
    req = urllib.request.Request(
        API_BASE + name, data=data, method='POST',
        headers={'Authorization': 'Bearer ' + key,
                 'Content-Type': 'image/jpeg',
                 'x-upsert': 'true',  # objects already exist — this is an in-place replace
                 'User-Agent': 'cozy-libram-downscale/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status
    except urllib.error.HTTPError as e:
        if e.code == 404:  # fall back to upsert-style create
            req2 = urllib.request.Request(
                API_BASE + name, data=data, method='POST',
                headers={'Authorization': 'Bearer ' + key,
                         'Content-Type': 'image/jpeg',
                         'x-upsert': 'true',
                         'User-Agent': 'cozy-libram-downscale/1.0'})
            with urllib.request.urlopen(req2, timeout=120) as r2:
                return r2.status
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', action='store_true', help='PUT downscaled bytes in place')
    ap.add_argument('--write-local', metavar='DIR', help='save downscaled files to DIR instead of uploading')
    ap.add_argument('--redo', action='store_true', help='reprocess files already logged as done')
    args = ap.parse_args()

    key = load_service_key()
    if args.write_local:
        os.makedirs(args.write_local, exist_ok=True)

    done = {}
    if os.path.exists(PROGRESS) and not args.redo:
        with open(PROGRESS) as f:
            for line in f:
                try:
                    e = json.loads(line)
                    done[e['name']] = e.get('action')
                except Exception:
                    pass
    # Resume: skip only names whose prior action is terminal for THIS mode.
    if args.upload:
        terminal = {'uploaded', 'skip', 'skip-not-smaller'}
    elif args.write_local:
        terminal = {'wrote-local', 'skip', 'skip-not-smaller'}
    else:
        terminal = {'downscaled-dryrun', 'wrote-local', 'uploaded', 'skip',
                    'skip-not-smaller', 'download-failed', 'decode-failed'}

    names = list_objects(key)
    print(f'{len(names)} objects in covers bucket; {len(done)} already processed, '
          f'mode={"upload" if args.upload else "write-local" if args.write_local else "dry-run"}')

    t_down, t_skip, kb_before, kb_after = 0, 0, 0, 0
    for i, name in enumerate(names):
        if done.get(name) in terminal:
            continue
        try:
            raw = download(name)
        except Exception as e:
            log({'name': name, 'action': 'download-failed', 'error': str(e)[:120]})
            print(f'[{i+1}/{len(names)}] {name[:12]}… download failed: {e}', flush=True)
            continue
        try:
            new_bytes, w, h = downscale(raw)
        except Exception as e:
            log({'name': name, 'action': 'decode-failed', 'error': str(e)[:120]})
            print(f'[{i+1}/{len(names)}] {name[:12]}… decode failed: {e}', flush=True)
            continue
        kb_before += len(raw)
        if new_bytes is None:
            t_skip += 1
            kb_after += len(raw)
            log({'name': name, 'action': 'skip', 'w': w, 'h': h, 'kb': round(len(raw)/1024, 1)})
            continue
        if len(new_bytes) >= len(raw):
            t_skip += 1
            kb_after += len(raw)
            log({'name': name, 'action': 'skip-not-smaller', 'w': w, 'h': h,
                 'kb': round(len(raw)/1024, 1)})
            continue
        t_down += 1
        kb_after += len(new_bytes)
        entry = {'name': name, 'action': 'downscaled', 'w': w, 'h': h,
                 'kb_before': round(len(raw)/1024, 1), 'kb_after': round(len(new_bytes)/1024, 1)}
        if args.upload:
            try:
                status = put_object(name, new_bytes, key)
                entry['action'] = 'uploaded'
                entry['put_status'] = status
                log(entry)
            except Exception as e:
                log({'name': name, 'action': 'upload-failed', 'error': str(e)[:120],
                     'kb_before': entry['kb_before']})
                print(f'[{i+1}/{len(names)}] {name[:12]}… upload failed: {e}', flush=True)
            time.sleep(PACE_S)
        elif args.write_local:
            with open(os.path.join(args.write_local, name), 'wb') as f:
                f.write(new_bytes)
            entry['action'] = 'wrote-local'
            log(entry)
        else:
            entry['action'] = 'downscaled-dryrun'
            log(entry)  # dry run still logs so it resumes cleanly
        if (i+1) % 25 == 0:
            print(f'[{i+1}/{len(names)}] downscaled={t_down} skipped={t_skip}', flush=True)

    print(f'DONE: {t_down} downscaled, {t_skip} skipped, '
          f'{kb_before/1024:.1f}MB -> {kb_after/1024:.1f}MB projected')


if __name__ == '__main__':
    main()
