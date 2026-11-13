// A "keyboard hand": turns a continuous driving intent (wheel angle, throttle, brake) into 0/1 key presses the way a
// person on a keyboard has to — with a reaction delay, minimum press/release times, and only an internal model of where
// the steering is. Used by the keyboard robot and the keyboard probes to measure how drivable the key shaping is.
import { clamp } from '../math/vec';
import type { Car } from '../vehicle/car';
import { emptyInput, stepKeySteer, type DriverInput } from '../vehicle/controls';
import { TUNE, gentleCaps } from '../vehicle/tune';

export interface Intent {
  /** desired total front-wheel angle (rad, + right) */
  angle: number;
  throttle: number;
  brake: number;
  handbrake?: number;
  /** path curvature the plan is steering for (1/m, + right, in the direction of travel) */
  kappa?: number;
  /** target speed minus current speed (m/s) */
  speedErr?: number;
  /** curvature of the road itself just ahead (1/m, + right), without line corrections */
  kappaRoad?: number;
  /** slow hand: steering step chosen by the robot (−2 left, −1 left + 轻踩, 0 none, 1, 2); overrides kappa */
  steerStep?: number;
}

export interface KeyHandParams {
  /** reaction / actuation delay (s) */
  delay: number;
  /** minimum time a key stays down / up (s) */
  minPress: number;
  minRelease: number;
  /** steer dead band in processed-steer units */
  band: number;
}

export const HUMAN_KEYS: KeyHandParams = { delay: 0.1, minPress: 0.06, minRelease: 0.045, band: 0.035 };

interface KeyState { down: boolean; held: number }

const TICK = 1 / 120;

export class KeyHand {
  /** decided key states waiting for the delay to elapse: bits L R T B H */
  private queue: number[] = [];
  private keys: Record<'L' | 'R' | 'T' | 'B' | 'H', KeyState> = {
    L: { down: false, held: 99 }, R: { down: false, held: 99 }, T: { down: false, held: 99 }, B: { down: false, held: 99 }, H: { down: false, held: 99 },
  };
  private out: DriverInput = emptyInput();
  private sAvg = 0;
  /** statistics */
  presses = 0;
  ticks = 0;

  constructor(readonly p: KeyHandParams = HUMAN_KEYS) {
    const n = Math.max(0, Math.round(p.delay / TICK));
    for (let i = 0; i < n; i++) this.queue.push(0);
  }

  private want(k: keyof KeyHand['keys'], on: boolean) {
    const s = this.keys[k];
    s.held += TICK;
    if (on !== s.down && s.held >= (s.down ? this.p.minPress : this.p.minRelease)) {
      s.down = on; s.held = 0;
      if (on) this.presses++;
    }
    return s.down;
  }

  /** decide keys for this tick from intent; returns the (delayed) input the car receives now */
  drive(car: Car, it: Intent): DriverInput {
    this.ticks++;
    const v = Math.abs(car.fwdSpeed);
    // predict the processed steer when this decision lands: run the pending keys through the steering model
    let s = car.controls.steer;
    for (const bits of this.queue) s = stepKeySteer(s, ((bits >> 1) & 1) - (bits & 1), v, TICK, car.tune.steerRate);
    // the steering share that gives the wanted wheel angle in the current steering frame
    const target = car.controls.keyFor(it.angle);
    // a person judges the steering by its effect, i.e. its recent average, not the instantaneous value: keep the
    // ~0.15 s average of the processed steer on target (that sets the tap duty cycle), and let the prediction stop
    // obvious overshoot
    this.sAvg += (car.controls.steer - this.sAvg) * (1 - Math.exp(-TICK / 0.15));
    const sJudge = 0.6 * this.sAvg + 0.4 * s;
    const err = target - sJudge;
    let L = false, R = false;
    if (err > this.p.band) R = true;
    else if (err < -this.p.band) L = true;
    else if (Math.abs(target) > 0.08) { if (target > 0) R = sJudge < target; else L = sJudge > target; }
    if (R && s > target + 0.25) R = false;
    if (L && s < target - 0.25) L = false;
    const r = this.want('R', R && !L), l = this.want('L', L && !R);
    // throttle: predicted ramped throttle vs wanted
    let thr = car.controls.throttle;
    for (const bits of this.queue) thr = clamp(thr + (((bits >> 2) & 1) ? 5.5 : -12) * TICK, 0, 1);
    const tOn = it.brake > 0.25 ? false : it.throttle > 0.97 ? true : it.throttle < 0.03 ? false : thr < it.throttle;
    const t = this.want('T', tOn);
    // a person comes off the brake when the car starts to rotate under braking
    const rot = Math.abs(car.slideAngle) > 0.2 && car.slideAngle * car.yawRate < 0;
    const b = this.want('B', !rot && (it.brake > 0.25 || (this.keys.B.down && it.brake > 0.12)));
    const h = this.want('H', (it.handbrake ?? 0) > 0.5);
    const bits = (l ? 1 : 0) | (r ? 2 : 0) | (t ? 4 : 0) | (b ? 8 : 0) | (h ? 16 : 0);
    this.queue.push(bits);
    const now = this.queue.shift() ?? bits;
    const o = this.out;
    o.steer = ((now >> 1) & 1) - (now & 1);
    o.throttle = (now >> 2) & 1;
    o.brake = (now >> 3) & 1;
    o.handbrake = (now >> 4) & 1;
    o.shiftUp = o.shiftDown = false;
    o.digital = true;
    return o;
  }
}

// ───────────────────────── slow hand (手感重做) ─────────────────────────
// A stand-in for a person on a keyboard who drives by HOLDING keys: every key changes state at most 2.5 times a second
// (a press or a release each count; so a key stays down / up at least 0.4 s), what it sees is 0.2 s old by the time
// a key moves, and it does not predict its own delay (it decides on the car as it is now; the decision lands later).

export interface SlowHandParams {
  /** perception → key delay (s) */
  delay: number;
  /** a key keeps its state at least this long after a change (s): 0.4 s = 2.5 changes per second */
  dwell: number;
}

export const SLOW_HAND: SlowHandParams = { delay: 0.2, dwell: 0.4 };

export class SlowHand {
  private queue: number[] = [];
  private state = { L: false, R: false, T: false, B: false, H: false, G: false };
  private since = { L: 99, R: 99, T: 99, B: 99, H: 99, G: 99 };
  private out: DriverInput = emptyInput();
  /** statistics: state changes per key, and the most changes any key made within one second */
  changes = 0;
  maxPerSecond = 0;
  private hist: Record<'L' | 'R' | 'T' | 'B' | 'H' | 'G', number[]> = { L: [], R: [], T: [], B: [], H: [], G: [] };
  private t = 0;

  get throttleHeld() { return this.state.T; }
  get brakeHeld() { return this.state.B; }
  /** step thresholds on the grip share the bend needs: off→gentle, off→full, gentle→off, gentle→full, full→off, full→gentle */
  steps = [0.35, 0.8, 0.2, 0.85, 0.25, 0.6];

  /** 轻踩 ratio (URL gentle=) and the steering cap it gives */
  readonly gentle: number;
  private readonly gentleSteer: number;

  constructor(readonly p: SlowHandParams = SLOW_HAND, gentle = TUNE.gentle) {
    const n = Math.max(0, Math.round(p.delay / TICK));
    for (let i = 0; i < n; i++) this.queue.push(4); // throttle held at the start, like the line hold
    this.gentle = gentle;
    this.gentleSteer = gentleCaps(gentle).steer;
  }

  private want(k: 'L' | 'R' | 'T' | 'B' | 'H' | 'G', on: boolean) {
    if (on !== this.state[k] && this.since[k] >= this.p.dwell) {
      this.state[k] = on; this.since[k] = 0; this.changes++;
      const h = this.hist[k];
      h.push(this.t);
      while (h.length && h[0] <= this.t - 1) h.shift();
      if (h.length > this.maxPerSecond) this.maxPerSecond = h.length;
    }
    return this.state[k];
  }

  /** decide keys from the intent on the car as it is now; returns the input that lands now (decided `delay` ago) */
  drive(car: Car, it: Intent): DriverInput {
    this.t += TICK;
    for (const k of ['L', 'R', 'T', 'B', 'H', 'G'] as const) this.since[k] += TICK;
    // steering: how much of the car's cornering grip the path ahead needs (v² κ against μ g) — a person reads the bend
    // and the car's drift toward the edge, not the wheel angle; slides are left to the assists (counter-steer / caps)
    const v = Math.max(0, car.fwdSpeed);
    const muG = Math.max(0.2, car.frontMu * car.spec.tire.muScale * car.tune.grip) * 9.81;
    const k = it.kappa ?? 0;
    // share of the grip the bend asks for; at low speed (hairpins, getting back on the road) the wheel angle counts
    const need = Math.max((Math.max(v, 6) ** 2 * Math.abs(k)) / muG, Math.abs(car.controls.keyFor(it.angle)) * clamp(1 - (v - 8) / 8, 0, 1));
    const dir = Math.sign(k);
    // the bend itself (road curvature ahead, without the corrections): in a corner that needs half the grip or more a
    // person keeps at least the 轻踩 step held and corrects between that and the full key, rather than letting go
    const ffNeed = (Math.max(v, 6) ** 2 * (it.kappaRoad ?? 0)) / muG;
    const floorStep = ffNeed * dir > 0.5 ? 1 : 0;
    const cur = this.state.R ? 1 : this.state.L ? -1 : 0, curG = this.state.G;
    // steps: let go (0) / 轻踩 + key (≈ half the grip) / key (all of it); hysteresis toward the current step
    let step = cur === 0 ? 0 : curG ? 1 : 2;
    if (cur !== 0 && cur !== dir && need > 0.15) step = 0;
    else { const T = this.steps; step = step === 0 ? (need > T[1] ? 2 : need > T[0] ? 1 : 0) : step === 1 ? (need > T[3] ? 2 : need < T[2] ? 0 : 1) : (need < T[4] ? 0 : need < T[5] ? 1 : 2); }
    if (step < floorStep && !(cur !== 0 && cur !== dir)) step = floorStep;
    // the tail is stepping out against the key (sliding toward the outside): let go, the assist catches it — a player
    // only has to stop pressing into the slide
    const tailOut = -dir * car.slideAngle;
    if (tailOut > (this.state.R || this.state.L ? 0.26 : 0.2)) step = 0;
    let sideR = step > 0 ? dir > 0 : false, sideL = step > 0 ? dir < 0 : false;
    if (it.steerStep !== undefined) { step = Math.abs(it.steerStep); sideR = it.steerStep > 0; sideL = it.steerStep < 0; }
    const r = this.want('R', sideR && !this.state.L), l = this.want('L', sideL && !this.state.R);
    const g = this.want('G', step === 1);
    const a = need;
    // pedals: held or not, with hysteresis
    // pedals by the speed the road allows: hold the throttle while under it (traction control and the push-wide
    // protection look after the tyres), lift when over it, brake when well over it — before the turn rather than in it
    const e = it.speedErr ?? (it.throttle > 0.5 ? 1 : it.brake > 0.3 ? -6 : -2);
    const turning = a > 0.6;
    const b = this.want('B', this.state.B ? e < -1.5 : e < (turning ? -7 : -4));
    const t = this.want('T', !b && (this.state.T ? e > -2.5 : e > -0.5));
    const h = this.want('H', (it.handbrake ?? 0) > 0.5);
    const bits = (l ? 1 : 0) | (r ? 2 : 0) | (t ? 4 : 0) | (b ? 8 : 0) | (h ? 16 : 0) | (g ? 32 : 0);
    this.queue.push(bits);
    const now = this.queue.shift() ?? bits;
    const o = this.out;
    // what src/app/input.ts does with the 轻踩 key held
    const caps = (now >> 5) & 1 ? gentleCaps(this.gentle) : { throttle: 1, brake: 1, steer: 1 };
    o.steer = (((now >> 1) & 1) - (now & 1)) * caps.steer;
    o.throttle = ((now >> 2) & 1) * caps.throttle;
    o.brake = ((now >> 3) & 1) * caps.brake;
    o.handbrake = (now >> 4) & 1;
    o.shiftUp = o.shiftDown = false;
    o.digital = true;
    return o;
  }
}
