"""Extract each environment's palette from its chosen concept image and write the palette files.

Colours are medians of hand-picked boxes (x0, y0, x1, y1 in the 1280x720 concept). A few keys are derived
(shoulder = road mixed toward dark vegetation, ambient = mean of sky colours darkened) so the renderer gets a
complete set. Writes public/assets/palettes.json, docs/art/palettes.md, and docs/art/palettes_preview.jpg
(concept image with the boxes outlined + swatches) for checking that every box hit the intended thing.

  python3 art/palette.py
"""
import json
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "art/raw/concept"

ENVS = {
    "nordic": {
        "name": "北境林道", "src": "concept_nordic_1", "override": {"sunColor": "#ffe0a6", "rock": "#8b8a7c"}, "sunDir": "低角度晨光，左后方 ~25° 高度角",
        "boxes": {
            "road": (340, 430, 440, 455), "vegLight": (640, 340, 720, 362), "vegDark": (835, 255, 875, 320),
            "distant": (520, 200, 640, 222), "skyTop": (450, 40, 600, 80), "skyHorizon": (300, 125, 450, 148),
            "fog": (560, 262, 660, 284), "sunColor": (650, 118, 760, 138), "shadow": (933, 627, 1060, 650),
            "rock": (1150, 548, 1180, 562),
        },
    },
    "savanna": {
        "name": "赤土高原", "src": "concept_savanna_1", "override": {"sunColor": "#fff0c8", "shadow": "#7a2e22"}, "sunDir": "正午高光，几乎头顶 ~70° 高度角，短影",
        "boxes": {
            "road": (430, 600, 600, 660), "vegLight": (700, 330, 800, 360), "vegDark": (940, 168, 1040, 196),
            "distant": (500, 240, 640, 265), "skyTop": (500, 55, 700, 95), "skyHorizon": (700, 205, 840, 222),
            "fog": (300, 278, 420, 294), "sunColor": (760, 108, 900, 122), "shadow": (900, 600, 1000, 625),
            "rock": (60, 380, 120, 420),
        },
    },
    "snow": {
        "name": "雪岭", "src": "concept_snow_1", "override": {"sunColor": "#f2eef8", "rock": "#3a3d4c"}, "sunDir": "阴天漫射，太阳不可见；晴冷时段低角度侧光",
        "boxes": {
            "road": (650, 650, 800, 700), "vegLight": (440, 300, 470, 350), "vegDark": (110, 240, 160, 290),
            "distant": (420, 150, 500, 170), "skyTop": (500, 15, 700, 55), "skyHorizon": (600, 200, 700, 215),
            "fog": (600, 330, 700, 365), "sunColor": (20, 300, 120, 330), "shadow": (20, 545, 100, 575),
            "rock": (125, 532, 165, 550),
        },
    },
    "coast": {
        "name": "山海公路", "src": "concept_coast_1b", "override": {"shadow": "#4a4a66", "vegDark": "#2c3d2a"}, "sunDir": "晴，左上方 ~45° 高度角，海面反光",
        "boxes": {
            "road": (400, 640, 550, 690), "vegLight": (330, 425, 400, 455), "vegDark": (960, 150, 985, 240),
            "distant": (420, 238, 520, 256), "skyTop": (500, 30, 700, 70), "skyHorizon": (40, 235, 130, 262),
            "fog": (300, 262, 380, 276), "sunColor": (170, 110, 230, 160), "shadow": (700, 640, 800, 660),
            "rock": (1140, 400, 1180, 420), "sea": (100, 330, 250, 400),
        },
    },
}

LABELS = {
    "road": "路面", "shoulder": "路肩", "vegLight": "植被亮", "vegDark": "植被暗", "distant": "远景",
    "skyTop": "天空上", "skyHorizon": "天空下/地平线", "fog": "雾色", "sunColor": "阳光", "shadow": "阴影",
    "rock": "岩石", "sea": "海", "ambient": "环境光", "groundTint": "地表乘色",
}


def hexc(c):
    return "#%02x%02x%02x" % tuple(int(round(v)) for v in c)


def mix(a, b, t):
    return [a[i] * (1 - t) + b[i] * t for i in range(3)]


def extract(env):
    im = np.asarray(Image.open(RAW / f"{env['src']}.png").convert("RGB")).astype(np.float32)
    c = {k: list(np.median(im[y0:y1, x0:x1].reshape(-1, 3), 0)) for k, (x0, y0, x1, y1) in env["boxes"].items()}
    for k, h in env.get("override", {}).items():  # hand-set where no box gives the right thing (e.g. sun light colour)
        c[k] = [int(h[i:i + 2], 16) for i in (1, 3, 5)]
    c["shoulder"] = mix(c["road"], c["vegDark"], 0.3)
    sky = mix(c["skyTop"], c["skyHorizon"], 0.5)
    c["ambient"] = [v * 0.75 for v in sky]
    # groundTint: a near-white, environment-hued multiplier for all terrain textures (sun and horizon light
    # mixed, scaled so the brightest channel is 255). Exact per-texture multipliers are in tex/manifest.json.
    g = mix(c["sunColor"], c["skyHorizon"], 0.3)
    c["groundTint"] = [v * 255 / max(g) for v in g]
    return c


def font(size):
    for p in ("/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    out = {"_doc": "Per-environment colours picked from the concept art (docs/art/concept_*). sRGB hex. "
                   "fogColor/skyTop/skyHorizon/sunColor/ambient feed the renderer; groundTint multiplies the neutral ground textures.",
           "envs": {}}
    md = ["# 环境色板（定稿 v1）", "",
          "从每个环境选定的概念图上取色（中位数取样，框位见 `palettes_preview.jpg`）。机器可读版本：`public/assets/palettes.json`。",
          "路肩 = 路面向暗植被混 30%；环境光 = 天空上下平均 × 0.75；地表乘色 groundTint = 阳光与地平线色 7:3 混合后把最亮通道拉到 255（接近白、带环境色相，乘在所有地表贴图上）。每张地表贴图精确对到色板的乘数见 `public/assets/tex/manifest.json` 的 `tint`。", ""]
    rows = []
    for key, env in ENVS.items():
        c = extract(env)
        e = {
            "name": env["name"], "concept": f"docs/art/concept_{key}.jpg", "sun": env["sunDir"],
            "fogColor": hexc(c["fog"]), "skyTop": hexc(c["skyTop"]), "skyHorizon": hexc(c["skyHorizon"]),
            "sunColor": hexc(c["sunColor"]), "ambient": hexc(c["ambient"]), "shadowColor": hexc(c["shadow"]),
            "groundTint": hexc(c["groundTint"]), "road": hexc(c["road"]), "shoulder": hexc(c["shoulder"]),
            "vegLight": hexc(c["vegLight"]), "vegDark": hexc(c["vegDark"]), "distant": hexc(c["distant"]),
            "rock": hexc(c["rock"]),
        }
        if "sea" in c:
            e["sea"] = hexc(c["sea"])
        out["envs"][key] = e
        md += [f"## {env['name']}（`{key}`）", "", f"概念图：`docs/art/concept_{key}.jpg`（源 `{env['src']}`）。光照：{env['sunDir']}。", "",
               "| 用途 | 键 | 颜色 |", "|---|---|---|"]
        for k in ("road", "shoulder", "vegLight", "vegDark", "distant", "skyTop", "skyHorizon", "fogColor", "sunColor",
                  "shadowColor", "ambient", "groundTint", "rock", "sea"):
            if k in e:
                md.append(f"| {LABELS.get(k.replace('Color', '') if k in ('fogColor', 'shadowColor') else k, k)} | `{k}` | `{e[k]}` |")
        md.append("")
        rows.append((key, env, c))
    (ROOT / "public/assets").mkdir(parents=True, exist_ok=True)
    (ROOT / "public/assets/palettes.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    (ROOT / "docs/art").mkdir(parents=True, exist_ok=True)
    (ROOT / "docs/art/palettes.md").write_text("\n".join(md))

    # preview: concept with boxes + swatch row
    W, sw = 960, 60
    f = font(16)
    sheets = []
    for key, env, c in rows:
        im = Image.open(RAW / f"{env['src']}.png").convert("RGB")
        d = ImageDraw.Draw(im)
        for k, b in env["boxes"].items():
            d.rectangle(b, outline=(255, 0, 255), width=2)
            d.text((b[0], b[1] - 14), k, fill=(255, 0, 255))
        im = im.resize((W, W * 720 // 1280))
        keys = ["road", "shoulder", "vegLight", "vegDark", "distant", "skyTop", "skyHorizon", "fog", "sunColor", "shadow", "ambient", "groundTint"]
        strip = Image.new("RGB", (W, sw + 22), (30, 30, 30))
        ds = ImageDraw.Draw(strip)
        w = W // len(keys)
        for i, k in enumerate(keys):
            ds.rectangle([i * w, 0, (i + 1) * w - 2, sw], fill=tuple(int(v) for v in c[k]))
            ds.text((i * w + 2, sw + 3), LABELS.get(k.replace("Color", ""), k), fill=(220, 220, 220), font=f)
        page = Image.new("RGB", (W, im.height + strip.height))
        page.paste(im, (0, 0))
        page.paste(strip, (0, im.height))
        sheets.append(page)
    full = Image.new("RGB", (W * 2 + 8, (sheets[0].height + 8) * 2), (20, 20, 20))
    for i, p in enumerate(sheets):
        full.paste(p, ((i % 2) * (W + 8), (i // 2) * (p.height + 8)))
    full.save(ROOT / "docs/art/palettes_preview.jpg", quality=85)
    print(json.dumps(out["envs"], indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
