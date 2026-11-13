"""Make generated textures tile without seams, normalise them, and preview the tiling.

Method: offset + image quilting with minimum-error cuts, done one axis at a time.
  Inputs: the picked image I and a variant V of the same material (Z-Image img2img of I, denoise ~0.75:
  same palette and scale, different layout; see make_ground.py).
  1. H pass: roll I by half the width, so its old left/right edges meet in a vertical seam through the middle
     (the new left/right edges come from I's centre and already wrap). Cover the seam with a vertical band
     taken from V. Each band edge is a dynamic-programming minimum-error cut through a 72 px overlap
     (Efros & Freeman 2001), so the boundary winds around pebbles/tufts instead of cutting through them.
     -> T1, periodic left/right. The same is done to V (patched from I) -> V1, also periodic left/right.
  2. V pass: the same on the transposed images: roll T1 by half the height, cover the horizontal seam with a
     band from V1. Here the cuts must start and end on the same row (cyclic), otherwise the left/right wrap
     breaks again. -> T2, periodic both ways.
  3. flatten low-frequency lighting with a wrap-around (FFT) blur; scale to the material's target mean
     luminance (multiplicative, keeps hue) and pull contrast toward rel_std * mean.
Skies only need step 1 (horizontal wrap).

(Earlier tries that failed: inpainting the seam cross directly left straight visible band edges; quilting a
cross in one go broke the wrap where the band itself reached the tile edge.)

  python3 art/seamless.py tile    I.png V.png out.jpg [--mean 0.5] [--rel_std 0.25]
  python3 art/seamless.py preview tex.jpg preview.jpg
  python3 art/seamless.py check   tex.jpg      # wrap-edge difference vs. interior rows/cols at JPEG block edges
"""
import pathlib
import sys

import numpy as np
from PIL import Image, ImageFilter

BAND = 0.12  # half-width of the patch band, as a fraction of the size
OV = 72  # width of the overlap zone the cut runs in
LUMA = np.array([0.299, 0.587, 0.114], np.float32)


def load(p, size=None):
    im = Image.open(p).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def save(a, p, quality=86):
    p = pathlib.Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))
    if p.suffix == ".jpg":
        im.save(p, quality=quality, optimize=True, progressive=True)
    else:
        im.save(p, optimize=True)


def lum(a):
    return (a * LUMA).sum(-1)


def blur_wrap(a, sigma):
    """Gaussian blur with periodic boundaries (FFT), so a tileable image stays tileable."""
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    k = np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    if a.ndim == 2:
        return np.real(np.fft.ifft2(np.fft.fft2(a) * k))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * k)) for c in range(a.shape[2])], -1)


def min_cut_path(cost, cyclic=False):
    """Minimum-cost top-to-bottom path through cost (rows x cols), moving at most 1 column per row.
    cyclic=True forces the path to end in the column it started in."""
    h, w = cost.shape

    def solve(start_cost):
        acc = cost.copy()
        acc[0] = start_cost
        back = np.zeros((h, w), np.int8)
        for y in range(1, h):
            prev = acc[y - 1]
            cand = np.stack([np.r_[np.inf, prev[:-1]], prev, np.r_[prev[1:], np.inf]])
            k = cand.argmin(0)
            acc[y] += cand[k, np.arange(w)]
            back[y] = k - 1
        return acc, back

    acc, back = solve(cost[0].copy())
    end = int(acc[-1].argmin())
    if cyclic:  # trace to find a good start, then re-solve with the start pinned and end there too
        path = trace(back, end)
        s0 = path[0]
        start = np.full(w, np.inf, np.float32)
        start[s0] = cost[0, s0]
        acc, back = solve(start)
        end = s0
    return trace(back, end)


def trace(back, end):
    h = back.shape[0]
    path = np.zeros(h, int)
    path[-1] = end
    for y in range(h - 1, 0, -1):
        path[y - 1] = path[y] + back[y, path[y]]
    return path


def band_mask(a, b, band, cyclic):
    """Mask (1 = take b) for a vertical band through the middle; both edges are min-error cuts."""
    h, w = a.shape[:2]
    err = ((a - b) ** 2).sum(-1)
    c = w // 2
    lo, hi = c - band, c + band
    pl = min_cut_path(err[:, lo - OV // 2: lo + OV // 2], cyclic) + lo - OV // 2
    pr = min_cut_path(err[:, hi - OV // 2: hi + OV // 2], cyclic) + hi - OV // 2
    cols = np.arange(w)[None, :]
    m = ((cols >= pl[:, None]) & (cols < pr[:, None])).astype(np.float32)
    # 1.5 px feather; the blur must wrap vertically in cyclic mode so the wrap edge isn't softened unevenly
    return np.clip(blur_wrap(m, 1.2), 0, 1) if cyclic else \
        np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255


def hpass(img, src, cyclic=False, band_frac=BAND):
    """Make img wrap left/right: roll by half the width, cover the middle seam with a band from src."""
    h, w = img.shape[:2]
    r = np.roll(img, w // 2, 1)
    if src.shape != r.shape:
        src = np.asarray(Image.fromarray((src * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    # give the patch source the local tone of the image it is pasted into (swap its low frequencies), so the
    # cut only has to hide detail, not a brightness/colour step
    src = np.clip(src + blur_wrap(r, 64) - blur_wrap(src, 64), 0, 1)
    m = band_mask(r, src, int(band_frac * w), cyclic)[..., None]
    return r * (1 - m) + src * m


def make_tileable(I, V):
    T1 = hpass(I, V)
    V1 = hpass(V, np.roll(I, I.shape[0] // 3, 0))
    # vertical pass on the transposed images; V1 is shifted so its patch rows differ from T1's content
    T2 = hpass(T1.transpose(1, 0, 2), np.roll(V1, V1.shape[1] // 4, 1).transpose(1, 0, 2), cyclic=True)
    return T2.transpose(1, 0, 2)


def periodic_part(a):
    """Moisan's periodic + smooth decomposition: subtract the smooth image whose Laplacian equals the wrap-edge jumps.
    For nearly periodic inputs (img2img of an exactly periodic procedural base, structure still aligned) this removes
    the edge mismatch without the quilting cut, which would break regular structure (roof tiles, bark furrows)."""
    h, w = a.shape[:2]
    out = np.empty_like(a)
    q = np.arange(h)[:, None]
    r = np.arange(w)[None, :]
    den = 2 * np.cos(2 * np.pi * q / h) + 2 * np.cos(2 * np.pi * r / w) - 4
    den[0, 0] = 1
    for c in range(a.shape[2]):
        u = a[..., c]
        v = np.zeros_like(u)
        v[0, :] += u[-1, :] - u[0, :]
        v[-1, :] += u[0, :] - u[-1, :]
        v[:, 0] += u[:, -1] - u[:, 0]
        v[:, -1] += u[:, 0] - u[:, -1]
        sh = np.fft.fft2(v) / den
        sh[0, 0] = 0
        out[..., c] = u - np.real(np.fft.ifft2(sh))
    return out


def flatten(a, sigma_frac=0.12, strength=0.85):
    """Remove large-scale lighting gradients: divide luminance by its wrap-around blur."""
    l = lum(a)
    low = blur_wrap(l, a.shape[0] * sigma_frac)
    gain = (l.mean() / np.maximum(low, 1e-3)) ** strength
    return a * gain[..., None]


def normalise(a, mean=0.5, rel_std=0.25):
    """Scale (multiplicatively, keeps hue/chroma ratios) so mean luminance = `mean`, then pull the contrast
    toward std = rel_std * mean (geometric mean of current and target), around the mean."""
    a = a * (mean / max(lum(a).mean(), 1e-4))
    l = lum(a)
    s = l.std()
    target = np.sqrt(s * rel_std * mean)
    out = (a - mean) * (target / max(s, 1e-4)) + mean
    return np.clip(out, 0, 1)


def saturate(a, k):
    g = lum(a)[..., None]
    return np.clip(g + (a - g) * k, 0, 1)


def tile(i_path, v_path, out_p, mean=0.5, rel_std=0.25, flat_sigma=0.12, sat=1.0, size=1024, method="quilt"):
    I = load(i_path, (size, size))
    if method == "psd":  # nearly periodic source: no quilting, see periodic_part
        T = periodic_part(I)
    else:
        T = make_tileable(I, load(v_path, (size, size)))
    a = normalise(saturate(flatten(T, flat_sigma, 1.0), sat), mean, rel_std)
    save(a, out_p)
    return pathlib.Path(out_p)


def tile_x(i_path, v_path, out_p, size=(2048, 1024), quality=84):
    """Horizontal wrap only (sky panoramas). No flatten/normalise: the vertical gradient is the point."""
    I = load(i_path, size)
    V = load(v_path, size)
    save(hpass(I, V, band_frac=0.08), out_p, quality)
    return pathlib.Path(out_p)


def preview(tex, out, cell=512):
    im = Image.open(tex).convert("RGB").resize((cell, cell), Image.LANCZOS)
    sheet = Image.new("RGB", (cell * 3, cell * 3))
    for y in range(3):
        for x in range(3):
            sheet.paste(im, (x * cell, y * cell))
    sheet.save(out, quality=85)


def check(tex):
    """Mean abs difference across the wrap edges vs. across interior JPEG-block-aligned row/column pairs."""
    a = load(tex)
    h, w = a.shape[:2]
    wrap = (np.abs(a[0] - a[-1]).mean() + np.abs(a[:, 0] - a[:, -1]).mean()) / 2
    inner = np.mean([(np.abs(a[k] - a[k - 1]).mean() + np.abs(a[:, k] - a[:, k - 1]).mean()) / 2 for k in (256, 512, 768)])
    return float(wrap), float(inner)


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "tile":
        kw = {}
        for k in ("--mean", "--rel_std"):
            if k in args:
                i = args.index(k)
                kw[k[2:]] = float(args[i + 1])
                del args[i:i + 2]
        print(tile(args[0], args[1], args[2], **kw))
    elif cmd == "preview":
        preview(args[0], args[1])
    elif cmd == "check":
        print("wrap %.4f  interior %.4f" % check(args[0]))
