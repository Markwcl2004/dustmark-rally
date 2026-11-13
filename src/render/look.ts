// "Poster" look: one place for the stylised lighting model, the analytic car shadow and the post chain.
//
//  - posterize(material): patches a MeshLambertMaterial so the sun term is a hard-edged lit/shade split (shadow map ×
//    N·L with a narrow terminator), the shade side is pulled toward the environment's blue shadow tint, and ambient comes
//    from a sky/ground hemisphere. All patched materials share LOOK uniforms, so retuning is live.
//  - PostFX: scene → MSAA half-float target (+ depth) → bloom (¼ res) → final pass: aerial perspective from depth
//    (warm near haze → cool far haze, height fog, sun glow), bloom, colour grade (lift/gain/sat/contrast), vignette, grain.
//    Fog is done here instead of per material, so it also covers materials this module does not own (car).
import * as THREE from 'three';
import type { Palette } from './materials';
import { SOFT } from './particles';


/** shared uniforms of every posterized material and of the post chain */
export const LOOK = {
  uShadeTint: { value: new THREE.Color() },
  uShadeMix: { value: 0.4 },
  uAmbSky: { value: new THREE.Color() },
  uAmbGround: { value: new THREE.Color() },
  uSunCol: { value: new THREE.Color() },
  uSunStrength: { value: 1 },
  uSunTint: { value: 0.3 },
  uTerm: { value: 0.16 },
  uTime: { value: 0 },
  // analytic car shadow (ground only): world → car-local, two boxes (centre.xyz, half extents)
  uCarInv: { value: new THREE.Matrix4() },
  uCarPos: { value: new THREE.Vector3(0, -1e5, 0) },
  uCarB1c: { value: new THREE.Vector3() }, uCarB1h: { value: new THREE.Vector3(0.9, 0.3, 2) },
  uCarB2c: { value: new THREE.Vector3() }, uCarB2h: { value: new THREE.Vector3(0.75, 0.3, 1.1) },
  uSunW: { value: new THREE.Vector3(0, 1, 0) },
  /** headlights (night): strength, colour */
  uHead: { value: 0 },
  uHeadCol: { value: new THREE.Color(1.0, 0.9, 0.72).multiplyScalar(2.6) },
  /** vegetation geometry → billboard cross-fade band (m from the camera) */
  uLodFade: { value: new THREE.Vector2(180, 220) },
};

export function setLookFromPalette(pal: Palette) {
  const L = pal.look;
  LOOK.uShadeTint.value.copy(L.shadowTint);
  LOOK.uShadeMix.value = L.shadowMix;
  LOOK.uAmbSky.value.copy(L.ambSky);
  LOOK.uAmbGround.value.copy(L.ambGround);
  LOOK.uSunCol.value.copy(pal.sun);
  LOOK.uSunStrength.value = L.sunStrength;
  LOOK.uTerm.value = L.terminator;
}

const POSTER_PARS = /* glsl */ `
uniform vec3 uShadeTint, uAmbSky, uAmbGround, uSunCol;
uniform float uShadeMix, uSunStrength, uSunTint, uTerm, uTime;
uniform vec2 uLodFade;
uniform mat4 uCarInv; uniform vec3 uCarPos; uniform float uHead; uniform vec3 uHeadCol;
#ifdef POSTER_CAR_SHADOW
uniform vec3 uCarB1c, uCarB1h, uCarB2c, uCarB2h, uSunW;
float boxHit(vec3 o, vec3 d, vec3 c, vec3 h) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (c - h - o) * inv, t1 = (c + h - o) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float a = max(max(tn.x, tn.y), tn.z), b = min(min(tf.x, tf.y), tf.z);
  return (b > max(a, 0.0)) ? 1.0 : 0.0;
}
float carShadow(vec3 wp) {
  if (distance(wp.xz, uCarPos.xz) > 9.0) return 1.0;
  vec3 o = (uCarInv * vec4(wp, 1.0)).xyz;
  vec3 d = normalize(mat3(uCarInv) * uSunW);
  return 1.0 - max(boxHit(o, d, uCarB1c, uCarB1h), boxHit(o, d, uCarB2c, uCarB2h));
}
#endif
`;

const POSTER_LIGHT = /* glsl */ `
{
  vec3 Nv = normal;
  // degenerate (zero-length) normals would turn into NaN and get smeared into black blocks by the bloom blur
  if (any(isnan(Nv)) || dot(Nv, Nv) < 1e-8) Nv = vec3(0.0, 0.0, 1.0);
  vec3 Nw = inverseTransformDirection(Nv, viewMatrix);
  #ifdef POSTER_FLAT_NORMAL
  Nw = vec3(0.0, 1.0, 0.0); Nv = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
  #endif
  float ndl = 0.0, sh = 1.0;
  #if NUM_SUN_LIGHTS > 0
    ndl = dot(Nv, sunLights[0].direction);
    #if defined(USE_SHADOWMAP) && NUM_SUN_LIGHT_SHADOWS > 0
      sh = receiveShadow ? getSunShadow(sunShadowMap[0], sunLightShadows[0], 0) : 1.0;
    #endif
  #endif
  #ifdef POSTER_CAR_SHADOW
    vec3 pw = transpose(mat3(viewMatrix)) * (-vViewPosition - viewMatrix[3].xyz);
    sh *= carShadow(pw);
  #endif
  #ifdef POSTER_WRAP
  ndl = ndl * 0.5 + 0.5;
  #endif
  float lit = smoothstep(-uTerm * 0.35, uTerm, ndl) * sh;
  vec3 albedo = diffuseColor.rgb;
  float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
  vec3 amb = mix(uAmbGround, uAmbSky, Nw.y * 0.5 + 0.5);
  vec3 shade = mix(albedo * amb, uShadeTint * (0.25 + 1.1 * lum), uShadeMix);
  vec3 sunlit = albedo * mix(vec3(1.0), uSunCol, uSunTint) * uSunStrength;
  // gentle form shading on the lit side: faces turned away read a step darker (two-tone poster modelling)
  sunlit *= mix(0.84, 1.0, smoothstep(0.12, 0.55, ndl));
  reflectedLight.directDiffuse = vec3(0.0);
  reflectedLight.indirectDiffuse = mix(shade, sunlit, lit);
  // headlights: an analytic beam from the player's car (car-local: forward = -z), wide and low, fading with distance
  if (uHead > 0.0) {
    vec3 pwh = transpose(mat3(viewMatrix)) * (-vViewPosition - viewMatrix[3].xyz);
    vec3 o = (uCarInv * vec4(pwh, 1.0)).xyz;
    float fd = -o.z - 1.9;
    if (fd > -0.5) {
      float lat = abs(o.x) / (max(fd, 0.0) * 0.45 + 1.0);
      float up = (o.y + 0.25) / (max(fd, 0.0) * 0.16 + 0.9);
      float beam = (1.0 - smoothstep(0.6, 1.05, lat)) * (1.0 - smoothstep(0.9, 2.6, up)) * smoothstep(-0.5, 0.5, fd);
      float fall = 1.0 / (1.0 + fd * fd / 700.0) * (1.0 - smoothstep(70.0, 120.0, fd));
      vec3 Lw = normalize(uCarPos + vec3(0.0, 0.6, 0.0) - pwh);
      float ndlH = max(dot(Nw, Lw), 0.0) * 0.75 + 0.25;
      #ifdef POSTER_RETRO
      // retro-reflective tape (marker poles): bounces the beam straight back, far brighter than paint
      ndlH = mix(ndlH, 6.0, vRetro);
      #endif
      reflectedLight.indirectDiffuse += albedo * uHeadCol * beam * fall * ndlH * uHead;
    }
  }
}
`;

export interface PosterOpts {
  /** analytic car shadow (terrain) */
  carShadow?: boolean;
  /** shade as if the surface faced straight up (grass cards, flat ground cover) */
  flatNormal?: boolean;
  /** wrap lighting (foliage: softer terminator) */
  wrap?: boolean;
  /** dissolve out (dithered) over LOOK.uLodFade — geometry LOD that hands over to billboards */
  lodFade?: boolean;
  /** retro-reflective vertices (attribute aWave < -0.5) multiply the headlight term */
  retro?: boolean;
  /** extra uniforms */
  uniforms?: Record<string, THREE.IUniform>;
  /** further shader edits applied after the poster patch */
  edit?: (sh: THREE.WebGLProgramParametersWithUniforms) => void;
  key: string;
}

/** patch a MeshLambertMaterial with the poster lighting model (idempotent per material) */
export function posterize<T extends THREE.MeshLambertMaterial>(m: T, opts: PosterOpts): T {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, LOOK, opts.uniforms ?? {});
    let defs = '';
    if (opts.carShadow) defs += '#define POSTER_CAR_SHADOW\n';
    if (opts.flatNormal) defs += '#define POSTER_FLAT_NORMAL\n';
    if (opts.wrap) defs += '#define POSTER_WRAP\n';
    if (opts.retro) {
      defs += '#define POSTER_RETRO\nvarying float vRetro;\n';
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWave;\nvarying float vRetro;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRetro = aWave < -0.5 ? 1.0 : 0.0;');
    }
    if (opts.lodFade) {
      defs += '#define POSTER_LODFADE\n';
      // alpha-to-coverage (MSAA) dissolve: much finer than a screen dither
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', 'gl_FragColor = vec4(outgoingLight, diffuseColor.a * lodKeep);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
#ifdef POSTER_LODFADE
float lodKeep = 1.0 - smoothstep(uLodFade.x, uLodFade.y, length(vViewPosition));
if (lodKeep < 0.02) discard;
#endif`);
    }
    sh.fragmentShader = defs + sh.fragmentShader
      .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n' + POSTER_PARS)
      .replace('#include <lights_fragment_begin>', POSTER_LIGHT)
      .replace('#include <lights_fragment_maps>', '')
      .replace('#include <lights_fragment_end>', '');
    opts.edit?.(sh);
  };
  m.customProgramCacheKey = () => 'poster-' + opts.key;
  return m;
}

/** vertex-coloured poster Lambert (vegetation, props) */
export function posterVcol(key: string, extra: THREE.MeshLambertMaterialParameters = {}, opts: Partial<PosterOpts> = {}) {
  return posterize(new THREE.MeshLambertMaterial({ vertexColors: true, ...extra }), { key, ...opts });
}

// ---------------------------------------------------------------------------------------------------------------------
// post chain

const FS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tColor; uniform vec2 uTexel, uScale; uniform float uThreshold; varying vec2 vUv;
void main(){
  vec3 c = vec3(0.0);
  vec2 uv = vUv * uScale;
  vec2 hi = uScale - uTexel;
  c += texture2D(tColor, min(uv + uTexel * vec2(-1.0, -1.0), hi)).rgb;
  c += texture2D(tColor, min(uv + uTexel * vec2( 1.0, -1.0), hi)).rgb;
  c += texture2D(tColor, min(uv + uTexel * vec2(-1.0,  1.0), hi)).rgb;
  c += texture2D(tColor, min(uv + uTexel * vec2( 1.0,  1.0), hi)).rgb;
  c *= 0.25;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = min(c, vec3(8.0));
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThreshold, uThreshold + 0.35, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tColor; uniform vec2 uDir, uScale; varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tColor, clamp(vUv * uScale + o, vec2(0.0), uScale)).rgb; }
void main(){
  vec3 c = tap(vec2(0.0)) * 0.227;
  c += tap(uDir * 1.385) * 0.316;
  c += tap(-uDir * 1.385) * 0.316;
  c += tap(uDir * 3.231) * 0.070;
  c += tap(-uDir * 3.231) * 0.070;
  gl_FragColor = vec4(c, 1.0);
}`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tColor, tDepth, tBloom, tPart;
uniform vec2 uPScale; uniform float uPartMax, uHazeStart;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos, uSunDir, uSunCol;
uniform vec3 uHazeNear, uHazeFar, uLift, uGain;
uniform float uHazeDensity, uHazeMax, uHazeLow, uHazeFalloff;
uniform float uBloom, uSat, uContrast, uVignette, uGrain, uTime, uSkyDist;
uniform vec2 uRes, uScale, uBScale;
uniform float uRadial, uRadialBlur, uSpeedBlur;
varying vec2 vUv;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec3 col = texture2D(tColor, vUv * uScale).rgb;
  // speed blur: radial, only toward the screen edges (centre stays sharp), strength = switch × setting × speed
  float rb = uRadial * uRadialBlur * uSpeedBlur;
  if (rb > 0.002) {
    vec2 dq = vUv - 0.5;
    float edge = smoothstep(0.18, 0.62, length(dq * vec2(uRes.x / uRes.y, 1.0)));
    if (edge > 0.0) {
      vec2 st = -dq * rb * edge * 0.012;
      vec3 acc = col;
      for (int i = 1; i <= 5; i++) acc += texture2D(tColor, clamp(vUv + st * float(i), 0.0, 1.0) * uScale).rgb;
      col = acc / 6.0;
    }
  }
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.5);
  float z = texture2D(tDepth, vUv * uScale).r;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 v = vp.xyz / vp.w;
  float dist = length(v);
  if (dist < uSkyDist) {
    vec3 dir = normalize(mat3(uCamWorld) * v);
    // height fog: denser in hollows / over the lake, integrated cheaply along the ray (mean height)
    float yMid = uCamPos.y + dir.y * dist * 0.5;
    float low = exp(-max(0.0, yMid - uHazeLow) / uHazeFalloff);
    // the first ~uHazeStart metres stay clear (near ground keeps its full colour and contrast), haze builds beyond
    float dh = max(0.0, dist - uHazeStart) + uHazeStart * 0.12 * smoothstep(0.0, uHazeStart, dist);
    float od = dh * uHazeDensity * (1.0 + 1.0 * low);
    float f = (1.0 - exp(-od)) * uHazeMax;
    float far = smoothstep(80.0, 1400.0, dist);
    vec3 haze = mix(uHazeNear, uHazeFar, far);
    float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 6.0);
    haze = mix(haze, uSunCol * 1.05, sunAmt * 0.35);
    col = mix(col, haze, f);
  }
  // soft particles (premultiplied, half res): accumulated opacity capped so stacked puffs never paint a flat sheet
  vec4 pt = texture2D(tPart, vUv * uPScale);
  if (pt.a > 0.002) { float pa = min(pt.a, uPartMax); col = col * (1.0 - pa) + pt.rgb * (pa / pt.a); }
  col += texture2D(tBloom, vUv * uBScale).rgb * uBloom;
  vec3 s = toSRGB(col);
  // grade in display space: lift/gain, saturation, contrast
  s = s * uGain + uLift * (1.0 - s);
  float l = dot(s, vec3(0.299, 0.587, 0.114));
  s = mix(vec3(l), s, uSat);
  s = (s - 0.5) * uContrast + 0.5;
  // vignette (warm brown, poster print)
  vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
  float vg = smoothstep(0.35, 1.05, length(q) * 1.15);
  s = mix(s, s * vec3(0.55, 0.47, 0.42), vg * uVignette);
  // silkscreen grain: luminance noise, strongest in the mid tones; also dithers the gradients
  float g = h12(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5;
  s += g * uGrain * (0.5 + 2.0 * l * (1.0 - l)) + (h12(gl_FragCoord.yx * 1.7) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

/** default strength of the radial speed blur (uRadialBlur); 1 = strong */
export const RADIAL_BLUR_DEFAULT = 0.45;

export class PostFX {
  readonly rt: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;
  /** soft-particle buffer (half resolution, premultiplied) */
  private pt: THREE.WebGLRenderTarget;
  /** soft particles (dust, spray, weather) — rendered after the scene with access to its depth */
  soft: THREE.Scene | null = null;
  private clearC = new THREE.Color();
  private quad: THREE.Mesh;
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  readonly final: THREE.ShaderMaterial;
  private size = new THREE.Vector2();
  enabled = true;

  constructor(readonly renderer: THREE.WebGLRenderer, pal: Palette, msaa: number) {
    // 8-bit sRGB storage (hardware encode/decode keeps the darks precise) at half the bandwidth of half-float — MSAA
    // resolve on a half-float target cost ~3 ms/frame on the M5 at 1965×1276
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, samples: msaa, depthBuffer: true });
    this.rt.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
    const small = { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.bloomA = new THREE.WebGLRenderTarget(4, 4, small);
    this.bloomB = new THREE.WebGLRenderTarget(4, 4, small);
    this.pt = new THREE.WebGLRenderTarget(4, 4, small);
    const L = pal.look;
    this.bright = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: this.rt.texture }, uTexel: { value: new THREE.Vector2() }, uScale: { value: new THREE.Vector2(1, 1) }, uThreshold: { value: L.bloomThreshold } } });
    this.blur = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, uDir: { value: new THREE.Vector2() }, uScale: { value: new THREE.Vector2(1, 1) } } });
    this.final = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture }, tBloom: { value: this.bloomA.texture }, tPart: { value: this.pt.texture }, uPScale: { value: new THREE.Vector2(1, 1) }, uPartMax: { value: L.partMax ?? 0.62 }, uHazeStart: { value: L.hazeStart ?? 60 },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: pal.sun.clone() },
        uHazeNear: { value: L.hazeNear.clone() }, uHazeFar: { value: L.hazeFar.clone() },
        uHazeDensity: { value: L.hazeDensity }, uHazeMax: { value: L.hazeMax }, uHazeLow: { value: L.hazeLow }, uHazeFalloff: { value: L.hazeFalloff },
        uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
        uBloom: { value: L.bloom }, uSat: { value: L.saturation }, uContrast: { value: L.contrast }, uVignette: { value: L.vignette }, uGrain: { value: L.grain },
        uTime: { value: 0 }, uSkyDist: { value: 8000 }, uRes: { value: new THREE.Vector2() }, uScale: { value: new THREE.Vector2(1, 1) }, uBScale: { value: new THREE.Vector2(1, 1) },
        // radial speed blur: uRadial = on/off switch (settings), uRadialBlur = strength (default weak), uSpeedBlur = 0..1 from the car's speed (view, per frame)
        uRadial: { value: 1 }, uRadialBlur: { value: RADIAL_BLUR_DEFAULT }, uSpeedBlur: { value: 0 },
      },
    });
    // lift/gain are display-space tints: use the sRGB numbers, not the linearised ones
    this.final.uniforms.uLift.value.set(...srgbTriple(L.liftHex));
    this.final.uniforms.uGain.value.set(...srgbTriple(L.gainHex));
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.final);
    this.quad.frustumCulled = false;
  }

  /** allocated target size (grow-only: dynamic resolution renders into a sub-rectangle instead of reallocating the
   *  MSAA target, which stalls the GPU for hundreds of ms) */
  private alloc = new THREE.Vector2();
  private view = new THREE.Vector2();

  /** k: internal resolution relative to the canvas drawing buffer (dynamic resolution, ≤ 1) */
  setSize(k = 1) {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(4, Math.round(this.size.x * k)), h = Math.max(4, Math.round(this.size.y * k));
    if (w > this.alloc.x || h > this.alloc.y) {
      this.alloc.set(Math.max(w, this.alloc.x), Math.max(h, this.alloc.y));
      this.rt.setSize(this.alloc.x, this.alloc.y);
      const bw = Math.max(4, Math.ceil(this.alloc.x / 4)), bh = Math.max(4, Math.ceil(this.alloc.y / 4));
      this.bloomA.setSize(bw, bh); this.bloomB.setSize(bw, bh);
      this.pt.setSize(Math.max(4, Math.ceil(this.alloc.x / 2)), Math.max(4, Math.ceil(this.alloc.y / 2)));
    }
    const pw = Math.max(1, Math.floor(w / 2)), ph = Math.max(1, Math.floor(h / 2));
    this.pt.viewport.set(0, 0, pw, ph);
    this.final.uniforms.uPScale.value.set(pw / this.pt.width, ph / this.pt.height);
    SOFT.uInvRes.value.set(1 / pw, 1 / ph);
    SOFT.uDScale.value.set(w / this.alloc.x, h / this.alloc.y);
    this.view.set(w, h);
    const sx = w / this.alloc.x, sy = h / this.alloc.y;
    this.rt.viewport.set(0, 0, w, h);
    const bw = Math.max(1, Math.floor(w / 4)), bh = Math.max(1, Math.floor(h / 4));
    for (const b of [this.bloomA, this.bloomB]) b.viewport.set(0, 0, bw, bh);
    this.bright.uniforms.uTexel.value.set(1 / this.alloc.x, 1 / this.alloc.y);
    this.bright.uniforms.uScale.value.set(sx, sy);
    this.blur.uniforms.uScale.value.set(bw / this.bloomA.width, bh / this.bloomA.height);
    this.final.uniforms.uScale.value.set(sx, sy);
    this.final.uniforms.uBScale.value.set(bw / this.bloomA.width, bh / this.bloomA.height);
    this.final.uniforms.uRes.value.set(w, h);
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.ortho);
  }

  render(scene: THREE.Scene, cam: THREE.PerspectiveCamera, time: number, sunDir: THREE.Vector3) {
    const r = this.renderer;
    if (!this.enabled) { r.setRenderTarget(null); r.render(scene, cam); return; }
    r.setRenderTarget(this.rt);
    r.render(scene, cam);
    const u = this.final.uniforms;
    // soft particles into their own buffer, reading the (now resolved) scene depth
    r.getClearColor(this.clearC);
    const ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.pt);
    r.clear(true, false, false);
    if (this.soft) {
      SOFT.tDepth.value = this.rt.depthTexture;
      SOFT.uCamNear.value = cam.near; SOFT.uCamFar.value = cam.far;
      r.autoClear = false;
      r.render(this.soft, cam);
      r.autoClear = true;
    }
    r.setClearColor(this.clearC, ca);
    if (u.uBloom.value > 0) {
      this.pass(this.bright, this.bloomA);
      this.blur.uniforms.tColor.value = this.bloomA.texture;
      this.blur.uniforms.uDir.value.set(1 / this.bloomA.width, 0);
      this.pass(this.blur, this.bloomB);
      this.blur.uniforms.tColor.value = this.bloomB.texture;
      this.blur.uniforms.uDir.value.set(0, 1 / this.bloomA.height);
      this.pass(this.blur, this.bloomA);
    }
    u.uInvProj.value.copy(cam.projectionMatrixInverse);
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.uSunDir.value.copy(sunDir);
    u.uTime.value = time;
    this.pass(this.final, null);
  }
}

function srgbTriple(hex: string): [number, number, number] {
  const c = new THREE.Color();
  c.setStyle(hex, THREE.SRGBColorSpace);
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o as THREE.RGB, THREE.SRGBColorSpace);
  return [o.r, o.g, o.b];
}
