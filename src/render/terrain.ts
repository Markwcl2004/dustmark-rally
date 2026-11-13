// Terrain + road meshes built from the analytic height field:
//  - a road-aligned ribbon (road, crown, shoulders, ditches, banks) at fine lateral resolution,
//  - world-grid tiles (2/4/8 m) covering the corridor, sunk slightly under the ribbon, with skirts,
//  - grouped per 200 m of road so chunks frustum-cull,
//  - a coarse far-ground plane under everything to the horizon.
import * as THREE from 'three';
import { zoneDef } from '../data/envs';
import { noise2 } from '../sim/math/rng';
import { clamp, smoothstep } from '../sim/math/vec';
import { DS } from '../sim/stage/centerline';
import { CORRIDOR, type Stage } from '../sim/stage/stage';

export const CHUNK_LEN = 400;
const TILE = 64;

interface Acc { pos: number[]; nor: number[]; surf: number[]; tint: number[]; road: number[]; idx: number[] }
const newAcc = (): Acc => ({ pos: [], nor: [], surf: [], tint: [], road: [], idx: [] });

function accToGeometry(a: Acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor, 3));
  g.setAttribute('surf', new THREE.Float32BufferAttribute(a.surf, 4));
  g.setAttribute('tint', new THREE.Float32BufferAttribute(a.tint, 1));
  g.setAttribute('aRoad', new THREE.Float32BufferAttribute(a.road, 4));
  const n = a.pos.length / 3;
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(a.idx, 1) : new THREE.Uint16BufferAttribute(a.idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export interface TerrainBuild {
  group: THREE.Group;
  chunks: { s0: number; center: THREE.Vector3; radius: number; meshes: THREE.Mesh[] }[];
  far: THREE.Mesh;
  stats: { ribbonVerts: number; tileVerts: number; tiles: number; ms: number };
  /** ribbon half-widths per sample: [left, right] */
  ribbonW: Float32Array;
}

export function buildTerrain(stage: Stage, material: THREE.Material, seed: number): TerrainBuild {
  const t0 = performance.now();
  const tr = stage.terrain, cl = stage.cl;
  const hw = stage.def.halfWidth;
  const group = new THREE.Group();
  group.name = 'terrain';
  const nChunks = Math.ceil(cl.length / CHUNK_LEN);
  const accs: Acc[] = Array.from({ length: nChunks }, newAcc);
  const ribbonAccs: Acc[] = Array.from({ length: nChunks }, newAcc);

  // ---- per-metre ground mix from the scenery zones (blended over ±45 m), racing line and inner-corner cut ----
  const n0 = cl.n;
  const gForest = new Float32Array(n0), gDry = new Float32Array(n0), gDirt = new Float32Array(n0), gHeath = new Float32Array(n0), line = new Float32Array(n0), cutK = new Float32Array(n0);
  for (let i = 0; i < n0; i++) {
    const w = stage.zones.weights(i * DS);
    for (const id in w) { const zd = zoneDef(stage.env, id); gForest[i] += zd.ground.forest * w[id]; gDry[i] += zd.ground.dry * w[id]; gDirt[i] += zd.ground.dirt * w[id]; gHeath[i] += (zd.ground.heath ?? 0) * w[id]; }
  }
  {
    // racing line: toward the inside through corners (smoothed curvature), slow wander on straights
    const k = new Float32Array(n0);
    const R = 22;
    for (let i = 0; i < n0; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - R); j <= Math.min(n0 - 1, i + R); j += 2) { a += cl.kappa[j]; c++; } k[i] = a / c; }
    for (let i = 0; i < n0; i++) {
      line[i] = clamp(k[i] * 70, -1.15, 1.15) + noise2(i / 90, 0.5, seed + 77) * 0.35;
      cutK[i] = clamp((Math.abs(k[i]) - 1 / 90) * 45, 0, 1) * Math.sign(k[i]);
    }
  }
  const at = (arr: Float32Array, s: number) => arr[clamp(Math.round(s / DS), 0, n0 - 1)];
  /** surf = (road, shoulder, dirt, forest); returns dry-grass amount. s < 0 → no road nearby (use far defaults) */
  const altArr = tr.gravel ?? tr.ice;
  const surfAt = (x: number, z: number, a: number, out: number[], s = -1) => {
    const road = 1 - smoothstep(hw - 0.15, hw + 0.35, a);
    const alt = altArr && s >= 0 ? altArr[clamp(Math.round(s / DS), 0, n0 - 1)] : 0;
    const sh = (1 - road) * (1 - smoothstep(tr.edge1 + 0.3, tr.edge2 + 0.4, a));
    const zf = s >= 0 ? at(gForest, s) : 0.6, zdry = s >= 0 ? at(gDry, s) : 0.4, zdirt = s >= 0 ? at(gDirt, s) : 0;
    const forestN = noise2(x / 55, z / 55, seed + 3) * 0.6 + noise2(x / 13, z / 13, seed + 4) * 0.25;
    const forest = (1 - road - sh) * smoothstep(6, 18, a) * clamp(zf * 1.1 + forestN * 0.6 - 0.1, 0, 1);
    const dirtN = noise2(x / 21, z / 21, seed + 6);
    let dirt = (1 - road) * clamp(zdirt * (0.8 + dirtN * 0.9) * (1 - smoothstep(30, 60, a)), 0, 1);
    // river channels: bare sandy bed
    if (tr.fords.length && a > tr.edge1 && tr.inFord(x, z, false, 1.35)) dirt = 1;
    const heath = (1 - road) * (s >= 0 ? at(gHeath, s) : 0) * smoothstep(tr.edge1, tr.edge2 + 2, a);
    out.push(alt, heath, dirt, forest);
    const dry = clamp(zdry * 0.85 + noise2(x / 38, z / 38, seed + 5) * 0.45 + (1 - smoothstep(tr.edge2, tr.edge2 + 6, a)) * 0.2, 0, 1);
    return dry;
  };
  /** sea-cliff rock is flagged with a negative tint (the ground shader paints strata there) */
  const cliffTint = (x: number, z: number, dry: number) => (tr.cliff && tr.cliffE(x, z) > -0.4 ? -1 : dry);
  /** aRoad = (s, signed d, racing line, cut on this side) */
  // snow: the 4th channel carries the ploughed wall height instead (snow roads have no cut verges)
  const wallArr = stage.env.road.kind === 'snow' ? tr.wallH : null;
  const roadAttr = (s: number, d: number, acc: number[]) => {
    if (wallArr) { acc.push(s, d, at(line, s), wallArr[clamp(Math.round(s / DS), 0, n0 - 1)]); return; }
    const c = at(cutK, s);
    acc.push(s, d, at(line, s), c * d > 0 ? Math.abs(c) : 0);
  };

  // ---- ribbon ----
  const sideOffsets = [0, 0.8, 1.6, 2.4, hw, hw + 0.35, tr.edge1, tr.edge1 + (tr.edge2 - tr.edge1) * 0.25, (tr.edge1 + tr.edge2) / 2, tr.edge1 + (tr.edge2 - tr.edge1) * 0.75, tr.edge2, tr.edge2 + 1.6, 10, 12.5];
  const offs = [...sideOffsets.slice(1).reverse().map((d) => -d), ...sideOffsets];
  const cols = offs.length;
  // clearance to other parts of the road on each side (hairpin legs, close passes)
  const n = cl.n;
  const ribbonW = new Float32Array(n * 2).fill(12.5);
  {
    const step = 2;
    const cell = 30;
    const grid = new Map<number, number[]>();
    const key = (x: number, z: number) => (Math.floor(x / cell) + 4096) * 8192 + Math.floor(z / cell) + 4096;
    for (let i = 0; i < n; i += step) { const k = key(cl.x[i], cl.z[i]); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
    for (let i = 0; i < n; i++) {
      const th = cl.theta[i], rx = -Math.sin(th), rz = Math.cos(th);
      let wl = 12.5, wr = 12.5;
      // inner side of tight corners: never fold past ~0.85 R (use the tightest curvature nearby)
      let km = 0;
      for (let j = Math.max(0, i - 12); j <= Math.min(n - 1, i + 12); j++) if (Math.abs(cl.kappa[j]) > Math.abs(km)) km = cl.kappa[j];
      if (Math.abs(km) > 1e-4) { const lim = 0.85 / Math.abs(km); if (km > 0) wr = Math.min(wr, lim); else wl = Math.min(wl, lim); }
      const kx = Math.floor(cl.x[i] / cell), kz = Math.floor(cl.z[i] / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const arr = grid.get((kx + a + 4096) * 8192 + kz + b + 4096);
        if (!arr) continue;
        for (const j of arr) {
          if (Math.abs(j - i) < 50) continue;
          const dx = cl.x[j] - cl.x[i], dz = cl.z[j] - cl.z[i];
          const dist = Math.hypot(dx, dz);
          if (dist > 30) continue;
          const side = dx * rx + dz * rz;
          const lim = Math.max(tr.edge2 + 0.5, dist / 2 - 0.5);
          if (side > 0) wr = Math.min(wr, lim); else wl = Math.min(wl, lim);
        }
      }
      ribbonW[i * 2] = Math.max(hw + 0.4, wl); ribbonW[i * 2 + 1] = Math.max(hw + 0.4, wr);
    }
    // smooth widths so the ribbon edge has no saw teeth
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n - 1; i++) for (let k = 0; k < 2; k++) {
      ribbonW[i * 2 + k] = Math.min(ribbonW[i * 2 + k], (ribbonW[(i - 1) * 2 + k] + ribbonW[i * 2 + k] + ribbonW[(i + 1) * 2 + k]) / 3 + 0.4);
    }
  }
  const widthAt = (s: number, side: number) => ribbonW[clamp(Math.round(s / DS), 0, n - 1) * 2 + (side > 0 ? 1 : 0)];

  let ribbonVerts = 0;
  {
    // rows along s
    const rows: number[] = [];
    for (let s = 0; s < cl.length; ) {
      rows.push(s);
      const k = Math.abs(cl.kappa[Math.min(n - 1, Math.round(s / DS))]);
      s += k > 1 / 35 ? 0.75 : k > 1 / 90 ? 1.1 : 1.8;
    }
    rows.push(cl.length);
    const P = new Float32Array(rows.length * cols * 3);
    const SURF: number[] = [], TINT: number[] = [], ROAD: number[] = [];
    const tmp: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      const p = stage.pointAt(rows[r]);
      const wl = widthAt(rows[r], -1), wr = widthAt(rows[r], 1);
      for (let c = 0; c < cols; c++) {
        let d = offs[c];
        if (d < 0) d = Math.max(d, -wl); else d = Math.min(d, wr);
        const x = p.x + p.rx * d, z = p.z + p.rz * d;
        const y = stage.height(x, z);
        const o = (r * cols + c) * 3;
        P[o] = x; P[o + 1] = y; P[o + 2] = z;
        tmp.length = 0;
        const dry = surfAt(x, z, Math.abs(d), tmp, rows[r]);
        SURF.push(tmp[0], tmp[1], tmp[2], tmp[3]);
        TINT.push(cliffTint(x, z, dry));
        roadAttr(rows[r], d, ROAD);
      }
    }
    // normals from the structured grid
    const N = new Float32Array(P.length);
    const v = (r: number, c: number, k: number) => P[(r * cols + c) * 3 + k];
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < cols; c++) {
      const r0 = Math.max(0, r - 1), r1 = Math.min(rows.length - 1, r + 1), c0 = Math.max(0, c - 1), c1 = Math.min(cols - 1, c + 1);
      const ax = v(r1, c, 0) - v(r0, c, 0), ay = v(r1, c, 1) - v(r0, c, 1), az = v(r1, c, 2) - v(r0, c, 2);
      const bx = v(r, c1, 0) - v(r, c0, 0), by = v(r, c1, 1) - v(r, c0, 1), bz = v(r, c1, 2) - v(r, c0, 2);
      // normal = b × a (right × forward = up)
      let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
      const l = Math.hypot(nx, ny, nz);
      // columns clamped together (hairpin insides) give a zero-area cell: fall back to up
      if (l < 1e-6) { nx = 0; ny = 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; }
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const o = (r * cols + c) * 3;
      N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
    }
    // emit into chunk accumulators (rows shared at chunk borders)
    let chunk = -1, base = 0, acc: Acc | null = null, prevRow = -1;
    for (let r = 0; r < rows.length; r++) {
      const ci = Math.min(nChunks - 1, Math.floor(rows[r] / CHUNK_LEN));
      if (ci !== chunk) {
        // start new chunk, re-emitting previous row to stitch
        chunk = ci; acc = ribbonAccs[ci];
        base = acc.pos.length / 3;
        if (prevRow >= 0) emitRow(acc, prevRow);
      }
      emitRow(acc!, r);
      const rowsInAcc = (acc!.pos.length / 3 - base) / cols;
      if (rowsInAcc >= 2) {
        const a0 = base + (rowsInAcc - 2) * cols, a1 = base + (rowsInAcc - 1) * cols;
        for (let c = 0; c < cols - 1; c++) {
          // winding: counter-clockwise seen from above
          acc!.idx.push(a0 + c, a0 + c + 1, a1 + c, a0 + c + 1, a1 + c + 1, a1 + c);
        }
      }
      prevRow = r;
    }
    function emitRow(a: Acc, r: number) {
      for (let c = 0; c < cols; c++) {
        const o = (r * cols + c) * 3;
        a.pos.push(P[o], P[o + 1], P[o + 2]);
        a.nor.push(N[o], N[o + 1], N[o + 2]);
        const so = (r * cols + c) * 4;
        a.surf.push(SURF[so], SURF[so + 1], SURF[so + 2], SURF[so + 3]);
        a.tint.push(TINT[r * cols + c]);
        const ro = (r * cols + c) * 4;
        a.road.push(ROAD[ro], ROAD[ro + 1], ROAD[ro + 2], ROAD[ro + 3]);
        ribbonVerts++;
      }
    }
  }

  // ---- world tiles ----
  const cor = stage.corridor;
  const coarse: number[] = [];
  for (let i = 0; i < n; i += 8) coarse.push(i);
  const nearestS = (x: number, z: number) => {
    let b = 0, bd = Infinity;
    for (const i of coarse) { const d = (cl.x[i] - x) ** 2 + (cl.z[i] - z) ** 2; if (d < bd) { bd = d; b = i; } }
    return b * DS;
  };
  const tx0 = Math.floor(cor.minX / TILE), tz0 = Math.floor(cor.minZ / TILE);
  const tx1 = Math.ceil((cor.minX + cor.nx * cor.cell) / TILE), tz1 = Math.ceil((cor.minZ + cor.nz * cor.cell) / TILE);
  let tiles = 0, tileVerts = 0;
  const tmp: number[] = [];
  for (let ti = tx0; ti < tx1; ti++) for (let tj = tz0; tj < tz1; tj++) {
    const x0 = ti * TILE, z0 = tj * TILE;
    let dmin = Infinity;
    for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) dmin = Math.min(dmin, cor.at(x0 + (a * TILE) / 4, z0 + (b * TILE) / 4));
    if (dmin > CORRIDOR + 10) continue;
    let res = dmin < 45 ? 4 : dmin < 120 ? 8 : 16;
    // sea cliffs: finer tiles where the shoreline passes (the ledges need ~2 m)
    if (tr.cliff && dmin < 150) {
      let near = false;
      for (let a = 0; a <= 4 && !near; a++) for (let b = 0; b <= 4; b++) { const e = tr.cliffE(x0 + (a * TILE) / 4, z0 + (b * TILE) / 4); if (e > -30 && e < 90) { near = true; break; } }
      if (near) res = dmin < 90 ? 2 : 4;
    }
    const N1 = Math.round(TILE / res) + 1;
    const ci = Math.min(nChunks - 1, Math.floor(nearestS(x0 + TILE / 2, z0 + TILE / 2) / CHUNK_LEN));
    const acc = accs[ci];
    tiles++;
    // heights with a 1-vertex border for normals
    const G = N1 + 2;
    const H = new Float32Array(G * G);
    const D = new Float32Array(G * G);
    const S = new Float32Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const x = x0 + (i - 1) * res, z = z0 + (j - 1) * res;
      H[j * G + i] = stage.height(x, z);
      const q = tr.last;
      D[j * G + i] = q.found ? q.d : 1e9;
      S[j * G + i] = q.found ? q.s : -1;
    }
    const base = acc.pos.length / 3;
    for (let j = 1; j <= N1; j++) for (let i = 1; i <= N1; i++) {
      const x = x0 + (i - 1) * res, z = z0 + (j - 1) * res;
      const k = j * G + i;
      let y = H[k];
      const d = D[k], a = Math.abs(d);
      // under the ribbon: sink so the ribbon always wins (only well inside its edge)
      if (a < 1e8) {
        const w = widthAt(S[k], d >= 0 ? 1 : -1);
        if (a < w - 2.6) y -= 0.9;
      }
      const nx = H[k - 1] - H[k + 1], nz = H[k - G] - H[k + G], ny = 2 * res;
      const l = Math.hypot(nx, ny, nz);
      acc.pos.push(x, y, z); acc.nor.push(nx / l, ny / l, nz / l);
      tmp.length = 0;
      const sNear = a < 1e8 ? S[k] : cor.sAt(x, z);
      const dry = surfAt(x, z, a < 1e8 ? a : 100, tmp, sNear);
      acc.surf.push(tmp[0], tmp[1], tmp[2], tmp[3]); acc.tint.push(cliffTint(x, z, dry));
      if (a < 1e8) roadAttr(S[k], d, acc.road); else acc.road.push(Math.max(0, sNear), 99, 0, 0);
      tileVerts++;
    }
    for (let j = 0; j < N1 - 1; j++) for (let i = 0; i < N1 - 1; i++) {
      const a = base + j * N1 + i, b = a + 1, c = a + N1, d = c + 1;
      acc.idx.push(a, c, b, b, c, d);
    }
    // skirts on the four edges
    const edge = (idxs: number[]) => {
      const sb = acc.pos.length / 3;
      for (const vi of idxs) {
        const o = vi * 3;
        acc.pos.push(acc.pos[o], acc.pos[o + 1] - 2.5, acc.pos[o + 2]);
        acc.nor.push(acc.nor[o], acc.nor[o + 1], acc.nor[o + 2]);
        acc.surf.push(acc.surf[vi * 4], acc.surf[vi * 4 + 1], acc.surf[vi * 4 + 2], acc.surf[vi * 4 + 3]);
        acc.tint.push(acc.tint[vi]);
        acc.road.push(acc.road[vi * 4], acc.road[vi * 4 + 1], acc.road[vi * 4 + 2], acc.road[vi * 4 + 3]);
      }
      for (let k = 0; k < idxs.length - 1; k++) {
        const a = idxs[k], b = idxs[k + 1], c = sb + k, d = sb + k + 1;
        // both windings: cracks can be seen from either side
        acc.idx.push(a, b, c, b, d, c, a, c, b, b, c, d);
      }
    };
    const row = (j: number) => Array.from({ length: N1 }, (_, i) => base + j * N1 + i);
    const col = (i: number) => Array.from({ length: N1 }, (_, j) => base + j * N1 + i);
    edge(row(0)); edge(row(N1 - 1)); edge(col(0)); edge(col(N1 - 1));
  }

  // ---- meshes per chunk ----
  const chunks: TerrainBuild['chunks'] = [];
  for (let c = 0; c < nChunks; c++) {
    const meshes: THREE.Mesh[] = [];
    if (accs[c].idx.length) {
      const m = new THREE.Mesh(accToGeometry(accs[c]), material);
      m.receiveShadow = true; m.name = `tiles-${c}`;
      meshes.push(m);
    }
    if (ribbonAccs[c].idx.length) {
      const rm = (material as THREE.Material & { _ribbon?: THREE.Material });
      const m = new THREE.Mesh(accToGeometry(ribbonAccs[c]), ribbonMaterial(rm));
      m.receiveShadow = true; m.name = `ribbon-${c}`;
      m.renderOrder = -1; // before the tiles: the sunk tiles under it then fail early-z instead of being shaded twice
      meshes.push(m);
    }
    const bs = new THREE.Sphere();
    const box = new THREE.Box3();
    for (const m of meshes) box.union(m.geometry.boundingBox!);
    box.getBoundingSphere(bs);
    for (const m of meshes) group.add(m);
    chunks.push({ s0: c * CHUNK_LEN, center: bs.center, radius: bs.radius, meshes });
  }

  // ---- far ground ----
  const far = buildFarGround(stage, material, seed, surfAt);
  group.add(far);
  return { group, chunks, far, stats: { ribbonVerts, tileVerts, tiles, ms: performance.now() - t0 }, ribbonW };
}

/** same ground shader, pulled toward the camera in depth so it wins where it overlaps the sunk tiles */
function ribbonMaterial(base: THREE.Material & { _ribbon?: THREE.Material }) {
  if (!base._ribbon) {
    const m = base.clone() as THREE.MeshLambertMaterial;
    m.onBeforeCompile = base.onBeforeCompile;
    m.customProgramCacheKey = base.customProgramCacheKey;
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
    base._ribbon = m;
  }
  return base._ribbon;
}

function buildFarGround(stage: Stage, material: THREE.Material, seed: number, surfAt: (x: number, z: number, a: number, out: number[], s?: number) => number) {
  const cor = stage.corridor;
  const cx = cor.minX + (cor.nx * cor.cell) / 2, cz = cor.minZ + (cor.nz * cor.cell) / 2;
  const size = Math.max(cor.nx, cor.nz) * cor.cell + 7000;
  const res = 56;
  const N1 = Math.ceil(size / res) + 1;
  const acc = newAcc();
  const tmp: number[] = [];
  const x0 = cx - size / 2, z0 = cz - size / 2;
  for (let j = 0; j < N1; j++) for (let i = 0; i < N1; i++) {
    const x = x0 + i * res, z = z0 + j * res;
    const d = cor.at(x, z);
    let y = stage.terrain.base(x, z) - 3.5;
    if (d < CORRIDOR) y -= 4;
    // flatten very far out into a gentle plain under the mountains
    const r = Math.hypot(x - cx, z - cz);
    let flatY = -10;
    const cst = stage.terrain.coast;
    if (cst) {
      // coast: far out the land side becomes a high plateau, the sea side sinks under the sea
      const u = ((x - cst.cx) * cst.nx + (z - cst.cz) * cst.nz) / cst.width;
      flatY = u > 0 ? cst.seaLevel - 40 : cst.amp * 0.6;
      if (u > 0.8) y = Math.min(y, cst.seaLevel - 2 - (u - 0.8) * 30);
    }
    y = y * (1 - smoothstep(size * 0.3, size * 0.48, r)) + smoothstep(size * 0.3, size * 0.48, r) * flatY;
    if (stage.terrain.cliff) y = stage.terrain.cliffCarve(x, z, y);
    acc.pos.push(x, y, z);
    acc.nor.push(0, 1, 0);
    tmp.length = 0;
    const sN = cor.sAt(x, z);
    const dry = surfAt(x, z, 100, tmp, sN);
    acc.surf.push(0, tmp[1], tmp[2] * 0.5, Math.max(0.5, tmp[3])); acc.tint.push(stage.terrain.cliff && stage.terrain.cliffE(x, z) > 0 ? -1 : dry);
    acc.road.push(Math.max(0, sN), 99, 0, 0);
  }
  // normals
  for (let j = 0; j < N1; j++) for (let i = 0; i < N1; i++) {
    const h = (a: number, b: number) => acc.pos[(clamp(b, 0, N1 - 1) * N1 + clamp(a, 0, N1 - 1)) * 3 + 1];
    const nx = h(i - 1, j) - h(i + 1, j), nz = h(i, j - 1) - h(i, j + 1), ny = 2 * res;
    const l = Math.hypot(nx, ny, nz), o = (j * N1 + i) * 3;
    acc.nor[o] = nx / l; acc.nor[o + 1] = ny / l; acc.nor[o + 2] = nz / l;
  }
  for (let j = 0; j < N1 - 1; j++) for (let i = 0; i < N1 - 1; i++) {
    const a = j * N1 + i, b = a + 1, c = a + N1, d = c + 1;
    acc.idx.push(a, c, b, b, c, d);
  }
  const m = new THREE.Mesh(accToGeometry(acc), material);
  m.receiveShadow = false; m.name = 'far-ground';
  return m;
}
