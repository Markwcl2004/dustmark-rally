// Simplified Pacejka "magic formula" on normalized combined slip + friction ellipse + load sensitivity.
import { SURFACES, type SurfaceParams } from '../../data/surfaces';

export interface TireCurve {
  /** stiffness B chosen so the peak is at normalized slip 1 */
  B: number;
  C: number;
  E: number;
  /** tan of peak slip angle */
  tanPeak: number;
  kappaPeak: number;
  /** loose surfaces: normalized force at large slip (NaN = Pacejka fall-off) */
  slide: number;
  /** 0..1 superellipse widening of the combined-slip limit */
  ell: number;
  /** longitudinal grip relative to the peak μ (loose ground: the side force has a ploughing share traction lacks) */
  lon: number;
  p: SurfaceParams;
}

function magic(B: number, C: number, E: number, x: number) {
  const bx = B * x;
  return Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

/** find B so magic(B,C,E,·) peaks at x = 1 */
function solveB(C: number, E: number) {
  // peak where C*atan(g(u)) = pi/2  → g(u) = tan(pi/(2C)), g(u) = u - E(u - atan u)
  const target = Math.tan(Math.PI / (2 * C));
  let lo = 0.01, hi = 50;
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    const g = m - E * (m - Math.atan(m));
    if (g < target) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

const curves: (TireCurve | undefined)[] = [];
export function tireCurve(surface: number): TireCurve {
  let c = curves[surface];
  if (!c) {
    const p = SURFACES[surface];
    c = { B: solveB(p.shapeC, p.shapeE), C: p.shapeC, E: p.shapeE, tanPeak: Math.tan((p.peakSlipDeg * Math.PI) / 180), kappaPeak: p.peakSlipRatio, slide: p.slide ?? NaN, ell: p.ellipse ?? 0, lon: p.lon ?? 1, p };
    curves[surface] = c;
  }
  return c;
}

/** normalized force (peak 1 at s = 1) for combined normalized slip s ≥ 0. Loose surfaces: past the peak the force
 *  levels off at `slide` (the tyre ploughs a bank of gravel / snow ahead of it instead of skating) */
export function tireForceNorm(c: TireCurve, s: number) {
  if (s > 1 && c.slide === c.slide) return 1 + (c.slide - 1) * (1 - Math.exp(1 - s));
  return magic(c.B, c.C, c.E, s);
}

export interface TireOut { fx: number; fy: number; sx: number; sy: number }

/**
 * Combined slip force (uncapped). kappa = slip ratio, tanAlpha = tan(slip angle) with sign of lateral slip velocity.
 * Returns fx along slip direction (positive = drive), fy opposing lateral slip.
 */
export function tireForces(c: TireCurve, fz: number, muScale: number, loadSens: number, kappa: number, tanAlpha: number, latScale: number, out: TireOut) {
  const sx = kappa / c.kappaPeak;
  const sy = tanAlpha / c.tanPeak;
  const s = Math.hypot(sx, sy);
  out.sx = sx; out.sy = sy;
  if (s < 1e-6 || fz <= 0) { out.fx = 0; out.fy = 0; return out; }
  // load sensitivity: μ drops as load rises above the static ~3 kN reference
  const mu = c.p.mu * muScale * Math.max(0.6, 1 - loadSens * (fz / 3000 - 1));
  const f = mu * fz * tireForceNorm(c, s);
  let ux = sx / s, uy = sy / s;
  if (c.ell > 0) {
    // combined slip on loose ground: superellipse (exponent 4) limit instead of the circle — spinning the wheels in a
    // slide still leaves most of the side force (and vice versa); pure slip is unchanged
    const x2 = ux * ux, y2 = uy * uy;
    const k = 1 + c.ell * (1 / Math.sqrt(Math.sqrt(x2 * x2 + y2 * y2)) - 1);
    ux *= k; uy *= k;
  }
  out.fx = f * ux * c.lon;
  out.fy = -f * uy * latScale;
  return out;
}
