// Car materials: MeshLambert + onBeforeCompile so they keep three's lights, shadows and fog.
//  body  : vertex colour or projected livery (5-view canvas) or explicit livery uv; interior colour on back faces;
//          height-masked dirt; light groups (tail/brake, head, pod) as emissive; mudflap swing in the vertex shader;
//          a faint sky sheen on paint so panels read as painted metal.
//  glass : dark tint + sky reflection, alpha rises at grazing angles (helmets and cage show through).
//  wheel : vertex colour + uniform dirt (instanced).
import * as THREE from 'three';
import { frac, PAD, REG } from './layout';
import type { Shape } from './shape';

export interface CarUniforms {
  uLivery: { value: THREE.Texture | null };
  uBox: { value: THREE.Vector4 };
  uRegL: { value: THREE.Vector4 }; uRegR: { value: THREE.Vector4 }; uRegT: { value: THREE.Vector4 }; uRegF: { value: THREE.Vector4 }; uRegB: { value: THREE.Vector4 };
  uDirt: { value: number }; uDirtColor: { value: THREE.Color };
  /** x = tail/brake, y = headlights, z = light pod */
  uLights: { value: THREE.Vector3 };
  uFlap: { value: THREE.Vector4 };
  uInterior: { value: THREE.Color };
  uSkyTop: { value: THREE.Color }; uSkyLow: { value: THREE.Color };
}

const v4 = (r: [number, number, number, number]) => new THREE.Vector4(...r);

export function makeUniforms(S: Shape, tex: THREE.Texture | null): CarUniforms {
  return {
    uLivery: { value: tex },
    uBox: { value: new THREE.Vector4(S.zMin, S.zMax, S.yMax, S.xMax) },
    uRegL: { value: v4(frac(REG.L, PAD)) }, uRegR: { value: v4(frac(REG.R, PAD)) }, uRegT: { value: v4(frac(REG.T, PAD)) },
    uRegF: { value: v4(frac(REG.F, PAD)) }, uRegB: { value: v4(frac(REG.B, PAD)) },
    uDirt: { value: 0 }, uDirtColor: { value: new THREE.Color('#9b8463') },
    uLights: { value: new THREE.Vector3(0.35, 0.06, 0) },
    uFlap: { value: new THREE.Vector4() },
    uInterior: { value: new THREE.Color('#1d1e21') },
    uSkyTop: { value: new THREE.Color('#c9d6d8') }, uSkyLow: { value: new THREE.Color('#6e6a5c') },
  };
}

const NOISE = /* glsl */`
float carHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float carNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(carHash(i), carHash(i + vec3(1,0,0)), f.x), mix(carHash(i + vec3(0,1,0)), carHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(carHash(i + vec3(0,0,1)), carHash(i + vec3(1,0,1)), f.x), mix(carHash(i + vec3(0,1,1)), carHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

const VERT_PARS = /* glsl */`
attribute float aPaint; attribute float aGlow; attribute vec2 aUv; attribute vec2 aFlap;
uniform vec4 uFlap; uniform vec4 uBox;
varying vec3 vObjP; varying vec3 vObjN; varying vec2 vLUv; varying float vPaint; varying float vGlow;`;

const VERT_MAIN = /* glsl */`
#ifdef CAR_BODY
if (aFlap.x > 0.5) {
  int fi = int(aFlap.x + 0.5) - 1;
  float ang = fi == 0 ? uFlap.x : fi == 1 ? uFlap.y : fi == 2 ? uFlap.z : uFlap.w;
  float d = aFlap.y - transformed.y;
  transformed.z += sin(ang) * d;
  transformed.y = aFlap.y - cos(ang) * d;
}
#endif
vObjP = transformed; vObjN = objectNormal; vLUv = aUv; vPaint = aPaint; vGlow = aGlow;`;

const FRAG_PARS = /* glsl */`
uniform sampler2D uLivery; uniform vec4 uBox; uniform vec4 uRegL; uniform vec4 uRegR; uniform vec4 uRegT; uniform vec4 uRegF; uniform vec4 uRegB;
uniform float uDirt; uniform vec3 uDirtColor; uniform vec3 uLights; uniform vec3 uInterior; uniform vec3 uSkyTop; uniform vec3 uSkyLow;
varying vec3 vObjP; varying vec3 vObjN; varying vec2 vLUv; varying float vPaint; varying float vGlow;
${NOISE}
vec3 livTex(vec4 r, vec2 c) { vec2 uv = r.xy + clamp(c, 0.0, 1.0) * r.zw; return texture2D(uLivery, vec2(uv.x, 1.0 - uv.y)).rgb; }
vec3 liveryAt(vec3 p, vec3 n) {
  float L = uBox.y - uBox.x, W = 2.0 * uBox.w, cy = (uBox.z - p.y) / uBox.z;
  vec3 sideC = n.x > 0.0 ? livTex(uRegR, vec2((uBox.y - p.z) / L, cy)) : livTex(uRegL, vec2((p.z - uBox.x) / L, cy));
  vec3 topC = livTex(uRegT, vec2((uBox.y - p.z) / L, (p.x + uBox.w) / W));
  vec3 endC = n.z < 0.0 ? livTex(uRegF, vec2((uBox.w - p.x) / W, cy)) : livTex(uRegB, vec2((p.x + uBox.w) / W, cy));
  vec3 a = vec3(abs(n.x) + 1e-3, max(n.y, 0.0), abs(n.z));
  vec3 w = pow(a, vec3(10.0)); w /= (w.x + w.y + w.z);
  return sideC * w.x + topC * w.y + endC * w.z;
}`;

const FRAG_ALBEDO = /* glsl */`
#include <color_fragment>
vec3 alb = diffuseColor.rgb;
float dirtM = 0.0;
#ifdef CAR_BODY
  if (vPaint > 2.5) {
    float L = uBox.y - uBox.x, cy = (uBox.z - vObjP.y) / uBox.z;
    alb = vObjP.x > 0.0 ? livTex(uRegR, vec2((uBox.y - vObjP.z) / L, cy)) : livTex(uRegL, vec2((vObjP.z - uBox.x) / L, cy));
  }
  else if (vPaint > 1.5) alb = texture2D(uLivery, vec2(vLUv.x, 1.0 - vLUv.y)).rgb;
  else if (vPaint > 0.5) alb = liveryAt(vObjP, normalize(vObjN));
  if (!gl_FrontFacing) alb = uInterior;
  {
    float nz = carNoise(vObjP * vec3(6.0, 9.0, 6.0)) * 0.6 + carNoise(vObjP * 21.0) * 0.4;
    float top = mix(0.3, 1.1, uDirt);
    dirtM = uDirt * (1.0 - smoothstep(top * 0.45, top, vObjP.y + (nz - 0.5) * 0.4));
    dirtM = clamp(dirtM * (0.6 + nz * 0.8), 0.0, 0.92);
    if (vGlow > 0.5) dirtM *= 0.4;
    if (!gl_FrontFacing) dirtM = 0.0;
  }
#endif
#ifdef CAR_WHEEL
  {
    float nz = carNoise(vObjP * 18.0);
    dirtM = clamp(uDirt * (0.55 + nz * 0.5), 0.0, 0.85);
  }
#endif
alb = mix(alb, uDirtColor, dirtM);
diffuseColor.rgb = alb;`;

const FRAG_EMISSIVE = /* glsl */`
#include <emissivemap_fragment>
#ifdef CAR_BODY
  if (vGlow > 0.5) {
    float gl = vGlow < 1.5 ? uLights.x : (vGlow < 2.5 ? uLights.y : uLights.z);
    totalEmissiveRadiance += vColor.rgb * gl * 1.6;
  }
  if (vPaint > 0.5 && gl_FrontFacing) {
    vec3 V = normalize(vViewPosition);
    float fres = pow(1.0 - clamp(dot(normal, V), 0.0, 1.0), 4.0);
    vec3 R = reflect(-V, normal);
    vec3 Rw = (vec4(R, 0.0) * viewMatrix).xyz;
    vec3 sky = mix(uSkyLow, uSkyTop, smoothstep(-0.15, 0.5, Rw.y));
    totalEmissiveRadiance += sky * fres * 0.22 * (1.0 - dirtM);
  }
#endif
#ifdef CAR_GLASS
  {
    vec3 V = normalize(vViewPosition);
    float fres = pow(1.0 - clamp(abs(dot(normal, V)), 0.0, 1.0), 2.5);
    vec3 R = reflect(-V, normal);
    vec3 Rw = (vec4(R, 0.0) * viewMatrix).xyz;
    vec3 sky = mix(uSkyLow * 0.6, uSkyTop, smoothstep(-0.1, 0.45, Rw.y));
    // a soft diagonal streak across the glass
    float streak = smoothstep(0.35, 0.0, abs(fract((vObjP.z * 0.9 + vObjP.y * 1.3) * 0.7) - 0.5) * 2.0 - 0.55);
    totalEmissiveRadiance += sky * (0.12 + 0.55 * fres + 0.12 * streak);
    diffuseColor.a = clamp(0.62 + 0.33 * fres + 0.08 * streak, 0.0, 0.96);
  }
#endif`;

function inject(m: THREE.MeshLambertMaterial, U: CarUniforms, def: string, key = def) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.defines = { ...(sh.defines ?? {}), [def]: '' };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', FRAG_ALBEDO)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

export function bodyMaterial(U: CarUniforms) {
  return inject(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), U, 'CAR_BODY');
}
export function glassMaterial(U: CarUniforms) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide });
  return inject(m, U, 'CAR_GLASS');
}
export function wheelMaterial(U: CarUniforms, doubleSide = false) {
  return inject(new THREE.MeshLambertMaterial({ vertexColors: true, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide }), U, 'CAR_WHEEL', doubleSide ? 'CAR_WHEEL2' : 'CAR_WHEEL');
}
