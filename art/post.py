"""Post-processing for full-frame illustrations (concepts, UI art, skies).

  python3 art/post.py concepts   -> docs/art/concept_*.jpg (picked concept per env + all candidates sheet)
  python3 art/post.py ui         -> public/assets/ui/*.jpg from the picks in art/jobs/ui_picks.json
  python3 art/post.py crowd      -> public/assets/crowd/<env>_<n>.png
  python3 art/post.py veg        -> public/assets/tex/nordic/ foliage cards + billboards

Poster prompts often get a paper margin; trim_border() detects and removes it (rows/columns from each side that
are near-uniform and close to the corner colour), then the image is cropped back to the requested aspect.
patch() paints small rectangles with the median colour of their surroundings (used to remove pseudo-lettering
the model sometimes puts on the car's rear panel).
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "art"))


def trim_border(im, tol=18, max_frac=0.08):
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    h, w = a.shape[:2]
    corner = np.median(np.concatenate([a[:3, :3].reshape(-1, 3), a[:3, -3:].reshape(-1, 3), a[-3:, :3].reshape(-1, 3), a[-3:, -3:].reshape(-1, 3)]), 0)

    def is_border(line):
        return np.abs(line - corner).mean() < tol and line.std(0).mean() < tol

    t = 0
    while t < h * max_frac and is_border(a[t]):
        t += 1
    b = h
    while h - b < h * max_frac and is_border(a[b - 1]):
        b -= 1
    l = 0
    while l < w * max_frac and is_border(a[:, l]):
        l += 1
    r = w
    while w - r < w * max_frac and is_border(a[:, r - 1]):
        r -= 1
    if t or l or b < h or r < w:  # a margin was found: cut a few pixels more to drop its soft inner edge
        t, l, b, r = t + 4 if t else 0, l + 4 if l else 0, b - 4 if b < h else h, r - 4 if r < w else w
    return im.crop((l, t, r, b))


def fit(im, w, h):
    """Centre-crop to the w:h aspect, then resize to w x h."""
    ar = w / h
    if im.width / im.height > ar:
        nw = int(im.height * ar)
        im = im.crop(((im.width - nw) // 2, 0, (im.width - nw) // 2 + nw, im.height))
    else:
        nh = int(im.width / ar)
        im = im.crop((0, (im.height - nh) // 2, im.width, (im.height - nh) // 2 + nh))
    return im.resize((w, h), Image.LANCZOS)


def patch(im, boxes):
    a = np.asarray(im.convert("RGB")).copy()
    for x0, y0, x1, y1 in boxes:
        ring = np.concatenate([a[y0 - 3:y0, x0:x1].reshape(-1, 3), a[y1:y1 + 3, x0:x1].reshape(-1, 3)])
        a[y0:y1, x0:x1] = np.median(ring, 0)
    out = Image.fromarray(a)
    # soften the patch edges a little so it reads as paint, not a sticker
    blurred = out.filter(ImageFilter.GaussianBlur(1.2))
    m = Image.new("L", out.size, 0)
    for x0, y0, x1, y1 in boxes:
        m.paste(255, (x0 - 2, y0 - 2, x1 + 2, y1 + 2))
    m = m.filter(ImageFilter.GaussianBlur(2))
    return Image.composite(blurred, out, m)


def save_jpg(im, p, q=85):
    p = pathlib.Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    im.convert("RGB").save(p, quality=q, optimize=True, progressive=True)


CONCEPT_PICKS = {
    "nordic": ("concept_nordic_1", [(766, 474, 802, 488)]),  # pseudo-badge on the tail panel
    "savanna": ("concept_savanna_1", []),
    "snow": ("concept_snow_1", []),
    "coast": ("concept_coast_1b", []),
}


def concepts():
    raw = ROOT / "art/raw/concept"
    for env, (src, boxes) in CONCEPT_PICKS.items():
        im = Image.open(raw / f"{src}.png").convert("RGB")
        if boxes:
            im = patch(im, boxes)
        save_jpg(fit(trim_border(im), 1280, 720), ROOT / f"docs/art/concept_{env}.jpg")


def ui():
    cfg = json.load(open(ROOT / "art/jobs/ui_picks.json"))
    for out, p in cfg.items():
        im = Image.open(ROOT / "art/raw/ui" / f"{p['src']}.png").convert("RGB")
        if p.get("patch"):
            im = patch(im, p["patch"])
        im = fit(trim_border(im), *p["size"])
        save_jpg(im, ROOT / out, p.get("q", 84))


def crowd():
    import cutout
    cfg = json.load(open(ROOT / "art/jobs/crowd_picks.json"))
    for out, src in cfg.items():
        raw = ROOT / "art/raw/crowd"
        cutout.clean(raw / f"{src}.png", raw / f"{src}_cut.png", ROOT / out, height=512, bottom=True, maxkb=380, sat=0.9)


def veg():
    import cutout
    cfg = json.load(open(ROOT / "art/jobs/veg_picks.json"))
    raw = ROOT / "art/raw/veg"
    for out, p in cfg.items():
        cutout.clean(raw / f"{p['src']}.png", raw / f"{p['src']}_cut.png", ROOT / out, height=p.get("height"),
                     width=p.get("width"), bottom=p.get("bottom", False), maxkb=390, sat=p.get("sat", 1.0))


if __name__ == "__main__":
    {"concepts": concepts, "ui": ui, "crowd": crowd, "veg": veg}[sys.argv[1]]()
