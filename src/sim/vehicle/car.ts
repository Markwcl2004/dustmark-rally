// Rigid-body car: raycast suspension, Pacejka tires (velocity-capped, sequential impulses), drivetrain, body collision.
import type { CarSpec } from '../../data/cars';
import { SURFACES, Surface } from '../../data/surfaces';
import type { Ground, Obstacle } from '../ground';
import { Quat, V3, clamp, moveTowards } from '../math/vec';
import { ASSIST_TUNING, Controls, DEFAULT_ASSISTS, HB_SLIP, hbSlipAt, type Assists, type DriverInput } from './controls';
import { tireCurve, tireForces, type TireOut } from './tire';
import { TUNE, type Tune } from './tune';

export const DT = 1 / 120;
/** drift assist: extra rear-wheel slip (normalized) traction control allows while a drift is held */
const DRIFT_SPIN = 3;
const smooth01 = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const G = 9.81;
const RHO = 1.225;
const RPM = 60 / (2 * Math.PI);
/** peak slip ratio of the surface the assists were tuned on (gravel) */
const GRAVEL_PEAK = 0.16;

export interface Wheel {
  index: number;
  front: boolean;
  left: boolean;
  /** body-frame hardpoint (top of travel) */
  mount: V3;
  /** current extension 0..travel; wheel centre = mount - up*ext */
  ext: number;
  comp: number;
  compPrev: number;
  omega: number;
  spin: number;
  steer: number;
  grounded: boolean;
  /** suspension force (N) */
  load: number;
  /** tyre normal load (N): suspension force through a ~12 Hz unsprung-mass lag, so a massless raycast wheel
   *  doesn't drop to zero grip on every rebound stroke over rough gravel */
  tireLoad: number;
  contact: V3;
  normal: V3;
  surface: number;
  slipRatio: number;
  slipAngle: number;
  /** sliding speed of the contact patch (m/s), for dust/skid effects */
  slideSpeed: number;
  /** longitudinal slip velocity ωr − v (m/s), + = wheelspin */
  slipVel: number;
  /** combined slip normalised to the tyre peak (1 = at the friction limit) */
  combSlip: number;
  driveTorque: number;
  /** grounded in water (ford): renderers spray, audio sloshes */
  inWater: boolean;
}

interface Sphere { p: V3; r: number }

export interface CarEvents {
  /** impacts this tick: largest normal speed (m/s) against obstacles */
  obstacleHit: number;
  /** largest body-vs-ground penetration speed this tick */
  bodyHit: number;
  landed: number;
  /** strongest bump-stop closing speed this tick (m/s), for clunks / camera */
  bottomOut: number;
  /** +1 upshift / -1 downshift started this tick */
  shift: number;
  /** speed (m/s) at which a wheel entered water this tick (0 = none): splash one-shot */
  splash: number;
}

export class Car {
  readonly spec: CarSpec;
  pos = new V3();
  quat = new Quat();
  vel = new V3();
  angVel = new V3();
  wheels: Wheel[] = [];
  controls = new Controls();
  assists: Assists = { ...DEFAULT_ASSISTS };
  transmission: 'auto' | 'manual' = 'auto';

  gear = 1;
  pendingGear = 1;
  shiftTimer = 0;
  rpm = 1000;
  boost = 0;
  /** first stage of the two-stage turbo spool (engine.spool) */
  private spoolState = 0;
  limiterCut = false;
  reverseHold = 0;
  /** seconds since the last automatic upshift (blocks an immediate un-braked downshift: no gear hunting) */
  private sinceUp = 9;
  private prevUp = false;
  private prevDown = false;

  /** derived each tick */
  speed = 0;
  fwdSpeed = 0;
  slideAngle = 0;
  airTime = 0;
  groundedCount = 0;
  engineTorque = 0;
  throttleOut = 0;
  brakeOut = 0;
  events: CarEvents = { obstacleHit: 0, bodyHit: 0, landed: 0, bottomOut: 0, shift: 0, splash: 0 };
  /** how long ABS has been releasing wheels without a break (s) */
  absTime = 0;
  /** traction-control throttle multiplier (1 = not cutting) */
  tcMul = 1;
  private hbTimer = 0;
  /** yaw rate about body up (rad/s, + = turning right) */
  yawRate = 0;
  /** surface friction under the front tyres last tick (robot drivers read it) */
  frontMu = 1;
  /** tan of the peak slip angle of the tyres under the front wheels last tick (keyboard steering's grip window) */
  frontTanPeak = 0.23;
  /** feel knobs (URL grip= / slipcap= / push= / steerrate=), copied from TUNE when the car is built */
  tune: Tune = { ...TUNE };
  /** push-wide protection: throttle multiplier (1 = not trimming) */
  pushMul = 1;
  /** filtered longitudinal acceleration (m/s²) and last tick's forward speed */
  axF = 0;
  private prevFwd = 0;
  /** a drift the driver started is being held with the key into it (drift assist) */
  holdDrift = false;
  /** seconds since the body slip was last past 20° (a deliberate slide: no push-wide trimming on its way out) */
  driftT = 9;
  /** handbrake assist: rear handbrake force multiplier (1 = full) */
  hbMul = 1;

  /** traction-control floor scale: TC floors are tuned on a car whose 1st-gear drive force is ~2× its driven-axle
   *  grip; a car with more (e.g. a light rear-drive car on gravel) may cut proportionally deeper */
  readonly tcFloorScale: number;
  /** handbrake assist slip limit (rad) */
  readonly hbSlip: number;

  private invI = new V3();
  private spheres: Sphere[] = [];
  private staticComp: number[] = [];

  // scratch
  private right = new V3(); private up = new V3(); private fwd = new V3();
  private F = new V3(); private T = new V3();
  private t1 = new V3(); private t2 = new V3(); private t3 = new V3(); private t4 = new V3();
  private tire: TireOut = { fx: 0, fy: 0, sx: 0, sy: 0 };

  constructor(spec: CarSpec) {
    this.spec = spec;
    const { length: L, width: W, height: H } = spec.dims;
    const m = spec.mass, s = spec.inertiaScale;
    // box inertia about body axes (x pitch, y yaw, z roll)
    const Ix = (m / 12) * (H * H + L * L) * s[0];
    const Iy = (m / 12) * (W * W + L * L) * s[1];
    const Iz = (m / 12) * (W * W + H * H) * s[2];
    this.invI.set(1 / Ix, 1 / Iy, 1 / Iz);
    {
      const e = spec.engine, gb = spec.gearbox;
      const tMax = Math.max(...e.torque.map((p) => p[1]));
      const fDrive = (tMax * gb.ratios[0] * gb.final * gb.efficiency) / spec.wheel.radius;
      const axle = spec.drive === 'awd' ? 1 : spec.drive === 'fwd' ? spec.frontWeight : 1 - spec.frontWeight;
      const ratio = fDrive / (m * G * axle * 1.0);
      this.tcFloorScale = Math.min(1, 2.0 / ratio) * (spec.assist?.tcFloorMul ?? 1);
    }

    this.hbSlip = spec.assist?.hbSlipDeg !== undefined ? (spec.assist.hbSlipDeg * Math.PI) / 180 : HB_SLIP;
    const a = spec.wheelbase * (1 - spec.frontWeight); // CG → front axle
    const b = spec.wheelbase * spec.frontWeight; // CG → rear axle
    const r = spec.wheel.radius;
    for (let i = 0; i < 4; i++) {
      const front = i < 2, left = i % 2 === 0;
      const k = front ? spec.susp.springF : spec.susp.springR;
      const cornerLoad = (m * G * (front ? spec.frontWeight : 1 - spec.frontWeight)) / 2;
      const c0 = cornerLoad / k;
      this.staticComp.push(c0);
      const track = front ? spec.trackF : spec.trackR;
      // wheel centre at rest sits at y = -(cg - r); hardpoint is travel - c0 above it
      const mountY = -(spec.cgHeight - r) + (spec.susp.travel - c0);
      this.wheels.push({
        index: i, front, left,
        mount: new V3(left ? -track / 2 : track / 2, mountY, front ? -a : b),
        ext: spec.susp.travel - c0, comp: c0, compPrev: c0,
        omega: 0, spin: 0, steer: 0, grounded: false, load: 0, tireLoad: 0,
        contact: new V3(), normal: new V3(0, 1, 0), surface: Surface.Gravel,
        slipRatio: 0, slipAngle: 0, slideSpeed: 0, slipVel: 0, combSlip: 0, driveTorque: 0, inWater: false,
      });
    }
    // collision spheres (body frame, relative to CG)
    const hl = L / 2, hw = W / 2;
    const yb = -(spec.cgHeight - 0.2); // underbody level
    const add = (x: number, y: number, z: number, rr: number) => this.spheres.push({ p: new V3(x, y, z), r: rr });
    add(-hw + 0.25, yb + 0.22, -hl + 0.45, 0.24); add(hw - 0.25, yb + 0.22, -hl + 0.45, 0.24);
    add(-hw + 0.25, yb + 0.22, hl - 0.4, 0.24); add(hw - 0.25, yb + 0.22, hl - 0.4, 0.24);
    add(0, yb + 0.24, -0.55, 0.26); add(0, yb + 0.24, 0.6, 0.26);
    add(0, yb + 0.35, -hl + 0.3, 0.3); add(0, yb + 0.35, hl - 0.3, 0.3);
    const roofY = H - spec.cgHeight - 0.28;
    add(-hw + 0.35, roofY, -0.55, 0.28); add(hw - 0.35, roofY, -0.55, 0.28);
    add(-hw + 0.35, roofY, 0.75, 0.28); add(hw - 0.35, roofY, 0.75, 0.28);
  }

  get spheresBody(): readonly Sphere[] { return this.spheres; }

  /** place the car at rest on the ground, nose pointing along heading (dx,dz) */
  reset(ground: Ground, x: number, z: number, dx: number, dz: number) {
    // align to the terrain under the car
    const n = ground.normal(x, z, new V3());
    const f = new V3(dx, 0, dz).normalize();
    f.addScaled(n, -f.dot(n)).normalize();
    const back = f.clone().scale(-1);
    const rgt = new V3().crossOf(n, back).normalize();
    this.quat.setFromBasis(rgt, n, back);
    const h = ground.height(x, z);
    this.pos.set(x, h + this.spec.cgHeight / Math.max(0.5, n.y) + 0.02, z);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.omega = 0; w.comp = w.compPrev = this.staticComp[i]; w.ext = this.spec.susp.travel - this.staticComp[i];
      w.tireLoad = w.load = this.staticComp[i] * (w.front ? this.spec.susp.springF : this.spec.susp.springR);
    }
    this.gear = 1; this.pendingGear = 1; this.shiftTimer = 0; this.rpm = this.spec.engine.idleRpm; this.boost = 0; this.spoolState = 0;
    this.controls.reset();
    this.airTime = 0; this.tcMul = 1; this.yawRate = 0; this.pushMul = 1; this.axF = 0; this.prevFwd = 0; this.hbMul = 1; this.driftT = 9;
  }

  /** world-space inverse-inertia multiply: out = I⁻¹ v */
  private invInertia(v: V3, out: V3) {
    this.quat.unrotate(v, out);
    out.x *= this.invI.x; out.y *= this.invI.y; out.z *= this.invI.z;
    return this.quat.rotate(out, out);
  }

  /** inverse effective mass at offset r (from CG) along unit dir n */
  private invMassAt(r: V3, n: V3) {
    const rn = this.t3.crossOf(r, n);
    const iv = this.invInertia(rn, this.t4);
    return 1 / this.spec.mass + this.t4.crossOf(iv, r).dot(n);
  }

  private applyImpulse(r: V3, j: V3) {
    this.vel.addScaled(j, 1 / this.spec.mass);
    const tq = this.t3.crossOf(r, j);
    this.angVel.add(this.invInertia(tq, this.t4));
  }

  /** world point → velocity of the body at that point */
  private pointVel(r: V3, out: V3) { return out.crossOf(this.angVel, r).add(this.vel); }

  private torqueCurve(rpm: number) {
    const tc = this.spec.engine.torque;
    if (rpm <= tc[0][0]) return tc[0][1];
    for (let i = 1; i < tc.length; i++) {
      if (rpm <= tc[i][0]) {
        const [r0, t0] = tc[i - 1], [r1, t1] = tc[i];
        return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
      }
    }
    return tc[tc.length - 1][1];
  }

  gearRatio(g = this.gear) {
    const gb = this.spec.gearbox;
    if (g > 0) return gb.ratios[g - 1] * gb.final;
    if (g < 0) return -gb.reverse * gb.final;
    return 0;
  }

  private drivenOmega() {
    const w = this.wheels, d = this.spec.drive;
    if (d === 'fwd') return (w[0].omega + w[1].omega) / 2;
    if (d === 'rwd') return (w[2].omega + w[3].omega) / 2;
    return (w[0].omega + w[1].omega + w[2].omega + w[3].omega) / 4;
  }

  step(inp: DriverInput, ground: Ground, dt = DT) {
    const spec = this.spec, m = spec.mass, S = spec.susp;
    const q = this.quat;
    q.rotate(this.t1.set(1, 0, 0), this.right);
    q.rotate(this.t1.set(0, 1, 0), this.up);
    q.rotate(this.t1.set(0, 0, -1), this.fwd);
    const right = this.right, up = this.up, fwd = this.fwd;
    this.events.obstacleHit = 0; this.events.bodyHit = 0; this.events.landed = 0; this.events.bottomOut = 0; this.events.shift = 0; this.events.splash = 0;

    this.fwdSpeed = this.vel.dot(fwd);
    this.speed = this.vel.len();
    const lat = this.vel.dot(right);
    this.slideAngle = this.speed > 2 && this.fwdSpeed > 0.5 ? Math.atan2(lat, this.fwdSpeed) : 0;

    // ---- controls & gearbox ----
    this.yawRate = -this.angVel.dot(up);
    const tune = ASSIST_TUNING[this.assists.level];
    // longitudinal acceleration (push-wide protection reads it)
    this.axF += ((this.fwdSpeed - this.prevFwd) / dt - this.axF) * Math.min(1, dt / 0.12);
    this.prevFwd = this.fwdSpeed;
    const steerAngle = this.controls.update(inp, {
      speed: this.fwdSpeed, vTotal: Math.hypot(this.fwdSpeed, lat), latSpeed: lat, slideAngle: this.slideAngle, yawRate: this.yawRate,
      frontArm: spec.wheelbase * (1 - spec.frontWeight), alphaPeak: Math.atan(this.frontTanPeak), mu: this.frontMu * spec.tire.muScale * this.tune.grip,
      rearSat: spec.drive === 'rwd' ? 0 : (this.wheels[2].combSlip + this.wheels[3].combSlip) / 2,
      geom: { lockDeg: spec.steer.lockDeg, highSpeedDeg: spec.steer.highSpeedDeg, wheelbase: spec.wheelbase }, assists: this.assists, csMul: spec.assist?.csMul, hbSlip: this.hbSlip,
      slipCap: this.tune.slipCap, steerRate: this.tune.steerRate,
      dt,
    });
    let throttle = this.controls.throttle, brake = this.controls.brake;
    this.holdDrift = this.controls.drifting > 0 && this.controls.steer * this.slideAngle < 0;
    // traction control: hold the driven wheels' slip ratio near the tyre peak (held throttle = the most drive the
    // surface gives). On loose ground the target is higher and rises with the wheel's side slip: in a slide spinning
    // wheels still push (superellipse tyre limit), which is what pulls the car straight
    if (tune.tcFloor < 1) {
      let ex = 0;
      const ca = spec.assist, sm = ca?.tcSlipMul ?? 1;
      const holdDrift = this.holdDrift;
      for (const w of this.wheels) {
        if (!w.grounded || w.driveTorque <= 0 || w.slipVel < 1.0) continue;
        // (a drift being held is judged on the rear wheels: the centre sends most of the drive there)
        if (holdDrift && w.front && spec.drive === 'awd') continue;
        const c = tireCurve(w.surface);
        const sy = Math.min(3, Math.abs(Math.tan(w.slipAngle)) / c.tanPeak);
        // a drift being held (key into the slide): the rear may spin up harder — that is what keeps the tail out
        // (and the steered front wheels spin less, so they keep the side force that holds the angle)
        const tgt = (holdDrift && w.front ? tune.tcBase : tune.tcBase + c.ell * (tune.tcLoose + tune.tcSlide * sy + (holdDrift ? DRIFT_SPIN : 0))) * sm;
        // (slip measured against at least 4 m/s of road speed: pulling away, a little wheelspin is how it goes)
        const e = (w.slipVel / Math.max(6, this.speed) / c.kappaPeak - tgt) / tgt;
        if (e > ex) ex = e;
      }
      // spin guard (cars that rotate on the throttle): the body slip is past the guard angle and still growing
      if (ca?.spinGuard && this.speed > 4) {
        const b = this.slideAngle, over = Math.abs(b) - ca.spinGuard * (this.assists.level === 'novice' ? 0.7 : 1);
        if (over > 0 && this.yawRate * b < 0) ex = Math.max(ex, over * 4);
      }
      // a handbrake turn needs the front to pull: no cut while (or just after) the handbrake is used (four-wheel drive
      // sends everything forward then; rear drive needs the rear to keep spinning). A front-drive car keeps its TC:
      // spinning the steered wheels would only push it wide.
      this.hbTimer = this.controls.handbrake > 0.1 ? 1.2 : Math.max(0, this.hbTimer - dt);
      if (this.hbTimer > 0 && spec.drive !== 'fwd') ex = 0;
      // (pulling away the floor is higher: a turbo needs revs to make boost, and a car stalled on a slope by its own
      // traction control is worse than a little wheelspin)
      // (the floor is tuned on gravel: on ice the same throttle in 1st still spins the wheels, so it scales with grip)
      let muD = 0, nD = 0;
      for (const w of this.wheels) if (w.driveTorque > 0 && w.grounded) { muD += tireCurve(w.surface).p.mu; nD++; }
      const muRel = nD ? Math.min(1, muD / nD / SURFACES[Surface.Gravel].mu) : 1;
      const floor = Math.max(tune.tcFloor * this.tcFloorScale * muRel * muRel, 0.6 * muRel * (1 - smooth01((this.speed - 2) / 4)));
      const want = ex > 0 ? Math.max(floor, 1 - ex * 2.5) : 1;
      this.tcMul = want < this.tcMul ? moveTowards(this.tcMul, want, 10 * dt) : moveTowards(this.tcMul, want, 2.5 * dt);
      throttle *= this.tcMul;
    } else this.tcMul = 1;
    // push-wide protection (ESC-like, looks only at the tyres): key held into the corner, front tyres saturated, not
    // drifting, and the car still gaining speed → trim the torque so the speed stops rising and the car keeps to the
    // smallest radius it can make, instead of running wider and wider
    {
      this.driftT = Math.abs(this.slideAngle) > 0.35 ? 0 : this.driftT + dt;
      // (the deceleration it settles for fades out below ~60 km/h: a slow corner is held at its speed, not crawled)
      const ax = (tune.pushAx + (this.tune.push - 1) * -0.8) * smooth01((this.fwdSpeed - 12) / 16);
      const W0 = this.wheels[0], W1 = this.wheels[1];
      const muG = this.frontMu * spec.tire.muScale * this.tune.grip * G;
      const fsat = W0.grounded && W1.grounded ? (W0.combSlip + W1.combSlip) / 2 : 0;
      const rsat = this.wheels[2].grounded && this.wheels[3].grounded ? (this.wheels[2].combSlip + this.wheels[3].combSlip) / 2 : 0;
      const on = !Number.isNaN(tune.pushAx) && this.tune.push > 0 && this.controls.throttle > 0.3 && Math.abs(this.controls.steer) > 0.35 &&
        this.fwdSpeed > 15 && (fsat > 0.8 || (spec.drive === 'rwd' && rsat > 1.0) || Math.abs(this.yawRate) * this.speed > 0.75 * muG) &&
        Math.abs(this.slideAngle) < 0.3 && this.driftT > 1 && this.controls.hbHold === 0;
      if (on) this.pushMul = clamp(this.pushMul - (this.axF - ax) * 0.8 * this.tune.push * dt, 0.12, 1);
      else this.pushMul = moveTowards(this.pushMul, 1, 1.5 * dt);
      throttle *= this.pushMul;
    }
    // handbrake assist: let the rear brake go as the turn target is reached (holding the key never spins the car);
    // it comes back once the handbrake is released
    {
      const hbT = tune.hbTurn * Math.PI / 180;
      if (hbT > 0 && this.controls.handbrake > 0.1) {
        const turned = Math.abs(this.controls.hbTurn) + Math.abs(this.yawRate) * 0.3;
        const slip = Math.abs(this.slideAngle + clamp(this.controls.slideRate, -3, 3) * 0.25);
        // the system "pumps" the handbrake: full below the slip limit, off above it, off for good past the turn target
        this.hbMul = moveTowards(this.hbMul, turned > hbT ? 0 : clamp((hbSlipAt(this.hbSlip, this.controls.hbV0) - slip) / (8 * Math.PI / 180), 0, 1), 8 * dt);
      } else this.hbMul = 1;
    }
    const handbrake = this.controls.handbrake * this.hbMul;
    // engine-drag control (novice/standard, with TC): off the throttle, if engine braking locks the driven wheels up
    // well past the tyre peak (ice, snow), crack the throttle so the engine stops dragging them — keeps a lift on ice
    // from spinning a rear-drive car; on gravel the threshold is rarely reached, so lift-off rotation stays
    if (tune.tcFloor < 1 && throttle < 0.05 && brake < 0.05 && handbrake < 0.1 && this.gear > 0) {
      for (const w of this.wheels) {
        if (!w.grounded || w.driveTorque >= 0 || w.slipRatio > -2 * tireCurve(w.surface).kappaPeak) continue;
        throttle = 0.06;
        break;
      }
    }
    this.updateGearbox(inp, dt);
    if (this.gear < 0) { const t = throttle; throttle = brake; brake = t; }
    // hold brake at standstill when no pedal is pressed (prevents creeping on slopes)
    const holding = throttle < 0.05 && this.speed < 1.2 && this.groundedCount >= 3;
    this.throttleOut = throttle; this.brakeOut = brake;

    // ---- forces: gravity, aero ----
    const F = this.F.set(0, -G * m, 0), T = this.T.set(0, 0, 0);
    const v2 = this.speed;
    F.addScaled(this.vel, -0.5 * RHO * spec.aero.cdA * v2);
    F.addScaled(up, -0.5 * RHO * spec.aero.clA * this.fwdSpeed * this.fwdSpeed);

    // ---- suspension raycasts ----
    const travel = S.travel, rad = spec.wheel.radius;
    let grounded = 0;
    const comp = [0, 0, 0, 0];
    for (const w of this.wheels) {
      const mw = q.rotate(w.mount, this.t1).add(this.pos);
      // solve ground along -up from hardpoint: mw.y - up.y*t = h(mw.xz - up.xz*t)
      const maxT = travel + rad;
      let t = maxT;
      const uy = Math.max(0.2, up.y);
      let tt = (mw.y - ground.height(mw.x, mw.z)) / uy;
      for (let it = 0; it < 2; it++) {
        const px = mw.x - up.x * tt, pz = mw.z - up.z * tt;
        tt = (mw.y - ground.height(px, pz)) / uy;
      }
      t = tt;
      if (t < maxT) {
        w.grounded = true; grounded++;
        w.comp = travel - (t - rad);
        w.ext = Math.max(0, t - rad);
        w.contact.set(mw.x - up.x * t, mw.y - up.y * t, mw.z - up.z * t);
        ground.normal(w.contact.x, w.contact.z, w.normal);
        w.surface = ground.surface(w.contact.x, w.contact.z);
        const wet = w.surface === Surface.Water;
        if (wet && !w.inWater && this.speed > this.events.splash) this.events.splash = this.speed;
        w.inWater = wet;
      } else {
        w.inWater = false;
        w.grounded = false;
        w.comp = 0;
        w.ext = travel;
        w.contact.set(mw.x - up.x * maxT, mw.y - up.y * maxT, mw.z - up.z * maxT);
      }
      comp[w.index] = w.comp;
    }
    const wasAir = this.groundedCount === 0;
    if (wasAir && grounded > 0 && this.airTime > 0.25) this.events.landed = Math.max(0, -this.vel.y);
    this.groundedCount = grounded;
    this.airTime = grounded === 0 ? this.airTime + dt : 0;

    for (const w of this.wheels) {
      const front = w.front;
      const k = front ? S.springF : S.springR;
      let f = 0;
      if (w.grounded) {
        const c = w.comp;
        const cv = (c - w.compPrev) / dt;
        f = k * c + (cv > 0 ? (front ? S.bumpF : S.bumpR) : (front ? S.reboundF : S.reboundR)) * cv;
        // high-speed bump: extra damping above the knee (landings, big hits) without making small bumps harsh
        if (cv > S.hsKnee) f += S.hsBump * (cv - S.hsKnee);
        // bump stop over the last 4 cm, progressive and damped
        const bs = c - (travel - S.bumpStop);
        if (bs > 0) {
          f += k * 5 * bs + k * 60 * bs * bs + (cv > 0 ? S.bumpStopDamp * cv : 0);
          if (cv > this.events.bottomOut) this.events.bottomOut = cv;
        }
        // anti-roll bar
        const other = comp[w.index ^ 1];
        f += (front ? S.arbF : S.arbR) * (c - other);
        // past full travel the tyre itself compresses (stiff, damped) instead of the body stopping dead
        const over = c - travel;
        if (over > 0) f += 240000 * over + (cv > 0 ? 6000 * cv : 0);
        // yielding ground (deep snow): the wheel ploughs into it instead of being thrown up a bank
        const sink = SURFACES[w.surface]?.sink ?? 0;
        f = clamp(f, 0, (22 - 18 * sink) * this.spec.mass * G / 4);
      }
      w.load = f;
      w.tireLoad = w.grounded ? w.tireLoad + (f - w.tireLoad) * 0.45 : 0;
      w.compPrev = w.comp;
      if (f > 0) {
        // force along body up through the hardpoint/contact line
        const r = this.t2.subOf(w.contact, this.pos);
        const fv = this.t1.copy(up).scale(f);
        F.add(fv);
        T.add(this.t3.crossOf(r, fv));
      }
    }

    // ---- body vs ground penalty contacts ----
    for (let si = 0; si < this.spheres.length; si++) {
      const s = this.spheres[si];
      const c = q.rotate(s.p, this.t1).add(this.pos);
      const h = ground.height(c.x, c.z);
      if (c.y - s.r > h + 0.5) continue;
      const n = ground.normal(c.x, c.z, this.t2);
      const depth = s.r - (c.y - h) * n.y;
      if (depth <= 0) continue;
      // soft ground (snow banks): less spring, more damping and friction — the car ploughs in and stops; the bank
      // gives way around the body, so it trips the car over far less than a hard earth bank (shorter lever arm)
      const soft = SURFACES[ground.surface(c.x, c.z)]?.soft ?? 0;
      const r = c.sub(this.pos); // reuse t1 as offset
      const pv = this.pointVel(r, this.t3);
      const vn = pv.dot(n);
      let fn = 160000 * (1 - 0.75 * soft) * depth + 60000 * (1 - 0.75 * soft) * depth * depth * 10 - 9000 * (1 + 0.3 * soft) * Math.min(0, vn) - 2000 * (1 - 0.8 * soft) * Math.max(0, vn);
      fn = Math.max(0, fn);
      if (-vn > this.events.bodyHit) this.events.bodyHit = -vn;
      // friction
      pv.addScaled(n, -vn);
      const vt = pv.len();
      const fv = this.t4.copy(n).scale(fn);
      if (vt > 1e-4) {
        const ft = Math.min((0.55 + 0.45 * soft) * fn, (vt * m * 0.25) / dt);
        fv.addScaled(pv, -ft / vt);
      }
      F.add(fv);
      T.add(this.t3.crossOf(r, fv).scale(1 - 0.7 * soft));
    }

    // ---- air attitude: mild pitch self-levelling toward the flight path, a little throttle/brake authority ----
    // (the main throttle-lifts / brake-drops effect is the wheels' spin reaction, applied in the tyre loop)
    if (grounded === 0) {
      T.addScaled(right, (throttle - brake) * spec.air.pedalPitch);
      if (this.speed > 5) {
        const vdir = this.t1.copy(this.vel).scale(1 / this.speed);
        const pitchErr = vdir.y - fwd.y; // + → velocity points higher than the nose
        T.addScaled(right, pitchErr * spec.air.levelPitch);
      }
      // aerodynamic angular damping
      T.addScaled(this.angVel, -spec.air.damping);
    }

    // ---- stability assist (novice): yaw torque against a growing spin, like brake-based ESC ----
    if (tune.escSlip > 0 && grounded >= 3 && this.speed > 6 && this.controls.hbHold === 0) {
      const b = this.slideAngle, over = Math.abs(b) - tune.escSlip;
      // yawing further into the slide? (slide<0 means rear out to the left in a right turn → yaw right is "into")
      if (over > 0 && this.yawRate * b < 0) T.addScaled(up, this.yawRate * Math.min(1, over * 4) * 3200);
    }

    // ---- integrate external forces into velocities ----
    this.vel.addScaled(F, dt / m);
    this.angVel.add(this.invInertia(T.scale(dt), this.t1));

    // ---- drivetrain torque ----
    this.updateEngine(throttle, dt);
    const tw = this.engineTorque * this.gearRatio() * spec.gearbox.efficiency;
    let tf = 0, tr = 0;
    if (spec.drive === 'fwd') tf = tw;
    else if (spec.drive === 'rwd') tr = tw;
    else if (this.controls.handbrake > 0.3) tf = tw; // four-wheel drive: the handbrake opens the centre diff
    else {
      // drift assist (four-wheel drive): while a drift is held, the centre sends more to the rear
      const split = this.holdDrift && ASSIST_TUNING[this.assists.level].slipCap > 0 ? Math.min(spec.diff.centerSplit, 0.3) : spec.diff.centerSplit;
      tf = tw * split; tr = tw - tf;
    }
    this.wheels[0].driveTorque = this.wheels[1].driveTorque = tf / 2;
    this.wheels[2].driveTorque = this.wheels[3].driveTorque = tr / 2;

    // ---- tires: sequential velocity-capped impulses ----
    const I = spec.wheel.inertia;
    const absOn = tune.absSlip > 0;
    let brakeStab = 1;
    if (absOn && brake > 0.1 && this.speed > 5) {
      const grow = this.slideAngle * this.controls.slideRate > 0 ? 1 : 0.4;
      brakeStab = 1 - smooth01((Math.abs(this.slideAngle) - 0.15) / 0.15) * grow;
    }
    const absThresh = -tune.absSlip;
    let muF = 0, tpF = 0, nF = 0, absNow = false;
    for (const w of this.wheels) {
      w.steer = w.front ? steerAngle : 0;
      const gripK = spec.tire.muScale * this.tune.grip;
      let tb = brake * spec.brakes.maxTorque * (w.front ? spec.brakes.frontBias : 1 - spec.brakes.frontBias) * 2;
      // brake stability (novice / standard): a held brake pedal lets the tail come round a little (trail braking),
      // but once the slide passes ~12° and is still growing the rear brakes let go, so it does not become a spin
      if (!w.front && brakeStab < 1) tb *= brakeStab;
      if (!w.front) tb += handbrake * spec.brakes.handbrake;
      if (holding) tb = Math.max(tb, 1500);
      // ABS (+ EBD: the rears release earlier so they never lock before the fronts — keeps 0/1 key braking straight)
      const wc = tireCurve(w.surface), pk = wc.kappaPeak / GRAVEL_PEAK;
      const absTrip = w.slipRatio < (w.front ? absThresh : absThresh * 0.6) * pk || (w.slipRatio < -0.03 && w.combSlip > tune.absComb * (w.front ? 1 : 0.85));
      // release: drop the pressure below what the tyre can react (so the wheel spins back up), cycling like real ABS
      // (a fixed fraction of a strong brake would still hold the wheel locked)
      if (absOn && w.grounded && brake > 0.1 && absTrip && !(handbrake > 0.1 && !w.front)) {
        tb = Math.min(tb * 0.35, 0.3 * wc.p.mu * gripK * w.tireLoad * spec.wheel.radius);
        absNow = true;
      }
      const omega0 = w.omega + (w.driveTorque * dt) / I;
      const brakeDw = ((tb + 4) * dt) / I; // max |Δω| the brake can apply this tick
      if (!w.grounded) {
        const prevOmega = w.omega;
        w.omega = moveTowards(omega0, 0, brakeDw); w.slipRatio = 0; w.slipAngle = 0; w.slideSpeed = 0; w.slipVel = 0; w.combSlip = 0;
        // spin reaction on the body when airborne: spinning the wheels up lifts the nose, braking them drops it
        if (grounded === 0) this.angVel.add(this.invInertia(this.t3.copy(right).scale(I * (w.omega - prevOmega)), this.t4));
        w.spin += w.omega * dt;
        continue;
      }
      const n = w.normal;
      // wheel heading: body forward yawed by steer around up, projected on contact plane
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const fw = this.t1.set(fwd.x * cs + right.x * sn, fwd.y * cs + right.y * sn, fwd.z * cs + right.z * sn);
      fw.addScaled(n, -fw.dot(n)).normalize();
      const rw = this.t2.crossOf(fw, n);
      const fwc = fw.clone(), rwc = rw.clone();
      const r = new V3().subOf(w.contact, this.pos).addScaled(up, spec.susp.rollCenter);
      const pv = this.pointVel(r, new V3());
      const vl = pv.dot(fwc), vt = pv.dot(rwc);
      const tanA = vt / Math.max(Math.abs(vl), 1.5);
      const curve = tireCurve(w.surface);
      if (w.front) { muF += curve.p.mu; tpF += curve.tanPeak; nF++; }
      // rear lateral balance (rally set-up, < 1 = livelier tail) acts on loose surfaces; on sealed ones it fades out
      const latScale = spec.tire.lateralScale * (w.front ? 1 : 1 - (1 - spec.tire.rearLat) * Math.min(1, curve.p.loose));
      const invML = this.invMassAt(r, fwc);
      // static-friction floor at walking speed: slip-based tire models creep otherwise
      const statF = clamp(1 - Math.hypot(vl, vt) / 2.5, 0, 1) * curve.p.mu * gripK * w.tireLoad;
      const capTo = (f: number, lock: number) => {
        const lim = Math.max(Math.abs(f), statF);
        return Math.abs(lock) < lim ? lock : Math.sign(lock) * lim;
      };
      // longitudinal: first try the wheel brake-locked (ω = 0); if the brake cannot hold it, let it turn
      let omega = 0, fx = 0, fy = 0, kappa = 0, locked = false;
      if (Math.abs(omega0) <= brakeDw) {
        const vslip = -vl;
        kappa = vslip / Math.max(Math.abs(vl), 1.0);
        tireForces(curve, w.tireLoad, gripK, spec.tire.loadSens, kappa, tanA, latScale, this.tire);
        fx = this.tire.fx; fy = this.tire.fy;
        fx = capTo(fx, vslip / (dt * invML));
        // brake must absorb drive + tire reaction torque to keep ω at 0
        if (Math.abs(omega0 - (fx * rad * dt) / I) <= brakeDw) { locked = true; omega = 0; }
      }
      if (!locked) {
        omega = moveTowards(omega0, 0, brakeDw);
        const vslip = omega * rad - vl;
        kappa = vslip / Math.max(Math.abs(vl), Math.abs(omega * rad), 1.0);
        tireForces(curve, w.tireLoad, gripK, spec.tire.loadSens, kappa, tanA, latScale, this.tire);
        fx = this.tire.fx; fy = this.tire.fy;
        fx = capTo(fx, vslip / (dt * ((rad * rad) / I + invML)));
        omega -= (fx * rad * dt) / I;
      }
      const kLat = this.invMassAt(r, rwc);
      fy = capTo(fy, -vt / (dt * kLat));
      // rolling resistance + loose-surface drag, never reversing the wheel's motion
      const sp = curve.p;
      let frr = -(sp.rollRes * w.tireLoad * clamp(vl / 0.5, -1, 1)) - sp.drag * (w.tireLoad / 1000) * vl - (sp.wade ?? 0) * vl * Math.abs(vl);
      const frrLock = Math.abs(vl) / (dt * invML);
      if (Math.abs(frr) > frrLock) frr = Math.sign(frr) * frrLock;
      const j = new V3().addScaled(fwc, (fx + frr) * dt).addScaled(rwc, fy * dt);
      this.applyImpulse(r, j);
      w.omega = omega;
      w.spin += w.omega * dt;
      const vslip = omega * rad - vl;
      w.slipRatio = kappa;
      w.slipAngle = Math.atan(tanA);
      w.slideSpeed = Math.hypot(vslip, vt);
      w.slipVel = vslip;
      w.combSlip = Math.hypot(this.tire.sx, this.tire.sy);
    }

    if (nF > 0) { this.frontMu = muF / nF; this.frontTanPeak = tpF / nF; }
    this.absTime = absNow ? this.absTime + dt : 0;

    // ---- differentials (implicit locking) ----
    const lockPair = (a: Wheel, b: Wheel, f: number) => {
      const mean = (a.omega + b.omega) / 2, d = (a.omega - b.omega) * (1 - f) / 2;
      a.omega = mean + d; b.omega = mean - d;
    };
    const W = this.wheels;
    if (spec.drive !== 'rwd') lockPair(W[0], W[1], spec.diff.frontLock);
    const hbKey = this.controls.handbrake > 0.3;
    if (spec.drive !== 'fwd' && !hbKey) lockPair(W[2], W[3], spec.diff.rearLock);
    if (spec.drive === 'awd' && !hbKey) {
      const f = (W[0].omega + W[1].omega) / 2, r = (W[2].omega + W[3].omega) / 2;
      const d = (f - r) * spec.diff.centerLock / 2;
      W[0].omega -= d; W[1].omega -= d; W[2].omega += d; W[3].omega += d;
    }

    // ---- integrate pose ----
    this.pos.addScaled(this.vel, dt);
    q.integrate(this.angVel, dt);

    // ---- obstacles (impulse + positional correction) ----
    this.collideObstacles(ground, up);
  }

  private collideObstacles(ground: Ground, up: V3) {
    const q = this.quat;
    const tryHit = (c: V3, rad: number) => {
      ground.obstaclesNear(c.x, c.z, rad + 1.5, (o: Obstacle) => {
        let nx: number, ny: number, nz: number, depth: number;
        if (o.kind === 'cyl') {
          if (c.y + rad < o.y || c.y - rad > o.y + o.h) return;
          const dx = c.x - o.x, dz = c.z - o.z;
          const d = Math.hypot(dx, dz);
          depth = rad + o.r - d;
          if (depth <= 0 || d < 1e-6) return;
          nx = dx / d; ny = 0; nz = dz / d;
        } else {
          const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z;
          const d = Math.hypot(dx, dy, dz);
          depth = rad + o.r - d;
          if (depth <= 0 || d < 1e-6) return;
          nx = dx / d; ny = dy / d; nz = dz / d;
        }
        const n = new V3(nx, ny, nz);
        const r = new V3().subOf(c, this.pos).addScaled(n, -rad);
        const pv = this.pointVel(r, new V3());
        const vn = pv.dot(n);
        if (vn < 0) {
          const k = this.invMassAt(r, n);
          const jn = (-(1 + 0.15) * vn) / k;
          const j = n.clone().scale(jn);
          // friction
          const vtv = pv.clone().addScaled(n, -vn);
          const vt = vtv.len();
          if (vt > 1e-3) {
            const tdir = vtv.scale(1 / vt);
            const kt = this.invMassAt(r, tdir);
            const jt = Math.min(0.35 * jn, vt / kt);
            j.addScaled(tdir, -jt);
          }
          this.applyImpulse(r, j);
          if (-vn > this.events.obstacleHit) this.events.obstacleHit = -vn;
        }
        // push out
        this.pos.addScaled(n, depth * 0.8);
        c.addScaled(n, depth * 0.8);
      });
    };
    const c = new V3();
    for (let i = 0; i < this.spheres.length; i++) { const s = this.spheres[i]; q.rotate(s.p, c).add(this.pos); tryHit(c, s.r); }
    for (const w of this.wheels) {
      q.rotate(w.mount, c).add(this.pos).addScaled(up, -w.ext);
      tryHit(c, this.spec.wheel.radius * 0.9);
    }
  }

  private updateGearbox(inp: DriverInput, dt: number) {
    const gb = this.spec.gearbox, n = gb.ratios.length;
    const upEdge = inp.shiftUp && !this.prevUp, downEdge = inp.shiftDown && !this.prevDown;
    this.prevUp = inp.shiftUp; this.prevDown = inp.shiftDown;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) { this.shiftTimer = 0; this.gear = this.pendingGear; }
      return;
    }
    this.sinceUp += dt;
    const shift = (g: number) => { if (g === this.gear) return; this.events.shift = g > this.gear ? 1 : -1; if (g > this.gear) this.sinceUp = 0; this.pendingGear = g; this.shiftTimer = this.spec.gearbox.shiftTime; };
    const fs = this.fwdSpeed;
    if (this.transmission === 'manual') {
      if (upEdge && this.gear < n) shift(this.gear === -1 ? 0 : this.gear + 1);
      if (downEdge && this.gear > -1) shift(this.gear - 1);
      return;
    }
    // automatic
    if (this.gear >= 1) {
      // reverse: stopped + holding brake
      if (fs < 0.6 && inp.brake > 0.5 && inp.throttle < 0.1) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.35) { this.reverseHold = 0; this.gear = -1; this.pendingGear = -1; return; }
      } else this.reverseHold = 0;
      if (this.groundedCount < 2) return;
      const drivenRpm = Math.abs(this.drivenOmega() * this.gearRatio()) * RPM;
      const wheelRpm = Math.abs(fs / this.spec.wheel.radius * this.gearRatio()) * RPM;
      // upshift on engine rpm, but not while just spinning the wheels at very low road speed — unless the engine is
      // on the limiter and the car is rolling (a hairpin exit in 1st with the wheels spinning: take 2nd, don't bounce)
      if (this.gear < n && drivenRpm > gb.upRpm && (wheelRpm > gb.upRpm * 0.82 || (this.limiterCut && fs > 6))) shift(this.gear + 1);
      else if (this.gear > 1) {
        const lower = Math.abs(fs / this.spec.wheel.radius * this.gearRatio(this.gear - 1)) * RPM;
        // into 1st only with plenty of rev room left (1st is for hairpins and pulling away, not for 50 km/h)
        const room = this.gear === 2 ? 1900 : 0;
        if (drivenRpm < gb.downRpm && lower < gb.upRpm - 700 - room && wheelRpm < gb.downRpm && this.sinceUp > 1.0) shift(this.gear - 1);
        else if (inp.brake > 0.3 && lower < gb.upRpm - 1200 - room && drivenRpm < gb.downRpm + 1200) shift(this.gear - 1);
      }
    } else if (this.gear === -1) {
      if (inp.throttle > 0.3 && fs > -0.8) { this.gear = 1; this.pendingGear = 1; }
    } else if (this.gear === 0) {
      if (inp.throttle > 0.3) this.gear = 1;
    }
  }

  private updateEngine(throttle: number, dt: number) {
    const e = this.spec.engine;
    const ratio = this.gearRatio();
    const engaged = this.gear !== 0 && this.shiftTimer <= 0;
    const lag = e.turboLag;
    if (e.spool) {
      // big turbo: needs exhaust flow (rpm) and builds through two lags in series → nothing, nothing, then a shove
      const [lo, hi] = e.spool.rpm;
      const u = clamp((this.rpm - lo) / (hi - lo), 0, 1);
      const tgt = throttle * (0.15 + 0.85 * u * u * (3 - 2 * u));
      const k = 1 - Math.exp(-dt / (lag * 0.5));
      this.spoolState += (tgt - this.spoolState) * k;
      this.boost += (this.spoolState - this.boost) * k;
    } else this.boost += lag > 0 ? (throttle - this.boost) * (1 - Math.exp(-dt / lag)) : throttle - this.boost;
    let rpm: number;
    if (!engaged) {
      const target = e.idleRpm + throttle * (e.limiter - e.idleRpm);
      rpm = moveTowards(this.rpm, target, (throttle > 0.1 ? 9000 : 5000) * dt);
      this.rpm = rpm;
      this.engineTorque = 0;
      return;
    }
    const wheelRpm = Math.abs(this.drivenOmega() * ratio) * RPM;
    const slipRpm = e.idleRpm + throttle * 2600; // clutch slips below this (launch)
    rpm = wheelRpm < slipRpm ? moveTowards(this.rpm, slipRpm, 12000 * dt) : wheelRpm;
    if (wheelRpm >= slipRpm) rpm = wheelRpm;
    this.rpm = Math.min(rpm, e.limiter + 150);
    if (this.rpm >= e.limiter) this.limiterCut = true;
    else if (this.rpm < e.limiter - 250) this.limiterCut = false;
    const boost = lag > 0 ? e.offBoost + (1 - e.offBoost) * (e.spool ? Math.pow(this.boost, e.spool.exp) : this.boost) : 1;
    let tq = throttle * this.torqueCurve(this.rpm) * boost;
    if (this.limiterCut) tq = 0;
    // engine braking — except during sustained ABS braking (the assist declutches so the engine can't lock the
    // driven wheels behind the ABS's back; a short brake tap to provoke rotation is left alone)
    if (throttle < 0.05 && wheelRpm > e.idleRpm * 1.2) tq = this.absTime > 0.2 ? 0 : -e.braking * (this.rpm / e.redline);
    // drive torque sign follows wheel direction convention (forward = +omega)
    this.engineTorque = tq;
  }

  /** compact numeric state for hashing */
  stateNumbers(out: number[]) {
    out.push(this.pos.x, this.pos.y, this.pos.z, this.quat.x, this.quat.y, this.quat.z, this.quat.w,
      this.vel.x, this.vel.y, this.vel.z, this.angVel.x, this.angVel.y, this.angVel.z, this.rpm, this.gear);
    for (const w of this.wheels) out.push(w.omega, w.comp);
    return out;
  }

  /** world position of wheel centre */
  wheelCenter(w: Wheel, out: V3) {
    this.quat.rotate(w.mount, out).add(this.pos);
    this.quat.rotate(this.t1.set(0, 1, 0), this.t2);
    return out.addScaled(this.t2, -w.ext);
  }
}
