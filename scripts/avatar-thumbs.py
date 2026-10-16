#!/usr/bin/env python3
"""Generate the picker-sized avatar derivatives (issue #214).

The painted avatar catalog (img/avatars/avatar-*.webp) ships at
1600x1600 — 2,246 KB across 22 files — but the profile-picture picker
paints tiles at <=84 CSS px and collection heroes at 52px, so the grid
only ever needs a ~256px derivative (256 covers the 84px tile at DPR 3).
This script writes 256x256 WebP derivatives to img/avatars/thumb/, one
per catalog original, and the picker (js/236) renders those in grids
and heroes. The full-size originals stay what they were: the applied
avatar everywhere else (topbar, profile, fitting-room preview) and the
sw.js precache.

The derivatives are committed like the rest of the catalog and are
runtime-cached by the service worker on first picker use — NEVER
precached (the v500 sticker / v558 zxing pattern), so they add no
install weight.

Re-run after adding or replacing a catalog avatar:

    python3 scripts/avatar-thumbs.py            # (re)generate all thumbs
    python3 scripts/avatar-thumbs.py --check    # verify only, write nothing

Requires Pillow. Never overwrites an original; a thumb is only written
when it is smaller than its source.
"""
import argparse
import os
import sys

from PIL import Image

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(APP, 'img', 'avatars')
OUT_DIR = os.path.join(SRC_DIR, 'thumb')
SIZE = 256
QUALITY = 82


def thumb_bytes(src_path):
    im = Image.open(src_path)
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGB')
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    import io
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=QUALITY, method=4)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true',
                    help='verify every original has a current 256px thumb; write nothing')
    args = ap.parse_args()

    originals = sorted(f for f in os.listdir(SRC_DIR)
                       if f.startswith('avatar-') and f.endswith('.webp'))
    if not originals:
        print('no catalog originals found in', SRC_DIR)
        return 1

    missing, stale, written, total_old, total_new = [], [], 0, 0, 0
    for name in originals:
        src = os.path.join(SRC_DIR, name)
        dst = os.path.join(OUT_DIR, name)
        data = thumb_bytes(src)
        total_old += os.path.getsize(src)
        total_new += len(data)
        if not os.path.exists(dst):
            missing.append(name)
        elif open(dst, 'rb').read() != data:
            stale.append(name)
        if args.check:
            continue
        if len(data) >= os.path.getsize(src):
            print('SKIP %s: derivative not smaller than original' % name)
            continue
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(data)
        written += 1

    print('%d originals, %d KB -> thumbs %d KB (%d files %s)' % (
        len(originals), total_old // 1024, total_new // 1024,
        len(originals), 'checked' if args.check else 'written: %d' % written))
    if args.check and (missing or stale):
        print('missing:', missing)
        print('stale:', stale)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
