"""Contact sheet: python3 art/sheet.py out.jpg --cols 3 --cell 512 [--title T] [--checker] files...

Each image is fitted into a cell (keeping aspect), labelled with its file stem. --checker draws RGBA images
over a grey checkerboard so cut-out edges (white or black fringes) are visible.
"""
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()


def checker(w, h, s=16):
    im = Image.new("RGB", (w, h), (150, 150, 150))
    d = ImageDraw.Draw(im)
    for y in range(0, h, s):
        for x in range(0, w, s):
            if (x // s + y // s) % 2:
                d.rectangle([x, y, x + s - 1, y + s - 1], fill=(110, 110, 110))
    return im


def make(out, files, cols=3, cell=512, title=None, use_checker=False, aspect=None):
    files = [pathlib.Path(f) for f in files]
    if aspect is None:
        im0 = Image.open(files[0])
        aspect = im0.width / im0.height
    cw, ch = (cell, int(cell / aspect)) if aspect >= 1 else (int(cell * aspect), cell)
    lab = 26
    top = 48 if title else 0
    rows = (len(files) + cols - 1) // cols
    W, H = cols * (cw + 8) + 8, top + rows * (ch + lab + 8) + 8
    sheet = Image.new("RGB", (W, H), (34, 32, 30))
    d = ImageDraw.Draw(sheet)
    if title:
        d.text((12, 10), title, fill=(235, 225, 205), font=font(28))
    f = font(18)
    for i, p in enumerate(files):
        x = 8 + (i % cols) * (cw + 8)
        y = top + 8 + (i // cols) * (ch + lab + 8)
        im = Image.open(p)
        im.thumbnail((cw, ch), Image.LANCZOS)
        ox, oy = x + (cw - im.width) // 2, y + (ch - im.height) // 2
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = checker(im.width, im.height) if use_checker else Image.new("RGB", im.size, (34, 32, 30))
            bg.paste(im, (0, 0), im)
            im = bg
        sheet.paste(im.convert("RGB"), (ox, oy))
        d.text((x + 2, y + ch + 3), p.stem, fill=(220, 210, 190), font=f)
    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=85, optimize=True)


if __name__ == "__main__":
    a = sys.argv[1:]
    out = a.pop(0)
    kw = {}
    while a and a[0].startswith("--"):
        k = a.pop(0)
        if k == "--checker":
            kw["use_checker"] = True
        elif k == "--cols":
            kw["cols"] = int(a.pop(0))
        elif k == "--cell":
            kw["cell"] = int(a.pop(0))
        elif k == "--title":
            kw["title"] = a.pop(0)
        elif k == "--aspect":
            kw["aspect"] = float(a.pop(0))
    make(out, a, **kw)
