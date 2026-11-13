// The stage scene: renderer, sun (2-cascade shadow, half-rate) + poster lighting, terrain, vegetation, props, sky,
// water, car, particles, chunk LOD, post chain (aerial perspective, bloom, grade, vignette, grain).
import * as THREE from 'three';
import type { CarSpec } from '../data/cars';
import { SURFACES } from '../data/surfaces';
import type { Stage } from '../sim/stage/stage';
import type { Car } from '../sim/vehicle/car';
import { ChaseCamera } from './camera';
import { buildCarModel, type CarModel } from './carModel';
import { LOOK, PostFX, setLookFromPalette } from './look';
import { artPending, groundMaterial, loadPalette, type Palette } from './materials';
import { Fx, SOFT, Weather } from './particles';
import { buildProps, type PropsBuild } from './props';
import { buildLights, buildMountains, buildSky, buildWater, type Lights } from './sky';
import { buildTerrain, type TerrainBuild } from './terrain';
import { buildVegetation, type VegBuild } from './vegetation';

export interface Quality {
  name: string; renderScale: number; shadowSize: number; antialias: boolean;
  /** vegetation chunk LOD distances: full geometry / simplified geometry (beyond: billboards); ground cover */
  vegNear: number; vegLod: number; cover: number;
  dust: number;
  /** view depth covered by the two shadow cascades (m) */
  shadowRange: number;
}
export const QUALITIES: Record<string, Quality> = {
  perf: { name: 'perf', renderScale: 0.5, shadowSize: 1024, antialias: false, vegNear: 40, vegLod: 160, cover: 55, dust: 1800, shadowRange: 150 },
  default: { name: 'default', renderScale: 0.65, shadowSize: 2048, antialias: true, vegNear: 50, vegLod: 220, cover: 75, dust: 3000, shadowRange: 140 },
  high: { name: 'high', renderScale: 0.85, shadowSize: 2048, antialias: true, vegNear: 120, vegLod: 360, cover: 110, dust: 4000, shadowRange: 320 },
};

/** interpolated car pose handed to the view each frame */
export interface CarPose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  wheels: { ext: number; steer: number; spin: number; grounded: boolean; contact: THREE.Vector3; slide: number; surface: number }[];
}

export class StageView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly chase: ChaseCamera;
  pal!: Palette;
  terrain!: TerrainBuild;
  veg!: VegBuild;
  props!: PropsBuild;
  car!: CarModel;
  fx!: Fx;
  post!: PostFX;
  private lights!: Lights;
  private sunDir = new THREE.Vector3();
  private water!: THREE.Group;
  renderScale: number;
  gpuName = 'unknown';
  private time = 0;
  private frameNo = 0;
  private emitAcc = [0, 0, 0, 0];
  private stoneAcc = [0, 0, 0, 0];
  private splashAcc = [0, 0, 0, 0];
  private ripT = -1; private ripI = 0;
  /** radial speed blur on/off (settings; game.applyPost sets it) */
  speedBlur = true;
  /** road wetness (weather): tyre mist off wet asphalt */
  private wet = 0;
  private mistAcc = [0, 0, 0, 0];
  /** dust / gravel-chip emission multipliers (environment × weather) */
  dustScale = 1;
  stoneScale = 1;
  stats = { build: {} as Record<string, number> };
  // scratch
  private v1 = new THREE.Vector3(); private v2 = new THREE.Vector3(); private v3 = new THREE.Vector3();
  private carBox = new THREE.Box3();
  private camPrev = new THREE.Vector3();
  private camVel = new THREE.Vector3();

  constructor(readonly canvas: HTMLCanvasElement, readonly stage: Stage, readonly carSpec: CarSpec, readonly quality: Quality, renderScale?: number) {
    // MSAA happens in the post chain's render target; the canvas itself only receives the final full-screen pass
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    // count every pass of a frame (shadow, scene, bloom, final) in renderer.info
    this.renderer.info.autoReset = false;
    // live tuning handle for the lighting model (devtools: __look.uShadeMix.value = …)
    (window as unknown as { __look: typeof LOOK }).__look = LOOK;
    this.renderScale = renderScale ?? quality.renderScale;
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    this.chase = new ChaseCamera(innerWidth / innerHeight);
    // the GPU post chain replaces the CSS vignette/grain overlays (owned by the UI; hidden here, not removed)
    for (const id of ['grade', 'grain']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  }

  async build(onProgress?: (p: number, label: string) => void) {
    const t0 = performance.now();
    const st = this.stage;
    this.pal = await loadPalette(st.env, st.env.id === 'north' && st.weatherId === Object.keys(st.env.weathers)[0]);
    const pal = this.pal;
    setLookFromPalette(pal);
    this.scene.background = pal.look.hazeFar.clone();
    this.post = new PostFX(this.renderer, pal, this.quality.antialias ? 4 : 0);
    // height fog is relative to the stage's mean road height
    let mean = 0; for (let i = 0; i < st.terrain.prof.length; i += 10) mean += st.terrain.prof[i];
    mean /= Math.ceil(st.terrain.prof.length / 10);
    this.post.final.uniforms.uHazeLow.value = mean + pal.look.hazeLow;
    this.resize();
    onProgress?.(0.3, '地形');
    await nextFrame();
    const kind = st.env.road.kind === 'asphalt' ? 1 : st.env.road.kind === 'snow' ? 2 : 0;
    const gm = groundMaterial(st.env.id, pal, { halfWidth: st.def.halfWidth, edge1: st.terrain.edge1, edge2: st.terrain.edge2, kind, wet: st.weather.wet ?? 0, tex: st.env.tex, sea: st.terrain.coast?.seaLevel });
    this.terrain = buildTerrain(st, gm.material, st.def.seed);
    this.scene.add(this.terrain.group);
    this.stats.build.terrainMs = this.terrain.stats.ms;
    onProgress?.(0.6, '植被');
    await nextFrame();
    const t1 = performance.now();
    const q = this.quality;
    this.veg = buildVegetation(st, pal, { near: q.vegNear, mid: q.vegLod, cover: q.cover });
    this.scene.add(this.veg.group);
    this.stats.build.vegMs = performance.now() - t1;
    const t2 = performance.now();
    this.props = buildProps(st, pal);
    this.scene.add(this.props.group);
    this.stats.build.propsMs = performance.now() - t2;
    this.scene.add(buildSky(pal));
    this.scene.add(buildMountains(st, pal, st.def.seed));
    this.water = buildWater(st, pal);
    this.scene.add(this.water);
    this.lights = buildLights(pal, q.shadowSize, q.shadowRange);
    this.sunDir.copy(this.lights.dir);
    // fit the cascades to a fixed-FOV proxy of the view camera: the chase camera's speed FOV would otherwise change
    // the cascade size (and texel size) continuously and make shadow edges swim
    {
      const sh = this.lights.sun.shadow as unknown as { updateMatrices(l: THREE.Light, c?: THREE.Camera): void };
      const orig = sh.updateMatrices.bind(sh);
      const proxy = new THREE.PerspectiveCamera();
      sh.updateMatrices = (l, c) => {
        if (!c || !(c as THREE.PerspectiveCamera).isPerspectiveCamera) return orig(l, c);
        const pc = c as THREE.PerspectiveCamera;
        proxy.near = pc.near; proxy.far = pc.far; proxy.aspect = pc.aspect; proxy.fov = 75;
        proxy.updateProjectionMatrix();
        proxy.matrixWorld.copy(pc.matrixWorld);
        orig(l, proxy);
      };
    }
    LOOK.uSunW.value.copy(this.sunDir);
    this.scene.add(this.lights.sun, this.lights.hemi);
    this.car = buildCarModel(this.carSpec, 0);
    this.prepareCar(this.car);
    this.scene.add(this.car.root);
    const fxd = st.env.fx;
    const dustCol = fxd.dustColor ? new THREE.Color(fxd.dustColor) : pal.road.clone().lerp(new THREE.Color('#fff6e6'), 0.35);
    const snowSpray = fxd.spray === 'snow';
    this.fx = new Fx(q.dust, dustCol, pal.look.shadowTint.clone().lerp(dustCol, 0.45), pal.sun, { dustOpacity: snowSpray ? 0.22 : fxd.dustOpacity, splashCol: st.env.road.kind === 'snow' ? new THREE.Color('#f4f4fa') : undefined, snowSpray, mist: (st.weather.wet ?? 0) > 0 ? pal.look.hazeNear.clone().lerp(new THREE.Color('#ffffff'), 0.3) : undefined });
    // sprite light level: daylight 1; at night the sprites take the poster shade of their albedo (moonlit ambient) and
    // only the car's lamps light them up
    const night = !!st.weather.night;
    SOFT.uLight.value = night ? 1 : Math.min(1, pal.look.sunStrength / 0.9);
    SOFT.uNightL.value = night ? 1 : 0;
    {
      const L = pal.look, a = dustCol, lum = a.r * 0.299 + a.g * 0.587 + a.b * 0.114;
      const amb = L.ambSky.clone().multiply(a);
      SOFT.uShadeN.value.copy(amb).lerp(L.shadowTint.clone().multiplyScalar(0.25 + 1.1 * lum), L.shadowMix);
    }
    this.dustScale = fxd.dust * (st.weather.dust ?? 1);
    this.stoneScale = fxd.stones;
    if (st.weather.fall) {
      // rain on a "wet" (after the rain) weather is only a drizzle
      const drizzle = st.weather.fall === 'rain' && (st.weather.wet ?? 0) > 0;
      const w = new Weather(st.weather.fall, st.weather.fall === 'snow' ? 2600 : drizzle ? 1100 : 3200, st.weather.fall === 'snow' ? new THREE.Color(st.weather.night ? '#c8d0ea' : '#ffffff') : new THREE.Color('#c9d4dc'));
      if (drizzle) w.uniforms.uOpacity.value = 0.2;
      this.fx.setWeather(w);
    }
    this.wet = st.weather.wet ?? 0;
    if (st.weather.night) {
      LOOK.uHead.value = pal.look.headlights ?? 1;
      this.car.setLights(1, 1);
      this.car.setLightPod(true);
      this.prepareCar(this.car);
    } else LOOK.uHead.value = 0;
    this.scene.add(this.fx.group);
    this.fx.carBox.copy(this.carBox);
    this.post.soft = this.fx.soft;
    SOFT.uHaze.value.copy(pal.look.hazeNear).lerp(pal.look.hazeFar, 0.5);
    SOFT.uHazeK.value = pal.look.hazeDensity;
    onProgress?.(0.9, '着色器');
    await nextFrame();
    // let the art textures finish loading first (≤ 2.5 s): the warm-up frames then decode and upload them during
    // loading instead of in the first second of driving (100–140 ms hitch per new environment)
    for (let t = performance.now(); artPending() > 0 && performance.now() - t < 2500;) await nextFrame();
    this.renderer.compile(this.scene, this.chase.cam);
    this.warmup();
    this.stats.build.totalMs = performance.now() - t0;
  }

  /** the car casts its ground shadow analytically (two boxes in the terrain shader, every frame, never lags the half-rate
   *  shadow map); it is taken out of the sun shadow map so it does not leave a stale second shadow there */
  private prepareCar(model: CarModel) {
    model.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.root.matrixWorld).invert();
    this.carBox.makeEmpty();
    model.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      this.carBox.union(b);
    });
    const b = this.carBox;
    if (b.isEmpty()) b.set(new THREE.Vector3(-0.9, -0.3, -2), new THREE.Vector3(0.9, 1, 2));
    const c = b.getCenter(new THREE.Vector3()), h = b.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const lowTop = b.min.y + (b.max.y - b.min.y) * 0.55;
    // body: full footprint up to the belt line; cabin: narrower, shorter, up to the roof
    LOOK.uCarB1c.value.set(c.x, (b.min.y + 0.12 + lowTop) / 2, c.z);
    LOOK.uCarB1h.value.set(h.x * 0.94, (lowTop - b.min.y - 0.12) / 2, h.z * 0.96);
    LOOK.uCarB2c.value.set(c.x, (lowTop + b.max.y) / 2, c.z + h.z * 0.05);
    LOOK.uCarB2h.value.set(h.x * 0.8, (b.max.y - lowTop) / 2, h.z * 0.55);
  }

  /** one throw-away frame that sees everything (all LODs, cover, every caster in the shadow map) so shader programs,
   *  shadow-depth variants and textures are created during loading, not mid-stage */
  private warmup() {
    const cor = this.stage.corridor;
    const cx = cor.minX + (cor.nx * cor.cell) / 2, cz = cor.minZ + (cor.nz * cor.cell) / 2;
    const span = Math.max(cor.nx, cor.nz) * cor.cell;
    const cam = new THREE.PerspectiveCamera(70, 1, 1, 20000);
    cam.position.set(cx, span * 0.9, cz + 1);
    cam.lookAt(cx, 0, cz);
    cam.updateMatrixWorld();
    this.veg.showAll();
    const bb = this.veg.billboards?.material as THREE.ShaderMaterial | undefined;
    const flags = bb?.uniforms.uChunkFar.value as Float32Array | undefined;
    flags?.fill(1);
    // stretch the shadow range over the whole stage once so every caster's depth-material variant compiles now
    const sc = this.lights.sun.shadow.camera, range = sc.far;
    sc.far = 30000;
    this.lights.sun.shadow.needsUpdate = true;
    this.post.render(this.scene, cam, 0, this.sunDir);
    sc.far = range;
    flags?.fill(0);
    // a few real chase-camera viewpoints along the road: compiles the shadow-depth variants the overhead frame misses
    // (otherwise they compile mid-stage, 100–250 ms hitches)
    const st = this.stage, rc = new THREE.PerspectiveCamera(70, this.chase.cam.aspect, 0.15, 12000);
    for (let s = st.startS; s < st.finishS; s += 350) {
      const p = st.pointAt(s), a = st.pointAt(s + 40);
      rc.position.set(p.x - p.dx * 7, p.y + 3, p.z - p.dz * 7);
      rc.lookAt(a.x, a.y + 1, a.z);
      rc.updateMatrixWorld();
      this.veg.update(rc.position, 0);
      this.lights.sun.shadow.needsUpdate = true;
      this.post.render(this.scene, rc, 0, this.sunDir);
    }
    this.lights.sun.shadow.needsUpdate = true;
  }

  /** the canvas keeps the largest render scale used so far; dynamic resolution only shrinks the internal targets'
   *  sub-viewport (the final pass upsamples), so a change never reallocates the canvas drawing buffer (that stalled
   *  the GPU for 60–100 ms per step) */
  private canvasScale = 0;

  resize() {
    const w = innerWidth, h = innerHeight;
    this.canvasScale = Math.max(this.canvasScale, this.renderScale);
    this.renderer.setPixelRatio(devicePixelRatio * this.canvasScale);
    this.renderer.setSize(w, h, false);
    this.chase.cam.aspect = w / h;
    this.chase.cam.updateProjectionMatrix();
    this.post?.setSize(this.renderScale / this.canvasScale);
  }

  setRenderScale(s: number) {
    this.renderScale = s;
    if (s > this.canvasScale || !this.post) this.resize();
    else this.post.setSize(s / this.canvasScale);
  }

  updateCar(pose: CarPose, model = this.car) {
    model.root.position.copy(pose.pos);
    model.root.quaternion.copy(pose.quat);
    const spec = this.carSpec;
    model.wheels.forEach((w, i) => {
      const s = pose.wheels[i];
      const front = i < 2, left = i % 2 === 0;
      const a = spec.wheelbase * (1 - spec.frontWeight), b = spec.wheelbase * spec.frontWeight;
      const mountY = -(spec.cgHeight - spec.wheel.radius) + (spec.susp.travel - ((spec.mass * 9.81 * (front ? spec.frontWeight : 1 - spec.frontWeight)) / 2) / (front ? spec.susp.springF : spec.susp.springR));
      const track = front ? spec.trackF : spec.trackR;
      w.pivot.position.set((left ? -1 : 1) * track / 2, mountY - s.ext, front ? -a : b);
      w.pivot.rotation.y = -s.steer;
      w.spin.rotation.x = -s.spin;
    });
  }

  /** per-frame update: camera, LOD, car shadow, particles, half-rate shadow map; then render through the post chain */
  frame(dt: number, pose: CarPose, shake: number) {
    this.renderer.info.reset();
    this.time += dt;
    this.frameNo++;
    this.chase.update(dt, pose.pos, pose.quat, pose.vel, this.stage, shake);
    const cam = this.chase.cam;
    cam.updateMatrixWorld();
    this.veg.update(cam.position, this.time);
    this.props.update(this.time, pose.pos);
    (this.water.userData.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    // ford ripples: drop a ring source every 0.18 s while a wheel is in the water
    const fordMat = this.water.userData.ford as THREE.ShaderMaterial | undefined;
    if (fordMat && this.time - this.ripT > 0.18 && pose.wheels.some((w) => w.surface === 8)) {
      this.ripT = this.time;
      const rs = fordMat.uniforms.uRip.value as THREE.Vector4[];
      const w = pose.wheels[this.ripI % 4];
      rs[this.ripI % rs.length].set(w.contact.x, w.contact.y, w.contact.z, this.time);
      this.ripI++;
    }
    // analytic car shadow
    this.car.root.updateMatrixWorld();
    LOOK.uCarInv.value.copy(this.car.root.matrixWorld).invert();
    LOOK.uCarPos.value.copy(pose.pos);
    this.emitParticles(dt, pose);
    if (dt > 0) this.camVel.subVectors(cam.position, this.camPrev).multiplyScalar(1 / dt);
    this.camPrev.copy(cam.position);
    this.fx.update(this.time, this.sunDir, cam, this.car.root.matrixWorld, this.camVel);
    // shadow map at half rate (static scenery only; the car shadow is analytic)
    if (this.frameNo % 2 === 0) this.lights.sun.shadow.needsUpdate = true;
    // radial speed blur ramps in from 90 to 200 km/h (the switch and strength uniforms belong to the settings)
    const kmh = pose.vel.length() * 3.6;
    this.post.final.uniforms.uSpeedBlur.value = this.speedBlur ? THREE.MathUtils.smoothstep(kmh, 90, 200) : 0;
    this.post.render(this.scene, cam, this.time, this.sunDir);
  }

  private emitParticles(dt: number, pose: CarPose) {
    const speed = pose.vel.length();
    const right = this.v1.set(1, 0, 0).applyQuaternion(pose.quat);
    right.y = 0; right.normalize();
    const fwd = this.v3.set(0, 0, -1).applyQuaternion(pose.quat);
    fwd.y = 0; fwd.normalize();
    const lat = pose.vel.dot(right); // sideways speed (drift)
    const t = this.time;
    const dustK = this.dustScale;
    pose.wheels.forEach((w, i) => {
      if (!w.grounded) { this.emitAcc[i] = 0; return; }
      if (w.surface === 8 /* water */) {
        // wading: spray fans out of every wheel, more with speed
        this.splashAcc[i] += Math.min(70, speed * 3.0) * dt;
        while (this.splashAcc[i] >= 1) {
          this.splashAcc[i] -= 1;
          const side = i % 2 === 0 ? -1 : 1;
          const out = (1.5 + Math.random() * 3) * side;
          this.fx.splash.emit(t - Math.random() * dt, w.contact.x + right.x * side * 0.3, w.contact.y + 0.15, w.contact.z + right.z * side * 0.3,
            pose.vel.x * 0.35 + right.x * out - fwd.x * 1.5 + (Math.random() - 0.5) * 2, 2.5 + Math.random() * 3.5 + speed * 0.06, pose.vel.z * 0.35 + right.z * out - fwd.z * 1.5 + (Math.random() - 0.5) * 2,
            0.45 + Math.random() * 0.4, 0.12 + Math.random() * 0.12, 0.35 + Math.random() * 0.35 + speed * 0.008, Math.random() * 6.28, (Math.random() * 4) | 0);
        }
        return;
      }
      const loose = SURFACES[w.surface]?.loose ?? 0;
      if (this.fx.mist && loose <= 0.05 && i >= 2 && speed > 6) {
        // wet asphalt: a fine mist of road water lifted off the rear tyres, hanging low behind the car
        this.mistAcc[i] += this.wet * (speed - 6) * 3.0 * dt;
        while (this.mistAcc[i] >= 1) {
          this.mistAcc[i] -= 1;
          const side = i % 2 === 0 ? -1 : 1;
          this.fx.mist.emit(t - Math.random() * dt, w.contact.x - fwd.x * 0.5 + right.x * side * 0.1, w.contact.y + 0.2, w.contact.z - fwd.z * 0.5 + right.z * side * 0.1,
            pose.vel.x * 0.55 - fwd.x * 1.2 + (Math.random() - 0.5) * 1.4, 0.5 + Math.random() * 0.8, pose.vel.z * 0.55 - fwd.z * 1.2 + (Math.random() - 0.5) * 1.4,
            0.7 + Math.random() * 0.6, 0.3, 1.0 + Math.random() * 0.8 + speed * 0.015, Math.random() * 6.28, (Math.random() * 4) | 0);
        }
      }
      if (loose <= 0.05) return;
      const rear = i >= 2;
      const side = i % 2 === 0 ? -1 : 1;
      const slide = Math.min(w.slide, 14);
      if (this.fx.spray) { this.emitSnow(i, w, rear, side, slide, speed, lat, fwd, right, pose, dt); return; }
      const rate = loose * dustK * (Math.max(0, speed - 3) * (rear ? 1.0 : 0.35) + slide * (rear ? 3.0 : 1.5));
      this.emitAcc[i] += rate * dt;
      const k = Math.min(1, speed / 30);
      const throwK = Math.min(1, Math.abs(lat) / 8);
      while (this.emitAcc[i] >= 1) {
        this.emitAcc[i] -= 1;
        // born just behind and outside the tyre, thrown backward (relative to the ground: the tyre flings it back) and
        // outward; drifting adds the car's sideways motion. The car drives away from it → a trail that opens up behind.
        const back = 1.5 + slide * 0.35 + Math.random() * 1.5;
        const out = (0.8 + Math.random() * 1.6) * side;
        const vx = pose.vel.x * 0.06 - fwd.x * back + right.x * (out + lat * 0.35) + (Math.random() - 0.5) * 1.6;
        const vz = pose.vel.z * 0.06 - fwd.z * back + right.z * (out + lat * 0.35) + (Math.random() - 0.5) * 1.6;
        const px = w.contact.x - fwd.x * 0.45 + right.x * side * 0.2, pz = w.contact.z - fwd.z * 0.45 + right.z * side * 0.2;
        const s0 = 0.6 + Math.random() * 0.6 + k * 0.4;
        const s1 = 2.6 + k * 3.6 + throwK * 2.2 + Math.random() * 2.0;
        this.fx.dust.emit(t - Math.random() * dt, px, w.contact.y + 0.4 + Math.random() * 0.3, pz, vx, 0.5 + Math.random() * 1.2 + throwK * 0.8, vz,
          3.5 + k * 3.0 + Math.random() * 2.5, s0, s1, Math.random() * 6.28, (Math.random() * 4) | 0);
      }
      // gravel chips from the driven/sliding tyres
      if (rear || slide > 2) {
        this.stoneAcc[i] += loose * this.stoneScale * (Math.max(0, speed - 6) * 0.5 + slide * 2.2) * dt;
        while (this.stoneAcc[i] >= 1) {
          this.stoneAcc[i] -= 1;
          const back = this.v2.copy(pose.vel).multiplyScalar(-0.12);
          const sp = 2 + Math.random() * 4;
          this.fx.stones.emit(t - Math.random() * dt, w.contact.x, w.contact.y + 0.08, w.contact.z,
            back.x + right.x * lat * 0.35 + (Math.random() - 0.5) * sp, 1.5 + Math.random() * 3.5, back.z + right.z * lat * 0.35 + (Math.random() - 0.5) * sp,
            0.5 + Math.random() * 0.6, 0.07 + Math.random() * 0.07, 0.07, Math.random() * 6.28, (Math.random() * 4) | 0);
        }
      }
    });
  }

  /** powder snow: many small flakes flung back and up off the tread (falling, dispersing) + a faint size-capped mist */
  private emitSnow(i: number, w: CarPose['wheels'][number], rear: boolean, side: number, slide: number, speed: number, lat: number,
    fwd: THREE.Vector3, right: THREE.Vector3, pose: CarPose, dt: number) {
    const t = this.time, k = this.dustScale;
    const rate = k * (Math.max(0, speed - 2.5) * (rear ? 6 : 2) + slide * (rear ? 13 : 5));
    this.emitAcc[i] += rate * dt;
    const throwK = Math.min(1, Math.abs(lat) / 8);
    while (this.emitAcc[i] >= 1) {
      this.emitAcc[i] -= 1;
      const r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
      const back = 1.2 + speed * 0.12 + slide * 0.3 + r1 * 2.2;
      const out = (0.3 + r2 * 1.4) * side + (Math.random() - 0.5) * 0.8;
      const up = 1.2 + r3 * 2.6 + speed * 0.05 + throwK * 0.8;
      const vx = pose.vel.x * 0.35 - fwd.x * back + right.x * (out + lat * 0.3);
      const vz = pose.vel.z * 0.35 - fwd.z * back + right.z * (out + lat * 0.3);
      const px = w.contact.x - fwd.x * (0.3 + Math.random() * 0.3) + right.x * side * (0.05 + Math.random() * 0.2);
      const pz = w.contact.z - fwd.z * (0.3 + Math.random() * 0.3) + right.z * side * (0.05 + Math.random() * 0.2);
      const s0 = 0.04 + Math.random() * 0.06, s1 = 0.14 + Math.random() * 0.26 + throwK * 0.15;
      this.fx.spray!.emit(t - Math.random() * dt, px, w.contact.y + 0.12 + Math.random() * 0.15, pz, vx, up, vz,
        0.55 + Math.random() * 0.8, s0, s1, Math.random() * 6.28, (Math.random() * 4) | 0);
      // one in six also leaves a faint drifting mist puff
      if (Math.random() < 0.16) {
        this.fx.dust.emit(t - Math.random() * dt, px - fwd.x * 0.6, w.contact.y + 0.3, pz - fwd.z * 0.6, vx * 0.4, 0.3 + Math.random() * 0.5, vz * 0.4,
          1.2 + Math.random() * 1.2, 0.4, 1.1 + Math.random() * 0.9 + throwK * 0.6, Math.random() * 6.28, (Math.random() * 4) | 0);
      }
    }
  }

  /** water spray at a point (wading; called by whoever detects water contact) */
  splash(x: number, y: number, z: number, vx: number, vz: number, amount: number) {
    for (let i = 0; i < amount; i++) {
      this.fx.splash.emit(this.time, x, y + 0.1, z, vx * 0.3 + (Math.random() - 0.5) * 3, 2 + Math.random() * 3, vz * 0.3 + (Math.random() - 0.5) * 3, 0.6 + Math.random() * 0.5, 0.3, 1.4, Math.random() * 6.28, (Math.random() * 4) | 0);
    }
  }

  info() {
    const r = this.renderer.info;
    return { calls: r.render.calls, triangles: r.render.triangles, programs: r.programs?.length ?? 0, geometries: r.memory.geometries, textures: r.memory.textures };
  }
}

export function poseFromCar(car: Car, out?: CarPose): CarPose {
  const p = out ?? {
    pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(),
    wheels: car.wheels.map(() => ({ ext: 0, steer: 0, spin: 0, grounded: false, contact: new THREE.Vector3(), slide: 0, surface: 0 })),
  };
  p.pos.set(car.pos.x, car.pos.y, car.pos.z);
  p.quat.set(car.quat.x, car.quat.y, car.quat.z, car.quat.w);
  p.vel.set(car.vel.x, car.vel.y, car.vel.z);
  car.wheels.forEach((w, i) => {
    const o = p.wheels[i];
    o.ext = w.ext; o.steer = w.steer; o.spin = w.spin; o.grounded = w.grounded; o.slide = w.slideSpeed; o.surface = w.surface;
    o.contact.set(w.contact.x, w.contact.y, w.contact.z);
  });
  return p;
}

/** a = prev, b = current, alpha in [0,1] → out */
export function lerpPose(a: CarPose, b: CarPose, alpha: number, out: CarPose) {
  out.pos.lerpVectors(a.pos, b.pos, alpha);
  out.quat.slerpQuaternions(a.quat, b.quat, alpha);
  out.vel.lerpVectors(a.vel, b.vel, alpha);
  for (let i = 0; i < out.wheels.length; i++) {
    const o = out.wheels[i], wa = a.wheels[i], wb = b.wheels[i];
    o.ext = wa.ext + (wb.ext - wa.ext) * alpha;
    o.steer = wa.steer + (wb.steer - wa.steer) * alpha;
    o.spin = wa.spin + (wb.spin - wa.spin) * alpha;
    o.grounded = wb.grounded; o.slide = wb.slide; o.surface = wb.surface;
    o.contact.lerpVectors(wa.contact, wb.contact, alpha);
  }
  return out;
}

export function clonePose(p: CarPose): CarPose {
  return {
    pos: p.pos.clone(), quat: p.quat.clone(), vel: p.vel.clone(),
    wheels: p.wheels.map((w) => ({ ...w, contact: w.contact.clone() })),
  };
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
