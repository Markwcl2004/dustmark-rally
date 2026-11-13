// Stage run rules: countdown, timing, progress, penalties, finish.
// Penalties (DESIGN §6 玩法 6): back on the road (R) +5 s, false start +10 s, cutting past a checkpoint +15 s.
import { Surface } from '../../data/surfaces';
import { V3 } from '../math/vec';
import type { Car } from '../vehicle/car';
import type { Stage } from '../stage/stage';

export type Phase = 'countdown' | 'running' | 'finished';

export const COUNTDOWN_S = 3;
export const RESET_PENALTY = 5;
export const FALSE_START_PENALTY = 10;
export const CUT_PENALTY = 15;
/** a cut: leaving the road (beyond the ditch + this margin, m) and rejoining at least CUT_MIN_GAIN m further along
 *  while the car itself travelled less than CUT_PATH_RATIO of that road distance (a crash excursion that comes back
 *  where it left never counts) */
export const CUT_MARGIN = 2.5;
export const CUT_MIN_GAIN = 30;
export const CUT_PATH_RATIO = 0.6;
const UP = new V3(0, 1, 0);

export type PenaltyKind = 'reset' | 'falsestart' | 'cut';
export interface PenaltyEvent { kind: PenaltyKind; sec: number; at: number }

export class Session {
  phase: Phase = 'countdown';
  /** ticks since session start (including countdown) */
  ticks = 0;
  /** stage time in seconds (0 at the green light) */
  time = -COUNTDOWN_S;
  finishTime = 0;
  penalties = 0;
  resets = 0;
  falseStart = false;
  cuts = 0;
  /** penalties as they happen (the game drains this for the HUD pop-ups) */
  events: PenaltyEvent[] = [];
  /** every penalty of the run (not drained) */
  log: PenaltyEvent[] = [];
  progressS: number;
  maxProgressS: number;
  topSpeed = 0;
  /** obstacle impacts above 3 m/s and hard landings (accident counters) */
  impacts = 0;
  rollovers = 0;
  offRoadTime = 0;
  private flipTimer = 0;
  private tmp = new V3();
  // cut detection
  private offTrack = false;
  private exitS = 0;
  private offPath = 0;
  private lastX = 0;
  private lastZ = 0;

  constructor(readonly stage: Stage) {
    this.progressS = stage.startS;
    this.maxProgressS = stage.startS;
  }

  get progress() { return Math.min(1, Math.max(0, (this.maxProgressS - this.stage.startS) / this.stage.length)); }
  get total() { return (this.phase === 'finished' ? this.finishTime : Math.max(0, this.time)) + this.penalties; }

  private penalise(kind: PenaltyKind, sec: number) {
    this.penalties += sec;
    const e = { kind, sec, at: this.time };
    this.events.push(e);
    this.log.push(e);
  }

  update(car: Car, dt: number) {
    this.ticks++;
    this.time += dt;
    if (this.phase === 'countdown' && this.time >= 0) this.phase = 'running';
    const tr = this.stage.trackS(car.pos.x, car.pos.z, this.progressS);
    this.progressS = tr.s;
    if (tr.dist < 30) this.maxProgressS = Math.max(this.maxProgressS, Math.min(tr.s, this.maxProgressS + 60));
    const edge2 = this.stage.terrain.edge2;
    if (tr.dist > edge2) this.offRoadTime += dt;
    // false start: across the start line before the green light (only possible when the car is not held on the line)
    if (this.phase === 'countdown' && !this.falseStart && this.progressS > this.stage.startS + 0.3) {
      this.falseStart = true;
      this.penalise('falsestart', FALSE_START_PENALTY);
    }
    if (this.phase === 'running') {
      this.topSpeed = Math.max(this.topSpeed, car.speed);
      if (car.events.obstacleHit > 3) this.impacts++;
      this.trackCut(car, tr.dist, edge2);
      if (this.progressS >= this.stage.finishS && tr.dist < 20) {
        this.phase = 'finished';
        this.finishTime = this.time;
      }
    }
    // upside-down detection (counts once per event)
    const upY = car.quat.rotate(UP, this.tmp).y;
    if (upY < 0.2) { if (this.flipTimer === 0) this.rollovers++; this.flipTimer += dt; } else this.flipTimer = 0;
  }

  private trackCut(car: Car, dist: number, edge2: number) {
    const x = car.pos.x, z = car.pos.z;
    if (!this.offTrack) {
      if (dist > edge2 + CUT_MARGIN) { this.offTrack = true; this.exitS = this.progressS; this.offPath = 0; this.lastX = x; this.lastZ = z; }
      return;
    }
    this.offPath += Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x; this.lastZ = z;
    if (dist < edge2) {
      this.offTrack = false;
      const gain = this.progressS - this.exitS;
      if (gain > CUT_MIN_GAIN && this.offPath < gain * CUT_PATH_RATIO) { this.cuts++; this.penalise('cut', CUT_PENALTY); }
    }
  }

  /** time spent upside-down in the current event */
  get flippedFor() { return this.flipTimer; }

  /** R: put the car back on the road at the current progress (or where it left the road, if it is out there), +5 s */
  resetCar(car: Car) {
    let at = this.progressS;
    if (this.offTrack) { at = Math.min(at, this.exitS); this.offTrack = false; this.progressS = at; }
    let s = Math.max(this.stage.startS - 20, Math.min(at, this.stage.cl.length - 40));
    // (手感重做) not back onto the same patch of ice or a steep pitch: look up to 60 m back for road that isn't ice and
    // climbs under 6 %, and set the car down rolling at walking pace so it can get going
    const st = this.stage, grade = (q: number) => Math.abs(st.terrain.profAt(q + 2) - st.terrain.profAt(q - 2)) / 4;
    for (let back = 0; back <= 60; back += 4) {
      const q = Math.max(st.startS - 20, s - back), pq = st.pointAt(q);
      if (st.surface(pq.x, pq.z) !== Surface.Ice && grade(q) < 0.06) { s = q; break; }
    }
    const p = this.stage.pointAt(s);
    car.reset(this.stage, p.x, p.z, p.dx, p.dz);
    if (this.phase === 'running') {
      const v = 2.5;
      car.vel.set(p.dx * v, 0, p.dz * v);
      for (const w of car.wheels) w.omega = v / car.spec.wheel.radius;
    }
    if (this.phase === 'running') { this.penalise('reset', RESET_PENALTY); this.resets++; }
    this.flipTimer = 0;
  }
}
