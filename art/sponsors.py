"""Fictional sponsors, drawn entirely in code (no generation model: text from diffusion models is unreliable).

  python3 art/sponsors.py
    -> public/assets/sponsors/<id>.png      logo, RGBA, transparent background (mark + wordmark)
       public/assets/sponsors/banner_<n>.jpg roadside banners, 2048x512 (4:1)
       public/assets/decals/atlas.png      car sticker atlas 2048x2048 RGBA
       public/assets/decals/atlas.json     rects per sticker (pixels, and uv with v up = three.js flipY default)

Names were checked with a web search (2026-11-11): none is a known consumer brand. Colours follow the retro
poster look: off-white instead of pure white, two or three flat colours per brand, slight print grain on banners.
"""
import json
import math
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SP = ROOT / "public/assets/sponsors"
DC = ROOT / "public/assets/decals"
SUP = "/System/Library/Fonts/Supplemental/"
FONTS = {
    "futura_xb": (SUP + "Futura.ttc", 4), "futura_b": (SUP + "Futura.ttc", 2),
    "avenir_hi": ("/System/Library/Fonts/Avenir Next Condensed.ttc", 9), "avenir_h": ("/System/Library/Fonts/Avenir Next Condensed.ttc", 8),
    "din": (SUP + "DIN Condensed Bold.ttf", 0), "impact": (SUP + "Impact.ttf", 0), "rockwell": (SUP + "Rockwell.ttc", 2),
    "gill_ub": (SUP + "GillSans.ttc", 6), "black": (SUP + "Arial Black.ttf", 0),
}
OFF = (244, 236, 216)
INK = (30, 28, 30)

# id, name, product, mark, font, colours (primary, secondary, accent)
BRANDS = [
    ("vargolt", "VARGOLT", "机油", "drop", "avenir_hi", ((226, 104, 38), INK, OFF)),
    ("velluma", "VELLUMA", "车灯", "sun", "futura_xb", ((240, 190, 50), (32, 52, 92), OFF)),
    ("haldro", "HALDRO", "电瓶", "bolt", "impact", ((200, 44, 40), INK, OFF)),
    ("quentar", "QUENTAR", "燃油", "stripes", "futura_b", ((34, 84, 160), (214, 52, 44), OFF)),
    ("mirsava", "MIRSAVA", "矿泉水", "peak", "gill_ub", ((30, 130, 140), (24, 60, 80), OFF)),
    ("zeptal", "ZEPTAL", "火花塞", "spark", "din", ((214, 52, 44), OFF, INK)),
    ("telmora", "TELMORA", "电台", "waves", "avenir_h", ((92, 60, 130), (244, 196, 64), OFF)),
    ("brunska", "BRUNSKA", "咖啡", "bean", "rockwell", ((110, 66, 40), (236, 214, 170), OFF)),
    ("osvari", "OSVARI", "护目镜", "diamond", "futura_b", (INK, (210, 170, 70), OFF)),
    ("graviko", "GRAVIKO", "轮胎", "tread", "black", ((246, 196, 40), INK, OFF)),
    ("falkora", "FALKORA", "计时表", "wing", "din", ((30, 44, 84), (214, 168, 70), OFF)),
    ("pyranto", "PYRANTO", "刹车", "flame", "avenir_hi", ((226, 70, 36), (250, 170, 40), INK)),
]

S = 4  # supersampling factor for anti-aliased drawing


def font(key, size):
    p, i = FONTS[key]
    return ImageFont.truetype(p, size, index=i)


def mark(kind, size, c1, c2, c3):
    """Draw a brand mark into a size x size RGBA image (supersampled)."""
    n = size * S
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = n / 2
    if kind == "drop":
        d.ellipse([n * .06, n * .06, n * .94, n * .94], fill=c2)
        d.polygon([(m, n * .16), (m - n * .2, n * .52), (m + n * .2, n * .52)], fill=c1)
        d.ellipse([m - n * .21, n * .4, m + n * .21, n * .82], fill=c1)
        d.ellipse([m - n * .1, n * .54, m - n * .02, n * .68], fill=c3)
    elif kind == "sun":
        d.ellipse([n * .04, n * .04, n * .96, n * .96], fill=c2)
        for k in range(12):
            a0, a1 = math.radians(k * 30 - 6), math.radians(k * 30 + 6)
            d.polygon([(m, m), (m + math.cos(a0) * n * .44, m + math.sin(a0) * n * .44), (m + math.cos(a1) * n * .44, m + math.sin(a1) * n * .44)], fill=c1)
        d.ellipse([m - n * .19, m - n * .19, m + n * .19, m + n * .19], fill=c1, outline=c2, width=int(n * .03))
    elif kind == "bolt":
        pts = [(m + n * .5 * math.cos(math.radians(60 * k + 30)), m + n * .5 * math.sin(math.radians(60 * k + 30))) for k in range(6)]
        d.polygon(pts, fill=c2)
        d.polygon([(m + n * .08, n * .12), (m - n * .2, m + n * .05), (m - n * .01, m + n * .05), (m - n * .1, n * .88), (m + n * .22, m - n * .07), (m + n * .02, m - n * .07)], fill=c1)
    elif kind == "stripes":
        d.rounded_rectangle([n * .04, n * .14, n * .96, n * .86], radius=n * .1, fill=c1)
        for k in range(3):  # three forward-leaning speed bars
            x = n * (.2 + k * .22)
            d.polygon([(x + n * .12, n * .24), (x + n * .24, n * .24), (x + n * .08, n * .76), (x - n * .04, n * .76)], fill=c3 if k < 2 else c2)
    elif kind == "peak":
        d.rectangle([n * .04, n * .04, n * .96, n * .96], fill=c2)
        d.polygon([(n * .08, n * .74), (n * .4, n * .22), (n * .55, n * .45), (n * .66, n * .32), (n * .92, n * .74)], fill=c3)
        d.polygon([(n * .4, n * .22), (n * .48, n * .35), (n * .32, n * .35)], fill=c1)
        for k in range(2):
            y = n * (.8 + k * .08)
            d.line([(n * (.08 + j * .14), y + (n * .025 if j % 2 else -n * .025)) for j in range(7)], fill=c1, width=int(n * .04), joint="curve")
    elif kind == "spark":
        d.ellipse([n * .04, n * .04, n * .96, n * .96], fill=c1)
        pts = []
        for k in range(16):
            r = n * (.42 if k % 2 == 0 else .14)
            a = math.radians(k * 22.5 - 90)
            pts.append((m + math.cos(a) * r, m + math.sin(a) * r))
        d.polygon(pts, fill=c2)
        d.ellipse([m - n * .07, m - n * .07, m + n * .07, m + n * .07], fill=c3)
    elif kind == "waves":
        d.rectangle([0, 0, n, n], fill=c1)
        for k, r in enumerate((.12, .26, .4)):
            w = int(n * .07)
            d.arc([n * .2 - n * r, m - n * r, n * .2 + n * r, m + n * r], -55, 55, fill=c2, width=w)
        d.ellipse([n * .14, m - n * .06, n * .26, m + n * .06], fill=c2)
    elif kind == "bean":
        d.ellipse([n * .04, n * .04, n * .96, n * .96], fill=c2)
        d.ellipse([n * .24, n * .12, n * .76, n * .88], fill=c1)
        d.arc([n * .2, n * .14, n * .6, n * .86], -70, 70, fill=c2, width=int(n * .05))
    elif kind == "diamond":
        d.polygon([(m, n * .04), (n * .96, m), (m, n * .96), (n * .04, m)], fill=c1)
        d.polygon([(m, n * .2), (n * .8, m), (m, n * .8), (n * .2, m)], fill=c2)
        d.ellipse([m - n * .12, m - n * .12, m + n * .12, m + n * .12], fill=c1)
    elif kind == "tread":
        d.rounded_rectangle([n * .04, n * .04, n * .96, n * .96], radius=n * .12, fill=c2)
        for k in range(4):
            y = n * (.14 + k * .2)
            d.polygon([(n * .16, y + n * .12), (m, y), (n * .84, y + n * .12), (n * .84, y + n * .2), (m, y + n * .08), (n * .16, y + n * .2)], fill=c1)
    elif kind == "wing":
        d.ellipse([n * .04, n * .04, n * .96, n * .96], fill=c1)
        for k in range(4):
            x0 = n * (.18 + k * .06)
            d.polygon([(x0, n * (.38 + k * .09)), (n * .84, n * (.26 + k * .07)), (n * .84, n * (.3 + k * .07)), (x0 + n * .1, n * (.44 + k * .09))], fill=c2)
    elif kind == "flame":
        d.polygon([(n * .1, n * .08), (n * .9, n * .08), (n * .9, n * .55), (m, n * .96), (n * .1, n * .55)], fill=c3)
        d.polygon([(m, n * .16), (n * .72, n * .5), (n * .66, n * .74), (m, n * .84), (n * .34, n * .74), (n * .3, n * .52), (n * .42, n * .58)], fill=c1)
        d.polygon([(m, n * .44), (n * .6, n * .62), (m, n * .78), (n * .42, n * .66)], fill=c2)
    return im.resize((size, size), Image.LANCZOS)


def wordmark(text, fkey, h, color, italic_skew=0.0):
    f = font(fkey, h * S)
    l, t, r, b = f.getbbox(text)
    im = Image.new("RGBA", (r - l + h * S // 2, b - t + h * S // 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((-l + h * S // 4, -t + h * S // 8), text, font=f, fill=color)
    if italic_skew:
        w = im.width + int(im.height * italic_skew)
        im = im.transform((w, im.height), Image.AFFINE, (1, italic_skew, -im.height * italic_skew, 0, 1, 0), Image.BICUBIC)
    return im.resize((max(1, im.width // S), max(1, im.height // S)), Image.LANCZOS)


def logo(b, h=200, text_color=None):
    """Mark on the left + wordmark on the right, transparent background."""
    _, name, _, kind, fk, (c1, c2, c3) = b
    mk = mark(kind, h, c1, c2, c3)
    wm = wordmark(name, fk, int(h * 0.62), text_color or c1, 0.18 if fk.endswith("i") else 0)
    W = h + int(h * .12) + wm.width
    im = Image.new("RGBA", (W, h), (0, 0, 0, 0))
    im.alpha_composite(mk, (0, 0))
    im.alpha_composite(wm, (h + int(h * .12), (h - wm.height) // 2))
    return im


def grain(im, amount=10, seed=0):
    a = np.asarray(im).astype(np.int16)
    rng = np.random.default_rng(seed)
    nz = rng.normal(0, amount, a.shape[:2])[..., None]
    a[..., :3] = np.clip(a[..., :3] + nz, 0, 255)
    return Image.fromarray(a.astype(np.uint8))


def sticker(b, w, h):
    """Car decal: logo on a rounded panel so it reads on any livery colour."""
    _, name, _, kind, fk, (c1, c2, c3) = b
    bg = c3 if c1 != c3 else OFF
    lum = lambda c: 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
    txt = max((c1, c2), key=lambda c: abs(lum(c) - lum(bg)))  # whichever brand colour reads best on the panel
    im = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, w * S - 1, h * S - 1], radius=h * S // 6, fill=bg, outline=c2 if c2 != bg else c1, width=h * S // 20)
    im = im.resize((w, h), Image.LANCZOS)
    lg = logo(b, int(h * .72), text_color=txt)
    lg.thumbnail((int(w * .9), int(h * .72)), Image.LANCZOS)
    im.alpha_composite(lg, ((w - lg.width) // 2, (h - lg.height) // 2))
    return im


def banner(i, a, b2):
    """4:1 roadside banner: two sponsors, alternating, on bold colour fields with a retro stripe."""
    W, H = 2048, 512
    _, _, _, _, _, (c1, c2, c3) = a
    im = Image.new("RGBA", (W, H), c1 + (255,))
    d = ImageDraw.Draw(im)
    d.rectangle([W // 2, 0, W, H], fill=b2[5][1] + (255,) if b2[5][1] != INK else (40, 38, 40, 255))
    d.rectangle([0, H - 56, W, H - 32], fill=OFF + (255,))
    d.rectangle([0, 32, W, 44], fill=OFF + (255,))
    for k, (br, x0) in enumerate(((a, 0), (b2, W // 2))):
        bc1, bc2, bc3 = br[5]
        field = c1 if k == 0 else (b2[5][1] if b2[5][1] != INK else (40, 38, 40))
        txt = OFF if sum(field) < 450 else INK
        lg = logo(br, 300, text_color=txt)
        lg.thumbnail((W // 2 - 120, 300), Image.LANCZOS)
        im.alpha_composite(lg, (x0 + (W // 2 - lg.width) // 2, (H - lg.height) // 2 - 6))
    return grain(im.convert("RGB"), 7, i)


def main():
    SP.mkdir(parents=True, exist_ok=True)
    DC.mkdir(parents=True, exist_ok=True)
    meta = []
    for b in BRANDS:
        lg = logo(b, 256, text_color=b[5][0] if sum(b[5][0]) < 600 else b[5][1])
        lg.save(SP / f"{b[0]}.png", optimize=True)
        meta.append({"id": b[0], "name": b[1], "product": b[2]})
    pairs = [(0, 6), (3, 11), (9, 5), (7, 2), (1, 4), (10, 8)]
    for i, (p, q) in enumerate(pairs):
        banner(i, BRANDS[p], BRANDS[q]).save(SP / f"banner_{i + 1}.jpg", quality=86, optimize=True)
    # decal atlas: 12 wide stickers (2 cols x 6 rows, 1000x240), then 12 square marks, then generic roundel + number panel
    A = 2048
    atlas = Image.new("RGBA", (A, A), (0, 0, 0, 0))
    rects = {}

    def put(key, im, x, y):
        atlas.alpha_composite(im, (x, y))
        w, h = im.size
        rects[key] = {"px": [x, y, w, h], "uv": [round(x / A, 5), round(1 - (y + h) / A, 5), round((x + w) / A, 5), round(1 - y / A, 5)]}

    for i, b in enumerate(BRANDS):
        put(b[0], sticker(b, 1000, 240), 16 + (i % 2) * 1016, 16 + (i // 2) * 256)
    for i, b in enumerate(BRANDS):
        put(b[0] + "_mark", mark(b[3], 160, *b[5]), 16 + i * 168, 1560)
    # generic door roundel and number panel (the livery code prints the car number onto them)
    r = Image.new("RGBA", (300 * S, 300 * S), (0, 0, 0, 0))
    ImageDraw.Draw(r).ellipse([0, 0, 300 * S - 1, 300 * S - 1], fill=OFF + (255,), outline=INK + (255,), width=10 * S)
    put("roundel", r.resize((300, 300), Image.LANCZOS), 16, 1740)
    p = Image.new("RGBA", (520 * S, 200 * S), (0, 0, 0, 0))
    ImageDraw.Draw(p).rounded_rectangle([0, 0, 520 * S - 1, 200 * S - 1], radius=20 * S, fill=OFF + (255,), outline=INK + (255,), width=8 * S)
    put("number_panel", p.resize((520, 200), Image.LANCZOS), 340, 1740)
    # flat colours: a 256-colour palette is visually lossless here and keeps the file under 400 KB
    atlas.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(DC / "atlas.png", optimize=True)
    (DC / "atlas.json").write_text(json.dumps({
        "_doc": "Sticker rects in atlas.png (2048x2048). px = [x, y, w, h] from top-left. uv = [u0, v0, u1, v1] with v measured "
                "from the bottom (three.js default flipY=true). <id> = wide sticker on a panel, <id>_mark = square mark only, "
                "roundel / number_panel = blank shapes for the car number.",
        "size": A, "sponsors": meta, "rects": rects}, indent=1, ensure_ascii=False) + "\n")
    print("ok", len(rects), "rects")


if __name__ == "__main__":
    main()
