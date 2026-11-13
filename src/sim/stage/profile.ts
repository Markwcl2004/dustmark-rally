// Road vertical profile: smoothed environment terrain + grade limit + scripted features (jumps, crests, dips).
import { clamp, smoothstep } from '../math/vec';
import { DS, type Centerline, type ResolvedFeature } from './centerline';
import type { Terrain, Lake } from './terrain';

/** kicker (rise H over L, quadratic), sharp lip, landing slope down D below baseline, then recover. s relative to kicker start */
export function jumpShape(s: number, H: number, L: number) {
  const Ld = L * 1.6, D = H * 0.55, Lr = 55;
  if (s <= 0) return 0;
  if (s < L) { const u = s / L; return H * u * u; }
  if (s < L + Ld) { const u = (s - L) / Ld; return H - (H + D) * (1 - (1 - u) * (1 - u)); }
  if (s < L + Ld + Lr) { const u = (s - L - Ld) / Lr; return -D * (1 - u * u * (3 - 2 * u)); }
  return 0;
}
export const jumpExtent = (L: number) => L + L * 1.6 + 55;

function featureAt(f: ResolvedFeature, s: number, crestSpeed = 0) {
  const L = f.length;
  switch (f.kind) {
    case 'jump': return jumpShape(s - (f.s - L), f.height, L); // f.s is the lip
    case 'crest': {
      // rally crest: the top is no sharper than a car at the design speed can follow (vertical curvature ≤ g/V²),
      // and the back side is 1.6× longer than the front — any hop off the top lands on that long downslope
      const H = f.height;
      const a = Math.max(L / 2, crestSpeed > 0 ? Math.PI * Math.sqrt(H / (2 * (G / (crestSpeed * crestSpeed)))) : 0);
      const b = a * 1.6;
      const u = s - f.s;
      if (u <= -a || u >= b) return 0;
      return H * 0.5 * (1 + Math.cos(Math.PI * (u < 0 ? u / a : u / b)));
    }
    case 'dip': {
      const u = (s - f.s) / (L / 2);
      return Math.abs(u) < 1 ? -f.height * 0.5 * (1 + Math.cos(Math.PI * u)) : 0;
    }
    case 'ford': {
      // ramps down into a riverbed with a flat bottom (the wading stretch), then back up
      const u = Math.abs(s - f.s) / (L / 2);
      if (u >= 1) return 0;
      const k = clamp((u - 0.32) / 0.68, 0, 1);
      return -f.height * (1 - k * k * (3 - 2 * k));
    }
    case 'rollers': {
      const total = L * f.count, u = (s - (f.s - total / 2)) / L;
      if (u < 0 || u > f.count) return 0;
      const sn = Math.sin(Math.PI * u);
      return f.height * sn * sn;
    }
  }
}

const G = 9.81;

function boxBlur(a: Float64Array, radius: number) {
  const n = a.length, out = new Float64Array(n);
  let sum = 0, cnt = 0;
  const r = Math.max(1, Math.round(radius));
  for (let i = -r; i <= r; i++) { const k = clamp(i, 0, n - 1); sum += a[k]; cnt++; }
  for (let i = 0; i < n; i++) {
    out[i] = sum / cnt;
    const add = clamp(i + r + 1, 0, n - 1), rem = clamp(i - r, 0, n - 1);
    sum += a[add] - a[rem];
  }
  return out;
}

export function buildProfile(cl: Centerline, terrain: Terrain, maxGrade: number, smooth: number, halfWidth: number, follow?: Float64Array, crestSpeed = 0): { prof: Float64Array; lakes: Lake[] } {
  const n = cl.n;
  let p = new Float64Array(n);
  for (let i = 0; i < n; i++) p[i] = terrain.base(cl.x[i], cl.z[i]);
  const raw = p;
  const r = smooth / DS / 2;
  p = boxBlur(boxBlur(boxBlur(p, r), r), r * 0.6);
  // zones that hug the ground (villages, clearings): blend toward a lightly smoothed profile → fewer cuttings there
  if (follow) {
    const loose = boxBlur(boxBlur(raw, 22), 22);
    const f = boxBlur(follow, 40);
    for (let i = 0; i < n; i++) p[i] += (loose[i] - p[i]) * f[i];
  }
  // lake sections: flatten toward their mean so the shore road runs level
  const lakePieces = cl.pieces.filter((pc) => pc.lake);
  for (const pc of lakePieces) {
    const i0 = Math.floor(pc.s0 / DS), i1 = Math.min(n - 1, Math.ceil(pc.s1 / DS));
    let m = 0;
    for (let i = i0; i <= i1; i++) m += p[i];
    m /= i1 - i0 + 1;
    for (let i = Math.max(0, i0 - 120); i <= Math.min(n - 1, i1 + 120); i++) {
      const w = smoothstep(i0 - 120, i0, i) * (1 - smoothstep(i1, i1 + 120, i));
      p[i] = p[i] + (m - p[i]) * w;
    }
  }
  // braking zones of tight corners stay even: no unscripted crests/hollows where the car must slow down and turn in
  {
    const even = boxBlur(boxBlur(p, 45), 45);
    const w = new Float64Array(n);
    for (const pc of cl.pieces) {
      if (pc.kind !== 'turn') continue;
      const g = pc.grade;
      if (!(g === 'hairpin' || g === 'square' || (typeof g === 'number' && g <= 3))) continue;
      const i0 = Math.floor(pc.s0 / DS);
      for (let i = Math.max(0, i0 - 110); i <= Math.min(n - 1, i0 + 30); i++) {
        const u = i < i0 - 70 ? smoothstep(i0 - 110, i0 - 70, i) : i > i0 + 10 ? 1 - smoothstep(i0 + 10, i0 + 30, i) : 1;
        w[i] = Math.max(w[i], u);
      }
    }
    for (let i = 0; i < n; i++) p[i] += (even[i] - p[i]) * w[i];
  }
  // grade limit (forward + backward passes)
  const g = maxGrade * DS;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) p[i] = clamp(p[i], p[i - 1] - g, p[i - 1] + g);
    for (let i = n - 2; i >= 0; i--) p[i] = clamp(p[i], p[i + 1] - g, p[i + 1] + g);
  }
  p = boxBlur(p, 6);
  // scripted features on top
  const feats = cl.pieces.flatMap((pc) => pc.features);
  for (const f of feats) {
    const ext = f.kind === 'jump' ? jumpExtent(f.length) + f.length : f.kind === 'rollers' ? f.length * f.count : f.length * 3;
    const i0 = Math.max(0, Math.floor((f.s - ext) / DS)), i1 = Math.min(n - 1, Math.ceil((f.s + ext) / DS));
    for (let i = i0; i <= i1; i++) p[i] += featureAt(f, i * DS, crestSpeed);
  }
  // lakes beside the road
  const lakes: Lake[] = [];
  // consecutive lake pieces on the same side form one lake
  const groups: { s0: number; s1: number; side: 'L' | 'R' }[] = [];
  for (const pc of lakePieces) {
    const g = groups[groups.length - 1];
    if (g && g.side === pc.lake && pc.s0 - g.s1 < 5) g.s1 = pc.s1;
    else groups.push({ s0: pc.s0, s1: pc.s1, side: pc.lake! });
  }
  for (const gp of groups) {
    const sm = (gp.s0 + gp.s1) / 2, im = Math.round(sm / DS);
    // ellipse axis along the chord of the lake section
    const i0 = Math.floor(gp.s0 / DS), i1 = Math.min(n - 1, Math.ceil(gp.s1 / DS));
    let ux = cl.x[i1] - cl.x[i0], uz = cl.z[i1] - cl.z[i0];
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    const side = gp.side === 'R' ? 1 : -1;
    const a = ul / 2 + 60, b = 160;
    // the road bulges toward/away from the chord; offset from the mid-point on the road
    const off = halfWidth + 18 + b;
    const cx = cl.x[im] - uz * off * side, cz = cl.z[im] + ux * off * side;
    let lo = Infinity;
    for (let i = i0; i <= i1; i++) lo = Math.min(lo, p[i]);
    const lake: Lake = { cx, cz, ux, uz, a, b, level: lo - 1.3, side: gp.side, s0: gp.s0, s1: gp.s1 };
    // push the lake away until no road (plus ditch margin) intrudes into its shore band
    const nx = -uz * side, nz = ux * side;
    for (let it = 0; it < 60; it++) {
      let minRho = Infinity;
      for (let i = 0; i < n; i += 3) {
        const ddx = cl.x[i] - lake.cx, ddz = cl.z[i] - lake.cz;
        const uu = (ddx * ux + ddz * uz) / (lake.a + 14), vv = (-ddx * uz + ddz * ux) / (lake.b + 14);
        minRho = Math.min(minRho, Math.sqrt(uu * uu + vv * vv));
      }
      if (minRho >= 1.05) break;
      lake.cx += nx * 5; lake.cz += nz * 5;
    }
    lakes.push(lake);
  }
  return { prof: p, lakes };
}
