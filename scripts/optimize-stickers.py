#!/usr/bin/env python3
"""Convert cut sticker PNGs to WebP (q90) for the app bundle.

Originals stay untouched in assets/stickers/cut/ (archived on Git);
optimized copies land in assets/stickers/cut-webp/<theme>/<name>.webp
mirroring the cut layout. q90 measured at ~16% of PNG size on the
Velvet set with no visible quality loss on watercolor art.

Usage: python3 scripts/optimize-stickers.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "stickers" / "cut"
DST = ROOT / "assets" / "stickers" / "cut-webp"
QUALITY = 90

def main() -> None:
    total_in = total_out = count = 0
    for png in sorted(SRC.rglob("*.png")):
        rel = png.relative_to(SRC).with_suffix(".webp")
        out = DST / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.open(png).save(out, "WEBP", quality=QUALITY, method=4)
        total_in += png.stat().st_size
        total_out += out.stat().st_size
        count += 1
    mb = 1048576
    print(f"{count} stickers: {total_in/mb:.1f} MB PNG -> "
          f"{total_out/mb:.1f} MB WebP ({100*total_out/total_in:.0f}%)")

if __name__ == "__main__":
    main()
