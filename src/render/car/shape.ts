// Derived body geometry shared by the body loft, the parts and the livery painter.
// Model space: x right, y up (0 = ground at rest), -z forward. Axles from the physics frame.
import type { CarFrame, CarVisual } from '../../data/carVisuals';
import { clamp, mix, type V2 } from './builder';

export const RING = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, Gb: 7, M: 8, I: 9 } as const;

export interface Shape {
  vis: CarVisual;
  frame: CarFrame;
  zF: number; zR: number; r: number; tw: number;
  /** bumper faces and body ends */
  zBf: number; zBr: number; zN: number; zT: number;
  hw: number;
  zWs: number; zRf: number; zRr: number; zRb: number; zB: number; zC0: number; zC1: number;
  /** arch half-length along z and radius */
  Ra: number; Rw: number;
  /** half width of the flare's outer face */
  xFlare: number;
  yMax: number; xMax: number; zMin: number; zMax: number;
  H(z: number): number;
  plan(z: number): number;
  archY(i: number, dz: number): number;
  /** body cross-section half profile (x ≥ 0) at z; yLow lifts the bottom into a wheel well; shrink = nose/tail chamfer */
  ring(z: number, yLow?: number, shrink?: number): V2[];
  /** greenhouse: base line point, roof edge point, height */
  ghBase(z: number): V2;
  ghEdge(z: number): V2;
  roofY(z: number): number;
  /** windscreen/roof/rear-glass cross-section at z: roof edge → bevel → mid → centre (x ≥ 0) */
  roofSection(z: number): V2[];
  /** top-surface height at (z, |x| ≤ bevel point) */
  roofYAt(z: number, x: number): number;
}

export function makeShape(vis: CarVisual, frame: CarFrame): Shape {
  const b = vis.body, p = vis.parts;
  const zF = -frame.wheelbase * (1 - frame.frontWeight), zR = frame.wheelbase * frame.frontWeight;
  const r = frame.wheelR;
  const tw = Math.max(frame.trackF, frame.trackR) / 2 + frame.wheelW / 2; // tyre outer face
  const zBf = zF - b.overhangF, zBr = zR + b.overhangR;
  const zN = zBf + p.bumper.depth * 0.7, zT = zBr - p.bumper.depth * 0.7;
  // body must cover the tyres together with the flares
  const hw = Math.max(b.width / 2, tw + 0.012 - p.arch.flare + b.waistOut * 0.5);
  const xFlare = Math.max(hw + p.arch.flare, tw + 0.015);
  const zWs = zF + b.wsBase, zRf = zF + b.roofF, zRr = zR + b.roofR, zRb = zR + b.rearBase;
  const zB = zF + b.bPillar;
  const zC0 = zR + b.cEdge, zC1 = zC0 - b.cSlant;
  const Ra = r + p.arch.gap;
  const Rw = p.arch.shape === 'box' ? Ra + 0.03 : Ra;

  const H = (z: number) => {
    if (z <= zWs) {
      const t = clamp((z - zN) / (zWs - zN), 0, 1);
      const e = mix(t, 1 - (1 - t) * (1 - t), b.hoodCurve);
      return b.noseH + (b.belt - b.noseH) * e;
    }
    if (z <= zRb) return b.belt + (b.deckRear - b.belt) * ((z - zWs) / (zRb - zWs));
    const t = clamp((z - zRb) / (zT - zRb), 0, 1);
    return b.deckRear + (b.tailH - b.deckRear) * (t * t * (3 - 2 * t));
  };
  const plan = (z: number) => {
    let inset = 0;
    if (z < zN + b.roundF) { const u = clamp((zN + b.roundF - z) / b.roundF, 0, 1); inset = Math.max(inset, b.insetF * (1 - Math.sqrt(1 - u * u))); }
    if (z > zT - b.roundR) { const u = clamp((z - (zT - b.roundR)) / b.roundR, 0, 1); inset = Math.max(inset, b.insetR * (1 - Math.sqrt(1 - u * u))); }
    return hw - inset;
  };
  const archY = (_i: number, dz: number) => {
    const a = Math.abs(dz);
    if (p.arch.shape === 'round') return r + Math.sqrt(Math.max(0, Ra * Ra - a * a));
    const top = r + Ra - 0.004, c = 0.14;
    return a < Rw - c ? top : top - (a - (Rw - c)) * 1.1;
  };
  const along = (z: number) => clamp((z - zN) / (zT - zN), 0, 1);

  const ring = (z: number, yLow = b.belly, shrink = 0): V2[] => {
    const hwz = plan(z) - shrink;
    const Hz0 = H(z) - shrink * 0.8;
    const rise = b.waistRise * along(z);
    const ysh = Math.min(b.shoulder + rise, Hz0 - 0.03);
    const ywa = Math.min(b.waist + rise, ysh - 0.05);
    const ysi = Math.min(b.sill, ywa - 0.06);
    const yl = yLow;
    const dX = hwz - b.waistOut;
    const D: V2 = [dX, Math.max(ysi, yl + 0.004)];
    const Cc: V2 = [dX - 0.008, Math.max(yl, b.belly + 0.05)];
    const B: V2 = [dX - b.rockIn - 0.05, yl];
    const A: V2 = [0, yl];
    const E: V2 = [hwz, Math.max(ywa, D[1] + 0.004)];
    const F: V2 = [hwz - b.shoulderIn, Math.max(ysh, E[1] + 0.004)];
    const Hz = Math.max(Hz0, F[1] + 0.012);
    const G: V2 = [F[0] - b.deckIn, Hz];
    const deck = (x: number) => Hz + b.crown * (1 - (x / G[0]) ** 2);
    const gbx = G[0] - b.tumble;
    const Gb: V2 = [gbx, deck(gbx)];
    const M: V2 = [gbx * 0.5, deck(gbx * 0.5)];
    const I: V2 = [0, Hz + b.crown];
    return [A, B, Cc, D, E, F, G, Gb, M, I];
  };

  // greenhouse
  const ghBase = (z: number): V2 => { const q = ring(z); return [q[RING.Gb][0], q[RING.Gb][1] - 0.004]; };
  const roofY = (z: number) => {
    const yb0 = ghBase(zWs)[1], yb1 = ghBase(zRb)[1];
    if (z <= zWs) return yb0;
    if (z <= zRf) return yb0 + (b.roofH - yb0) * ((z - zWs) / (zRf - zWs));
    if (z <= zRr) return b.roofH - b.roofDrop * ((z - zRf) / (zRr - zRf));
    if (z <= zRb) return (b.roofH - b.roofDrop) + (yb1 - (b.roofH - b.roofDrop)) * ((z - zRr) / (zRb - zRr));
    return yb1;
  };
  const ghEdge = (z: number): V2 => {
    const x0 = ghBase(zWs)[0], x1 = ghBase(zRb)[0];
    let x: number;
    if (z <= zRf) x = x0 + (b.roofW - x0) * clamp((z - zWs) / (zRf - zWs), 0, 1);
    else if (z <= zRr) x = b.roofW;
    else x = b.roofW + (x1 - b.roofW) * clamp((z - zRr) / (zRb - zRr), 0, 1);
    return [x, roofY(z)];
  };

  const roofSection = (z: number): V2[] => {
    const e = ghEdge(z);
    const ramp = Math.max(0, Math.min(1, (z - zWs) / 0.12, (zRb - z) / 0.12));
    const bev = 0.055 * ramp, rise = 0.018 * ramp;
    const cr = mix(b.crown * 0.75, 0.035, ramp);
    const x1 = e[0] - bev;
    return [e, [x1, e[1] + rise + cr * (1 - (x1 / e[0]) ** 2)], [x1 * 0.5, e[1] + rise + cr * 0.78], [0, e[1] + rise + cr]];
  };
  const roofYAt = (z: number, x: number) => {
    const q = roofSection(z);
    const ax = Math.abs(x);
    for (let i = q.length - 1; i > 0; i--) {
      const a = q[i], c = q[i - 1];
      if (ax <= c[0]) return a[1] + ((c[1] - a[1]) * (ax - a[0])) / Math.max(1e-6, c[0] - a[0]);
    }
    return q[0][1];
  };
  const wing = p.wing;
  const yMax = Math.max(b.roofH + 0.12, wing.style === 'high' || wing.style === 'double' ? wing.y + 0.12 : 0) + 0.02;
  return {
    vis, frame, zF, zR, r, tw, zBf, zBr, zN, zT, hw, zWs, zRf, zRr, zRb, zB, zC0, zC1, Ra, Rw, xFlare,
    yMax, xMax: xFlare + 0.16, zMin: zBf - 0.06, zMax: Math.max(zBr, wing.style === 'none' ? zBr : zR + wing.z + wing.chord) + 0.06,
    H, plan, archY, ring, ghBase, ghEdge, roofY, roofSection, roofYAt,
  };
}
