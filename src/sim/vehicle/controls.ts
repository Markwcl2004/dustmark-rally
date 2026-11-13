// Driver input → processed steering/pedals. Deterministic; runs inside the sim tick so replays/ghosts match.
//
// 手感重做 (2026-11-12): every keyboard action works by HOLDING a key, not by tapping at the right rate.
//  - steering: the processed value s ∈ [-1,1] moves toward the key target at a speed-dependent rate (slow at speed so
//    a short press is a small correction, fast near standstill) and returns to centre when released.
//    With assists (novice / standard) s is a share of the FRONT GRIP, not an angle:
//        angle = rel + |s| · (full − rel)
//        full  = kin + sign(s) · α_peak      kin = direction the front axle is actually moving (body slip + yaw)
//        rel   = kin · cs(β)                 released key: front wheels follow the direction of travel once sliding
//    so a held key always works the front tyres at their peak slip angle (= the most cornering force there is, at any
//    speed, on any surface — never past it to plough on), and a released key counter-steers by itself.
//  - drift assist: the front grip a held key asks for tapers and reverses as the body slip angle (predicted 0.25 s
//    ahead) approaches the level's cap (standard 35°, novice 20°): a held key keeps a slide, it does not spin it.
//  - handbrake assist: while the handbrake is held, the heading change since the pull is integrated; the rear brake is
//    released (car.ts) and the front stops pulling as it reaches the target turn (≈ 80°), so holding it never spins.
//  - hardcore: only the input ramps; s maps linearly onto the speed-scaled lock (keys and pads alike).
//  - analog (pad / phone) with assists: linear angle, clamped to the same grip window, plus the counter-steer help.
//  - pedals: keyboard throttle/brake are ramped. Traction control / push-wide protection / ABS live in car.ts.
import { clamp, moveTowards } from '../math/vec';

export interface DriverInput {
  /** -1 (left) .. +1 (right) */
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
  shiftUp: boolean;
  shiftDown: boolean;
  /** steer came from digital keys → apply rate limiting + self-centering */
  digital: boolean;
}

export const emptyInput = (): DriverInput => ({ steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, digital: false });

export type AssistLevel = 'novice' | 'standard' | 'hardcore';

export interface Assists {
  level: AssistLevel;
  /** counter-steer assist on/off (settings; hardcore forces it off) */
  counterSteer: boolean;
}

export const DEFAULT_ASSISTS: Assists = { level: 'standard', counterSteer: true };

export function assistsFor(level: AssistLevel): Assists {
  return { level, counterSteer: level !== 'hardcore' };
}

export interface AssistTune {
  /** keys steer by grip share (held key = front tyres at their peak) instead of by angle */
  hold: boolean;
  /** share of the front-axle travel direction a released key steers toward once the car slides (0 = off) */
  csGain: number;
  /** drift assist: body slip-angle cap (deg, 0 = off) */
  slipCap: number;
  /** handbrake assist: heading change (deg) after which the rear brake lets go and the front stops pulling (0 = off) */
  hbTurn: number;
  /** ABS: slip ratio where brake pressure is dumped (0 = off), and the combined-slip level (1 = tyre peak) where it
   *  also releases so a sliding car stays steerable under a 0/1 brake key */
  absSlip: number; absComb: number;
  /** traction control (normalized slip, 1 = tyre peak slip ratio): target on sealed surfaces, extra on loose ones,
   *  extra per unit of lateral slip on loose ones (spin the wheels harder in a slide: they still push), and the
   *  lowest throttle it may cut to (floor 1 = off) */
  tcBase: number; tcLoose: number; tcSlide: number; tcFloor: number;
  /** push-wide protection: longitudinal acceleration (m/s²) the throttle is trimmed to while the front tyres are
   *  saturated and the key is held into the corner (NaN = off) */
  pushAx: number;
  /** stability: yaw-torque damping when the body slip angle exceeds this (rad); 0 = off */
  escSlip: number;
}

/** per-level tuning (DESIGN §4 输入与辅助; table in PROGRESS 手感重做) */
export const ASSIST_TUNING: Record<AssistLevel, AssistTune> = {
  novice: { hold: true, csGain: 1, slipCap: 20, hbTurn: 85, absSlip: 0.14, absComb: 1.2, tcBase: 1.1, tcLoose: 0.3, tcSlide: 0.5, tcFloor: 0.1, pushAx: -2.0, escSlip: 0.3 },
  standard: { hold: true, csGain: 0.9, slipCap: 35, hbTurn: 105, absSlip: 0.24, absComb: 1.25, tcBase: 1.25, tcLoose: 0.5, tcSlide: 0.8, tcFloor: 0.12, pushAx: -1.5, escSlip: 0 },
  hardcore: { hold: false, csGain: 0, slipCap: 0, hbTurn: 0, absSlip: 0, absComb: 99, tcBase: 99, tcLoose: 0, tcSlide: 0, tcFloor: 1, pushAx: NaN, escSlip: 0 },
};

export const G = 9.81;
/** yaw damper of the held-key steering frame (rad of front slip per rad/s of yaw-rate change) */
const YAW_DAMP = 0.2;
/** handbrake assist: body slip angle (rad) beyond which the rear brake lets go even before the turn target (past
 *  ≈ 45° full opposite lock can no longer catch the rotation once the key is released); per car: assist.hbSlip */
export const HB_SLIP = 42 * Math.PI / 180;
/** …which at hairpin pace (below ~50 km/h) opens up toward 90°: slow enough for the front to catch anything */
export function hbSlipAt(base: number, v: number) {
  return base + (Math.PI / 2 - base) * (1 - smooth(clamp((v - 9) / 7.5, 0, 1)));
}
const DEG = Math.PI / 180;
const smooth = (x: number) => x * x * (3 - 2 * x);

export interface SteerGeom {
  /** full lock (deg) */
  lockDeg: number;
  /** analog high-speed lock (deg) at ~145 km/h */
  highSpeedDeg: number;
  wheelbase: number;
}

/** classic speed-scaled lock (rad): full lock at walking pace, highSpeedDeg from ~145 km/h */
export function classicLock(v: number, g: SteerGeom) {
  const sf = clamp((v - 4) / 36, 0, 1);
  return (g.lockDeg + (g.highSpeedDeg - g.lockDeg) * smooth(sf)) * DEG;
}

/** keyboard steer rates (normalized s per second): building toward a key, returning to centre */
export function keySteerRates(v: number, mul = 1) {
  const k = smooth(clamp((v - 5) / 32, 0, 1)); // 18 → 133 km/h
  return { build: (4.2 - 2.6 * k) * mul, center: (6.5 - 3.3 * k) * mul };
}

/** advance processed digital steer one tick toward target (shared with the keyboard robots' internal model) */
export function stepKeySteer(s: number, target: number, v: number, dt: number, mul = 1) {
  const r = keySteerRates(v, mul);
  if (target === 0) return moveTowards(s, 0, r.center * dt);
  if (s !== 0 && Math.sign(target) !== Math.sign(s)) {
    // reversing: swing back through centre fast (centring + build rate)
    const ns = s - Math.sign(s) * (r.center + r.build) * dt;
    return Math.sign(ns) === Math.sign(s) ? ns : clamp(ns, -Math.abs(target), Math.abs(target));
  }
  return moveTowards(s, target, (Math.abs(target) < Math.abs(s) ? r.center : r.build) * dt);
}

export interface ControlCtx {
  /** forward speed (m/s) */
  speed: number;
  /** ground speed (m/s), whatever the direction */
  vTotal: number;
  /** lateral speed (m/s, + = to the right of the nose) */
  latSpeed: number;
  /** body slip angle (rad, + = velocity to the right of the nose) */
  slideAngle: number;
  /** yaw rate (rad/s, + = turning right) */
  yawRate: number;
  /** CG → front axle (m) */
  frontArm: number;
  /** peak slip angle of the tyres on the surface under the front wheels (rad) */
  alphaPeak: number;
  /** friction under the front tyres (surface × tyre × grip knob) */
  mu: number;
  /** rear tyres' combined slip (1 = at their peak), average of the grounded ones */
  rearSat: number;
  geom: SteerGeom;
  assists: Assists;
  /** drift-assist cap override (deg, NaN = level default; 0 = off) */
  slipCap: number;
  /** keyboard steering rate multiplier */
  steerRate: number;
  /** per-car counter-steer gain multiplier (default 1) */
  csMul?: number;
  /** per-car handbrake-assist slip limit (rad) */
  hbSlip?: number;
  dt: number;
}

export class Controls {
  /** processed normalized steer -1..1 (before speed scaling) */
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = 0;
  digital = false;
  /** wheel angle requested by the driver (rad), without the counter-steer / cap part */
  driverAngle = 0;
  /** angle added by the assists (rad) */
  assistAngle = 0;
  /** > 0 while (or shortly after) the handbrake is used — rotation is intended then */
  hbHold = 0;
  /** heading change since the handbrake was pulled (rad, signed, + = right) */
  hbTurn = 0;
  /** ground speed when the handbrake was pulled (m/s) */
  hbV0 = 0;
  /** 1 while a slide the driver started (lift / brake / handbrake) is being held; 0 = grip driving */
  drifting = 0;
  /** filtered rate of change of the body slip angle (rad/s) */
  slideRate = 0;
  private prevSlide = 0;
  /** yaw rate through a 0.4 s low-pass (the steering frame keeps the transient part of the yaw term: yaw damping) */
  yawF = 0;
  /** last tick's steering frame (rad): front-axle travel direction, released-key angle, held-left / held-right angle
   *  (keyboard robots invert the mapping with these) */
  kin = 0;
  rel = 0;
  fullL = 0;
  fullR = 0;
  /** exponent of the s → grip-share curve (progressive at speed: a short press is a small correction) */
  prog = 1;

  reset() {
    this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0; this.driverAngle = 0; this.assistAngle = 0; this.hbHold = 0;
    this.hbTurn = 0; this.hbV0 = 0; this.slideRate = 0; this.prevSlide = 0; this.yawF = 0; this.drifting = 0; this.kin = 0; this.rel = 0; this.fullL = 0; this.fullR = 0; this.prog = 1;
  }

  /** processed steer s that gives the front-wheel angle `angle` in the current steering frame (keyboard robots) */
  keyFor(angle: number) {
    const ip = 1 / this.prog;
    if (angle >= this.rel) return Math.pow(clamp((angle - this.rel) / Math.max(1e-4, this.fullR - this.rel), 0, 1), ip);
    return -Math.pow(clamp((this.rel - angle) / Math.max(1e-4, this.rel - this.fullL), 0, 1), ip);
  }

  /** returns steer angle (rad, + = right) for the front wheels */
  update(inp: DriverInput, c: ControlCtx) {
    const v = Math.abs(c.speed), dt = c.dt;
    const target = clamp(inp.steer, -1, 1);
    this.digital = inp.digital;
    if (inp.digital) {
      // keys are -1/0/+1; anything in between (the gentle key, scripted tests) is a partial target
      this.steer = stepKeySteer(this.steer, target, v, dt, c.steerRate);
    } else {
      this.steer = moveTowards(this.steer, target, 10 * dt);
    }
    // pedals: keys get a ramp (in 0.18 s / out 0.08 s), analog nearly direct
    const thrT = clamp(inp.throttle, 0, 1), brT = clamp(inp.brake, 0, 1);
    if (inp.digital) {
      this.throttle = moveTowards(this.throttle, thrT, (thrT > this.throttle ? 5.5 : 12) * dt);
      this.brake = moveTowards(this.brake, brT, (brT > this.brake ? 6.5 : 12) * dt);
    } else {
      this.throttle = moveTowards(this.throttle, thrT, 20 * dt);
      this.brake = moveTowards(this.brake, brT, 20 * dt);
    }
    this.handbrake = moveTowards(this.handbrake, clamp(inp.handbrake, 0, 1), 12 * dt);
    this.hbHold = this.handbrake > 0.1 ? 1.2 : Math.max(0, this.hbHold - dt);

    const tune = ASSIST_TUNING[c.assists.level];
    const lock = c.geom.lockDeg * DEG;
    const beta = c.slideAngle;
    this.slideRate += ((beta - this.prevSlide) / dt - this.slideRate) * Math.min(1, dt / 0.06);
    this.prevSlide = beta;
    // heading turned since the handbrake pull (cleared when it is let go)
    const hbOn = this.handbrake > 0.1;
    if (hbOn) { if (this.hbTurn === 0 && this.hbV0 === 0) this.hbV0 = c.vTotal; this.hbTurn += c.yawRate * dt; }
    else { this.hbTurn = 0; this.hbV0 = 0; }
    this.yawF += (c.yawRate - this.yawF) * Math.min(1, dt / 0.7);

    const classic = classicLock(v, c.geom);
    if (!tune.hold) {
      // hardcore: direct, linear, speed-scaled
      this.kin = 0; this.rel = 0; this.fullL = -classic; this.fullR = classic;
      this.driverAngle = this.steer * classic;
      this.assistAngle = 0;
      return clamp(this.driverAngle, -lock, lock);
    }

    // direction the front axle is moving relative to the nose (= wheel angle with zero front slip)
    const vt = c.vTotal;
    const wv = smooth(clamp((vt - 3) / 6, 0, 1)); // the frame is meaningless at walking pace: plain lock there
    // the yaw term uses the low-passed yaw rate: in a transient the front tyres still see the yaw change (that is
    // what damps a car's yaw), in a steady corner the front works at exactly the slip asked for
    // plus a yaw damper on the throttle: rotating faster than a moment ago → the held key asks the front for a little
    // less (off the throttle it stays out of the way: lifting or braking into a corner is how a slide is started)
    const kin = clamp(Math.atan2(c.latSpeed + c.frontArm * this.yawF, Math.max(Math.abs(c.speed), 1)) - YAW_DAMP * this.throttle * (c.yawRate - this.yawF), -lock, lock) * wv;
    // released key, once the car slides or rotates faster than grip allows: point the front wheels down the travel
    // direction (counter-steer by itself) and steer the yaw rate toward a gentle rotation back in line (≤ 0.7 rad/s,
    // so the tail comes back without swinging through to the other side)
    const cs = c.assists.counterSteer ? tune.csGain * (c.csMul ?? 1) : 0;
    const vf = Math.max(Math.abs(c.speed), 1);
    const kinA = clamp(Math.atan2(c.latSpeed + c.frontArm * c.yawRate, vf), -lock, lock) * wv;
    const rGrip = (c.mu * G) / Math.max(vt, 5);
    const slideW = smooth(clamp((Math.abs(beta) - 0.05) / 0.12, 0, 1));
    const spinW = smooth(clamp((Math.abs(c.yawRate) - 1.2 * rGrip) / (0.8 * rGrip), 0, 1));
    const rDes = clamp(2.5 * beta, -0.7, 0.7);
    const corr = clamp(0.25 * (rDes - c.yawRate), -c.alphaPeak, c.alphaPeak) * wv;
    const rel = (kinA + corr) * cs * Math.max(slideW, spinW);
    // drift assist: predicted tail-out angle against the cap → how much front grip a held key may still ask for
    const capDeg = Number.isNaN(c.slipCap) ? tune.slipCap : c.slipCap * (c.assists.level === 'novice' ? 20 / 35 : 1);
    const cap = capDeg * DEG;
    const betaP = beta + clamp(this.slideRate, -3, 3) * 0.25;
    const band = Math.min(12 * DEG, 0.4 * cap);
    const ap = c.alphaPeak;
    const hbT = tune.hbTurn * DEG;
    const grip = (dir: number) => {
      if (hbOn && hbT > 0) {
        // handbrake turn: pull until the turn target is near (predicted from the yaw rate), then let go / catch
        // …and before the body slip gets past what full opposite lock can still catch (≈ 40°)
        const turned = this.hbTurn * dir + Math.max(0, c.yawRate * dir) * 0.3;
        const tailHb = -dir * betaP;
        return clamp(Math.min((hbT - turned) / (30 * DEG), (hbSlipAt(c.hbSlip ?? HB_SLIP, this.hbV0) + 8 * DEG - tailHb) / (20 * DEG)), -0.6, 1);
      }
      if (cap <= 0) return 1;
      const tail = -dir * betaP; // holding right (+1) with the velocity left of the nose (β < 0) = tail out
      let k = clamp((cap + 0.4 * band - tail) / band, -0.6, 1);
      // grip driving on the throttle (not sliding yet): a held key asks for the most cornering the CAR has — if the
      // rear tyres reach their peak first, the front stops there too (no power-on drift creeping in by itself; a
      // lift, a brake or the handbrake still swings the tail out, and once it is out the slide is kept)
      const grip = this.drifting ? 0 : 1 - smooth(clamp((tail - 0.25) / 0.2, 0, 1));
      if (grip > 0 && this.throttle > 0.4 && this.brake < 0.1) k = Math.min(k, 1 - grip * clamp((c.rearSat - 1.0) * 3, 0, 1));
      return k;
    };
    // a slide the driver started (off the throttle, on the brake or the handbrake) is held as a drift until it is
    // over (body slip back under 5°) or the key is let go
    const provoked = this.throttle < 0.3 || this.brake > 0.1 || this.hbHold > 0;
    if (Math.abs(beta) > 0.2 && provoked && Math.abs(this.steer) > 0.3 && vt > 12) this.drifting = 1;
    else if (Math.abs(beta) < 0.09 || Math.abs(this.steer) < 0.15) this.drifting = 0;
    const kR = grip(1), kL = grip(-1);
    const full = (dir: number, k: number) => {
      const a = kin + dir * ap * k;
      return clamp(dir * lock + (a - dir * lock) * wv, -lock, lock);
    };
    const fullR = full(1, kR), fullL = full(-1, kL);
    this.kin = kin; this.rel = rel; this.fullL = fullL; this.fullR = fullR;
    this.prog = 1 + 0.5 * smooth(clamp((v - 15) / 25, 0, 1));

    let angle: number;
    if (inp.digital) {
      const a = Math.pow(Math.abs(this.steer), this.prog);
      angle = rel + a * ((this.steer >= 0 ? fullR : fullL) - rel);
      this.driverAngle = this.steer * classic;
    } else {
      // pad / phone: the stick is an angle; clamp it to the grip window and add the counter-steer help
      const want = this.steer * classic;
      this.driverAngle = want;
      angle = clamp(want + rel * (1 - Math.min(1, Math.abs(this.steer) * 2)), Math.min(fullL, rel), Math.max(fullR, rel));
    }
    this.assistAngle = angle - this.driverAngle;
    return clamp(angle, -lock, lock);
  }
}
