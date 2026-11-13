// Robot reference runs (analog robot, skill 0.9): the medal lines (scoring.ts MEDAL_RATIO × total) and the split
// curve the HUD compares a medal line against. Pure: runs in Node (tests, scripts/opptimes) and in the browser
// worker (src/app/botWorker.ts).
import type { CarSpec } from '../../data/cars';
import { refTimes } from '../driver/run';
import type { StageDef } from '../stage/script';

/** the reference skill (the only one the game uses) */
export const REF_SKILL = 0.9;
/** split curve resolution (m): splits are every km, 100 m keeps the cache / precomputed table small */
export const CURVE_STEP = 100;

export interface BotRun {
  /** stage total incl. penalties (s) */
  total: number;
  /** stage time every CURVE_STEP m from the start line */
  curve?: number[];
  ms?: number;
}

/** cache key (variant = full stage variant id incl. direction + weather); `tag` identifies the simulation build (hash of the sim sources + data) so stale entries are ignored */
export const botKey = (tag: string, variant: string, car: string, skill: number) => `${tag}|${variant}|${car}|${skill}`;

export function runReference(def: StageDef, spec: CarSpec, skill: number, withCurve = skill >= 0.9): BotRun {
  const t0 = Date.now();
  const r = refTimes(def, spec, skill, CURVE_STEP);
  return { total: Math.round(r.total * 1000) / 1000, curve: withCurve ? Array.from(r.times, (x) => Math.round(x * 100) / 100) : undefined, ms: Date.now() - t0 };
}

/** stage time of a reference curve at distance d (m from the start line) */
export function curveAt(curve: ArrayLike<number>, d: number, step = CURVE_STEP) {
  const f = Math.max(0, d / step), i = Math.min(curve.length - 2, Math.floor(f));
  if (i < 0) return 0;
  const u = Math.min(1, f - i);
  return curve[i] + (curve[i + 1] - curve[i]) * u;
}
