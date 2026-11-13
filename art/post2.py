"""Batch 2 post-processing, driven by picks files (output path -> source candidate + options).

  python3 art/post2.py cut  art/jobs/veg2_picks.json     # RGBA sprites (vegetation, crowd, staff, props, trophies)
  python3 art/post2.py ui   art/jobs/ui2_picks.json      # full-frame jpg/png UI art
  python3 art/post2.py metals                            # trophy/medal silver + bronze from the gold cut-outs

cut picks:  {"public/assets/...png": {"src": "name", "raw": "art/raw/b2/veg", "height"|"width": px, "bottom": true, "sat": 0.9}}
            -> cutout.clean (decontaminate edge, shave 1 px, crop, bottom-align, colour bleed, quantise > 390 KB).
            "keep_largest": true drops loose specks that BiRefNet left (only the largest connected blob + blobs > 2 % of it stay).
ui picks:   {"public/assets/ui/x.jpg": {"src", "raw", "size": [w, h], "dim": 1.0, "contrast": 1.0, "sat": 1.0, "patch": [[x0,y0,x1,y1]...],
            "crop": [x0,y0,x1,y1 fractions], "texture": true}}  texture = card_texture() overlay (contours, dust, grain)  -> trim paper margin, optional crop, centre-fit to size, tone (contrast toward
            the mean, then multiply by dim: menu backgrounds are pressed down so text reads on top), jpg q85 or png.
metals:     the gold trophy/medal: pixels whose hue is gold (and are saturated) are re-mapped through a silver or bronze ramp
            by their luminance; everything else (wooden base, ribbon) keeps its colour.
"""
import colorsys
import io
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cutout  # noqa: E402
import post  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


def save_png(img, out, maxkb=390):
    out = pathlib.Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    if buf.tell() > maxkb * 1024:
        img.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(out, optimize=True)
    else:
        out.write_bytes(buf.getvalue())


def keep_largest(cut_path, dst):
    """Zero alpha outside the main blob(s) of a cut-out (BiRefNet sometimes keeps specks or background bits)."""
    from collections import deque
    im = Image.open(cut_path).convert("RGBA")
    a = np.asarray(im).copy()
    m = a[..., 3] > 40
    small = Image.fromarray(m.astype(np.uint8) * 255).resize((m.shape[1] // 4, m.shape[0] // 4), Image.BOX)
    sm = np.asarray(small) > 20
    lab = np.zeros(sm.shape, np.int32)
    sizes = [0]
    for y, x in zip(*np.where(sm)):
        if lab[y, x]:
            continue
        n = len(sizes)
        q = deque([(y, x)])
        lab[y, x] = n
        cnt = 0
        while q:
            cy, cx = q.popleft()
            cnt += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = cy + dy, cx + dx
                if 0 <= yy < sm.shape[0] and 0 <= xx < sm.shape[1] and sm[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n
                    q.append((yy, xx))
        sizes.append(cnt)
    big = max(sizes)
    keep = np.array([s >= 0.02 * big for s in sizes])
    keep[0] = False
    km = np.asarray(Image.fromarray(keep[lab].astype(np.uint8) * 255).resize((m.shape[1], m.shape[0]), Image.NEAREST)) > 0
    a[..., 3] = np.where(km, a[..., 3], 0)
    Image.fromarray(a, "RGBA").save(dst)
    return dst


def cut(picks_path):
    cfg = json.load(open(picks_path))
    for out, p in cfg.items():
        if out.startswith("_"):
            continue
        raw = ROOT / p["raw"]
        src, c = raw / f"{p['src']}.png", raw / f"{p['src']}_cut.png"
        if p.get("keep_largest"):
            c = keep_largest(c, raw / f"{p['src']}_cutk.png")
        cutout.clean(src, c, ROOT / out, height=p.get("height"), width=p.get("width"), bottom=p.get("bottom", False),
                     maxkb=390, sat=p.get("sat", 1.0))
        print(out, (ROOT / out).stat().st_size // 1024, "KB", Image.open(ROOT / out).size)


def tone(im, contrast=1.0, dim=1.0, sat=1.0):
    a = np.asarray(im.convert("RGB")).astype(np.float32) / 255
    if sat != 1.0:
        g = (a * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1, keepdims=True)
        a = g + (a - g) * sat
    if contrast != 1.0:
        m = a.mean((0, 1), keepdims=True)
        a = m + (a - m) * contrast
    a = np.clip(a * dim, 0, 1)
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8))


def card_texture(im, seed=1, contour=0.10, dust=1.0):
    """Poster texture for the car-card backgrounds (the model painted clean bands only): faint topographic contour
    lines from a smooth noise field, dust speckle/splatter, fine print grain. Everything multiplies the existing colours."""
    from PIL import ImageDraw, ImageFilter
    rng = np.random.default_rng(seed)
    w, h = im.size
    a = np.asarray(im.convert("RGB")).astype(np.float32) / 255
    g = rng.random((7, 10)).astype(np.float32)
    field = np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)).astype(np.float32) / 255
    field = np.asarray(Image.fromarray((field * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32) / 255
    k = field * 14
    gy, gx = np.gradient(k)
    dist = np.abs(k - np.round(k)) / np.maximum(np.hypot(gx, gy), 1e-4)  # distance to the nearest isoline in px
    line = np.clip(1.2 - dist, 0, 1)  # ~1.5 px lines, no blobs where the field is flat
    a = a * (1 - contour * line[..., None])
    dots = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(dots)
    for _ in range(int(2500 * dust)):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.choice([0.7, 1.0, 1.5, 2.5, 4.0], p=[0.45, 0.3, 0.15, 0.07, 0.03])
        d.ellipse([x - r, y - r, x + r, y + r], fill=int(rng.uniform(60, 160)))
    dots = np.asarray(dots.filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255
    a = a * (1 - 0.35 * dots[..., None])
    a = a * (1 + rng.normal(0, 0.025, (h, w, 1)).astype(np.float32))
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def ui(picks_path):
    cfg = json.load(open(picks_path))
    for out, p in cfg.items():
        if out.startswith("_"):
            continue
        im = Image.open(ROOT / p["raw"] / f"{p['src']}.png").convert("RGB")
        if p.get("patch"):
            im = post.patch(im, p["patch"])
        im = post.trim_border(im)
        if p.get("crop"):
            x0, y0, x1, y1 = p["crop"]
            im = im.crop((int(x0 * im.width), int(y0 * im.height), int(x1 * im.width), int(y1 * im.height)))
        im = post.fit(im, *p["size"])
        im = tone(im, p.get("contrast", 1.0), p.get("dim", 1.0), p.get("sat", 1.0))
        if p.get("texture"):
            im = card_texture(im, seed=p.get("seed", 1))
        if out.endswith(".png"):
            save_png(im, ROOT / out)
        else:
            post.save_jpg(im, ROOT / out, p.get("q", 85))
        print(out, (ROOT / out).stat().st_size // 1024, "KB")


RAMPS = {  # luminance 0 -> 1 colour stops
    "silver": [(0.0, (40, 44, 52)), (0.45, (140, 146, 156)), (0.8, (205, 210, 218)), (1.0, (250, 251, 252))],
    "bronze": [(0.0, (48, 24, 12)), (0.45, (150, 86, 46)), (0.8, (205, 140, 88)), (1.0, (248, 214, 170))],
}


def ramp(l, stops):
    xs = [s[0] for s in stops]
    return np.stack([np.interp(l, xs, [s[1][c] for s in stops]) for c in range(3)], -1)


def metals():
    for kind in ("trophy", "medal"):
        src = ROOT / f"public/assets/ui/{kind}_gold.png"
        if not src.exists():
            continue
        a = np.asarray(Image.open(src).convert("RGBA")).astype(np.float32)
        rgb = a[..., :3] / 255
        hsv = np.vectorize(colorsys.rgb_to_hsv, otypes=[float, float, float])(rgb[..., 0], rgb[..., 1], rgb[..., 2])
        h, s, v = hsv
        hue = (h > 0.07) & (h < 0.17) & (s > 0.25)
        near = np.asarray(Image.fromarray(hue.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(9))) > 0
        gold = hue | ((s < 0.18) & (v > 0.85) & near)  # gold hues + white highlights on the metal (not the ribbon)
        lum = (rgb * np.array([0.299, 0.587, 0.114])).sum(-1)
        lum = np.clip((lum - 0.12) / 0.8, 0, 1)
        for metal, stops in RAMPS.items():
            out = a.copy()
            out[..., :3] = np.where(gold[..., None], ramp(lum, stops), a[..., :3])
            save_png(Image.fromarray(out.astype(np.uint8), "RGBA"), ROOT / f"public/assets/ui/{kind}_{metal}.png")
            print(kind, metal)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "metals":
        metals()
    else:
        {"cut": cut, "ui": ui}[cmd](sys.argv[2])
