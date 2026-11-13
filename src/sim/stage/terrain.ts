// Analytic stage height field: environment base noise blended into the road cross-section near the centerline.
import type { EnvDef } from '../../data/envs';
import { Surface } from '../../data/surfaces';
import { normalFromHeight } from '../ground';
import { noise2, ridged } from '../math/rng';
import { V3, clamp, smoothstep } from '../math/vec';
import { DS, type Centerline } from './centerline';
import type { Dir } from './script';

/** a river channel crossing the road (ford): runs along (ux,uz) through (cx,cz); half width hw; bed height at the crossing */
export interface Ford { cx: number; cz: number; ux: number; uz: number; hw: number; bed: number; level: number; water: boolean; s: number }

export interface Lake { cx: number; cz: number; ux: number; uz: number; a: number; b: number; level: number; side: Dir; s0: number; s1: number }

/** sea cliffs (coast): a world-space shoreline along the coast direction t; everything seaward of it falls in rock
 *  ledges to the sea floor. Built from the road samples of `seacliff` zones (the shore runs a platform's width outside
 *  the road there) and receding away from every other stretch of road. */
export interface SeaCliff {
  /** along-coast unit vector (tx,tz); bins of BIN m starting at t0 */
  tx: number; tz: number; t0: number; bin: number;
  /** shoreline (u, metres along the sea normal) and pre-cliff ground height at the shoreline, per bin */
  shore: Float32Array; top: Float32Array;
  /** per centreline sample: smoothed seacliff weight 0..1 and which side the sea is on (+1 right, −1 left) */
  flag: Float32Array; side: Int8Array;
}

/** platform between the shoulder ditch and the cliff edge (m) */
export const CLIFF_PLATFORM = 3.2;

export interface NearestRoad {
  /** nearest sample index (1 m spacing) */
  i: number;
  /** arc length along centerline */
  s: number;
  /** signed lateral offset, + = right of travel */
  d: number;
  /** road surface height at the centre for this s */
  h: number;
  found: boolean;
}

/** distance from centre beyond which the road no longer influences the terrain */
export const BLEND_END = 24;

export class Terrain {
  readonly cl: Centerline;
  readonly env: EnvDef;
  readonly seed: number;
  readonly halfWidth: number;
  /** road centre height per sample */
  prof: Float64Array;
  lakes: Lake[] = [];
  fords: Ford[] = [];
  /** coastal tilt (land falls toward the sea along n) */
  coast: { cx: number; cz: number; nx: number; nz: number; amp: number; width: number; seaLevel: number } | null = null;
  /** per-sample snow wall height (m), ice patch flag, gravel override flag (set by Stage from the zones) */
  wallH: Float32Array | null = null;
  ice: Uint8Array | null = null;
  gravel: Uint8Array | null = null;
  /** sea cliffs (coast seacliff zones) */
  cliff: SeaCliff | null = null;
  /** weather surface remap */
  grip: Partial<Record<number, number>> = {};
  private grid = new Map<number, number[]>();
  private readonly CELL = BLEND_END + 1;
  readonly edge1: number; // shoulder end / ditch start
  readonly edge2: number; // ditch end
  private q: NearestRoad = { i: 0, s: 0, d: 0, h: 0, found: false };
  /** nearest-road result of the most recent height()/nearest() call (read right after calling) */
  get last(): Readonly<NearestRoad> { return this.q; }

  constructor(cl: Centerline, env: EnvDef, seed: number, halfWidth: number) {
    this.cl = cl; this.env = env; this.seed = seed; this.halfWidth = halfWidth;
    this.edge1 = halfWidth + env.road.shoulder;
    this.edge2 = this.edge1 + env.road.ditchWidth;
    this.prof = new Float64Array(cl.n);
    for (let i = 0; i < cl.n; i += 2) this.addGrid(i);
    if ((cl.n - 1) % 2) this.addGrid(cl.n - 1);
  }

  private key(ix: number, iz: number) { return (ix + 8192) * 16384 + (iz + 8192); }
  private addGrid(i: number) {
    const k = this.key(Math.floor(this.cl.x[i] / this.CELL), Math.floor(this.cl.z[i] / this.CELL));
    let a = this.grid.get(k);
    if (!a) this.grid.set(k, (a = []));
    a.push(i);
  }

  /** environment base terrain (no road) */
  base(x: number, z: number) {
    const t = this.env.terrain;
    let h = 0;
    for (let o = 0; o < t.octaves.length; o++) {
      const [a, l] = t.octaves[o];
      h += a * noise2(x / l, z / l, this.seed + o * 131);
    }
    h += t.ridge[0] * (ridged(x / t.ridge[1], z / t.ridge[1], this.seed + 977, 3) - 0.45);
    const c = this.coast;
    if (c) {
      // the land falls toward the sea: a saturating tilt across the stage (sea side → −amp)
      const u = ((x - c.cx) * c.nx + (z - c.cz) * c.nz) / c.width;
      h -= c.amp * Math.tanh(u) + c.amp * 0.35 * Math.max(0, u - 1.2);
    }
    return h;
  }

  /** nearest centerline point within BLEND_END; result object is reused */
  private q2: NearestRoad = { i: 0, s: 0, d: 0, h: 0, found: false };
  private second = -1;

  nearest(x: number, z: number, out: NearestRoad = this.q): NearestRoad {
    const cl = this.cl;
    const kx = Math.floor(x / this.CELL), kz = Math.floor(z / this.CELL);
    let best = -1, bd = BLEND_END * BLEND_END + 16;
    let best2 = -1, bd2 = bd;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const arr = this.grid.get(this.key(kx + a, kz + b));
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const j = arr[k];
        const dx = x - cl.x[j], dz = z - cl.z[j];
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) {
          // demote the previous best to second if it belongs to another part of the road
          if (best >= 0 && Math.abs(best - j) > 40) { best2 = best; bd2 = bd; }
          bd = d2; best = j;
        } else if (d2 < bd2 && Math.abs(j - best) > 40) { bd2 = d2; best2 = j; }
      }
    }
    if (best2 >= 0 && Math.abs(best2 - best) <= 40) best2 = -1;
    this.second = best2;
    if (best < 0) { out.found = false; return out; }
    return this.refine(x, z, best, out);
  }

  private refine(x: number, z: number, best: number, out: NearestRoad) {
    const cl = this.cl;
    // refine on 1 m segments around the coarse hit
    let bs = 0, bdist = Infinity, bseg = best, bsgn = 1;
    const j0 = Math.max(0, best - 3), j1 = Math.min(cl.n - 2, best + 2);
    for (let j = j0; j <= j1; j++) {
      const ax = cl.x[j], az = cl.z[j], ex = cl.x[j + 1] - ax, ez = cl.z[j + 1] - az;
      const L2 = ex * ex + ez * ez;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      // allow running off the ends of the whole centerline (open caps)
      if (!(j === 0 && t < 0) && !(j === cl.n - 2 && t > 1)) t = clamp(t, 0, 1);
      const px = ax + ex * t, pz = az + ez * t;
      const dx = x - px, dz = z - pz;
      const dd = dx * dx + dz * dz;
      if (dd < bdist) {
        bdist = dd; bs = (j + t) * DS; bseg = j;
        bsgn = (-ez * dx + ex * dz) >= 0 ? 1 : -1;
      }
    }
    out.found = true;
    out.i = bseg;
    out.s = bs;
    out.d = Math.sqrt(bdist) * bsgn;
    out.h = this.profAt(bs);
    return out;
  }

  /** curvature smoothed over ±25 m, keeping the sign of the strongest bend */
  private kSmooth: Float32Array | null = null;
  kAt(s: number) {
    if (!this.kSmooth) {
      const n = this.cl.n, k = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let best = 0;
        for (let j = Math.max(0, i - 25); j <= Math.min(n - 1, i + 25); j += 2) if (Math.abs(this.cl.kappa[j]) > Math.abs(best)) best = this.cl.kappa[j];
        k[i] = best;
      }
      this.kSmooth = k;
    }
    return this.kSmooth[clamp(Math.round(s / DS), 0, this.cl.n - 1)];
  }

  profAt(s: number) {
    const f = s / DS;
    if (f <= 0) return this.prof[0];
    if (f >= this.cl.n - 1) return this.prof[this.cl.n - 1];
    const i = Math.floor(f), t = f - i;
    return this.prof[i] * (1 - t) + this.prof[i + 1] * t;
  }

  /** road cross-section height offset at lateral distance a = |d| (≤ edge2 + bank) */
  cross(a: number, s: number, d: number) {
    const r = this.env.road, hw = this.halfWidth;
    if (a <= hw) {
      const c = -r.crown * (a / hw) * (a / hw);
      // ruts in the two wheel tracks either side of centre, plus gravel roughness
      const rut = -r.rut * (Math.exp(-((a - 0.8) * (a - 0.8)) / 0.06) + 0.6 * Math.exp(-((a - 2.4) * (a - 2.4)) / 0.08));
      const rough = r.rough * (0.7 * noise2(s / 6.5, d / 3.2, this.seed + 5) + 0.3 * noise2(s / 1.7, d / 1.7, this.seed + 6));
      return c + rut + rough;
    }
    const base = -r.crown - 0.05 * (Math.min(a, this.edge1) - hw);
    if (a <= this.edge1) return base;
    const wall = this.wallH ? this.wallH[clamp(Math.round(s / DS), 0, this.cl.n - 1)] : 0;
    if (a <= this.edge2) {
      const t = (a - this.edge1) / r.ditchWidth;
      if (wall > 0) {
        // ploughed snow wall: a steep rounded face rising from the shoulder, lumpy top
        const lump = 1 + 0.18 * noise2(s / 7, d > 0 ? 3.1 : 7.7, this.seed + 41);
        return base + wall * lump * smoothstep(0, 1, t) * (1 - 0.1 * t);
      }
      return base - r.ditchDepth * Math.sin(Math.PI * t);
    }
    return base + (wall > 0 ? wall * 0.88 * (1 + 0.18 * noise2(s / 7, d > 0 ? 3.1 : 7.7, this.seed + 41)) : 0);
  }

  /** final terrain height */
  /** height influenced by one road point (cross-section near, blend to base further out) */
  private roadInfluenced(q: NearestRoad, base: number) {
    const a = Math.abs(q.d), e2 = this.edge2;
    if (a <= e2) return q.h + this.cross(a, q.s, q.d);
    const edgeH = q.h + this.cross(e2, q.s, q.d) + 0.25 * smoothstep(e2, e2 + 2, a);
    // cutting / embankment: the bank is as wide as the height difference needs at the environment's bank slope
    // (narrow, steep faces next to the road instead of a 17 m ramp), always reaching the base terrain by BLEND_END
    const delta = base - edgeH;
    // outside of corners: a flat run-off verge before the bank starts (forgiving when a car runs wide)
    const k = this.kAt(q.s);
    const runoff = k * q.d < 0 ? clamp((Math.abs(k) - 1 / 140) * 260, 0, 4.5) : 0;
    // sea cliff stretch, sea side: a flat platform out to the cliff edge (the cliff itself is carved in height())
    const cf = this.cliff;
    const plat = cf && cf.side[q.i] * q.d > 0 ? cf.flag[q.i] * CLIFF_PLATFORM : 0;
    const b0 = e2 + runoff + plat;
    const W = clamp(Math.abs(delta) / this.env.terrain.bankSlope + 1.5, 3, BLEND_END - b0 - 0.5);
    return edgeH + delta * smoothstep(b0, b0 + W, a);
  }

  /** final terrain height */
  height(x: number, z: number) {
    const base = this.base(x, z);
    let h = base;
    const q = this.nearest(x, z);
    if (q.found) {
      const a = Math.abs(q.d);
      h = this.roadInfluenced(q, base);
      // a second, separate part of the road nearby (hairpin legs): blend so there is no seam halfway
      if (this.second >= 0 && a > this.edge2) {
        const q2 = this.refine(x, z, this.second, this.q2);
        const a2 = Math.abs(q2.d);
        if (a2 < BLEND_END) {
          const d1 = a - this.edge2, d2 = Math.max(0, a2 - this.edge2);
          const f = smoothstep(0, 1, d1 / Math.max(1e-6, d1 + d2));
          h = h + (this.roadInfluenced(q2, base) - h) * f;
        }
      }
      if (this.lakes.length) h = this.lakeCarve(x, z, h, a);
      if (this.fords.length) h = this.fordCarve(x, z, h, a);
    } else {
      if (this.lakes.length) h = this.lakeCarve(x, z, h, 99);
      if (this.fords.length) h = this.fordCarve(x, z, h, 99);
    }
    if (this.cliff) h = this.cliffCarve(x, z, h);
    return h;
  }

  /** how far (m) seaward of the cliff shoreline (x,z) lies; ≤ 0 on land, −Infinity without sea cliffs */
  cliffE(x: number, z: number) {
    const cf = this.cliff, c = this.coast;
    if (!cf || !c) return -Infinity;
    const dx = x - c.cx, dz = z - c.cz;
    const u = dx * c.nx + dz * c.nz, t = dx * cf.tx + dz * cf.tz;
    return u - this.cliffBin(cf.shore, t);
  }

  private cliffBin(arr: Float32Array, t: number) {
    const cf = this.cliff!;
    const f = (t - cf.t0) / cf.bin;
    if (f <= 0) return arr[0];
    if (f >= arr.length - 1) return arr[arr.length - 1];
    const i = Math.floor(f), k = f - i;
    return arr[i] * (1 - k) + arr[i + 1] * k;
  }

  /** sea floor and ledged rock face seaward of the shoreline; reefs and stacks poke out of the water near the foot */
  cliffCarve(x: number, z: number, h: number) {
    const cf = this.cliff, c = this.coast;
    if (!cf || !c) return h;
    const dx = x - c.cx, dz = z - c.cz;
    const u = dx * c.nx + dz * c.nz, t = dx * cf.tx + dz * cf.tz;
    const shore = this.cliffBin(cf.shore, t);
    const e0 = u - shore;
    if (!(e0 > 0)) return h;
    const top = this.cliffBin(cf.top, t);
    // horizontal distance to the shoreline polyline (not just the offset along the sea normal: the shore bends)
    let e2 = e0 * e0;
    {
      const sh = cf.shore, f = (t - cf.t0) / cf.bin, w = Math.ceil(Math.min(e0, 90) / cf.bin);
      const j0 = Math.max(0, Math.floor(f) - w), j1 = Math.min(sh.length - 2, Math.ceil(f) + w);
      for (let j = j0; j <= j1; j++) {
        // segment j → j+1 in (t, u)
        const ta = cf.t0 + j * cf.bin, ua = sh[j], dt = cf.bin, du = sh[j + 1] - ua;
        const q = clamp(((t - ta) * dt + (u - ua) * du) / (dt * dt + du * du), 0, 1);
        const a = t - ta - dt * q, b = u - ua - du * q;
        const dd = a * a + b * b;
        if (dd < e2) e2 = dd;
      }
    }
    const e = Math.sqrt(e2);
    // ledges: the face alternates steep (≈2.5:1) and flatter (≈1.2:1) bands every P m of run, phase varies along the coast
    const S = 1.9, A = 0.36, P = 4.2, k = (2 * Math.PI) / P;
    const ph = 2.4 * noise2(t / 35, 0.5, this.seed + 61) + 0.9 * noise2(t / 9, 4.5, this.seed + 62);
    const drop = S * (e + (A / k) * (Math.sin(k * e + ph) - Math.sin(ph)));
    const sea = c.seaLevel;
    const floor = sea - 3;
    const face = top - drop;
    // reefs / stacks: soft bumps on the sea floor, densest at the foot of the cliff
    const foot = Math.max(0, (top - floor) / S);
    const near = 1 - smoothstep(foot + 4, foot + 70, e);
    const r = noise2(x / 13, z / 13, this.seed + 71) * 0.8 + noise2(x / 6, z / 6, this.seed + 72) * 0.2;
    const reef = smoothstep(0.3 - 0.25 * near, 0.85, r) * (0.4 + 0.6 * near);
    const bed = floor + reef * 5.6;
    return Math.min(h, Math.max(face, bed));
  }

  /** at or beyond the cliff edge / under the sea (no scenery there) */
  offshore(x: number, z: number) {
    if (!this.coast) return false;
    if (this.cliff && this.cliffE(x, z) > -0.5) return true;
    return this.height(x, z) < this.coast.seaLevel + 0.8;
  }

  /** build the sea-cliff shoreline from per-sample seacliff flags (after the profile and sea level are known) */
  buildSeaCliff(raw: Uint8Array) {
    const c = this.coast;
    if (!c) return;
    const cl = this.cl, n = cl.n;
    const tx = -c.nz, tz = c.nx;
    // smoothed flag (±30 m), sea side per sample
    const flag = new Float32Array(n), side = new Int8Array(n);
    {
      const pre = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + raw[i];
      for (let i = 0; i < n; i++) { const a = Math.max(0, i - 30), b = Math.min(n, i + 31); flag[i] = clamp((pre[b] - pre[a]) / (b - a) * 1.6 - 0.3, 0, 1); }
      for (let i = 0; i < n; i++) { const th = cl.theta[i]; side[i] = -Math.sin(th) * c.nx + Math.cos(th) * c.nz >= 0 ? 1 : -1; }
    }
    const T = new Float64Array(n), U = new Float64Array(n);
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = cl.x[i] - c.cx, dz = cl.z[i] - c.cz;
      T[i] = dx * tx + dz * tz; U[i] = dx * c.nx + dz * c.nz;
      tmin = Math.min(tmin, T[i]); tmax = Math.max(tmax, T[i]);
    }
    const BIN = 2, pad = 900;
    const t0 = tmin - pad, nb = Math.ceil((tmax - tmin + 2 * pad) / BIN) + 1;
    const anchor = new Float32Array(nb).fill(1e7), cons = new Float32Array(nb).fill(-1e7);
    const W = this.edge2 + CLIFF_PLATFORM, M = 30;
    for (let i = 0; i < n; i++) {
      const cliffy = flag[i] > 0.5 && raw[i];
      const b = Math.round((T[i] - t0) / BIN);
      if (cliffy) anchor[b] = Math.min(anchor[b], U[i] + W);
      // every road sample keeps land around it: a platform's width on cliff stretches, M metres elsewhere
      const R = cliffy ? W : M - (M - W) * flag[i];
      const rb = Math.ceil(R / BIN);
      for (let k = -rb; k <= rb; k++) { const j = b + k; if (j >= 0 && j < nb) cons[j] = Math.max(cons[j], U[i] + R); }
    }
    // the shore follows the cliff road and recedes slowly away from it; the keep-land constraint fades at 1.5:1
    // (a long coastline: it leaves the road slowly, 1 m out per 3.5 m along the coast)
    for (let j = 1; j < nb; j++) anchor[j] = Math.min(anchor[j], anchor[j - 1] + BIN * 0.28);
    for (let j = nb - 2; j >= 0; j--) anchor[j] = Math.min(anchor[j], anchor[j + 1] + BIN * 0.28);
    for (let j = 1; j < nb; j++) cons[j] = Math.max(cons[j], cons[j - 1] - BIN * 2.5);
    for (let j = nb - 2; j >= 0; j--) cons[j] = Math.max(cons[j], cons[j + 1] - BIN * 2.5);
    const shore = new Float32Array(nb);
    for (let j = 0; j < nb; j++) shore[j] = Math.max(anchor[j], cons[j]);
    // round off the kinks, never back over the keep-land constraint; a little ragged noise outward
    const tmp = new Float32Array(nb);
    for (let pass = 0; pass < 4; pass++) {
      for (let j = 0; j < nb; j++) tmp[j] = (shore[Math.max(0, j - 1)] + 2 * shore[j] + shore[Math.min(nb - 1, j + 1)]) / 4;
      for (let j = 0; j < nb; j++) shore[j] = Math.max(tmp[j], cons[j]);
    }
    for (let j = 0; j < nb; j++) shore[j] += 0.9 * (1 + noise2((t0 + j * BIN) / 11, 2.5, this.seed + 63));
    const top = new Float32Array(nb);
    // heights at the shoreline with the platform already flattened (shore far away while sampling)
    this.cliff = { tx, tz, t0, bin: BIN, shore: new Float32Array(nb).fill(1e7), top, flag, side };
    for (let j = 0; j < nb; j++) {
      if (shore[j] > 5e5) { top[j] = c.seaLevel; continue; }
      const t = t0 + j * BIN;
      const x = c.cx + tx * t + c.nx * shore[j], z = c.cz + tz * t + c.nz * shore[j];
      // the highest ground along the shoreline nearby: the face then starts at or above the land it cuts into
      let hm = -Infinity;
      for (const o of [-1.5, 0, 1.5]) for (const w of [-0.6, 0, 0.6]) hm = Math.max(hm, this.height(x + tx * o + c.nx * w, z + tz * o + c.nz * w));
      top[j] = hm + 0.05;
    }
    // limit how fast the cliff top changes along the coast (it only ever moves up): keeps the face within ~2.6:1
    for (let j = 1; j < nb; j++) top[j] = Math.max(top[j], top[j - 1] - BIN * 0.45);
    for (let j = nb - 2; j >= 0; j--) top[j] = Math.max(top[j], top[j + 1] - BIN * 0.45);
    this.cliff = { tx, tz, t0, bin: BIN, shore, top, flag, side };
  }

  /** lake shore/bed target height for normalized ellipse radius rho */
  static lakeShore(level: number, rho: number) {
    return rho >= 0.92 ? level + 0.35 + 3 * (rho - 0.92) : level + 0.35 - 4.85 * smoothstep(0.92, 0.45, rho);
  }

  private lakeCarve(x: number, z: number, h: number, roadDist: number) {
    for (const L of this.lakes) {
      const dx = x - L.cx, dz = z - L.cz;
      const u = (dx * L.ux + dz * L.uz) / L.a, v = (-dx * L.uz + dz * L.ux) / L.b;
      const rho = Math.sqrt(u * u + v * v);
      if (rho > 1.35) continue;
      const keep = smoothstep(this.edge2 + 1, this.edge2 + 13, roadDist); // never carve the road
      const w = smoothstep(1.35, 0.92, rho) * keep;
      h = h + (Terrain.lakeShore(L.level, rho) - h) * w;
    }
    return h;
  }

  /** river channels: a U-shaped bed through every ford, meandering away from the road on both sides */
  private fordCarve(x: number, z: number, h: number, roadDist: number) {
    for (const F of this.fords) {
      const dx = x - F.cx, dz = z - F.cz;
      const u = dx * F.ux + dz * F.uz;
      if (Math.abs(u) > 260) continue;
      const mean = 7 * Math.sin(u / 37 + F.s) + 4 * Math.sin(u / 13);
      const v = Math.abs(-dx * F.uz + dz * F.ux - mean * smoothstep(8, 40, Math.abs(u)));
      const w = F.hw * (1 + 0.25 * Math.sin(u / 23 + 1.3));
      if (v > w + 6) continue;
      // bed rises slowly away from the crossing (the river runs downhill one way)
      const bed = F.bed + Math.max(0, Math.abs(u) - 20) * 0.01;
      const k = smoothstep(w * 0.55, w + 6, v);
      const target = bed + (h - bed) * k;
      const keep = smoothstep(this.edge2, this.edge2 + 3, roadDist); // the road surface itself is the scripted ford dip
      h = Math.min(h, h + (target - h) * keep);
    }
    return h;
  }

  /** inside a ford's channel (the water surface) */
  inFord(x: number, z: number, wetOnly = true, widen = 1) {
    for (const F of this.fords) {
      if (wetOnly && !F.water) continue;
      const dx = x - F.cx, dz = z - F.cz;
      const u = dx * F.ux + dz * F.uz;
      if (Math.abs(u) > 260) continue;
      const mean = 7 * Math.sin(u / 37 + F.s) + 4 * Math.sin(u / 13);
      const v = Math.abs(-dx * F.uz + dz * F.ux - mean * smoothstep(8, 40, Math.abs(u)));
      if (v < F.hw * 0.62 * widen * (1 + 0.25 * Math.sin(u / 23 + 1.3))) return F;
    }
    return null;
  }

  normal(x: number, z: number, out: V3) {
    return normalFromHeight((a, b) => this.height(a, b), x, z, out, 0.2);
  }

  surface(x: number, z: number): Surface {
    return this.remap(this.rawSurface(x, z));
  }

  private remap(s: number): Surface { const r = this.grip[s]; return (r ?? s) as Surface; }

  private rawSurface(x: number, z: number): number {
    const r = this.env.road;
    if (this.fords.length && this.inFord(x, z)) return Surface.Water;
    const q = this.nearest(x, z);
    if (q.found) {
      const a = Math.abs(q.d);
      const i = clamp(Math.round(q.s / DS), 0, this.cl.n - 1);
      if (a <= this.halfWidth + 0.25) {
        if (this.ice && this.ice[i]) return Surface.Ice;
        if (this.gravel && this.gravel[i]) return Surface.Gravel;
        return r.surface;
      }
      if (a <= this.edge1 + 0.3) return this.gravel && this.gravel[i] ? Surface.Dirt : r.shoulderSurface;
    }
    for (const L of this.lakes) {
      const dx = x - L.cx, dz = z - L.cz;
      const u = (dx * L.ux + dz * L.uz) / L.a, v = (-dx * L.uz + dz * L.ux) / L.b;
      if (u * u + v * v < 0.9) return r.kind === 'snow' ? Surface.Ice : Surface.Water;
    }
    return r.offSurface;
  }

  /** road weight 0..1 for rendering / scatter (1 on road surface) */
  roadDistance(x: number, z: number) {
    const q = this.nearest(x, z);
    return q.found ? Math.abs(q.d) : Infinity;
  }
}
