// Handling acceptance probes (DESIGN.md §4 手感验收). Pure sim; run by scripts/probe.ts and tests.
import type { CarSpec } from '../../data/cars';
import { Surface } from '../../data/surfaces';
import { TestGround } from '../ground';
import { V3, clamp } from '../math/vec';
import { Car, DT } from './car';
import { assistsFor, emptyInput, type AssistLevel, type DriverInput } from './controls';
import { KeyHand, type Intent } from '../driver/keys';
import { noise2 } from '../math/rng';

export interface ProbeResult { name: string; pass: boolean; summary: string; data: Record<string, number | string | boolean> }

const KMH = 3.6;

function makeCar(spec: CarSpec, ground: TestGround, x = 0, z = 0, dx = 0, dz = -1) {
  const car = new Car(spec);
  car.assists = assistsFor(probeAssist);
  car.reset(ground, x, z, dx, dz);
  // settle
  const inp = emptyInput();
  for (let i = 0; i < 120; i++) car.step(inp, ground);
  return car;
}

/** set the car rolling forward at v (m/s) without wheel slip */
function launchAt(car: Car, v: number) {
  const fwd = car.quat.rotate(new V3(0, 0, -1), new V3());
  car.vel.copy(fwd).scale(v);
  for (const w of car.wheels) w.omega = v / car.spec.wheel.radius;
  // pick a sensible gear
  const gb = car.spec.gearbox;
  for (let g = 1; g <= gb.ratios.length; g++) {
    car.gear = g; car.pendingGear = g;
    const rpm = (v / car.spec.wheel.radius) * car.gearRatio(g) * 60 / (2 * Math.PI);
    if (rpm < gb.upRpm - 500) break;
  }
}

function heading(car: Car) {
  const f = car.quat.rotate(new V3(0, 0, -1), new V3());
  return Math.atan2(f.x, -f.z);
}
function upY(car: Car) { return car.quat.rotate(new V3(0, 1, 0), new V3()).y; }
function pitchDeg(car: Car) { const f = car.quat.rotate(new V3(0, 0, -1), new V3()); return Math.asin(clamp(f.y, -1, 1)) * 180 / Math.PI; }
function slipDeg(car: Car) {
  const f = car.quat.rotate(new V3(0, 0, -1), new V3()), r = car.quat.rotate(new V3(1, 0, 0), new V3());
  const vf = car.vel.dot(f), vr = car.vel.dot(r);
  return car.vel.len() > 3 ? Math.atan2(vr, Math.abs(vf)) * 180 / Math.PI : 0;
}

/** assist level the probes run with (scripts/probe --assist) */
let probeAssist: AssistLevel = 'standard';
export function setProbeAssist(a: AssistLevel) { probeAssist = a; }

export function probeIdle(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = new Car(spec);
  car.reset(g, 0, 0, 0, -1);
  const inp = emptyInput();
  for (let i = 0; i < 240; i++) car.step(inp, g); // settle 2 s
  const p0 = car.pos.clone();
  let maxV = 0, maxW = 0;
  for (let i = 0; i < 600; i++) {
    car.step(inp, g);
    maxV = Math.max(maxV, car.vel.len()); maxW = Math.max(maxW, car.angVel.len());
  }
  const drift = Math.hypot(car.pos.x - p0.x, car.pos.z - p0.z);
  // slope hold: 12% side + 15% forward
  const gs = new TestGround(Surface.Gravel, (x, z) => 0.12 * x + 0.15 * z);
  const c2 = new Car(spec); c2.reset(gs, 0, 0, 0, -1);
  for (let i = 0; i < 240; i++) c2.step(inp, gs);
  const q0 = c2.pos.clone();
  for (let i = 0; i < 600; i++) c2.step(inp, gs);
  const slopeDrift = Math.hypot(c2.pos.x - q0.x, c2.pos.z - q0.z);
  const pass = maxV < 0.01 && drift < 0.01 && slopeDrift < 0.05;
  return { name: 'idle', pass, summary: `静止 5 s：最大速度 ${(maxV * 1000).toFixed(2)} mm/s，水平漂移 ${(drift * 1000).toFixed(2)} mm；12%/15% 坡上 5 s 漂移 ${(slopeDrift * 1000).toFixed(1)} mm`, data: { maxVmm: maxV * 1000, maxWmrad: maxW * 1000, driftMm: drift * 1000, slopeDriftMm: slopeDrift * 1000 } };
}

export function probeAccel(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  const inp: DriverInput = { ...emptyInput(), throttle: 1 };
  let t = 0, t100 = -1, vmax = 0, tTop = 0;
  for (let i = 0; i < 120 * 90; i++) {
    car.step(inp, g); t += DT;
    const v = car.fwdSpeed * KMH;
    if (t100 < 0 && v >= 100) t100 = t;
    if (v > vmax + 0.05) { vmax = v; tTop = t; }
  }
  const e0 = Math.abs(t100 - spec.target.zeroTo100) / spec.target.zeroTo100;
  const e1 = Math.abs(vmax - spec.target.topKmh) / spec.target.topKmh;
  return { name: 'accel', pass: t100 > 0 && e0 <= 0.1 && e1 <= 0.1, summary: `砂石 0–100 ${t100.toFixed(2)} s（目标 ${spec.target.zeroTo100}，误差 ${(e0 * 100).toFixed(0)}%）；极速 ${vmax.toFixed(0)} km/h @${tTop.toFixed(0)} s（目标 ${spec.target.topKmh}，误差 ${(e1 * 100).toFixed(0)}%）`, data: { zeroTo100: t100, topKmh: vmax } };
}

export function probeBrake(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, 100 / KMH);
  for (let i = 0; i < 12; i++) car.step({ ...emptyInput(), throttle: 0.3 }, g);
  launchAt(car, 100 / KMH);
  const p0 = car.pos.clone();
  const inp: DriverInput = { ...emptyInput(), brake: 1 };
  let t = 0, maxYaw = 0;
  while (car.fwdSpeed > 0.05 && t < 20) { car.step(inp, g); t += DT; maxYaw = Math.max(maxYaw, Math.abs(heading(car))); }
  const d = Math.hypot(car.pos.x - p0.x, car.pos.z - p0.z);
  // 手感重做: gravel μ 1.05 with 0.83 of it in line (traction / braking) → ideal ≈ 45 m; ABS on a 0/1 pedal ≈ 85–95 %
  return { name: 'brake', pass: d >= 42 && d <= 56, summary: `砂石 100→0 刹车距离 ${d.toFixed(1)} m（目标 42–56），用时 ${t.toFixed(2)} s，航向偏移 ${(maxYaw * 180 / Math.PI).toFixed(1)}°`, data: { distance: d, time: t } };
}

export function probeDrift(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, 80 / KMH);
  // short steady run
  for (let i = 0; i < 30; i++) car.step({ ...emptyInput(), throttle: 0.35 }, g);
  // lift and turn in hard (keyboard-style full right), with a short flick left first (Scandinavian flick)
  let maxSlip = 0, t = 0;
  const flick: DriverInput = { ...emptyInput(), steer: -0.6 };
  for (let i = 0; i < 30; i++) { car.step(flick, g); t += DT; }
  const turn: DriverInput = { ...emptyInput(), steer: 1 };
  for (let i = 0; i < 120 * 1.6; i++) { car.step(turn, g); t += DT; maxSlip = Math.max(maxSlip, Math.abs(slipDeg(car))); if (maxSlip > 28) break; }
  const slipAtCatch = Math.abs(slipDeg(car));
  // recover: full throttle, counter-steer (player steers straight-ish; assist adds the opposite lock)
  let tRec = -1, tt = 0;
  for (let i = 0; i < 120 * 5; i++) {
    const s = slipDeg(car);
    car.step({ ...emptyInput(), throttle: 1, steer: clamp(s / 20, -1, 1) }, g);
    tt += DT;
    if (Math.abs(slipDeg(car)) < 5 && tRec < 0) { tRec = tt; break; }
  }
  const pass = maxSlip > 20 && tRec > 0 && tRec <= 3 && upY(car) > 0.8;
  return { name: 'drift', pass, summary: `80 km/h 松油门甩尾：最大滑移角 ${maxSlip.toFixed(1)}°（目标 >20°）；全油门反打从 ${slipAtCatch.toFixed(0)}° 救回到 <5° 用 ${tRec < 0 ? '未救回' : tRec.toFixed(2) + ' s'}（目标 ≤3 s）`, data: { maxSlipDeg: maxSlip, recoverS: tRec } };
}

export function probeHandbrake(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, 40 / KMH);
  for (let i = 0; i < 20; i++) car.step({ ...emptyInput(), throttle: 0.3 }, g);
  const h0 = heading(car);
  const f0 = car.quat.rotate(new V3(0, 0, -1), new V3());
  const p0 = car.pos.clone();
  let maxLat = 0, t = 0, turned = 0, maxFwd = 0;
  // steer full left + handbrake, then modest throttle to pivot
  while (t < 6) {
    const hb = t < 1.1 ? 1 : 0;
    car.step({ ...emptyInput(), steer: -1, handbrake: hb, throttle: t > 0.5 ? 0.45 : 0 }, g);
    t += DT;
    let dh = heading(car) - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    turned = Math.max(turned, Math.abs(dh));
    const rel = new V3().subOf(car.pos, p0);
    const lat = Math.abs(rel.x * f0.z - rel.z * f0.x);
    maxLat = Math.max(maxLat, lat);
    maxFwd = Math.max(maxFwd, rel.dot(f0));
    if (Math.abs(dh) > Math.PI * 0.97) break;
  }
  // turning radius ≈ half the lateral offset after ~180°
  const radius = maxLat / 2;
  const pass = turned > Math.PI * 0.95 && radius < 7;
  return { name: 'handbrake', pass, summary: `40 km/h 手刹掉头：转过 ${(turned * 180 / Math.PI).toFixed(0)}° 用 ${t.toFixed(2)} s，半径 ≈ ${radius.toFixed(1)} m（目标 <7 m），前冲 ${maxFwd.toFixed(1)} m`, data: { radius, turnedDeg: turned * 180 / Math.PI, time: t } };
}

/** standard jump: 22 m kicker rising 1.6 m, lip, landing slope falling 3 m over 34 m */
export function jumpProfile(s: number) {
  if (s < 0 || s > 60) return 0;
  if (s < 22) { const u = s / 22; return 1.6 * u * u; }
  const u = Math.min(1, (s - 22) / 34);
  return 1.6 - 3.0 * (1 - (1 - u) * (1 - u));
}

export function probeJump(spec: CarSpec, kmh = 120): ProbeResult {
  // jump runs along -Z; flat at -1.4 after landing ramp
  const base = (s: number) => (s <= 0 ? 0 : s < 56 ? jumpProfile(s) : -1.4);
  const g = new TestGround(Surface.Gravel, (_x, z) => base(-z - 80));
  const car = makeCar(spec, g, 0, 0, 0, -1);
  launchAt(car, kmh / KMH);
  let t = 0, air = false, tookOff = -1, landed = -1, allDown = -1, airTime = 0;
  let minPitch = 0, maxPitch = 0, minUp = 1, maxRoll = 0;
  let consecutive = 0;
  for (let i = 0; i < 120 * 12; i++) {
    // hold speed on approach, then stay neutral-ish
    const thr = tookOff < 0 ? clamp((kmh / KMH - car.fwdSpeed) * 0.8, 0, 1) : 0.4;
    car.step({ ...emptyInput(), throttle: thr }, g);
    t += DT;
    if (car.groundedCount === 0) {
      if (!air && tookOff < 0) tookOff = t;
      air = true; airTime += DT;
    } else if (air) {
      air = false;
      if (landed < 0 && airTime > 0.2) landed = t;
    }
    if (tookOff >= 0) {
      const p = pitchDeg(car);
      minPitch = Math.min(minPitch, p); maxPitch = Math.max(maxPitch, p);
      const u = upY(car); minUp = Math.min(minUp, u);
      const rgt = car.quat.rotate(new V3(1, 0, 0), new V3());
      maxRoll = Math.max(maxRoll, Math.abs(Math.asin(clamp(rgt.y, -1, 1))) * 180 / Math.PI);
    }
    if (landed >= 0) {
      consecutive = car.groundedCount === 4 ? consecutive + 1 : 0;
      if (allDown < 0 && consecutive >= 24) allDown = t - 0.2 - landed;
    }
    if (landed >= 0 && t - landed > 3) break;
  }
  const settle = allDown < 0 ? 99 : Math.max(0, allDown);
  const pass = landed > 0 && settle <= 1.5 && minPitch >= -20 && maxPitch <= 20 && minUp > 0.7;
  return { name: 'jump', pass, summary: `${kmh} km/h 标准飞坡：滞空 ${airTime.toFixed(2)} s，落地后 ${settle.toFixed(2)} s 四轮稳定接地（目标 ≤1.5 s），俯仰 ${minPitch.toFixed(1)}°…${maxPitch.toFixed(1)}°（目标 ±20°），最大侧倾 ${maxRoll.toFixed(1)}°，${minUp > 0.7 ? '未翻车' : '翻车'}`, data: { airTime, settleS: settle, minPitch, maxPitch, maxRoll, rolled: minUp <= 0.7 } };
}

export function probeRollover(spec: CarSpec): ProbeResult {
  // steady-state cornering on flat gravel, increasing speed on a fixed steer: must never roll
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, 40 / KMH);
  let minUp = 1, maxRoll = 0;
  for (let i = 0; i < 120 * 20; i++) {
    car.step({ ...emptyInput(), steer: 0.6, throttle: 0.5 + 0.5 * Math.min(1, i / 1200) }, g);
    minUp = Math.min(minUp, upY(car));
    const rgt = car.quat.rotate(new V3(1, 0, 0), new V3());
    maxRoll = Math.max(maxRoll, Math.abs(Math.asin(clamp(rgt.y, -1, 1))) * 180 / Math.PI);
  }
  const flatOk = minUp > 0.85;
  // sliding sideways into an earth bank (rises 1.6 m over 1.2 m at x > 3): should roll over
  const bank = (x: number) => (x < 3 ? 0 : Math.min(1.6, (x - 3) * 1.35));
  const gb = new TestGround(Surface.Gravel, (x) => bank(x));
  const c2 = makeCar(spec, gb, -8, 0, 0, -1);
  c2.vel.set(16, 0, -2); // 58 km/h sideways
  for (const w of c2.wheels) w.omega = 2 / spec.wheel.radius;
  let minUp2 = 1;
  for (let i = 0; i < 120 * 4; i++) { c2.step(emptyInput(), gb); minUp2 = Math.min(minUp2, upY(c2)); }
  const bankRolls = minUp2 < 0.2;
  return { name: 'rollover', pass: flatOk && bankRolls, summary: `平地满舵加速绕圈 20 s 最大侧倾 ${maxRoll.toFixed(1)}°，${flatOk ? '未翻' : '翻车'}；58 km/h 横滑撞土坡：车身 up.y 最低 ${minUp2.toFixed(2)}（${bankRolls ? '翻了，符合预期' : '没翻'}）`, data: { flatMaxRollDeg: maxRoll, flatRolled: !flatOk, bankRolled: bankRolls } };
}

// ───────────────────────── keyboard probes ─────────────────────────
// Driven by 0/1 keys only. Closed-loop ones go through KeyHand (human reaction delay + key timing); scripted ones press
// keys on a timetable like a person would.

const key = (steer: number, throttle = 0, brake = 0, handbrake = 0): DriverInput => ({ ...emptyInput(), steer, throttle, brake, handbrake, digital: true });

/** pure-pursuit intent toward a lateral path x(z) for a car driving along -Z */
function pathIntent(car: Car, pathX: (z: number) => number, vWant: number, out: Intent): Intent {
  const v = Math.max(0, car.fwdSpeed);
  const L = clamp(4 + v * 0.3, 6, 18);
  const zt = car.pos.z - L;
  const tx = pathX(zt) - car.pos.x, tz = zt - car.pos.z;
  let hx = 0, hz = -1;
  const f = car.quat.rotate(new V3(0, 0, -1), new V3());
  hx = f.x; hz = f.z;
  const sp = Math.hypot(car.vel.x, car.vel.z);
  if (sp > 3 && car.fwdSpeed > 0) { hx = car.vel.x / sp; hz = car.vel.z / sp; }
  const xr = -tx * hz + tz * hx, zf = tx * hx + tz * hz;
  const d2 = Math.max(1, xr * xr + zf * zf);
  out.angle = clamp(car.slideAngle, -0.5, 0.5) + Math.atan(car.spec.wheelbase * (2 * xr) / d2);
  const err = vWant - v;
  out.throttle = clamp(err * 0.5 + 0.3, 0, 1);
  out.brake = err < -2 ? clamp(-err * 0.2, 0, 1) : 0;
  if (out.brake > 0) out.throttle = 0;
  return out;
}

/** gravel pad with cones every `gap` m along -Z at x = 0 */
function conePad(n: number, gap: number, z0: number) {
  const g = new TestGround(Surface.Gravel);
  for (let i = 0; i < n; i++) g.grid.add({ kind: 'cyl', x: 0, y: 0, z: z0 - i * gap, r: 0.15, h: 0.7 });
  return g;
}

export function slalomRun(spec: CarSpec, kmh: number, keys: boolean) {
  const gap = 30, n = 8, z0 = -60, A = 1.9;
  const g = conePad(n, gap, z0);
  const car = makeCar(spec, g);
  launchAt(car, kmh / KMH);
  if (!keys) car.assists.counterSteer = false;
  // weave: pass cone i on the left for even i, right for odd i
  const pathX = (z: number) => {
    const u = (z0 - z) / gap; // 0 at the first cone
    if (u < -2) return 0;
    if (u < 0) return -A * Math.sin(((u + 2) / 2) * Math.PI / 2);
    if (u > n - 1 + 1.5) return 0;
    return -A * Math.cos(u * Math.PI);
  };
  const hand = new KeyHand();
  const it: Intent = { angle: 0, throttle: 0, brake: 0 };
  let hits = 0, worst = 0, wrong = 0, t = 0;
  const passed = new Array(n).fill(false);
  const lim = (n - 1) * gap + 80;
  while (car.pos.z > z0 - lim && t < 30) {
    pathIntent(car, pathX, kmh / KMH, it);
    const inp = keys ? hand.drive(car, it) : { ...emptyInput(), steer: clamp(it.angle / ((spec.steer.lockDeg + (spec.steer.highSpeedDeg - spec.steer.lockDeg) * (() => { const sf = clamp((car.fwdSpeed - 4) / 36, 0, 1); return sf * sf * (3 - 2 * sf); })()) * Math.PI / 180), -1, 1), throttle: it.throttle, brake: it.brake };
    car.step(inp, g); t += DT;
    if (car.events.obstacleHit > 0.3) hits++;
    for (let i = 0; i < n; i++) {
      const cz = z0 - i * gap;
      if (!passed[i] && car.pos.z < cz) {
        passed[i] = true;
        const side = i % 2 === 0 ? -1 : 1; // even → pass on the left (x < 0)
        if (car.pos.x * side < 0.6) wrong++;
      }
    }
    if (car.pos.z < z0 + 10 && car.pos.z > z0 - (n - 1) * gap - 10) worst = Math.max(worst, Math.abs(car.pos.x - pathX(car.pos.z)));
  }
  return { clean: hits === 0 && wrong === 0 && passed.every(Boolean), hits, wrong, worst, presses: hand.presses / Math.max(t, 1) };
}

/** keyboard slalom: highest speed (km/h) that clears 8 cones 30 m apart, keys vs ideal analog */
export function probeKbSlalom(spec: CarSpec): ProbeResult {
  const best = (keys: boolean) => {
    let top = 0, worst = 0;
    for (let kmh = 40; kmh <= 100; kmh += 5) {
      const r = slalomRun(spec, kmh, keys);
      if (!r.clean) break;
      top = kmh; worst = r.worst;
    }
    return { top, worst };
  };
  const k = best(true), a = best(false);
  const pass = k.top >= 55 && k.top >= a.top - 10;
  return { name: 'kb-slalom', pass, summary: `键盘蛇形（8 桩，间距 30 m，左右 ±1.9 m）：键盘最高 ${k.top} km/h 无碰桩（该速度下最大偏离 ${k.worst.toFixed(2)} m）；理想模拟量 ${a.top} km/h（目标 键盘 ≥55 且不比模拟量低 10 以上）`, data: { kbTop: k.top, analogTop: a.top, kbWorst: k.worst } };
}

/**
 * Keyboard drift, held keys only (手感重做): 90 km/h, lift and swing left for 0.4 s, then hold right with a 0.2 s brake
 * dab (enter); keep holding right and hold the throttle for 3 s (keep: the slide settles at a steady angle, no spin,
 * no straightening by itself); let go of the steering, throttle still held (exit: back under 5°).
 */
export function probeKbDrift(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const c = makeCar(spec, g);
  launchAt(c, 90 / KMH);
  for (let i = 0; i < 30; i++) c.step(key(0, 1), g);
  for (let i = 0; i < 48; i++) c.step(key(-1), g);
  let entry = 0;
  for (let i = 0; i < 120 * 1.0; i++) { c.step(key(1, 0, i < 24 ? 1 : 0), g); entry = Math.max(entry, Math.abs(slipDeg(c))); }
  let lo = 99, hi = 0, spun = false, sum = 0, n = 0;
  for (let i = 0; i < 120 * 3; i++) {
    c.step(key(1, 1), g);
    const sd = Math.abs(slipDeg(c));
    if (sd > 80 || upY(c) < 0.7) { spun = true; break; }
    if (i >= 120) { lo = Math.min(lo, sd); hi = Math.max(hi, sd); sum += sd; n++; }
  }
  const vHold = c.fwdSpeed * KMH;
  let tRec = -1, tt = 0;
  if (!spun) for (let i = 0; i < 120 * 4; i++) { c.step(key(0, 1), g); tt += DT; if (Math.abs(slipDeg(c)) < 5) { tRec = tt; break; } }
  // (the swing here is a 0.4 s hold, not a 0.25 s tap: entry > 15° for every car; the analog lift-off probe `drift`
  // keeps DESIGN's > 20°). Keeping it on the throttle: front drive pulls straight on power — not required there
  const entryMin = 15, recMax = spec.drive === 'awd' ? 1.5 : 2.5;
  const mean = n ? sum / n : 0;
  const keep = spec.drive === 'fwd' || (mean >= 8 && lo >= 3 && hi <= 45);
  const pass = !spun && entry > entryMin && keep && tRec >= 0 && tRec <= recMax;
  return { name: 'kb-drift', pass, summary: `键盘漂移（只按住）：90 km/h 松油、左 0.4 s→按住右+点刹 0.2 s，车尾 ${entry.toFixed(1)}°（>${entryMin}°）；按住右+按住油门 3 s，后 2 s 滑移 ${lo.toFixed(0)}–${hi.toFixed(0)}°（均值 ${mean.toFixed(0)}°，目标 均值 ≥8°、不低于 3°、≤45°；前驱不要求），${spun ? '打转' : '未打转'}，${vHold.toFixed(0)} km/h；松方向+油门 ${tRec < 0 ? '未拉直' : tRec.toFixed(2) + ' s'} 回到 <5°（≤${recMax} s）`, data: { entry, holdLo: lo, holdHi: hi, holdMean: mean, spun, recoverS: tRec } };
}

/** keyboard handbrake hairpin, held keys: left + handbrake until the car has turned 90° (seen 0.2 s late), then left +
 *  throttle until 160°, then let go */
export function probeKbHandbrake(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, 45 / KMH);
  for (let i = 0; i < 20; i++) car.step(key(0, 1), g);
  const h0 = heading(car);
  const f0 = car.quat.rotate(new V3(0, 0, -1), new V3());
  const p0 = car.pos.clone();
  let t = 0, maxLat = 0, tTurn = -1, released = false, overshoot = 0, hbOff = -1, seen = -1, prevH = h0, un = 0;
  while (t < 8) {
    const h = heading(car);
    let d = h - prevH; d = Math.atan2(Math.sin(d), Math.cos(d)); prevH = h; un += d;
    const a = -un; // left turn → heading decreases
    if (seen < 0 && a > Math.PI / 2) seen = t;
    if (hbOff < 0 && seen >= 0 && t - seen >= 0.2) hbOff = t;
    if (!released && a > (160 * Math.PI) / 180) { released = true; tTurn = t; }
    if (released) overshoot = Math.max(overshoot, a - Math.PI);
    const inp = released ? key(0, 1) : hbOff < 0 ? key(-1, 0, 0, 1) : key(-1, 1);
    car.step(inp, g); t += DT;
    const rel = new V3().subOf(car.pos, p0);
    maxLat = Math.max(maxLat, Math.abs(rel.x * f0.z - rel.z * f0.x));
    if (released && t - tTurn > 1.5) break;
  }
  const radius = maxLat / 2;
  const od = (overshoot * 180) / Math.PI;
  const pass = tTurn > 0 && tTurn < 5 && radius >= 2 && radius < 8 && od < 45;
  return { name: 'kb-handbrake', pass, summary: `键盘手刹发卡（45 km/h，按住左+空格，看到转过 90° 后 0.2 s 松空格、按住左+油门）：手刹 ${hbOff < 0 ? '未松' : hbOff.toFixed(2) + ' s'}，转过 160° 用 ${tTurn < 0 ? '未完成' : tTurn.toFixed(2) + ' s'}，半径 ≈ ${radius.toFixed(1)} m（目标 2–8 m，不原地打转），松键后多转 ${od.toFixed(0)}°（<45°）`, data: { radius, timeS: tTurn, overshootDeg: od, hbS: hbOff } };
}

/** high-speed stability on keys: a single tap, a no-input run on bumpy gravel, and a closed-loop lane change */
export function probeKbLaneChange(spec: CarSpec): ProbeResult {
  const v = 150 / KMH;
  // a) one 100 ms tap at 150 km/h
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, v);
  const h0 = heading(car);
  let maxDh = 0, maxYaw = 0;
  for (let i = 0; i < 120 * 2.5; i++) {
    const tap = i >= 12 && i < 24;
    car.step(key(tap ? 1 : 0, car.fwdSpeed < v ? 1 : 0), g);
    maxDh = Math.max(maxDh, Math.abs(heading(car) - h0));
    maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
  }
  const latTap = Math.abs(car.pos.x);
  // b) 6 s no steering on stage-like gravel: the generator's ruts (2.5 cm) + two-scale roughness (3.5 cm)
  const gb = new TestGround(Surface.Gravel, (x, z) => {
    const a = Math.abs(x), sx = -z;
    const rut = -0.025 * (Math.exp(-((a - 0.8) ** 2) / 0.06) + 0.6 * Math.exp(-((a - 2.4) ** 2) / 0.08));
    return rut + 0.035 * (0.7 * noise2(sx / 6.5, x / 3.2, 11) + 0.3 * noise2(sx / 1.7, x / 1.7, 12));
  });
  const c2 = makeCar(spec, gb);
  launchAt(c2, v);
  const hb = heading(c2);
  let bumpDh = 0;
  for (let i = 0; i < 120 * 6; i++) { c2.step(key(0, c2.fwdSpeed < v ? 1 : 0), gb); bumpDh = Math.max(bumpDh, Math.abs(heading(c2) - hb)); }
  const drift = Math.abs(c2.pos.x);
  bumpDh *= 180 / Math.PI;
  // c) key-sequence lane change at a slow hand's pace: right 0.4 s, let go 0.4 s, left 0.4 s, let go — must end
  //    straight and settle
  const c3 = makeCar(spec, g);
  launchAt(c3, v);
  const h3 = heading(c3), x3 = c3.pos.x;
  let maxSlip = 0, settleT = -1, t3 = 0;
  for (let i = 0; i < 120 * 4; i++) {
    const st = t3 < 0.4 ? 1 : t3 < 0.8 ? 0 : t3 < 1.2 ? -1 : 0;
    c3.step(key(st, c3.fwdSpeed < v ? 1 : 0), g); t3 += DT;
    maxSlip = Math.max(maxSlip, Math.abs(slipDeg(c3)));
    if (t3 > 1.2 && settleT < 0 && Math.abs(c3.yawRate) < 0.02 && Math.abs(slipDeg(c3)) < 1) settleT = t3 - 1.2;
  }
  const laneDx = Math.abs(c3.pos.x - x3), laneDh = (Math.abs(heading(c3) - h3) * 180) / Math.PI;
  const dhDeg = (maxDh * 180) / Math.PI;
  const pass = dhDeg < 2.5 && latTap < 1.5 && drift < 1.0 && bumpDh < 1.5 && laneDx > 1.0 && laneDx < 6 && laneDh < 3 && settleT >= 0 && settleT < 1.5 && maxSlip < 6;
  return { name: 'kb-lanechange', pass, summary: `150 km/h 键盘：轻点右 0.1 s 航向最多变 ${dhDeg.toFixed(2)}°、2.5 s 后横移 ${latTap.toFixed(2)} m（目标 <2.5°，<1.5 m）；车辙+碎石路面不碰方向 6 s 横漂 ${drift.toFixed(2)} m、航向 ${bumpDh.toFixed(2)}°（<1 m，<1.5°）；按键变线（右 0.4 s→松 0.4 s→左 0.4 s）横移 ${laneDx.toFixed(1)} m（1–6），收尾航向差 ${laneDh.toFixed(1)}°（<3°），${settleT < 0 ? '未稳定' : settleT.toFixed(2) + ' s 稳定'}（<1.5 s），最大滑移 ${maxSlip.toFixed(1)}°（<6°）`, data: { tapHeadingDeg: dhDeg, tapLat: latTap, bumpDrift: drift, bumpHeadingDeg: bumpDh, laneDx, laneDh, laneSettleS: settleT, laneMaxSlip: maxSlip, tapYawRate: maxYaw } };
}

/** four crests in a row at 150 km/h: landings must be absorbed (no body strike, small pitch, straight on) */
export function probeCrests(spec: CarSpec, kmh = 150): ProbeResult {
  const crest = (s: number) => {
    // 4 crests shaped like the stage's (cosine, 2.0–2.6 m high, 70–90 m long) every 170 m starting at s = 100
    const H = [2.3, 2.6, 2.0, 2.5], L = [80, 72, 90, 76];
    for (let k = 0; k < 4; k++) {
      const u = (s - 100 - k * 170) / L[k];
      if (u >= 0 && u <= 1) return H[k] * 0.5 * (1 - Math.cos(u * 2 * Math.PI));
    }
    return 0;
  };
  const g = new TestGround(Surface.Gravel, (_x, z) => crest(-z));
  const car = makeCar(spec, g);
  launchAt(car, kmh / KMH);
  let t = 0, landings = 0, maxLandV = 0, maxBottom = 0, maxBody = 0, minPitch = 0, maxPitch = 0, minUp = 1, maxG = 0, worstSettle = 0;
  let prevVy = car.vel.y, landT = -1, settled = true, air = 0, bounces = 0, worstRatio = 0, landV = 0, peakSince = 0;
  const gHist: number[] = [];
  const h0 = heading(car);
  let maxDh = 0;
  while (-car.pos.z < 100 + 3 * 170 + 90 + 120 && t < 20) {
    car.step(key(0, car.fwdSpeed < kmh / KMH ? 1 : 0), g);
    t += DT;
    const ay = (car.vel.y - prevVy) / DT; prevVy = car.vel.y;
    gHist.push(ay); if (gHist.length > 4) gHist.shift();
    const aAvg = gHist.reduce((a, b) => a + b, 0) / gHist.length;
    maxG = Math.max(maxG, aAvg / 9.81 + 1);
    if (car.groundedCount === 0) air += DT;
    else {
      if (air > 0.25) { landings++; landT = t; settled = false; landV = car.events.landed; maxLandV = Math.max(maxLandV, landV); peakSince = 0; }
      air = 0;
    }
    if (landT >= 0 && t - landT < 0.5) {
      peakSince = Math.max(peakSince, aAvg / 9.81 + 1);
      // physics floor: stopping landV within the suspension travel needs at least v²/(2·travel)
      const floorG = (landV * landV) / (2 * spec.susp.travel * 9.81) + 1;
      worstRatio = Math.max(worstRatio, peakSince / floorG);
      if (t - landT > 0.08 && car.groundedCount < 2 && settled) bounces++;
    }
    if (!settled && car.groundedCount === 4 && t - landT > 0.05) { worstSettle = Math.max(worstSettle, t - landT); settled = true; }
    maxBottom = Math.max(maxBottom, car.events.bottomOut);
    maxBody = Math.max(maxBody, car.events.bodyHit);
    const p = pitchDeg(car); minPitch = Math.min(minPitch, p); maxPitch = Math.max(maxPitch, p);
    minUp = Math.min(minUp, upY(car));
    maxDh = Math.max(maxDh, Math.abs(heading(car) - h0));
  }
  const dh = (maxDh * 180) / Math.PI;
  const pass = landings >= 3 && maxBody < 0.5 && minPitch > -15 && maxPitch < 15 && minUp > 0.8 && dh < 4 && worstRatio < 1.6 && bounces === 0 && worstSettle < 0.6;
  return { name: 'crests', pass, summary: `${kmh} km/h 连续 4 个坡顶：腾空落地 ${landings} 次，落地垂直速度最大 ${maxLandV.toFixed(1)} m/s，车身峰值 ${maxG.toFixed(1)} g（= 悬挂行程内刹停所需最小值的 ${worstRatio.toFixed(2)} 倍，目标 <1.6），落地后弹起 ${bounces} 次，限位块撞击 ${maxBottom.toFixed(2)} m/s，车身触地 ${maxBody.toFixed(2)} m/s（目标 <0.5），俯仰 ${minPitch.toFixed(1)}…${maxPitch.toFixed(1)}°，航向偏 ${dh.toFixed(1)}°，最长 ${worstSettle.toFixed(2)} s 四轮落稳（<0.6 s）`, data: { landings, maxLandV, maxG, worstRatio, bounces, maxBottom, maxBody, minPitch, maxPitch, headingDeg: dh, settleS: worstSettle } };
}

/** heading-rate (rad/s) of the velocity vector → path curvature = rate / speed */
function pathCurv(car: Car, prevDir: { x: number; z: number }, dt: number) {
  const sp = Math.hypot(car.vel.x, car.vel.z);
  if (sp < 1) return 0;
  const x = car.vel.x / sp, z = car.vel.z / sp;
  const d = Math.atan2(prevDir.x * z - prevDir.z * x, prevDir.x * x + prevDir.z * z);
  prevDir.x = x; prevDir.z = z;
  return d / dt / sp;
}

/**
 * Character (per drive layout, DESIGN §6 性格): steady corner on gravel (fixed analog steer, speed held), then
 *  a) full throttle for 1.5 s: change of body slip angle and of path curvature (push wide vs. tail out)
 *  b) from the same steady corner a sudden lift: yaw-rate change over 0.6 s (tuck-in)
 *  c) turbo response: 3rd gear at 3000 rpm part throttle → floor it: time to 50 % / 90 % of the full-load torque
 * Pass: front drive pushes on power (curvature ×≤0.97) and tucks on a lift (yaw rate ×≥1.03); rear drive steps out on
 * power (slip ≥ 10°) without spinning (< 60°); four-wheel drive stays composed on power (no spin).
 */
export function probeCharacter(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const steady = () => {
    const c = makeCar(spec, g);
    launchAt(c, 55 / KMH);
    const dir = { x: 0, z: -1 };
    let k = 0;
    for (let i = 0; i < 120 * 3; i++) {
      c.step({ ...emptyInput(), steer: 0.32, throttle: clamp(0.35 + (55 / KMH - c.fwdSpeed) * 0.4, 0, 1) }, g);
      const kk = pathCurv(c, dir, DT);
      if (i > 120 * 2.5) k += kk / 60;
    }
    return { c, dir, k };
  };
  // a) power on
  const a = steady();
  const slip0 = Math.abs(slipDeg(a.c));
  let maxSlip = slip0, kOn = 0, n = 0, spun = false;
  for (let i = 0; i < 180; i++) {
    a.c.step({ ...emptyInput(), steer: 0.32, throttle: 1 }, g);
    const kk = pathCurv(a.c, a.dir, DT);
    if (i > 120) { kOn += kk; n++; }
    maxSlip = Math.max(maxSlip, Math.abs(slipDeg(a.c)));
    if (Math.abs(slipDeg(a.c)) > 60) { spun = true; break; }
  }
  const curvRatio = n ? kOn / n / a.k : 0;
  // b) lift
  const b = steady();
  const yaw0 = Math.abs(b.c.yawRate);
  let yawMax = yaw0;
  for (let i = 0; i < 72; i++) { b.c.step({ ...emptyInput(), steer: 0.32, throttle: 0 }, g); yawMax = Math.max(yawMax, Math.abs(b.c.yawRate)); }
  const tuck = yawMax / Math.max(1e-3, yaw0);
  // c) turbo response
  const c = makeCar(spec, g);
  const gr = Math.min(3, spec.gearbox.ratios.length);
  const v3 = (3000 / 9.549) / c.gearRatio(gr) * spec.wheel.radius;
  launchAt(c, v3);
  c.gear = gr; c.pendingGear = gr;
  for (let i = 0; i < 120; i++) c.step({ ...emptyInput(), throttle: 0.2 }, g);
  let t50 = -1, t90 = -1, t = 0;
  for (let i = 0; i < 240 && t90 < 0; i++) {
    c.step({ ...emptyInput(), throttle: 1 }, g); t += DT;
    const full = (() => { const tc = spec.engine.torque; let r = tc[tc.length - 1][1]; for (let j = 1; j < tc.length; j++) if (c.rpm <= tc[j][0]) { const [r0, t0] = tc[j - 1], [r1, t1] = tc[j]; r = t0 + ((t1 - t0) * (c.rpm - r0)) / (r1 - r0); break; } return r; })();
    const f = c.throttleOut > 0.5 ? c.engineTorque / (c.throttleOut * full) : 0; // boost factor (TC cuts excluded)
    if (t50 < 0 && f >= 0.5) t50 = t;
    if (t90 < 0 && f >= 0.9) t90 = t;
  }
  const dSlip = maxSlip - slip0;
  let pass: boolean, rule: string;
  if (spec.drive === 'fwd') { pass = curvRatio <= 0.97 && tuck >= 1.03 && !spun; rule = '前驱：给油推头（曲率 ×≤0.97）、松油收线（横摆 ×≥1.03）'; }
  else if (spec.drive === 'rwd') { pass = maxSlip >= 10 && !spun; rule = '后驱：给油车尾出来（滑移 ≥10°）且不打转（<60°）'; }
  else { pass = !spun; rule = '四驱：给油不打转'; }
  return {
    name: 'character', pass,
    summary: `55 km/h 定圆（${slip0.toFixed(1)}°）全油门 1.5 s：滑移 ${maxSlip.toFixed(1)}°（+${dSlip.toFixed(1)}），路径曲率 ×${curvRatio.toFixed(2)}，${spun ? '打转' : '未打转'}；松油 0.6 s 横摆 ×${tuck.toFixed(2)}；3 挡 3000 rpm 地板油 50%/90% 扭矩 ${t50.toFixed(2)}/${t90.toFixed(2)} s。判据 ${rule}`,
    data: { slip0, maxSlip, curvRatio, tuck, t50, t90, spun },
  };
}

// ───────────────────────── hold-key probes (手感重做) ─────────────────────────
// Everything here is driven by HOLDING keys: a key goes down and stays down until the manoeuvre is over.

/** acceleration of the car's CG along a body axis over the last tick (m/s²) */
function accelAlong(car: Car, prevVel: V3, axis: V3) { return (car.vel.x - prevVel.x) * axis.x / DT + (car.vel.y - prevVel.y) * axis.y / DT + (car.vel.z - prevVel.z) * axis.z / DT; }
const isAwd = (spec: CarSpec) => spec.drive === 'awd';

/** A. steady-state cornering: hold one steering key + hold the throttle on a big pad; lateral g once it has settled */
export function holdCircle(spec: CarSpec, surf: number = Surface.Gravel, kmh = 70) {
  const g = new TestGround(surf as Surface);
  const car = makeCar(spec, g);
  launchAt(car, kmh / KMH);
  const dir = { x: 0, z: -1 };
  let acc = 0, n = 0, vAcc = 0, slipAcc = 0, spun = false;
  for (let i = 0; i < 120 * 14; i++) {
    car.step(key(1, 1), g);
    const k = pathCurv(car, dir, DT);
    if (Math.abs(slipDeg(car)) > 70) spun = true;
    if (i >= 120 * 10) { const v = Math.hypot(car.vel.x, car.vel.z); acc += v * v * k; vAcc += v; slipAcc += Math.abs(slipDeg(car)); n++; }
  }
  return { latG: acc / n / 9.81, kmh: (vAcc / n) * KMH, slip: slipAcc / n, spun };
}

export function probeHoldCircle(spec: CarSpec): ProbeResult {
  const gr = holdCircle(spec, Surface.Gravel), as = holdCircle(spec, Surface.AsphaltDry);
  const need = isAwd(spec) ? 0.92 : 0;
  const pass = !gr.spun && !as.spun && gr.latG >= need && (isAwd(spec) ? as.latG >= 1.15 : true);
  return { name: 'hold-circle', pass, summary: `按住方向+按住油门绕圈（70 km/h 起）稳态侧向：砂石 ${gr.latG.toFixed(3)} g @${gr.kmh.toFixed(0)} km/h 滑移 ${gr.slip.toFixed(1)}°，柏油 ${as.latG.toFixed(3)} g @${as.kmh.toFixed(0)} km/h（四驱目标 ≥0.92 / ≥1.15），${gr.spun || as.spun ? '打转' : '未打转'}`, data: { gravelG: gr.latG, gravelKmh: gr.kmh, asphaltG: as.latG, asphaltKmh: as.kmh, spun: gr.spun || as.spun } };
}

/** right-hand corner after a straight along -Z: signed offset from the centreline (+ = outside) and arc progress */
function cornerRoad(R: number, deg: number, Ls: number) {
  const th = (deg * Math.PI) / 180, cx = R, cz = -Ls;
  const ex = cx - R * Math.cos(th), ez = cz - R * Math.sin(th);
  return {
    th,
    offset(x: number, z: number) {
      const phi = Math.atan2(-(z - cz), -(x - cx));
      if (z > cz) return -x;
      if (phi <= th) return Math.hypot(x - cx, z - cz) - R;
      return (x - ex) * -Math.cos(th) + (z - ez) * -Math.sin(th);
    },
    /** 0 before the arc, 1 at its end, > 1 after */
    progress(x: number, z: number) {
      if (z > cz) return (cz - z) / (R * th);
      const phi = Math.atan2(-(z - cz), -(x - cx));
      if (phi <= th) return phi / th;
      return 1 + ((x - ex) * Math.sin(th) + (z - ez) * -Math.cos(th)) / (R * th);
    },
  };
}

/** road half-width the corner probes allow for the CG: north-1's road (3.3 m) + its shoulder (0.9 m) */
const ROAD_HALF = 3.3 + 0.9;

/**
 * B. The play-tester's corner: grade-5 right (110 m, 45°) at 120 km/h, throttle held all the way, the steering key
 * pressed 0.3 s before the arc and held until the car points down the exit (no taps, no counter-steer). Then a grade-4
 * (65 m, 60°) at 120: lift + hold the key; once the tail is out (or at the apex) hold the throttle too.
 */
export function holdCorner(spec: CarSpec, R: number, deg: number, kmh: number, mode: 'throttle' | 'lift') {
  const g = new TestGround(Surface.Gravel);
  const Ls = 60;
  const rd = cornerRoad(R, deg, Ls);
  const car = makeCar(spec, g);
  launchAt(car, kmh / KMH);
  const v0 = kmh / KMH;
  let maxOut = 0, maxIn = 0, maxSlip = 0, spun = false, t = 0, held = false, released = false, vExit = -1, thrOn = mode === 'throttle';
  let tThr = -1, tStraight = -1, slidOut = 0, maxOff = 0;
  const h0 = heading(car);
  while (t < 14) {
    const off = rd.offset(car.pos.x, car.pos.z), pr = rd.progress(car.pos.x, car.pos.z);
    const dh = heading(car) - h0;
    if (!held && car.pos.z < -Ls + v0 * 0.3) held = true;
    if (held && !released && dh > rd.th - 0.035) released = true;
    const sl = slipDeg(car);
    if (!thrOn && mode === 'lift' && pr > 0.5) { thrOn = true; tThr = t; }
    if (thrOn && tThr >= 0 && tStraight < 0 && Math.abs(sl) < 10 && t - tThr > 0.05) tStraight = t - tThr;
    slidOut = Math.max(slidOut, Math.abs(sl));
    // approach: hold 120 (a cruise, as the player arrives at that speed); from the turn-in on, keys only
    const cruise = clamp((v0 - car.fwdSpeed) * 0.8 + 0.3, 0, 1);
    car.step(held ? key(!released ? 1 : 0, thrOn ? 1 : 0) : { ...key(0), throttle: mode === 'throttle' ? cruise : 0 }, g);
    t += DT;
    if (pr > 0) { maxOut = Math.max(maxOut, off); maxIn = Math.max(maxIn, -off); maxSlip = Math.max(maxSlip, Math.abs(slipDeg(car))); maxOff = Math.max(maxOff, Math.abs(off)); }
    if (vExit < 0 && pr >= 1) vExit = car.fwdSpeed * KMH;
    if (Math.abs(slipDeg(car)) > 80 || upY(car) < 0.6) { spun = true; break; }
    if (pr > 1 + 60 / (R * rd.th)) break;
  }
  return { maxOut, maxIn, maxOff, maxSlip, spun, vExit, tStraight, slidOut };
}

export function probeHoldCorner(spec: CarSpec): ProbeResult {
  const a = holdCorner(spec, 110, 45, 120, 'throttle');
  const pass = !a.spun && a.maxOff <= ROAD_HALF && a.vExit >= 105;
  return {
    name: 'hold-corner', pass,
    summary: `五级右（110 m，45°）120 km/h 按住方向+按住油门：外侧最多 ${a.maxOut.toFixed(1)} m、内侧 ${a.maxIn.toFixed(1)} m（路半宽含路肩 ${ROAD_HALF} m），最大滑移 ${a.maxSlip.toFixed(1)}°，出弯 ${a.vExit.toFixed(0)} km/h（≥105），${a.spun ? '打转' : '未打转'}`,
    data: { out: a.maxOut, in: a.maxIn, slip: a.maxSlip, exitKmh: a.vExit, spun: a.spun },
  };
}

/** B, second half: grade-4 right (65 m, 60°) at 120 km/h, lift + hold the key, throttle held from the apex. Judged on
 *  control (tail out but no spin, straight again ≤ 1.5 s after the throttle). Staying on the road is reported, not
 *  required: 120 km/h on a 65 m radius is 1.75 g — no tyre makes that; the entry speed that does stay on is listed */
export function probeLiftCorner(spec: CarSpec): ProbeResult {
  const b = holdCorner(spec, 65, 60, 120, 'lift');
  let vOk = 0;
  for (let k = 115; k >= 70; k -= 5) { const r = holdCorner(spec, 65, 60, k, 'lift'); if (!r.spun && r.maxOut <= ROAD_HALF) { vOk = k; break; } }
  const pass = !b.spun && b.tStraight >= 0 && b.tStraight <= 1.5;
  return {
    name: 'lift-corner', pass,
    summary: `四级右（65 m，60°）120 km/h 松油+按住方向：车尾 ${b.slidOut.toFixed(0)}°，${b.spun ? '打转' : '未打转'}，弯心起按住油门 ${b.tStraight < 0 ? '未拉直' : b.tStraight.toFixed(2) + ' s'} 回到 <10°（≤1.5 s）；外侧冲出 ${b.maxOut.toFixed(1)} m（路半宽含路肩 ${ROAD_HALF} m，物理上需 1.75 g，不判），出弯 ${b.vExit.toFixed(0)} km/h；同样手法不出外侧的最高入弯速度 ${vOk || '<70'} km/h`,
    data: { slide: b.slidOut, straightS: b.tStraight, out: b.maxOut, in: b.maxIn, exitKmh: b.vExit, spun: b.spun, vOk },
  };
}

/**
 * C. High-speed drift exit: 130 km/h on gravel, hold right + handbrake until the body slip passes 30°, then let go of
 * everything but the throttle (held). Slip back under 8° (four-wheel drive ≤ 1.5 s, others ≤ 2.5 s), speed lost
 * < 15 km/h, no swing to the other side (pendulum) past 8°.
 */
export function probeDriftExit(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, 130 / KMH);
  // a steady right-hand drift: velocity 30° left of the nose, yawing right at the rate of a ~0.9 g corner, wheels
  // turning at the forward speed
  {
    const v = 130 / KMH, b = (30 * Math.PI) / 180;
    const f = car.quat.rotate(new V3(0, 0, -1), new V3()), r = car.quat.rotate(new V3(1, 0, 0), new V3()), u = car.quat.rotate(new V3(0, 1, 0), new V3());
    car.vel.copy(f).scale(v * Math.cos(b)).addScaled(r, -v * Math.sin(b));
    car.angVel.copy(u).scale(-(0.9 * 9.81) / v);
    for (const w of car.wheels) w.omega = (v * Math.cos(b)) / car.spec.wheel.radius;
    for (let i = 0; i < 6; i++) car.step(key(0, 1), g);
  }
  const slip0 = Math.abs(slipDeg(car)), v0 = car.fwdSpeed * KMH, vh0 = Math.hypot(car.vel.x, car.vel.z) * KMH;
  let tRec = -1, swing = 0, vMin = vh0, tt = 0, spun = false;
  for (let i = 0; i < 120 * 4; i++) {
    car.step(key(0, 1), g); tt += DT;
    const sd = slipDeg(car);
    vMin = Math.min(vMin, Math.hypot(car.vel.x, car.vel.z) * KMH);
    if (tRec < 0 && Math.abs(sd) < 8) tRec = tt;
    if (tRec >= 0) swing = Math.max(swing, sd); // the slide was to the left (β < 0): a swing back is β > 0
    if (Math.abs(sd) > 80) { spun = true; break; }
  }
  const lim = isAwd(spec) ? 1.5 : 2.5;
  const loss = vh0 - vMin;
  const pass = !spun && tRec >= 0 && tRec <= lim && loss < 15 && swing < 8;
  return { name: 'drift-exit', pass, summary: `130 km/h 侧滑到 ${slip0.toFixed(0)}°（车速 ${vh0.toFixed(0)} km/h，纵向 ${v0.toFixed(0)}）后只按住油门：${tRec < 0 ? '未拉直' : tRec.toFixed(2) + ' s'} 回到 <8°（目标 ≤${lim} s），车速最多掉 ${loss.toFixed(1)} km/h（<15），反向摆 ${Math.max(0, swing).toFixed(1)}°（<8°），${spun ? '打转' : '未打转'}`, data: { slip0, recoverS: tRec, speedLoss: loss, swing, spun } };
}

/** D. Pull-out: sliding at 25° body slip (80 km/h), full throttle, keys released: acceleration along the nose */
export function pullOut(spec: CarSpec, slipDegIn = 25, kmh = 80) {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  const v = kmh / KMH, b = (slipDegIn * Math.PI) / 180;
  const fwd = car.quat.rotate(new V3(0, 0, -1), new V3()), rgt = car.quat.rotate(new V3(1, 0, 0), new V3());
  // velocity 25° to the left of the nose (tail out to the left in a right-hand slide), wheels rolling at road speed
  car.vel.copy(fwd).scale(v * Math.cos(b)).addScaled(rgt, -v * Math.sin(b));
  for (const w of car.wheels) w.omega = (v * Math.cos(b)) / car.spec.wheel.radius;
  const gb = car.spec.gearbox;
  for (let gg = 1; gg <= gb.ratios.length; gg++) { car.gear = gg; car.pendingGear = gg; if ((v / car.spec.wheel.radius) * car.gearRatio(gg) * 9.549 < gb.upRpm - 1500) break; }
  // mid-slide on the throttle already: the turbo is spooled (the lag is the character probe's business)
  (car as unknown as { spoolState: number }).spoolState = 1; car.boost = 1;
  const prev = new V3();
  let acc = 0, n = 0;
  for (let i = 0; i < 48; i++) {
    prev.copy(car.vel);
    car.step(key(1, 1), g);
    const f = car.quat.rotate(new V3(0, 0, -1), new V3());
    if (i >= 12) { acc += accelAlong(car, prev, f); n++; }
  }
  return acc / n / 9.81;
}

export function probePullOut(spec: CarSpec): ProbeResult {
  const a = pullOut(spec);
  const need = isAwd(spec) ? 0.35 : 0;
  return { name: 'pullout', pass: a >= need, summary: `砂石 80 km/h 滑移 25°、按住方向+全油门 0.1–0.4 s：沿车头加速度 ${a.toFixed(3)} g（四驱目标 ≥0.35 g）`, data: { pullG: a } };
}

/** E. Handbrake held: 60 km/h, hold left + handbrake 1.2 s then let go (heading turned 70–110°, never > 150°); held 3 s
 *  (≤ 180°) */
export function holdHandbrake(spec: CarSpec, holdS: number, kmh = 60) {
  const g = new TestGround(Surface.Gravel);
  const car = makeCar(spec, g);
  launchAt(car, kmh / KMH);
  const h0 = heading(car);
  let t = 0, turned = 0, at = 0, unwrapped = 0, prevH = h0;
  while (t < holdS + 3) {
    const on = t < holdS;
    car.step(key(on ? -1 : 0, 0, 0, on ? 1 : 0), g); t += DT;
    const h = heading(car);
    let d = h - prevH; d = Math.atan2(Math.sin(d), Math.cos(d)); prevH = h;
    unwrapped += d;
    turned = Math.max(turned, -unwrapped);
    if (on) at = -unwrapped;
  }
  return { atRelease: (at * 180) / Math.PI, maxTurn: (turned * 180) / Math.PI, vEnd: car.fwdSpeed * KMH };
}

export function probeHoldHandbrake(spec: CarSpec): ProbeResult {
  const a = holdHandbrake(spec, 1.2), b = holdHandbrake(spec, 3);
  const pass = a.maxTurn >= 70 && a.maxTurn <= 110 && b.maxTurn <= 180;
  return { name: 'hold-handbrake', pass, summary: `60 km/h 按住左+手刹 1.2 s 后全松：松手时 ${a.atRelease.toFixed(0)}°，最终转过 ${a.maxTurn.toFixed(0)}°（目标 70–110，≤150）；一直按住 3 s：${b.maxTurn.toFixed(0)}°（≤180）`, data: { turn12: a.maxTurn, atRelease: a.atRelease, turn3: b.maxTurn } };
}

/**
 * Hairpin exit on held keys (收尾任务报告的 1 挡/限速器、洛川出发卡打转): from 18 km/h in 1st, hold one steering key and
 * the throttle for 3 s (the hairpin), then let go of the steering and keep the throttle 2.5 s. On gravel, dry asphalt,
 * snow and ice: no time on the rev limiter, no burning out in 1st (it must drive away), no spin.
 */
export function hairpinExit(spec: CarSpec, surf: number) {
  const g = new TestGround(surf as Surface);
  const car = makeCar(spec, g);
  launchAt(car, 18 / KMH);
  car.gear = 1; car.pendingGear = 1;
  let limiter = 0, maxSlip = 0, firstSlow = 0, t = 0;
  for (let i = 0; i < 120 * 5.5; i++) {
    car.step(key(i < 360 ? -1 : 0, 1), g); t += DT;
    if (car.limiterCut) limiter += DT;
    if (car.gear === 1 && car.speed < 4 && t > 1) firstSlow += DT;
    maxSlip = Math.max(maxSlip, Math.abs(slipDeg(car)));
  }
  return { limiter, firstSlow, maxSlip, vEnd: car.speed * KMH, gear: car.gear };
}

export function probeHairpinExit(spec: CarSpec): ProbeResult {
  const S: [number, string][] = [[Surface.Gravel, '砂石'], [Surface.AsphaltDry, '柏油'], [Surface.Snow, '雪'], [Surface.Ice, '冰']];
  const rs = S.map(([s]) => hairpinExit(spec, s));
  const pass = rs.every((r) => r.limiter < 0.1 && r.firstSlow < 0.5 && r.maxSlip < 60 && r.vEnd > 25);
  return { name: 'hairpin-exit', pass, summary: `发卡出弯（18 km/h 1 挡，按住方向+按住油门 3 s，再只按油门 2.5 s）${S.map(([, n], i) => `${n}：限速器 ${rs[i].limiter.toFixed(2)} s、1 挡原地 ${rs[i].firstSlow.toFixed(1)} s、最大滑移 ${rs[i].maxSlip.toFixed(0)}°、末速 ${rs[i].vEnd.toFixed(0)} km/h ${rs[i].gear} 挡`).join('；')}（目标：限速器 <0.1 s，1 挡原地 <0.5 s，不打转 <60°，末速 >25）`, data: Object.fromEntries(rs.flatMap((r, i) => [[`limiter${i}`, r.limiter], [`slip${i}`, r.maxSlip], [`vEnd${i}`, r.vEnd]])) };
}

/** standing start on an 8 % icy climb (钉胎): held throttle, no steering — must get going (≥ 15 km/h within 8 s) */
export function probeIceHill(spec: CarSpec): ProbeResult {
  const g = new TestGround(Surface.Ice, (_x, z) => -0.08 * z);
  const car = new Car(spec);
  car.assists = assistsFor(probeAssist);
  car.reset(g, 0, 0, 0, -1);
  for (let i = 0; i < 240; i++) car.step({ ...emptyInput(), brake: 0.3, digital: true }, g);
  const z0 = car.pos.z;
  let t = 0, t15 = -1, minZ = z0, back = 0;
  for (let i = 0; i < 120 * 8; i++) {
    car.step(key(0, 1), g); t += DT;
    if (t15 < 0 && car.fwdSpeed * KMH >= 15) t15 = t;
    minZ = Math.min(minZ, car.pos.z); back = Math.max(back, car.pos.z - z0);
  }
  const climbed = z0 - car.pos.z;
  const pass = t15 > 0 && back < 0.5;
  return { name: 'ice-hill', pass, summary: `冰面 8% 上坡静止起步（按住油门）：${t15 < 0 ? '8 s 内没到 15 km/h' : t15.toFixed(1) + ' s 到 15 km/h'}，8 s 爬了 ${climbed.toFixed(0)} m，倒溜最多 ${back.toFixed(2)} m（目标：8 s 内到 15 km/h，不倒溜 >0.5 m）`, data: { t15, climbed, back } };
}

export const PROBES: Record<string, (spec: CarSpec) => ProbeResult> = {
  idle: probeIdle,
  accel: probeAccel,
  brake: probeBrake,
  drift: probeDrift,
  handbrake: probeHandbrake,
  jump: (s) => probeJump(s, 120),
  rollover: probeRollover,
  'kb-slalom': probeKbSlalom,
  'kb-drift': probeKbDrift,
  'kb-handbrake': probeKbHandbrake,
  'kb-lanechange': probeKbLaneChange,
  crests: (s) => probeCrests(s, 150),
  character: probeCharacter,
  'hold-circle': probeHoldCircle,
  'hold-corner': probeHoldCorner,
  'lift-corner': probeLiftCorner,
  'drift-exit': probeDriftExit,
  pullout: probePullOut,
  'hold-handbrake': probeHoldHandbrake,
  'hairpin-exit': probeHairpinExit,
  'ice-hill': probeIceHill,
};
