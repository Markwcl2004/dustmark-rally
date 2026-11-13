// Content catalogue for the menus and the career: environments, stages (+ direction, weather), cars.
// Data-driven on top of the stage task's CATALOG / STAGES (src/data/stages/index.ts: ids `<base>`, `<base>-r`,
// `<id>@<weather>`) and the car task's CAR_ORDER / CARS. Whatever is listed but has no data yet is "coming soon"
// (available: false) and becomes playable as soon as the data lands — nothing to change here.
import { CARS, CAR_ORDER } from '../../data/cars';
import { CAR_VISUALS } from '../../data/carVisuals';
import { CATALOG, STAGES, stageId } from '../../data/stages';
import { buildCenterline } from '../stage/centerline';
import type { StageDef } from '../stage/script';

export const GROUPS = ['入门组', '经典组', '顶级组'] as const;

export interface WeatherInfo { id: string; name: string; available: boolean }
export interface StageInfo {
  /** forward, default-weather id */
  id: string; name: string; env: string;
  /** content exists */
  available: boolean;
  reversible: boolean;
  surface: string;
  blurb: string;
  /** planned length when the stage is not built yet (km) */
  lengthKm: number;
  /** scenery sections in driving order (forward) */
  zones: string[];
  weathers: WeatherInfo[];
  defaultWeather: string;
}
export interface EnvInfo {
  id: string; name: string;
  /** key of the art pipeline (posters, palettes.json): nordic / savanna / snow / coast */
  art: string;
  surface: string;
  character: string;
  available: boolean;
  stages: StageInfo[];
  weathers: WeatherInfo[];
}
export interface CarEntry {
  id: string; name: string; model: string; group: string; groupIdx: number;
  drive: 'fwd' | 'rwd' | 'awd'; driveCn: string; hp: number; massKg: number; personality: string;
  zeroTo100: number; topKmh: number;
  /** physics data present (drivable) */
  available: boolean;
  liveries: { name: string; base: string; c1: string; c2: string; number: number }[];
}

const ART: Record<string, string> = { north: 'nordic' };
const CHARACTER: Record<string, string> = {
  north: '高速 · 连续坡顶 · 大飞坡', savanna: '颠簸 · 乱石 · 长直接急弯', snow: '窄 · 雪墙 · 低抓地', coast: '发卡连发卡 · 悬崖 · 高速下山',
};

/** variant id for a stage + direction + weather (weather may be omitted → default) */
export function variantId(stage: string, reverse = false, weather?: string) { return stageId(stage, { reverse, weather }); }

/** StageDef for a stage, direction and weather (null if that variant does not exist) */
export function stageDef(stage: string, reverse = false, weather?: string): StageDef | null {
  return STAGES[variantId(stage, reverse, weather)] ?? (weather ? STAGES[variantId(stage, reverse)] ?? null : null);
}

export function listEnvs(): EnvInfo[] {
  return CATALOG.map((e) => {
    const stages: StageInfo[] = e.stages.map((s) => ({
      id: s.id, name: s.name, env: e.id, available: s.ready && !!STAGES[s.id], reversible: s.reversible && !!STAGES[`${s.id}-r`],
      surface: s.surface, blurb: s.blurb, lengthKm: s.lengthKm, zones: s.zones ?? [], defaultWeather: s.defaultWeather,
      weathers: s.weathers.map((w) => ({ id: w.id, name: w.name, available: !!STAGES[variantId(s.id, false, w.id)] })),
    }));
    return {
      id: e.id, name: e.name, art: ART[e.id] ?? e.id, surface: e.surface, character: CHARACTER[e.id] ?? '',
      available: stages.some((s) => s.available), stages,
      weathers: e.weathers.map((w) => ({ id: w.id, name: w.name, available: stages.some((s) => s.weathers.some((x) => x.id === w.id && x.available)) })),
    };
  });
}

export function envInfo(id: string): EnvInfo | undefined { return listEnvs().find((e) => e.id === id); }
export function stageInfo(id: string): StageInfo | undefined {
  const base = id.split('@')[0].replace(/-r$/, '');
  for (const e of listEnvs()) for (const s of e.stages) if (s.id === base) return s;
  return undefined;
}
export const artKey = (env: string) => ART[env] ?? env;

const lenCache = new Map<string, number>();
/** timed length of a stage in metres (centreline only: cheap, no terrain); planned length if not built yet */
export function stageLength(id: string, reverse = false): number {
  const key = `${id}|${reverse}`;
  let L = lenCache.get(key);
  if (L === undefined) {
    const d = stageDef(id, reverse);
    // Stage: start line 60 m in, finish 170 m before the end of the centreline (src/sim/stage/stage.ts)
    L = d ? Math.max(0, buildCenterline(d).length - 230) : (stageInfo(id)?.lengthKm ?? 0) * 1000;
    lenCache.set(key, L);
  }
  return L;
}

const DRIVE_CN = { fwd: '前驱', rwd: '后驱', awd: '四驱' } as const;

export function listCars(): CarEntry[] {
  return CAR_ORDER.map((id) => {
    const c = CARS[id] as (typeof CARS)[string] | undefined;
    const v = CAR_VISUALS[id];
    const group = c?.group ?? v?.group ?? '';
    const drive = (c?.drive ?? v?.drive ?? 'awd') as CarEntry['drive'];
    return {
      id, name: c?.name ?? v?.name ?? id, model: c?.model ?? v?.model ?? '', group, groupIdx: Math.max(0, GROUPS.indexOf(group as typeof GROUPS[number])),
      drive, driveCn: DRIVE_CN[drive],
      hp: c?.target.hp ?? v?.hp ?? 0, massKg: c?.mass ?? v?.mass ?? 0,
      personality: (c as unknown as { personality?: string })?.personality ?? '',
      zeroTo100: c?.target.zeroTo100 ?? 0, topKmh: c?.target.topKmh ?? 0,
      available: !!c,
      liveries: (v?.liveries ?? []).map((l) => ({ name: l.name, base: l.base, c1: l.c1, c2: l.c2, number: l.number })),
    };
  });
}

export function carEntry(id: string) { return listCars().find((c) => c.id === id); }
export function carsInGroup(g: number) { return listCars().filter((c) => c.groupIdx === g); }

/** key for records / ghosts: stage + direction (weather does not split records) */
export const recordKey = (stage: string, reverse: boolean) => (reverse ? `${stage}-r` : stage);
