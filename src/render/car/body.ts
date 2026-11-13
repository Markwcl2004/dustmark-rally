// Body shell: lower-body loft (cross-sections at stations along z, creases as patch borders), nose/tail chamfers and
// caps, wheel wells, the greenhouse (side panels with windows on a skewed grid + windscreen/roof/rear-glass surface),
// glass (separate builder), and the interior seen through the glass (deck, seats, drivers, roll cage).
import * as THREE from 'three';
import { col, mix, MeshBuilder, type Surf, type V2, type V3 } from './builder';
import { RING, type Shape } from './shape';

export interface BodyColors { body: Surf; frame: Surf; dark: Surf; under: Surf; trim: Surf; interior: Surf; glass: Surf; cage: Surf; helmets: [THREE.Color, THREE.Color] }

export function buildBody(S: Shape, out: MeshBuilder, glass: MeshBuilder, C: BodyColors, lod: number) {
  const b = S.vis.body;
  const step = lod ? 0.2 : 0.075;

  // ---------- stations ----------
  interface St { z: number; yl: number; shrink: number; brk?: boolean; arch?: boolean }
  const st: St[] = [];
  const arches = [S.zF, S.zR];
  const inArch = (z: number) => arches.some((wz) => Math.abs(z - wz) < S.Rw);
  const ch = lod ? 0 : Math.min(0.05, b.roundF * 0.15 + 0.012), chR = lod ? 0 : Math.min(0.05, b.roundR * 0.15 + 0.012);
  const pushRange = (z0: number, z1: number) => {
    const n = Math.max(1, Math.ceil((z1 - z0) / step));
    for (let i = 1; i < n; i++) { const z = z0 + ((z1 - z0) * i) / n; st.push({ z, yl: b.belly, shrink: 0 }); }
  };
  // nose chamfer + dense rounding zone
  st.push({ z: S.zN, yl: b.belly, shrink: ch, brk: true });
  st.push({ z: S.zN + ch, yl: b.belly, shrink: 0, brk: true });
  const keyZ = [S.zN + ch];
  if (!lod) for (let k = 1; k <= 4; k++) keyZ.push(S.zN + ch + (b.roundF * k) / 4);
  for (const wz of arches) keyZ.push(wz - S.Rw, wz + S.Rw);
  if (!lod) for (let k = 4; k >= 1; k--) keyZ.push(S.zT - chR - (b.roundR * k) / 4);
  keyZ.push(S.zWs, S.zRb, S.zT - chR);
  keyZ.sort((a, b2) => a - b2);
  const keys = keyZ.filter((z, i) => z >= S.zN + ch - 1e-6 && z <= S.zT - chR + 1e-6 && (i === 0 || z - keyZ[i - 1] > 0.01) && !inArch(z));
  let prev = S.zN + ch;
  const sortedEvents: { z: number; kind: 'key' | 'arch'; wz?: number }[] = [
    ...keys.map((z) => ({ z, kind: 'key' as const })),
    ...arches.map((wz) => ({ z: wz - S.Rw, kind: 'arch' as const, wz })),
  ].sort((a, c) => a.z - c.z);
  for (const ev of sortedEvents) {
    if (ev.z <= prev + 1e-6 && ev.kind === 'key') continue;
    pushRange(prev, ev.z);
    if (ev.kind === 'key') { st.push({ z: ev.z, yl: b.belly, shrink: 0 }); prev = ev.z; continue; }
    // wheel arch: wall (out→in), arch stations, wall (in→out)
    const wz = ev.wz!, z0 = wz - S.Rw, z1 = wz + S.Rw;
    const ai = arches.indexOf(wz);
    st.push({ z: z0, yl: b.belly, shrink: 0, brk: true });
    const n = lod ? 6 : 18;
    for (let k = 0; k <= n; k++) {
      let dz: number;
      if (S.vis.parts.arch.shape === 'round') dz = -Math.cos((Math.PI * k) / n) * S.Rw * 0.9999;
      else dz = (-1 + (2 * k) / n) * S.Rw * 0.9999;
      st.push({ z: wz + dz, yl: S.archY(ai, dz), shrink: 0, arch: true, brk: k === 0 || k === n });
    }
    st.push({ z: z1, yl: b.belly, shrink: 0, brk: true });
    prev = z1;
  }
  pushRange(prev, S.zT - chR);
  if (st[st.length - 1].z < S.zT - chR - 1e-6) st.push({ z: S.zT - chR, yl: b.belly, shrink: 0 });
  st[st.length - 1].brk = true;
  st.push({ z: S.zT, yl: b.belly, shrink: chR, brk: true });

  const rings = st.map((s) => S.ring(s.z, s.yl, s.shrink));
  const half0 = out.count, glass0 = glass.count;

  // ---------- lower-body loft ----------
  // row groups that are smoothed together; a border between groups is a hard crease
  const soft = b.soft;
  const rowGroups: number[][] = [[0], [1], [2], [3]];
  if (soft < 0.33) rowGroups.push([4], [5], [6, 7, 8]);
  else if (soft < 0.66) rowGroups.push([4], [5, 6, 7, 8]);
  else rowGroups.push([4, 5], [6, 7, 8]);
  // column runs: split at every break station; a run between an out/in pair at the same z is a well wall
  const runs: [number, number][] = [];
  let r0 = 0;
  for (let j = 1; j < st.length; j++) if (st[j].brk || j === st.length - 1) { if (j > r0) runs.push([r0, j]); r0 = j; }
  const cabin = (z: number) => z > S.zWs && z < S.zRb;
  for (const [j0, j1] of runs) {
    const wall = j1 - j0 === 1 && Math.abs(st[j0].z - st[j1].z) < 1e-4;
    const archRun = st[j0 + 1]?.arch && st[j1].arch;
    for (const rows of rowGroups) {
      const i0 = rows[0], i1 = rows[rows.length - 1] + 1;
      const P: V3[][] = [];
      for (let i = i0; i <= i1; i++) { const row: V3[] = []; for (let j = j0; j <= j1; j++) row.push([rings[j][i][0], rings[j][i][1], st[j].z]); P.push(row); }
      out.grid(P, (ii, jj) => {
        const i = i0 + ii, zc = (st[j0 + jj].z + st[j0 + jj + 1].z) / 2;
        if (wall) return C.dark;
        if (archRun && i <= 2) return C.dark;
        if (i <= 1) return C.under;
        if (i === 2) return C.trim;
        if (i >= 7 && cabin(zc)) return C.interior;
        return C.body;
      });
    }
  }
  // end caps (flat fascia / tail panel)
  const cap = (j: number, nz: number) => {
    const rr = rings[j], z = st[j].z;
    const pts: V3[] = [];
    for (let i = 0; i < rr.length; i++) pts.push([rr[i][0], rr[i][1], z]);
    for (let i = rr.length - 2; i >= 1; i--) pts.push([-rr[i][0], rr[i][1], z]);
    // orientation: polygon normal must point along nz
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], c = pts[(i + 1) % pts.length]; s += (a[0] - c[0]) * (a[1] + c[1]); }
    if (Math.sign(s) !== Math.sign(nz)) pts.reverse();
    out.poly(pts, C.body);
  };
  // ---------- greenhouse ----------
  buildGreenhouse(S, out, glass, C, lod);
  out.mirror(half0);
  glass.mirror(glass0);
  // caps, interior: full width, added after mirroring the half shell
  cap(0, -1);
  cap(st.length - 1, 1);
  if (!lod) buildInterior(S, out, C);
}

// The greenhouse surfaces are sampled on a shared column set so the side panel, windscreen/roof and glass meet exactly.
function buildGreenhouse(S: Shape, out: MeshBuilder, glass: MeshBuilder, C: BodyColors, lod: number) {
  const b = S.vis.body;
  const zWs = S.zWs, zRb = S.zRb;
  // key columns [z at base (t=0), z at roof edge (t=1)]; null base = interpolate
  const aFront = zWs + Math.min(0.14, (S.zRf - zWs) * 0.2);
  const bw = b.bWidth;
  const keys: { b: number | null; t: number; tag?: string }[] = [
    { b: zWs, t: zWs, tag: 'start' },
    { b: null, t: zWs + 0.04, tag: 'wsG0' },
    { b: aFront, t: aFront, tag: 'A' },
    { b: null, t: S.zRf - 0.05, tag: 'wsG1' },
    { b: null, t: S.zRf, tag: 'roofF' },
    { b: S.zB - bw / 2, t: S.zB - bw / 2 + 0.02, tag: 'B0' },
    { b: S.zB + bw / 2, t: S.zB + bw / 2 + 0.02, tag: 'B1' },
    { b: S.zC0, t: S.zC1, tag: 'C' },
    { b: null, t: S.zRr, tag: 'roofR' },
    { b: null, t: S.zRr + 0.05, tag: 'rgG0' },
    { b: null, t: zRb - 0.035, tag: 'rgG1' },
    { b: zRb, t: zRb, tag: 'end' },
  ];
  keys.sort((a, c) => a.t - c.t);
  // drop keys that collide
  const K = keys.filter((k, i) => i === 0 || k.t - keys[i - 1].t > 0.012);
  for (let i = 0; i < K.length; i++) if (K[i].b === null) {
    let a = i - 1; while (K[a].b === null) a--;
    let c = i + 1; while (K[c].b === null) c++;
    const f = (K[i].t - K[a].t) / (K[c].t - K[a].t);
    K[i].b = K[a].b! + (K[c].b! - K[a].b!) * f;
  }
  // enforce monotonic bases
  for (let i = 1; i < K.length; i++) if (K[i].b! < K[i - 1].b! + 0.005) K[i].b = K[i - 1].b! + 0.005;
  // subdivide into columns
  const cols: { b: number; t: number; key?: string }[] = [];
  const dz = lod ? 0.25 : 0.07;
  for (let i = 0; i < K.length; i++) {
    cols.push({ b: K[i].b!, t: K[i].t, key: K[i].tag });
    if (i === K.length - 1) break;
    const n = Math.max(1, Math.ceil(Math.max(K[i + 1].t - K[i].t, K[i + 1].b! - K[i].b!) / dz));
    for (let k = 1; k < n; k++) cols.push({ b: mix(K[i].b!, K[i + 1].b!, k / n), t: mix(K[i].t, K[i + 1].t, k / n) });
  }
  const idx = (tag: string) => cols.findIndex((c) => c.key === tag);
  const iA = idx('A'), iB0 = idx('B0'), iB1 = idx('B1'), iC = idx('C'), iRf = idx('roofF'), iRr = idx('roofR');
  const iW0 = idx('wsG0'), iW1 = idx('wsG1'), iG0 = idx('rgG0'), iG1 = idx('rgG1');
  // ---- side panel: rows t = 0, tLow, tHigh, 1 ----
  const T = [0, 0.07, 0.88, 1];
  const side = (c: { b: number; t: number }, t: number): V3 => {
    const z = mix(c.b, c.t, t);
    const p0 = S.ghBase(z), p1 = S.ghEdge(z);
    return [mix(p0[0], p1[0], t), mix(p0[1], p1[1], t), z];
  };
  const P: V3[][] = T.map((t) => cols.map((c) => side(c, t)));
  const window = (j: number) => (iA >= 0 && iB0 >= 0 && j >= iA && j < iB0) || (iB1 >= 0 && iC >= 0 && j >= iB1 && j < iC);
  const pillarSurf = b.pillars === 'black' ? C.frame : C.body;
  out.grid(P, (i, j) => {
    if (i === 1 && window(j)) return C.glass;
    if (i === 0) return C.body;
    if (i === 2) return C.frame;
    if (j >= iB0 && j < iB1) return C.frame;
    if (j < iA) return C.frame;
    if (j >= iC) return C.body;
    return pillarSurf;
  }, { to: (i, j) => (i === 1 && window(j) ? glass : out) });
  // ---- top surface (windscreen / roof / rear glass), three patches split at the roof creases ----
  const tops = cols.map((c) => S.roofSection(c.t));
  const segs: [number, number][] = [[0, iRf], [iRf, iRr], [iRr, cols.length - 1]];
  const wsGlass = (j: number) => j >= iW0 && j < iW1;
  const rgGlass = (j: number) => j >= iG0 && j < iG1;
  for (const [j0, j1] of segs) {
    if (j0 < 0 || j1 <= j0) continue;
    for (const [r0, r1] of [[0, 1], [1, 3]] as const) {
      const Q: V3[][] = [];
      // profile runs from the roof edge inward (CCW seen from +z on the right half)
      for (let i = r0; i <= r1; i++) { const row: V3[] = []; for (let j = j0; j <= j1; j++) row.push([tops[j][i][0], tops[j][i][1], cols[j].t]); Q.push(row); }
      const isGlass = (i: number, j: number) => r0 === 1 && (wsGlass(j0 + j) || rgGlass(j0 + j));
      out.grid(Q, (i, j) => {
        const jj = j0 + j;
        if (isGlass(i, j)) return C.glass;
        if (jj < iRf) return C.frame; // A-pillar trim, cowl, header
        if (jj >= iRr) return r0 === 0 ? C.body : C.frame;
        return C.body;
      }, { to: (i, j) => (isGlass(i, j) ? glass : out) });
    }
  }
}

function buildInterior(S: Shape, out: MeshBuilder, C: BodyColors) {
  const b = S.vis.body;
  const m = new THREE.Matrix4();
  const belt = b.belt;
  const headZ = Math.max(S.zWs + 0.4, Math.min(S.zB - 0.1, S.zRf + 0.05));
  const headY = belt + Math.min(0.2, (b.roofH - belt) * 0.42);
  const seatZ = headZ + 0.1;
  const suit = col('#2a2d33');
  const helmet = (x: number, c: THREE.Color) => {
    // helmet shell + a slightly larger partial sphere as the visor band (faces -z, eye height)
    m.makeTranslation(x, headY, headZ);
    out.geo(new THREE.SphereGeometry(0.125, 12, 8), m, { c });
    out.geo(new THREE.SphereGeometry(0.129, 8, 3, Math.PI * 1.5 - 0.6, 1.2, Math.PI / 2 - 0.3, 0.58), m, { c: col('#15181c') });
    // shoulders / torso
    const t = new THREE.BoxGeometry(0.36, 0.22, 0.22);
    m.makeTranslation(x, headY - 0.22, headZ + 0.04);
    out.geo(t, m, { c: suit });
    // seat back with a head wing
    const s = new THREE.BoxGeometry(0.42, 0.5, 0.07);
    m.makeRotationX(0.18).premultiply(new THREE.Matrix4().makeTranslation(x, headY - 0.16, seatZ + 0.06));
    out.geo(s, m, { c: col('#1b1c20') });
  };
  helmet(-0.34, C.helmets[0]);
  helmet(0.34, C.helmets[1]);
  // roll cage: main hoop at the B pillar, A-pillar bars, roof bars, diagonal, rear stays
  const tube = (a: V3, c: V3) => {
    const d = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const L = d.length();
    const g = new THREE.CylinderGeometry(0.018, 0.018, L, 5, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    m.compose(new THREE.Vector3((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2), q, new THREE.Vector3(1, 1, 1));
    out.geo(g, m, C.cage);
  };
  const inset = 0.06;
  const at = (z: number, t: number): V3 => {
    const p0 = S.ghBase(z), p1 = S.ghEdge(z);
    return [mix(p0[0], p1[0], t) - inset - 0.03 * t, mix(p0[1], p1[1], t) - 0.04 * t, z];
  };
  const zh = S.zB + 0.02;
  const lowY = belt - 0.05;
  for (const sx of [1, -1]) {
    const top = at(zh, 1), bot = at(zh, 0);
    tube([sx * bot[0], lowY, zh], [sx * top[0], top[1], zh]);
    const aTop = at(S.zRf - 0.02, 1), aBot = at(S.zWs + 0.12, 0.2);
    tube([sx * aBot[0], aBot[1], aBot[2]], [sx * aTop[0], aTop[1], aTop[2]]);
    tube([sx * aTop[0], aTop[1], aTop[2]], [sx * top[0], top[1], zh]);
    const rTop = at(Math.min(S.zRr - 0.02, zh + 0.6), 0.9);
    tube([sx * top[0], top[1], zh], [sx * rTop[0] * 0.9, belt + 0.02, Math.min(S.zRb - 0.1, zh + 0.75)]);
  }
  const top = at(zh, 1);
  tube([-top[0], top[1], zh], [top[0], top[1], zh]);
  tube([-top[0], top[1], zh], [top[0], lowY, zh]);
  const aTop = at(S.zRf - 0.02, 1);
  tube([-aTop[0], aTop[1], aTop[2]], [aTop[0], aTop[1], aTop[2]]);
}
