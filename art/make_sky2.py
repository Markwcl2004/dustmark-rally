"""Batch 2 skies and cloud bands (no mirroring).

  python3 art/make_sky2.py     (reads art/jobs/sky2_picks.json)

Skies: Z-Image 2048x512 (4:1, art/jobs/sky2.json) -> trim paper margin and the ground strip at the bottom
-> wrapx.wrap_fade (the last 30 % of the width cross-faded over the start; a min-error cut left visible steps in the long
cloud bands) -> 3072x768 jpg (so the painting is stretched ~1.3x horizontally).
Same projection as batch 1: 4:1 upper hemisphere, u = 360 deg, v from horizon (bottom) to ~90 deg (top). No sun disc.
This replaces the mirrored clear.jpg (the mirror made a faint V where slanted clouds met at u = 0 / 0.5).

Cloud bands (public/assets/sky/clouds_N.png): clouds painted on a flat blue background -> wrap_fade on the RGB -> per-row
background colour (median of the pixels near the global background colour) -> alpha = smoothstep of the colour
distance -> un-premultiply the background out of the edge pixels -> RGBA 2048x512, wraps in x. Meant to be layered
(scrolling slowly) over a procedural gradient sky or over the jpg skies.
Previews: art/raw/tile_preview/sky_<name>.jpg (twice side by side), clouds over a gradient.
"""
import io
import json
import pathlib
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import post  # noqa: E402
import wrapx  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "art/raw/b2/sky"
PREV = ROOT / "art/raw/tile_preview"


def smoothstep(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def twice(img, out):
    small = img.convert("RGB").resize((1024, 256), Image.LANCZOS)
    two = Image.new("RGB", (2048, 256))
    two.paste(small, (0, 0))
    two.paste(small, (1024, 0))
    two.save(out, quality=85)


def add_flakes(img, n, seed=5):
    """Sprinkle small soft snowflakes (wrap-safe: none within 6 px of the left/right edge)."""
    from PIL import ImageDraw, ImageFilter
    rng = np.random.default_rng(seed)
    layer = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(layer)
    for _ in range(n):
        x, y = rng.uniform(6, img.width - 6), rng.uniform(0, img.height)
        r = rng.uniform(1.2, 3.2)
        d.ellipse([x - r, y - r, x + r, y + r], fill=int(rng.uniform(150, 255)))
    layer = layer.filter(ImageFilter.GaussianBlur(0.8))
    return Image.composite(Image.new("RGB", img.size, (250, 250, 255)), img, layer)


def sky(src, out, bottom=0.92, top=0.0, flakes=0):
    im = post.trim_border(Image.open(RAW / f"{src}.png").convert("RGB"))
    im = im.crop((0, int(im.height * top), im.width, int(im.height * bottom)))
    a = wrapx.wrap_fade(np.asarray(im).astype(np.float32) / 255, 0.3)
    img = Image.fromarray((a * 255 + 0.5).astype(np.uint8)).resize((3072, 768), Image.LANCZOS)
    if flakes:
        img = add_flakes(img, flakes)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, quality=85, optimize=True, progressive=True)
    twice(img, PREV / f"sky_{out.stem}.jpg")
    return wrapx.check(np.asarray(img).astype(np.float32) / 255)


def clouds(src, out, t0=0.05, t1=0.18):
    im = post.trim_border(Image.open(RAW / f"{src}.png").convert("RGB"))
    a = wrapx.wrap_fade(np.asarray(im).astype(np.float32) / 255, 0.3)
    h, w = a.shape[:2]
    edge = np.concatenate([a[: h // 20].reshape(-1, 3), a[-h // 20:].reshape(-1, 3)])
    b0 = np.median(edge, 0)
    near = np.sqrt(((a - b0) ** 2).sum(-1)) < 0.12
    bg = np.empty((h, 3), np.float32)
    for y in range(h):
        bg[y] = np.median(a[y][near[y]], 0) if near[y].sum() > 20 else b0
    bg = wrapx.blur(bg[:, None, :].repeat(8, 1), 6)[:, 0]  # smooth vertically
    dist = np.sqrt(((a - bg[:, None]) ** 2).sum(-1))
    al = smoothstep(dist, t0, t1)
    am = np.maximum(al, 0.05)[..., None]
    fg = np.clip((a - (1 - am) * bg[:, None]) / am, 0, 1)
    rgb = np.where(al[..., None] > 0.02, fg, bg[:, None] * np.ones_like(a))
    img = Image.fromarray((np.dstack([rgb, al]) * 255 + 0.5).astype(np.uint8), "RGBA").resize((2048, 512), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    if buf.tell() > 400 * 1024:
        img.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(out, optimize=True)
    else:
        out.write_bytes(buf.getvalue())
    # preview over a plain vertical gradient
    g = np.linspace(0, 1, 512)[:, None, None]
    grad = (np.array([0.36, 0.6, 0.82]) * (1 - g) + np.array([0.93, 0.9, 0.82]) * g) * np.ones((512, 2048, 3))
    c = np.asarray(img.convert("RGBA")).astype(np.float32) / 255
    comp = c[..., :3] * c[..., 3:] + grad * (1 - c[..., 3:])
    twice(Image.fromarray((comp * 255).astype(np.uint8)), PREV / f"sky_{out.stem}.jpg")


def main():
    picks = json.load(open(ROOT / "art/jobs/sky2_picks.json"))
    PREV.mkdir(parents=True, exist_ok=True)
    for out, p in picks.items():
        if out.startswith("_"):
            continue
        o = ROOT / out
        if o.stem.startswith("clouds"):
            clouds(p["src"], o, p.get("t0", 0.05), p.get("t1", 0.18))
            print(out, o.stat().st_size // 1024, "KB")
        else:
            w, i = sky(p["src"], o, p.get("bottom", 0.92), p.get("top", 0.0), p.get("flakes", 0))
            print(out, o.stat().st_size // 1024, "KB", "wrap %.4f interior %.4f" % (w, i))


if __name__ == "__main__":
    main()
