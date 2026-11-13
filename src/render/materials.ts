// Central material/texture registry and palette.
//   public/assets/tex/<artKey>/<slot>.jpg  (or <slot>_1.jpg, first variant) → replaces the procedural placeholder.
// Palette: src/data/envs.ts (palette + look), overridden by public/assets/palettes.json (art pipeline) where it has a key.
// Ground textures are used as *luminance detail only* (normalised by their mean): every colour comes from the palette,
// so the screen keeps the poster colour blocks no matter what hue the generated textures have.
import * as THREE from 'three';
import assetFiles from 'virtual:asset-list';
import { ENVS, type EnvDef } from '../data/envs';
import { posterize } from './look';
import { PROC_TEX } from './texgen';

const files = new Set(assetFiles);
export const hasAsset = (path: string) => files.has(path);

export interface Palette {
  skyTop: THREE.Color; skyHorizon: THREE.Color; fog: THREE.Color; fogDensity: number;
  sun: THREE.Color; sunIntensity: number; sunElev: number; sunAzim: number;
  hemiSky: THREE.Color; hemiGround: THREE.Color; hemiIntensity: number;
  road: THREE.Color; shoulder: THREE.Color; grass: THREE.Color; grassDry: THREE.Color; forest: THREE.Color; dirt: THREE.Color; heath: THREE.Color; rock: THREE.Color;
  pine: THREE.Color; pineDark: THREE.Color; birchLeaf: THREE.Color; birchBark: THREE.Color; bush: THREE.Color; trunk: THREE.Color;
  water: THREE.Color; mountainNear: THREE.Color; mountainFar: THREE.Color; shadow: THREE.Color; sea: THREE.Color; paint: THREE.Color; track?: THREE.Color; speckLight?: THREE.Color; speckDark?: THREE.Color;
  look: {
    shadowTint: THREE.Color; shadowMix: number; ambSky: THREE.Color; ambGround: THREE.Color; sunStrength: number; terminator: number;
    hazeNear: THREE.Color; hazeFar: THREE.Color; hazeDensity: number; hazeMax: number; hazeLow: number; hazeFalloff: number; hazeStart?: number; partMax?: number;
    cloud: THREE.Color; cloudCover: number; skyTex?: string; cloudTex?: string; sunDisc?: number; stars?: number; headlights?: number; liftHex: string; gainHex: string;
    saturation: number; contrast: number; bloom: number; bloomThreshold: number; vignette: number; grain: number;
  };
  /** where each colour came from, for the debug overlay */
  source: string;
}

const C = (hex: string) => new THREE.Color(hex);

/** art pipeline key for an environment (palettes.json / tex folder) */
export const ART_KEY: Record<string, string> = Object.fromEntries(Object.values(ENVS).map((e) => [e.id, e.art]));

/** artPalette: apply public/assets/palettes.json on top (north default weather only: the other environments and the
 *  weather variants carry their own tuned colours in envs.ts) */
export async function loadPalette(env: EnvDef, artPalette = true): Promise<Palette> {
  const p = env.palette, L = env.look;
  const pal: Palette = {
    skyTop: C(p.skyTop), skyHorizon: C(p.skyHorizon), fog: C(p.fog), fogDensity: p.fogDensity,
    sun: C(p.sun), sunIntensity: p.sunIntensity, sunElev: p.sunElev, sunAzim: p.sunAzim,
    hemiSky: C(p.hemiSky), hemiGround: C(p.hemiGround), hemiIntensity: p.hemiIntensity,
    road: C(p.gravel), shoulder: C(p.gravelDark), grass: C(p.grass), grassDry: C(p.grassDry), forest: p.forest ? C(p.forest) : C(p.grass).lerp(C(p.pineDark), 0.45).lerp(C(p.dirt), 0.2), dirt: C(p.dirt), heath: C(p.heath), rock: C(p.rock),
    pine: C(p.pine), pineDark: C(p.pineDark), birchLeaf: C(p.birchLeaf), birchBark: C(p.birchBark), bush: C(p.bush), trunk: C(p.trunk ?? '#7a3f2b'),
    water: C(p.water), mountainNear: C(p.mountainNear), mountainFar: C(p.mountainFar), shadow: C(L.shadowTint), sea: C(p.sea ?? p.water), paint: C(p.paint ?? '#f1eee4'), track: p.track ? C(p.track) : undefined, speckLight: p.speckLight ? C(p.speckLight) : undefined, speckDark: p.speckDark ? C(p.speckDark) : undefined,
    look: {
      shadowTint: C(L.shadowTint), shadowMix: L.shadowMix, ambSky: C(L.ambSky), ambGround: C(L.ambGround), sunStrength: L.sunStrength, terminator: L.terminator,
      hazeNear: C(L.hazeNear), hazeFar: C(L.hazeFar), hazeDensity: L.hazeDensity, hazeMax: L.hazeMax, hazeLow: L.hazeLow, hazeFalloff: L.hazeFalloff, hazeStart: L.hazeStart, partMax: L.partMax,
      cloud: C(L.cloud), cloudCover: L.cloudCover, skyTex: L.skyTex, cloudTex: L.cloudTex, sunDisc: L.sunDisc, stars: L.stars, headlights: L.headlights, liftHex: L.lift, gainHex: L.gain,
      saturation: L.saturation, contrast: L.contrast, bloom: L.bloom, bloomThreshold: L.bloomThreshold, vignette: L.vignette, grain: L.grain,
    },
    source: 'envs.ts',
  };
  const key = ART_KEY[env.id] ?? env.id;
  if (artPalette && hasAsset('/assets/palettes.json')) {
    try {
      const j = await (await fetch('/assets/palettes.json')).json();
      const a = j?.envs?.[key];
      if (a) {
        // the art palette is authoritative for the big colour blocks it was sampled for
        const set = (c: THREE.Color, v?: string) => { if (v) c.set(v); };
        set(pal.road, a.road); set(pal.shoulder, a.shoulder); set(pal.rock, a.rock);
        if (a.skyTop) pal.skyTop.lerp(C(a.skyTop), 0.2); set(pal.skyHorizon, a.skyHorizon); set(pal.sun, a.sunColor);
        set(pal.look.hazeFar, a.fogColor); set(pal.mountainFar, a.distant);
        set(pal.look.shadowTint, a.shadowColor); set(pal.shadow, a.shadowColor);
        if (a.vegLight) pal.grassDry.lerp(C(a.vegLight), 0.5);
        pal.source = `palettes.json:${key} + envs.ts`;
      }
    } catch { /* keep defaults */ }
  }
  return pal;
}

const texCache = new Map<string, THREE.Texture>();
let pending = 0;
/** art textures still loading (screenshots wait for 0) */
export const artPending = () => pending;
const loader = new THREE.TextureLoader();

function meanLum(img: CanvasImageSource) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
  return s / 256;
}

/** texture for a slot: art file if present, else procedural placeholder. Always returns immediately; art swaps in when loaded.
 *  userData.mean = mean luminance (for detail normalisation). */
export function slotTexture(envId: string, slot: string, opts: { repeat?: boolean; srgb?: boolean; file?: string } = {}) {
  const key = ART_KEY[envId] ?? envId;
  const id = `${key}/${opts.file ?? slot}`;
  let t = texCache.get(id);
  if (t) return t;
  const gen = PROC_TEX[slot];
  const cv = gen ? gen() : document.createElement('canvas');
  const tex: THREE.Texture = new THREE.Texture(cv as never);
  tex.needsUpdate = true;
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat !== false) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; }
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.userData.mean = PROC_TEX[slot] ? meanLum(cv) : 0.5;
  const candidates = opts.file ? [`/assets/tex/${key}/${opts.file}`] : [`/assets/tex/${key}/${slot}.jpg`, `/assets/tex/${key}/${slot}_1.jpg`, `/assets/tex/${key}/${slot}.png`, `/assets/tex/${key}/${slot}_1.png`];
  const art = candidates.find(hasAsset);
  if (art) {
    pending++;
    loader.load(art, (img) => {
      pending--;
      // size changes after the first upload need a fresh GPU texture (immutable texStorage)
      tex.dispose();
      tex.image = img.image as never;
      tex.userData.mean = meanLum(img.image as CanvasImageSource);
      tex.needsUpdate = true;
      tex.userData.source = art;
    }, undefined, () => { pending--; });
  }
  tex.userData.source = art ?? 'procedural';
  texCache.set(id, tex);
  return tex;
}

/** load a plain image texture (sprites, billboards); counts toward artPending */
export function imageTexture(url: string, srgb = true, onLoad?: (t: THREE.Texture) => void) {
  const cached = texCache.get(url);
  if (cached) return cached;
  pending++;
  const t = loader.load(url, (tt) => { pending--; onLoad?.(tt); }, undefined, () => { pending--; });
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  texCache.set(url, t);
  return t;
}

const meanU = (t: THREE.Texture) => ({ get value() { return (t.userData.mean as number) || 0.5; } });

/**
 * Terrain + road material: poster Lambert with
 *  - a procedural gravel road drawn per pixel from the road coordinates attribute `aRoad` = (s, d, racing line, inner-corner cut):
 *    flat pale sand, fine speckle, two firm lighter wheel tracks following the line, loose darker gravel in the
 *    centre ridge and outer bands, ragged grass edge, cut dirt on the inside of corners;
 *  - off-road ground from `surf` = (–, –, dirt, forest) and `tint` = dry grass, plus slope → dirt bank → rock.
 *  Textures only add luminance detail.
 */
export interface GroundOpts {
  halfWidth: number; edge1: number; edge2: number;
  /** road shading: 0 gravel, 1 asphalt, 2 snow */
  kind: number;
  /** wet road (weather) 0..1 */
  wet: number;
  /** env.tex file names per slot */
  tex: EnvDef['tex'];
  /** sea level (coast: waterline foam, wet rock); omit = no sea */
  sea?: number;
}

export function groundMaterial(envId: string, pal: Palette, road: GroundOpts) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const f = road.tex;
  const T = (slot: string, file?: string) => slotTexture(envId, slot, { srgb: false, file });
  const tFine = T('gravel_road', f.fine ?? 'gravel_road_2.jpg');
  const tPeb = T('gravel_road', f.peb);
  const tSh = T('gravel_shoulder', f.shoulder);
  const tGrass = T('grass', f.grass);
  const tForest = T('forest_floor', f.forest);
  const tRock = T('rock', f.rock);
  const tDirt = T('dirt_bank', f.dirt);
  const tWall = slotTexture(envId, 'rock', { srgb: true, file: f.wall ?? f.rock });
  const road1 = pal.road.clone();
  // the gravel colours for a gravel stretch on an asphalt road come from the shoulder (sandy) colour
  const grav = road.kind === 1 ? pal.shoulder.clone().lerp(new THREE.Color('#d8c4a2'), 0.4) : road1.clone();
  const u: Record<string, THREE.IUniform> = {
    tFine: { value: tFine }, tPeb: { value: tPeb }, tSh: { value: tSh }, tGrass: { value: tGrass }, tForest: { value: tForest }, tRock: { value: tRock }, tDirt: { value: tDirt }, tWall: { value: tWall },
    mFine: meanU(tFine), mPeb: meanU(tPeb), mSh: meanU(tSh), mGrass: meanU(tGrass), mForest: meanU(tForest), mRock: meanU(tRock), mDirt: meanU(tDirt),
    cRoad: { value: road1 }, cGrav: { value: grav },
    cTrack: { value: pal.track ? pal.track.clone() : grav.clone().lerp(new THREE.Color('#fff4e2'), 0.32) },
    cLoose: { value: grav.clone().lerp(pal.dirt, 0.28).multiplyScalar(0.9) },
    cSpeckD: { value: pal.speckDark ? pal.speckDark.clone() : new THREE.Color(road.kind === 2 ? '#8a90b0' : '#3b3f52') }, cSpeckL: { value: pal.speckLight ? pal.speckLight.clone() : new THREE.Color('#fff8ec') },
    cShoulder: { value: pal.shoulder }, cGrass: { value: pal.grass }, cGrassDry: { value: pal.grassDry }, cForest: { value: pal.forest },
    cDirt: { value: pal.dirt }, cRock: { value: pal.rock }, cHeath: { value: pal.heath }, cHeather: { value: new THREE.Color(envId === 'north' ? '#7d5a78' : pal.heath.getStyle()).lerp(pal.heath, envId === 'north' ? 0 : 0.6) },
    cPaint: { value: pal.paint.clone() }, cSky: { value: pal.skyTop.clone().lerp(pal.skyHorizon, 0.5) }, cShadeT: { value: pal.look.shadowTint.clone() },
    uHW: { value: road.halfWidth }, uE1: { value: road.edge1 }, uE2: { value: road.edge2 },
    uKind: { value: road.kind }, uWet: { value: road.wet }, uWallTex: { value: f.wall && road.kind === 1 ? 1 : 0 },
    uSea: { value: road.sea ?? -1e5 },
  };
  posterize(m, {
    key: 'ground-v5', carShadow: true, uniforms: u,
    edit: (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 surf;\nattribute float tint;\nattribute vec4 aRoad;\nvarying vec4 vSurf;\nvarying float vTint;\nvarying vec4 vRoad;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSurf = surf; vTint = tint; vRoad = aRoad;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = mat3(modelMatrix) * objectNormal; vWNormal = dot(vWNormal, vWNormal) > 1e-8 ? normalize(vWNormal) : vec3(0.0, 1.0, 0.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tFine, tPeb, tSh, tGrass, tForest, tRock, tDirt, tWall;
uniform float mFine, mPeb, mSh, mGrass, mForest, mRock, mDirt;
uniform vec3 cRoad, cGrav, cTrack, cLoose, cSpeckD, cSpeckL, cShoulder, cGrass, cGrassDry, cForest, cDirt, cRock, cHeath, cHeather, cPaint, cSky, cShadeT;
uniform float uHW, uE1, uE2, uKind, uWet, uWallTex, uSea;
varying vec4 vSurf; varying float vTint; varying vec4 vRoad; varying vec3 vWPos; varying vec3 vWNormal;
const vec3 LW = vec3(0.299, 0.587, 0.114);
float det(sampler2D t, float mean, vec2 p) { return dot(texture2D(t, p).rgb, LW) / max(mean, 0.05) - 1.0; }
float h11(float p) { return fract(sin(p * 127.1) * 43758.5453); }
float vn1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h11(i), h11(i + 1.0), f) * 2.0 - 1.0; }
vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
// crisp gravel: one jittered pebble per cell, anti-aliased by the screen footprint, fades out before it can shimmer.
// returns (dark pebble coverage, light pebble coverage)
vec2 pebbles(vec2 p, float cell, float density) {
  vec2 g = p / cell, i = floor(g), f = fract(g);
  vec2 r = h22(i);
  vec2 c = 0.2 + 0.6 * r;
  float rad = (0.08 + 0.17 * fract(r.x * 7.3)) * step(fract(r.y * 13.7), density);
  float d = length((f - c) * vec2(1.0, 0.8 + 0.4 * r.y)) - rad;
  float aa = fwidth(g.x) * 1.2 + 1e-4;
  float cov = (1.0 - smoothstep(-aa, aa, d)) * (1.0 - smoothstep(0.18, 0.4, aa));
  return fract(r.x * 31.1) < 0.62 ? vec2(cov, 0.0) : vec2(0.0, cov);
}
// anti-aliased band |x| < w
float band(float x, float w) { float aa = fwidth(x) + 1e-4; return 1.0 - smoothstep(w - aa, w + aa, abs(x)); }
vec3 gWetSheen = vec3(0.0);
`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gWetSheen;')
        .replace('#include <map_fragment>', `
vec2 wp = vWPos.xz;
vec2 wr = mat2(0.8, -0.6, 0.6, 0.8) * wp;
float s = vRoad.x, d = vRoad.y, ad = abs(d);
// ---------- off-road ground ----------
float macro = det(tGrass, mGrass, wr * 0.0093 + 0.21);
float g1 = det(tGrass, mGrass, wp * 0.21);
float g2 = det(tGrass, mGrass, wr * 0.063 + 0.5);
// tint < 0 marks sea-cliff rock (render/terrain.ts), otherwise it is the dry-grass amount
float cliffK = clamp(-vTint, 0.0, 1.0);
float dry = clamp(max(vTint, 0.0) + macro * 0.55 + g2 * 0.18, 0.0, 1.0);
vec3 col = mix(cGrass, cGrassDry, smoothstep(0.25, 0.75, dry));
col *= 1.0 + clamp(g1, -0.6, 0.6) * 0.1;
// moorland / scree: heath colour with darker patches
float heath = vSurf.y;
vec3 heathC = mix(cHeath, cHeather, smoothstep(0.15, 0.5, g2 + macro * 0.4) * 0.55) * (1.0 + clamp(g1, -0.6, 0.6) * 0.12);
col = mix(col, heathC, heath * smoothstep(-0.8, -0.15, macro + g2 * 0.3));
vec3 forestC = cForest * (1.0 + clamp(det(tForest, mForest, wp * 0.17), -0.7, 0.7) * 0.22);
col = mix(col, forestC, smoothstep(0.2, 0.7, vSurf.w + macro * 0.25));
vec3 dirtC = cDirt * (1.0 + clamp(det(tDirt, mDirt, wr * 0.16), -0.7, 0.7) * 0.25);
float slope = 1.0 - clamp(vWNormal.y, 0.0, 1.0);
float nearRoad = 1.0 - smoothstep(14.0, 24.0, ad);
// snow: banks stay snow (a touch bluer), only real rock faces show
float bankK = uKind > 1.5 ? 0.0 : 1.0;
float bank = smoothstep(0.2, 0.32, slope + g2 * 0.06) * nearRoad * bankK;
col = mix(col, dirtC, clamp(max(vSurf.z * smoothstep(-0.3, 0.3, macro + 0.15), bank), 0.0, 1.0));
if (uKind > 1.5) col = mix(col, mix(col, cShadeT * 1.15, 0.38), smoothstep(0.12, 0.4, slope));
vec3 rockC = cRock * (1.0 + clamp(det(tRock, mRock, (wr + vWPos.y * 0.7) * 0.085), -0.7, 0.7) * 0.4);
float rockK = smoothstep(0.42 - heath * 0.16, 0.52 - heath * 0.16, slope + macro * 0.08);
if (uKind > 1.5) rockK = smoothstep(0.62, 0.72, slope + macro * 0.1);
if (uWallTex > 0.5) {
  // coast: steep cut faces beside the road are dry-stone retaining walls (texture as albedo, vertical projection)
  vec2 nh = normalize(vWNormal.xz + vec2(1e-4));
  vec2 wuv = vec2((vWPos.x * nh.y - vWPos.z * nh.x) * 0.3, vWPos.y * 0.3);
  vec3 wallC = texture2D(tWall, wuv).rgb;
  float isWall = smoothstep(0.26, 0.36, slope) * (1.0 - smoothstep(10.0, 18.0, ad));
  rockC = mix(rockC, wallC, isWall);
  rockK = max(rockK, isWall);
}
col = mix(col, rockC, rockK);
if (cliffK > 0.0) {
  // sea cliff: horizontal strata in three rock tones (warped), dark crevices under each ledge, wet and dark above the waterline
  float yy = vWPos.y + vn1(wp.x * 0.045 + wp.y * 0.031) * 2.2 + vn1(wp.y * 0.11 - wp.x * 0.07) * 0.8;
  float lay = fract(yy / 3.3), lid = floor(yy / 3.3);
  float hs = h11(lid * 1.73 + 4.1);
  vec3 cc = hs < 0.36 ? cRock : hs < 0.7 ? cRock * vec3(0.84, 0.72, 0.62) : mix(cRock, vec3(0.97, 0.93, 0.85), 0.4);
  cc *= 1.0 - 0.38 * (1.0 - smoothstep(0.0, 0.14, lay));
  cc *= 1.0 + clamp(det(tRock, mRock, vec2((wp.x + wp.y) * 0.09, vWPos.y * 0.21)), -0.6, 0.6) * 0.32;
  cc = mix(cc, cc * vec3(0.5, 0.52, 0.55), 1.0 - smoothstep(uSea + 0.4, uSea + 2.6, vWPos.y));
  col = mix(col, cc, cliffK);
}
if (uSea > -1e4) {
  // surf: a broken cream line wherever ground meets the sea (cliff feet, reefs, beaches)
  float fn = vn1(wp.x * 0.35 + wp.y * 0.27 + uTime * 0.4) * 0.25;
  float foam = 1.0 - smoothstep(0.15 + fn, 0.6 + fn, abs(vWPos.y - uSea - 0.1));
  col = mix(col, vec3(0.96, 0.95, 0.9), foam * 0.85);
}
// ---------- road band ----------
if (ad < uE2 + 2.5) {
  float edgeN = vn1(s * 0.9 + sign(d) * 31.0) * 0.28 + vn1(s * 3.7 + sign(d) * 7.0) * 0.12;
  float cut = clamp(vRoad.w, 0.0, 1.0);
  // alternative surface flag: gravel stretch (asphalt env) / ice patch (snow env)
  float alt = clamp(vSurf.x, 0.0, 1.0);
  float gravK = uKind < 0.5 ? 1.0 : (uKind < 1.5 ? alt : 0.0);
  // shoulder: darker coarse gravel, ditch: grass with a dirt bottom; grass reaches into the shoulder in tufts
  vec3 shC = cShoulder * (1.0 + clamp(det(tSh, mSh, wr * 0.31), -0.7, 0.7) * 0.28);
  float grassIn = smoothstep(uHW + 0.35 + edgeN, uHW + 0.9 + edgeN, ad + g1 * 0.25);
  if (uKind > 0.5 && uKind < 1.5) grassIn = smoothstep(uE1 - 0.1 + edgeN * 0.5, uE1 + 0.5 + edgeN * 0.5, ad + g1 * 0.2);
  vec3 side = mix(shC, col, grassIn * (1.0 - cut * gravK));
  float ditch = smoothstep(uE1, uE1 + 0.5, ad) * (1.0 - smoothstep(uE2 - 0.4, uE2, ad));
  if (uKind < 1.5) side = mix(side, mix(col, dirtC, 0.35), ditch * 0.6);
  // inner corner: tyres cut the verge down to bare dirt (loose roads)
  float cutZone = cut * gravK * (1.0 - smoothstep(uHW + 0.4, uE2 + 1.5 + edgeN * 2.0, ad));
  side = mix(side, mix(dirtC, cShoulder, 0.35), cutZone);
  float t = d - vRoad.z, at = abs(t);
  float wob = vn1(s * 0.11) * 0.12 + vn1(s * 0.53) * 0.05;
  float track = 1.0 - smoothstep(0.14, 0.32, abs(at - 0.82 + wob));
  float loose = clamp(smoothstep(0.42, 0.22, at) * 0.85 + smoothstep(1.15, 1.6, at), 0.0, 1.0) * (1.0 - track);
  float fine = det(tFine, mFine, wp * 0.62) * 0.6 + det(tFine, mFine, wr * 1.45 + 0.31) * 0.4;
  float peb = det(tPeb, mPeb, wr * 0.47 + 0.17);
  vec3 rc = cRoad;
  if (gravK > 0.0) {
    // ----- gravel / earth road -----
    vec3 gc = mix(cGrav, cLoose, loose * 0.85);
    gc *= 1.0 + vn1(s * 0.07 + d * 0.3) * 0.035;
    gc = mix(gc, cTrack, track * 0.9);
    float sp = fine * mix(0.55, 0.2, track) + peb * mix(0.25, 0.75, loose);
    gc = mix(gc, cSpeckD, smoothstep(0.35, 0.95, -sp) * mix(0.55, 0.15, track));
    gc = mix(gc, cSpeckL, smoothstep(0.3, 0.8, sp) * 0.45);
    vec2 pb1 = pebbles(wp, 0.22, mix(0.16, 0.02, track) * (0.6 + 0.8 * loose));
    vec2 pb2 = pebbles(wr + 3.7, 0.07, mix(0.42, 0.1, track));
    gc = mix(gc, mix(gc, cSpeckD, 0.55), clamp(pb1.x * 0.9 + pb2.x * 0.7, 0.0, 1.0));
    gc = mix(gc, cSpeckL, clamp(pb1.y * 0.45 + pb2.y * 0.35, 0.0, 1.0));
    float prints = smoothstep(0.55, 0.95, vn1(t * 38.0 + vn1(s * 0.2) * 3.0)) * track * (1.0 - smoothstep(0.08, 0.3, fwidth(t * 38.0)));
    gc *= 1.0 - prints * 0.09;
    gc = mix(gc, mix(cLoose, cDirt, 0.4), cut * smoothstep(uHW - 1.2, uHW, ad) * 0.6);
    if (uWet > 0.0) {
      // damp gravel: darker, wet dark ruts where the tracks hold water
      gc *= mix(1.0, 0.72, uWet);
      float rutW = (1.0 - smoothstep(0.1, 0.35, abs(at - 0.82 + wob))) * smoothstep(0.35, 0.6, vn1(s * 0.09 + sign(t) * 3.0));
      gc = mix(gc, gc * 0.6, rutW * uWet);
      vec3 Vg = normalize(cameraPosition - vWPos);
      gWetSheen = cSky * pow(1.0 - clamp(Vg.y, 0.0, 1.0), 3.0) * 0.35 * rutW * uWet;
    }
    rc = gc;
  }
  if (uKind > 0.5 && uKind < 1.5 && gravK < 1.0) {
    // ----- asphalt: aggregate speckle, darker polished wheel tracks, repair patches, cracks, painted lines -----
    vec3 ac = cRoad * (1.0 + vn1(s * 0.05 + d * 0.2) * 0.04 + clamp(fine, -0.6, 0.6) * 0.05);
    float trk = 1.0 - smoothstep(0.25, 0.6, abs(abs(d) - uHW * 0.5 + wob * 0.5));
    ac *= 1.0 - trk * 0.08;
    vec2 pa = pebbles(wr * 1.3, 0.05, 0.35);
    ac = mix(ac, ac * 0.72, pa.x * 0.6); ac = mix(ac, ac * 1.25, pa.y * 0.5);
    // repair patches: rectangles along the lane, darker and smoother
    vec2 pc = vec2(s / 9.0, d / 2.2); vec2 pi = floor(pc); vec2 pr = h22(pi + 17.0);
    vec2 pf = abs(fract(pc) - 0.5);
    float patchK = step(pr.x, 0.18) * (1.0 - smoothstep(0.28 + 0.15 * pr.y, 0.3 + 0.15 * pr.y, max(pf.x * 1.1, pf.y)));
    ac = mix(ac, cRoad * 0.78, patchK);
    // cracks: thin dark wiggles
    float cr = band(vn1(s * 0.6 + floor(d * 1.3) * 7.0) * 0.6 + fract(d * 1.3) - 0.5, 0.01) * step(0.82, h11(floor(s / 6.0) + floor(d * 1.3) * 3.0));
    ac = mix(ac, ac * 0.55, cr * 0.8);
    // markings: dashed centre line, solid edge lines; worn a little
    float wear = 0.82 + 0.18 * smoothstep(-0.2, 0.4, fine);
    float centre = band(d, 0.06) * step(fract(s / 12.0), 0.45);
    float edgeL = band(ad - (uHW - 0.28), 0.06);
    ac = mix(ac, cPaint, clamp(centre + edgeL, 0.0, 1.0) * wear);
    rc = mix(ac, rc, gravK);
    // wet: darker asphalt, damp patches in the tracks, a sky-coloured fresnel sheen, the sun's glare streak on the
    // glossy surface, and standing puddles as crisp mirror blocks (all emissive, so they also show in the shade)
    if (uWet > 0.0) {
      float pud = smoothstep(0.15, 0.55, fine * 0.5 + vn1(s * 0.3 + d * 1.7) * 0.4 + trk * 0.3) * uWet;
      float pool = smoothstep(0.5, 0.56, vn1(s * 0.13 + floor(d * 0.6) * 3.7) * 0.55 + vn1(s * 0.7 + d * 0.9) * 0.25 + trk * 0.3 + fine * 0.08) * uWet;
      rc *= mix(1.0, 0.52, uWet) * (1.0 - pud * 0.15);
      vec3 V = normalize(cameraPosition - vWPos);
      float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
      vec3 Rw = reflect(-V, normalize(vec3(fine * 0.02, 1.0, peb * 0.02)));
      float rs = max(dot(Rw, uSunW), 0.0);
      float onRoad = 1.0 - smoothstep(uHW, uHW + 0.3, ad);
      vec3 glare = uSunCol * uSunStrength * (pow(rs, 18.0) * 0.32 + pow(rs, 160.0) * 1.3);
      gWetSheen = (cSky * (0.12 + 0.6 * fres) * (0.4 + 0.6 * pud) + glare * (0.55 + 0.45 * pud)) * uWet * onRoad;
      gWetSheen = mix(gWetSheen, cSky * (0.5 + 0.45 * fres) + glare * 0.9, pool * onRoad * 0.85);
      rc = mix(rc, rc * 0.35, pool * onRoad);
    }
  }
  if (uKind > 1.5) {
    // ----- compacted snow: white, blue-grey ruts in the wheel tracks, ploughed ridges, ice patches -----
    vec3 sc = cRoad * (1.0 + clamp(fine, -0.6, 0.6) * 0.04);
    float rut = 1.0 - smoothstep(0.1, 0.35, abs(at - 0.85 + wob));
    float lines = smoothstep(0.4, 0.9, vn1(t * 22.0 + vn1(s * 0.15) * 4.0)) * (1.0 - smoothstep(0.08, 0.3, fwidth(t * 22.0)));
    sc = mix(sc, mix(cRoad, cShadeT, 0.5), rut * (0.45 + 0.3 * lines));
    sc = mix(sc, cRoad * 1.03, loose * 0.3);
    vec2 pb = pebbles(wp, 0.12, 0.18 * loose);
    sc = mix(sc, mix(sc, cShadeT, 0.25), pb.x * 0.6);
    // ice: glossy blue-white sheet with streaks
    float iceK = alt * (1.0 - smoothstep(uHW - 0.4, uHW + 0.3, ad));
    vec3 ice = mix(vec3(0.62, 0.74, 0.86), vec3(0.86, 0.92, 0.97), smoothstep(-0.3, 0.6, fine + vn1(s * 0.8 + d * 3.0) * 0.4));
    sc = mix(sc, ice, iceK * 0.85);
    if (iceK > 0.0) { vec3 V = normalize(cameraPosition - vWPos); gWetSheen = cSky * pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0) * 0.45 * iceK; }
    rc = sc;
    // walls/verge: ploughed snow (vRoad.w = wall height). The face toward the road is blue-grey with plough-cut blocks
    // and a dirty band at the foot, grey streaks of road grime; the rounded crest catches the light
    side = mix(col, cShoulder, (1.0 - smoothstep(uHW, uE1 + 0.3, ad)) * 0.6);
    float wallH = vRoad.w;
    float hasWall = smoothstep(0.2, 0.5, wallH);
    float faceZ = smoothstep(uE1 - 0.15, uE1 + 0.25, ad) * (1.0 - smoothstep(uE2 - 0.5, uE2 + 0.1, ad));
    vec2 bc = vec2(s / 1.9 + sign(d) * 17.0, vWPos.y * 1.9);
    float blk = h22(floor(bc + vec2(floor(bc.y) * 0.5, 0.0))).x;
    vec3 faceC = mix(cRoad, cShadeT, 0.5) * (0.91 + 0.15 * blk);
    vec3 grime = mix(cRoad * 0.82, cDirt, 0.3);
    float foot = 1.0 - smoothstep(uE1 + 0.1, uE1 + 0.55 + 0.25 * vn1(s * 0.4 + d), ad);
    float streak = smoothstep(0.45, 0.8, vn1(s * 0.21 + sign(d) * 5.0)) * band(fract(vWPos.y * 1.1 + vn1(s * 0.13) * 0.4) - 0.5, 0.07);
    faceC = mix(faceC, grime, clamp(foot * 0.75 + streak * 0.45, 0.0, 1.0));
    side = mix(side, faceC, faceZ * hasWall * 0.9);
    float crest = smoothstep(uE2 - 0.7, uE2 - 0.15, ad) * (1.0 - smoothstep(uE2 + 0.6, uE2 + 1.6, ad)) * hasWall;
    side = mix(side, cRoad * 1.06, crest * 0.6);
    gWetSheen += vec3(0.07, 0.07, 0.08) * crest * min(uSunStrength, 1.0);
    // no wall: the old soft shading of the verge bank
    float face = smoothstep(uE1 - 0.2, uE1 + 0.4, ad) * (1.0 - smoothstep(uE1 + 0.9, uE1 + 1.6, ad));
    side = mix(side, mix(side, cShadeT * 1.2, 0.35), face * smoothstep(0.1, 0.35, slope) * (1.0 - hasWall));
  }
  float roadW = 1.0 - smoothstep(uHW - 0.1 + edgeN * 0.6 * gravK, uHW + 0.25 + edgeN * 0.6 * gravK, ad);
  col = mix(side, rc, roadW);
}
diffuseColor.rgb *= col;
`);
    },
  });
  return { material: m, uniforms: u };
}

/** flat Lambert with vertex colours (legacy helper) */
export function vcolMaterial(opts: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });
}
