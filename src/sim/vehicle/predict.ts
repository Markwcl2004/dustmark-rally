// Trajectory prediction (DESIGN §4 轨迹预测): clone the car, hold the current raw input, step the same sim forward.
//
// - The clone is a separate Car ("shadow") whose every mutable field is copied from the real car by reflection
//   (rigid body, wheels, gearbox/engine, input shaping in Controls, assist state such as TC/handbrake timers). Reflection
//   instead of a hand-written copy keeps working when car.ts grows new state; `aliased` lists anything it could only
//   share by reference (should stay empty — a test checks it).
// - Zero side effects: the real car is only read. Session/timing/penalties are not touched (the predictor never
//   sees a Session), the sim has no random stream, and the only shared caches below the car (tyre curves, terrain
//   scratch results) are pure memos of deterministic values.
// - Cost: the stage's analytic height field is the expensive part of a car tick (~95 %), so the predictor reads the
//   ground through `CachedGround`, a bilinear grid memo (0.2 m) kept across predictions. Consecutive predictions
//   overlap almost entirely, so steady state is a few hundred height evaluations per prediction.
// - Allocation: everything here is preallocated (typed arrays, scratch vectors). Car.step itself still allocates a
//   few small vectors per tick (as the real sim does).
import { Surface } from '../../data/surfaces';
import type { Ground, Obstacle } from '../ground';
import { Quat, V3 } from '../math/vec';
import { Car, DT } from './car';
import { emptyInput, type DriverInput } from './controls';

export const STOP_NONE = 0;
export const STOP_IMPACT = 1;
export const STOP_ROLLOVER = 2;

export interface PredictOptions {
  /** seconds to look ahead (DESIGN: 2.5, adjustable 1.5–4) */
  horizon: number;
  /** spacing of recorded samples (s) */
  sampleEvery: number;
  /** sim step used by the prediction (s); DT = exact 120 Hz, 2·DT = half the cost (see PROGRESS for the error) */
  step: number;
  /** read the ground through a bilinear memo grid (much cheaper on analytic stages; exact on flat test pads) */
  cacheGround: boolean;
  /** off-road test for colouring (e.g. beyond the shoulder); default: surface under the CG is grass/mud/water */
  offRoad?: (x: number, z: number) => boolean;
}

export const DEFAULT_PREDICT: PredictOptions = { horizon: 2.5, sampleEvery: 0.05, step: DT, cacheGround: true };

/** recorded samples, structure-of-arrays, fixed capacity */
export class Trajectory {
  readonly cap: number;
  n = 0;
  /** seconds from the start of the prediction */
  t: Float32Array;
  /** CG position */
  pos: Float32Array;
  /** body orientation (x,y,z,w) */
  quat: Float32Array;
  vel: Float32Array;
  /** body slip angle |β| (rad, 0..π): angle between the nose and the direction of travel */
  slip: Float32Array;
  /** 1 = all four wheels off the ground */
  air: Uint8Array;
  /** surface under the CG */
  surface: Uint8Array;
  /** 1 = off the road */
  offRoad: Uint8Array;
  /** ground height under the CG */
  groundY: Float32Array;
  /** ground points either side of the path, half a car width out, perpendicular to the direction of travel:
   *  left x,y,z, right x,y,z */
  edge: Float32Array;
  /** body yaw: forward direction projected on the ground (x,z) */
  fwd: Float32Array;
  stop = STOP_NONE;
  /** time of the impact / rollover (s) */
  stopT = 0;
  hit = new V3();
  /** caller's tag for when the prediction started (e.g. sim tick) */
  tag = 0;
  /** horizon actually requested */
  horizon = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.t = new Float32Array(cap);
    this.pos = new Float32Array(cap * 3);
    this.quat = new Float32Array(cap * 4);
    this.vel = new Float32Array(cap * 3);
    this.slip = new Float32Array(cap);
    this.air = new Uint8Array(cap);
    this.surface = new Uint8Array(cap);
    this.offRoad = new Uint8Array(cap);
    this.groundY = new Float32Array(cap);
    this.edge = new Float32Array(cap * 6);
    this.fwd = new Float32Array(cap * 2);
  }

  /** linear interpolation of the CG position at time t → out */
  posAt(t: number, out: V3) {
    const n = this.n;
    if (n === 0) return out.set(0, 0, 0);
    let i = 0;
    while (i < n - 1 && this.t[i + 1] < t) i++;
    if (i >= n - 1) return out.set(this.pos[(n - 1) * 3], this.pos[(n - 1) * 3 + 1], this.pos[(n - 1) * 3 + 2]);
    const a = this.t[i], b = this.t[i + 1], f = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0;
    const p = this.pos, j = i * 3;
    return out.set(p[j] + (p[j + 3] - p[j]) * f, p[j + 1] + (p[j + 4] - p[j + 1]) * f, p[j + 2] + (p[j + 5] - p[j + 2]) * f);
  }
}

// flat Float32 layout for handing a trajectory across a worker boundary (transferable, no per-message allocation)
const PACK_HEAD = 8;
const PACK_STRIDE = 24;
export const packedSize = (cap: number) => PACK_HEAD + cap * PACK_STRIDE;

export function packTrajectory(tr: Trajectory, out: Float32Array) {
  const n = Math.min(tr.n, Math.floor((out.length - PACK_HEAD) / PACK_STRIDE));
  out[0] = n; out[1] = tr.stop; out[2] = tr.stopT; out[3] = tr.hit.x; out[4] = tr.hit.y; out[5] = tr.hit.z; out[6] = tr.tag; out[7] = tr.horizon;
  for (let i = 0; i < n; i++) {
    let o = PACK_HEAD + i * PACK_STRIDE;
    out[o++] = tr.t[i];
    for (let k = 0; k < 3; k++) out[o++] = tr.pos[i * 3 + k];
    for (let k = 0; k < 4; k++) out[o++] = tr.quat[i * 4 + k];
    for (let k = 0; k < 3; k++) out[o++] = tr.vel[i * 3 + k];
    out[o++] = tr.slip[i]; out[o++] = tr.air[i]; out[o++] = tr.surface[i]; out[o++] = tr.offRoad[i]; out[o++] = tr.groundY[i];
    for (let k = 0; k < 6; k++) out[o++] = tr.edge[i * 6 + k];
    out[o++] = tr.fwd[i * 2]; out[o++] = tr.fwd[i * 2 + 1];
  }
  return out;
}

export function unpackTrajectory(src: Float32Array, tr: Trajectory) {
  const n = Math.min(tr.cap, src[0] | 0);
  tr.n = n; tr.stop = src[1]; tr.stopT = src[2]; tr.hit.set(src[3], src[4], src[5]); tr.tag = src[6]; tr.horizon = src[7];
  for (let i = 0; i < n; i++) {
    let o = PACK_HEAD + i * PACK_STRIDE;
    tr.t[i] = src[o++];
    for (let k = 0; k < 3; k++) tr.pos[i * 3 + k] = src[o++];
    for (let k = 0; k < 4; k++) tr.quat[i * 4 + k] = src[o++];
    for (let k = 0; k < 3; k++) tr.vel[i * 3 + k] = src[o++];
    tr.slip[i] = src[o++]; tr.air[i] = src[o++]; tr.surface[i] = src[o++]; tr.offRoad[i] = src[o++]; tr.groundY[i] = src[o++];
    for (let k = 0; k < 6; k++) tr.edge[i * 6 + k] = src[o++];
    tr.fwd[i * 2] = src[o++]; tr.fwd[i * 2 + 1] = src[o++];
  }
  return tr;
}

// ---------------------------------------------------------------------------------------------------------------
// state cloning

const SKIP_KEYS = new Set(['spec']);

function isPlainish(o: object) {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}

/**
 * Copy every mutable field of `s` into `d` (same class), recursing into owned sub-objects. Numbers/booleans/strings are
 * assigned, V3/Quat/typed arrays copied in place, arrays and plain objects recursed. Functions are left alone (the
 * destination keeps its own, bound to itself). An object the destination lacks is cloned when it is plain data; any
 * other class instance is shared by reference and its key recorded in `aliased`. Allocation-free once the destination
 * has all its sub-objects (no path strings are built).
 */
export function copyState(d: object, s: object, aliased: string[] | null = null, depth = 0): string[] | null {
  const D = d as Record<string, unknown>, S = s as Record<string, unknown>;
  for (const k in S) {
    if (depth === 0 && SKIP_KEYS.has(k)) continue;
    const sv = S[k];
    if (typeof sv === 'function') continue;
    if (sv === null || typeof sv !== 'object') { D[k] = sv; continue; }
    let dv = D[k];
    if (dv === sv) continue;
    if (dv === null || dv === undefined || typeof dv !== 'object') {
      if (sv instanceof V3) dv = new V3();
      else if (sv instanceof Quat) dv = new Quat();
      else if (Array.isArray(sv)) dv = [];
      else if (ArrayBuffer.isView(sv)) dv = new (sv.constructor as new (n: number) => ArrayLike<number>)((sv as unknown as ArrayLike<number>).length);
      else if (isPlainish(sv)) dv = {};
      else { D[k] = sv; aliased?.push(k); continue; }
      D[k] = dv;
    }
    if (sv instanceof V3 || sv instanceof Quat) (dv as V3).copy(sv as V3);
    else if (ArrayBuffer.isView(sv)) (dv as Float64Array).set(sv as Float64Array);
    else if (Array.isArray(sv)) {
      const da = dv as unknown[];
      if (da.length !== sv.length) da.length = sv.length;
      for (let i = 0; i < sv.length; i++) {
        const e = sv[i];
        if (e === null || typeof e !== 'object') da[i] = e;
        else {
          if (da[i] === null || typeof da[i] !== 'object') da[i] = e instanceof V3 ? new V3() : Array.isArray(e) ? [] : {};
          if (e instanceof V3 || e instanceof Quat) (da[i] as V3).copy(e as V3);
          else copyState(da[i] as object, e as object, aliased, depth + 1);
        }
      }
    } else if (depth < 4) copyState(dv as object, sv as object, aliased, depth + 1);
  }
  return aliased;
}

// ---------------------------------------------------------------------------------------------------------------
// ground memo

/** Bilinear memo of another ground's height field on a fixed grid (direct-mapped hash table, bounded memory). */
export class CachedGround implements Ground {
  private readonly size: number;
  private readonly mask: number;
  private kx: Int32Array; private kz: Int32Array; private hv: Float64Array;
  private sx: Int32Array; private sz: Int32Array; private sv: Uint8Array;
  private readonly inv: number;
  private readonly sInv = 1 / 0.5;
  /** height evaluations of the underlying ground (misses) since construction */
  misses = 0;

  constructor(readonly src: Ground, readonly cell = 0.25, bits = 17) {
    this.size = 1 << bits;
    this.mask = this.size - 1;
    this.kx = new Int32Array(this.size).fill(-0x7fffffff); this.kz = new Int32Array(this.size); this.hv = new Float64Array(this.size);
    this.sx = new Int32Array(this.size >> 2).fill(-0x7fffffff); this.sz = new Int32Array(this.size >> 2); this.sv = new Uint8Array(this.size >> 2);
    this.inv = 1 / cell;
  }

  private node(ix: number, iz: number) {
    const i = (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) & this.mask;
    if (this.kx[i] === ix && this.kz[i] === iz) return this.hv[i];
    const h = this.src.height(ix * this.cell, iz * this.cell);
    this.misses++;
    this.kx[i] = ix; this.kz[i] = iz; this.hv[i] = h;
    return h;
  }

  height(x: number, z: number) {
    const fx = x * this.inv, fz = z * this.inv;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = this.node(ix, iz), h10 = this.node(ix + 1, iz), h01 = this.node(ix, iz + 1), h11 = this.node(ix + 1, iz + 1);
    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  normal(x: number, z: number, out: V3) {
    const e = 0.2;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  surface(x: number, z: number): Surface {
    const ix = Math.round(x * this.sInv), iz = Math.round(z * this.sInv);
    const m = this.mask >> 2;
    const i = (Math.imul(ix, 83492791) ^ Math.imul(iz, 2654435761 | 0)) & m;
    if (this.sx[i] === ix && this.sz[i] === iz) return this.sv[i] as Surface;
    const s = this.src.surface(ix / this.sInv, iz / this.sInv);
    this.sx[i] = ix; this.sz[i] = iz; this.sv[i] = s;
    return s;
  }

  obstaclesNear(x: number, z: number, r: number, visit: (o: Obstacle) => void) { this.src.obstaclesNear(x, z, r, visit); }
}

/** off-road test for a stage: CG beyond the shoulder (into the ditch or further) */
export function stageOffRoad(terrain: { nearest(x: number, z: number, out?: { found: boolean; d: number; i: number; s: number; h: number }): { found: boolean; d: number }; edge1: number }) {
  const q = { found: false, d: 0, i: 0, s: 0, h: 0 };
  const lim = terrain.edge1 + 0.2;
  return (x: number, z: number) => { const r = terrain.nearest(x, z, q); return !r.found || Math.abs(r.d) > lim; };
}

const OFF_SURFACES = new Set<number>([Surface.Grass, Surface.Mud, Surface.Water, Surface.Snow]);

// ---------------------------------------------------------------------------------------------------------------

export class Predictor {
  readonly shadow: Car;
  readonly ground: Ground;
  opts: PredictOptions;
  /** latest completed prediction */
  result: Trajectory;
  private work: Trajectory;
  private inp: DriverInput = emptyInput();
  private running = false;
  private stepIdx = 0;
  private nSteps = 0;
  private perSample = 1;
  /** fields of Car that could only be shared by reference during cloning (should stay empty) */
  aliased: string[] = [];
  /** completed predictions */
  count = 0;
  // scratch
  private up = new V3(); private fw = new V3(); private rt = new V3(); private tmp = new V3();
  private hitBest = Infinity;
  private prevHVel = 0;
  private readonly visitObstacle = (o: Obstacle) => {
    const c = this.shadow.pos;
    const dx = c.x - o.x, dz = c.z - o.z;
    const d = Math.hypot(dx, dz);
    const gap = d - o.r;
    if (gap < this.hitBest && d > 1e-6) {
      this.hitBest = gap;
      const y = o.kind === 'cyl' ? Math.min(Math.max(c.y, o.y), o.y + o.h) : o.y;
      this.work.hit.set(o.x + (dx / d) * o.r, y, o.z + (dz / d) * o.r);
    }
  };

  constructor(real: Car, ground: Ground, opts: Partial<PredictOptions> = {}) {
    this.opts = { ...DEFAULT_PREDICT, ...opts };
    this.shadow = new Car(real.spec);
    this.ground = this.opts.cacheGround ? new CachedGround(ground) : ground;
    const cap = Math.ceil(4.2 / Math.max(0.02, this.opts.sampleEvery)) + 4;
    this.result = new Trajectory(cap);
    this.work = new Trajectory(cap);
  }

  get busy() { return this.running; }

  /** start a prediction from the real car's current state, holding `input` */
  begin(real: Car, input: DriverInput, tag = 0) {
    if (real.spec !== this.shadow.spec) throw new Error('Predictor: car spec changed; build a new predictor');
    this.aliased.length = 0;
    copyState(this.shadow, real, this.aliased);
    const I = this.inp;
    I.steer = input.steer; I.throttle = input.throttle; I.brake = input.brake; I.handbrake = input.handbrake;
    I.shiftUp = input.shiftUp; I.shiftDown = input.shiftDown; I.digital = input.digital;
    const o = this.opts;
    const horizon = Math.min(4, Math.max(0.5, o.horizon));
    this.nSteps = Math.round(horizon / o.step);
    this.perSample = Math.max(1, Math.round(o.sampleEvery / o.step));
    this.stepIdx = 0;
    const w = this.work;
    w.n = 0; w.stop = STOP_NONE; w.stopT = 0; w.tag = tag; w.horizon = horizon;
    this.prevHVel = Math.hypot(real.vel.x, real.vel.z);
    this.record(0);
    this.running = true;
  }

  /** advance up to maxSteps sim steps; returns true when this call finished the prediction (result swapped in) */
  advance(maxSteps: number): boolean {
    if (!this.running) return false;
    const car = this.shadow, dt = this.opts.step, w = this.work;
    let left = maxSteps;
    while (left-- > 0 && this.stepIdx < this.nSteps) {
      car.step(this.inp, this.ground, dt);
      this.stepIdx++;
      const t = this.stepIdx * dt;
      // impact: an obstacle hit, or the body digging into the ground hard enough to stop the car (bank, ditch wall)
      const e = car.events;
      const hv = Math.hypot(car.vel.x, car.vel.z);
      const decel = (this.prevHVel - hv) / dt;
      this.prevHVel = hv;
      let stop = STOP_NONE;
      if (e.obstacleHit > 1.0) {
        stop = STOP_IMPACT;
        this.hitBest = Infinity;
        w.hit.copy(car.pos);
        this.ground.obstaclesNear(car.pos.x, car.pos.z, 4, this.visitObstacle);
      } else if (e.bodyHit > 2.5 && decel > 25) {
        stop = STOP_IMPACT;
        // leading point of the body along the direction of travel, on the ground
        const s = Math.max(1e-6, hv), L = car.spec.dims.length / 2;
        const x = car.pos.x + (car.vel.x / s) * L, z = car.pos.z + (car.vel.z / s) * L;
        w.hit.set(x, this.ground.height(x, z) + 0.4, z);
      } else {
        car.quat.rotate(this.tmp.set(0, 1, 0), this.up);
        if (this.up.y < 0.2) { stop = STOP_ROLLOVER; w.hit.copy(car.pos); }
      }
      if (stop !== STOP_NONE) {
        w.stop = stop; w.stopT = t;
        this.record(t);
        this.stepIdx = this.nSteps;
        break;
      }
      if (this.stepIdx % this.perSample === 0 || this.stepIdx === this.nSteps) this.record(t);
    }
    if (this.stepIdx >= this.nSteps) {
      this.running = false;
      const r = this.result; this.result = this.work; this.work = r;
      this.count++;
      return true;
    }
    return false;
  }

  /** synchronous full prediction (tests, tools) */
  run(real: Car, input: DriverInput, tag = 0): Trajectory {
    this.begin(real, input, tag);
    while (!this.advance(1 << 20));
    return this.result;
  }

  private record(t: number) {
    const w = this.work;
    if (w.n >= w.cap) return;
    const car = this.shadow, i = w.n++;
    w.t[i] = t;
    w.pos[i * 3] = car.pos.x; w.pos[i * 3 + 1] = car.pos.y; w.pos[i * 3 + 2] = car.pos.z;
    w.quat[i * 4] = car.quat.x; w.quat[i * 4 + 1] = car.quat.y; w.quat[i * 4 + 2] = car.quat.z; w.quat[i * 4 + 3] = car.quat.w;
    w.vel[i * 3] = car.vel.x; w.vel[i * 3 + 1] = car.vel.y; w.vel[i * 3 + 2] = car.vel.z;
    const fw = car.quat.rotate(this.tmp.set(0, 0, -1), this.fw);
    const rt = car.quat.rotate(this.tmp.set(1, 0, 0), this.rt);
    const sp = car.vel.len();
    const vf = car.vel.dot(fw), vl = car.vel.dot(rt);
    w.slip[i] = sp > 3 ? Math.atan2(Math.abs(vl), vf) : 0;
    w.air[i] = car.groundedCount === 0 ? 1 : 0;
    const g = this.ground;
    const x = car.pos.x, z = car.pos.z;
    const surf = g.surface(x, z);
    w.surface[i] = surf;
    w.offRoad[i] = (this.opts.offRoad ? this.opts.offRoad(x, z) : OFF_SURFACES.has(surf)) ? 1 : 0;
    w.groundY[i] = g.height(x, z);
    // heading on the ground
    let hx = fw.x, hz = fw.z, hl = Math.hypot(hx, hz);
    if (hl < 1e-6) { hx = 0; hz = -1; hl = 1; }
    w.fwd[i * 2] = hx / hl; w.fwd[i * 2 + 1] = hz / hl;
    // band edges: perpendicular to the direction of travel (heading when crawling)
    let tx = car.vel.x, tz = car.vel.z, tl = Math.hypot(tx, tz);
    if (tl < 1.0) { tx = hx; tz = hz; tl = hl; }
    tx /= tl; tz /= tl;
    const half = car.spec.dims.width * 0.5;
    const lx = x + tz * half, lz = z - tx * half; // left = −right, right = (−tz, tx)
    const rx = x - tz * half, rz = z + tx * half;
    const e = w.edge, j = i * 6;
    e[j] = lx; e[j + 1] = g.height(lx, lz); e[j + 2] = lz;
    e[j + 3] = rx; e[j + 4] = g.height(rx, rz); e[j + 5] = rz;
  }
}
