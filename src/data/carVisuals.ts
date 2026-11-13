// Visual definition of the six cars (pure data): body shape, parts, liveries.
// One generator (src/render/car/*) builds every car from these numbers. Physics lives in cars.ts (owned by the
// handling task); when a car has no physics entry yet, `frame` stands in so the turntable can still show it.
// Lengths in metres. z offsets are measured from the axles (+ = rearward), heights from the ground at rest.

export interface CarFrame {
  wheelbase: number; frontWeight: number; trackF: number; trackR: number;
  wheelR: number; wheelW: number; cgHeight: number;
}

export interface BodyParams {
  /** front axle → front bumper face / rear axle → rear bumper face */
  overhangF: number; overhangR: number;
  /** body width at the waist crease (flares extra) */
  width: number;
  belly: number; sill: number; waist: number; waistRise: number; shoulder: number;
  /** deck height at the windscreen base, at the rear-glass base and at the tail */
  belt: number; deckRear: number; tailH: number; noseH: number;
  /** 0 = straight wedge hood, 1 = domed */
  hoodCurve: number;
  waistOut: number; shoulderIn: number; deckIn: number; crown: number; rockIn: number;
  /** plan-view corner rounding: length along z and inset at the very end */
  roundF: number; insetF: number; roundR: number; insetR: number;
  /** 0 = every crease hard (boxy), 1 = only the waist crease hard (soft) */
  soft: number;
  // greenhouse
  wsBase: number; roofF: number; roofR: number; rearBase: number;
  roofH: number; roofDrop: number; roofW: number; tumble: number;
  bPillar: number; bWidth: number;
  /** rear side-window rear edge (from rear axle) and its forward lean at the top */
  cEdge: number; cSlant: number;
  /** black window band (A/B pillars + frames) or body-coloured pillars */
  pillars: 'black' | 'body';
  doors: 2 | 4;
}

export interface PartParams {
  arch: { shape: 'round' | 'box'; gap: number; flare: number; band: number };
  bumper: { style: 'body' | 'black' | 'chrome'; topF: number; topR: number; depth: number };
  head: 'round' | 'twinRound' | 'rect' | 'slim';
  grille: 'slats' | 'mesh' | 'intake';
  tail: 'rect' | 'round' | 'bar' | 'slim';
  wing: { style: 'none' | 'duck' | 'high' | 'double'; z: number; y: number; chord: number; span: number; plate: number };
  scoop: boolean; antenna: boolean; lightPod: boolean;
  exhaust: 'right' | 'left';
  mirror: 'modern' | 'round';
  rim: 'spoke6' | 'spoke5' | 'mini8' | 'dish';
  /** brake caliper colour */
  caliper: string;
}

export type LiveryPattern = 'sweep' | 'chevron' | 'blocks' | 'fade' | 'twin' | 'split';

export interface LiveryDef {
  name: string;
  pattern: LiveryPattern;
  base: string;
  /** band colours, most prominent first */
  c1: string; c2: string; c3: string;
  /** colour of wing / mirrors / bumpers when they are not body coloured */
  trim: string;
  rim: string;
  number: number;
  driver: string; codriver: string;
  /** decal ids from public/assets/decals/atlas.json */
  main: string; second: string; third: string; marks: string[];
}

export interface CarVisual {
  id: string;
  name: string;
  model: string;
  group: string;
  era: string;
  drive: 'fwd' | 'rwd' | 'awd';
  hp: number; mass: number;
  frame: CarFrame;
  body: BodyParams;
  parts: PartParams;
  liveries: LiveryDef[];
}

// 海报色板（palettes.json / 概念图）
const P = {
  white: '#f2ede1', cream: '#ece0c4', orange: '#d9542b', red: '#c63a2c', blue: '#2b4f9b', navy: '#1e3a64',
  mustard: '#e2a72e', green: '#2e5a45', ink: '#1d2024', sky: '#6f9fc0', black: '#1b1b1c', gold: '#d2a646',
};

const base: Omit<BodyParams, never> = {
  overhangF: 0.82, overhangR: 0.7, width: 1.78,
  belly: 0.2, sill: 0.33, waist: 0.56, waistRise: 0.03, shoulder: 0.74,
  belt: 0.86, deckRear: 0.93, tailH: 0.88, noseH: 0.66, hoodCurve: 0.5,
  waistOut: 0.025, shoulderIn: 0.035, deckIn: 0.05, crown: 0.035, rockIn: 0.04,
  roundF: 0.3, insetF: 0.14, roundR: 0.22, insetR: 0.08, soft: 0.3,
  wsBase: 0.62, roofF: 1.4, roofR: -0.1, rearBase: 0.3,
  roofH: 1.33, roofDrop: 0.03, roofW: 0.56, tumble: 0.11,
  bPillar: 1.48, bWidth: 0.09, cEdge: -0.3, cSlant: 0.12, pillars: 'black', doors: 4,
};

export const CAR_VISUALS: Record<string, CarVisual> = {
  pipit: {
    id: 'pipit', name: '岭雀', model: 'Pipit 16V', group: '入门组', era: '两厢小钢炮', drive: 'fwd', hp: 150, mass: 1080,
    frame: { wheelbase: 2.44, frontWeight: 0.61, trackF: 1.47, trackR: 1.45, wheelR: 0.305, wheelW: 0.19, cgHeight: 0.5 },
    body: {
      ...base, overhangF: 0.72, overhangR: 0.6, width: 1.7, sill: 0.32, waist: 0.58, waistRise: 0.02, shoulder: 0.78,
      belt: 0.9, deckRear: 0.98, tailH: 0.92, noseH: 0.7, hoodCurve: 0.85, crown: 0.045, soft: 0.85,
      roundF: 0.34, insetF: 0.16, roundR: 0.26, insetR: 0.1,
      wsBase: 0.46, roofF: 1.18, roofR: 0.0, rearBase: 0.36, roofH: 1.42, roofDrop: 0.03, roofW: 0.54, tumble: 0.1,
      bPillar: 1.28, cEdge: -0.12, cSlant: 0.1, doors: 2,
    },
    parts: {
      arch: { shape: 'round', gap: 0.035, flare: 0.035, band: 0.06 },
      bumper: { style: 'black', topF: 0.42, topR: 0.46, depth: 0.08 },
      head: 'rect', grille: 'slats', tail: 'rect',
      wing: { style: 'none', z: 0, y: 0, chord: 0, span: 0, plate: 0 },
      scoop: false, antenna: true, lightPod: false, exhaust: 'right', mirror: 'modern', rim: 'mini8', caliper: '#c63a2c',
    },
    liveries: [
      { name: '北岬', pattern: 'sweep', base: P.white, c1: P.mustard, c2: P.blue, c3: P.red, trim: P.black, rim: P.white, number: 31, driver: '林岚', codriver: '周屿', main: 'haldro', second: 'osvari', third: 'graviko', marks: ['zeptal_mark', 'velluma_mark', 'falkora_mark'] },
      { name: '橘港', pattern: 'twin', base: P.cream, c1: P.orange, c2: P.navy, c3: P.mustard, trim: P.black, rim: P.white, number: 18, driver: '许棹', codriver: '陈默', main: 'brunska', second: 'mirsava', third: 'pyranto', marks: ['haldro_mark', 'telmora_mark'] },
      { name: '松针', pattern: 'fade', base: P.white, c1: P.green, c2: P.mustard, c3: P.green, trim: P.black, rim: P.gold, number: 44, driver: '乔野', codriver: '沈舟', main: 'mirsava', second: 'vargolt', third: 'osvari', marks: ['graviko_mark', 'quentar_mark', 'zeptal_mark'] },
    ],
  },
  wren: {
    id: 'wren', name: '津桥', model: 'Wren TS-R', group: '入门组', era: '方正两厢', drive: 'fwd', hp: 165, mass: 1120,
    frame: { wheelbase: 2.48, frontWeight: 0.6, trackF: 1.49, trackR: 1.47, wheelR: 0.31, wheelW: 0.2, cgHeight: 0.5 },
    body: {
      ...base, overhangF: 0.74, overhangR: 0.62, width: 1.72, sill: 0.33, waist: 0.6, waistRise: 0.0, shoulder: 0.8,
      belt: 0.9, deckRear: 0.94, tailH: 0.94, noseH: 0.74, hoodCurve: 0.15, crown: 0.02, soft: 0.0,
      roundF: 0.12, insetF: 0.06, roundR: 0.1, insetR: 0.05, waistOut: 0.02, shoulderIn: 0.03, deckIn: 0.04,
      wsBase: 0.5, roofF: 1.16, roofR: 0.06, rearBase: 0.3, roofH: 1.41, roofDrop: 0.01, roofW: 0.6, tumble: 0.08,
      bPillar: 1.3, bWidth: 0.1, cEdge: -0.04, cSlant: 0.02, doors: 2,
    },
    parts: {
      arch: { shape: 'box', gap: 0.04, flare: 0.04, band: 0.07 },
      bumper: { style: 'black', topF: 0.44, topR: 0.46, depth: 0.09 },
      head: 'rect', grille: 'slats', tail: 'bar',
      wing: { style: 'duck', z: 0, y: 0, chord: 0.16, span: 0.96, plate: 0 },
      scoop: false, antenna: true, lightPod: false, exhaust: 'left', mirror: 'modern', rim: 'spoke6', caliper: '#e2a72e',
    },
    liveries: [
      { name: '海军', pattern: 'blocks', base: P.white, c1: P.blue, c2: P.red, c3: P.mustard, trim: P.black, rim: P.white, number: 27, driver: '骆川', codriver: '叶迟', main: 'quentar', second: 'falkora', third: 'haldro', marks: ['vargolt_mark', 'brunska_mark'] },
      { name: '林线', pattern: 'chevron', base: P.cream, c1: P.green, c2: P.mustard, c3: P.green, trim: P.green, rim: P.gold, number: 9, driver: '唐霁', codriver: '吴潮', main: 'telmora', second: 'graviko', third: 'zeptal', marks: ['mirsava_mark', 'osvari_mark', 'velluma_mark'] },
      { name: '赤线', pattern: 'split', base: P.white, c1: P.orange, c2: P.ink, c3: P.mustard, trim: P.ink, rim: P.white, number: 52, driver: '韩疆', codriver: '白砚', main: 'pyranto', second: 'vargolt', third: 'telmora', marks: ['falkora_mark', 'haldro_mark'] },
    ],
  },
  heron: {
    id: 'heron', name: '洛川', model: 'Heron 2000 SC', group: '经典组', era: '七十年代后驱轿跑', drive: 'rwd', hp: 240, mass: 980,
    frame: { wheelbase: 2.36, frontWeight: 0.53, trackF: 1.38, trackR: 1.40, wheelR: 0.3, wheelW: 0.165, cgHeight: 0.48 },
    body: {
      ...base, overhangF: 0.86, overhangR: 0.82, width: 1.64, belly: 0.19, sill: 0.3, waist: 0.6, waistRise: 0.0, shoulder: 0.7,
      belt: 0.78, deckRear: 0.82, tailH: 0.8, noseH: 0.66, hoodCurve: 0.25, crown: 0.025, soft: 0.5,
      roundF: 0.1, insetF: 0.04, roundR: 0.12, insetR: 0.05, waistOut: 0.018, shoulderIn: 0.02, deckIn: 0.035, rockIn: 0.03,
      wsBase: 1.0, roofF: 1.48, roofR: -0.08, rearBase: 0.28, roofH: 1.27, roofDrop: 0.02, roofW: 0.52, tumble: 0.13,
      bPillar: 1.56, bWidth: 0.05, cEdge: -0.22, cSlant: 0.1, pillars: 'body', doors: 2,
    },
    parts: {
      arch: { shape: 'round', gap: 0.03, flare: 0.02, band: 0.045 },
      bumper: { style: 'chrome', topF: 0.42, topR: 0.44, depth: 0.07 },
      head: 'twinRound', grille: 'mesh', tail: 'round',
      wing: { style: 'duck', z: 0, y: 0, chord: 0.1, span: 0.9, plate: 0 },
      scoop: false, antenna: false, lightPod: true, exhaust: 'right', mirror: 'round', rim: 'mini8', caliper: '#1b1b1c',
    },
    liveries: [
      { name: '鹭羽', pattern: 'twin', base: P.cream, c1: P.green, c2: P.green, c3: P.mustard, trim: P.green, rim: P.gold, number: 4, driver: '程野', codriver: '方柯', main: 'brunska', second: 'falkora', third: 'vargolt', marks: ['osvari_mark', 'quentar_mark'] },
      { name: '旧港', pattern: 'sweep', base: P.white, c1: P.red, c2: P.blue, c3: P.mustard, trim: P.black, rim: P.white, number: 11, driver: '江晚', codriver: '冯石', main: 'quentar', second: 'zeptal', third: 'mirsava', marks: ['brunska_mark', 'pyranto_mark', 'telmora_mark'] },
      { name: '芥末', pattern: 'blocks', base: P.mustard, c1: P.ink, c2: P.white, c3: P.red, trim: P.ink, rim: P.white, number: 63, driver: '温岱', codriver: '岑舟', main: 'vargolt', second: 'osvari', third: 'haldro', marks: ['graviko_mark', 'velluma_mark'] },
    ],
  },
  shrike: {
    id: 'shrike', name: '赤峰', model: 'Shrike TX4', group: '经典组', era: '八十年代四驱怪兽', drive: 'awd', hp: 450, mass: 1100,
    frame: { wheelbase: 2.4, frontWeight: 0.48, trackF: 1.52, trackR: 1.54, wheelR: 0.32, wheelW: 0.235, cgHeight: 0.5 },
    body: {
      ...base, overhangF: 0.8, overhangR: 0.72, width: 1.76, belly: 0.2, sill: 0.34, waist: 0.58, waistRise: 0.06, shoulder: 0.76,
      belt: 0.82, deckRear: 0.96, tailH: 0.96, noseH: 0.6, hoodCurve: 0.0, crown: 0.015, soft: 0.0,
      roundF: 0.08, insetF: 0.04, roundR: 0.06, insetR: 0.03, waistOut: 0.03, shoulderIn: 0.04, deckIn: 0.04,
      wsBase: 0.62, roofF: 1.32, roofR: -0.06, rearBase: 0.36, roofH: 1.32, roofDrop: 0.02, roofW: 0.56, tumble: 0.1,
      bPillar: 1.42, bWidth: 0.11, cEdge: -0.22, cSlant: 0.0, doors: 2,
    },
    parts: {
      arch: { shape: 'box', gap: 0.05, flare: 0.1, band: 0.09 },
      bumper: { style: 'black', topF: 0.4, topR: 0.48, depth: 0.1 },
      head: 'rect', grille: 'slats', tail: 'rect',
      wing: { style: 'double', z: 0.62, y: 1.18, chord: 0.36, span: 0.98, plate: 0.3 },
      scoop: true, antenna: true, lightPod: true, exhaust: 'right', mirror: 'modern', rim: 'spoke5', caliper: '#c63a2c',
    },
    liveries: [
      { name: '烈焰', pattern: 'blocks', base: P.white, c1: P.red, c2: P.ink, c3: P.mustard, trim: P.ink, rim: P.white, number: 1, driver: '雷岳', codriver: '孟川', main: 'pyranto', second: 'haldro', third: 'zeptal', marks: ['vargolt_mark', 'graviko_mark', 'falkora_mark'] },
      { name: '群青', pattern: 'chevron', base: P.white, c1: P.blue, c2: P.mustard, c3: P.blue, trim: P.navy, rim: P.gold, number: 8, driver: '卫衡', codriver: '常远', main: 'velluma', second: 'quentar', third: 'osvari', marks: ['telmora_mark', 'mirsava_mark'] },
      { name: '砂暴', pattern: 'fade', base: P.cream, c1: P.orange, c2: P.ink, c3: P.mustard, trim: P.ink, rim: P.white, number: 22, driver: '燕北', codriver: '黎川', main: 'graviko', second: 'brunska', third: 'vargolt', marks: ['pyranto_mark', 'haldro_mark', 'zeptal_mark'] },
    ],
  },
  kestrel: {
    id: 'kestrel', name: '雁山', model: 'Kestrel R4', group: '顶级组', era: '现代四驱', drive: 'awd', hp: 380, mass: 1230,
    frame: { wheelbase: 2.55, frontWeight: 0.56, trackF: 1.58, trackR: 1.58, wheelR: 0.33, wheelW: 0.21, cgHeight: 0.5 },
    body: {
      ...base, overhangF: 0.84, overhangR: 0.7, width: 1.8, sill: 0.355, waist: 0.56, waistRise: 0.04, shoulder: 0.74,
      belt: 0.84, deckRear: 0.97, tailH: 0.9, noseH: 0.6, hoodCurve: 0.7, crown: 0.035, soft: 0.25,
      waistOut: 0.04, shoulderIn: 0.05, deckIn: 0.05,
      roundF: 0.32, insetF: 0.15, roundR: 0.2, insetR: 0.08,
      wsBase: 0.48, roofF: 1.2, roofR: 0.06, rearBase: 0.5, roofH: 1.33, roofDrop: 0.03, roofW: 0.6, tumble: 0.1,
      bPillar: 1.36, cEdge: -0.2, cSlant: 0.16, doors: 4,
    },
    parts: {
      arch: { shape: 'round', gap: 0.035, flare: 0.065, band: 0.085 },
      bumper: { style: 'body', topF: 0.48, topR: 0.5, depth: 0.1 },
      head: 'slim', grille: 'intake', tail: 'slim',
      wing: { style: 'high', z: 0.28, y: 1.35, chord: 0.34, span: 1.0, plate: 0.2 },
      scoop: true, antenna: true, lightPod: false, exhaust: 'right', mirror: 'modern', rim: 'spoke6', caliper: '#e2a72e',
    },
    liveries: [
      { name: '北境', pattern: 'sweep', base: P.white, c1: P.mustard, c2: P.blue, c3: P.red, trim: P.navy, rim: P.white, number: 7, driver: '顾北辰', codriver: '谢川', main: 'vargolt', second: 'velluma', third: 'graviko', marks: ['haldro_mark', 'zeptal_mark', 'falkora_mark'] },
      { name: '潮汐', pattern: 'split', base: P.white, c1: P.blue, c2: P.orange, c3: P.white, trim: P.navy, rim: P.white, number: 12, driver: '苏迟', codriver: '季原', main: 'quentar', second: 'telmora', third: 'mirsava', marks: ['quentar_mark', 'osvari_mark'] },
      { name: '赤松', pattern: 'chevron', base: P.cream, c1: P.red, c2: P.green, c3: P.mustard, trim: P.green, rim: P.gold, number: 3, driver: '闻笛', codriver: '庞岩', main: 'zeptal', second: 'brunska', third: 'pyranto', marks: ['vargolt_mark', 'telmora_mark', 'graviko_mark'] },
    ],
  },
  petrel: {
    id: 'petrel', name: '海岱', model: 'Petrel X4', group: '顶级组', era: '现代短轴四驱', drive: 'awd', hp: 380, mass: 1190,
    frame: { wheelbase: 2.44, frontWeight: 0.57, trackF: 1.58, trackR: 1.57, wheelR: 0.33, wheelW: 0.21, cgHeight: 0.5 },
    body: {
      ...base, overhangF: 0.8, overhangR: 0.66, width: 1.8, sill: 0.35, waist: 0.57, waistRise: 0.02, shoulder: 0.77,
      belt: 0.87, deckRear: 0.95, tailH: 0.88, noseH: 0.63, hoodCurve: 0.9, crown: 0.05, soft: 0.9,
      waistOut: 0.035, shoulderIn: 0.04,
      roundF: 0.4, insetF: 0.2, roundR: 0.3, insetR: 0.13,
      wsBase: 0.44, roofF: 1.12, roofR: 0.0, rearBase: 0.34, roofH: 1.36, roofDrop: 0.04, roofW: 0.58, tumble: 0.11,
      bPillar: 1.3, cEdge: -0.16, cSlant: 0.2, doors: 2,
    },
    parts: {
      arch: { shape: 'round', gap: 0.035, flare: 0.07, band: 0.1 },
      bumper: { style: 'body', topF: 0.46, topR: 0.5, depth: 0.1 },
      head: 'slim', grille: 'intake', tail: 'slim',
      wing: { style: 'high', z: 0.2, y: 1.38, chord: 0.3, span: 1.0, plate: 0.2 },
      scoop: true, antenna: true, lightPod: false, exhaust: 'left', mirror: 'modern', rim: 'spoke5', caliper: '#c63a2c',
    },
    liveries: [
      { name: '远洋', pattern: 'fade', base: P.white, c1: P.blue, c2: P.orange, c3: P.navy, trim: P.navy, rim: P.white, number: 21, driver: '霍青', codriver: '杜衡', main: 'telmora', second: 'osvari', third: 'quentar', marks: ['mirsava_mark', 'falkora_mark', 'velluma_mark'] },
      { name: '金穗', pattern: 'twin', base: P.white, c1: P.mustard, c2: P.green, c3: P.mustard, trim: P.green, rim: P.gold, number: 6, driver: '萧野', codriver: '邵禾', main: 'mirsava', second: 'haldro', third: 'brunska', marks: ['zeptal_mark', 'graviko_mark'] },
      { name: '墨林', pattern: 'blocks', base: P.cream, c1: P.green, c2: P.mustard, c3: P.orange, trim: P.green, rim: P.white, number: 15, driver: '容川', codriver: '贺岚', main: 'falkora', second: 'pyranto', third: 'velluma', marks: ['brunska_mark', 'quentar_mark', 'osvari_mark'] },
    ],
  },
};

export const CAR_IDS = ['pipit', 'wren', 'heron', 'shrike', 'kestrel', 'petrel'] as const;

/** visual for a physics id ("kestrel", "kestrel-fwd" test variants → kestrel); unknown ids fall back to kestrel */
export function carVisual(id: string): CarVisual {
  return CAR_VISUALS[id] ?? CAR_VISUALS[id.split('-')[0]] ?? CAR_VISUALS.kestrel;
}
