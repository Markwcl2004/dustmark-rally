"""Procedural particle sprites (no generation model): python3 art/fx.py -> public/assets/fx/*.png

Each is a 256x256 grey+alpha PNG (mode LA): grey = shading (multiply by the particle/environment colour in the
shader), alpha = coverage. Shapes are soft and blobby to match the gouache look; a little grain is baked in.
  dust.png        soft cauliflower puff, lit from the top
  dust_sheet.png  2x2 atlas of four different puffs (512x512, each cell 256) for variety
  snow.png        soft flake dot with a faint six-point star
  splash.png      water splash: a crown of droplets and a soft core
  stones.png      2x2 atlas of small angular stone chips (512x512)
"""
import math
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = pathlib.Path(__file__).resolve().parent.parent / "public/assets/fx"
N = 256


def blur(a, r):
    return np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255


def noise(seed, scale):
    """Value noise in [0,1] from upsampled random grid."""
    rng = np.random.default_rng(seed)
    g = rng.random((scale, scale)).astype(np.float32)
    return np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC)).astype(np.float32) / 255


def save(grey, alpha, name):
    OUT.mkdir(parents=True, exist_ok=True)
    g = (np.clip(grey, 0, 1) * 255).astype(np.uint8)
    a = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    Image.merge("LA", (Image.fromarray(g), Image.fromarray(a))).save(OUT / name, optimize=True)


def puff(seed):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:N, 0:N].astype(np.float32) / N
    a = np.zeros((N, N), np.float32)
    for _ in range(9):  # union of soft circles = cauliflower outline
        cx, cy = 0.5 + np.clip(rng.normal(0, 0.08), -0.13, 0.13), 0.53 + np.clip(rng.normal(0, 0.06), -0.1, 0.1)
        r = rng.uniform(0.12, 0.2)
        d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
        a = np.maximum(a, np.clip((r - d) / 0.05, 0, 1))
    edge = np.clip((0.44 - np.sqrt((x - 0.5) ** 2 + (y - 0.5) ** 2)) / 0.1, 0, 1)  # never touch the sprite border
    a = blur(a * edge, 5) * (0.75 + 0.25 * noise(seed + 1, 18))
    a *= 0.85 + 0.15 * noise(seed + 2, 64)  # grain
    shade = 0.62 + 0.38 * np.clip(1.15 - y * 1.2, 0, 1)  # lit from above
    shade = shade * (0.9 + 0.1 * noise(seed + 3, 24))
    return shade, np.clip(a, 0, 1)


def snow():
    y, x = np.mgrid[0:N, 0:N].astype(np.float32) / N - 0.5
    d = np.sqrt(x * x + y * y)
    core = np.clip((0.3 - d) / 0.3, 0, 1) ** 1.3
    ang = np.arctan2(y, x)
    star = np.clip(np.cos(ang * 6) * 0.5 + 0.5, 0, 1) ** 6 * np.clip((0.3 - d) / 0.3, 0, 1) * 0.18
    a = np.clip(core + star, 0, 1)
    return np.ones_like(a) * 0.97, a


def splash():
    rng = np.random.default_rng(7)
    im = Image.new("L", (N * 4, N * 4), 0)
    d = ImageDraw.Draw(im)
    c = N * 2
    for _ in range(26):  # droplets thrown up and out
        ang = rng.uniform(math.pi * 1.05, math.pi * 1.95)
        rr = rng.uniform(0.18, 0.44) * N * 4
        px, py = c + math.cos(ang) * rr, c * 1.25 + math.sin(ang) * rr * 0.9
        s = rng.uniform(6, 22)
        d.ellipse([px - s, py - s * 1.3, px + s, py + s * 1.3], fill=int(rng.uniform(170, 255)))
    for _ in range(14):  # soft spray body made of overlapping blobs
        px, py = c + rng.normal(0, N * 0.45), c * 1.2 + rng.normal(0, N * 0.18)
        s = rng.uniform(N * 0.2, N * 0.42)
        d.ellipse([px - s, py - s * 0.8, px + s, py + s * 0.8], fill=int(rng.uniform(90, 150)))
    a = np.asarray(im.resize((N, N), Image.LANCZOS)).astype(np.float32) / 255
    a = np.maximum(blur(a, 1.2), blur(a, 6) * 0.8)
    y = np.mgrid[0:N, 0:N][0] / N
    return 0.8 + 0.2 * (1 - y), a


def stones(seed):
    rng = np.random.default_rng(seed)
    im = Image.new("L", (N * 4, N * 4), 0)
    sh = Image.new("L", (N * 4, N * 4), 0)
    c = N * 2
    k = rng.integers(5, 8)
    pts = [(c + math.cos(t) * rng.uniform(0.6, 1) * N * 1.6, c + math.sin(t) * rng.uniform(0.6, 1) * N * 1.3)
           for t in sorted(rng.uniform(0, 2 * math.pi, k))]
    ImageDraw.Draw(im).polygon(pts, fill=255)
    # facet shading: two lighter planes on the upper side
    d = ImageDraw.Draw(sh)
    d.polygon(pts, fill=150)
    top = [p for p in pts if p[1] < c] + [(c, c)]
    if len(top) >= 3:
        d.polygon(top, fill=230)
    a = np.asarray(im.resize((N, N), Image.LANCZOS)).astype(np.float32) / 255
    g = np.asarray(sh.resize((N, N), Image.LANCZOS)).astype(np.float32) / 255
    g = g * (0.9 + 0.1 * noise(seed, 40))
    return np.where(a > 0, g / np.maximum(a, 1e-3), 0), a


def atlas(cells):
    g = np.zeros((N * 2, N * 2), np.float32)
    a = np.zeros_like(g)
    for i, (cg, ca) in enumerate(cells):
        y, x = (i // 2) * N, (i % 2) * N
        g[y:y + N, x:x + N], a[y:y + N, x:x + N] = cg, ca
    return g, a


if __name__ == "__main__":
    save(*puff(1), "dust.png")
    save(*atlas([puff(s) for s in (2, 3, 4, 5)]), "dust_sheet.png")
    save(*snow(), "snow.png")
    save(*splash(), "splash.png")
    save(*atlas([stones(s) for s in (11, 12, 13, 14)]), "stones.png")
    print(sorted(p.name for p in OUT.iterdir()))
