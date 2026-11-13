// Pooled particles (ring buffers, instanced camera-facing quads, zero allocation while running):
//  - Dust: long-lived billowing puffs from the art dust sheet, sun-lit (warm tops, blue undersides, glowing when back-lit),
//    drifting with a light wind, growing into a trail that hangs for several seconds;
//  - Stones: small dark gravel chips thrown by the tyres, ballistic;
//  - Splash: water spray (wading);
//  - Weather: falling snow / rain streaks in a box that wraps around the camera.
//
// Soft particles (dust, splash, snow spray, weather) do not go into the main MSAA pass: PostFX renders them into a
// half-resolution premultiplied buffer after the scene, sampling the scene depth for
//  - soft intersection with the ground and occlusion by anything in front (no hard edges, no depth test needed),
//  - a near-camera fade, and
//  - car protection: a puff that sits between the camera and the player's car and overlaps it on screen is faded, so the
//    car is never painted over by its own dust;
// and the final pass caps the accumulated opacity, so layered puffs never wash the background out to a flat white.
import * as THREE from 'three';
import { hasAsset, imageTexture } from './materials';

const VERT = /* glsl */ `
attribute vec4 aPos;   // xyz spawn, w birth time
attribute vec4 aVel;   // xyz velocity, w lifetime
attribute vec4 aSize;  // start size, end size, rotation, sheet cell
uniform float uTime, uDrag, uGravity, uRise, uStretch;
uniform vec3 uWind;
uniform float uNear0, uNear1;
uniform float uMaxScr, uClamp;
varying vec2 vUv;
varying vec3 vW;
varying float vAlpha;
varying vec3 vN;
varying float vAge;
varying float vViewZ;
varying float vSize;
void main() {
  float age = uTime - aPos.w;
  float life = aVel.w;
  float t = clamp(age / life, 0.0, 1.0);
  float k = uDrag > 0.0 ? (1.0 - exp(-age * uDrag)) / uDrag : age;
  vec3 p = aPos.xyz + aVel.xyz * k + uWind * age + vec3(0.0, uRise * age - 0.5 * uGravity * age * age, 0.0);
  float size = mix(aSize.x, aSize.y, 1.0 - (1.0 - t) * (1.0 - t));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // screen-size cap (fine spray): a sprite is never wider on screen than uMaxScr (NDC, set from the car's width)
  if (uClamp > 0.0) size = min(size, uMaxScr * max(-mv.z, 0.05) / projectionMatrix[0][0]);
  vW = p;
  float c = cos(aSize.z), s = sin(aSize.z);
  vec2 q = mat2(c, -s, s, c) * position.xy;
  vec2 qq = q * size;
  // streaks (rain): stretch along the screen-space fall direction
  if (uStretch > 0.0) {
    vec3 vel = (viewMatrix * vec4(aVel.xyz + vec3(0.0, -uGravity * age, 0.0), 0.0)).xyz;
    vec2 dir = normalize(vel.xy + vec2(0.0, -0.001));
    qq = dir * position.y * size * uStretch + vec2(-dir.y, dir.x) * position.x * size;
  }
  mv.xy += qq;
  gl_Position = projectionMatrix * mv;
  float cell = aSize.w;
  vUv = (vec2(mod(cell, 2.0), 1.0 - floor(cell / 2.0)) + position.xy + 0.5) * 0.5;
  float a = (age < 0.0 || age > life) ? 0.0 : smoothstep(0.0, 0.06, t) * (1.0 - t) * (1.0 - t * 0.5);
  // near-camera fade
  float zc = -(viewMatrix * vec4(p, 1.0)).z;
  a *= smoothstep(uNear0, uNear1, zc);
  vAlpha = a;
  // pseudo sphere normal in view space for lighting
  vN = normalize(vec3(position.xy * 1.4, 0.8));
  vAge = t;
  vViewZ = -zc;
  vSize = size;
  if (vAlpha <= 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor, uShadow, uSunCol;
uniform vec3 uSunView;   // sun direction in view space
uniform float uOpacity, uUseMap, uLit, uSoft;
uniform sampler2D uMap;
uniform sampler2D tDepth;
uniform vec2 uInvRes, uDScale;
uniform float uCamNear, uCamFar;
uniform vec3 uHaze; uniform float uHazeK;
uniform vec4 uCarScr; uniform float uCarZ, uCarR;
uniform float uLight, uNightL;
uniform vec3 uShadeN, uCarW, uCarF;
varying vec3 vW;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vN;
varying float vAge;
varying float vViewZ;
varying float vSize;
void main() {
  float a, lum;
  if (uUseMap > 0.5) { vec4 t = texture2D(uMap, vUv); a = t.a; lum = t.r; }
  else { vec2 c = fract(vUv * 2.0) - 0.5; float d = length(c) * 2.0; a = exp(-d * d * 3.5) * (1.0 - smoothstep(0.85, 1.0, d)); lum = 1.0 - d * 0.3; }
  a *= vAlpha * uOpacity;
  // soft particles: fade where the puff meets the scene behind it, vanish where something is in front
  if (uSoft > 0.0) {
    float zb = texture2D(tDepth, gl_FragCoord.xy * uInvRes * uDScale).r;
    float sceneZ = (uCamNear * uCamFar) / ((uCamFar - uCamNear) * zb - uCamFar);
    a *= clamp((vViewZ - sceneZ) / (uSoft * max(vSize, 0.5)), 0.0, 1.0);
  }
  // car protection: a fragment over the player's car (its screen ellipse) from a puff in front of it is faded out
  if (uCarR > 0.0) {
    vec2 ndc = gl_FragCoord.xy * uInvRes * 2.0 - 1.0;
    vec2 e = (ndc - uCarScr.xy) / uCarScr.zw;
    float front = smoothstep(-0.4, 0.6, -vViewZ < uCarZ ? uCarZ + vViewZ : -1.0);
    a *= 1.0 - 0.97 * front * (1.0 - smoothstep(0.75, 1.1, length(e)));
  }
  if (a < 0.003) discard;
  vec3 col;
  if (uLit > 0.5) {
    // poster dust: sunlit side warm, shadow side toward the blue shadow tint; back-lit puffs glow (forward scattering)
    float ndl = dot(vN, uSunView) + (lum - 0.6) * 0.9;
    float lit = smoothstep(-0.1, 0.25, ndl);
    float fwd = pow(max(-uSunView.z, 0.0), 3.0) * (1.0 - smoothstep(0.0, 0.9, length(vN.xy)));
    col = mix(uShadow, uColor * mix(vec3(1.0), uSunCol, 0.3), lit) + uSunCol * fwd * 0.25;
    col = mix(col, mix(uShadow, uColor, 0.55), vAge * 0.3);
    a = pow(a, 0.8);
  } else {
    col = uColor * (0.55 + 0.6 * lum);
  }
  // ambient level of the scene (night: the sprite takes the dark moonlit shade, not its daylight colour)
  col *= uLight;
  if (uNightL > 0.0) {
    col = mix(col, uShadeN * (0.8 + 0.4 * lum), 0.85);
    // lit only where the car's lamps reach: red tail-light glow behind the car, white headlight beams in front
    vec3 rel = vW - uCarW;
    float along = dot(rel.xz, uCarF.xz);
    float side = length(rel.xz - uCarF.xz * along);
    vec3 tb = rel + vec3(uCarF.x, 0.0, uCarF.z) * 2.3 - vec3(0.0, 0.2, 0.0);
    float tail = exp(-dot(tb, tb) / 1.6) * 0.55;
    float fd = along - 2.0;
    float head = fd > 0.0 ? (1.0 - smoothstep(0.6, 1.1, side / (fd * 0.45 + 1.0))) / (1.0 + fd * fd / 500.0) * smoothstep(0.0, 1.0, fd) : 0.0;
    col += uColor * (vec3(1.0, 0.16, 0.1) * tail + vec3(1.0, 0.92, 0.78) * head * 1.4) * uNightL;
  }
  // own aerial perspective (the post haze is computed from the scene depth behind the puff)
  col = mix(col, uHaze, clamp((1.0 - exp(-max(0.0, -vViewZ - 60.0) * uHazeK)), 0.0, 0.85));
  gl_FragColor = vec4(col * a, a);
}`;

export interface ParticleOpts {
  max: number; color: THREE.Color; shadow: THREE.Color; sun: THREE.Color;
  opacity: number; drag: number; gravity: number; rise: number; lit: boolean;
  map?: string; renderOrder?: number; name: string;
  /** soft particle (offscreen pass, premultiplied) */
  soft?: boolean;
  /** rain streaks: length multiplier along the fall direction */
  stretch?: number;
  /** near-camera fade range (m) */
  near?: [number, number];
  /** car protection (fade puffs in front of the car) */
  protectCar?: boolean;
  /** cap the on-screen size of each sprite to a third of the car's width */
  clamp?: boolean;
}

/** uniforms shared by every soft particle system (scene depth, camera, car) */
export const SOFT = {
  tDepth: { value: null as THREE.Texture | null },
  uInvRes: { value: new THREE.Vector2(1, 1) },
  uDScale: { value: new THREE.Vector2(1, 1) },
  uCamNear: { value: 0.15 }, uCamFar: { value: 12000 },
  /** player car on screen: NDC centre xy, ellipse radii zw; view depth (m) */
  uCarScr: { value: new THREE.Vector4(0, 0, 0.001, 0.001) }, uCarZ: { value: -1 },
  uHaze: { value: new THREE.Color() }, uHazeK: { value: 0.0015 },
  /** car width on screen (NDC) / 3: cap for clamped sprites */
  uMaxScr: { value: 0.2 },
  /** scene light level for sprites (1 = daylight), night lamp glow strength, moonlit shade colour */
  uLight: { value: 1 }, uNightL: { value: 0 }, uShadeN: { value: new THREE.Color(0.2, 0.25, 0.4) },
  /** player car world position and forward direction (lamp glow) */
  uCarW: { value: new THREE.Vector3(0, -1e5, 0) }, uCarF: { value: new THREE.Vector3(0, 0, -1) },
};

export class Particles {
  readonly mesh: THREE.Mesh;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private next = 0;
  private dirtyFrom = -1;
  private dirtyTo = -1;
  readonly max: number;
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly soft: boolean;

  constructor(o: ParticleOpts) {
    this.max = o.max;
    this.soft = !!o.soft;
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(o.max * 4).fill(-1e6), 4);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(o.max * 4).fill(1e-3), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(o.max * 4), 4);
    for (const a of [this.aPos, this.aVel, this.aSize]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aSize', this.aSize);
    g.instanceCount = o.max;
    const near = o.near ?? [1.2, 3.5];
    this.uniforms = {
      ...SOFT,
      uTime: { value: 0 }, uColor: { value: o.color.clone() }, uShadow: { value: o.shadow.clone() }, uSunCol: { value: o.sun.clone() },
      uSunView: { value: new THREE.Vector3(0, 1, 0) }, uOpacity: { value: o.opacity }, uMap: { value: null }, uUseMap: { value: 0 },
      uDrag: { value: o.drag }, uGravity: { value: o.gravity }, uRise: { value: o.rise }, uWind: { value: new THREE.Vector3(0.6, 0, 0.3) },
      uLit: { value: o.lit ? 1 : 0 }, uSoft: { value: o.soft ? 0.3 : 0 }, uStretch: { value: o.stretch ?? 0 },
      uNear0: { value: near[0] }, uNear1: { value: near[1] }, uCarR: { value: o.protectCar ? 1 : 0 }, uClamp: { value: o.clamp ? 1 : 0 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, uniforms: this.uniforms,
      // premultiplied "over" (soft pass accumulates alpha too, for the opacity cap in the final pass)
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      depthTest: !o.soft,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? 5;
    this.mesh.name = o.name;
    if (o.map && hasAsset(o.map)) {
      imageTexture(o.map, false, (t) => { this.uniforms.uMap.value = t; this.uniforms.uUseMap.value = 1; });
    }
  }

  emit(time: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, rot = 0, cell = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.aPos.setXYZW(i, x, y, z, time);
    this.aVel.setXYZW(i, vx, vy, vz, life);
    this.aSize.setXYZW(i, s0, s1, rot, cell);
    if (this.dirtyFrom < 0) { this.dirtyFrom = i; this.dirtyTo = i; }
    else this.dirtyTo = i;
  }

  update(time: number, sunView: THREE.Vector3) {
    this.uniforms.uTime.value = time;
    this.uniforms.uSunView.value.copy(sunView);
    if (this.dirtyFrom < 0) return;
    for (const a of [this.aPos, this.aVel, this.aSize]) {
      a.clearUpdateRanges();
      if (this.dirtyTo >= this.dirtyFrom) a.addUpdateRange(this.dirtyFrom * a.itemSize, (this.dirtyTo - this.dirtyFrom + 1) * a.itemSize);
      else { a.addUpdateRange(this.dirtyFrom * a.itemSize, (this.max - this.dirtyFrom) * a.itemSize); a.addUpdateRange(0, (this.dirtyTo + 1) * a.itemSize); }
      a.needsUpdate = true;
    }
    this.dirtyFrom = this.dirtyTo = -1;
  }
}

/** falling weather (snow flakes / rain streaks) in a box that wraps around the camera: static per-particle phase, the
 *  vertex shader folds positions into the box, so nothing is emitted or uploaded while running */
export class Weather {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  constructor(kind: 'snow' | 'rain', count: number, color: THREE.Color) {
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = count;
    const rain = kind === 'rain';
    this.uniforms = {
      ...SOFT,
      uTime: { value: 0 }, uBox: { value: new THREE.Vector3(rain ? 34 : 46, rain ? 18 : 22, rain ? 34 : 46) },
      uFall: { value: rain ? 16 : 1.4 }, uSize: { value: rain ? 0.035 : 0.075 }, uLen: { value: rain ? 0.9 : 0 },
      uColor: { value: color.clone() }, uOpacity: { value: rain ? 0.32 : 0.85 }, uWind: { value: new THREE.Vector2(rain ? 1.5 : 1.1, rain ? 0.6 : 0.4) },
      uVel: { value: new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime, uFall, uSize, uLen; uniform vec3 uBox; uniform vec2 uWind; uniform vec3 uVel;
        varying vec2 vUv; varying float vA; varying float vViewZ;
        void main(){
          vec3 w = vec3(uWind.x, -uFall * (0.75 + 0.5 * aSeed.w), uWind.y);
          // flakes flutter
          float fl = ${rain ? '0.0' : '1.0'};
          vec3 p = aSeed.xyz * uBox + w * uTime + fl * vec3(sin(uTime * 1.3 + aSeed.w * 40.0), 0.0, cos(uTime * 1.1 + aSeed.x * 30.0)) * 0.6;
          // wrap into a box centred on the camera
          p = mod(p - cameraPosition + uBox * 0.5, uBox) - uBox * 0.5 + cameraPosition;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float s = uSize * (0.6 + 0.8 * aSeed.y);
          vec2 q = position.xy;
          if (uLen > 0.0) {
            // streak along the fall direction relative to the moving camera
            vec3 rel = (viewMatrix * vec4(w - uVel * 0.6, 0.0)).xyz;
            vec2 d = normalize(rel.xy + vec2(0.0, -0.001));
            float len = uLen * length(rel.xy) / max(-mv.z, 1.0) * 6.0;
            mv.xy += d * q.y * max(len, s * 4.0) + vec2(-d.y, d.x) * q.x * s;
          } else mv.xy += q * s;
          gl_Position = projectionMatrix * mv;
          vUv = position.xy + 0.5;
          float z = -mv.z;
          vA = smoothstep(1.6, 4.0, z) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, z));
          vViewZ = mv.z;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity;
        uniform sampler2D tDepth; uniform vec2 uInvRes, uDScale; uniform float uCamNear, uCamFar;
        varying vec2 vUv; varying float vA; varying float vViewZ;
        void main(){
          vec2 c = vUv - 0.5;
          float a = ${rain ? '(1.0 - smoothstep(0.2, 0.5, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)))' : '1.0 - smoothstep(0.25, 0.5, length(c))'};
          float zb = texture2D(tDepth, gl_FragCoord.xy * uInvRes * uDScale).r;
          float sceneZ = (uCamNear * uCamFar) / ((uCamFar - uCamNear) * zb - uCamFar);
          a *= vA * uOpacity * step(sceneZ, vViewZ);
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'weather-' + kind;
  }
  update(time: number, camVel: THREE.Vector3) { this.uniforms.uTime.value = time; this.uniforms.uVel.value.copy(camVel); }
}

/** all particle systems of a stage view */
export class Fx {
  readonly dust: Particles;
  readonly stones: Particles;
  readonly splash: Particles;
  /** fine powder snow thrown off the tyres (snow environment) */
  readonly spray: Particles | null = null;
  /** road-water mist off wet asphalt (wet weather) */
  readonly mist: Particles | null = null;
  /** scene-pass particles (stones) */
  readonly group = new THREE.Group();
  /** soft-pass particles (dust, splash, weather) — rendered by PostFX into its particle buffer */
  readonly soft = new THREE.Scene();
  weather: Weather | null = null;
  private sunView = new THREE.Vector3();
  private v = new THREE.Vector3();
  private carCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
  /** player car's local bounding box (set by the view from the model) */
  carBox = new THREE.Box3(new THREE.Vector3(-1, -0.5, -2.2), new THREE.Vector3(1, 1, 2.2));

  constructor(dustMax: number, dustCol: THREE.Color, shadow: THREE.Color, sun: THREE.Color, opts: { dustOpacity?: number; splashCol?: THREE.Color; snowSpray?: boolean; mist?: THREE.Color } = {}) {
    // snow: the "dust" system carries only a faint, size-capped mist; the spray itself is many small flakes
    this.dust = new Particles({ name: 'dust', max: dustMax, color: dustCol, shadow, sun, opacity: opts.dustOpacity ?? 0.5, drag: 1.1, gravity: 0, rise: 0.35, lit: true, map: '/assets/fx/dust_sheet.png', soft: true, protectCar: true, near: [1.0, 3.0], clamp: opts.snowSpray });
    if (opts.snowSpray) {
      this.spray = new Particles({ name: 'snow-spray', max: Math.round(dustMax * 1.4), color: dustCol, shadow, sun, opacity: 0.7, drag: 1.5, gravity: 5.5, rise: 0, lit: true, soft: true, protectCar: true, near: [0.8, 2.2], clamp: true });
    }
    this.stones = new Particles({ name: 'stones', max: 600, color: new THREE.Color('#4a4640'), shadow, sun, opacity: 1, drag: 0.4, gravity: 9.8, rise: 0, lit: false, map: '/assets/fx/stones.png', renderOrder: 4 });
    // stones stay in the scene pass with straight alpha
    const sm = this.stones.mesh.material as THREE.ShaderMaterial;
    sm.blending = THREE.NormalBlending; sm.premultipliedAlpha = true;
    // never bind the scene depth texture to a scene-pass program (it is the framebuffer's attachment there)
    this.stones.uniforms.tDepth = { value: null };
    this.splash = new Particles({ name: 'splash', max: 1400, color: opts.splashCol ?? new THREE.Color('#eef4f4'), shadow, sun, opacity: 0.55, drag: 0.7, gravity: 7, rise: 0, lit: true, soft: true, protectCar: true, near: [1.0, 3.0], clamp: true });
    this.group.add(this.stones.mesh);
    this.soft.add(this.dust.mesh, this.splash.mesh);
    if (this.spray) this.soft.add(this.spray.mesh);
    if (opts.mist) {
      this.mist = new Particles({ name: 'mist', max: 1200, color: opts.mist, shadow, sun, opacity: 0.2, drag: 1.3, gravity: 0.6, rise: 0.15, lit: true, soft: true, protectCar: true, near: [1.0, 3.0], clamp: true });
      this.soft.add(this.mist.mesh);
    }
  }

  setWeather(w: Weather | null) {
    if (this.weather) this.soft.remove(this.weather.mesh);
    this.weather = w;
    if (w) this.soft.add(w.mesh);
  }

  update(time: number, sunWorld: THREE.Vector3, cam: THREE.PerspectiveCamera, carMatrix: THREE.Matrix4, camVel: THREE.Vector3) {
    this.sunView.copy(sunWorld).transformDirection(cam.matrixWorldInverse);
    // the car's screen-space ellipse: project the 8 corners of its box
    const b = this.carBox;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zMin = Infinity;
    for (let i = 0; i < 8; i++) {
      const c = this.carCorners[i].set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(carMatrix);
      this.v.copy(c).applyMatrix4(cam.matrixWorldInverse);
      zMin = Math.min(zMin, -this.v.z);
      if (-this.v.z < 0.2) { x0 = y0 = -2; x1 = y1 = 2; continue; }
      this.v.applyMatrix4(cam.projectionMatrix);
      x0 = Math.min(x0, this.v.x); x1 = Math.max(x1, this.v.x); y0 = Math.min(y0, this.v.y); y1 = Math.max(y1, this.v.y);
    }
    // ellipse through the box corners: radii = half extents × √2
    SOFT.uCarScr.value.set((x0 + x1) / 2, (y0 + y1) / 2, Math.max(1e-3, (x1 - x0) * 0.62), Math.max(1e-3, (y1 - y0) * 0.66));
    SOFT.uCarZ.value = zMin + 0.3;
    SOFT.uMaxScr.value = Math.max(0.004, (x1 - x0) / 3);
    SOFT.uCarW.value.setFromMatrixPosition(carMatrix);
    SOFT.uCarF.value.set(0, 0, -1).transformDirection(carMatrix);
    this.dust.update(time, this.sunView);
    this.spray?.update(time, this.sunView);
    this.mist?.update(time, this.sunView);
    this.stones.update(time, this.sunView);
    this.splash.update(time, this.sunView);
    this.weather?.update(time, camVel);
  }
}
