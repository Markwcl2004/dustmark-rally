"""Small client for the ComfyUI server (a separate GPU machine), used for DUSTMARK art.

Queues jobs over the HTTP API and downloads the results, so art generation runs there and files land here.

  python3 art/comfy.py t2i     jobs.json outdir  # Z-Image Turbo: [{name, prompt, seed?, w?, h?, cut?, steps?}]
  python3 art/comfy.py edit    jobs.json outdir  # Qwen-Image-Edit-2511: [{name, image, prompt, seed?, image2?, image3?, cut?}]
  python3 art/comfy.py inpaint jobs.json outdir  # Z-Image img2img inside a mask: [{name, image, mask, prompt, denoise?, seed?}]
  python3 art/comfy.py cut     indir outdir      # BiRefNet background removal for every png in indir

A jobs file is either a plain list, or {"style": "...", "suffix": "...", "defaults": {...}, "jobs": [...]}:
the prompt sent is style + prompt + suffix, and defaults fill missing keys of every job.

`cut: true` also removes the background and saves an RGBA png. Existing outputs are skipped, so a batch can be rerun.
The local machine has an HTTP proxy that blocks Tailscale addresses, so every request bypasses proxies.
Jobs from other users already in the ComfyUI queue are never touched: ours queue behind them.
"""
import json
import os
import mimetypes
import pathlib
import sys
import time
import urllib.parse
import urllib.request
import uuid

HOST = os.environ.get("COMFY_HOST", "http://127.0.0.1:8188")  # set COMFY_HOST to your ComfyUI server
BIREFNET = "birefnet.safetensors"
PREFIX = "dustmark"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(path, data=None, ctype="application/json", tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(HOST + path, data=data, headers={"Content-Type": ctype} if data else {})
            with OPENER.open(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # flaky Tailscale link: retry a few times
            if k == tries - 1:
                raise
            print("retry", path[:60], e, flush=True)
            time.sleep(3 * (k + 1))


def upload(path):
    """Upload a local image to ComfyUI's input folder and return the name to use in LoadImage."""
    p = pathlib.Path(path)
    name = f"dm_{uuid.uuid5(uuid.NAMESPACE_URL, str(p.resolve()) + str(p.stat().st_mtime)).hex[:12]}{p.suffix}"
    boundary = uuid.uuid4().hex
    body = b"".join([
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
        f"Content-Type: {mimetypes.guess_type(p.name)[0] or 'image/png'}\r\n\r\n".encode(), p.read_bytes(), b"\r\n",
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode(),
    ])
    return json.loads(call("/upload/image", body, f"multipart/form-data; boundary={boundary}"))["name"]


def save_nodes(g, image_ref, name, cut):
    """Add SaveImage (and a background-removed RGBA copy when cut) to graph g."""
    g["90"] = {"class_type": "SaveImage", "inputs": {"images": image_ref, "filename_prefix": f"{PREFIX}/{name}"}}
    if cut:
        g["91"] = {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": BIREFNET}}
        g["92"] = {"class_type": "RemoveBackground", "inputs": {"bg_removal_model": ["91", 0], "image": image_ref}}
        g["93"] = {"class_type": "InvertMask", "inputs": {"mask": ["92", 0]}}
        g["94"] = {"class_type": "JoinImageWithAlpha", "inputs": {"image": image_ref, "alpha": ["93", 0]}}
        g["95"] = {"class_type": "SaveImage", "inputs": {"images": ["94", 0], "filename_prefix": f"{PREFIX}/{name}_cut"}}


def zimage_base(j):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_turbo_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": j.get("shift", 3.0)}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": j["prompt"], "clip": ["2", 0]}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
    }


def t2i_graph(j):
    g = zimage_base(j)
    g["7"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": j.get("w", 1024), "height": j.get("h", 1024), "batch_size": 1}}
    g["8"] = {"class_type": "KSampler", "inputs": {
        "model": ["4", 0], "seed": j.get("seed", 1), "steps": j.get("steps", 9), "cfg": 1.0,
        "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 1.0,
        "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0]}}
    g["9"] = {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}}
    save_nodes(g, ["9", 0], j["name"], j.get("cut"))
    return g


def inpaint_graph(j):
    """Re-noise only the white area of `mask` (white = regenerate) and keep the rest of `image`."""
    g = zimage_base(j)
    g["20"] = {"class_type": "LoadImage", "inputs": {"image": upload(j["image"])}}
    g["21"] = {"class_type": "LoadImageMask", "inputs": {"image": upload(j["mask"]), "channel": "red"}}
    g["22"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["20", 0], "vae": ["3", 0]}}
    g["23"] = {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["22", 0], "mask": ["21", 0]}}
    g["8"] = {"class_type": "KSampler", "inputs": {
        "model": ["4", 0], "seed": j.get("seed", 1), "steps": j.get("steps", 9), "cfg": 1.0,
        "sampler_name": "res_multistep", "scheduler": "simple", "denoise": j.get("denoise", 0.75),
        "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["23", 0]}}
    g["9"] = {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}}
    save_nodes(g, ["9", 0], j["name"], False)
    return g


def edit_graph(j):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2511_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b.safetensors", "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        # the server runs with --use-sage-attention (for the video model); with it Qwen-Image returns all-black images
        "7": {"class_type": "ModelAttentionBackend", "inputs": {"model": ["1", 0], "attention": "pytorch attention"}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["7", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
        "5": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["4", 0], "shift": 3.1}},
        "6": {"class_type": "CFGNorm", "inputs": {"model": ["5", 0], "strength": 1.0}},
    }
    refs = {}
    for i, key in enumerate(["image", "image2", "image3"]):
        if j.get(key):
            n = str(20 + i * 2)
            g[n] = {"class_type": "LoadImage", "inputs": {"image": upload(j[key])}}
            g[str(21 + i * 2)] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": [n, 0], "upscale_method": "lanczos", "megapixels": j.get("mp", 1.0), "resolution_steps": 16}}
            refs[f"image{i + 1}"] = [str(21 + i * 2), 0]
    g["10"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": j["prompt"], "vae": ["3", 0], **refs}}
    g["11"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": "", "vae": ["3", 0], **refs}}
    g["12"] = {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["10", 0], "reference_latents_method": "index_timestep_zero"}}
    g["13"] = {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["11", 0], "reference_latents_method": "index_timestep_zero"}}
    g["14"] = {"class_type": "VAEEncode", "inputs": {"pixels": refs["image1"], "vae": ["3", 0]}}
    g["15"] = {"class_type": "KSampler", "inputs": {
        "model": ["6", 0], "seed": j.get("seed", 1), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
        "denoise": 1.0, "positive": ["12", 0], "negative": ["13", 0], "latent_image": ["14", 0]}}
    g["16"] = {"class_type": "VAEDecode", "inputs": {"samples": ["15", 0], "vae": ["3", 0]}}
    save_nodes(g, ["16", 0], j["name"], j.get("cut"))
    return g


def cut_graph(j):
    g = {"1": {"class_type": "LoadImage", "inputs": {"image": upload(j["image"])}}}
    save_nodes(g, ["1", 0], j["name"], True)
    del g["90"]
    return g


def free():
    call("/free", json.dumps({"unload_models": True, "free_memory": True}).encode())
    time.sleep(3)


def load_jobs(src):
    """Plain list, or {style, suffix, defaults, jobs}: expand into a plain list with full prompts."""
    d = json.load(open(src))
    if isinstance(d, list):
        return d
    style, suffix, defaults = d.get("style", ""), d.get("suffix", ""), d.get("defaults", {})
    out = []
    for j in d["jobs"]:
        j = {**defaults, **j}
        if not j.get("raw_prompt"):
            j["prompt"] = " ".join(s for s in (style, j["prompt"], suffix) if s)
        out.append(j)
    return out


def run(kind, jobs, out):
    """Generate first, then cut backgrounds in a separate pass: BiRefNet next to a loaded generator runs out of VRAM."""
    out.mkdir(parents=True, exist_ok=True)
    if kind != "cut":
        _run(kind, [{**j, "cut": False} for j in jobs], out)
        cuts = [{"name": j["name"], "image": str(out / f"{j['name']}.png")} for j in jobs
                if j.get("cut") and (out / f"{j['name']}.png").exists() and not (out / f"{j['name']}_cut.png").exists()]
        if cuts:
            free()
            _run("cut", cuts, out)
            free()
        return
    _run(kind, jobs, out)


def _run(kind, jobs, out):
    build = {"t2i": t2i_graph, "edit": edit_graph, "cut": cut_graph, "inpaint": inpaint_graph}[kind]
    queued = []
    for j in jobs:
        want = [out / f"{j['name']}_cut.png"] if kind == "cut" else [out / f"{j['name']}.png"]
        if all(p.exists() for p in want):
            continue
        missing = [j[k] for k in ("image", "image2", "image3", "mask") if j.get(k) and not pathlib.Path(j[k]).exists()]
        if missing:  # its source failed earlier: skip this one, the rest of the batch still runs
            print("SKIP", j["name"], "missing", *missing, flush=True)
            continue
        r = json.loads(call("/prompt", json.dumps({"prompt": build(j), "client_id": PREFIX}).encode()))
        if r.get("node_errors"):
            print("ERROR", j["name"], r["node_errors"], flush=True)
            continue
        queued.append((j["name"], r["prompt_id"], time.time()))
    print(f"queued {len(queued)} jobs", flush=True)
    t0 = time.time()
    for name, pid, _ in queued:
        while True:  # a prompt shows up in /history only once it has finished or failed
            h = json.loads(call(f"/history/{pid}"))
            if pid in h:
                break
            time.sleep(1.5)
        entry = h[pid]
        if entry.get("status", {}).get("status_str") == "error":
            msgs = [m for m in entry["status"].get("messages", []) if m[0] == "execution_error"]
            print("FAILED", name, msgs[0][1].get("exception_message", "")[:400] if msgs else entry["status"], flush=True)
            continue
        for node in entry["outputs"].values():
            for im in node.get("images", []):
                suffix = "_cut" if im["filename"].startswith(f"{name}_cut") else ""
                q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
                (out / f"{name}{suffix}.png").write_bytes(call(f"/view?{q}"))
        print(f"{name} done at {time.time() - t0:.0f}s", flush=True)
    print("BATCH_DONE", flush=True)


if __name__ == "__main__":
    kind, src, dst = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    if kind == "cut":
        jobs = [{"name": p.stem, "image": str(p)} for p in sorted(pathlib.Path(src).glob("*.png")) if not p.stem.endswith("_cut")]
    else:
        jobs = load_jobs(src)
    only = [a for a in sys.argv[4:]]  # optional: only run jobs whose name starts with one of these
    if only:
        jobs = [j for j in jobs if any(j["name"].startswith(o) for o in only)]
    run(kind, jobs, dst)
