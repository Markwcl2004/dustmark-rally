// Wheel (tyre + rally rim + brake disc) as one vertex-coloured geometry for an InstancedMesh, plus the caliper
// (non-spinning, separate instanced geometry). Local frame: axle along x, outer face toward +x, centre at origin.
import * as THREE from 'three';
import type { CarVisual, LiveryDef } from '../../data/carVisuals';
import { col, MeshBuilder, type Surf, type V3 } from './builder';

function lathe(out: MeshBuilder, prof: [number, number][], segs: number, s: Surf | ((i: number, j: number) => Surf), flip: boolean) {
  // prof: [radius, x]; rows = profile, columns = angle (last column repeats the first → closed)
  const G: V3[][] = prof.map(([rho, x]) => {
    const row: V3[] = [];
    for (let j = 0; j <= segs; j++) { const a = ((j % segs) / segs) * Math.PI * 2; row.push([x, Math.cos(a) * rho, Math.sin(a) * rho]); }
    return row;
  });
  out.grid(G, typeof s === 'function' ? s : () => s, { flip });
}

export function buildWheelGeometry(v: CarVisual, L: LiveryDef, r: number, w: number, lod: number) {
  const out = new MeshBuilder();
  const hw = w / 2;
  const rimR = r * 0.6;
  const segs = lod ? 12 : 28;
  const tread = col('#2b2927'), wall = col('#363431'), rim = col(L.rim), barrel = col('#4b4945'), metal = col('#8f8b84'), dark = col('#1c1b1a');
  // tyre: inner bead → inner wall → tread → outer wall → outer bead
  const prof: [number, number][] = [
    [rimR + 0.012, -hw * 0.86], [r * 0.87, -hw], [r - 0.022, -hw * 0.97], [r, -hw * 0.78],
    [r, hw * 0.78], [r - 0.022, hw * 0.97], [r * 0.87, hw], [rimR + 0.012, hw * 0.86],
  ];
  lathe(out, prof, segs, (i) => ({ c: i >= 2 && i <= 4 ? tread : wall }), true);
  // tread lugs: raised blocks on every other segment across the tread
  if (!lod) {
    const n = segs;
    for (let j = 0; j < n; j += 2) {
      const a0 = (j / n) * Math.PI * 2 + 0.02, a1 = ((j + 1) / n) * Math.PI * 2 - 0.02;
      for (const [x0, x1] of [[-hw * 0.74, -hw * 0.06], [hw * 0.06, hw * 0.74]] as const) {
        const xa = j % 4 === 0 ? x0 : x0 + hw * 0.1, xb = j % 4 === 0 ? x1 - hw * 0.1 : x1;
        const R0 = r - 0.002, R1 = r + 0.007;
        const P = (x: number, a: number, R: number): V3 => [x, Math.cos(a) * R, Math.sin(a) * R];
        const s: Surf = { c: tread };
        out.quad(P(xa, a0, R1), P(xa, a1, R1), P(xb, a1, R1), P(xb, a0, R1), s);
        out.quad(P(xa, a0, R0), P(xa, a0, R1), P(xb, a0, R1), P(xb, a0, R0), s);
        out.quad(P(xa, a1, R1), P(xa, a1, R0), P(xb, a1, R0), P(xb, a1, R1), s);
        out.quad(P(xb, a0, R0), P(xb, a0, R1), P(xb, a1, R1), P(xb, a1, R0), s);
        out.quad(P(xa, a1, R0), P(xa, a1, R1), P(xa, a0, R1), P(xa, a0, R0), s);
      }
    }
  }
  // rim barrel (seen from outside through the spokes) and the outer lip
  lathe(out, [[rimR, hw * 0.84], [rimR, -hw * 0.86]], segs, { c: barrel }, true);
  lathe(out, [[rimR + 0.014, hw * 0.88], [rimR - 0.004, hw * 0.92], [rimR - 0.022, hw * 0.84]], segs, { c: rim }, true);
  // dust shield closing the inside
  out.geo(new THREE.CircleGeometry(rimR, segs), new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(-hw * 0.8, 0, 0), { c: dark });
  // brake disc
  if (!lod) out.geo(new THREE.CylinderGeometry(rimR * 0.84, rimR * 0.84, 0.026, 24).rotateZ(Math.PI / 2), new THREE.Matrix4().makeTranslation(-hw * 0.15, 0, 0), { c: metal });
  // spokes / face
  const face = hw * 0.78;
  const style = v.parts.rim;
  if (lod || style === 'dish') {
    out.geo(new THREE.RingGeometry(0.06, rimR - 0.012, segs), new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(face, 0, 0), { c: rim });
    if (!lod) for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      out.geo(new THREE.CircleGeometry(0.038, 10), new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(face + 0.002, Math.cos(a) * rimR * 0.58, Math.sin(a) * rimR * 0.58), { c: dark });
    }
  } else {
    const n = style === 'spoke6' ? 6 : style === 'spoke5' ? 5 : 8;
    const sw = style === 'spoke5' ? 0.07 : style === 'mini8' ? 0.05 : 0.045;
    const len = rimR - 0.07;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(face - 0.012, Math.cos(a) * (0.055 + len / 2), Math.sin(a) * (0.055 + len / 2)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.12)),
        new THREE.Vector3(1, 1, 1));
      out.geo(new THREE.BoxGeometry(0.03, len, sw), m, { c: rim });
      if (style === 'mini8') {
        // web between spokes near the rim → "minilite" look
        const m2 = new THREE.Matrix4().compose(new THREE.Vector3(face - 0.01, Math.cos(a + Math.PI / n) * (rimR - 0.035), Math.sin(a + Math.PI / n) * (rimR - 0.035)), new THREE.Quaternion().setFromEuler(new THREE.Euler(a + Math.PI / n, 0, 0)), new THREE.Vector3(1, 1, 1));
        out.geo(new THREE.BoxGeometry(0.022, 0.03, 0.09), m2, { c: rim });
      }
    }
    // hub + centre cap
    out.geo(new THREE.CylinderGeometry(0.07, 0.075, 0.04, 14).rotateZ(-Math.PI / 2), new THREE.Matrix4().makeTranslation(face - 0.008, 0, 0), { c: rim });
    out.geo(new THREE.CylinderGeometry(0.035, 0.04, 0.03, 10).rotateZ(-Math.PI / 2), new THREE.Matrix4().makeTranslation(face + 0.02, 0, 0), { c: col('#d8d4cb') });
  }
  return out.build();
}

export function buildCaliperGeometry(v: CarVisual, r: number, w: number) {
  const out = new MeshBuilder();
  const rimR = r * 0.6;
  const a = 0.55; // behind the top
  const rho = rimR * 0.74;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(-w * 0.075 + 0.02, Math.cos(a) * rho, Math.sin(a) * rho), new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)), new THREE.Vector3(1, 1, 1));
  out.geo(new THREE.BoxGeometry(0.075, 0.07, 0.16), m, { c: col(v.parts.caliper) });
  return out.build();
}
