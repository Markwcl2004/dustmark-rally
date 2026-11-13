"""Sky panoramas: clean the picked skies and make them wrap horizontally.

  python3 art/make_sky.py      (reads art/jobs/sky_picks.json: {"public/assets/sky/clear.jpg": "sky_clear_a", ...})

1. trim the poster paper margin (post.trim_border) and the dark "ground" strip the model draws along the
   bottom edge (bottom 10%), fit to 2:1;
2. wrap by mirroring: output = [image | image flipped left-right], 3072x768 (4:1 = the upper hemisphere of an
   equirectangular map, 360 x 90 degrees, square pixels). Mirroring is exactly seamless; the cost is two
   symmetric points (at u = 0 and u = 0.5), which in a flat poster sky only show on the slanted dusk streaks.
   Tried and rejected: quilting a band from an img2img variant, and Z-Image inpainting of the seam band:
   both left a visible column (grain/tone mismatch on the flat colour fields).
The top edge is the zenith side, the bottom edge the horizon. No sun disc is painted; the renderer draws the sun.
Preview: art/raw/tile_preview/sky_<name>.jpg shows the 4:1 strip twice side by side.
"""
import json
import pathlib
import sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import post  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main():
    picks = json.load(open(ROOT / "art/jobs/sky_picks.json"))
    prev = ROOT / "art/raw/tile_preview"
    prev.mkdir(parents=True, exist_ok=True)
    for out, src in picks.items():
        im = post.trim_border(Image.open(ROOT / "art/raw/sky" / f"{src}.png").convert("RGB"))
        im = im.crop((0, int(im.height * 0.01), im.width, int(im.height * 0.90)))
        im = post.fit(im, 1536, 768)
        pano = Image.new("RGB", (3072, 768))
        pano.paste(im, (0, 0))
        pano.paste(im.transpose(Image.FLIP_LEFT_RIGHT), (1536, 0))
        o = ROOT / out
        o.parent.mkdir(parents=True, exist_ok=True)
        pano.save(o, quality=84, optimize=True, progressive=True)
        small = pano.resize((1024, 256), Image.LANCZOS)
        two = Image.new("RGB", (2048, 256))
        two.paste(small, (0, 0))
        two.paste(small, (1024, 0))
        two.save(prev / f"sky_{o.stem}.jpg", quality=85)
        print(out, o.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
