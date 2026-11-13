// Stage "paragraph script" types (DESIGN.md §5). Scripts live in src/data/stages/*.ts.

export type Dir = 'L' | 'R';
/** 1 tightest … 6 fastest, plus hairpin and square */
export type Grade = 1 | 2 | 3 | 4 | 5 | 6 | 'hairpin' | 'square';
export type TurnMod = 'tightens' | 'opens' | 'long' | 'blind' | 'crest' | 'dontcut' | 'cut';
export type Range = number | [number, number];

export interface Feature {
  /** where along the segment, 0..1 (default 0.5) */
  at?: Range;
  kind: 'crest' | 'jump' | 'dip' | 'rollers' | 'ford';
  /** feature height (m); jumps: kicker height */
  height?: Range;
  /** feature length (m) */
  length?: Range;
  /** rollers: number of humps */
  count?: number;
  /** ford: water in the channel (false = dry riverbed crossing) */
  water?: boolean;
}

/** scenery zone id (looked up in the environment's `zones` table, src/data/envs.ts). Set on a segment, it holds until the next segment that sets one. */
export type ZoneId = string;

export interface StraightSeg {
  kind: 'straight';
  zone?: ZoneId;
  len: Range;
  features?: Feature[];
  /** lake on this side of the road */
  lake?: Dir;
  /** narrow sweeping bend on a "straight" (deg, signed + = right) */
  bend?: Range;
}

export interface TurnSeg {
  kind: 'turn';
  zone?: ZoneId;
  dir: Dir;
  grade: Grade;
  /** turn angle in degrees (defaults by grade) */
  angle?: Range;
  mods?: TurnMod[];
  features?: Feature[];
  lake?: Dir;
}

/** alternating S-bends: n turns starting with dir */
export interface SSeg {
  kind: 's';
  zone?: ZoneId;
  dir: Dir;
  grades: Grade[];
  /** short straight between bends (m) */
  gap?: Range;
  angle?: Range;
}

export type Segment = StraightSeg | TurnSeg | SSeg;

export interface StageDef {
  id: string;
  name: string;
  env: string;
  seed: number;
  /** road half width (m) */
  halfWidth: number;
  segments: Segment[];
  /** run the same road the other way (centreline built forward, then reversed; pace notes regenerated) */
  reverse?: boolean;
  /** weather/time-of-day variant id (env.weathers); default: the environment's first */
  weather?: string;
  /** id of the forward, default-weather definition this variant derives from */
  base?: string;
  /** coast: side of the stage (relative to its start→finish chord, forward direction) where the land falls to the sea */
  sea?: Dir;
}

/** radius table (m) for corner grades; hairpin uses 8–12 */
export const GRADE_RADIUS: Record<string, [number, number]> = {
  hairpin: [8, 12],
  square: [12, 16],
  1: [14, 16],
  2: [23, 27],
  3: [37, 43],
  4: [60, 70],
  5: [100, 120],
  6: [165, 195],
};

/** default turn angle ranges (deg) */
export const GRADE_ANGLE: Record<string, [number, number]> = {
  hairpin: [165, 185],
  square: [85, 95],
  1: [70, 110],
  2: [60, 100],
  3: [50, 90],
  4: [40, 75],
  5: [30, 55],
  6: [20, 40],
};

export const GRADE_CN: Record<string, string> = {
  hairpin: '发卡', square: '直角', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六',
};
export const MOD_CN: Record<TurnMod, string> = {
  tightens: '收紧', opens: '放开', long: '长', blind: '盲弯', crest: '过坡', dontcut: '别切', cut: '可切',
};
