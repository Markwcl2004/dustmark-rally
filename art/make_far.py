"""Far silhouette layers: public/assets/far/<env>_{1,2}.png (RGBA, 4:1, wraps horizontally, land touches the bottom edge).

  python3 art/make_far.py            (reads art/jobs/far_picks.json: {"nordic_1": {"src": "far_nordic_1a", ...}, ...})

Source: Z-Image 2048x512 (art/jobs/far.json): flat silhouette bands on an empty white sky.
1. trim paper margin; wrapx.wrap_x (pick start AND end columns whose layer heights match, detrend, min-error cut;
   the result is resized back to 2048 wide, so a layer may be stretched horizontally by up to ~1.4x);
2. alpha: colour distance from the sky colour (median of the top rows), smoothstep; then every pixel below the first solid
   pixel of its column is made solid (no sky holes inside the land), everything more than 3 px above it is cleared;
3. colour: converted to a NEUTRAL value layer (R = G = B): white = the farthest/lightest haze, darker = nearer shapes,
   squeezed into [lo, 1] (layer 1 has more range than layer 2). The renderer multiplies by the fog/distant colour, so
   the hue comes from palettes.json, not from the texture;
   "mirror": true in the picks instead appends a left-right flipped copy (4096x512, 8:1): used for the layered hill
   bands where the two ends never show the same layer heights and every cut left a visible step;
4. resize to 2048x512 (mirrored: 4096x512), quantise if > 400 KB. Review preview: art/raw/tile_preview/far_<name>.jpg = the layer tinted with
   the palette's `distant` colour over its `skyHorizon`, shown twice side by side to check the wrap.
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
LUMA = np.array([0.299, 0.587, 0.114], np.float32)


def smoothstep(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def make(src, out, lo=0.55, t0=0.05, t1=0.14, crop_top=0.0, mirror=False):
    im = post.trim_border(Image.open(src).convert("RGB"))
    im = im.crop((int(im.width * 0.015), 0, int(im.width * 0.985), im.height - 6))  # paper-margin remnants at the sides
    if crop_top:
        im = im.crop((0, int(im.height * crop_top), im.width, im.height))
    a = np.asarray(im).astype(np.float32) / 255
    if mirror:  # [image | image flipped]: exactly seamless, 8:1; used where the layer heights at the two ends never match
        a = np.concatenate([a, a[:, ::-1]], 1)
    else:
        a = wrapx.wrap_x(a, ov=200, search=520, search_start=520)
    h, w = a.shape[:2]
    sky = np.median(a[: max(4, h // 20)].reshape(-1, 3), 0)
    dist = np.sqrt(((a - sky) ** 2).sum(-1))
    al = smoothstep(dist, t0, t1)
    solid = al > 0.6
    # first solid pixel = start of a run of >= 8 solid pixels (thin vertical paper-grain lines in the sky don't count)
    run = solid.copy()
    for k in range(1, 8):
        run[:-k] &= solid[k:]
    run[-8:] = solid[-8:]
    solid = run
    first = np.where(solid.any(0), solid.argmax(0), h)
    rows = np.arange(h)[:, None]
    al = np.where(rows >= first[None, :] + 1, 1.0, al)
    al = np.where(rows < first[None, :] - 3, 0.0, al)  # nothing floats above the ridge of its column (paper grain, specks)
    # value layer
    L = (a * LUMA).sum(-1)
    land = al > 0.5
    lmin, lmax = np.percentile(L[land], 2), max(np.percentile(L[land], 99.5), float((sky * LUMA).sum()))
    v = lo + (1 - lo) * np.clip((L - lmin) / max(lmax - lmin, 1e-3), 0, 1)
    # under semi-transparent edges keep the edge value (no sky colour bleeding in)
    rgba = np.dstack([v, v, v, al])
    img = Image.fromarray((rgba * 255 + 0.5).astype(np.uint8)).resize((4096 if mirror else 2048, 512), Image.LANCZOS)
    out = pathlib.Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    if buf.tell() > 400 * 1024:
        img.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(out, optimize=True)
    else:
        out.write_bytes(buf.getvalue())
    return img


def preview(img, env, out):
    pal = json.load(open(ROOT / "public/assets/palettes.json"))["envs"][env]
    hx = lambda s: np.array([int(s[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255  # noqa: E731
    a = np.asarray(img.convert("RGBA")).astype(np.float32) / 255
    col = a[..., :3] * hx(pal["distant"])
    bg = np.ones_like(col) * hx(pal["skyHorizon"])
    rgb = col * a[..., 3:] + bg * (1 - a[..., 3:])
    one = Image.fromarray((rgb * 255).astype(np.uint8)).resize((1024, 256), Image.LANCZOS)
    two = Image.new("RGB", (2048, 256))
    two.paste(one, (0, 0))
    two.paste(one, (1024, 0))
    two.save(out, quality=85)


def main():
    picks = json.load(open(ROOT / "art/jobs/far_picks.json"))
    prev = ROOT / "art/raw/tile_preview"
    prev.mkdir(parents=True, exist_ok=True)
    for name, p in picks.items():
        if name.startswith("_"):
            continue
        out = ROOT / f"public/assets/far/{name}.png"
        img = make(ROOT / "art/raw/b2/far" / f"{p['src']}.png", out, lo=p.get("lo", 0.55), t0=p.get("t0", 0.05), t1=p.get("t1", 0.14),
                   crop_top=p.get("crop_top", 0.0), mirror=p.get("mirror", False))
        preview(img, name.split("_")[0], prev / f"far_{name}.jpg")
        print(out, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
