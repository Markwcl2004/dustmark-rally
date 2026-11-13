// Player settings (persisted in the save). Pure data + normalisation; the app applies them.

export type AssistLevel = 'novice' | 'standard' | 'hardcore';
export type QualityName = 'perf' | 'default' | 'high';

export interface Settings {
  assist: AssistLevel;
  transmission: 'auto' | 'manual';
  /** counter-steer help (on by default in the standard assist level) */
  counterSteer: boolean;
  /** trajectory prediction (P) and its horizon in s (1.5–4) */
  predict: boolean;
  predictT: number;
  /** co-driver: seconds of road called ahead (2–6) and voice pack */
  callEarly: number;
  voice: 'meijia' | 'tingting';
  vol: { master: number; engine: number; ambient: number; voice: number; ui: number };
  quality: QualityName;
  /** 0 = the preset's render scale */
  renderScale: number;
  dynres: boolean;
  post: { bloom: boolean; vignette: boolean; grain: boolean; radialBlur: boolean };
  hudLite: boolean;
  pad: { deadzone: number; curve: number };
}

export const DEFAULT_SETTINGS: Settings = {
  assist: 'standard', transmission: 'auto', counterSteer: true,
  predict: false, predictT: 2.5,
  callEarly: 4, voice: 'meijia',
  vol: { master: 0.85, engine: 1, ambient: 0.9, voice: 1, ui: 0.7 },
  quality: 'default', renderScale: 0, dynres: true,
  post: { bloom: true, vignette: true, grain: true, radialBlur: true },
  hudLite: false,
  pad: { deadzone: 0.08, curve: 1.6 },
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** fill missing / invalid fields from the defaults (old saves, hand-edited storage) */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  const vol = r.vol ?? {}, post = r.post ?? {}, pad = r.pad ?? {};
  return {
    assist: pick(r.assist, ['novice', 'standard', 'hardcore'] as const, d.assist),
    transmission: pick(r.transmission, ['auto', 'manual'] as const, d.transmission),
    counterSteer: bool(r.counterSteer, d.counterSteer),
    predict: bool(r.predict, d.predict),
    predictT: clamp(r.predictT, 1.5, 4, d.predictT),
    callEarly: clamp(r.callEarly, 2, 6, d.callEarly),
    voice: pick(r.voice, ['meijia', 'tingting'] as const, d.voice),
    vol: {
      master: clamp(vol.master, 0, 1, d.vol.master), engine: clamp(vol.engine, 0, 1, d.vol.engine),
      ambient: clamp(vol.ambient, 0, 1, d.vol.ambient), voice: clamp(vol.voice, 0, 1, d.vol.voice), ui: clamp(vol.ui, 0, 1, d.vol.ui),
    },
    quality: pick(r.quality, ['perf', 'default', 'high'] as const, d.quality),
    renderScale: clamp(r.renderScale, 0, 1, d.renderScale),
    dynres: bool(r.dynres, d.dynres),
    post: { bloom: bool(post.bloom, true), vignette: bool(post.vignette, true), grain: bool(post.grain, true), radialBlur: bool(post.radialBlur, true) },
    hudLite: bool(r.hudLite, d.hudLite),
    pad: { deadzone: clamp(pad.deadzone, 0, 0.3, d.pad.deadzone), curve: clamp(pad.curve, 1, 3, d.pad.curve) },
  };
}
