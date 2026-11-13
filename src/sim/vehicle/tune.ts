// Feel knobs (手感重做): a handful of numbers a play-tester can change from the URL to answer "too slippery / too
// twitchy / the assist is too obvious" in one sentence. Each Car copies the defaults when it is built (plain data on the
// car, so trajectory prediction and replays clone it with the rest of the state).
//
//   grip=1.0      μ multiplier on every surface (0.7–1.3)
//   slipcap=35    body slip-angle cap of the drift assist (deg, standard; novice uses 20·slipcap/35; 0 = off)
//   push=1.0      push-wide protection strength (0 = off, 2 = strong)
//   steerrate=1.0 keyboard steering build / return rate multiplier (0.5–2)
//   gentle=0.5    throttle cap of the 轻踩 key (brake cap 0.9×, steering cap 1.2×, at most 1)

export interface Tune {
  grip: number;
  /** degrees; NaN = per-assist-level default */
  slipCap: number;
  push: number;
  steerRate: number;
  gentle: number;
}

export const TUNE: Tune = { grip: 1, slipCap: NaN, push: 1, steerRate: 1, gentle: 0.5 };

type Get = (k: string) => string | null;
const num = (q: Get, k: string, lo: number, hi: number) => {
  const v = q(k);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/** read the knobs (e.g. from URLSearchParams.get) into TUNE (cars built afterwards pick them up) */
export function applyTuneParams(q: Get) {
  TUNE.grip = num(q, 'grip', 0.5, 1.6) ?? TUNE.grip;
  TUNE.slipCap = num(q, 'slipcap', 0, 90) ?? TUNE.slipCap;
  TUNE.push = num(q, 'push', 0, 3) ?? TUNE.push;
  TUNE.steerRate = num(q, 'steerrate', 0.3, 3) ?? TUNE.steerRate;
  TUNE.gentle = num(q, 'gentle', 0.2, 1) ?? TUNE.gentle;
}

/** gentle-key caps (throttle, brake, steering) for a gentle ratio g */
export function gentleCaps(g: number) {
  return { throttle: g, brake: Math.min(1, 0.9 * g), steer: Math.min(1, 1.2 * g) };
}
