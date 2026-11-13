// Separate body parts: bumpers, wheel-arch flares, lights + grille, mirrors, wing, roof scoop, antenna, exhaust,
// tow hooks, mudflaps, glass strips (sun strip / driver names) and the 4-lamp night pod (own builder → own mesh).
import * as THREE from 'three';
import type { LiveryDef } from '../../data/carVisuals';
import { clamp, col, mix, MeshBuilder, type Surf, type V2, type V3 } from './builder';
import { frac, REG } from './layout';
import type { Shape } from './shape';

export const GLOW = { tail: 1, head: 2, pod: 3 } as const;

export interface PartSurfs { body: Surf; trim: Surf; dark: Surf; chrome: Surf; base: Surf; frame: Surf }

const M4 = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

function polyFacing(out: MeshBuilder, pts: V3[], dir: V3, s: Surf) {
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], c = pts[(i + 1) % pts.length];
    n = [n[0] + (a[1] - c[1]) * (a[2] + c[2]), n[1] + (a[2] - c[2]) * (a[0] + c[0]), n[2] + (a[0] - c[0]) * (a[1] + c[1])];
  }
  if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0) pts = [...pts].reverse();
  out.poly(pts, s);
}


/** where the lamps sit on the fascia / rear panel (used by parts and the livery painter) */
export function lampLayout(S: Shape) {
  const b = S.vis.body, p = S.vis.parts;
  const chF = Math.min(0.05, b.roundF * 0.15 + 0.012), chR = Math.min(0.05, b.roundR * 0.15 + 0.012);
  const yFt = S.H(S.zN) - chF * 0.8;
  const fasciaW = S.plan(S.zN) - chF;
  const headH = clamp(yFt - p.bumper.topF - 0.05, 0.07, 0.15);
  const yHead = p.bumper.style === 'chrome' ? (yFt + p.bumper.topF) / 2 + 0.01 : Math.max(p.bumper.topF + headH / 2 + 0.025, yFt - headH / 2 - 0.035);
  const xHead = fasciaW - 0.2;
  const yTt = S.H(S.zT) - chR * 0.8;
  const tailW = S.plan(S.zT) - chR;
  const xT = tailW - 0.2;
  const yTail = Math.max(p.bumper.topR + 0.1, yTt - 0.1);
  return { chF, chR, yFt, fasciaW, headH, yHead, xHead, yTt, tailW, xT, yTail };
}

export function buildParts(S: Shape, out: MeshBuilder, pod: MeshBuilder, L: LiveryDef, P: PartSurfs, lod: number) {
  const v = S.vis, b = v.body, p = v.parts;
  const lens = (hex: string, glow: number): Surf => ({ c: col(hex), glow });
  const box = (w: number, h: number, d: number, m: THREE.Matrix4, s: Surf, to = out) => to.geo(new THREE.BoxGeometry(w, h, d), m, s);
  const cyl = (r: number, d: number, seg: number, m: THREE.Matrix4, s: Surf, to = out) => to.geo(new THREE.CylinderGeometry(r, r, d, seg).rotateX(Math.PI / 2), m, s);
  const disc = (r: number, seg: number, m: THREE.Matrix4, s: Surf, to = out) => to.geo(new THREE.CircleGeometry(r, seg), m, s);
  const seg = lod ? 8 : 16;

  // ---------------- bumpers ----------------
  const bumper = (front: boolean) => {
    const zEnd = front ? S.zN : S.zT;
    const arch = front ? S.zF - S.Rw - 0.03 : S.zR + S.Rw + 0.03;
    const round = front ? b.roundF : b.roundR;
    const wrap = Math.max(0.04, Math.min(round + 0.08, Math.abs(arch - zEnd)));
    const K = lod ? 3 : 7;
    const half: V2[] = [];
    for (let k = 0; k <= K; k++) {
      const t = k / K;
      const z = front ? zEnd + wrap * (1 - t) : zEnd - wrap * (1 - t);
      half.push([S.plan(z), z]);
    }
    const xw = S.plan(zEnd);
    const nAcross = lod ? 2 : 6;
    for (let k = 1; k <= nAcross; k++) half.push([xw * (1 - k / nAcross), zEnd]);
    // full outline: left end → centre → right end (front); right end → centre → left end (rear)
    let line: V2[] = [...half.map(([x, z]): V2 => [-x, z]), ...half.slice(0, -1).reverse()];
    if (!front) line = line.map(([x, z]): V2 => [-x, z]);
    const N = line.map((_, j) => {
      const a = line[Math.max(0, j - 1)], c = line[Math.min(line.length - 1, j + 1)];
      const tx = c[0] - a[0], tz = c[1] - a[1], l = Math.hypot(tx, tz) || 1;
      return [tz / l, -tx / l] as V2;
    });
    const depth = p.bumper.depth;
    const top = front ? p.bumper.topF : p.bumper.topR;
    const chrome = p.bumper.style === 'chrome';
    const yb = chrome ? top - 0.11 : b.belly + 0.012;
    const prof: [number, number][] = chrome
      ? [[yb, 0.07], [yb + 0.018, 0.01], [top - 0.02, 0], [top, 0.025], [top, 0.09]]
      : [[yb, depth * 0.7], [yb + 0.04, 0.02], [top - 0.045, 0], [top, 0.035], [top, depth + 0.05]];
    const G: V3[][] = prof.map(([y, back]) => line.map(([x, z], j) => {
      const n = N[j];
      const out0 = depth * 0.7 * Math.abs(n[1]) + 0.018 * (1 - Math.abs(n[1]));
      const d = out0 - back * (chrome ? 1 : mix(0.4, 1, Math.abs(n[1])));
      return [x + n[0] * d, y, z + n[1] * d];
    }));
    const s = p.bumper.style === 'body' ? P.body : chrome ? P.chrome : P.trim;
    out.grid(G, (i) => (i === 0 && !chrome ? P.trim : s));
    // end caps
    for (const j of [0, line.length - 1]) {
      const ring = prof.map((_, i) => G[i][j]);
      const jn = j === 0 ? 1 : line.length - 2;
      const d: V3 = [G[2][j][0] - G[2][jn][0], 0, G[2][j][2] - G[2][jn][2]];
      polyFacing(out, ring, d, s);
    }
    return { line, top, yb };
  };
  const bf = bumper(true);
  const br = bumper(false);
  void bf; void br;

  // ---------------- wheel-arch flares ----------------
  const flare = (wz: number, ai: number) => {
    const n = lod ? 8 : 22;
    const band = p.arch.band;
    const pts: { z: number; y: number; nz: number; ny: number }[] = [];
    if (p.arch.shape === 'round') {
      const a0 = -0.06, a1 = Math.PI + 0.06; // front-low → over the top → rear-low
      for (let k = 0; k <= n; k++) {
        const a = a1 - ((a1 - a0) * k) / n;
        // a = 0 → rear (+z), a = π → front (-z)
        pts.push({ z: wz + Math.cos(a) * S.Ra, y: S.r + Math.sin(a) * S.Ra, nz: Math.cos(a), ny: Math.sin(a) });
      }
    } else {
      // squared arch: vertical front edge, chamfer, flat top, chamfer, vertical rear edge
      const top = S.archY(ai, 0), c = 0.14;
      const yBot = S.r - 0.05;
      const outline: [number, number][] = [[-S.Rw, yBot], [-S.Rw, top - c * 1.1], [-S.Rw + c, top], [S.Rw - c, top], [S.Rw, top - c * 1.1], [S.Rw, yBot]];
      // resample
      const segs: number[] = []; let tot = 0;
      for (let i = 1; i < outline.length; i++) { const l = Math.hypot(outline[i][0] - outline[i - 1][0], outline[i][1] - outline[i - 1][1]); segs.push(l); tot += l; }
      for (let k = 0; k <= n; k++) {
        let d = (tot * k) / n, i = 0;
        while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
        const t = segs[i] ? d / segs[i] : 0;
        const zz = mix(outline[i][0], outline[i + 1][0], t), yy = mix(outline[i][1], outline[i + 1][1], t);
        const tz = outline[i + 1][0] - outline[i][0], ty = outline[i + 1][1] - outline[i][1], l = Math.hypot(tz, ty);
        pts.push({ z: wz + zz, y: yy, nz: -ty / l, ny: tz / l });
      }
    }
    // profile across the flare: inner lip (tucked), outer lip, outer face top, base on the body side
    const sideX = (z: number, y: number) => {
      const q = S.ring(z);
      for (let i = 3; i < 6; i++) if (y <= q[i + 1][1]) { const t = clamp((y - q[i][1]) / Math.max(1e-4, q[i + 1][1] - q[i][1]), 0, 1); return mix(q[i][0], q[i + 1][0], t); }
      return q[6][0];
    };
    const xo = S.xFlare;
    const rows: ((q: (typeof pts)[0]) => V3)[] = [
      (q) => [sideX(q.z, q.y) - 0.04, q.y - q.ny * 0.004, q.z - q.nz * 0.004],
      (q) => [xo - 0.012, q.y, q.z],
      (q) => [xo, q.y + q.ny * 0.022, q.z + q.nz * 0.022],
      (q) => [xo - p.arch.flare * 0.35, q.y + q.ny * band * 0.65, q.z + q.nz * band * 0.65],
      (q) => { const y = q.y + q.ny * band, z = q.z + q.nz * band; return [sideX(z, y) - 0.006, y, z]; },
    ];
    const G = rows.map((f) => pts.map(f));
    // profile runs outward/up; columns run front → rear over the top → front face of the grid is outward
    out.grid(G.slice(0, 2), () => P.dark);
    // flares take the flank projection only (paint 3): their forward/up-facing faces would smear the end views
    out.grid(G.slice(1), () => (P.body.paint === 1 ? { ...P.body, paint: 3 } : P.body));
  };
  const f0 = out.count;
  flare(S.zF, 0); flare(S.zR, 1);
  out.mirror(f0);

  // ---------------- lights, grille ----------------
  const LL = lampLayout(S);
  const { headH, yHead } = LL;
  const zf = S.zN - 0.004;
  const headLens = lens('#e6e4d8', GLOW.head);
  const l0 = out.count;
  const xHead = LL.xHead;
  if (p.head === 'rect') {
    box(0.32, headH + 0.03, 0.03, M4(xHead, yHead, zf), P.dark);
    box(0.29, headH, 0.02, M4(xHead, yHead, zf - 0.012), headLens);
  } else if (p.head === 'slim') {
    const w = 0.34, h = Math.min(headH, 0.1);
    const q = (dx: number, dy: number, z: number): V3 => [xHead + dx, yHead + dy, z];
    polyFacing(out, [q(-w / 2, -h / 2, zf - 0.008), q(w / 2, -h / 2 + 0.03, zf - 0.008), q(w / 2, h / 2, zf - 0.008), q(-w / 2 + 0.05, h / 2, zf - 0.008)], [0, 0, -1], P.dark);
    polyFacing(out, [q(-w / 2 + 0.03, -h / 2 + 0.02, zf - 0.014), q(w / 2 - 0.02, -h / 2 + 0.04, zf - 0.014), q(w / 2 - 0.02, h / 2 - 0.018, zf - 0.014), q(-w / 2 + 0.07, h / 2 - 0.018, zf - 0.014)], [0, 0, -1], headLens);
  } else {
    const rr = p.head === 'twinRound' ? 0.068 : 0.085;
    const xs = p.head === 'twinRound' ? [xHead + 0.075, xHead - 0.085] : [xHead];
    for (const x of xs) {
      cyl(rr + 0.012, 0.05, seg, M4(x, yHead, zf - 0.01), P.chrome);
      disc(rr, seg, M4(x, yHead, zf - 0.036, 0, Math.PI, 0), headLens);
    }
  }
  // indicator under the lamp
  box(0.08, 0.035, 0.02, M4(xHead + 0.1, yHead - headH / 2 - 0.035, zf - 0.006), lens('#e8a23a', 0));
  out.mirror(l0);
  // grille between the lamps
  const gW = Math.max(0.2, xHead * 2 - 0.42), gH = Math.min(0.12, headH);
  if (p.grille === 'slats' || p.grille === 'mesh') {
    box(gW, gH, 0.02, M4(0, yHead, zf - 0.006), P.dark);
    if (p.grille === 'mesh') { box(gW + 0.03, 0.014, 0.03, M4(0, yHead + gH / 2 + 0.007, zf - 0.008), P.chrome); box(gW + 0.03, 0.014, 0.03, M4(0, yHead - gH / 2 - 0.007, zf - 0.008), P.chrome); }
    else for (const dy of [-gH / 4, gH / 4]) box(gW - 0.02, 0.014, 0.012, M4(0, yHead + dy, zf - 0.018), P.trim);
  } else {
    box(gW, Math.min(0.06, gH), 0.02, M4(0, yHead - 0.01, zf - 0.006), P.dark);
  }
  // tail lights on the rear panel
  const { tailW, xT, yTail } = LL;
  const zt = S.zT + 0.004;
  const tailLens = lens('#c62a1d', GLOW.tail);
  const t0 = out.count;
  if (p.tail === 'rect') {
    box(0.34, 0.17, 0.03, M4(xT, yTail, zt), P.dark);
    box(0.3, 0.09, 0.02, M4(xT, yTail + 0.03, zt + 0.012), tailLens);
    box(0.18, 0.04, 0.02, M4(xT + 0.05, yTail - 0.045, zt + 0.012), lens('#e8a23a', 0));
    box(0.1, 0.04, 0.02, M4(xT - 0.09, yTail - 0.045, zt + 0.012), lens('#ece8dc', 0));
  } else if (p.tail === 'round') {
    for (const [dx, c] of [[0.07, '#c62a1d'], [-0.08, '#e8a23a']] as const) {
      cyl(0.068, 0.04, seg, M4(xT + dx, yTail, zt + 0.004), P.chrome);
      disc(0.058, seg, M4(xT + dx, yTail, zt + 0.026), c === '#c62a1d' ? tailLens : lens(c, 0));
    }
  } else if (p.tail === 'bar') {
    box(0.46, 0.13, 0.03, M4(tailW - 0.26, yTail, zt), P.dark);
    box(0.42, 0.08, 0.02, M4(tailW - 0.26, yTail + 0.015, zt + 0.012), tailLens);
    box(0.12, 0.03, 0.02, M4(tailW - 0.13, yTail - 0.04, zt + 0.012), lens('#e8a23a', 0));
  } else {
    box(0.4, 0.095, 0.03, M4(xT - 0.02, yTail + 0.03, zt), P.dark);
    box(0.36, 0.06, 0.02, M4(xT - 0.02, yTail + 0.03, zt + 0.012), tailLens);
    box(0.07, 0.16, 0.03, M4(tailW - 0.06, yTail - 0.02, zt), P.dark);
    box(0.045, 0.13, 0.02, M4(tailW - 0.06, yTail - 0.02, zt + 0.012), tailLens);
  }
  out.mirror(t0);
  // rain light low on the rear bumper
  if (p.bumper.style !== 'chrome') box(0.1, 0.045, 0.02, M4(0, b.belly + 0.06, S.zBr + 0.002), tailLens);

  // ---------------- mirrors ----------------
  const m0 = out.count;
  {
    const zm = S.zWs + 0.16;
    const base = S.ghBase(zm);
    const ring = S.ring(zm);
    const xm = ring[6][0] + 0.045, ym = base[1] + 0.085;
    if (p.mirror === 'modern') {
      // tapered pod on a short stalk from the door corner
      const pod = new THREE.CylinderGeometry(0.045, 0.06, 0.13, 8).rotateX(Math.PI / 2).scale(1.25, 0.8, 1);
      out.geo(pod, M4(xm, ym, zm, 0, -0.12, 0), P.trim);
      box(0.11, 0.065, 0.01, M4(xm + 0.004, ym, zm + 0.066, 0, -0.12, 0), P.frame);
      box(0.1, 0.025, 0.04, M4(base[0] + 0.04, base[1] + 0.045, zm + 0.01, 0, 0, -0.45), P.dark);
    } else {
      cyl(0.055, 0.05, 10, M4(xm - 0.04, ym + 0.02, zm - 0.1), P.chrome);
      disc(0.045, 10, M4(xm - 0.04, ym + 0.02, zm - 0.074), P.frame);
      box(0.015, 0.1, 0.015, M4(xm - 0.04, ym - 0.04, zm - 0.1), P.chrome);
    }
  }
  out.mirror(m0);

  // ---------------- wing ----------------
  const w = p.wing;
  const sp = Math.min(S.hw - 0.04, S.xFlare - 0.06) * w.span;
  const wingPlane = (yLE: number, zLE: number, chord: number, ang: number, uvRect: [number, number, number, number] | null, thick = 0.035) => {
    // closed airfoil loop in (z, y), leading edge first, upper surface then lower
    const prof: V2[] = [[0, 0], [0.03, thick * 0.75], [chord * 0.35, thick], [chord, thick * 0.3], [chord, 0], [chord * 0.4, -thick * 0.25], [0.03, -thick * 0.25], [0, 0]];
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rot = ([z, y]: V2): V2 => [zLE + z * ca - y * sa, yLE + y * ca + z * sa];
    const pts = prof.map(rot);
    const G: V3[][] = pts.map(([z, y]) => [[-sp, y, z] as V3, [sp, y, z] as V3]);
    const topSurf: Surf = uvRect
      ? { c: col('#ffffff'), paint: 2, uv: (q) => [uvRect[0] + ((q[0] + sp) / (2 * sp)) * uvRect[2], uvRect[1] + clamp((q[2] - zLE) / chord, 0, 1) * uvRect[3]] }
      : P.trim;
    // rows run LE → upper → TE → lower; with columns -x → +x the front side is the outside of the loop
    out.grid(G, (i) => (i <= 2 ? topSurf : P.trim));
    for (const sx of [-1, 1]) polyFacing(out, pts.slice(0, -1).map(([z, y]): V3 => [sx * sp, y, z]), [sx, 0, 0], P.trim);
    return pts;
  };
  if (w.style === 'high' || w.style === 'double') {
    const zc = S.zR + w.z;
    const zLE = zc - w.chord / 2;
    const ang = 0.1;
    wingPlane(w.y, zLE, w.chord, ang, frac(REG.wingTop, 4));
    let lowY = w.y;
    if (w.style === 'double') { lowY = w.y - 0.15; wingPlane(lowY, zLE + 0.08, w.chord * 0.8, 0.05, frac(REG.wingLow, 4), 0.03); }
    // end plates with sticker panels
    const ph = w.plate, pl = w.chord + 0.12;
    for (const sx of [-1, 1]) {
      const x = sx * (sp + 0.008);
      box(0.012, ph, pl, M4(x, w.y - ph / 2 + 0.06, zc + 0.02), P.trim);
      const g = new THREE.PlaneGeometry(pl - 0.04, ph - 0.04);
      out.geo(g, M4(x + sx * 0.0075, w.y - ph / 2 + 0.06, zc + 0.02, 0, sx * Math.PI / 2, 0), { c: col('#ffffff'), paint: 2 }, frac(sx > 0 ? REG.plateR : REG.plateL, 3));
    }
    // pylons down to the hatch / deck
    for (const sx of [-1, 1]) {
      const x = sx * Math.min(0.3, sp * 0.35);
      const zs = zc + 0.03;
      const deck = zs < S.zRb - 0.02 ? S.roofYAt(zs, Math.abs(x)) : S.H(zs) + b.crown * 0.6;
      const h = lowY - deck;
      if (h > 0.02) box(0.018, h + 0.03, Math.min(0.09, w.chord * 0.3), M4(x, deck + h / 2, zs), P.dark);
    }
  } else if (w.style === 'duck') {
    const z1 = S.zT + 0.025, z0 = S.zT - w.chord;
    const sx = S.plan(S.zT) * w.span;
    const y0 = S.H(z0) + b.crown * 0.5, y1 = S.H(S.zT) + 0.065;
    const prof: V2[] = [[z0, y0 - 0.01], [z1, y1], [z1, y1 - 0.03], [S.zT - 0.01, y1 - 0.07]];
    const G: V3[][] = prof.map(([z, y]) => [[-sx, y, z] as V3, [0, y + 0.006, z] as V3, [sx, y, z] as V3]);
    out.grid(G, (i) => (i === 0 ? P.body : P.trim));
    for (const s of [-1, 1]) polyFacing(out, prof.map(([z, y]): V3 => [s * sx, y, z]), [s, 0, 0], P.trim);
  }


  // ---------------- roof scoop, antenna ----------------
  if (p.scoop && !lod) {
    const z0 = S.zRf + 0.06, z1 = z0 + 0.36, hw = 0.17;
    const y0 = S.roofYAt(z0, 0) - 0.005, y1 = S.roofYAt(z1, 0) - 0.005;
    const prof: V2[] = [[z0, y0], [z0 + 0.03, y0 + 0.07], [z1, y1 + 0.02], [z1, y1]];
    const G: V3[][] = prof.map(([z, y]) => [[-hw, y, z] as V3, [hw, y, z] as V3]);
    out.grid(G, () => P.body);
    for (const s of [-1, 1]) polyFacing(out, prof.map(([z, y]): V3 => [s * hw, y, z]), [s, 0, 0], P.body);
    polyFacing(out, [[-hw + 0.02, y0 + 0.008, z0 + 0.012], [hw - 0.02, y0 + 0.008, z0 + 0.012], [hw - 0.02, y0 + 0.058, z0 + 0.03], [-hw + 0.02, y0 + 0.058, z0 + 0.03]], [0, 0.4, -1], P.dark);
  }
  if (p.antenna && !lod) {
    const za = S.zRr - 0.18, xa = 0.18;
    const ya = S.roofYAt(za, xa);
    box(0.04, 0.02, 0.06, M4(xa, ya + 0.008, za), P.dark);
    out.geo(new THREE.CylinderGeometry(0.004, 0.006, 0.42, 4), M4(xa, ya + 0.2, za + 0.06, 0.32, 0, 0), P.dark);
  }

  // ---------------- exhaust, tow hooks, sump guard ----------------
  {
    const sx = p.exhaust === 'right' ? 1 : -1;
    const x = sx * (S.plan(S.zT) - 0.38);
    cyl(0.042, 0.26, 10, M4(x, b.belly + 0.07, S.zBr - 0.06), { c: col('#77736c') });
    disc(0.032, 10, M4(x, b.belly + 0.07, S.zBr + 0.071), { c: col('#141414') });
    const hook = (x: number, y: number, z: number, c: string) => out.geo(new THREE.TorusGeometry(0.035, 0.009, 4, 8), M4(x, y, z, 0, Math.PI / 2, 0), { c: col(c) });
    if (!lod) {
      hook(0.34, b.belly + 0.08, S.zBf - 0.005, '#e2a72e');
      hook(-0.32 * sx, b.belly + 0.1, S.zBr + 0.005, '#c63a2c');
    }
    // aluminium sump guard under the nose
    box(Math.min(1.1, S.plan(S.zN) * 1.5), 0.012, 0.7, M4(0, b.belly - 0.035, S.zN + 0.25, 0.08, 0, 0), { c: col('#8d8a83') });
  }

  // ---------------- mudflaps (swing in the vertex shader) ----------------
  {
    let idx = 0;
    for (const front of [true, false]) {
      const wz = front ? S.zF : S.zR;
      const track = front ? S.frame.trackF : S.frame.trackR;
      const fw = S.frame.wheelW + 0.07;
      const hinge = S.r + (front ? 0.02 : 0.08);
      const bottom = front ? 0.13 : 0.05;
      const h = hinge - bottom;
      const z = wz + S.Ra + 0.03;
      for (const sx of [-1, 1]) {
        idx++;
        const x = (sx * track) / 2;
        const flap: V2 = [idx, hinge];
        const red: Surf = { c: col('#c63a2c'), flap };
        out.geo(new THREE.BoxGeometry(fw, h, 0.012), M4(x, hinge - h / 2, z), red);
        out.geo(new THREE.PlaneGeometry(fw - 0.02, h - 0.02), M4(x, hinge - h / 2, z + 0.0065), { c: col('#ffffff'), paint: 2, flap }, frac(front ? REG.flapF : REG.flap, 3));
        if (!front) box(fw, 0.03, 0.05, M4(x, hinge + 0.01, z - 0.015), { c: col('#1c1c1c'), flap });
      }
    }
  }

  // ---------------- glass strips: sun strip on the windscreen, driver names on the rear glass ----------------
  if (!lod) {
    const strip = (z0: number, z1: number, rect: [number, number, number, number], fromFront: boolean) => {
      const nx = 10, nz = 2;
      const xs = S.roofSection((z0 + z1) / 2)[1][0] - 0.01;
      const G: V3[][] = [];
      for (let i = 0; i <= nx; i++) {
        const x = xs - (2 * xs * i) / nx;
        const row: V3[] = [];
        for (let j = 0; j <= nz; j++) { const z = mix(z0, z1, j / nz); row.push([x, S.roofYAt(z, x) + 0.006, z]); }
        G.push(row);
      }
      const s: Surf = { c: col('#ffffff'), paint: 2, uv: (q) => [rect[0] + (fromFront ? (xs - q[0]) / (2 * xs) : (q[0] + xs) / (2 * xs)) * rect[2], rect[1] + (fromFront ? (z1 - q[2]) / (z1 - z0) : (q[2] - z0) / (z1 - z0)) * rect[3]] };
      out.grid(G, () => s);
    };
    strip(S.zRf - 0.05 - 0.15, S.zRf - 0.05, frac(REG.sunStrip, 2), true);
    strip(S.zRr + 0.05, S.zRr + 0.05 + 0.085, frac(REG.nameStrip, 2), false);
  }

  // ---------------- night light pod (own mesh, toggled at runtime): 4 lamps on a bar above the nose ----------------
  {
    const zp = S.zN + 0.12;
    const yp = S.H(zp) + b.crown + 0.12;
    const span = Math.min(0.6, S.plan(zp) - 0.2);
    box(span * 2 + 0.16, 0.035, 0.04, M4(0, yp - 0.1, zp + 0.03), P.dark, pod);
    const podLens = lens('#fff4d2', GLOW.pod);
    for (let i = 0; i < 4; i++) {
      const x = -span + (2 * span * i) / 3;
      cyl(0.088, 0.08, seg, M4(x, yp, zp), P.dark, pod);
      cyl(0.094, 0.012, seg, M4(x, yp, zp - 0.042), P.chrome, pod);
      disc(0.078, seg, M4(x, yp, zp - 0.049, 0, Math.PI, 0), podLens, pod);
      box(0.03, 0.08, 0.03, M4(x, yp - 0.07, zp + 0.03), P.dark, pod);
    }
    for (const sx of [-1, 1]) box(0.035, Math.max(0.05, yp - 0.1 - S.H(zp)), 0.035, M4(sx * span * 0.62, (yp - 0.1 + S.H(zp)) / 2, zp + 0.05), P.dark, pod);
  }
}
