"""Procedural, already-tileable "underpaintings" for ground materials where text-to-image keeps composing
(gravel heaped in one corner, tyre tracks on snow). Z-Image then repaints them img2img (art/jobs/ground_img2img.json,
denoise ~0.6) so the layout stays even and the look matches the other textures.

  python3 art/procbase.py  -> art/raw/procbase/<name>.png (1024x1024) + a white full mask
"""
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "art/raw/procbase"
N = 1024


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def wrap_ellipse(d, x, y, rx, ry, fill, outline=None):
    for ox in (-N, 0, N):
        for oy in (-N, 0, N):
            if -rx * 2 < x + ox < N + rx * 2 and -ry * 2 < y + oy < N + ry * 2:
                d.ellipse([x + ox - rx, y + oy - ry, x + ox + rx, y + oy + ry], fill=fill, outline=outline)


def wrap_poly(d, pts, fill):
    for ox in (-N, 0, N):
        for oy in (-N, 0, N):
            d.polygon([(px + ox, py + oy) for px, py in pts], fill=fill)


def lowfreq(seed, cells, amp):
    """Tileable low-frequency noise: random grid tiled 3x3, upsampled, centre cut."""
    rng = np.random.default_rng(seed)
    g = rng.random((cells, cells)).astype(np.float32)
    big = np.tile(g, (3, 3))
    im = Image.fromarray((big * 255).astype(np.uint8)).resize((N * 3, N * 3), Image.BICUBIC)
    a = np.asarray(im).astype(np.float32)[N:2 * N, N:2 * N] / 255
    return (a - 0.5) * amp


def base(color, seed, amp=18):
    c = np.array(hexrgb(color), np.float32)
    a = np.ones((N, N, 3), np.float32) * c + lowfreq(seed, 6, amp)[..., None] + lowfreq(seed + 1, 40, amp * 0.6)[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def pebbles(img, seed, count, rmin, rmax, colors, angular=False):
    rng = np.random.default_rng(seed)
    d = ImageDraw.Draw(img)
    cols = [hexrgb(c) for c in colors]
    for _ in range(count):
        x, y = rng.uniform(0, N, 2)
        r = rng.uniform(rmin, rmax) * (rng.random() ** 1.5 * 0.7 + 0.3) * 1.4
        col = cols[rng.integers(len(cols))]
        j = rng.normal(0, 9)
        col = tuple(int(np.clip(v + j, 0, 255)) for v in col)
        rim = tuple(int(v * 0.72) for v in col)
        if angular:
            k = rng.integers(4, 7)
            ang = np.sort(rng.uniform(0, 2 * np.pi, k))
            rr = r * rng.uniform(0.6, 1.0, k)
            pts = [(x + np.cos(t) * q, y + np.sin(t) * q * 0.85) for t, q in zip(ang, rr)]
            wrap_poly(d, [(px + 1.5, py + 1.5) for px, py in pts], rim)
            wrap_poly(d, pts, col)
        else:
            ry = r * rng.uniform(0.65, 1.0)
            wrap_ellipse(d, x + 1.2, y + 1.6, r, ry, rim)
            wrap_ellipse(d, x, y, r, ry, col)
    return img


def gravel_road(seed, sand, stones):
    img = base(sand, seed)
    img = pebbles(img, seed + 10, 9000, 2, 5, stones)  # grit
    img = pebbles(img, seed + 11, 2600, 4, 10, stones)  # gravel
    img = pebbles(img, seed + 12, 160, 9, 16, stones)  # a few bigger stones
    return img.filter(ImageFilter.GaussianBlur(0.6))


def shoulder(seed):
    img = base("#8f7a62", seed, 26)
    img = pebbles(img, seed + 10, 4000, 2, 5, ["#a89a86", "#6f6a64", "#b8ab92", "#7d6a55"])
    img = pebbles(img, seed + 11, 900, 7, 18, ["#9c968c", "#7c7b78", "#c2b59c", "#8a7660", "#5f5d5c"], angular=True)
    img = pebbles(img, seed + 12, 70, 16, 30, ["#8e8b86", "#a49c8c", "#6c6966"], angular=True)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def snow_road(seed):
    img = base("#e9ebf2", seed, 26)
    d = ImageDraw.Draw(img)
    rng = np.random.default_rng(seed)
    for _ in range(260):  # soft lavender hollows and lumps
        x, y = rng.uniform(0, N, 2)
        r = rng.uniform(12, 60)
        col = ("#cdd2e6", "#d9dcec", "#f6f7fb", "#c3c8df")[rng.integers(4)]
        wrap_ellipse(d, x, y, r, r * rng.uniform(0.4, 0.9), hexrgb(col))
    img = img.filter(ImageFilter.GaussianBlur(5))
    img = pebbles(img, seed + 5, 2500, 1.5, 3.5, ["#9a9aa6", "#b9bccb", "#ffffff", "#7d7f8c"])  # grit + ice crystals
    return img.filter(ImageFilter.GaussianBlur(0.5))


def coast_ground(seed):
    img = base("#d9c8a6", seed, 24)
    img = pebbles(img, seed + 10, 3500, 1.5, 4, ["#c9b48e", "#b8a27c", "#e8dcc3", "#a8956f"])  # sand grain
    img = pebbles(img, seed + 11, 700, 4, 11, ["#efe9dc", "#e2d8c4", "#cfc4ae", "#bfb39b"])  # limestone pebbles
    img = pebbles(img, seed + 12, 220, 8, 20, ["#7d7a45", "#8e8550", "#a3925a", "#6a6d3d"])  # dry scrub tufts
    return img.filter(ImageFilter.GaussianBlur(0.6))


def snow_ground(seed):
    """Final fresh-snow texture (no model pass: generated snow kept getting large blue dots that repeat badly)."""
    rng = np.random.default_rng(seed)
    img = base("#eff1f7", seed, 14)
    d = ImageDraw.Draw(img)
    for _ in range(170):  # soft lavender hollows
        x, y = rng.uniform(0, N, 2)
        r = rng.uniform(20, 70)
        col = ("#dfe2ef", "#e6e8f2", "#f8f9fc", "#d8dbea")[rng.integers(4)]
        wrap_ellipse(d, x, y, r, r * rng.uniform(0.35, 0.7), hexrgb(col))
    img = img.filter(ImageFilter.GaussianBlur(9))
    d = ImageDraw.Draw(img)
    for _ in range(110):  # crisp lit edges of small drifts, like the flat poster snow
        x, y = rng.uniform(0, N, 2)
        w = rng.uniform(12, 40)
        wrap_ellipse(d, x, y, w, w * 0.18, hexrgb("#fbfcfe"))
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    img = pebbles(img, seed + 3, 900, 0.8, 1.8, ["#ffffff", "#e4ecfa", "#c9cfe2"])  # sparkles
    return img.filter(ImageFilter.GaussianBlur(0.4))


def birch_bark(seed):
    """Final birch bark texture (no model pass: the flat poster look is easy to draw and AI kept adding trunk edges)."""
    rng = np.random.default_rng(seed)
    img = base("#e9e2d0", seed, 16)
    d = ImageDraw.Draw(img)
    for _ in range(26):  # faint grey vertical streaks
        x = rng.uniform(0, N)
        w = rng.uniform(3, 14)
        col = hexrgb(("#d6cfbe", "#ddd6c6", "#cfc8b8")[rng.integers(3)])
        y0, h = rng.uniform(0, N), rng.uniform(120, 500)
        wrap_ellipse(d, x, y0, w, h, col)
    for _ in range(230):  # lenticels: short horizontal dashes
        x, y = rng.uniform(0, N, 2)
        w = rng.uniform(6, 34) * (1 + 1.5 * (rng.random() < 0.12))
        h = rng.uniform(1.6, 3.6)
        col = hexrgb(("#5d5852", "#7d7468", "#3f3d3a", "#968a7a")[rng.integers(4)])
        wrap_ellipse(d, x, y, w, h, col)
    for _ in range(18):  # dark patches: flattened diamonds with a pale rim
        x, y = rng.uniform(0, N, 2)
        w, h = rng.uniform(18, 60), rng.uniform(7, 18)
        pts = [(x - w, y + rng.uniform(-3, 3)), (x - w * 0.2, y - h), (x + w, y + rng.uniform(-3, 3)), (x + w * 0.1, y + h * 0.8)]
        wrap_poly(d, [(px, py - 3) for px, py in pts], hexrgb("#f4f0e6"))
        wrap_poly(d, pts, hexrgb(("#2f2d2b", "#3a3734")[rng.integers(2)]))
    return img.filter(ImageFilter.GaussianBlur(0.7))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    gravel_road(1, "#c9b597", ["#d8c8aa", "#b5a891", "#9c968c", "#c9b08a", "#857f78", "#e3d7bf", "#a88f6c"]).save(OUT / "gravel_road_1.png")
    gravel_road(2, "#bfae93", ["#cdbfa5", "#a9a08f", "#8f8a83", "#bca07a", "#7a746e", "#ddd2bc"]).save(OUT / "gravel_road_2.png")
    shoulder(3).save(OUT / "gravel_shoulder.png")
    snow_road(4).save(OUT / "snow_road.png")
    coast_ground(5).save(OUT / "coast_ground.png")
    sg = ROOT / "public/assets/tex/snow/ground.jpg"
    sg.parent.mkdir(parents=True, exist_ok=True)
    snow_ground(7).save(sg, quality=86, optimize=True, progressive=True)
    bb = ROOT / "public/assets/tex/nordic/birch_bark.jpg"
    bb.parent.mkdir(parents=True, exist_ok=True)
    birch_bark(6).save(bb, quality=86, optimize=True, progressive=True)
    Image.new("RGB", (N, N), (255, 255, 255)).save(OUT / "full_mask.png")
    print(sorted(p.name for p in OUT.iterdir()))
