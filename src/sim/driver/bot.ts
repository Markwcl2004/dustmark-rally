// Robot driver: pure-pursuit steering on the centreline + target speed from curvature/crests with braking look-ahead.
import { SURFACES, Surface } from '../../data/surfaces';
import { V3, clamp } from '../math/vec';
import { DS } from '../stage/centerline';
import type { Stage } from '../stage/stage';
import type { Car } from '../vehicle/car';
import { tireCurve } from '../vehicle/tire';
import { emptyInput, type DriverInput } from '../vehicle/controls';
import { KeyHand, SlowHand, type Intent } from './keys';
import { CachedGround, copyState } from '../vehicle/predict';
import { Car as SimCar } from '../vehicle/car';
import { gentleCaps } from '../vehicle/tune';
import { DT } from '../vehicle/car';
import type { World } from '../world';

const G = 9.81;

export interface BotParams {
  /** 0..1 scales grip usage, braking and top speed */
  skill: number;
  /** driving with 0/1 keys: on sealed surfaces (stiff, peaky tyres) the keyed steering cannot hold the limit as
   *  precisely, so corner a little below it */
  keyboard?: boolean;
}

export class Bot {
  readonly vTarget: Float64Array;
  private input: DriverInput = emptyInput();
  private stuck = 0;
  private right = new V3(); private fwd = new V3(); private t = new V3();
  /** lateral offset (+ right) for a mild racing line */
  readonly line: Float64Array;
  /** road friction used for the speed plan (per metre, worst over the next 12 m) */
  readonly mu: Float64Array;
  /** slip-angle feed-forward scale per metre (surface tyre stiffness relative to gravel) */
  readonly slipK: Float64Array;
  /** achievable share of μ under ABS braking per metre */
  readonly brakeEff: Float64Array;

  constructor(readonly stage: Stage, readonly car: Car, readonly params: BotParams = { skill: 0.9 }) {
    const cl = stage.cl, n = cl.n;
    const skill = clamp(params.skill, 0.3, 1.05);
    // grip and capability: surface friction along the road (sampled at the centreline, worst value over the next
    // 12 m so the car is already slow when it reaches ice / a ford), the car's tyres, its brakes and its top speed
    const sp = car.spec;
    const latK = sp.tire.muScale * sp.tire.lateralScale;
    const lonK = sp.tire.muScale;
    const brakeCap = (4 * sp.brakes.maxTorque) / sp.wheel.radius / sp.mass;
    const vMax = (sp.target.topKmh / 3.6) * (0.8 + 0.2 * skill);
    const muRaw = new Float64Array(n);
    this.slipK = new Float64Array(n);
    this.brakeEff = new Float64Array(n);
    const gv = SURFACES[Surface.Gravel], gK = Math.tan((gv.peakSlipDeg * Math.PI) / 180) / gv.mu;
    for (let i = 0; i < n; i++) {
      const p = stage.pointAt(i * DS);
      const sp = SURFACES[stage.surface(p.x, p.z)] ?? gv;
      // usable braking on peaky (sealed) surfaces is lower: ABS cycles around a sharp peak (measured ~0.75–0.85 μ)
      muRaw[i] = sp.mu;
      this.brakeEff[i] = clamp(1.3 / sp.shapeC, 0.75, 1);
      // tyre slip angle needed per unit of lateral g, relative to gravel (asphalt: stiff tyres, ~0.4×)
      this.slipK[i] = Math.min(1.4, Math.tan((sp.peakSlipDeg * Math.PI) / 180) / sp.mu / gK);
    }
    this.mu = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = muRaw[i];
      for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 12); j++) m = Math.min(m, muRaw[j]);
      this.mu[i] = m;
    }
    // low-grip surfaces (snow, ice): slides build slowly and recover slowly — use less of the grip
    const lowMu = sp.drive === 'rwd' ? 0.85 : 1; // rear drive on snow/ice: the tail goes on the slightest lift or push
    const keyK = params.keyboard ? 0.92 : 1;
    const aLatAt = (i: number) => this.mu[i] * latK * G * (0.5 + 0.32 * skill) * (this.mu[i] < 0.6 ? (0.8 + this.mu[i] / 3) * lowMu : 1) * (this.brakeEff[i] < 0.95 ? keyK : 1);
    const aBrakeAt = (i: number) => Math.min(this.mu[i] * this.brakeEff[i] * lonK * G * (0.45 + 0.3 * skill), brakeCap * 0.85);
    // racing line: shift toward the inside of corners (smoothed curvature)
    const kS = new Float64Array(n);
    const W = 14;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) if (Math.abs(cl.kappa[j]) > Math.abs(m)) m = cl.kappa[j];
      kS[i] = m;
    }
    this.line = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0, c = 0;
      for (let j = Math.max(0, i - 25); j <= Math.min(n - 1, i + 25); j++) { acc += cl.kappa[j]; c++; }
      const k = acc / c;
      this.line[i] = clamp(k * 60, -1, 1) * (stage.def.halfWidth - 1.4);
    }
    // the line's own curvature (three points 5 m apart on the offset path): moving to the inside of a hairpin makes the
    // turn tighter than the centreline (10 m radius − 2 m inside = 8 m). On sealed roads (stiff, peaky tyres, walls and
    // rails at the verge) the corner speed is planned on that; loose surfaces forgive it (the car drifts a little wide)
    const kL = new Float64Array(n);
    const H = 5;
    for (let i = H; i < n - H; i++) {
      const a = stage.pointAt((i - H) * DS), b = stage.pointAt(i * DS), c = stage.pointAt((i + H) * DS);
      const ax = a.x + a.rx * this.line[i - H], az = a.z + a.rz * this.line[i - H];
      const bx = b.x + b.rx * this.line[i], bz = b.z + b.rz * this.line[i];
      const cx = c.x + c.rx * this.line[i + H], cz = c.z + c.rz * this.line[i + H];
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const la = Math.hypot(bx - ax, bz - az), lb = Math.hypot(cx - bx, cz - bz), lc = Math.hypot(cx - ax, cz - az);
      kL[i] = la * lb * lc > 1e-6 ? (2 * Math.abs(cross)) / (la * lb * lc) : 0;
    }
    for (let i = 0; i < n; i++) {
      let m = Math.abs(kS[i]);
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) if (kL[j] > m && this.brakeEff[j] < 0.95) m = kL[j];
      kS[i] = m;
    }
    const v = new Float64Array(n);
    const prof = stage.terrain.prof;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(kS[i]);
      let vi = k > 1e-5 ? Math.sqrt(aLatAt(i) / k) : vMax;
      // crests: keep vertical acceleration within ~1.4 g of "lightness"; jumps are flown, but not flat out
      if (i > 3 && i < n - 4) {
        const curv = -(prof[i + 3] - 2 * prof[i] + prof[i - 3]) / (9 * DS * DS);
        if (curv > 0.004) vi = Math.min(vi, Math.sqrt((G * 1.25) / curv));
      }
      v[i] = Math.min(vi, vMax);
    }
    // jumps: fixed approach speed so the landing is on the down-slope
    for (const p of cl.pieces) for (const f of p.features) if (f.kind === 'jump') {
      const i = Math.round(f.s / DS);
      for (let j = i - 30; j <= i + 4; j++) if (j >= 0 && j < n) v[j] = Math.min(v[j], (95 + 25 * skill) / 3.6);
    }
    // braking look-ahead (backward pass)
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * aBrakeAt(i) * DS));
    this.vTarget = v;
  }

  private intent: Intent = { angle: 0, throttle: 0, brake: 0 };

  /** continuous driving intent: front-wheel angle, throttle, brake */
  plan(world: World): Intent {
    const car = this.car, st = this.stage, it = this.intent;
    car.quat.rotate(this.t.set(1, 0, 0), this.right);
    car.quat.rotate(this.t.set(0, 0, -1), this.fwd);
    const v = Math.max(0, car.fwdSpeed);
    // anticipation: plan from where the car will be when the decision lands (keyboard robot: its reaction delay)
    const lead = this.lead;
    const s = world.session.progressS + v * lead;
    const yawLead = -car.yawRate * lead; // world rotation about +Y (left-positive)
    const cy = Math.cos(yawLead), sy = Math.sin(yawLead);
    const px = car.pos.x + car.vel.x * lead, pz = car.pos.z + car.vel.z * lead;
    // pure pursuit in the velocity frame + slide (β) compensation + tire slip feed-forward
    const L = clamp(4 + v * 0.3, 7, 19);
    const sl = Math.min(st.cl.length - 1, s + L);
    const p = st.pointAt(sl);
    // back to the line no steeper than ~11° across the road: a car run wide out of a hairpin does not whip over to the
    // inside line (that is how it found the wall on the other side of the exit)
    const nrNow = st.terrain.nearest(car.pos.x, car.pos.z);
    const lineOff = this.line[Math.min(this.line.length - 1, Math.round(sl / DS))];
    const shift = 0.2 * L;
    const off = nrNow.found ? clamp(lineOff, nrNow.d - shift, nrNow.d + shift) : lineOff;
    const tx = p.x + p.rx * off - px, tz = p.z + p.rz * off - pz;
    // heading reference: velocity direction when moving, else the nose (rotated by the anticipated yaw)
    let hx = this.fwd.x, hz = this.fwd.z;
    const sp = Math.hypot(car.vel.x, car.vel.z);
    if (sp > 3 && car.fwdSpeed > 0) { hx = car.vel.x / sp; hz = car.vel.z / sp; }
    if (lead > 0) { const rx = hx * cy + hz * sy, rz = -hx * sy + hz * cy; hx = rx; hz = rz; }
    const xr = -tx * hz + tz * hx; // + = target to the right of travel
    const zf = tx * hx + tz * hz;
    const d2 = Math.max(1, xr * xr + zf * zf);
    const wb = car.spec.wheelbase;
    const kappa = (2 * xr) / d2;
    // road curvature ahead for the tire-slip feed-forward (not the error-correction part)
    let kr = 0;
    for (let k = 0; k < 4; k++) kr += st.pointAt(s + (L * k) / 4).kappa;
    kr /= 4;
    const sk = this.slipK[Math.min(this.slipK.length - 1, Math.max(0, Math.round(s / DS)))];
    const ff = clamp(0.013 * sk * v * v * kr, -0.14, 0.14);
    // big slide → catching it comes first (counter-steer into the slide, path second)
    const big = clamp((Math.abs(car.slideAngle) - 0.3) / 0.25, 0, 1);
    // on low grip the slide has to be caught harder (more opposite lock than the slide angle itself)
    const muNow = this.mu[Math.min(this.mu.length - 1, Math.max(0, Math.round(s / DS)))];
    const csK = 1 + 0.8 * clamp((0.4 - muNow) / 0.2, 0, 1);
    let delta = clamp(car.slideAngle * csK, -0.6, 0.6) + (Math.atan(wb * kappa) + ff) * (1 - 0.7 * big);
    // keep the front tyres near their peak slip angle: on stiff, peaky tyres (asphalt) steering past it only plows on
    if (v > 8 && big === 0) {
      const ap = Math.atan(tireCurve(car.wheels[0].surface).tanPeak) * 1.25;
      const kin = car.slideAngle + (wb * (1 - car.spec.frontWeight) * car.yawRate) / v;
      delta = clamp(delta, kin - ap, kin + ap);
    }
    if (zf < 0) delta = Math.sign(xr || 1) * 0.6; // target behind: full lock toward it
    it.angle = delta;
    it.kappa = zf < 0 ? Math.sign(xr || 1) * 0.2 : kappa;
    // speed control: look a little ahead for latency
    const iA = Math.min(this.vTarget.length - 1, Math.round((s + v * (0.35 + this.lookExtra) + 2) / DS));
    // off the line → slow down to get back
    const lat = Math.abs(st.terrain.nearest(car.pos.x, car.pos.z).d);
    const vt = this.vTarget[iA] * (lat > st.def.halfWidth - 0.5 ? 0.85 : 1);
    const err = vt - v;
    it.speedErr = err;
    const slide = Math.abs(car.slideAngle);
    // throttle with a little traction sense: ease off when sliding or wide of the line
    const rwd = car.spec.drive === 'rwd';
    const tc = clamp(1 - (slide - (rwd ? 0.06 : 0.1)) * (rwd ? 4.5 : 3.2), 0.25, 1) * (lat > st.def.halfWidth - 0.8 ? 0.6 : 1);
    const muHere = this.mu[Math.min(this.mu.length - 1, Math.max(0, Math.round(s / DS)))];
    it.throttle = clamp(err * 0.45 + 0.35, 0, 1) * tc * (muHere < 0.5 ? 0.55 + 0.9 * muHere : 1);
    it.brake = err < -1.2 ? clamp(-err * 0.22, 0, 1) : 0;
    if (it.brake > 0) it.throttle = 0;
    // stuck / flipped → reset (counts as an accident)
    if (world.session.phase === 'running' && (v < 1 && car.speed < 1)) this.stuck += 1 / 120; else this.stuck = 0;
    return it;
  }

  /** extra speed look-ahead (s) — the keyboard robot reacts later, so it brakes a little earlier */
  lookExtra = 0;
  /** plan this far (s) into the future from the current motion (keyboard robot: covers its reaction delay) */
  lead = 0;

  /** analog (gamepad-like) driving */
  drive(world: World): DriverInput {
    const car = this.car, inp = this.input;
    const it = this.plan(world);
    const sf = clamp((Math.abs(car.fwdSpeed) - 4) / 36, 0, 1);
    const maxAng = ((car.spec.steer.lockDeg + (car.spec.steer.highSpeedDeg - car.spec.steer.lockDeg) * sf * sf * (3 - 2 * sf)) * Math.PI) / 180;
    inp.steer = clamp(it.angle / maxAng, -1, 1);
    inp.digital = false;
    inp.throttle = it.throttle;
    inp.brake = it.brake;
    inp.handbrake = 0;
    inp.shiftUp = inp.shiftDown = false;
    return inp;
  }

  /** bot wants a reset (stuck or upside down) */
  wantsReset(world: World) {
    if (this.stuck > 2.5 || world.session.flippedFor > 1.5) { this.stuck = 0; return true; }
    return false;
  }
}

/** Robot that may only press keys (0/1, human reaction delay and key timing) — measures keyboard drivability. */
export class KeyBot {
  readonly bot: Bot;
  readonly hand = new KeyHand();
  constructor(stage: Stage, car: Car, params: BotParams = { skill: 0.9 }) {
    this.bot = new Bot(stage, car, { ...params, keyboard: true });
    this.bot.lookExtra = 0.15;
    this.bot.lead = this.hand.p.delay;
  }
  drive(world: World): DriverInput { return this.hand.drive(this.bot.car, this.bot.plan(world)); }
  wantsReset(world: World) { return this.bot.wantsReset(world); }
}

/** Robot standing in for a person on a keyboard (手感重做): holds keys, ≤ 2.5 key changes per second per key, 0.2 s late,
 *  no prediction of its own delay. `skill` scales its target speeds like the other robots. */
export class SlowKeyBot {
  readonly bot: Bot;
  readonly hand = new SlowHand();
  /** a person's sense of where the car goes: for each of the five steering steps (left / left+轻踩 / none /
   *  right+轻踩 / right) and the pedals the speed plan allows, the car (cloned) is driven ahead holding that for 0.5 s
   *  and then either letting go, keeping it, or easing to half, for `lookS` in all; the choice that keeps the car
   *  nearest the middle of the road (and gets on down it) wins. It decides on the car as it is NOW — the 0.2 s before
   *  its keys move and the ≥ 0.4 s a key stays put are not part of its picture (no self-prediction) */
  lookS = 1.4;
  /** decisions per second (a person re-judges a few times a second) */
  decideHz = 10;
  /** weight of progress against staying in the middle; cost of coasting below the speed the road allows */
  progressW = 0.4;
  coastW = 0;
  private step = 0;
  private pedal: [number, number] = [1, 0];
  private tick = 0;
  private inp: DriverInput = emptyInput();
  private ground: CachedGround;
  private a: SimCar; private b: SimCar;
  constructor(stage: Stage, car: Car, params: BotParams = { skill: 0.9 }) {
    this.bot = new Bot(stage, car, { ...params, keyboard: true });
    this.bot.lookExtra = 0;
    this.bot.lead = 0;
    this.ground = new CachedGround(stage);
    this.a = new SimCar(car.spec); this.b = new SimCar(car.spec);
  }

  private setInp(step: number, thr: number, brk: number) {
    const I = this.inp, c = Math.abs(step) === 1 ? gentleCaps(this.hand.gentle) : null;
    I.steer = Math.sign(step) * (c ? c.steer : 1); I.throttle = thr * (c ? c.throttle : 1); I.brake = brk * (c ? c.brake : 1);
    I.handbrake = 0; I.digital = true; I.shiftUp = I.shiftDown = false;
    return I;
  }

  /** run `car` for n steps of 2·DT holding the input; accumulate the path cost from sample index k0 (0.1 s samples) */
  private roll(car: SimCar, n: number, k0: number, kN: number, acc: { J: number; s: number; dead: boolean }) {
    const st = this.bot.stage, hw = st.def.halfWidth;
    for (let i = 1; i <= n; i++) {
      car.step(this.inp, this.ground, 2 * DT);
      if (car.events.obstacleHit > 1) acc.dead = true;
      if (i % 6 === 0) {
        const k = k0 + i / 6, wk = k / kN;
        const nr = st.terrain.nearest(car.pos.x, car.pos.z);
        const d = nr.found ? nr.d : 99;
        if (nr.found) acc.s = nr.s;
        const over = Math.abs(d) - (hw - 0.7);
        acc.J += wk * (0.3 * (d / hw) ** 2 + (over > 0 ? 8 * over * over : 0));
        if (Math.abs(car.slideAngle) > 0.9) acc.J += 3 * wk;
      }
    }
  }

  drive(world: World): DriverInput {
    const it = this.bot.plan(world);
    const car = this.bot.car;
    const running = world.session.phase === 'running' && car.speed > 3;
    if (this.tick++ % Math.round(120 / this.decideHz) === 0 && running) {
      const s0 = world.session.progressS, e = it.speedErr ?? 0;
      const n1 = 30, n2 = Math.round((this.lookS - 0.5) / (2 * DT)), kN = (n1 + n2) / 6;
      const norm = Math.max(10, car.speed * this.lookS);
      // pedals the speed plan allows: under the road's speed → throttle or coast; over it → coast or brake
      const pedals: [number, number][] = e > 1 ? [[1, 0], [0, 0]] : e < -3 ? [[0, 0], [0, 1]] : [[1, 0], [0, 0], [0, 1]];
      let best = this.step, bestP = this.pedal, bestJ = Infinity;
      const acc = { J: 0, s: s0, dead: false };
      for (const [thr, brk] of pedals) for (const c of [-2, -1, 0, 1, 2]) {
        copyState(this.a, car);
        acc.J = 0; acc.s = s0; acc.dead = false;
        this.setInp(c, thr, brk);
        this.roll(this.a, n1, 0, kN, acc);
        const J1 = acc.J, sA = acc.s, dA = acc.dead;
        let Jc = Infinity;
        for (const c2 of c === 0 ? [0] : [c, Math.sign(c), 0]) {
          copyState(this.b, this.a);
          acc.J = J1; acc.s = sA; acc.dead = dA;
          this.setInp(c2, thr, brk);
          this.roll(this.b, n2, n1 / 6, kN, acc);
          const J = acc.J + (acc.dead ? 50 : 0) - this.progressW * (acc.s - s0) / norm;
          if (J < Jc) Jc = J;
        }
        if (e > 1 && thr === 0) Jc += this.coastW;
        if (c === this.step && thr === this.pedal[0] && brk === this.pedal[1]) Jc -= 0.05; // a little loyalty to what is held
        if (Jc < bestJ) { best = c; bestP = [thr, brk]; bestJ = Jc; }
      }
      this.step = best; this.pedal = bestP;
    }
    it.steerStep = running ? this.step : undefined;
    if (running) it.speedErr = this.pedal[1] ? -9 : this.pedal[0] ? 3 : -3;
    return this.hand.drive(car, it);
  }

  /** a person also presses R when the car is lost off the road (beyond the ditch for 3 s), or when it is going the
   *  wrong way (25 m back down the road from the furthest point reached, e.g. after a spin it drove off the wrong way) */
  private lost = 0;
  private furthest = -Infinity;
  wantsReset(world: World) {
    const c = this.bot.car, st = this.bot.stage, ses = world.session;
    const d = Math.abs(st.terrain.nearest(c.pos.x, c.pos.z).d);
    this.lost = ses.phase === 'running' && d > st.terrain.edge2 + 1 ? this.lost + 1 / 120 : 0;
    this.furthest = Math.max(this.furthest, ses.progressS);
    const wrongWay = ses.phase === 'running' && ses.progressS < this.furthest - 25;
    if (this.lost > 3 || wrongWay) { this.lost = 0; this.furthest = -Infinity; return true; }
    if (this.bot.wantsReset(world)) { this.furthest = -Infinity; return true; }
    return false;
  }
}
