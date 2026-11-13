// Obstacles and scenery placement, driven by the stage's scenery zones (src/data/envs.ts ZoneDef):
// trees, rocks, boulders, bushes, stumps, deadwood, log piles, cabins, fences, hay bales, power poles, parked vans,
// media towers, spectators, banners, corner arrows, flags, tape, boards, arches.
// Everything that can be hit near the road is also pushed into the obstacle list (physics).
import { zoneDef, type EnvDef, type TreeKind, type ZoneDef } from '../../data/envs';
import type { Obstacle } from '../ground';
import { Rng, hash2, noise2 } from '../math/rng';
import { clamp, smoothstep } from '../math/vec';
import { DS, type Centerline, type Piece } from './centerline';
import type { Terrain } from './terrain';

export type PropType =
  | TreeKind | 'bush' | 'rock' | 'boulder' | 'stump' | 'deadwood'
  | 'logs' | 'cabin' | 'fence' | 'hay' | 'pole' | 'van' | 'tower' | 'crowd' | 'banner' | 'arrow' | 'flag'
  | 'hut' | 'tent' | 'termite' | 'rockpile' | 'snowfence' | 'snowpile' | 'house' | 'wall';

export const TREE_TYPES: readonly PropType[] = ['pine', 'scots', 'birch', 'spruce', 'acacia', 'thorn', 'snowpine', 'snowspruce', 'bare', 'cypress', 'olive', 'umbrella'];
/** trunk radius (m, at scale 1) for the physics obstacle */
const TRUNK_R: Record<string, number> = { pine: 0.26, scots: 0.22, birch: 0.17, spruce: 0.14, acacia: 0.24, thorn: 0.14, snowpine: 0.26, snowspruce: 0.14, bare: 0.18, cypress: 0.2, olive: 0.3, umbrella: 0.24 };
/** size spread per kind: base + big × spread */
const TREE_SIZE: Record<string, [number, number]> = { pine: [0.7, 0.85], scots: [0.85, 0.55], birch: [0.7, 0.6], spruce: [0.35, 0.4], acacia: [0.7, 0.6], thorn: [0.6, 0.5], snowpine: [0.7, 0.8], snowspruce: [0.35, 0.45], bare: [0.7, 0.5], cypress: [0.7, 0.6], olive: [0.7, 0.5], umbrella: [0.75, 0.5] };

export interface Prop {
  type: PropType;
  x: number; y: number; z: number;
  rot: number;
  scale: number;
  variant: number;
  /** distance from road centre at placement */
  d: number;
  /** fences: length along rot (m) */
  len?: number;
}

export interface Marker {
  kind: 'start' | 'finish' | 'stop' | 'km' | 'board';
  s: number;
  text: string;
  /** +1 right, -1 left */
  side: number;
}

export interface TapeLine { s0: number; s1: number; side: number; d: number }

/** coarse distance-to-road grid (cell metres) covering the corridor, with the nearest centreline sample per cell */
export class Corridor {
  readonly cell = 8;
  readonly minX: number; readonly minZ: number; readonly nx: number; readonly nz: number;
  readonly dist: Float32Array;
  readonly idx: Int32Array;
  constructor(cl: Centerline, readonly radius: number) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < cl.n; i++) { x0 = Math.min(x0, cl.x[i]); x1 = Math.max(x1, cl.x[i]); z0 = Math.min(z0, cl.z[i]); z1 = Math.max(z1, cl.z[i]); }
    const pad = radius + this.cell * 2;
    this.minX = Math.floor((x0 - pad) / this.cell) * this.cell;
    this.minZ = Math.floor((z0 - pad) / this.cell) * this.cell;
    this.nx = Math.ceil((x1 + pad - this.minX) / this.cell) + 1;
    this.nz = Math.ceil((z1 + pad - this.minZ) / this.cell) + 1;
    this.dist = new Float32Array(this.nx * this.nz).fill(1e9);
    this.idx = new Int32Array(this.nx * this.nz).fill(-1);
    const rc = Math.ceil(radius / this.cell) + 1;
    for (let i = 0; i < cl.n; i += 3) {
      const px = cl.x[i], pz = cl.z[i];
      const cx = Math.round((px - this.minX) / this.cell), cz = Math.round((pz - this.minZ) / this.cell);
      for (let a = -rc; a <= rc; a++) {
        const ix = cx + a; if (ix < 0 || ix >= this.nx) continue;
        for (let b = -rc; b <= rc; b++) {
          const iz = cz + b; if (iz < 0 || iz >= this.nz) continue;
          const wx = this.minX + ix * this.cell, wz = this.minZ + iz * this.cell;
          const d = Math.hypot(wx - px, wz - pz);
          const k = iz * this.nx + ix;
          if (d < this.dist[k]) { this.dist[k] = d; this.idx[k] = i; }
        }
      }
    }
  }
  /** bilinear approximate distance to the road centreline */
  at(x: number, z: number) {
    const fx = (x - this.minX) / this.cell, fz = (z - this.minZ) / this.cell;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= this.nx - 1 || iz >= this.nz - 1) return 1e9;
    const tx = fx - ix, tz = fz - iz, n = this.nx, d = this.dist;
    const a = d[iz * n + ix], b = d[iz * n + ix + 1], c = d[(iz + 1) * n + ix], e = d[(iz + 1) * n + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  }
  /** arc length of the nearest centreline sample (cell resolution), -1 outside */
  sAt(x: number, z: number) {
    const ix = Math.round((x - this.minX) / this.cell), iz = Math.round((z - this.minZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    const i = this.idx[iz * this.nx + ix];
    return i < 0 ? -1 : i * DS;
  }
}

/** zone runs along the road, resolved from the script pieces */
export class Zones {
  readonly runs: { s0: number; s1: number; id: string }[] = [];
  constructor(pieces: Piece[], readonly env: EnvDef, length: number) {
    for (const p of pieces) {
      const id = p.zone || env.defaultZone;
      const last = this.runs[this.runs.length - 1];
      if (last && last.id === id) last.s1 = p.s1;
      else this.runs.push({ s0: last ? last.s1 : 0, s1: p.s1, id });
    }
    if (!this.runs.length) this.runs.push({ s0: 0, s1: length, id: env.defaultZone });
    this.runs[this.runs.length - 1].s1 = Math.max(this.runs[this.runs.length - 1].s1, length + 1);
  }
  id(s: number) {
    for (const r of this.runs) if (s < r.s1) return r.id;
    return this.runs[this.runs.length - 1].id;
  }
  def(s: number): ZoneDef { return zoneDef(this.env, this.id(s)); }
  /** zone with a dithered transition band (±band m) so borders are not ruler-straight */
  dither(s: number, h: number, band = 40) { return this.def(s + (h - 0.5) * 2 * band); }
  /** blend weights of every zone id at s (linear over ±band) */
  weights(s: number, band = 45): Record<string, number> {
    const w: Record<string, number> = {};
    const N = 7;
    for (let k = 0; k < N; k++) {
      const id = this.id(s + ((k / (N - 1)) - 0.5) * 2 * band);
      w[id] = (w[id] ?? 0) + 1 / N;
    }
    return w;
  }
}

export interface ScatterResult {
  props: Prop[];
  obstacles: Obstacle[];
  markers: Marker[];
  tape: TapeLine[];
  /** guard rails (steel W-beam on posts) along drops */
  rails: TapeLine[];
}

export function scatter(cl: Centerline, terrain: Terrain, env: EnvDef, corridor: Corridor, zones: Zones, seed: number, startS: number, finishS: number, keepClear: { s: number; r: number }[]): ScatterResult {
  const props: Prop[] = [];
  const obstacles: Obstacle[] = [];
  const rng = new Rng(seed * 31 + 7);
  const v = env.veg;
  const e2 = terrain.edge2;
  const ptAt = (s: number) => {
    const i = clamp(Math.round(s / DS), 0, cl.n - 1);
    const th = cl.theta[i];
    return { x: cl.x[i], z: cl.z[i], th, dx: Math.cos(th), dz: Math.sin(th), rx: -Math.sin(th), rz: Math.cos(th), k: cl.kappa[i] };
  };
  const at = (s: number, d: number) => { const p = ptAt(s); return { x: p.x + p.rx * d, z: p.z + p.rz * d, p }; };
  const clearZones = keepClear.map((k) => ({ ...ptAt(k.s), r: k.r }));
  const inClear = (x: number, z: number, extra = 0) => clearZones.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + extra);
  const inLake = (x: number, z: number, margin: number) => terrain.lakes.some((L) => {
    const dx = x - L.cx, dz = z - L.cz;
    const u = (dx * L.ux + dz * L.uz) / L.a, w = (-dx * L.uz + dz * L.ux) / L.b;
    return u * u + w * w < margin * margin;
  });
  /** exact |d| to the road from (x,z), Infinity if far */
  const roadD = (x: number, z: number) => { const q = terrain.nearest(x, z); return q.found ? Math.abs(q.d) : Infinity; };

  // ---- spectator tape ----
  const tape: TapeLine[] = [];
  const td = e2 + 1.6;
  tape.push({ s0: startS - 40, s1: startS + 70, side: -1, d: td }, { s0: startS - 40, s1: startS + 70, side: 1, d: td });
  tape.push({ s0: finishS - 60, s1: finishS + 60, side: -1, d: td }, { s0: finishS - 60, s1: finishS + 60, side: 1, d: td });
  const jumps: number[] = [];
  for (const pc of cl.pieces) {
    for (const f of pc.features) if (f.kind === 'jump') { jumps.push(f.s); tape.push({ s0: f.s - 45, s1: f.s + 35, side: -1, d: td + 2 }, { s0: f.s - 45, s1: f.s + 35, side: 1, d: td + 2 }); }
    if (pc.kind === 'turn' && (pc.grade === 'hairpin' || pc.grade === 1 || pc.grade === 'square')) {
      const side = pc.dir === 'R' ? -1 : 1; // outside of the corner
      tape.push({ s0: pc.s0 - 10, s1: pc.s1 + 10, side, d: td + 2.5 });
    }
  }

  // ---- guard rails where the ground falls away beside the road (coast cliffs, high embankments on asphalt) ----
  const rails: TapeLine[] = [];
  if (env.road.kind === 'asphalt') {
    const rd = terrain.edge1 + 0.35;
    for (const side of [-1, 1]) {
      let run0 = -1, gap = 0;
      for (let s = 30; s < cl.length - 30; s += 4) {
        const p = at(s, (terrain.edge2 + 5) * side);
        const drop = terrain.profAt(s) - terrain.height(p.x, p.z);
        // sea-cliff stretches: always railed on the sea side (the edge can sit just beyond the probe point)
        const pc = terrain.cliff ? at(s, (terrain.edge2 + 12) * side) : null;
        const want = drop > 2.2 || (env.terrain.coast ? drop > 1.2 : false) || (pc !== null && terrain.cliffE(pc.x, pc.z) > -1);
        if (want) { if (run0 < 0) run0 = s; gap = 0; }
        else if (run0 >= 0 && ++gap > 3) {
          const s1 = s - gap * 4 + 6;
          if (s1 - run0 > 16) rails.push({ s0: run0 - 6, s1, side, d: rd });
          run0 = -1; gap = 0;
        }
      }
      if (run0 >= 0) rails.push({ s0: run0 - 6, s1: cl.length - 30, side, d: rd });
    }
    // physics: a row of overlapping spheres at bumper height along each rail (hard)
    for (const r of rails) for (let s = r.s0; s <= r.s1; s += 0.9) {
      const { x, z } = at(s, (r.d + 0.15) * r.side);
      obstacles.push({ kind: 'sphere', x, y: terrain.height(x, z) + 0.45, z, r: 0.42, h: 0 });
    }
  }
  const nearRail = (s: number, d: number, r: number) => rails.some((t) => s > t.s0 - r && s < t.s1 + r && d * t.side > 0 && Math.abs(d) < t.d + r + 4);

  // ---- event furniture first (it claims space; vegetation keeps clear of it) ----
  const claimed: { x: number; z: number; r: number }[] = [];
  const isClaimed = (x: number, z: number, r: number) => claimed.some((c) => (x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + r) ** 2);
  const claim = (x: number, z: number, r: number) => claimed.push({ x, z, r });
  const hard = (x: number, y: number, z: number, r: number, kind: 'cyl' | 'sphere' = 'sphere', h = 0) => obstacles.push({ kind, x, y, z, r, h });
  const push = (p: Prop) => { props.push(p); return p; };

  // spectator groups: zone density + hot spots (jumps, hairpins, village), on the higher side, behind their own tape
  const crowdSpots: { s: number; side: number; n: number }[] = [];
  for (let s = startS + 90; s < finishS - 70; s += 10) {
    const z = zones.def(s);
    if (rng.next() < (z.crowd / 10) * 0.55) crowdSpots.push({ s, side: 0, n: 1 + rng.int(0, 1) });
  }
  for (const j of jumps) crowdSpots.push({ s: j + 8, side: 0, n: 3 }, { s: j - 20, side: 0, n: 2 });
  for (const pc of cl.pieces) if (pc.kind === 'turn' && pc.grade === 'hairpin') crowdSpots.push({ s: (pc.s0 + pc.s1) / 2, side: pc.dir === 'R' ? 1 : -1, n: 3 });
  crowdSpots.sort((a, b) => a.s - b.s);
  let lastCrowd = -1e9;
  for (const c of crowdSpots) {
    if (c.s - lastCrowd < 30) continue;
    let side = c.side;
    if (!side) {
      const hl = terrain.height(at(c.s, -(e2 + 6)).x, at(c.s, -(e2 + 6)).z), hr = terrain.height(at(c.s, e2 + 6).x, at(c.s, e2 + 6).z);
      side = hr > hl + 0.3 ? 1 : hl > hr + 0.3 ? -1 : (rng.chance(0.5) ? 1 : -1);
      // outside of a corner is the danger side: prefer the inside unless it is the high side
      const k = ptAt(c.s).k;
      if (Math.abs(k) > 1 / 120 && Math.sign(k) !== side && Math.abs(hr - hl) < 1) side = Math.sign(k);
    }
    let placed = 0;
    for (let g = 0; g < c.n; g++) {
      const s = c.s + (g - (c.n - 1) / 2) * 5.5 + rng.range(-1, 1);
      const d = e2 + 5 + rng.range(0, 2.5) + g % 2 * 1.2;
      const { x, z, p } = at(s, d * side);
      if (inLake(x, z, 1.15) || roadD(x, z) < e2 + 4) continue;
      if (terrain.coast && terrain.offshore(x, z)) continue;
      if (Math.abs(terrain.height(x, z) - terrain.profAt(s)) > 6) continue;
      push({ type: 'crowd', x, y: terrain.height(x, z), z, rot: yawToRoad(p, side), scale: rng.range(0.92, 1.06), variant: rng.int(0, 3), d });
      claim(x, z, 2.6);
      placed++;
    }
    if (!placed) continue;
    lastCrowd = c.s;
    const s0 = c.s - c.n * 3.5 - 6, s1 = c.s + c.n * 3.5 + 6;
    tape.push({ s0, s1, side, d: e2 + 3.2 });
    // a sponsor banner on the tape line
    if (rng.chance(0.7)) {
      const sb = c.s + rng.range(-4, 4);
      const { x, z, p } = at(sb, (e2 + 3.4) * side);
      push({ type: 'banner', x, y: terrain.height(x, z), z, rot: yawAlong(p, side), scale: 1, variant: rng.int(0, 5), d: e2 + 3.4 });
    }
  }
  /** props keep clear of the tape lines (posts would stand inside rocks/trees otherwise) */
  const nearTape = (s: number, d: number, r: number) => tape.some((t) => s > t.s0 - r && s < t.s1 + r && Math.abs(d * t.side - t.d) < r + 0.8);

  // banners along start/finish/jump tape
  for (const t of tape) {
    if (t.s1 - t.s0 < 60) continue;
    for (let s = t.s0 + 12; s < t.s1 - 8; s += rng.range(16, 26)) {
      const { x, z, p } = at(s, (t.d + 0.25) * t.side);
      if (inClear(x, z, -18)) continue;
      push({ type: 'banner', x, y: terrain.height(x, z), z, rot: yawAlong(p, t.side), scale: 1, variant: rng.int(0, 5), d: t.d + 0.25 });
    }
  }

  // corner arrows (chevron boards) on the outside of tight corners, facing the approach
  for (const pc of cl.pieces) {
    if (pc.kind !== 'turn') continue;
    const g = pc.grade;
    if (!(g === 'hairpin' || g === 'square' || (typeof g === 'number' && g <= 3))) continue;
    const side = pc.dir === 'R' ? -1 : 1;
    const n = g === 'hairpin' || g === 1 || g === 'square' ? 3 : 2;
    const sm = pc.s0 + (pc.s1 - pc.s0) * 0.38;
    for (let k = 0; k < n; k++) {
      const s = sm + (k - (n - 1) / 2) * 5;
      const d = e2 + 1.4;
      const { x, z, p } = at(s, d * side);
      if (roadD(x, z) < e2 + 0.8) continue;
      // face the driver approaching the corner
      const q = ptAt(pc.s0 - 25);
      push({ type: 'arrow', x, y: terrain.height(x, z), z, rot: Math.atan2(-q.dx, -q.dz), scale: 1, variant: pc.dir === 'R' ? 1 : 0, d });
      claim(x, z, 1.2);
    }
  }

  // zone sets walk the road in 10 m steps
  const runs = zones.runs;
  let poleSide = 1, lastPole = -1e9, lastFence = -1e9, lastCabin = -1e9, lastVan = -1e9, lastLogs = -1e9, lastHay = -1e9, lastFlag = -1e9;
  for (let s = 20; s < cl.length - 20; s += 10) {
    const zd = zones.def(s);
    const sets = zd.props;
    const run = runs.find((r) => s >= r.s0 && s < r.s1)!;
    const inner = s > run.s0 + 25 && s < run.s1 - 25;
    // power line along village / lake roads
    if (sets.includes('poles') && s - lastPole >= 48) {
      const d = e2 + 7.5;
      const { x, z, p } = at(s, d * poleSide);
      if (!inLake(x, z, 1.1) && roadD(x, z) > e2 + 5 && !inClear(x, z, -10) && !isClaimed(x, z, 1)) {
        const y = terrain.height(x, z);
        push({ type: 'pole', x, y, z, rot: Math.atan2(-p.dx, -p.dz), scale: 1, variant: 0, d });
        hard(x, y - 1, z, 0.16, 'cyl', 9);
        claim(x, z, 1.5);
        lastPole = s;
      }
    }
    // wooden fences in short runs
    if (sets.includes('fences') && inner && s - lastFence > 45 && rng.chance(0.35)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(2.6, 4.2), len = rng.range(16, 34);
      let ok = true;
      for (let u = 0; u <= len; u += 4) { const a = at(s + u, d * side); if (roadD(a.x, a.z) < e2 + 2 || inClear(a.x, a.z) || nearTape(s + u, d * side, 1)) ok = false; }
      if (ok) {
        for (let u = 0; u < len; u += 3.0) {
          const a = at(s + u, d * side), b = at(s + Math.min(len, u + 3.0), d * side);
          const y = terrain.height(a.x, a.z);
          push({ type: 'fence', x: a.x, y, z: a.z, rot: Math.atan2(b.x - a.x, b.z - a.z), scale: 1, variant: 0, d, len: Math.hypot(b.x - a.x, b.z - a.z) });
          hard(a.x, y + 0.5, a.z, 0.45);
          claim(a.x, a.z, 1.2);
        }
        lastFence = s + len;
      }
    }
    // red cabins
    if (sets.includes('cabins') && inner && s - lastCabin > rng.range(55, 110)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(12, 26);
      const { x, z, p } = at(s, d * side);
      if (!inLake(x, z, 1.2) && roadD(x, z) > e2 + 10 && !inClear(x, z) && !isClaimed(x, z, 6)) {
        const y = terrain.height(x, z);
        const variant = rng.int(0, 2); // 0 house, 1 barn, 2 shed
        push({ type: 'cabin', x, y, z, rot: yawToRoad(p, side) + (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.12, 0.12), scale: rng.range(0.9, 1.15), variant, d });
        hard(x, y - 1, z, variant === 1 ? 4.5 : 3.2, 'cyl', 8);
        claim(x, z, 7);
        lastCabin = s;
      }
    }
    // hay bales: outside of corners and near jumps in open zones
    if (sets.includes('hay') && s - lastHay > 60) {
      const k = ptAt(s + 15).k;
      if (Math.abs(k) > 1 / 90) {
        const side = -Math.sign(k), d = e2 + 1.8;
        let n = 0;
        for (let u = 0; u < 4; u++) {
          const { x, z } = at(s + 8 + u * 1.7, d * side);
          if (roadD(x, z) < e2 + 1.2 || inClear(x, z) || isClaimed(x, z, 0.8)) continue;
          const y = terrain.height(x, z);
          push({ type: 'hay', x, y, z, rot: rng.range(0, Math.PI), scale: rng.range(0.95, 1.05), variant: 0, d });
          hard(x, y + 0.7, z, 0.72);
          claim(x, z, 1);
          n++;
        }
        if (n) lastHay = s;
      } else if (rng.chance(0.08)) {
        // a few bales stacked in a field
        const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(9, 20);
        const { x, z } = at(s, d * side);
        if (roadD(x, z) > e2 + 6 && !inLake(x, z, 1.1) && !isClaimed(x, z, 3) && !inClear(x, z)) {
          for (let u = 0; u < 3; u++) {
            const bx = x + rng.range(-2.5, 2.5), bz = z + rng.range(-2.5, 2.5);
            push({ type: 'hay', x: bx, y: terrain.height(bx, bz), z: bz, rot: rng.range(0, Math.PI), scale: 1, variant: 1, d });
          }
          hard(x, terrain.height(x, z) + 0.7, z, 2.4);
          claim(x, z, 4);
          lastHay = s;
        }
      }
    }
    // log piles
    if (sets.includes('logs') && inner && s - lastLogs > rng.range(22, 45)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(3.8, 9);
      const { x, z, p } = at(s, d * side);
      if (!inLake(x, z, 1.1) && roadD(x, z) > e2 + 3.2 && !inClear(x, z) && !isClaimed(x, z, 3.5) && !nearTape(s, d * side, 3)) {
        const y = terrain.height(x, z);
        const th = Math.atan2(p.dz, p.dx);
        push({ type: 'logs', x, y, z, rot: -th + rng.range(-0.25, 0.25), scale: rng.range(0.9, 1.3), variant: rng.int(0, 1), d });
        for (let k2 = -1; k2 <= 1; k2++) hard(x + Math.cos(th) * k2 * 1.9, y + 0.5, z + Math.sin(th) * k2 * 1.9, 1.0);
        claim(x, z, 4);
        lastLogs = s;
      }
    }
    // parked service / media vans in clearings
    if (sets.includes('vans') && inner && s - lastVan > rng.range(160, 260)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(8, 13);
      const { x, z, p } = at(s, d * side);
      const y = terrain.height(x, z);
      if (!inLake(x, z, 1.2) && roadD(x, z) > e2 + 6 && !inClear(x, z) && !isClaimed(x, z, 4) && Math.abs(y - terrain.profAt(s)) < 3) {
        push({ type: 'van', x, y, z, rot: Math.atan2(p.dx, p.dz) + rng.range(-0.3, 0.3) + (rng.chance(0.5) ? Math.PI : 0), scale: 1, variant: rng.int(0, 2), d });
        hard(x, y + 0.9, z, 1.6);
        claim(x, z, 4);
        lastVan = s;
      }
    }
    // flags on poles near spectators / villages
    if (sets.includes('flags') && s - lastFlag > rng.range(35, 70)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(5.5, 9);
      const { x, z, p } = at(s, d * side);
      if (!inLake(x, z, 1.1) && roadD(x, z) > e2 + 4.5 && !isClaimed(x, z, 1) && !inClear(x, z, -12) && !(terrain.coast && terrain.offshore(x, z))) {
        push({ type: 'flag', x, y: terrain.height(x, z), z, rot: yawAlong(p, 1), scale: 1, variant: rng.int(0, 3), d });
        claim(x, z, 1);
        lastFlag = s;
      }
    }
  }
  // ---- environment-specific sets ----
  let lastHut = -1e9, lastTent = -1e9, lastTerm = -1e9, lastPile = -1e9, lastSF = -1e9, lastSP = -1e9, lastHouse = -1e9, lastWall = -1e9;
  const okSpot = (x: number, z: number, s: number, d: number, minRoad: number, r: number) =>
    !inLake(x, z, 1.15) && roadD(x, z) > minRoad && !inClear(x, z) && !isClaimed(x, z, r) && !nearRail(s, d, r) && !terrain.inFord(x, z, false) && !(terrain.coast && terrain.offshore(x, z));
  for (let s = 20; s < cl.length - 20; s += 10) {
    const zd = zones.def(s);
    const sets = zd.props;
    if (!sets.length) continue;
    const run = runs.find((r) => s >= r.s0 && s < r.s1)!;
    const inner = s > run.s0 + 25 && s < run.s1 - 25;
    // round huts with thatched cones (savanna camps), in small clusters
    if (sets.includes('huts') && inner && s - lastHut > rng.range(45, 80)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(14, 28);
      const { x, z } = at(s, d * side);
      if (okSpot(x, z, s, d * side, e2 + 11, 6)) {
        for (let k = 0; k < 3; k++) {
          const hx = x + rng.range(-7, 7), hz = z + rng.range(-7, 7);
          if (roadD(hx, hz) < e2 + 10 || isClaimed(hx, hz, 3)) continue;
          const y = terrain.height(hx, hz);
          push({ type: 'hut', x: hx, y, z: hz, rot: rng.range(0, 6.28), scale: rng.range(0.85, 1.15), variant: rng.int(0, 1), d });
          hard(hx, y - 1, hz, 2.3, 'cyl', 5);
          claim(hx, hz, 3.2);
        }
        lastHut = s;
      }
    }
    // event tents (gazebos) near crowds
    if (sets.includes('tents') && inner && s - lastTent > rng.range(60, 120)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(8, 14);
      const { x, z, p } = at(s, d * side);
      if (okSpot(x, z, s, d * side, e2 + 6, 3.5)) {
        const y = terrain.height(x, z);
        push({ type: 'tent', x, y, z, rot: yawToRoad(p, side), scale: 1, variant: rng.int(0, 2), d });
        hard(x, y - 1, z, 2.2, 'cyl', 3);
        claim(x, z, 3.5);
        lastTent = s;
      }
    }
    // termite mounds (hard)
    if (sets.includes('termites') && s - lastTerm > rng.range(30, 70)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(4, 30);
      const { x, z } = at(s, d * side);
      if (okSpot(x, z, s, d * side, e2 + 3, 1.5)) {
        const y = terrain.height(x, z), sc = rng.range(0.7, 1.4);
        push({ type: 'termite', x, y, z, rot: rng.range(0, 6.28), scale: sc, variant: rng.int(0, 1), d });
        hard(x, y - 1, z, 0.75 * sc, 'cyl', 2.5 * sc + 1);
        claim(x, z, 1.5);
        lastTerm = s;
      }
    }
    // piles of boulders (kopjes) set back from the road
    if (sets.includes('rockpiles') && s - lastPile > rng.range(40, 90)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(9, 30);
      const { x, z } = at(s, d * side);
      if (okSpot(x, z, s, d * side, e2 + 7, 6)) {
        const y = terrain.height(x, z), sc = rng.range(1.2, 2.4);
        push({ type: 'rockpile', x, y, z, rot: rng.range(0, 6.28), scale: sc, variant: rng.int(0, 2), d });
        hard(x, y + 0.6 * sc, z, 2.2 * sc);
        claim(x, z, 3.5 * sc);
        lastPile = s;
      }
    }
    // snow fences: slatted wooden fences on the windward slopes
    if (sets.includes('snowfence') && inner && s - lastSF > rng.range(50, 100)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(5, 10), len = rng.range(20, 40);
      let ok = true;
      for (let u = 0; u <= len; u += 4) { const a = at(s + u, d * side); if (!okSpot(a.x, a.z, s + u, d * side, e2 + 3, 0.5) || nearTape(s + u, d * side, 1)) ok = false; }
      if (ok) {
        for (let u = 0; u < len; u += 3.0) {
          const a = at(s + u, d * side), b = at(s + Math.min(len, u + 3.0), d * side);
          const y = terrain.height(a.x, a.z);
          push({ type: 'snowfence', x: a.x, y, z: a.z, rot: Math.atan2(b.x - a.x, b.z - a.z), scale: 1, variant: 0, d, len: Math.hypot(b.x - a.x, b.z - a.z) });
          claim(a.x, a.z, 1.2);
        }
        lastSF = s + len;
      }
    }
    // ploughed snow piles beside the walls (render + soft physics via the height field is not needed: they are off the road)
    if (sets.includes('snowpiles') && s - lastSP > rng.range(35, 80)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(2.5, 6);
      const { x, z } = at(s, d * side);
      if (okSpot(x, z, s, d * side, e2 + 1.5, 2)) {
        push({ type: 'snowpile', x, y: terrain.height(x, z), z, rot: rng.range(0, 6.28), scale: rng.range(0.8, 1.6), variant: 0, d });
        claim(x, z, 2.5);
        lastSP = s;
      }
    }
    // white houses with red tile roofs (coast villages), up on the high side
    if (sets.includes('houses') && inner && s - lastHouse > rng.range(28, 55)) {
      const hl = terrain.height(at(s, -(e2 + 12)).x, at(s, -(e2 + 12)).z), hr = terrain.height(at(s, e2 + 12).x, at(s, e2 + 12).z);
      const side = hr > hl ? 1 : -1, d = e2 + rng.range(9, 20);
      const { x, z, p } = at(s, d * side);
      const y = terrain.height(x, z);
      if (okSpot(x, z, s, d * side, e2 + 7, 5.5) && Math.abs(y - terrain.profAt(s)) < 9) {
        push({ type: 'house', x, y, z, rot: yawToRoad(p, side) + (rng.chance(0.3) ? Math.PI / 2 : 0) + rng.range(-0.1, 0.1), scale: rng.range(0.9, 1.2), variant: rng.int(0, 2), d });
        hard(x, y - 1, z, 3.6, 'cyl', 8);
        claim(x, z, 6);
        lastHouse = s;
      }
    }
    // low dry-stone walls along the road (hard)
    if (sets.includes('walls') && inner && s - lastWall > rng.range(25, 60)) {
      const side = rng.chance(0.5) ? 1 : -1, d = e2 + rng.range(1.6, 3.2), len = rng.range(18, 45);
      let ok = true;
      for (let u = 0; u <= len; u += 3) { const a = at(s + u, d * side); if (!okSpot(a.x, a.z, s + u, d * side, e2 + 1, 0.6) || nearTape(s + u, d * side, 1.2)) ok = false; }
      if (ok) {
        for (let u = 0; u < len; u += 2.5) {
          const a = at(s + u, d * side), b = at(s + Math.min(len, u + 2.5), d * side);
          const y = terrain.height(a.x, a.z);
          push({ type: 'wall', x: a.x, y, z: a.z, rot: Math.atan2(b.x - a.x, b.z - a.z), scale: 1, variant: 0, d, len: Math.hypot(b.x - a.x, b.z - a.z) });
          hard(a.x, y + 0.35, a.z, 0.55);
          claim(a.x, a.z, 1.0);
        }
        lastWall = s + len;
      }
    }
  }

  // media towers beside the jumps
  for (const j of jumps) {
    const side = rng.chance(0.5) ? 1 : -1, d = e2 + 11;
    const { x, z, p } = at(j + 22, d * side);
    if (inLake(x, z, 1.1) || roadD(x, z) < e2 + 8) continue;
    const y = terrain.height(x, z);
    push({ type: 'tower', x, y, z, rot: yawToRoad(p, side), scale: 1, variant: 0, d });
    hard(x, y - 1, z, 1.6, 'cyl', 8);
    claim(x, z, 3.5);
  }

  const betweenRoadAndLake = (x: number, z: number) => terrain.lakes.some((L) => {
    const dx = x - L.cx, dz = z - L.cz;
    const u = (dx * L.ux + dz * L.uz) / L.a, w = (-dx * L.uz + dz * L.ux) / L.b;
    const side = L.side === 'R' ? 1 : -1;
    return Math.abs(u) < 1.05 && w * side < -0.75 && w * side > -1.6;
  });

  // ---- trees, bushes, rocks, boulders, stumps, deadwood on a jittered world grid ----
  const cell = 3.2;
  const x0 = corridor.minX, z0 = corridor.minZ;
  const nx = Math.floor((corridor.nx * corridor.cell) / cell), nz = Math.floor((corridor.nz * corridor.cell) / cell);
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
    const hx = hash2(ix, iz, seed + 11), hz = hash2(ix, iz, seed + 12), hp = hash2(ix, iz, seed + 13);
    const x = x0 + (ix + hx) * cell, z = z0 + (iz + hz) * cell;
    const cd = corridor.at(x, z);
    if (cd > corridor.radius - 6) continue;
    const sNear = corridor.sAt(x, z);
    const zd = zones.dither(sNear < 0 ? 0 : sNear, hash2(ix, iz, seed + 20), 45);
    // groves and clearings
    const grove = clamp(0.55 + 0.9 * noise2(x / 140, z / 140, seed + 21), zd.trees >= 1.5 ? 0.85 : 0, 1.3);
    const dens = (cd < 60 ? v.nearDensity * zd.trees : v.farDensity * zd.treesFar * (1 - smoothstep(150, corridor.radius, cd) * 0.6)) * grove;
    const pTree = (dens * cell * cell) / 100;
    const pBush = cd < 45 ? (v.bushDensity * zd.bush * cell * cell) / 100 * (0.6 + 0.6 * grove) : 0;
    const pRock = (v.rockDensity * zd.rock * cell * cell) / 100 * (cd < 25 ? 2.2 : 1);
    const pBoulder = (zd.boulder * cell * cell) / 100 * (cd < 60 ? 1 : 0.5);
    const pStump = cd < 50 ? ((zd.cover.stump * 0.12) * cell * cell) / 100 : 0;
    const pDead = cd < 60 ? ((zd.cover.deadwood * 0.12) * cell * cell) / 100 : 0;
    let type: PropType | null = null;
    let acc = pTree;
    if (hp < acc) {
      // patchy mix: noise shifts the balance between the first and the other kinds so groves read as groves
      const ent = Object.entries(zd.mix).filter(([, w]) => (w ?? 0) > 0) as [TreeKind, number][];
      if (!ent.length) continue;
      const patch = noise2(x / 80, z / 80, seed + 33) * 0.35;
      const w = ent.map(([k, v], i) => v * (i === 0 ? 1 + patch : k === 'birch' || (i === 1 && !('birch' in zd.mix)) ? 1 - patch : 1));
      let r = hash2(ix, iz, seed + 14) * w.reduce((a, b) => a + b, 0), k = 0;
      for (; k < w.length - 1 && r > w[k]; k++) r -= w[k];
      type = ent[k][0];
    } else if (hp < (acc += pBush)) type = 'bush';
    else if (hp < (acc += pRock)) type = 'rock';
    else if (hp < (acc += pBoulder)) type = 'boulder';
    else if (hp < (acc += pStump)) type = 'stump';
    else if (hp < (acc += pDead)) type = 'deadwood';
    if (!type) continue;
    const isTree = TREE_TYPES.includes(type);
    let d = cd;
    if (cd < 34) {
      const q = terrain.nearest(x, z);
      d = q.found ? Math.abs(q.d) : cd;
      if (q.found && nearTape(q.s, q.d, type === 'rock' || type === 'boulder' ? 2.5 : 1.2)) continue;
      if (q.found && rails.length && nearRail(q.s, q.d, 1.5)) continue;
    }
    const treeLine = e2 + zd.treeLine + (type === 'spruce' || type === 'snowspruce' ? -0.6 : 0) + (type === 'acacia' || type === 'umbrella' ? 2.5 : 0);
    const minD = type === 'bush' ? e2 + 0.6 : type === 'rock' ? e2 + 0.3 : type === 'boulder' ? e2 + 3.5 : type === 'stump' ? e2 + 1.2 : type === 'deadwood' ? e2 + 3 : treeLine + hash2(ix, iz, seed + 16) * 2.5;
    if (d < minD) continue;
    if (inLake(x, z, type === 'rock' ? 0.95 : 1.08)) continue;
    if (terrain.fords.length && terrain.inFord(x, z, false) && type !== 'rock') continue;
    if (isTree && betweenRoadAndLake(x, z)) continue;
    if (inClear(x, z)) continue;
    if (isClaimed(x, z, isTree ? 1.5 : 0.8)) continue;
    // nothing grows on the sea-cliff face or under the sea
    if (terrain.coast && terrain.offshore(x, z)) continue;
    const y = terrain.height(x, z);
    const h17 = hash2(ix, iz, seed + 17);
    // size spread: a few old giants, many mid trees, young ones at the edges
    const big = Math.pow(h17, 1.6);
    const sc =
      isTree ? TREE_SIZE[type][0] + big * TREE_SIZE[type][1] :
      type === 'rock' ? (0.5 + Math.pow(h17, 2) * 1.6) * (d < 16 ? 0.6 : 1) :
      type === 'boulder' ? 1.6 + h17 * 2.2 :
      type === 'stump' ? 0.8 + h17 * 0.5 :
      type === 'deadwood' ? 0.8 + h17 * 0.6 :
      0.6 + h17 * 0.7;
    const variant = Math.floor(hash2(ix, iz, seed + 18) * 3);
    props.push({ type, x, y, z, rot: hash2(ix, iz, seed + 19) * Math.PI * 2, scale: sc, variant, d });
    if (d < 36) {
      if (isTree) obstacles.push({ kind: 'cyl', x, y: y - 1, z, r: TRUNK_R[type] * (0.7 + sc * 0.4), h: 12 });
      else if (type === 'rock' && sc > 0.7) obstacles.push({ kind: 'sphere', x, y: y + 0.05 * sc, z, r: 0.62 * sc, h: 0 });
      else if (type === 'boulder') obstacles.push({ kind: 'sphere', x, y: y + 0.2 * sc, z, r: 0.85 * sc, h: 0 });
      else if (type === 'stump') obstacles.push({ kind: 'cyl', x, y: y - 0.5, z, r: 0.3 * sc, h: 0.9 });
      else if (type === 'deadwood') {
        const c = Math.cos(props[props.length - 1].rot), sn = Math.sin(props[props.length - 1].rot);
        for (let k = -1; k <= 1; k++) obstacles.push({ kind: 'sphere', x: x + c * k * 1.6 * sc, y: y + 0.15, z: z - sn * k * 1.6 * sc, r: 0.3, h: 0 });
      }
    }
  }

  // cabins on the far bank of lakes
  for (const L of terrain.lakes) {
    for (let k = 0; k < 3; k++) {
      const ang = rng.range(-0.8, 0.8) + (k === 2 ? Math.PI : 0);
      const rr = 1.06 + rng.range(0.02, 0.08);
      const x = L.cx + (Math.cos(ang) * L.a * L.ux - Math.sin(ang) * L.b * L.uz) * rr * (k === 2 ? 0.4 : 1);
      const z = L.cz + (Math.cos(ang) * L.a * L.uz + Math.sin(ang) * L.b * L.ux) * rr * (k === 2 ? 0.4 : 1);
      const cd = corridor.at(x, z);
      if (cd < 30) continue;
      props.push({ type: 'cabin', x, y: terrain.height(x, z), z, rot: rng.range(0, Math.PI * 2), scale: rng.range(0.9, 1.15), variant: k === 1 ? 2 : 0, d: cd });
    }
  }

  // ---- markers ----
  const markers: Marker[] = [];
  markers.push({ kind: 'start', s: startS, text: '起点', side: 0 });
  markers.push({ kind: 'finish', s: finishS, text: '终点', side: 0 });
  markers.push({ kind: 'stop', s: Math.min(cl.length - 30, finishS + 140), text: 'STOP', side: 0 });
  for (let k = 1; (k * 1000) < finishS - startS - 150; k++) markers.push({ kind: 'km', s: startS + k * 1000, text: `${k} KM`, side: k % 2 ? 1 : -1 });
  for (const m of [300, 200, 100]) markers.push({ kind: 'board', s: finishS - m, text: String(m), side: 1 });

  return { props, obstacles, markers, tape, rails };
}

/** yaw (three.js convention, rotation about +Y of a local -Z forward / +Z front face) so a prop on `side` faces the road */
function yawToRoad(p: { rx: number; rz: number }, side: number) {
  // direction from the prop toward the road = -side * right
  const fx = -side * p.rx, fz = -side * p.rz;
  return Math.atan2(fx, fz);
}

/** yaw so a flat board on `side` runs parallel to the road with its front (+Z) toward the road */
function yawAlong(p: { rx: number; rz: number }, side: number) { return yawToRoad(p, side); }
