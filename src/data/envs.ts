// Environment parameters (pure data): terrain shape, road cross-section, vegetation, scenery zones, palette, look (light + post),
// weather/time-of-day variants.
// Palette direction: "retro rally poster" — limited colours, low sun, tinted shadows, strong aerial perspective.
// public/assets/palettes.json (art pipeline, picked from the concept art) overrides the matching palette keys at runtime
// (see src/render/materials.ts loadPalette).
import { Surface } from './surfaces';

export type TreeKind =
  | 'pine' | 'scots' | 'birch' | 'spruce'          // north
  | 'acacia' | 'thorn'                              // savanna (flat-top acacia, small thorn tree)
  | 'snowpine' | 'snowspruce' | 'bare'              // snow (snow-laden spruce, young spruce, leafless tree)
  | 'cypress' | 'olive' | 'umbrella';               // coast (cypress, olive, umbrella pine)

export type PropSet =
  | 'cabins' | 'fences' | 'hay' | 'logs' | 'poles' | 'vans' | 'flags' | 'reeds' | 'stumpfield'
  | 'huts' | 'termites' | 'tents' | 'rockpiles'
  | 'snowfence' | 'snowpiles'
  | 'houses' | 'walls' | 'boats';

/** what grows / stands in one stretch of road. Densities are per 100 m². */
export interface ZoneDef {
  /** 中文名 (debug overlay / tour labels) */
  name: string;
  /** tree density multiplier near the road (d < 60 m) and further out */
  trees: number;
  treesFar: number;
  /** clear strip from the ditch edge to the first trees (m) */
  treeLine: number;
  /** relative share of each tree kind */
  mix: Partial<Record<TreeKind, number>>;
  bush: number;
  rock: number;
  /** big boulders / outcrops (hard obstacles when near) */
  boulder: number;
  /** render-only ground cover (cells of the environment's cover atlas: grass, fern, flower, reed; stumps/deadwood are models) */
  cover: { grass: number; fern: number; flower: number; reed: number; stump: number; deadwood: number };
  /** ground shading: forest-floor share, dry/light grass share, bare dirt share, heath (moorland / scree) (0..1) */
  ground: { forest: number; dry: number; dirt: number; heath?: number };
  /** 0..1: how closely the road profile follows the local ground here (1 = hugs it: few cuttings/banks, open verges;
   *  0 = engineered: the road cuts through crests and rides over hollows) */
  follow: number;
  /** spectators per 100 m of road (only where the zone allows a safe area) */
  crowd: number;
  /** scenery sets placed along the zone */
  props: PropSet[];
  /** snow walls ploughed up on both sides (height m) — soft obstacles: the car rides up and is slowed, not stopped dead */
  wall?: number;
  /** share of the road length with ice patches (0..1) */
  ice?: number;
  /** road surface override for this stretch (e.g. a gravel short-cut on an asphalt stage) */
  road?: 'gravel';
  /** coast: the sea comes right up under the road on the sea side — shoulder → guard rail → narrow platform → sea cliff */
  seacliff?: boolean;
}

/** a weather / time-of-day variant: overrides of palette + look, grip through surface remapping, falling particles */
export interface WeatherDef {
  name: string;
  palette?: Partial<EnvDef['palette']>;
  look?: Partial<EnvDef['look']>;
  /** road/verge surfaces are remapped (grip comes from the surface table in surfaces.ts; vehicle code is untouched) */
  grip?: Partial<Record<number, number>>;
  /** falling weather particles */
  fall?: 'snow' | 'rain';
  /** night: headlights on, dark ambient */
  night?: boolean;
  /** dust emission multiplier */
  dust?: number;
  /** road wetness 0..1 (shading: darker, sky sheen, puddles) */
  wet?: number;
}

export interface EnvDef {
  id: string;
  name: string;
  /** art folder key (public/assets/tex/<art>/, far/<art>_n.png, crowd/<art>_n.png, palettes.json) */
  art: string;
  terrain: {
    /** [amplitude m, wavelength m] octaves for base terrain */
    octaves: [number, number][];
    /** ridged mountain layer amplitude / wavelength */
    ridge: [number, number];
    maxGrade: number;
    /** road profile smoothing window (m) */
    smooth: number;
    /** steepest bank of a cutting/embankment next to the road (rise/run) */
    bankSlope: number;
    /** design speed (m/s) for crest landings: crests a car would leave at this speed get a landing downslope (0 = off) */
    crestSpeed?: number;
    /** coastal tilt: the whole landscape falls toward the sea on one side of the stage (amplitude m, half-width m) */
    coast?: { amp: number; width: number; seaLevel: number };
  };
  road: {
    /** shading of the road band */
    kind: 'gravel' | 'asphalt' | 'snow';
    /** physics surfaces: road, shoulder, off-road */
    surface: number;
    shoulderSurface: number;
    offSurface: number;
    crown: number;
    shoulder: number;
    ditchWidth: number;
    ditchDepth: number;
    /** micro bumps amplitude (m) */
    rough: number;
    rut: number;
  };
  veg: {
    /** trees per 100 m² near road (d<60) and far — multiplied by the zone's factors */
    nearDensity: number;
    farDensity: number;
    birchShare: number;
    bushDensity: number;
    rockDensity: number;
    /** clear distance from road edge to first trees (default when a zone does not say) */
    treeLine: number;
  };
  /** ground texture files in public/assets/tex/<art>/ per shader slot (missing → procedural) */
  tex: Partial<Record<'fine' | 'peb' | 'shoulder' | 'grass' | 'forest' | 'rock' | 'dirt' | 'wall', string>>;
  /** particles: dust amount and colour (defaults to the road colour), stones */
  fx: { dust: number; dustColor?: string; dustOpacity?: number; stones: number; spray?: 'snow' };
  /** scenery zones by id, referenced from stage scripts (`zone: 'forest'`) */
  zones: Record<string, ZoneDef>;
  /** zone used before the first segment that names one */
  defaultZone: string;
  /** weather variants; the first is the default */
  weathers: Record<string, WeatherDef>;
  palette: {
    skyTop: string;
    skyHorizon: string;
    fog: string;
    fogDensity: number;
    sun: string;
    sunIntensity: number;
    /** sun elevation / azimuth in degrees */
    sunElev: number;
    sunAzim: number;
    hemiSky: string;
    hemiGround: string;
    hemiIntensity: number;
    grass: string;
    grassDry: string;
    gravel: string;
    gravelDark: string;
    dirt: string;
    /** moorland ground (heath zones) */
    heath: string;
    rock: string;
    pine: string;
    pineDark: string;
    birchLeaf: string;
    birchBark: string;
    bush: string;
    water: string;
    mountainNear: string;
    mountainFar: string;
    exposure: number;
    /** forest-floor ground colour (default: grass/pine/dirt mix) */
    forest?: string;
    /** sea (coast) */
    sea?: string;
    /** road markings (asphalt) */
    paint?: string;
    /** gravel road: firm wheel tracks, light / dark stones (default: cream / slate) */
    track?: string;
    speckLight?: string;
    speckDark?: string;
    trunk?: string;
  };
  /** lighting + post-processing (src/render/look.ts). All colours sRGB hex. */
  look: {
    /** colour the shadowed side is pulled toward (poster blue) and how far (0..1) */
    shadowTint: string;
    shadowMix: number;
    /** ambient fill seen from the sky / from the ground in shade (multiplies albedo) */
    ambSky: string;
    ambGround: string;
    /** sun light multiplier on lit faces */
    sunStrength: number;
    /** width of the lit/shade terminator in N·L (smaller = harder poster edge) */
    terminator: number;
    /** aerial perspective: near haze colour (warm, low), far haze colour (cool), density per m, max opacity */
    hazeNear: string;
    hazeFar: string;
    hazeDensity: number;
    hazeMax: number;
    /** height fog: extra haze below this altitude relative to the stage mean (m), falloff (m) */
    hazeLow: number;
    hazeFalloff: number;
    /** metres in front of the camera that stay (almost) clear of haze */
    hazeStart?: number;
    /** cap on the accumulated opacity of the soft particles (dust, spray) */
    partMax?: number;
    /** sky: clouds colour, cloud cover 0..1 */
    cloud: string;
    cloudCover: number;
    /** painted sky (public/assets/sky/<file>) replacing the gradient, and/or a painted RGBA cloud band */
    skyTex?: string;
    cloudTex?: string;
    /** sun disc visibility 0..1 (overcast/night: 0) */
    sunDisc?: number;
    /** star field brightness (night) */
    stars?: number;
    /** colour grading: lift/gain (rgb hex as tint), saturation, contrast */
    lift: string;
    gain: string;
    saturation: number;
    contrast: number;
    bloom: number;
    bloomThreshold: number;
    vignette: number;
    grain: number;
    /** headlight strength (night) */
    headlights?: number;
  };
}

const NORDIC_ZONES: Record<string, ZoneDef> = {
  village: {
    name: '农舍村口', follow: 0.85, trees: 0.25, treesFar: 0.5, treeLine: 14,
    mix: { pine: 0.3, scots: 0.2, birch: 0.5, spruce: 0.2 },
    bush: 0.6, rock: 0.05, boulder: 0,
    cover: { grass: 9, fern: 0, flower: 4, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.05, dry: 0.85, dirt: 0.05 },
    crowd: 6, props: ['cabins', 'fences', 'hay', 'poles', 'vans', 'flags'],
  },
  forest: {
    name: '密林', follow: 0.0, trees: 2.0, treesFar: 1.3, treeLine: 0.6,
    mix: { pine: 0.62, scots: 0.22, birch: 0.06, spruce: 0.35 },
    bush: 0.9, rock: 0.12, boulder: 0.012,
    cover: { grass: 2.5, fern: 6, flower: 0.4, reed: 0, stump: 0.4, deadwood: 0.15 },
    ground: { forest: 0.9, dry: 0.2, dirt: 0.1 },
    crowd: 0.6, props: [],
  },
  logging: {
    name: '伐木场', follow: 0.6, trees: 0.18, treesFar: 0.9, treeLine: 20,
    mix: { pine: 0.6, scots: 0.3, birch: 0.1, spruce: 0.25 },
    bush: 0.25, rock: 0.08, boulder: 0,
    cover: { grass: 4, fern: 1, flower: 0.8, reed: 0, stump: 7, deadwood: 1.2 },
    ground: { forest: 0.15, dry: 0.45, dirt: 0.6 },
    crowd: 2.5, props: ['logs', 'stumpfield', 'vans', 'flags'],
  },
  birch: {
    name: '白桦林', follow: 0.15, trees: 1.05, treesFar: 1.0, treeLine: 3.5,
    mix: { pine: 0.06, scots: 0.04, birch: 1, spruce: 0.05 },
    bush: 0.7, rock: 0.05, boulder: 0,
    cover: { grass: 9, fern: 2.5, flower: 3, reed: 0, stump: 0.2, deadwood: 0.1 },
    ground: { forest: 0.25, dry: 0.75, dirt: 0.02 },
    crowd: 1.2, props: [],
  },
  lake: {
    name: '湖岸', follow: 0.5, trees: 0.35, treesFar: 0.7, treeLine: 9,
    mix: { pine: 0.45, scots: 0.35, birch: 0.35, spruce: 0.15 },
    bush: 0.5, rock: 0.25, boulder: 0.006,
    cover: { grass: 9, fern: 0.5, flower: 4, reed: 12, stump: 0, deadwood: 0.05 },
    ground: { forest: 0.12, dry: 0.3, dirt: 0.03 },
    crowd: 3, props: ['reeds', 'cabins', 'flags'],
  },
  moor: {
    name: '高地荒原', follow: 0.35, trees: 0.07, treesFar: 0.18, treeLine: 12,
    mix: { pine: 0.3, scots: 0.5, birch: 0.15, spruce: 0.4 },
    bush: 1.5, rock: 1.6, boulder: 0.1,
    cover: { grass: 8, fern: 0.4, flower: 0.6, reed: 0, stump: 0, deadwood: 0.05 },
    ground: { forest: 0.0, dry: 0.5, dirt: 0.12, heath: 1 },
    crowd: 2, props: ['flags', 'vans'],
  },
};


const SAVANNA_ZONES: Record<string, ZoneDef> = {
  plain: {
    name: '草原', follow: 0.7, trees: 0.05, treesFar: 0.09, treeLine: 10,
    mix: { acacia: 1, thorn: 0.35 },
    bush: 0.7, rock: 0.35, boulder: 0.01,
    cover: { grass: 14, fern: 1.2, flower: 0.4, reed: 0, stump: 0, deadwood: 0.08 },
    ground: { forest: 0.0, dry: 0.85, dirt: 0.12 },
    crowd: 1.2, props: ['termites', 'flags'],
  },
  acacia: {
    name: '金合欢林', follow: 0.5, trees: 0.28, treesFar: 0.3, treeLine: 5,
    mix: { acacia: 1, thorn: 0.6 },
    bush: 1.4, rock: 0.25, boulder: 0.01,
    cover: { grass: 10, fern: 2.5, flower: 0.6, reed: 0, stump: 0, deadwood: 0.2 },
    ground: { forest: 0.25, dry: 0.65, dirt: 0.15 },
    crowd: 0.8, props: ['termites'],
  },
  kopje: {
    name: '岩堆', follow: 0.3, trees: 0.07, treesFar: 0.1, treeLine: 7,
    mix: { acacia: 0.6, thorn: 1 },
    bush: 1.0, rock: 2.6, boulder: 0.16,
    cover: { grass: 8, fern: 1.5, flower: 0.2, reed: 0, stump: 0, deadwood: 0.1 },
    ground: { forest: 0.0, dry: 0.55, dirt: 0.35, heath: 0.6 },
    crowd: 2.2, props: ['rockpiles', 'flags'],
  },
  riverbed: {
    name: '干河床', follow: 0.75, trees: 0.16, treesFar: 0.22, treeLine: 6,
    mix: { acacia: 1, thorn: 0.5 },
    bush: 1.6, rock: 0.9, boulder: 0.02,
    cover: { grass: 9, fern: 2.5, flower: 0.5, reed: 3, stump: 0, deadwood: 0.3 },
    ground: { forest: 0.35, dry: 0.4, dirt: 0.45 },
    crowd: 2.5, props: ['flags'],
  },
  camp: {
    name: '营地', follow: 0.85, trees: 0.08, treesFar: 0.12, treeLine: 12,
    mix: { acacia: 1, thorn: 0.3 },
    bush: 0.6, rock: 0.2, boulder: 0,
    cover: { grass: 9, fern: 0.8, flower: 0.6, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.0, dry: 0.65, dirt: 0.4 },
    crowd: 6, props: ['huts', 'tents', 'vans', 'flags', 'fences'],
  },
};

const SNOW_ZONES: Record<string, ZoneDef> = {
  forest: {
    name: '雪林', follow: 0.1, trees: 1.8, treesFar: 1.25, treeLine: 1.5, wall: 0.9,
    mix: { snowpine: 1, snowspruce: 0.45, bare: 0.08 },
    bush: 0.6, rock: 0.1, boulder: 0.01,
    cover: { grass: 2, fern: 1.5, flower: 0, reed: 0, stump: 0.2, deadwood: 0.1 },
    ground: { forest: 0.55, dry: 0.2, dirt: 0.0 },
    crowd: 0.6, props: ['snowpiles'], ice: 0.04,
  },
  pass: {
    name: '垭口', follow: 0.3, trees: 0.12, treesFar: 0.2, treeLine: 8, wall: 1.0,
    mix: { snowpine: 1, snowspruce: 0.8, bare: 0.4 },
    bush: 0.5, rock: 1.4, boulder: 0.08,
    cover: { grass: 3, fern: 1, flower: 0, reed: 0, stump: 0, deadwood: 0.05 },
    ground: { forest: 0.0, dry: 0.4, dirt: 0.0, heath: 0.7 },
    crowd: 2, props: ['snowfence', 'flags', 'snowpiles'], ice: 0.1,
  },
  walls: {
    name: '雪墙道', follow: 0.2, trees: 0.6, treesFar: 0.9, treeLine: 4, wall: 1.3,
    mix: { snowpine: 1, snowspruce: 0.6, bare: 0.1 },
    bush: 0.3, rock: 0.2, boulder: 0.02,
    cover: { grass: 1.5, fern: 0.5, flower: 0, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.15, dry: 0.3, dirt: 0.0 },
    crowd: 0.8, props: ['snowfence'], ice: 0.05,
  },
  lake: {
    name: '冰湖', follow: 0.6, trees: 0.3, treesFar: 0.6, treeLine: 9, wall: 0.6,
    mix: { snowpine: 1, snowspruce: 0.5, bare: 0.6 },
    bush: 0.8, rock: 0.4, boulder: 0.02,
    cover: { grass: 4, fern: 1, flower: 0, reed: 4, stump: 0, deadwood: 0.05 },
    ground: { forest: 0.1, dry: 0.5, dirt: 0.0 },
    crowd: 2.5, props: ['cabins', 'flags', 'reeds'], ice: 0.35,
  },
  camp: {
    name: '林场', follow: 0.8, trees: 0.25, treesFar: 0.7, treeLine: 12, wall: 0.7,
    mix: { snowpine: 1, snowspruce: 0.5, bare: 0.3 },
    bush: 0.5, rock: 0.1, boulder: 0,
    cover: { grass: 3, fern: 0.5, flower: 0, reed: 0, stump: 1, deadwood: 0.3 },
    ground: { forest: 0.1, dry: 0.5, dirt: 0.0 },
    crowd: 6, props: ['cabins', 'fences', 'logs', 'vans', 'flags', 'poles'], ice: 0.03,
  },
};

const COAST_ZONES: Record<string, ZoneDef> = {
  cliff: {
    name: '崖路', follow: 0.15, trees: 0.12, treesFar: 0.25, treeLine: 4,
    mix: { olive: 0.4, cypress: 0.5, umbrella: 0.5 },
    bush: 1.5, rock: 0.8, boulder: 0.03,
    cover: { grass: 6, fern: 3, flower: 1.5, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.1, dry: 0.55, dirt: 0.3, heath: 0.6 },
    crowd: 1.5, props: ['flags'],
  },
  seacliff: {
    name: '临崖', follow: 0.2, trees: 0.08, treesFar: 0.2, treeLine: 5, seacliff: true,
    mix: { cypress: 0.6, umbrella: 0.6, olive: 0.3 },
    bush: 1.2, rock: 0.9, boulder: 0.02,
    cover: { grass: 6, fern: 2.5, flower: 1.5, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.05, dry: 0.6, dirt: 0.3, heath: 0.6 },
    crowd: 0.8, props: ['flags'],
  },
  olive: {
    name: '橄榄坡', follow: 0.4, trees: 0.65, treesFar: 0.6, treeLine: 6,
    mix: { olive: 1, cypress: 0.25, umbrella: 0.1 },
    bush: 0.8, rock: 0.4, boulder: 0.01,
    cover: { grass: 8, fern: 1.5, flower: 2.5, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.1, dry: 0.7, dirt: 0.3 },
    crowd: 1.5, props: ['walls', 'flags'],
  },
  village: {
    name: '渔村', follow: 0.55, trees: 0.2, treesFar: 0.35, treeLine: 8,
    mix: { cypress: 1, olive: 0.6, umbrella: 0.3 },
    bush: 0.9, rock: 0.1, boulder: 0,
    cover: { grass: 5, fern: 2, flower: 4, reed: 0, stump: 0, deadwood: 0 },
    ground: { forest: 0.05, dry: 0.6, dirt: 0.35 },
    crowd: 7, props: ['houses', 'walls', 'vans', 'flags', 'poles'],
  },
  cypress: {
    name: '柏树林', follow: 0.2, trees: 1.1, treesFar: 0.9, treeLine: 3,
    mix: { cypress: 1, umbrella: 0.7, olive: 0.2 },
    bush: 1.0, rock: 0.3, boulder: 0.01,
    cover: { grass: 5, fern: 2.5, flower: 1, reed: 0, stump: 0, deadwood: 0.05 },
    ground: { forest: 0.45, dry: 0.45, dirt: 0.2 },
    crowd: 1, props: [],
  },
  gravel: {
    name: '砂石近路', follow: 0.45, trees: 0.25, treesFar: 0.4, treeLine: 5, road: 'gravel',
    mix: { olive: 1, umbrella: 0.6, cypress: 0.3 },
    bush: 1.6, rock: 1.0, boulder: 0.03,
    cover: { grass: 7, fern: 2.5, flower: 1, reed: 0, stump: 0, deadwood: 0.05 },
    ground: { forest: 0.05, dry: 0.7, dirt: 0.45, heath: 0.4 },
    crowd: 3, props: ['walls', 'flags'],
  },
};

export const ENVS: Record<string, EnvDef> = {
  north: {
    id: 'north',
    name: '北境林道',
    art: 'nordic',
    terrain: {
      // mid-scale hills (90–500 m) are smoothed out of the road profile → the road cuts through crests and rides over hollows
      octaves: [[34, 1400], [22, 520], [17, 230], [7.5, 105], [1.6, 42], [0.45, 16]],
      ridge: [70, 2600],
      maxGrade: 0.12,
      smooth: 240,
      bankSlope: 1.15,
      crestSpeed: 36,
    },
    road: { kind: 'gravel', surface: Surface.Gravel, shoulderSurface: Surface.Dirt, offSurface: Surface.Grass, crown: 0.07, shoulder: 0.9, ditchWidth: 2.2, ditchDepth: 0.5, rough: 0.035, rut: 0.025 },
    veg: { nearDensity: 2.6, farDensity: 1.1, birchShare: 0.28, bushDensity: 1.2, rockDensity: 0.14, treeLine: 3.4 },
    tex: { fine: 'gravel_road_2.jpg', peb: 'gravel_road_1.jpg', shoulder: 'gravel_shoulder.jpg', grass: 'grass.jpg', forest: 'forest_floor.jpg', rock: 'rock.jpg', dirt: 'dirt_bank.jpg' },
    fx: { dust: 1, stones: 1 },
    zones: NORDIC_ZONES,
    defaultZone: 'forest',
    weathers: {
      clear: { name: '晴' },
      dusk: {
        name: '黄昏',
        palette: { sun: '#ffb877', sunElev: 9, sunAzim: 250, skyTop: '#6f8fb4', skyHorizon: '#f2b88a' },
        look: { shadowTint: '#3a3f78', shadowMix: 0.32, ambSky: '#8f97c4', ambGround: '#8a7a8e', sunStrength: 1.0, hazeNear: '#e8b892', hazeFar: '#8e89a8', hazeDensity: 0.0016, cloud: '#f7c79a', skyTex: 'dusk.jpg', cloudTex: undefined, lift: '#0a0818', gain: '#fff2e2', saturation: 1.18 },
      },
      fog: {
        name: '雾',
        palette: { sun: '#e9e6da', sunElev: 30 },
        look: { shadowMix: 0.12, sunStrength: 0.82, ambSky: '#c3cbc8', ambGround: '#a9ada4', hazeNear: '#cfd5cf', hazeFar: '#b8c2bf', hazeDensity: 0.012, hazeMax: 0.96, hazeStart: 18, hazeLow: 4, cloudCover: 0, skyTex: 'fog.jpg', cloudTex: undefined, sunDisc: 0, saturation: 1.05, contrast: 1.05, bloom: 0.08 },
        grip: { [Surface.Gravel]: Surface.Dirt },
        dust: 0.35,
        wet: 0.45,
      },
    },
    palette: {
      skyTop: '#86bccd',
      skyHorizon: '#efe5cb',
      fog: '#9fb3b3',
      fogDensity: 0.0024,
      sun: '#ffe0a6',
      sunIntensity: 1.3,
      sunElev: 24,
      sunAzim: 235,
      hemiSky: '#9fb8c4',
      hemiGround: '#6b5a3c',
      hemiIntensity: 0.62,
      grass: '#7f8a3e',
      grassDry: '#c9b766',
      gravel: '#e6c9a7',
      gravelDark: '#b39472',
      dirt: '#ad8657',
      heath: '#7a6447',
      rock: '#8b8a7c',
      pine: '#2e4a3b',
      pineDark: '#18291f',
      birchLeaf: '#b9c25a',
      birchBark: '#ece6d6',
      bush: '#4f6a34',
      water: '#5f97a8',
      mountainNear: '#6d8b93',
      mountainFar: '#9db4b8',
      exposure: 1.0,
    },
    look: {
      shadowTint: '#2f4f7e',
      shadowMix: 0.22,
      ambSky: '#9fb6d6',
      ambGround: '#8d93a4',
      sunStrength: 1.08,
      terminator: 0.16,
      hazeNear: '#d9ddcf',
      hazeFar: '#9ab3b8',
      hazeDensity: 0.0013,
      hazeMax: 0.8,
      hazeStart: 60,
      partMax: 0.6,
      hazeLow: -6,
      hazeFalloff: 12,
      cloud: '#f6ecd2',
      cloudCover: 0.6,
      cloudTex: 'clouds_1.png',
      lift: '#060a16',
      gain: '#fffaf0',
      saturation: 1.2,
      contrast: 1.17,
      bloom: 0.14,
      bloomThreshold: 0.9,
      vignette: 0.32,
      grain: 0.045,
    },
  },

  savanna: {
    id: 'savanna',
    name: '赤土高原',
    art: 'savanna',
    terrain: {
      octaves: [[16, 1700], [9, 620], [4.5, 230], [2.2, 95], [0.8, 32], [0.35, 12]],
      ridge: [30, 3200],
      maxGrade: 0.08,
      smooth: 200,
      bankSlope: 0.8,
      crestSpeed: 40,
    },
    road: { kind: 'gravel', surface: Surface.Dirt, shoulderSurface: Surface.Gravel, offSurface: Surface.Grass, crown: 0.05, shoulder: 0.8, ditchWidth: 1.6, ditchDepth: 0.3, rough: 0.065, rut: 0.04 },
    veg: { nearDensity: 2.2, farDensity: 1.0, birchShare: 0, bushDensity: 1.2, rockDensity: 0.2, treeLine: 6 },
    tex: { fine: 'road.jpg', peb: 'road.jpg', shoulder: 'shoulder.jpg', grass: 'dry_grass.jpg', forest: 'ground.jpg', rock: 'rock.jpg', dirt: 'riverbed.jpg' },
    fx: { dust: 1.7, dustColor: '#d9774a', dustOpacity: 0.55, stones: 1.2 },
    zones: SAVANNA_ZONES,
    defaultZone: 'plain',
    weathers: {
      noon: { name: '正午烈日' },
      dust: {
        name: '沙尘',
        palette: { sun: '#ffd9a0', sunElev: 38, skyTop: '#d9a074', skyHorizon: '#e3b083' },
        look: { hazeNear: '#e2a473', hazeFar: '#cc8a62', hazeDensity: 0.0085, hazeMax: 0.93, hazeStart: 25, sunStrength: 0.9, shadowMix: 0.2, skyTex: 'sandstorm.jpg', cloudTex: undefined, sunDisc: 0.25, saturation: 1.08, contrast: 1.06 },
        dust: 1.4,
      },
      sunset: {
        name: '日落',
        palette: { sun: '#ff9a5a', sunElev: 8, sunAzim: 255, skyTop: '#d0603c', skyHorizon: '#f2b04a' },
        look: { shadowTint: '#4a2448', shadowMix: 0.38, ambSky: '#c48a8a', ambGround: '#9a6a5a', sunStrength: 1.05, hazeNear: '#f0a05a', hazeFar: '#b0607a', hazeDensity: 0.0017, skyTex: 'sunset.jpg', cloudTex: undefined, lift: '#140610', gain: '#fff0e0', saturation: 1.15 },
      },
    },
    palette: {
      skyTop: '#efcfa6',
      skyHorizon: '#f3dcb6',
      fog: '#d9a07a',
      fogDensity: 0.002,
      sun: '#fff0c8',
      sunIntensity: 1.35,
      sunElev: 52,
      sunAzim: 210,
      hemiSky: '#e8cfaa',
      hemiGround: '#8a4a2a',
      hemiIntensity: 0.6,
      grass: '#a8963e',
      grassDry: '#e3b55a',
      gravel: '#c95629',
      gravelDark: '#a84a22',
      dirt: '#b8552c',
      heath: '#9a6a48',
      rock: '#9a4e30',
      pine: '#5e6a2a',
      pineDark: '#353a16',
      birchLeaf: '#8a8a3a',
      birchBark: '#d8c8a8',
      bush: '#6e7a2e',
      water: '#5f7f74',
      mountainNear: '#a8786e',
      mountainFar: '#b58e8a',
      exposure: 1.0,
      forest: '#9a8a42',
      trunk: '#3a2218',
      track: '#d8693e',
      speckLight: '#e9a679',
      speckDark: '#5e2a1a',
    },
    look: {
      shadowTint: '#7a3326',
      shadowMix: 0.28,
      ambSky: '#e2c6a4',
      ambGround: '#a87a62',
      sunStrength: 1.06,
      terminator: 0.16,
      hazeNear: '#efcba2',
      hazeFar: '#d39a7c',
      hazeDensity: 0.0012,
      hazeMax: 0.8,
      hazeLow: -4,
      hazeFalloff: 10,
      hazeStart: 70,
      partMax: 0.66,
      cloud: '#fbecd2',
      cloudCover: 0.3,
      lift: '#0e0604',
      gain: '#fff8ec',
      saturation: 1.18,
      contrast: 1.15,
      bloom: 0.12,
      bloomThreshold: 0.92,
      vignette: 0.3,
      grain: 0.045,
    },
  },
  snow: {
    id: 'snow',
    name: '雪岭',
    art: 'snow',
    terrain: {
      octaves: [[42, 1600], [24, 600], [12, 240], [4.5, 100], [1.1, 40], [0.3, 14]],
      ridge: [120, 2400],
      maxGrade: 0.11,
      smooth: 220,
      bankSlope: 1.0,
      crestSpeed: 32,
    },
    road: { kind: 'snow', surface: Surface.Snow, shoulderSurface: Surface.Snow, offSurface: Surface.DeepSnow, crown: 0.04, shoulder: 0.5, ditchWidth: 2.8, ditchDepth: 0, rough: 0.03, rut: 0.05 },
    veg: { nearDensity: 2.4, farDensity: 1.1, birchShare: 0, bushDensity: 1.0, rockDensity: 0.15, treeLine: 2 },
    tex: { fine: 'road.jpg', peb: 'road.jpg', shoulder: 'snow_bank.jpg', grass: 'ground.jpg', forest: 'ground.jpg', rock: 'rock_snow.jpg', dirt: 'snow_bank.jpg', wall: 'ice.jpg' },
    fx: { dust: 1.3, dustColor: '#f4f4fa', dustOpacity: 0.62, stones: 0, spray: 'snow' },
    zones: SNOW_ZONES,
    defaultZone: 'forest',
    weathers: {
      snowfall: { name: '阴天飘雪', fall: 'snow' },
      cold: {
        name: '晴冷',
        palette: { sun: '#fff1dc', sunElev: 14, sunAzim: 220, skyTop: '#7fa3cf', skyHorizon: '#d8dcef', sunIntensity: 1.25 },
        look: { shadowTint: '#5664a8', shadowMix: 0.42, sunStrength: 1.0, ambSky: '#a9b4dc', ambGround: '#a4a8c4', hazeNear: '#e2e4f2', hazeFar: '#a7b4d6', hazeDensity: 0.001, hazeStart: 70, skyTex: undefined, cloudTex: 'clouds_1.png', cloudCover: 0.3, sunDisc: 1, saturation: 1.15, contrast: 1.14 },
      },
      night: {
        name: '夜',
        night: true,
        palette: { sun: '#9fb2e6', sunElev: 30, sunAzim: 150, sunIntensity: 0.4, skyTop: '#141c3a', skyHorizon: '#2c3560' },
        look: { shadowTint: '#0d1230', shadowMix: 0.55, sunStrength: 0.34, ambSky: '#4a5888', ambGround: '#38406a', hazeNear: '#1c2446', hazeFar: '#222c52', hazeDensity: 0.0028, hazeStart: 40, hazeMax: 0.9, skyTex: 'night.jpg', cloudTex: undefined, cloud: '#2c3458', cloudCover: 0.25, sunDisc: 0, stars: 0.8, lift: '#04060e', gain: '#f0f4ff', saturation: 1.05, contrast: 1.1, bloom: 0.25, bloomThreshold: 0.75, headlights: 1 },
        fall: 'snow',
      },
    },
    palette: {
      skyTop: '#aaa8c2',
      skyHorizon: '#c4c2d4',
      fog: '#a19eb8',
      fogDensity: 0.003,
      sun: '#f2eef8',
      sunIntensity: 1.1,
      sunElev: 32,
      sunAzim: 200,
      hemiSky: '#c4c2d8',
      hemiGround: '#9c9ab0',
      hemiIntensity: 0.7,
      grass: '#dad9e6',
      grassDry: '#e4e3ee',
      gravel: '#dedde6',
      gravelDark: '#c6c6d6',
      dirt: '#7a6e72',
      heath: '#b6b4c6',
      rock: '#3e4152',
      pine: '#3a3f58',
      pineDark: '#22263a',
      birchLeaf: '#6a6e80',
      birchBark: '#5a5050',
      bush: '#4c5064',
      water: '#c4d2e2',
      mountainNear: '#8f8daa',
      mountainFar: '#b6b3c9',
      exposure: 1.0,
      forest: '#cfcee0',
      trunk: '#3a2e2e',
    },
    look: {
      shadowTint: '#7f84b8',
      shadowMix: 0.45,
      ambSky: '#b8b6d0',
      ambGround: '#a9a8c0',
      sunStrength: 0.9,
      terminator: 0.22,
      hazeNear: '#d4d2e2',
      hazeFar: '#a6a3bf',
      hazeDensity: 0.0024,
      hazeMax: 0.88,
      hazeLow: -4,
      hazeFalloff: 12,
      hazeStart: 45,
      partMax: 0.7,
      cloud: '#d8d6e4',
      cloudCover: 0.6,
      skyTex: 'snowfall.jpg',
      sunDisc: 0,
      lift: '#0a0a18',
      gain: '#f4f2fa',
      saturation: 1.1,
      contrast: 1.12,
      bloom: 0.06,
      bloomThreshold: 0.97,
      vignette: 0.3,
      grain: 0.045,
    },
  },
  coast: {
    id: 'coast',
    name: '山海公路',
    art: 'coast',
    terrain: {
      octaves: [[26, 1400], [16, 520], [9, 220], [3.5, 90], [0.9, 35], [0.3, 12]],
      ridge: [70, 2200],
      maxGrade: 0.12,
      smooth: 150,
      bankSlope: 2.2,
      crestSpeed: 36,
      coast: { amp: 48, width: 380, seaLevel: -40 },
    },
    road: { kind: 'asphalt', surface: Surface.AsphaltDry, shoulderSurface: Surface.Gravel, offSurface: Surface.Grass, crown: 0.06, shoulder: 0.9, ditchWidth: 1.2, ditchDepth: 0.22, rough: 0.008, rut: 0.004 },
    veg: { nearDensity: 2.0, farDensity: 1.0, birchShare: 0, bushDensity: 1.3, rockDensity: 0.2, treeLine: 4 },
    tex: { fine: 'road.jpg', peb: 'road_worn.jpg', shoulder: 'shoulder.jpg', grass: 'ground.jpg', forest: 'ground.jpg', rock: 'cliff_rock.jpg', dirt: 'ground.jpg', wall: 'stone_wall.jpg' },
    fx: { dust: 0.8, stones: 0.6 },
    zones: COAST_ZONES,
    defaultZone: 'cliff',
    weathers: {
      clear: { name: '晴' },
      wet: {
        name: '雨后湿地',
        palette: { sun: '#e6e8ea', sunElev: 34, skyTop: '#6d8798', skyHorizon: '#b9c6cc', sunIntensity: 1.0 },
        look: { shadowMix: 0.2, sunStrength: 0.86, ambSky: '#a9bac4', ambGround: '#8a949a', hazeNear: '#c4ced2', hazeFar: '#90a6b2', hazeDensity: 0.0022, hazeStart: 50, skyTex: 'wet.jpg', cloudTex: undefined, sunDisc: 0, saturation: 1.05, contrast: 1.1 },
        grip: { [Surface.AsphaltDry]: Surface.AsphaltWet, [Surface.Gravel]: Surface.Dirt },
        dust: 0.1,
        wet: 1,
        // the last of the rain: a sparse drizzle under low cloud
        fall: 'rain',
      },
      night: {
        name: '夜',
        night: true,
        palette: { sun: '#a8bce8', sunElev: 35, sunAzim: 120, sunIntensity: 0.4, skyTop: '#101a38', skyHorizon: '#26355c' },
        look: { shadowTint: '#0c1230', shadowMix: 0.55, sunStrength: 0.36, ambSky: '#40507e', ambGround: '#34405e', hazeNear: '#1a2444', hazeFar: '#1e2a4e', hazeDensity: 0.0016, hazeStart: 60, hazeMax: 0.85, skyTex: 'night.jpg', cloudTex: undefined, cloud: '#2c3458', cloudCover: 0.25, sunDisc: 0, stars: 1, lift: '#04060e', gain: '#f0f4ff', saturation: 1.05, contrast: 1.1, bloom: 0.25, bloomThreshold: 0.75, headlights: 1 },
      },
    },
    palette: {
      skyTop: '#7fb6cc',
      skyHorizon: '#b4d6dc',
      fog: '#8fb0bf',
      fogDensity: 0.002,
      sun: '#f6eed6',
      sunIntensity: 1.3,
      sunElev: 42,
      sunAzim: 140,
      hemiSky: '#a9cad6',
      hemiGround: '#7a6a52',
      hemiIntensity: 0.62,
      grass: '#8a8c3c',
      grassDry: '#c9ae66',
      gravel: '#8e8984',
      gravelDark: '#b6a48a',
      dirt: '#c48a5c',
      heath: '#9a8a5a',
      rock: '#d8b48e',
      pine: '#3e5a2e',
      pineDark: '#24361f',
      birchLeaf: '#8e9a6a',
      birchBark: '#8a7a6a',
      bush: '#5a6e34',
      water: '#3a88b4',
      mountainNear: '#6e98aa',
      mountainFar: '#9ec0cc',
      exposure: 1.0,
      forest: '#7a7a42',
      sea: '#3786b2',
      paint: '#f1eee4',
      trunk: '#5a4232',
    },
    look: {
      shadowTint: '#3f4270',
      shadowMix: 0.3,
      ambSky: '#a4c2d6',
      ambGround: '#9a9488',
      sunStrength: 1.06,
      terminator: 0.16,
      hazeNear: '#d9e2dc',
      hazeFar: '#8db4c6',
      hazeDensity: 0.0011,
      hazeMax: 0.8,
      hazeLow: -30,
      hazeFalloff: 20,
      hazeStart: 70,
      partMax: 0.55,
      cloud: '#f6f1e2',
      cloudCover: 0.35,
      cloudTex: 'clouds_1.png',
      lift: '#050a14',
      gain: '#fffbf2',
      saturation: 1.18,
      contrast: 1.15,
      bloom: 0.14,
      bloomThreshold: 0.9,
      vignette: 0.3,
      grain: 0.045,
    },
  },
};

/** zone definition by id with the environment default as fallback */
export function zoneDef(env: EnvDef, id: string | undefined): ZoneDef {
  return env.zones[id || env.defaultZone] ?? env.zones[env.defaultZone];
}

/** the environment with a weather variant's palette/look overrides applied */
export function envWithWeather(env: EnvDef, weather?: string): { env: EnvDef; weather: WeatherDef; weatherId: string } {
  const ids = Object.keys(env.weathers);
  const id = weather && env.weathers[weather] ? weather : ids[0];
  const w = env.weathers[id];
  if (id === ids[0] && !w.palette && !w.look) return { env, weather: w, weatherId: id };
  return { env: { ...env, palette: { ...env.palette, ...w.palette }, look: { ...env.look, ...w.look } }, weather: w, weatherId: id };
}
