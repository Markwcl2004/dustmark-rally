// Stage catalogue: 4 environments × 3 stages, each runnable forward/reverse and in the environment's weathers.
//
// Ids (stable, used by URL ?stage=, saves, menus, the bot):
//   <base>            forward, environment's default weather     e.g. north-1
//   <base>-r          reverse                                     e.g. north-1-r
//   <id>@<weather>    weather variant of either direction         e.g. coast-2-r@wet
// STAGES holds every combination of the stages that exist (ready); CATALOG describes all 12 for menus.
import type { StageDef } from '../../sim/stage/script';
import { buildCenterline } from '../../sim/stage/centerline';
import { NORTH_1 } from './north1';
import { NORTH_2, NORTH_3 } from './north23';
import { SAVANNA_1, SAVANNA_2, SAVANNA_3 } from './savanna';
import { SNOW_1, SNOW_2, SNOW_3 } from './snow';
import { COAST_1, COAST_2, COAST_3 } from './coast';

/** forward, default-weather definitions that exist */
const BASE_DEFS: StageDef[] = [NORTH_1, NORTH_2, NORTH_3, SAVANNA_1, SAVANNA_2, SAVANNA_3, SNOW_1, SNOW_2, SNOW_3, COAST_1, COAST_2, COAST_3];

export interface WeatherInfo { id: string; name: string }
export interface StageInfo {
  /** forward id; reverse = `${id}-r` */
  id: string;
  name: string;
  env: string;
  /** stage length start→finish (km, forward; reverse is the same road) */
  lengthKm: number;
  /** road surface summary (中文) */
  surface: string;
  /** one-line character for the menu card */
  blurb: string;
  /** scenery sections in driving order (forward) */
  zones: string[];
  weathers: WeatherInfo[];
  defaultWeather: string;
  reversible: boolean;
  /** stage content exists (false = placeholder still being built) */
  ready: boolean;
}
export interface EnvInfo { id: string; name: string; surface: string; weathers: WeatherInfo[]; stages: StageInfo[] }

const W = (id: string, name: string): WeatherInfo => ({ id, name });
const NORTH_W = [W('clear', '晴'), W('dusk', '黄昏'), W('fog', '雾')];
const SAVANNA_W = [W('noon', '正午烈日'), W('dust', '沙尘'), W('sunset', '日落')];
const SNOW_W = [W('snowfall', '阴天飘雪'), W('cold', '晴冷'), W('night', '夜')];
const COAST_W = [W('clear', '晴'), W('wet', '雨后湿地'), W('night', '夜')];

const S = (id: string, name: string, env: string, lengthKm: number, surface: string, blurb: string, zones: string[], weathers: WeatherInfo[]): StageInfo =>
  ({ id, name, env, lengthKm, surface, blurb, zones, weathers, defaultWeather: weathers[0].id, reversible: true, ready: false });

export const CATALOG: EnvInfo[] = [
  {
    id: 'north', name: '北境林道', surface: '砂石', weathers: NORTH_W, stages: [
      S('north-1', '镜湖林场', 'north', 4.78, '砂石', '湖岸混合：坡顶、两个飞坡、湖边、发卡', ['农舍村口', '密林', '伐木场', '白桦林', '湖岸', '高地荒原'], NORTH_W),
      S('north-2', '鹿鸣岭', 'north', 4.22, '砂石', '高速飞坡：长直道连坡顶，三个大飞坡', ['农舍村口', '伐木场', '密林', '高地荒原', '白桦林'], NORTH_W),
      S('north-3', '黑松沟', 'north', 3.35, '砂石', '密林窄路：连续技术弯和两个发卡，几乎没有直道', ['伐木场', '密林', '白桦林'], NORTH_W),
    ],
  },
  {
    id: 'savanna', name: '赤土高原', surface: '红土 / 砂石', weathers: SAVANNA_W, stages: [
      S('savanna-1', '象泉渡', 'savanna', 4.36, '红土，涉水', '长直道接急弯，三处涉水过河', ['草原', '干河床', '金合欢林', '岩堆'], SAVANNA_W),
      S('savanna-2', '狮岩台地', 'savanna', 3.69, '红土 / 砂石', '乱石台地：颠簸、碎弯、岩堆贴路', ['岩堆', '台地', '草原'], SAVANNA_W),
      S('savanna-3', '赭石长原', 'savanna', 5.12, '红土', '大草原高速：超长直道、两个飞坡、一处涉水', ['草原', '金合欢林', '干河床'], SAVANNA_W),
    ],
  },
  {
    id: 'snow', name: '雪岭', surface: '压实雪 / 局部冰', weathers: SNOW_W, stages: [
      S('snow-1', '雪狐垭口', 'snow', 3.80, '压实雪，雪墙', '窄路雪墙，连续节奏弯和两个发卡翻过垭口', ['雪林', '垭口', '雪墙道'], SNOW_W),
      S('snow-2', '冰湖坳', 'snow', 3.94, '压实雪，多处冰面', '湖坳里的冰面路段，抓地忽高忽低', ['冰湖', '雪林', '林场'], SNOW_W),
      S('snow-3', '松涛林道', 'snow', 4.26, '压实雪', '挂雪针叶林里的快速林道', ['雪林', '林场', '雪墙道'], SNOW_W),
    ],
  },
  {
    id: 'coast', name: '山海公路', surface: '柏油（砂石路肩）', weathers: COAST_W, stages: [
      S('coast-1', '望海崖', 'coast', 3.32, '柏油', '悬崖边三连发卡爬坡，护栏外就是海', ['渔村', '临崖', '崖路', '临崖', '橄榄坡', '崖路', '临崖'], COAST_W),
      S('coast-2', '白屋渔村', 'coast', 3.53, '柏油', '穿过白墙红瓦的渔村，石墙夹道出崖路', ['渔村', '崖路', '临崖', '橄榄坡', '临崖', '柏树林'], COAST_W),
      S('coast-3', '柏树长坡', 'coast', 4.32, '柏油 / 砂石', '高速下山，柏树林和一段砂石近路', ['柏树林', '崖路', '砂石近路', '临崖', '柏树林', '临崖'], COAST_W),
    ],
  },
];

for (const env of CATALOG) for (const st of env.stages) st.ready = BASE_DEFS.some((d) => d.id === st.id);

/** id of a variant */
export function stageId(base: string, opts: { reverse?: boolean; weather?: string } = {}) {
  const info = stageInfo(base);
  const w = opts.weather && info && opts.weather !== info.defaultWeather ? `@${opts.weather}` : '';
  return `${base}${opts.reverse ? '-r' : ''}${w}`;
}

export function stageInfo(id: string): StageInfo | undefined {
  const base = id.split('@')[0].replace(/-r$/, '');
  for (const e of CATALOG) for (const s of e.stages) if (s.id === base) return s;
  return undefined;
}

/** every variant of every existing stage, by id */
export const STAGES: Record<string, StageDef> = {};
for (const d of BASE_DEFS) {
  const info = stageInfo(d.id);
  const weathers = info?.weathers.map((w) => w.id) ?? [];
  for (const reverse of [false, true]) {
    for (const w of [undefined, ...weathers.slice(1)]) {
      const id = `${d.id}${reverse ? '-r' : ''}${w ? '@' + w : ''}`;
      STAGES[id] = { ...d, id, base: d.id, reverse: reverse || undefined, weather: w ?? info?.defaultWeather };
    }
  }
}
/** URL alias: `<id>@<default weather>` resolves to the plain id */
for (const env of CATALOG) for (const s of env.stages) for (const r of ['', '-r']) {
  const plain = STAGES[s.id + r];
  if (plain) STAGES[`${s.id}${r}@${s.defaultWeather}`] = plain;
}

export const DEFAULT_STAGE = NORTH_1.id;

/** exact start→finish length of a stage variant (builds the centreline; ~10 ms) */
export function stageLengthM(id: string) {
  const d = STAGES[id];
  if (!d) return 0;
  const cl = buildCenterline(d);
  return cl.length - 60 - 170;
}

/** definition for a URL/menu request: `id` may already carry -r/@weather; `weather` (if given and valid) is applied on top */
export function resolveStage(id: string, weather?: string): StageDef | undefined {
  if (weather && !id.includes('@') && STAGES[`${id}@${weather}`]) return STAGES[`${id}@${weather}`];
  return STAGES[id];
}
