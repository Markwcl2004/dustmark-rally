"""Batch 2 procedural, exactly periodic underpaintings (1024², wrap in both directions) for img2img
(art/jobs/ground2_img2img.json). Used where text-to-image keeps composing or where the layout is regular:

  road_worn         coast asphalt with small repair patches and sealed crack lines
  terracotta_roof   8 x 8 barrel tiles (alternating convex caps / concave pans), exact period 128 px
  pine_bark         vertical bark plates in columns, dark furrows between (V = trunk direction)
  shoulder_fine     nordic gravel shoulder without the big stones of batch 1 (they repeated visibly)
  savanna_shoulder  red-earth gravel shoulder
  stone_wall        dry stone wall, 12 courses, irregular rounded stones, dark gaps (period 1024 both ways)

  python3 art/procbase2.py  -> art/raw/procbase/<name>.png
Because the variant made by make_ground.py comes from the same base, the seam quilting lines up with the structure.
"""
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from procbase import N, OUT, base, hexrgb, lowfreq, pebbles, wrap_ellipse, wrap_poly  # noqa: E402


def jitter(rgb, rng, k=14):
    """Brightness-only jitter (same factor on every channel keeps the hue)."""
    f = 1 + rng.normal(0, k / 255)
    return tuple(int(np.clip(c * f, 0, 255)) for c in rgb)


def road_worn(seed):
    rng = np.random.default_rng(seed)
    img = base("#8a8279", seed, 16)
    img = pebbles(img, seed + 1, 14000, 1, 2.4, ["#9d958b", "#6f6963", "#a8a197", "#5d5852", "#b3aca2"])
    d = ImageDraw.Draw(img)
    for _ in range(7):  # small rectangular tar repairs, a little skewed
        x, y = rng.uniform(0, N, 2)
        w, h = rng.uniform(30, 80), rng.uniform(24, 60)
        a = rng.uniform(-0.15, 0.15)
        c, s = np.cos(a), np.sin(a)
        pts = [(x + c * px - s * py, y + s * px + c * py) for px, py in ((-w, -h), (w, -h), (w, h), (-w, h))]
        col = jitter(hexrgb("#76706a"), rng, 6)
        wrap_poly(d, pts, col)
    for _ in range(26):  # thin sealed cracks: short random walks
        x, y = rng.uniform(0, N, 2)
        ang = rng.uniform(0, np.pi * 2)
        pts = [(x, y)]
        for _ in range(rng.integers(6, 16)):
            ang += rng.normal(0, 0.5)
            x, y = x + np.cos(ang) * 9, y + np.sin(ang) * 9
            pts.append((x, y))
        for ox in (-N, 0, N):
            for oy in (-N, 0, N):
                d.line([(px + ox, py + oy) for px, py in pts], fill=hexrgb("#3b3835"), width=3)
    img = img.filter(ImageFilter.GaussianBlur(0.7))
    return pebbles(img, seed + 2, 5000, 0.8, 1.8, ["#a39c92", "#77716a"])


def terracotta_roof(seed, cols=8, rows=8):
    rng = np.random.default_rng(seed)
    cw, rh = N // cols, N // rows
    img = Image.new("RGB", (N, N), hexrgb("#5e2a1a"))
    d = ImageDraw.Draw(img)
    for r in range(rows):
        for c in range(cols):
            x0, y0 = c * cw, r * rh
            pan = jitter(hexrgb("#b8552e"), rng, 12)
            cap = jitter(hexrgb("#d9703d"), rng, 14)
            if rng.random() < 0.15:
                cap = jitter(hexrgb("#9c4a2c"), rng, 8)  # weathered tile
            # concave pan (left half), convex cap (right half) overlapping the next pan
            d.rectangle([x0 + 2, y0 + 4, x0 + cw // 2 + 4, y0 + rh - 2], fill=pan)
            d.rectangle([x0 + 6, y0 + 4, x0 + 14, y0 + rh - 2], fill=tuple(int(v * 0.85) for v in pan))
            for ox in (0, N):
                d.rounded_rectangle([x0 + cw // 2 - 6 - ox, y0 + 2, x0 + cw - 2 - ox + 6, y0 + rh - 8], 18, fill=cap)
            d.rectangle([x0 + cw // 2 + 8, y0 + 10, x0 + cw // 2 + 18, y0 + rh - 16], fill=tuple(min(255, int(v * 1.12)) for v in cap))
            d.rectangle([x0 + cw - 16, y0 + 10, x0 + cw - 6, y0 + rh - 16], fill=tuple(int(v * 0.88) for v in cap))
            # lower rim shadow where this row overlaps the one below
            d.rectangle([x0, y0 + rh - 8, x0 + cw, y0 + rh - 1], fill=jitter(hexrgb("#6d3220"), rng, 6))
    img = Image.fromarray(np.roll(np.asarray(img), (rh // 2, cw // 4), (0, 1)))
    img = img.filter(ImageFilter.GaussianBlur(1.0))
    return pebbles(img, seed + 3, 3000, 0.8, 2, ["#e08a5a", "#8d3e24", "#c86a40"])


def pine_bark(seed):
    rng = np.random.default_rng(seed)
    img = Image.new("RGB", (N, N), hexrgb("#2a160f"))  # furrows
    d = ImageDraw.Draw(img)
    widths = rng.uniform(60, 120, 30)
    widths = widths[: np.searchsorted(np.cumsum(widths), N) + 1]
    widths = widths * N / widths.sum()
    x = 0.0
    for w in widths:
        hs = rng.uniform(70, 220, 30)
        hs = hs[: np.searchsorted(np.cumsum(hs), N) + 1]
        hs = hs * N / hs.sum()
        y = rng.uniform(0, N)
        for h in hs:
            g = 5
            col = jitter(hexrgb(("#8a4a2c", "#7a3f26", "#9a5636", "#6f4a3a", "#86604c")[rng.integers(5)]), rng, 10)
            pts = [(x + g + rng.uniform(0, 6), y + g), (x + w - g - rng.uniform(0, 6), y + g + rng.uniform(-8, 8)),
                   (x + w - g - rng.uniform(0, 8), y + h - g), (x + g + rng.uniform(0, 8), y + h - g + rng.uniform(-8, 8))]
            wrap_poly(d, pts, col)
            # lighter grey flaky streak on some plates
            if rng.random() < 0.45:
                cx = x + w / 2 + rng.uniform(-w / 5, w / 5)
                wrap_poly(d, [(cx - 4, y + 14), (cx + 4, y + 14), (cx + 6, y + h - 14), (cx - 5, y + h - 14)], jitter(hexrgb("#9a7f6c"), rng, 8))
            y += h
        x += w
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    return pebbles(img, seed + 4, 2500, 0.8, 2, ["#b0866a", "#4a2a1c", "#c09a80"])


def shoulder_fine(seed):
    img = base("#8f7a62", seed, 20)
    img = pebbles(img, seed + 10, 6000, 2, 4.5, ["#a89a86", "#6f6a64", "#b8ab92", "#7d6a55"])
    img = pebbles(img, seed + 11, 1500, 5, 11, ["#9c968c", "#7c7b78", "#c2b59c", "#8a7660", "#5f5d5c"], angular=True)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def savanna_shoulder(seed):
    img = base("#a4482a", seed, 20)
    img = pebbles(img, seed + 10, 6000, 2, 4.5, ["#b8603a", "#8a3a22", "#c47a4a", "#7a3020"])
    img = pebbles(img, seed + 11, 1400, 5, 11, ["#9c5a3c", "#c08050", "#6a3424", "#b06a48", "#8a6050"], angular=True)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def coast_shoulder(seed):
    img = base("#cbbd9f", seed, 20)
    img = pebbles(img, seed + 10, 6000, 2, 4.5, ["#e2d8c4", "#a49a8a", "#d8ccb2", "#8f8a82"])
    img = pebbles(img, seed + 11, 1400, 5, 11, ["#efe9dc", "#b8b0a2", "#d6c8ac", "#9a948a", "#c4b898"], angular=True)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def plaster(seed, color, stain, chip):
    """Final lime-plaster wall (no model pass: with the poster prefix Z-Image paints decorative grids on blank walls)."""
    rng = np.random.default_rng(seed)
    img = base(color, seed, 10)
    a = np.asarray(img).astype(np.float32)
    w = np.clip(lowfreq(seed + 5, 5, 2.2) + lowfreq(seed + 6, 14, 1.0), 0, 1)[..., None]  # weathering stains
    a = a * (1 - 0.18 * w) + np.array(hexrgb(stain), np.float32) * 0.18 * w
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    for _ in range(9000):  # brush grain: short soft strokes
        x, y = rng.uniform(0, N, 2)
        L = rng.uniform(6, 20)
        ang = rng.normal(0, 0.5)
        f = rng.uniform(0.95, 1.05)
        c = tuple(int(np.clip(v * f, 0, 255)) for v in hexrgb(color))
        d.line([(x, y), (x + np.cos(ang) * L, y + np.sin(ang) * L)], fill=c, width=2)
    img = img.filter(ImageFilter.GaussianBlur(1.0))
    d = ImageDraw.Draw(img)
    for _ in range(45):  # small chips showing the warmer render
        x, y = rng.uniform(0, N, 2)
        r = rng.uniform(3, 9)
        k = rng.integers(5, 8)
        ang = np.sort(rng.uniform(0, 2 * np.pi, k))
        pts = [(x + np.cos(t) * r * rng.uniform(0.5, 1), y + np.sin(t) * r * rng.uniform(0.5, 1)) for t in ang]
        wrap_poly(d, [(px + 1, py + 1.5) for px, py in pts], tuple(int(v * 0.8) for v in hexrgb(chip)))
        wrap_poly(d, pts, hexrgb(chip))
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    return pebbles(img, seed + 7, 3000, 0.6, 1.4, [stain])


def stone_wall(seed, courses=12):
    rng = np.random.default_rng(seed)
    img = Image.new("RGB", (N, N), hexrgb("#4a3a2c"))  # gaps
    d = ImageDraw.Draw(img)
    hs = rng.uniform(0.75, 1.25, courses)
    hs = hs * N / hs.sum()
    y = 0.0
    cols = ["#e2d3b4", "#d4c09a", "#c9ae84", "#c8bca8", "#e8dcc4", "#c4a27a", "#b5aa98"]
    for h in hs:
        ws = rng.uniform(0.8 * h, 2.2 * h, 40)
        ws = ws[: np.searchsorted(np.cumsum(ws), N) + 1]
        ws = ws * N / ws.sum()
        x = rng.uniform(0, N)
        for w in ws:
            g = rng.uniform(2, 4)
            col = jitter(hexrgb(cols[rng.integers(len(cols))]), rng, 8)
            cx, cy = x + w / 2, y + h / 2 + rng.uniform(-3, 3)
            k = 9
            ang = np.linspace(0, 2 * np.pi, k, endpoint=False) + rng.uniform(0, 1)
            rx, ry = w / 2 - g, h / 2 - g
            # superellipse-ish: mostly flat-sided stones that fill their slot
            pts = [(cx + np.sign(np.cos(t)) * abs(np.cos(t)) ** 0.6 * rx * rng.uniform(0.9, 1.0),
                    cy + np.sign(np.sin(t)) * abs(np.sin(t)) ** 0.6 * ry * rng.uniform(0.85, 1.0)) for t in ang]
            wrap_poly(d, [(px + 2, py + 3) for px, py in pts], tuple(int(v * 0.7) for v in col))
            wrap_poly(d, pts, col)
            x += w
        y += h
    img = img.filter(ImageFilter.GaussianBlur(1.0))
    return pebbles(img, seed + 5, 4000, 0.8, 2, ["#f0e6d2", "#a8977c", "#8a7d6a"])


def facets(seed, tones, edge, n=420, speck=None, edge_frac=0.3, edge_w=2.2, edge2=None, ystretch=1.35):
    """Flat-painted rock: periodic Voronoi cells (wrap distance) in a few flat tones, dark hairlines along some cell borders."""
    rng = np.random.default_rng(seed)
    pts = rng.uniform(0, N, (n, 2)).astype(np.float32)
    pts[:, 1] *= 1.0
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    best = np.full((N, N), np.inf, np.float32)
    second = np.full((N, N), np.inf, np.float32)
    idx = np.zeros((N, N), np.int32)
    for i, (px, py) in enumerate(pts):
        dx = np.abs(xx - px)
        dx = np.minimum(dx, N - dx)
        dy = np.abs(yy - py)
        dy = np.minimum(dy, N - dy) * ystretch  # >1: flattened cells read as strata; <1: tall plates (bark)
        d = dx * dx + dy * dy
        closer = d < best
        second = np.where(closer, best, np.minimum(second, d))
        idx = np.where(closer, i, idx)
        best = np.where(closer, d, best)
    cols = np.array([hexrgb(t) for t in tones], np.float32)
    cell = cols[rng.integers(len(tones), size=n)] * rng.uniform(0.93, 1.07, (n, 1))
    img = cell[idx]
    gap = np.sqrt(second) - np.sqrt(best)
    show = rng.random(n) < edge_frac
    img[(gap < edge_w) & show[idx]] = np.array(hexrgb(edge), np.float32)
    if edge2:  # second, wider border colour on other cells (snow caught in cracks)
        show2 = (rng.random(n) < 0.3) & ~show
        img[(gap < edge_w * 3.5) & show2[idx]] = np.array(hexrgb(edge2), np.float32)
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    if speck:
        out = pebbles(out, seed + 9, 6000, 0.8, 2.2, speck)
    return out


def strokes(seed, ground, colors, count=26000, length=(8, 22), width=2, angle_spread=np.pi):
    """Grass mat: many short painted strokes in random directions (wrap)."""
    rng = np.random.default_rng(seed)
    img = base(ground, seed, 18)
    d = ImageDraw.Draw(img)
    cols = [hexrgb(c) for c in colors]
    for _ in range(count):
        x, y = rng.uniform(0, N, 2)
        a = rng.uniform(-angle_spread / 2, angle_spread / 2) - np.pi / 2
        L = rng.uniform(*length)
        x2, y2 = x + np.cos(a) * L, y + np.sin(a) * L
        c = cols[rng.integers(len(cols))]
        for ox in ((-N, 0, N) if (x < 30 or x > N - 30) else (0,)):
            for oy in ((-N, 0, N) if (y < 30 or y > N - 30) else (0,)):
                d.line([(x + ox, y + oy), (x2 + ox, y2 + oy)], fill=c, width=width)
    return img.filter(ImageFilter.GaussianBlur(0.5))


def riverbed(seed):
    rng = np.random.default_rng(seed)
    img = base("#b49a7c", seed, 30)
    a = np.asarray(img).astype(np.float32)
    wet = np.clip(np.asarray(Image.fromarray(np.uint8(128 + 127 * np.clip(rng.standard_normal((16, 16)), -1, 1))).resize((N, N), Image.BICUBIC)).astype(np.float32) / 255, 0, 1)
    wet = np.tile(wet[:N // 2, :N // 2], (2, 2)) if False else wet
    img = Image.fromarray(a.astype(np.uint8))
    img = pebbles(img, seed + 1, 2400, 4, 9, ["#c9b08a", "#8d8378", "#d9cdb5", "#a8573a", "#6f6a63", "#bfa27a"])
    img = pebbles(img, seed + 2, 700, 9, 15, ["#c2ab88", "#8f857a", "#d4c6ad", "#9c5236", "#7a746c"])
    img = pebbles(img, seed + 3, 6000, 1.2, 2.5, ["#9c876a", "#cbb89a"])
    return img.filter(ImageFilter.GaussianBlur(0.6))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn, s in (("road_worn", road_worn, 21), ("terracotta_roof", terracotta_roof, 22), ("pine_bark", pine_bark, 23),
                        ("shoulder_fine", shoulder_fine, 24), ("savanna_shoulder", savanna_shoulder, 25), ("stone_wall", stone_wall, 26),
                        ("pine_bark2", lambda s: facets(s, ["#8a4a2c", "#7a3f26", "#9a5636", "#7c5444", "#a0664a", "#6e3a24"], "#24120c",
                                                        n=150, edge_frac=1.0, edge_w=4.0, ystretch=0.32, speck=["#b0866a", "#4a2a1c"]), 35),
                        ("riverbed", riverbed, 27),
                        ("plaster_white", lambda s: plaster(s, "#ece5d4", "#c9b48c", "#d8b48a"), 36),
                        ("plaster_ochre", lambda s: plaster(s, "#d9a654", "#b07a3a", "#ead6b0"), 37), ("coast_shoulder", coast_shoulder, 34),
                        ("rock_savanna", lambda s: facets(s, ["#b5532e", "#a04a2a", "#c46a3e", "#8e3f28", "#cf8052"], "#4e1e14",
                                                          speck=["#e09a70", "#6e2a1a"]), 28),
                        ("rock_nordic", lambda s: facets(s, ["#8d8f8c", "#7d8186", "#9a968c", "#6f7378", "#a7a49a"], "#2e3236", edge_frac=0.25,
                                                         speck=["#b8b48a", "#c9a860", "#5a5e60"]), 29),
                        ("rock_snow", lambda s: facets(s, ["#3f4352", "#4a4f60", "#353846", "#565b6c"], "#1c1e28", edge2="#eef1f8",
                                                       speck=["#f4f6fb", "#c9cfe2"]), 30),
                        ("cliff_coast", lambda s: facets(s, ["#e3cfae", "#d6bd96", "#ecdcc0", "#c9ae86", "#d9c7a8"], "#8a6f52", edge_frac=0.45,
                                                         speck=["#f5ecd8", "#b39a78"]), 31),
                        ("grass_nordic", lambda s: strokes(s, "#7d7a45", ["#8e8a4c", "#6c7040", "#a49a58", "#5d6438", "#b8a964", "#7f8a50"]), 32),
                        ("grass_savanna", lambda s: strokes(s, "#b48a4c", ["#d6b26a", "#c49a58", "#e2c482", "#a07a40", "#8a6a3a", "#b9a060"],
                                                            length=(10, 26)), 33)):
        fn(s).save(OUT / f"{name}.png")
        print(OUT / f"{name}.png")
