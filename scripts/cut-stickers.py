#!/usr/bin/env python3
"""Cut sticker sheets into individual transparent PNGs.

Sheets are AI-generated grids of die-cut stickers on a uniform pale
background. Method: sample the background colour from the corners,
flood-fill from the image edges through background-like pixels, treat
everything else as foreground, split into connected components, and
crop each component with a feathered alpha edge.

Usage:
  python3 scripts/cut-stickers.py <sheet.webp> [<sheet2.webp> ...]
  python3 scripts/cut-stickers.py --all

Output: assets/stickers/cut/<theme>/<sheet>-<NN>.png  (NN = reading order)
Sheets whose name ends in -b for twilight are skipped with --all
(the flawed original; see MANIFEST.md).
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHEETS = ROOT / "assets" / "stickers" / "sheets"
CUT = ROOT / "assets" / "stickers" / "cut"
TOL = 26          # colour distance (per summed RGB) treated as background
MIN_AREA = 4000   # ignore specks smaller than this (px)
PAD = 6           # transparent padding around each cut sticker


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """True where the pixel is reachable background."""
    h, w, _ = rgb.shape
    corners = np.concatenate([
        rgb[:8, :8].reshape(-1, 3), rgb[:8, -8:].reshape(-1, 3),
        rgb[-8:, :8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3)])
    bg = corners.mean(axis=0)
    dist = np.abs(rgb.astype(int) - bg.astype(int)).sum(axis=2)
    is_bg_like = dist < TOL * 3
    # flood fill from all edges through bg-like pixels
    seen = np.zeros((h, w), dtype=bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg_like[y, x] and not seen[y, x]:
                seen[y, x] = True; dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg_like[y, x] and not seen[y, x]:
                seen[y, x] = True; dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for ny, nx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and is_bg_like[ny, nx]:
                seen[ny, nx] = True; dq.append((ny, nx))
    return seen


def components(fg: np.ndarray):
    """Connected components of the foreground mask, reading order."""
    h, w = fg.shape
    label = np.zeros((h, w), dtype=np.int32)
    boxes = []
    cur = 0
    for sy in range(h):
        for sx in range(w):
            if fg[sy, sx] and label[sy, sx] == 0:
                cur += 1
                dq = deque([(sy, sx)])
                label[sy, sx] = cur
                minx = maxx = sx; miny = maxy = sy; area = 0
                while dq:
                    y, x = dq.popleft(); area += 1
                    minx = min(minx, x); maxx = max(maxx, x)
                    miny = min(miny, y); maxy = max(maxy, y)
                    for ny, nx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
                        if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and label[ny, nx] == 0:
                            label[ny, nx] = cur; dq.append((ny, nx))
                if area >= MIN_AREA:
                    boxes.append((miny, minx, maxy, maxx, cur, area))
    boxes.sort(key=lambda b: (round(b[0] / 120), b[1]))  # rows, then left→right
    return label, boxes


def cut_sheet(path: Path) -> int:
    img = Image.open(path).convert("RGB")
    rgb = np.asarray(img)
    bg = background_mask(rgb)
    fg = ~bg
    label, boxes = components(fg)
    theme = path.stem.rsplit("-", 1)[0]
    out_dir = CUT / theme
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob(f"{path.stem}-*.png"):
        old.unlink()
    for i, (miny, minx, maxy, maxx, lab, _area) in enumerate(boxes, 1):
        x0 = max(0, minx - PAD); y0 = max(0, miny - PAD)
        x1 = min(rgb.shape[1], maxx + 1 + PAD); y1 = min(rgb.shape[0], maxy + 1 + PAD)
        crop = img.crop((x0, y0, x1, y1))
        alpha = ((label[y0:y1, x0:x1] == lab) * 255).astype(np.uint8)
        alpha_img = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.8))
        rgba = crop.convert("RGBA")
        rgba.putalpha(alpha_img)
        rgba.save(out_dir / f"{path.stem}-{i:02d}.png")
    return len(boxes)


def main():
    args = sys.argv[1:]
    if args == ["--all"]:
        files = sorted(p for p in SHEETS.glob("*.webp")
                       if not (p.stem == "twilight-b"))
    else:
        files = [Path(a) for a in args]
    total = 0
    for f in files:
        n = cut_sheet(f)
        total += n
        print(f"{f.name}: {n} stickers")
    print(f"TOTAL: {total} stickers from {len(files)} sheets")


if __name__ == "__main__":
    main()
