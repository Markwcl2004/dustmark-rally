// Car → sound/camera telemetry (pure TS; used by the game loop and by offline renders in Node).
import { SURFACE_COUNT, SURFACES } from '../data/surfaces';
import type { Car } from '../sim/vehicle/car';
import type { EngineState } from './dsp/engine';

function curveTorque(car: Car, rpm: number) {
  const tc = car.spec.engine.torque;
  if (rpm <= tc[0][0]) return tc[0][1];
  for (let i = 1; i < tc.length; i++) if (rpm <= tc[i][0]) { const [r0, t0] = tc[i - 1], [r1, t1] = tc[i]; return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0); }
  return tc[tc.length - 1][1];
}

export function engineState(car: Car, out: EngineState): EngineState {
  const e = car.spec.engine;
  out.rpm = car.rpm;
  const tq = car.engineTorque;
  out.load = tq >= 0 ? Math.min(1, tq / Math.max(1, curveTorque(car, car.rpm))) : Math.max(-1, tq / Math.max(1, e.braking));
  // free-revving (neutral / clutch slip / in the air with throttle): treat pedal as load so it sounds driven
  if (car.shiftTimer > 0 || car.gear === 0) out.load = Math.max(out.load, car.throttleOut * 0.6);
  out.throttle = car.throttleOut;
  out.boost = car.boost;
  out.shiftCut = car.shiftTimer > 0;
  out.limiter = car.limiterCut;
  out.speed = car.speed;
  out.redline = e.redline;
  return out;
}

export interface RoadState {
  speed: number;
  /** weighted surface mix of grounded wheels: index → share (0..1) */
  surfMix: Float32Array;
  /** total tyre sliding speed (m/s, sum over wheels) */
  slide: number;
  /** 0..1 looseness-weighted grounded share (stones) */
  loose: number;
  grounded: number;
}

export const newRoadState = (): RoadState => ({ speed: 0, surfMix: new Float32Array(SURFACE_COUNT), slide: 0, loose: 0, grounded: 0 });

export function roadState(car: Car, out: RoadState): RoadState {
  out.speed = car.speed;
  out.surfMix.fill(0);
  let g = 0, slide = 0, loose = 0;
  for (const w of car.wheels) {
    if (!w.grounded) continue;
    g++;
    out.surfMix[w.surface] += 0.25;
    slide += w.slideSpeed;
    loose += (SURFACES[w.surface]?.loose ?? 0) * 0.25;
  }
  out.grounded = g;
  out.slide = slide;
  out.loose = loose;
  return out;
}
