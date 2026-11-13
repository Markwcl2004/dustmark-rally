// Small non-indexed mesh builder for the car generator. Every vertex carries:
//   position, normal, color (linear), aPaint (0 vertex colour, 1 projected livery, 2 explicit livery uv),
//   aUv (canvas coords 0..1, top-left origin, for aPaint=2), aGlow (light group id), aFlap (mudflap idx+1, hinge y).
// Surfaces are built as grids ("patches"): normals are smoothed inside a patch and hard between patches,
// so creases stay crisp while panels shade smoothly.
import * as THREE from 'three';

export type V3 = [number, number, number];
export type V2 = [number, number];

export interface Surf {
  c: THREE.Color;
  paint?: number;
  glow?: number;
  /** explicit livery uv for aPaint=2: maps a vertex to canvas coords */
  uv?: (p: V3) => V2;
  flap?: V2;
}

const ZERO2: V2 = [0, 0];

export class MeshBuilder {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; uv: number[] = []; paint: number[] = []; glow: number[] = []; flap: number[] = [];

  get count() { return this.pos.length / 3; }
  get triangles() { return this.count / 3; }

  vert(p: V3, n: V3, s: Surf, uv?: V2) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(s.c.r, s.c.g, s.c.b);
    const u = uv ?? (s.uv ? s.uv(p) : ZERO2);
    this.uv.push(u[0], u[1]);
    this.paint.push(s.paint ?? 0);
    this.glow.push(s.glow ?? 0);
    const f = s.flap ?? ZERO2;
    this.flap.push(f[0], f[1]);
  }

  /** flat triangle, counter-clockwise = front */
  tri(a: V3, b: V3, c: V3, s: Surf) {
    const n = faceNormal(a, b, c);
    if (!n) return;
    this.vert(a, n, s); this.vert(b, n, s); this.vert(c, n, s);
  }

  /** flat quad a-b-c-d (CCW) */
  quad(a: V3, b: V3, c: V3, d: V3, s: Surf) { this.tri(a, b, c, s); this.tri(a, c, d, s); }

  /** convex/simple planar polygon (CCW seen from the front) via three's triangulator; projection axis picked from its normal */
  poly(pts: V3[], s: Surf) {
    if (pts.length < 3) return;
    const n = newell(pts);
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const pr = (p: V3) => (ax >= ay && ax >= az ? new THREE.Vector2(p[1], p[2]) : ay >= az ? new THREE.Vector2(p[2], p[0]) : new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(pts.map(pr), []);
    const nn = norm(n);
    for (const [i, j, k] of tris) {
      // triangulateShape returns indices in its own orientation; keep ours (CCW wrt n)
      const f = faceNormal(pts[i], pts[j], pts[k]);
      if (!f) continue;
      if (f[0] * nn[0] + f[1] * nn[1] + f[2] * nn[2] >= 0) { this.vert(pts[i], nn, s); this.vert(pts[j], nn, s); this.vert(pts[k], nn, s); }
      else { this.vert(pts[i], nn, s); this.vert(pts[k], nn, s); this.vert(pts[j], nn, s); }
    }
  }

  /**
   * Grid patch P[i][j]: i runs along the profile, j along the sweep. Front side = cross(P[i+1]-P[i], P[j+1]-P[j]).
   * surf(i, j) picks the surface for quad (i,j) (null = hole), and may route it to another builder via `to`.
   */
  grid(P: V3[][], surf: (i: number, j: number) => Surf | null, opts: { flip?: boolean; to?: (i: number, j: number) => MeshBuilder; flat?: boolean } = {}) {
    const ni = P.length, nj = P[0].length;
    const N: V3[][] = P.map((r) => r.map((): V3 => [0, 0, 0]));
    const sgn = opts.flip ? -1 : 1;
    for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nj - 1; j++) {
      const a = P[i][j], b = P[i + 1][j], c = P[i + 1][j + 1], d = P[i][j + 1];
      // quad normal from diagonals (area weighted)
      const e1 = sub(c, a), e2 = sub(d, b);
      const n = cross(e1, e2);
      for (const [ii, jj] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]] as const) { const t = N[ii][jj]; t[0] += n[0] * sgn; t[1] += n[1] * sgn; t[2] += n[2] * sgn; }
    }
    // degenerate vertices (zero-length edges): borrow from a neighbour along j, then i
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      if (len(N[i][j]) > 1e-12) continue;
      const cand = [N[i][j - 1], N[i][j + 1], N[i - 1]?.[j], N[i + 1]?.[j], N[i][j - 2], N[i][j + 2]];
      const f = cand.find((v) => v && len(v) > 1e-12);
      if (f) N[i][j] = [...f] as V3; else N[i][j] = [0, 1, 0];
    }
    for (const r of N) for (const v of r) { const l = len(v) || 1; v[0] /= l; v[1] /= l; v[2] /= l; }
    for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nj - 1; j++) {
      const s = surf(i, j);
      if (!s) continue;
      const out = opts.to ? opts.to(i, j) : this;
      const a = P[i][j], b = P[i + 1][j], c = P[i + 1][j + 1], d = P[i][j + 1];
      const na = N[i][j], nb = N[i + 1][j], nc = N[i + 1][j + 1], nd = N[i][j + 1];
      const emit = (p: V3, q: V3, r: V3, np: V3, nq: V3, nr: V3) => {
        const fn = faceNormal(p, q, r);
        if (!fn) return;
        if (opts.flat) { out.vert(p, fn, s); out.vert(q, fn, s); out.vert(r, fn, s); return; }
        out.vert(p, np, s); out.vert(q, nq, s); out.vert(r, nr, s);
      };
      if (sgn > 0) { emit(a, b, c, na, nb, nc); emit(a, c, d, na, nc, nd); }
      else { emit(a, c, b, na, nc, nb); emit(a, d, c, na, nd, nc); }
    }
  }

  /** append a three.js geometry transformed by m (its own normals; uv → canvas rect for paint=2 surfaces) */
  geo(g: THREE.BufferGeometry, m: THREE.Matrix4, s: Surf, rect?: [number, number, number, number]) {
    const gg = g.index ? g.toNonIndexed() : g;
    const p = gg.attributes.position, n = gg.attributes.normal, uv = gg.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    const flipWinding = m.determinant() < 0;
    const idx = flipWinding ? [0, 2, 1] : [0, 1, 2];
    for (let t = 0; t < p.count; t += 3) {
      for (const k of idx) {
        const i = t + k;
        v.fromBufferAttribute(p, i).applyMatrix4(m);
        w.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        let u: V2 | undefined;
        if (rect && uv) u = [rect[0] + uv.getX(i) * rect[2], rect[1] + (1 - uv.getY(i)) * rect[3]];
        this.vert([v.x, v.y, v.z], [w.x, w.y, w.z], s, u);
      }
    }
    if (gg !== g) gg.dispose();
  }

  /** like geo(), but the surface is picked per triangle from its centroid (in the geometry's local space) */
  geoBy(g: THREE.BufferGeometry, m: THREE.Matrix4, pick: (c: V3) => Surf) {
    const gg = g.index ? g.toNonIndexed() : g;
    const p = gg.attributes.position, n = gg.attributes.normal;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let t = 0; t < p.count; t += 3) {
      const c: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) { c[0] += p.getX(t + k) / 3; c[1] += p.getY(t + k) / 3; c[2] += p.getZ(t + k) / 3; }
      const s = pick(c);
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(p, t + k).applyMatrix4(m);
        w.fromBufferAttribute(n, t + k).applyMatrix3(nm).normalize();
        this.vert([v.x, v.y, v.z], [w.x, w.y, w.z], s);
      }
    }
    if (gg !== g) gg.dispose();
  }

  /** mirror every vertex appended since `from` across x=0 (winding flipped) */
  mirror(from = 0) {
    const n = this.count;
    for (let t = from; t < n; t += 3) {
      for (const k of [0, 2, 1]) {
        const i = t + k;
        this.pos.push(-this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
        this.nrm.push(-this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]);
        this.col.push(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
        this.uv.push(this.uv[i * 2], this.uv[i * 2 + 1]);
        this.paint.push(this.paint[i]);
        this.glow.push(this.glow[i]);
        this.flap.push(this.flap[i * 2], this.flap[i * 2 + 1]);
      }
    }
  }

  append(o: MeshBuilder) {
    this.pos.push(...o.pos); this.nrm.push(...o.nrm); this.col.push(...o.col); this.uv.push(...o.uv);
    this.paint.push(...o.paint); this.glow.push(...o.glow); this.flap.push(...o.flap);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 1));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setAttribute('aFlap', new THREE.Float32BufferAttribute(this.flap, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export function faceNormal(a: V3, b: V3, c: V3): V3 | null {
  const n = cross(sub(b, a), sub(c, a));
  const l = len(n);
  return l < 1e-10 ? null : [n[0] / l, n[1] / l, n[2] / l];
}
function newell(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

export const col = (hex: string | THREE.Color) => (hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex));
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
