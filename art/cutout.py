"""Clean up BiRefNet cut-outs for use as game sprites.

  python3 art/cutout.py <src.png> <src_cut.png> <out.png> [--height 512] [--bottom] [--pad 4] [--maxkb 400]

Steps: (1) snap near-0/near-1 alpha, (2) remove the background colour bleeding into semi-transparent edge pixels
(background = median of the source border; solves light/dark fringes), (3) shave the alpha edge by ~1 px,
(4) crop to content (--bottom: content touches the bottom edge, e.g. feet / trunk base), (5) resize,
(6) bleed edge colours into the fully transparent area so mipmaps/bilinear filtering don't pull in black,
(7) save; quantise to 256 colours if the png is still larger than --maxkb.
"""
import io
import pathlib
import sys

import numpy as np
from PIL import Image, ImageFilter


def box(x, r=2):
    """Separable (2r+1)^2 box sum via shifts (float images; PIL filters don't take mode F)."""
    for ax in (0, 1):
        x = sum(np.roll(x, k, ax) for k in range(-r, r + 1))
    return x


def bleed(rgb, a, iters=24):
    """Push colours of opaque pixels outward into transparent ones (iterative normalised box blur)."""
    w = (a > 0.5).astype(np.float32)
    c = rgb * w[..., None]
    for _ in range(iters):
        if w.min() > 0:
            break
        cs = box(c)
        ws = box(w)
        fill = (w == 0) & (ws > 1e-4)
        c[fill] = cs[fill] / ws[fill][:, None]
        w = np.where(fill, 1.0, w).astype(np.float32)
    return np.where(a[..., None] > 0.5, rgb, c)


def clean(src, cut, out, height=None, bottom=False, pad=4, maxkb=400, width=None, sat=1.0):
    orig = np.asarray(Image.open(src).convert("RGB")).astype(np.float32) / 255
    im = np.asarray(Image.open(cut).convert("RGBA")).astype(np.float32) / 255
    rgb, a = im[..., :3], im[..., 3]
    border = np.concatenate([orig[:4].reshape(-1, 3), orig[-4:].reshape(-1, 3), orig[:, :4].reshape(-1, 3), orig[:, -4:].reshape(-1, 3)])
    bg = np.median(border, 0)
    a = np.where(a < 0.05, 0, np.where(a > 0.95, 1, a))
    # decontaminate: observed = a*fg + (1-a)*bg  ->  fg = (observed - (1-a)*bg) / a
    am = np.maximum(a, 0.05)[..., None]
    fg = np.clip((rgb - (1 - am) * bg) / am, 0, 1)
    rgb = np.where((a > 0) & (a < 1), fg.transpose(2, 0, 1), rgb.transpose(2, 0, 1)).transpose(1, 2, 0)
    # shave ~1px off the edge: average of alpha and its 3x3 minimum
    amin = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))).astype(np.float32) / 255
    a = 0.4 * a + 0.6 * amin
    a = np.where(a < 0.04, 0, a)
    ys, xs = np.where(a > 0.03)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgb, a = rgb[y0:y1, x0:x1], a[y0:y1, x0:x1]
    h, w = a.shape
    # canvas with padding; bottom-aligned content gets no bottom padding
    H, W = h + pad * (1 if bottom else 2), w + pad * 2
    cr = np.zeros((H, W, 3), np.float32)
    ca = np.zeros((H, W), np.float32)
    cr[pad:pad + h, pad:pad + w], ca[pad:pad + h, pad:pad + w] = rgb, a
    rgb = bleed(cr, ca)
    if sat != 1.0:  # pull saturation toward the poster palette
        g = (rgb * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1, keepdims=True)
        rgb = np.clip(g + (rgb - g) * sat, 0, 1)
    img = Image.fromarray((np.dstack([rgb, ca[..., None]]) * 255 + 0.5).astype(np.uint8), "RGBA")
    if height and img.height != height:
        img = img.resize((max(1, round(img.width * height / img.height)), height), Image.LANCZOS)
    if width and img.width > width:
        img = img.resize((width, max(1, round(img.height * width / img.width))), Image.LANCZOS)
    out = pathlib.Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    if buf.tell() > maxkb * 1024:
        img.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(out, optimize=True)
    else:
        out.write_bytes(buf.getvalue())
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    kw = {}
    for k, t in (("--height", int), ("--width", int), ("--pad", int), ("--maxkb", int)):
        if k in args:
            i = args.index(k)
            kw[k[2:]] = t(args[i + 1])
            del args[i:i + 2]
    if "--bottom" in args:
        args.remove("--bottom")
        kw["bottom"] = True
    print(clean(*args, **kw))
