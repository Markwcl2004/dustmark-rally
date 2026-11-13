"""Write public/assets/tex/manifest.json: per ground/bark texture its mean colour, suggested tiling size,
and the multiplier that brings it to the environment's palette colour.

  python3 art/manifest.py

Textures keep their own hue; mean luminance is normalised per material (seamless.py / ground_picks.json), so
they work as albedo. `tint` is an optional HUE correction toward the concept palette colour, computed in LINEAR
space as linear(target) / linear(texture mean) per channel, then divided by its own luminance (so it does not
change brightness) and clamped to [0.6, 1.6]. Only materials whose colour the concept art actually shows get one.
Use: albedo_linear = texture_linear * tint * groundTint(environment light, palettes.json) * weather factor.
"""
import json
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEX = ROOT / "public/assets/tex"

# texture -> (metres per tile, palette key it should average to)
SPEC = {
    "nordic/gravel_road_1": (3.0, "road"), "nordic/gravel_road_2": (3.0, "road"),
    "nordic/gravel_shoulder": (3.0, "shoulder"), "nordic/forest_floor": (4.0, None),
    "nordic/grass": (4.0, "vegLight"), "nordic/rock": (4.0, "rock"), "nordic/dirt_bank": (3.0, None),
    "nordic/pine_bark": (1.5, None), "nordic/birch_bark": (1.5, None),
    "savanna/road": (4.0, "road"), "savanna/ground": (5.0, None),
    "snow/road": (4.0, "road"), "snow/ground": (6.0, "road"),
    "coast/road": (4.0, "road"), "coast/ground": (4.0, None),
    # batch 2
    "savanna/shoulder": (3.0, "shoulder"), "savanna/dry_grass": (4.0, "vegLight"), "savanna/rock": (4.0, "rock"),
    "savanna/riverbed": (3.0, None),
    "snow/ice": (4.0, None), "snow/snow_bank": (3.0, None), "snow/rock_snow": (4.0, None),
    "coast/road_worn": (4.0, "road"), "coast/shoulder": (3.0, "shoulder"), "coast/cliff_rock": (4.0, "rock"),
    "coast/stone_wall": (2.4, None), "coast/terracotta_roof": (2.0, None), "coast/plaster_wall": (2.0, None),
    "coast/plaster_wall_ochre": (2.0, None),
}


def lin(c):
    c = np.asarray(c, np.float64) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def main():
    pal = json.load(open(ROOT / "public/assets/palettes.json"))["envs"]
    out = {"_doc": " ".join(__doc__.strip().split("\n\n")[2].split()), "textures": {}}
    for key, (metres, pkey) in SPEC.items():
        p = TEX / f"{key}.jpg"
        if not p.exists():
            continue
        a = np.asarray(Image.open(p).convert("RGB")).astype(np.float64)
        mean_srgb = a.reshape(-1, 3).mean(0)
        mean_lin = lin(a.reshape(-1, 3)).mean(0)
        e = {"file": f"tex/{key}.jpg", "metresPerTile": metres, "meanColor": "#%02x%02x%02x" % tuple(int(round(v)) for v in mean_srgb),
             "sizeKB": p.stat().st_size // 1024}
        env = key.split("/")[0]
        if pkey:
            h = pal[env][pkey]
            target = lin([int(h[i:i + 2], 16) for i in (1, 3, 5)])
            e["tintTo"] = pkey
            r = target / np.maximum(mean_lin, 1e-4)
            r = r / (0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2])
            e["tint"] = [round(float(np.clip(v, 0.6, 1.6)), 3) for v in r]
        out["textures"][key] = e
    (TEX / "manifest.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    for k, v in out["textures"].items():
        print(k, v["meanColor"], v.get("tint"), v["sizeKB"], "KB")


if __name__ == "__main__":
    main()
