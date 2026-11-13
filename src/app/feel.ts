// 手感 settings: the five feel knobs of src/sim/vehicle/tune.ts as saved, player-facing settings.
//
// Stored as `feel` at the top level of the save (dustmark.save). The save's own normaliser (src/sim/rally/save.ts) keeps
// unknown top-level fields, so this needs no change under src/sim (whose source hash keys the precomputed reference
// times). An old save without the field reads as the defaults; 清除存档 drops it with the rest of the save.
//
// Precedence when a car is built (Game.applyCarSettings: new run and restart): defaults < saved feel < URL knob.
// The global TUNE already holds defaults ⊕ URL (src/app/input.ts applies the URL at load), so a knob the URL names is
// taken from TUNE and the saved value is ignored for it. Robot-driven runs (?bot= / ?ai=) ignore the saved feel.
import { TUNE, type Tune } from '../sim/vehicle/tune';

export interface Feel {
  /** μ multiplier on every surface */
  grip: number;
  /** drift-assist body slip cap in degrees (standard level; novice scales it by 20/35); 0 = off */
  slipCap: number;
  /** push-wide protection strength; 0 = off */
  push: number;
  /** keyboard steering build / return rate multiplier */
  steerRate: number;
  /** 轻踩 (left Shift) throttle ratio */
  gentle: number;
}

export type FeelKey = keyof Feel;

export const FEEL_DEFAULT: Readonly<Feel> = { grip: 1, slipCap: 35, push: 1, steerRate: 1, gentle: 0.5 };

/** slider ranges of the settings page: [min, max, step] (slipCap also has 0 = 关) */
export const FEEL_RANGE: Record<FeelKey, readonly [number, number, number]> = {
  grip: [0.8, 1.3, 0.05],
  slipCap: [15, 50, 5],
  push: [0, 2, 0.25],
  steerRate: [0.5, 2, 0.1],
  gentle: [0.3, 0.8, 0.05],
};

/** URL parameter of each knob (src/sim/vehicle/tune.ts) */
export const FEEL_URL: Record<FeelKey, string> = { grip: 'grip', slipCap: 'slipcap', push: 'push', steerRate: 'steerrate', gentle: 'gentle' };

const KEYS = Object.keys(FEEL_DEFAULT) as FeelKey[];
const round = (v: number, step: number) => +(Math.round(v / step) * step).toFixed(4);

/** fill missing / invalid knobs with the defaults and clamp to the slider ranges (snapped to the slider steps) */
export function normalizeFeel(raw: unknown): Feel {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...FEEL_DEFAULT };
  for (const k of KEYS) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi, step] = FEEL_RANGE[k];
    out[k] = k === 'slipCap' && v <= 0 ? 0 : round(Math.min(hi, Math.max(lo, v)), step);
  }
  return out;
}

/** the save's feel object (normalised in place, created when missing) — the settings page edits it directly */
export function feelOf(save: object): Feel {
  const s = save as { feel?: unknown };
  const f = normalizeFeel(s.feel);
  if (s.feel && typeof s.feel === 'object') Object.assign(s.feel as Feel, f);
  else s.feel = f;
  return s.feel as Feel;
}

export function resetFeel(f: Feel) { Object.assign(f, FEEL_DEFAULT); }

export function isDefaultFeel(f: Feel) { return KEYS.every((k) => f[k] === FEEL_DEFAULT[k]); }

/** knobs the page URL names (they win over the saved feel) */
export function urlFeel(search = typeof location !== 'undefined' ? location.search : ''): Partial<Record<FeelKey, string>> {
  const q = new URLSearchParams(search);
  const out: Partial<Record<FeelKey, string>> = {};
  for (const k of KEYS) { const v = q.get(FEEL_URL[k]); if (v !== null && v !== '') out[k] = v; }
  return out;
}

/** the car's tune for a run: defaults ⊕ saved feel ⊕ URL (feel null = defaults ⊕ URL only) */
export function tuneFor(feel: Feel | null, url: Partial<Record<FeelKey, string>> = urlFeel()): Tune {
  const t: Tune = { ...TUNE };
  if (!feel) return t;
  if (url.grip === undefined) t.grip = feel.grip;
  // 35 is the standard level's own cap: keep the "per-assist-level default" marker so novice / standard behave exactly
  // as with no setting at all (the sim scales an explicit cap for novice by 20/35, which gives the same 20°)
  if (url.slipCap === undefined) t.slipCap = feel.slipCap === FEEL_DEFAULT.slipCap ? NaN : feel.slipCap;
  if (url.push === undefined) t.push = feel.push;
  if (url.steerRate === undefined) t.steerRate = feel.steerRate;
  if (url.gentle === undefined) t.gentle = feel.gentle;
  return t;
}
