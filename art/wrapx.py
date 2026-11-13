"""Horizontal wrap for wide images without a second variant and without mirroring (batch 2: far layers, skies, cloud bands).

  wrap_x(img, ov=160, search=320) -> image whose left and right edges meet seamlessly

1. choose the end column: the image is cut to width e (W - search <= e <= W) so that its last `ov` columns look most
   like its first `ov` columns (sum of squared differences of a blurred copy: matches ridge heights / cloud rows, not grain);
2. detrend: per row, add a linear ramp over the full width so the low-frequency colour of the right end equals the left
   end (a 1-2 % tone difference spread over thousands of pixels is invisible, while at a seam it shows as a line);
3. self-quilt: the last `ov` columns are laid over the first `ov` columns and a minimum-error top-to-bottom cut
   (seamless.min_cut_path) picks, per row, where the right end's pixels hand over to the left end's; the right `ov`
   columns are then dropped. Result width e - ov, periodic in x.
The mirroring used in batch 1 is exactly seamless but makes two symmetric points (a V where slanted clouds meet).
"""
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from seamless import min_cut_path  # noqa: E402


def blur(a, r):
    """Separable Gaussian (sigma r) with edge padding, numpy only (PIL does not filter float images)."""
    if a.ndim == 2:
        k = np.exp(-0.5 * (np.arange(-3 * r, 3 * r + 1) / r) ** 2)
        k = (k / k.sum()).astype(np.float32)
        n = len(k) // 2
        p = np.pad(a.astype(np.float32), n, mode="edge")
        p = sum(k[i] * p[i:i + p.shape[0] - 2 * n] for i in range(len(k)))
        return sum(k[i] * p[:, i:i + p.shape[1] - 2 * n] for i in range(len(k)))
    return np.stack([blur(a[..., c], r) for c in range(a.shape[2])], -1)


def wrap_x(a, ov=160, search=320, step=4, search_start=0):
    """a: float32 HxWxC in [0,1] (C = 3 or 4). Returns float32 periodic left/right.
    search_start > 0 also lets the start column move (0..search_start): needed for layered silhouettes, where the
    ends must show the same layer heights before a cut can hide the join."""
    h, w, ch = a.shape
    f = 4  # coarse search on a 4x downsampled, blurred copy
    lo = blur(a, 6)[::f, ::f]
    o = ov // f
    best, s0, e = None, 0, w
    for s in range(0, search_start + 1, max(step, f)):
        head = lo[:, s // f:s // f + o]
        for cand in range(w - search, w + 1, max(step, f)):
            c = cand // f
            d = ((lo[:, c - o:c] - head) ** 2).mean()
            if best is None or d < best:
                best, s0, e = d, s, cand
    a = a[:, s0:e].copy()
    e -= s0
    # detrend: right end's low-frequency colour -> left end's, ramped over the width
    lo = blur(a, 24)
    diff = lo[:, :ov].mean(1) - lo[:, e - ov:].mean(1)  # H x C
    ramp = np.linspace(0, 1, e)[None, :, None]
    a = a + diff[:, None, :] * ramp
    left, right = a[:, :ov], a[:, e - ov:]
    err = ((left - right) ** 2).sum(-1)
    path = min_cut_path(err, cyclic=False)
    cols = np.arange(ov)[None, :]
    m = (cols < path[:, None]).astype(np.float32)  # 1 = take the right end's pixels (they continue from the far right)
    m = blur(m, 1.0)[..., None]
    a[:, :ov] = right * m + left * (1 - m)
    return np.clip(a[:, :e - ov], 0, 1)


def check(a):
    """Wrap-edge difference vs. typical neighbour-column difference."""
    wrap = np.abs(a[:, 0] - a[:, -1]).mean()
    inner = np.mean([np.abs(a[:, k] - a[:, k - 1]).mean() for k in (a.shape[1] // 4, a.shape[1] // 2, 3 * a.shape[1] // 4)])
    return float(wrap), float(inner)


def wrap_fade(a, frac=0.3):
    """Skies: cross-fade the last `frac` of the width over the first part (smoothstep weights). Result width W*(1-frac),
    periodic. Cloud bands at different heights at the two ends then read as one band thinning out while another
    appears, instead of the step a cut leaves (the cut works for silhouettes, not for long horizontal cloud bands)."""
    h, w, ch = a.shape
    L = int(w * frac)
    t = np.linspace(0, 1, L)[None, :, None]
    t = t * t * (3 - 2 * t)
    out = a[:, :w - L].copy()
    out[:, :L] = a[:, w - L:] * (1 - t) + a[:, :L] * t
    return out
