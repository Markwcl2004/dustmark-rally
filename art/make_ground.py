"""Turn picked ground/bark candidates into seamless, normalised game textures.

  python3 art/make_ground.py art/jobs/ground_picks.json

ground_picks.json: {"jobs": "art/jobs/ground.json", "raw": "art/raw/ground",
                    "picks": {"public/assets/tex/nordic/gravel_road_1.jpg": {"src": "nordic_gravel_road_a", "mean": 0.5}, ...}}
For each pick: Z-Image img2img variant of the source (same prompt unless the pick gives "prompt", denoise 0.6)
("method": "psd" for img2img results of exactly periodic procedural bases: no variant, seamless.periodic_part instead of quilting)
-> seamless.tile (offset + quilt the variant over the seams with min-error cuts, flatten lighting, normalise) -> jpg + 3x3 preview in
art/raw/tile_preview/. Re-running skips finished steps (delete the outputs to redo).
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import comfy  # noqa: E402
import seamless  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


def full_mask():
    from PIL import Image
    p = ROOT / "art/raw/seam/full_mask.png"
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (1024, 1024), (255, 255, 255)).save(p)
    return p


def source(raws, p, work):
    """Path of the pick's source image; with "crop": [x0, y0, x1, y1] (fractions) a cropped 1024² copy."""
    src = next(ROOT / r / f"{p['src']}.png" for r in raws if (ROOT / r / f"{p['src']}.png").exists())
    if not p.get("crop"):
        return src
    from PIL import Image
    im = Image.open(src).convert("RGB")
    x0, y0, x1, y1 = p["crop"]
    im = im.crop((int(x0 * im.width), int(y0 * im.height), int(x1 * im.width), int(y1 * im.height))).resize((1024, 1024), Image.LANCZOS)
    work.mkdir(parents=True, exist_ok=True)
    out = work / f"{p['src']}_crop.png"
    im.save(out)
    return out


def main(picks_path):
    cfg = json.load(open(picks_path))
    jobs = {}
    for jf in cfg["jobs"] if isinstance(cfg["jobs"], list) else [cfg["jobs"]]:
        jobs.update({j["name"]: j for j in comfy.load_jobs(ROOT / jf)})
    raws = cfg["raw"] if isinstance(cfg["raw"], list) else [cfg["raw"]]
    work = ROOT / "art/raw/seam"
    prev = ROOT / "art/raw/tile_preview"
    prev.mkdir(parents=True, exist_ok=True)
    inp = []
    for out, p in cfg["picks"].items():
        if p.get("method") == "psd":
            continue  # periodic procedural source: no variant needed
        src = source(raws, p, work)
        j = jobs[p["src"]]
        inp.append({"name": f"{p['src']}_var", "image": str(src), "mask": str(full_mask()), "prompt": p.get("prompt", j["prompt"]),
                    "seed": j.get("seed", 1) + 17, "denoise": p.get("denoise", 0.6)})
    comfy.run("inpaint", inp, work)
    for out, p in cfg["picks"].items():
        rep = work / f"{p['src']}_var.png"
        src = source(raws, p, work)
        res = seamless.tile(src, rep, ROOT / out, mean=p.get("mean", 0.5), rel_std=p.get("rel_std", 0.25),
                            flat_sigma=p.get("flat_sigma", 0.12), sat=p.get("sat", 1.0), method=p.get("method", "quilt"))
        name = pathlib.Path(out).parent.name + "_" + pathlib.Path(out).stem
        seamless.preview(res, prev / f"{name}.jpg")
        w, i = seamless.check(res)
        print(f"{out}: wrap {w:.4f} interior {i:.4f}  {res.stat().st_size // 1024} KB", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
