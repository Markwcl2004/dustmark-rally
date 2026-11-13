// Replay: the run's car poses recorded at 60 Hz (every second sim tick) and played back through the same StageView,
// with the engine telemetry (rpm, load, throttle, boost, shift cut / limiter) so the replay has sound.
// Memory ≈ 55 floats × 60 Hz → ≈ 13 KB/s (≈ 2.7 MB for a 3:20 stage); kept only for the last run, never saved
// (the ghost car is a separate 10 Hz pose track, src/sim/rally/ghost.ts).
import * as THREE from 'three';
import type { CarPose } from '../render/view';
import type { EngineState } from '../audio/dsp/engine';
import type { RoadState } from '../audio/telemetry';
import { SURFACES } from '../data/surfaces';

const F = 55; // floats per frame: 0–4 t s kmh rpm gear · 5–14 pose · 15–50 wheels · 51–54 engine sound
const HZ = 60;

export class ReplayRecorder {
  data = new Float32Array(F * HZ * 240);
  n = 0;
  private tick = 0;

  /** call every sim tick with the current pose; records every second tick */
  push(t: number, s: number, kmh: number, rpm: number, gear: number, p: CarPose, e?: EngineState) {
    if (this.tick++ % 2) return;
    if ((this.n + 1) * F > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    const o = this.n * F, d = this.data;
    d[o] = t; d[o + 1] = s; d[o + 2] = kmh; d[o + 3] = rpm; d[o + 4] = gear;
    d[o + 5] = p.pos.x; d[o + 6] = p.pos.y; d[o + 7] = p.pos.z;
    d[o + 8] = p.quat.x; d[o + 9] = p.quat.y; d[o + 10] = p.quat.z; d[o + 11] = p.quat.w;
    d[o + 12] = p.vel.x; d[o + 13] = p.vel.y; d[o + 14] = p.vel.z;
    for (let i = 0; i < 4; i++) {
      const w = p.wheels[i], k = o + 15 + i * 9;
      d[k] = w.ext; d[k + 1] = w.steer; d[k + 2] = w.spin; d[k + 3] = w.grounded ? 1 : 0; d[k + 4] = w.slide; d[k + 5] = w.surface;
      d[k + 6] = w.contact.x; d[k + 7] = w.contact.y; d[k + 8] = w.contact.z;
    }
    if (e) { d[o + 51] = e.load; d[o + 52] = e.throttle; d[o + 53] = e.boost; d[o + 54] = (e.shiftCut ? 1 : 0) | (e.limiter ? 2 : 0); }
    this.n++;
  }

  reset() { this.n = 0; this.tick = 0; }
  get t0() { return this.n ? this.data[0] : 0; }
  get t1() { return this.n ? this.data[(this.n - 1) * F] : 0; }
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();

/** interpolated pose at replay time t (stage time) into `out`; returns the frame's telemetry */
export function replayPose(r: ReplayRecorder, t: number, out: CarPose) {
  const d = r.data, n = r.n;
  if (!n) return { s: 0, kmh: 0, rpm: 0, gear: 1, t, frame: 0, u: 0 };
  // frames are evenly spaced in sim ticks → direct index
  const t0 = d[0], dt = n > 1 ? (d[(n - 1) * F] - t0) / (n - 1) : 1;
  const f = Math.max(0, Math.min(n - 1.0001, (t - t0) / dt));
  const i = Math.floor(f), u = f - i, a = i * F, b = Math.min(n - 1, i + 1) * F;
  const L = (k: number) => d[a + k] + (d[b + k] - d[a + k]) * u;
  out.pos.set(L(5), L(6), L(7));
  qa.set(d[a + 8], d[a + 9], d[a + 10], d[a + 11]); qb.set(d[b + 8], d[b + 9], d[b + 10], d[b + 11]);
  out.quat.slerpQuaternions(qa, qb, u);
  out.vel.set(L(12), L(13), L(14));
  for (let w = 0; w < 4; w++) {
    const o = out.wheels[w], k = 15 + w * 9;
    o.ext = L(k); o.steer = L(k + 1); o.spin = L(k + 2); o.grounded = d[b + k + 3] > 0.5; o.slide = d[b + k + 4]; o.surface = d[b + k + 5];
    o.contact.set(L(k + 6), L(k + 7), L(k + 8));
  }
  return { s: L(1), kmh: L(2), rpm: L(3), gear: d[a + 4], t, frame: a, u };
}

/** engine + road sound input of the replay at the frame replayPose just returned (sound follows the recording) */
export function replaySound(r: ReplayRecorder, at: { frame: number; u: number; rpm: number; kmh: number }, pose: CarPose, redline: number, es: EngineState, rs: RoadState) {
  const d = r.data, a = at.frame, b = Math.min((r.n - 1) * F, a + F);
  const L = (k: number) => d[a + k] + (d[b + k] - d[a + k]) * at.u;
  es.rpm = at.rpm; es.load = L(51); es.throttle = L(52); es.boost = L(53);
  const fl = d[a + 54];
  es.shiftCut = (fl & 1) !== 0; es.limiter = (fl & 2) !== 0;
  es.speed = at.kmh / 3.6; es.redline = redline;
  rs.speed = at.kmh / 3.6;
  rs.surfMix.fill(0);
  let g = 0, slide = 0, loose = 0;
  for (const w of pose.wheels) { if (!w.grounded) continue; g++; rs.surfMix[w.surface] += 0.25; slide += w.slide; loose += (SURFACES[w.surface]?.loose ?? 0) * 0.25; }
  rs.grounded = g; rs.slide = slide; rs.loose = loose;
  return { es, rs };
}

export type ReplayCam = 'tv' | 'far' | 'heli';
export const REPLAY_CAMS: ReplayCam[] = ['tv', 'far', 'heli'];
export const REPLAY_CAM_CN: Record<ReplayCam, string> = { tv: '电视机位', far: '追尾', heli: '直升机' };
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];

/** playback clock: pause, speed, seek */
export class ReplayClock {
  t: number;
  speed = 1;
  paused = false;
  cam: ReplayCam = 'tv';
  constructor(readonly t0: number, readonly t1: number) { this.t = t0; }
  advance(dt: number) {
    if (this.paused) return;
    this.t += dt * this.speed;
    if (this.t >= this.t1) { this.t = this.t1; this.paused = true; }
  }
  seek(t: number) { this.t = Math.max(this.t0, Math.min(this.t1, t)); }
  get frac() { return (this.t - this.t0) / Math.max(1e-6, this.t1 - this.t0); }
  faster(dir: 1 | -1) { const i = REPLAY_SPEEDS.indexOf(this.speed); this.speed = REPLAY_SPEEDS[Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))]; }
}
