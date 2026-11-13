// Road surface parameter table (DESIGN.md §4 轮胎). Values tuned by feel; write changes back to the design doc.

export const Surface = {
  AsphaltDry: 0,
  AsphaltWet: 1,
  Gravel: 2,
  Dirt: 3,
  Mud: 4,
  Grass: 5,
  Snow: 6,
  Ice: 7,
  Water: 8,
  /** deep / ploughed snow off the road (snow walls, banks): high rolling drag, soaks up impacts */
  DeepSnow: 9,
} as const;

/** number of surface kinds (array sizes in audio/telemetry) */
export const SURFACE_COUNT = 10;
export type Surface = (typeof Surface)[keyof typeof Surface];

export interface SurfaceParams {
  name: string;
  /** peak friction coefficient */
  mu: number;
  /** slip angle at peak lateral force (deg) */
  peakSlipDeg: number;
  /** slip ratio at peak longitudinal force */
  peakSlipRatio: number;
  /** Pacejka shape C: lower = flatter falloff past the peak (loose surfaces) */
  shapeC: number;
  /** Pacejka curvature E */
  shapeE: number;
  /** rolling resistance coefficient */
  rollRes: number;
  /** extra speed-proportional drag (N per (m/s) per kN load), loose/deep surfaces */
  drag: number;
  /** looseness 0..1 → dust/gravel spray and bumpiness */
  loose: number;
  /** vertical bump noise amplitude (m) felt by suspension */
  bump: number;
  /** wading drag per grounded wheel, N per (m/s)² (water, deep snow): the strong slow-down of a ford */
  wade?: number;
  /** 0..1: body contacts with this ground are soft and absorbing (snow banks) instead of a hard ground strike */
  soft?: number;
  /** 0..1: the ground yields under a wheel (deep snow): caps the wheel force so a bank does not throw the car over */
  sink?: number;
  /** loose surfaces: force at large combined slip relative to the peak (a tyre sliding sideways ploughs up a bank of
   *  gravel / snow and keeps its grip: ≥ 0.95, up to slightly rising). Unset = Pacejka fall-off past the peak (sealed) */
  slide?: number;
  /** 0..1 widening of the combined-slip friction limit toward a superellipse (exponent 4): on loose ground drive force
   *  does not eat all of the side force (0 = circle, sealed surfaces) */
  ellipse?: number;
  /** longitudinal (traction / braking) grip relative to μ, default 1. On loose ground part of the side force is the
   *  tyre ploughing a bank of gravel / snow sideways; spinning or locked in line it just digs */
  lon?: number;
}

export const SURFACES: Record<number, SurfaceParams> = {
  // rally tyres (DESIGN §4 路面参数表, 手感重做 2026-11-12): sealed surfaces fall off past the peak, loose ones plateau
  [Surface.AsphaltDry]: { name: '柏油干', mu: 1.32, peakSlipDeg: 7, peakSlipRatio: 0.1, shapeC: 1.65, shapeE: 0.2, rollRes: 0.012, drag: 0, loose: 0, bump: 0.004 },
  [Surface.AsphaltWet]: { name: '柏油湿', mu: 0.95, peakSlipDeg: 8, peakSlipRatio: 0.1, shapeC: 1.6, shapeE: 0.2, rollRes: 0.013, drag: 0, loose: 0, bump: 0.004 },
  [Surface.Gravel]: { name: '砂石', mu: 1.05, peakSlipDeg: 13, peakSlipRatio: 0.16, shapeC: 1.3, shapeE: -0.2, rollRes: 0.022, drag: 0.4, loose: 1, bump: 0.018, slide: 1.02, ellipse: 1, lon: 0.83 },
  [Surface.Dirt]: { name: '土路', mu: 0.9, peakSlipDeg: 13, peakSlipRatio: 0.16, shapeC: 1.32, shapeE: -0.1, rollRes: 0.026, drag: 0.6, loose: 0.8, bump: 0.022, slide: 1.0, ellipse: 0.9, lon: 0.87 },
  [Surface.Mud]: { name: '泥', mu: 0.6, peakSlipDeg: 16, peakSlipRatio: 0.2, shapeC: 1.25, shapeE: -0.3, rollRes: 0.06, drag: 3.0, loose: 0.6, bump: 0.02, slide: 0.95, ellipse: 0.6, lon: 0.9 },
  [Surface.Grass]: { name: '草', mu: 0.6, peakSlipDeg: 12, peakSlipRatio: 0.18, shapeC: 1.35, shapeE: -0.1, rollRes: 0.04, drag: 1.4, loose: 0.3, bump: 0.035, slide: 0.9, ellipse: 0.4 },
  [Surface.Snow]: { name: '雪', mu: 0.7, peakSlipDeg: 16, peakSlipRatio: 0.2, shapeC: 1.25, shapeE: -0.3, rollRes: 0.04, drag: 1.5, loose: 0.7, bump: 0.015, soft: 0.7, slide: 0.98, ellipse: 0.8, lon: 0.85 },
  [Surface.Ice]: { name: '冰', mu: 0.4, peakSlipDeg: 6, peakSlipRatio: 0.08, shapeC: 1.5, shapeE: 0.1, rollRes: 0.01, drag: 0, loose: 0.1, bump: 0.003 },
  [Surface.Water]: { name: '浅水', mu: 0.7, peakSlipDeg: 12, peakSlipRatio: 0.16, shapeC: 1.3, shapeE: -0.1, rollRes: 0.05, drag: 6.0, loose: 0.4, bump: 0.01, wade: 3.5, soft: 0.3, slide: 0.9, ellipse: 0.4 },
  [Surface.DeepSnow]: { name: '深雪', mu: 0.5, peakSlipDeg: 18, peakSlipRatio: 0.24, shapeC: 1.2, shapeE: -0.4, rollRes: 0.14, drag: 5.0, loose: 1, bump: 0.02, wade: 0.9, soft: 1, sink: 1, slide: 0.95, ellipse: 0.6 },
};
