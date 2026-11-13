// Cameras: chase far / near, hood, bumper, trackside tv, replay helicopter; TvDirector picks trackside spots for replays.
// Chase: spring-damped follow of a lagged heading (drifts show the car's side), delayed height and pitch over crests,
// longitudinal inertia (accelerating pushes the camera back, braking lets it run up and tip forward), speed FOV,
// low-frequency road rumble, landing / impact shake, terrain floor + line-of-sight lift, keeps out of tree trunks.
import * as THREE from 'three';
import type { Ground } from '../sim/ground';
import type { Stage } from '../sim/stage/stage';

export type CamMode = 'far' | 'near' | 'hood' | 'bumper' | 'tv' | 'heli';
export const CAM_MODES: CamMode[] = ['far', 'near', 'hood', 'bumper'];

interface ChaseCfg {
  /** distance behind the CG (m) */
  dist: number;
  /** eye height above the CG (m) */
  height: number;
  /** look-at point: metres ahead of the CG and height above it */
  lookAhead: number;
  lookUp: number;
  /** vertical FOV at rest and the extra at ~180 km/h */
  fov: number;
  fovBoost: number;
  /** heading follow (1/s): lower = the car rotates more on screen before the camera swings round */
  yawRate: number;
}

/** framing targets (set with docs/screenshots/m2): car ≈ 1/5–1/4 of the frame height, horizon on the upper third */
export const CHASE: Record<'far' | 'near', ChaseCfg> = {
  far: { dist: 7.5, height: 2.05, lookAhead: 4.0, lookUp: 0.3, fov: 50, fovBoost: 7, yawRate: 3.0 },
  near: { dist: 6.5, height: 1.5, lookAhead: 4.0, lookUp: 0.35, fov: 50, fovBoost: 8, yawRate: 3.6 },
};

/** per-frame car state the game feeds the camera (events are consumed once) */
export interface CamFeed {
  /** landing vertical speed (m/s) this frame, 0 if none */
  landed: number;
  /** strongest obstacle / body impact speed (m/s) this frame */
  impact: number;
  /** bump-stop closing speed (m/s) */
  bottomOut: number;
  /** surface roughness 0..1 under the wheels (gravel ~0.5, asphalt ~0.1) */
  rough: number;
  /** wheels on the ground 0..4 */
  grounded: number;
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
/** ring around the eye for the floor (m) and the line-of-sight samples between eye and car */
const RING: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LOS_F = [0.2, 0.4, 0.6, 0.8];

/** critically damped spring toward a moving target (position + velocity feed-forward): follows steady motion with
 *  no lag, lags only when the target accelerates — which is exactly the "weight" a chase camera should show */
function follow(x: THREE.Vector3, v: THREE.Vector3, target: THREE.Vector3, targetVel: THREE.Vector3, omega: number, dt: number) {
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    for (const k of ['x', 'y', 'z'] as const) {
      const a = omega * omega * (target[k] - x[k]) + 2 * omega * (targetVel[k] - v[k]);
      v[k] += a * h;
      x[k] += v[k] * h;
    }
    target.addScaledVector(targetVel, h);
  }
}

function follow1(x: number, v: number, target: number, targetVel: number, omega: number, dt: number): [number, number] {
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const a = omega * omega * (target - x) + 2 * omega * (targetVel - v);
    v += a * h; x += v * h; target += targetVel * h;
  }
  return [x, v];
}

export class ChaseCamera {
  mode: CamMode = 'far';
  readonly cam: THREE.PerspectiveCamera;
  /** 'tv' mode: fixed trackside position (set by the game), looks at the car */
  tvPos = new THREE.Vector3();
  /** 'tv' mode: zoom so the car keeps roughly the same size on screen (replays); off = fixed 40° (tools) */
  tvZoom = false;
  private heliPos = new THREE.Vector3();
  private heliVel = new THREE.Vector3();

  private heading = new THREE.Vector3(0, 0, -1);
  private pos = new THREE.Vector3();
  private posVel = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookVel = new THREE.Vector3();
  private camY = 0;
  private camYVel = 0;
  private carYf = 0;
  private headingLagY = 0;
  private carYfVel = 0;
  /** smoothed car forward incl. pitch (for crest pitch lag) */
  private pitchFwd = new THREE.Vector3(0, 0, -1);
  private initialized = false;
  private fovBoost = 0;
  private t = 0;
  // longitudinal inertia
  private prevVel = new THREE.Vector3();
  private accel = 0;
  private surge = 0;
  private surgeVel = 0;
  // shakes
  private shake = 0;
  private shakeT = 0;
  private rumbleAmt = 0;
  private feed: CamFeed = { landed: 0, impact: 0, bottomOut: 0, rough: 0.5, grounded: 4 };
  // hood / bumper smoothing
  private hoodQuat = new THREE.Quaternion();
  /** diagnostics for scripts/camshots */
  dbg = { pushed: 0, surge: 0, tgt: 0, act: 0, dt: 0 };
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(CHASE.far.fov, aspect, 0.15, 12000);
  }

  snap() { this.initialized = false; }

  /** eye points for the hood / bumper cams, measured on the actual car model (it is generated per car) */
  private hoodEye = new THREE.Vector3(0, 0.74, -0.62);
  private bumperEye = new THREE.Vector3(0, -0.12, -2.08);

  /** call once the car model exists: finds the hood surface and the front of the body by ray casting the mesh
   *  (model space = sim body frame, origin at the CG) */
  fitToModel(root: THREE.Object3D, cgHeight: number) {
    const saveP = root.position.clone(), saveQ = root.quaternion.clone(), saveS = root.scale.clone();
    root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const rc = new THREE.Raycaster();
    const topAt = (z: number) => {
      rc.set(new THREE.Vector3(0, box.max.y + 1, z), new THREE.Vector3(0, -1, 0));
      const h = rc.intersectObject(root, true).find((i) => (i.object as THREE.Mesh).isMesh && i.object.visible);
      return h ? h.point.y : NaN;
    };
    // walk back from the nose: the hood is the low flat part, the windscreen base is where the top jumps up
    const minZ = box.min.z, len = box.max.z - box.min.z;
    let hoodY = NaN, screenZ = minZ + len * 0.3;
    let prev = NaN;
    for (let z = minZ + len * 0.06; z < minZ + len * 0.55; z += len * 0.02) {
      const y = topAt(z);
      if (!Number.isFinite(y)) continue;
      if (Number.isFinite(prev) && y - prev > 0.06 && Number.isFinite(hoodY)) { screenZ = z; break; }
      if (!Number.isFinite(hoodY) || z < minZ + len * 0.35) hoodY = Number.isFinite(hoodY) ? Math.max(hoodY, y) : y;
      prev = y;
    }
    if (Number.isFinite(hoodY)) this.hoodEye.set(0, hoodY + 0.36, screenZ - 0.12);
    this.bumperEye.set(0, -cgHeight + 0.42, minZ - 0.06);
    root.position.copy(saveP); root.quaternion.copy(saveQ); root.scale.copy(saveS);
    root.updateMatrixWorld(true);
  }

  /** game → camera: per-frame events and surface info */
  setFeed(f: Partial<CamFeed>) {
    Object.assign(this.feed, f);
    const hit = Math.max(this.feed.landed * 0.16, this.feed.impact * 0.12, this.feed.bottomOut * 0.1);
    if (hit > this.shake * 0.6) { this.shake = Math.min(1, Math.max(this.shake, hit)); this.shakeT = 0; }
    this.feed.landed = 0; this.feed.impact = 0; this.feed.bottomOut = 0;
  }

  /** carPos/carQuat: interpolated CG pose; vel: world velocity */
  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, vel: THREE.Vector3, ground: Ground, shakeAmt: number) {
    this.t += dt;
    const cam = this.cam;
    this.fwd.set(0, 0, -1).applyQuaternion(carQuat);
    this.up.set(0, 1, 0).applyQuaternion(carQuat);
    const speed = vel.length();
    // longitudinal acceleration along the car (smoothed), for surge/pitch inertia
    if (dt > 0) {
      // horizontal only: landings and crests must not read as braking/accelerating
      const fx = this.fwd.x, fz = this.fwd.z, fl = Math.hypot(fx, fz) || 1;
      const a = ((vel.x - this.prevVel.x) * fx + (vel.z - this.prevVel.z) * fz) / fl / dt;
      this.accel += (THREE.MathUtils.clamp(a, -14, 14) - this.accel) * (1 - Math.exp(-dt * 6));
    }
    this.prevVel.copy(vel);
    // shake envelopes
    this.shakeT += dt;
    this.shake *= Math.exp(-dt * 5.5);
    const roughTarget = this.feed.grounded > 0 ? this.feed.rough * Math.min(1, speed / 28) * (0.5 + 0.5 * shakeAmt) : 0;
    this.rumbleAmt += (roughTarget - this.rumbleAmt) * (1 - Math.exp(-dt * 4));

    if (this.mode === 'tv') {
      cam.position.copy(this.tvPos);
      cam.up.set(0, 1, 0);
      cam.lookAt(carPos.x, carPos.y + 0.3, carPos.z);
      cam.fov = this.tvZoom ? THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(5.5 / Math.max(1, cam.position.distanceTo(carPos)))), 9, 48) : 40;
      cam.updateProjectionMatrix();
      return;
    }
    if (this.mode === 'heli') { this.updateHeli(dt, carPos, vel); return; }
    if (this.mode === 'hood' || this.mode === 'bumper') { this.updateHood(dt, carPos, carQuat, speed); return; }

    const cfg = CHASE[this.mode];
    // heading: flat forward, blended toward the velocity when moving (a slide shows the car's angle)
    const flat = tmpA.set(this.fwd.x, 0, this.fwd.z);
    if (flat.lengthSq() < 1e-4) flat.set(this.heading.x, 0, this.heading.z);
    flat.normalize();
    if (speed > 4) {
      const vflat = tmpB.set(vel.x, 0, vel.z).normalize();
      flat.lerp(vflat, Math.min(0.5, (speed - 4) * 0.03)).normalize();
    }
    if (!this.initialized) {
      this.heading.copy(flat);
      this.pitchFwd.copy(this.fwd);
      this.camY = carPos.y + cfg.height; this.camYVel = 0;
      this.surge = 0; this.surgeVel = 0; this.accel = 0;
    }
    // heading lag: exponential, faster when the error is large so it never loses the car
    const err = 1 - this.heading.dot(flat);
    const kh = 1 - Math.exp(-dt * cfg.yawRate * (1 + err * 6));
    this.heading.lerp(flat, kh).normalize();
    this.headingLagY = this.heading.x * flat.z - this.heading.z * flat.x;
    // crest pitch lag: the camera's sense of "forward" follows the car's pitch slowly
    this.pitchFwd.lerp(this.fwd, 1 - Math.exp(-dt * 2.2)).normalize();
    // surge: accelerating pushes the camera back, braking lets it close in (spring on a target offset)
    const surgeTarget = THREE.MathUtils.clamp(this.accel * 0.075, -0.75, 0.6);
    {
      const om = 5.5, e = Math.exp(-om * dt), d = this.surge - surgeTarget, c = this.surgeVel + om * d;
      this.surge = surgeTarget + (d + c * dt) * e; this.surgeVel = (this.surgeVel - om * c * dt) * e;
    }
    const dist = cfg.dist + this.surge;
    const target = tmpC.copy(carPos).addScaledVector(this.heading, -dist);
    // delayed vertical follow: a filtered copy of the car's height tracks steady climbs exactly but lags crests,
    // jumps and landings (the car pops up before the camera does)
    if (!this.initialized) { this.carYf = carPos.y; this.carYfVel = vel.y; }
    [this.carYf, this.carYfVel] = follow1(this.carYf, this.carYfVel, carPos.y - vel.y * dt, vel.y, 4.2, dt);
    const lag = this.mode === 'near' ? 0.6 : 0.9;
    this.camY = THREE.MathUtils.clamp(this.carYf + cfg.height - this.surge * 0.12, carPos.y + cfg.height - lag, carPos.y + cfg.height + lag * 1.4);
    target.y = this.camY;
    const d0 = Math.hypot(target.x - carPos.x, target.z - carPos.z);
    this.keepClear(target, carPos, ground);
    this.dbg.pushed = d0 - Math.hypot(target.x - carPos.x, target.z - carPos.z);
    this.dbg.surge = this.surge;
    if (!this.initialized) { this.pos.copy(target); this.posVel.copy(vel); }
    follow(this.pos, this.posVel, tmpB.copy(target).addScaledVector(vel, -dt), vel, 11, dt);
    // the spring may lag into a bank (fast direction change, after a reset): the eye itself never goes below the floor
    {
      const fl = this.floorAt(ground, this.pos.x, this.pos.z) + 0.5;
      if (this.pos.y < fl) { this.pos.y = fl; if (this.posVel.y < 0) this.posVel.y = 0; }
    }
    // look point: ahead along the lagged heading, raised; pitch follows the smoothed car pitch (crest lag)
    const lookT = tmpA.copy(carPos).addScaledVector(this.heading, cfg.lookAhead);
    lookT.y = carPos.y + cfg.lookUp + this.pitchFwd.y * cfg.lookAhead * 0.75 - this.surge * 0.25;
    if (!this.initialized) { this.look.copy(lookT); this.lookVel.copy(vel); this.initialized = true; }
    follow(this.look, this.lookVel, lookT.addScaledVector(vel, -dt), vel, 14, dt);
    cam.position.copy(this.pos);
    this.dbg.tgt = Math.hypot(target.x - carPos.x, target.z - carPos.z);
    this.dbg.act = Math.hypot(this.pos.x - carPos.x, this.pos.z - carPos.z);
    this.dbg.dt = dt;
    this.applyShake(cam, 1);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    // a touch of roll toward the slide/turn, plus rumble roll
    const roll = THREE.MathUtils.clamp(this.headingLagY * 0.6, -0.04, 0.04) + this.rumbleRoll() * 0.004;
    cam.rotateZ(roll);
    // speed FOV (ease in; ~0 at 40 km/h, full at ~180)
    const want = cfg.fovBoost * THREE.MathUtils.smoothstep(speed, 11, 50);
    this.fovBoost += (want - this.fovBoost) * (1 - Math.exp(-dt * 2.0));
    cam.fov = cfg.fov + this.fovBoost;
    cam.updateProjectionMatrix();
  }

  /** replay helicopter: high behind-and-beside the car, lagging its heading, slow drifting orbit */
  private updateHeli(dt: number, carPos: THREE.Vector3, vel: THREE.Vector3) {
    const cam = this.cam;
    const flat = tmpA.set(vel.x, 0, vel.z);
    if (flat.lengthSq() > 4) this.heading.lerp(flat.normalize(), 1 - Math.exp(-dt * 0.8)).normalize();
    const side = tmpB.set(-this.heading.z, 0, this.heading.x);
    const orbit = Math.sin(this.t * 0.07) * 0.8;
    const target = tmpC.copy(carPos).addScaledVector(this.heading, -22 * Math.cos(orbit)).addScaledVector(side, 22 * Math.sin(orbit));
    target.y = carPos.y + 17;
    if (!this.initialized) { this.heliPos.copy(target); this.heliVel.copy(vel); this.initialized = true; }
    follow(this.heliPos, this.heliVel, target.addScaledVector(vel, -dt), vel, 1.6, dt);
    cam.position.copy(this.heliPos);
    cam.up.set(0, 1, 0);
    cam.lookAt(carPos.x, carPos.y + 0.5, carPos.z);
    cam.fov = 34;
    cam.updateProjectionMatrix();
  }

  private rumbleRoll() { const t = this.t; return Math.sin(t * 23.1) * 0.6 + Math.sin(t * 37.7 + 1.1) * 0.4; }

  /** road rumble (low-frequency, few cm) + landing/impact shake (decaying ~8 Hz) */
  private applyShake(cam: THREE.PerspectiveCamera, scale: number) {
    const t = this.t, r = this.rumbleAmt * scale;
    if (r > 0.001) {
      cam.position.y += (Math.sin(t * 17.3) * 0.6 + Math.sin(t * 29.9 + 0.7) * 0.3 + Math.sin(t * 7.1 + 2.0) * 0.5) * 0.012 * r;
      cam.position.x += (Math.sin(t * 13.7 + 0.4) * 0.6 + Math.sin(t * 31.3) * 0.3) * 0.008 * r;
    }
    if (this.shake > 0.003) {
      const k = this.shake * scale, ph = this.shakeT * 2 * Math.PI;
      cam.position.y += Math.sin(ph * 8.0) * 0.11 * k;
      cam.position.x += Math.sin(ph * 6.3 + 1.0) * 0.05 * k;
    }
  }

  /** ground under the eye incl. a 1 m ring (a steep cutting wall right beside the eye would be clipped through by the
   *  near plane even when the point itself is above the ground) */
  private floorAt(ground: Ground, x: number, z: number) {
    let h = ground.height(x, z);
    for (const [dx, dz] of RING) h = Math.max(h, ground.height(x + dx, z + dz) - 0.35);
    return h;
  }

  /** terrain floor, line of sight to the car, and no standing inside trunks/rocks. In a deep cutting / tight bend
   *  (the point behind the car is inside the bank) the camera comes closer instead of climbing high over the wall. */
  private keepClear(p: THREE.Vector3, carPos: THREE.Vector3, ground: Ground) {
    for (let it = 0; it < 3; it++) {
      const g = this.floorAt(ground, p.x, p.z);
      // more than ~2.5 m of bank above the car where the camera wants to be: pull in toward the car
      if (g + 0.65 - (carPos.y + 2.05) > 2.5) { p.x += (carPos.x - p.x) * 0.35; p.z += (carPos.z - p.z) * 0.35; continue; }
      break;
    }
    const floor = this.floorAt(ground, p.x, p.z) + 0.65;
    if (p.y < floor) { p.y = floor; this.camY = Math.max(this.camY, floor); this.camYVel = Math.max(0, this.camYVel); }
    // line of sight: terrain between camera and car (crest behind, bank on the inside) → lift (or come closer if the
    // lift would be large)
    for (let it = 0; it < 2; it++) {
      let need = 0;
      for (const f of LOS_F) {
        const x = p.x + (carPos.x - p.x) * f, z = p.z + (carPos.z - p.z) * f;
        const yLine = p.y + (carPos.y + 0.4 - p.y) * f;
        const h = ground.height(x, z) + 0.3;
        if (h > yLine) need = Math.max(need, (h - yLine) / (1 - f));
      }
      if (need <= 0) break;
      if (need > 2.5 && it === 0) { p.x += (carPos.x - p.x) * 0.4; p.z += (carPos.z - p.z) * 0.4; p.y = Math.max(p.y, this.floorAt(ground, p.x, p.z) + 0.65); continue; }
      p.y += need; this.camY = Math.max(this.camY, p.y);
      break;
    }
    // obstacles: push the camera toward the car until outside any trunk/rock (+0.45 m)
    for (let it = 0; it < 2; it++) {
      let hitT = 0;
      ground.obstaclesNear(p.x, p.z, 1.2, (o) => {
        if (p.y < o.y - 0.5 || (o.kind === 'cyl' && p.y > o.y + o.h + 0.5)) return;
        const d = Math.hypot(p.x - o.x, p.z - o.z), need = o.r + 0.45;
        if (d < need) hitT = Math.max(hitT, (need - d) / Math.max(0.5, Math.hypot(carPos.x - p.x, carPos.z - p.z)) + 0.05);
      });
      if (hitT <= 0) break;
      const k = Math.min(0.6, hitT);
      p.x += (carPos.x - p.x) * k; p.z += (carPos.z - p.z) * k;
    }
  }

  private updateHood(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, speed: number) {
    const cam = this.cam;
    const bumper = this.mode === 'bumper';
    const off = tmpA.copy(bumper ? this.bumperEye : this.hoodEye);
    cam.position.copy(off.applyQuaternion(carQuat).add(carPos));
    // a little rotational smoothing (stiff — it's bolted to the car — but takes the edge off gravel chatter)
    if (!this.initialized) { this.hoodQuat.copy(carQuat); this.initialized = true; }
    this.hoodQuat.slerp(carQuat, 1 - Math.exp(-dt * (bumper ? 22 : 16)));
    cam.quaternion.copy(this.hoodQuat);
    this.applyShake(cam, bumper ? 0.7 : 0.5);
    const base = bumper ? 72 : 66;
    const want = 10 * THREE.MathUtils.smoothstep(speed, 11, 50);
    this.fovBoost += (want - this.fovBoost) * (1 - Math.exp(-dt * 2.0));
    cam.fov = base + this.fovBoost;
    cam.updateProjectionMatrix();
  }
}

/** trackside camera spots along a stage for the replay "TV" view: every ~150 m, beside the road (outside of the bend
 *  preferred), at a height and distance from which the terrain does not hide the road around it; not inside trees */
/** rough sight-blocking volume per scenery kind at scale 1: radius, bottom and top of the blocking part (m above the
 *  ground) — tree crowns, buildings, rock piles. Ground cover is handled by a clearance over the terrain. */
const OCCLUDE: Partial<Record<string, [number, number, number]>> = {
  pine: [2.2, 0, 12], scots: [2.4, 2, 14], birch: [2.0, 1, 11], spruce: [1.3, 0, 4.5], snowpine: [2.2, 0, 12], snowspruce: [1.3, 0, 4.5],
  acacia: [3.4, 2.8, 7.5], thorn: [1.8, 0.8, 4], bare: [1.4, 1, 9], cypress: [1.0, 0, 10], olive: [2.4, 1.2, 5], umbrella: [3.8, 3.5, 10],
  bush: [1.1, 0, 1.5], boulder: [1.7, 0, 2.2], rockpile: [2.4, 0, 2], termite: [1.0, 0, 2.6], snowpile: [2.0, 0, 1.7], logs: [2.6, 0, 1.6],
  hay: [0.9, 0, 1.4], cabin: [4.2, 0, 5.5], house: [5.0, 0, 7], hut: [3.0, 0, 4], tent: [3.0, 0, 3], van: [2.8, 0, 3], tower: [2.2, 0, 8],
};

/** Trackside cameras for the replay: candidate spots along the road (outside of the bend preferred), each scored by
 *  how much of the approach it sees — the line from the lens to the car must clear the terrain (with room for ground
 *  cover) and every tree crown / building / rock pile in the way. Spots on the road, inside a cutting or on a steep
 *  bank face are rejected; a blocked spot is tried higher and further out before it is dropped. */
export class TvDirector {
  readonly spots: { s: number; pos: THREE.Vector3 }[] = [];
  private cur = -1;
  /** occluders on a 10 m grid: x, z, r, y0, y1 */
  private occ = new Map<number, number[]>();

  constructor(readonly stage: Stage) {
    const st = stage, e2 = st.terrain.edge2;
    for (const p of st.props) {
      const o = OCCLUDE[p.type];
      if (!o) continue;
      const k = p.scale || 1, gy = st.height(p.x, p.z);
      const r = o[0] * k, rec = [p.x, p.z, r, gy + o[1] * k, gy + o[2] * k];
      for (let gx = Math.floor((p.x - r) / 10); gx <= Math.floor((p.x + r) / 10); gx++) for (let gz = Math.floor((p.z - r) / 10); gz <= Math.floor((p.z + r) / 10); gz++) {
        const key = gx * 100003 + gz;
        let a = this.occ.get(key);
        if (!a) this.occ.set(key, (a = []));
        a.push(...rec);
      }
    }
    let k = 0;
    for (let s = st.startS + 30; s < st.finishS + 60; s += 70 + ((k++ * 37) % 40)) {
      const p = st.pointAt(s);
      let best: { score: number; pos: THREE.Vector3 } | null = null;
      // outside of the bend first (kappa > 0 bends toward +right → camera on the left)
      const sides = Math.abs(p.kappa) > 1e-4 ? [p.kappa > 0 ? -1 : 1, p.kappa > 0 ? 1 : -1] : [k % 2 ? 1 : -1, k % 2 ? -1 : 1];
      spot: for (const side of sides) for (const d of [e2 + 3.5, e2 + 8, e2 + 14, e2 + 22, e2 + 32]) for (const hgt of [2.6, 4.5, 8, 13, 20]) {
        const x = p.x + p.rx * d * side, z = p.z + p.rz * d * side;
        let blocked = false;
        st.obstaclesNear(x, z, 1.6, () => { blocked = true; });
        if (blocked || this.occludedAt(x, z, st.height(x, z) + hgt)) continue;
        // not on any road (a hairpin's other leg), not on a steep bank face, not down in a cutting
        const near = st.terrain.nearest(x, z);
        if (Math.abs(near.d) < e2 + 1.5) continue;
        const gy = st.height(x, z);
        let steep = 0;
        for (const [dx, dz] of RING) steep = Math.max(steep, Math.abs(st.height(x + dx * 2, z + dz * 2) - gy) / 2);
        if (steep > 1.1) continue;
        let wall = -Infinity;
        for (const [dx, dz] of RING) wall = Math.max(wall, st.height(x + dx * 4, z + dz * 4) - (gy + hgt));
        if (wall > -0.3) continue;
        const pos = new THREE.Vector3(x, gy + hgt, z);
        let vis = 0, n = 0, miss = 0;
        for (let q = s - 80; q <= s + 50; q += 10) {
          n++;
          const r = st.pointAt(q);
          if (this.sees(pos, r.x, r.y + 0.7, r.z)) vis++;
          else if (++miss > 5) break; // can no longer reach 60 % of the 14 samples
        }
        n = 14;
        const score = vis / n - hgt * 0.01 - d * 0.004 + (side === sides[0] ? 0.05 : 0);
        if (vis / n >= 0.6 && (!best || score > best.score)) best = { score, pos };
        if (vis === n && side === sides[0]) break spot; // sees everything from the preferred side: good enough (load time)
      }
      if (best) this.spots.push({ s, pos: best.pos });
    }
  }

  /** inside a crown / building? */
  private occludedAt(x: number, z: number, y: number) {
    const a = this.occ.get(Math.floor(x / 10) * 100003 + Math.floor(z / 10));
    if (!a) return false;
    for (let i = 0; i < a.length; i += 5) if (y > a[i + 3] && y < a[i + 4] + 1 && Math.hypot(x - a[i], z - a[i + 1]) < a[i + 2] + 0.8) return true;
    return false;
  }

  /** clear line from the lens to a point on the car: terrain (+0.6 m of grass / scrub except right at the car) and
   *  the occluders on the 10 m grid cells along the line */
  sees(pos: THREE.Vector3, tx: number, ty: number, tz: number) {
    const st = this.stage;
    for (let f = 0.08; f < 0.95; f += 0.06) {
      const sx = pos.x + (tx - pos.x) * f, sz = pos.z + (tz - pos.z) * f, sy = pos.y + (ty - pos.y) * f;
      if (st.height(sx, sz) + (f < 0.85 ? 0.6 : 0.25) > sy) return false;
    }
    const dx = tx - pos.x, dz = tz - pos.z, L = Math.hypot(dx, dz);
    const seen = new Set<number>();
    for (let t = 0; t <= L; t += 5) {
      const key = Math.floor((pos.x + (dx * t) / L) / 10) * 100003 + Math.floor((pos.z + (dz * t) / L) / 10);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.occ.get(key);
      if (!a) continue;
      for (let i = 0; i < a.length; i += 5) {
        // closest point of the segment (2D) to the occluder's axis, height of the line there
        const ox = a[i] - pos.x, oz = a[i + 1] - pos.z;
        const u = Math.max(0, Math.min(1, (ox * dx + oz * dz) / (L * L)));
        if (u > 0.97) continue; // the car is right at it (a tree by the road behind the car is fine)
        const cx = dx * u - ox, cz = dz * u - oz;
        if (cx * cx + cz * cz > a[i + 2] * a[i + 2]) continue;
        const y = pos.y + (ty - pos.y) * u;
        if (y > a[i + 3] && y < a[i + 4]) return false;
      }
    }
    return true;
  }

  /** trackside position for a car at progress s (null: no spot sees it → use another view). With the car's position
   *  the current spot is kept only while it really sees the car (a tree / bank between them → cut to the next spot
   *  ahead that does). */
  pick(s: number, car?: THREE.Vector3): THREE.Vector3 | null {
    const sp = this.spots;
    if (!sp.length) return null;
    const ok = (i: number) => !car || this.sees(sp[i].pos, car.x, car.y + 0.3, car.z);
    // keep the current spot until the car is 30 m past it, then cut to the next one ahead
    if (this.cur >= 0 && this.cur < sp.length && s <= sp[this.cur].s + 30 && s >= sp[this.cur].s - 170 && ok(this.cur)) return sp[this.cur].pos;
    let i = sp.findIndex((x) => x.s >= s - 30);
    if (i < 0) i = sp.length - 1;
    for (; i < sp.length && sp[i].s - s <= 170; i++) if (ok(i)) { this.cur = i; return sp[i].pos; }
    this.cur = -1;
    return null;
  }
  /** a cut happened since the last call? (the camera should snap) */
  get index() { return this.cur; }
}
