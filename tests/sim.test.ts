import { describe, expect, it } from 'vitest';
import { CARS, withDrive } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { Bot } from '../src/sim/driver/bot';
import { Rng } from '../src/sim/math/rng';
import { DS } from '../src/sim/stage/centerline';
import { GRADE_RADIUS } from '../src/sim/stage/script';
import { Stage } from '../src/sim/stage/stage';
import { emptyInput, type DriverInput } from '../src/sim/vehicle/controls';
import { PROBES } from '../src/sim/vehicle/probes';
import { World } from '../src/sim/world';

const stageDef = STAGES['north-1'];
const car = CARS.kestrel;

/** scripted pseudo-random player input (deterministic) */
function scriptedRun(ticks: number) {
  const w = new World(stageDef, car, { cached: false });
  const rng = new Rng(99);
  const bot = new Bot(w.stage, w.car, { skill: 0.8 });
  const hashes: string[] = [];
  let inp: DriverInput = emptyInput();
  for (let i = 0; i < ticks; i++) {
    if (i % 90 === 0) {
      // mix the bot with random handbrake / steering jabs
      inp = { ...bot.drive(w) };
      if (rng.chance(0.2)) inp.handbrake = 1;
      if (rng.chance(0.2)) { inp.steer = rng.range(-1, 1); inp.digital = true; }
    } else inp = { ...bot.drive(w), handbrake: inp.handbrake, steer: inp.digital ? inp.steer : bot.drive(w).steer, digital: inp.digital };
    w.step(inp);
    if (i % 600 === 0) hashes.push(w.hash());
  }
  hashes.push(w.hash());
  return hashes;
}

describe('determinism', () => {
  it('same seed + same input → identical state hashes', () => {
    const a = scriptedRun(120 * 40);
    const b = scriptedRun(120 * 40);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(3);
  });
  it('stage generation is deterministic', () => {
    const s1 = new Stage(stageDef), s2 = new Stage(stageDef);
    expect(s1.cl.length).toBe(s2.cl.length);
    expect(Array.from(s1.terrain.prof.slice(0, 500))).toEqual(Array.from(s2.terrain.prof.slice(0, 500)));
    expect(s1.props.length).toBe(s2.props.length);
  });
});

describe('stage generation', () => {
  const st = new Stage(stageDef);
  it('builds a 4–5 km stage with the scripted features', () => {
    expect(st.length).toBeGreaterThan(4000);
    expect(st.length).toBeLessThan(5200);
    const feats = st.cl.pieces.flatMap((p) => p.features.map((f) => f.kind));
    expect(feats.filter((k) => k === 'jump').length).toBeGreaterThanOrEqual(2);
    expect(feats.filter((k) => k === 'crest').length).toBeGreaterThanOrEqual(3);
    expect(st.cl.pieces.some((p) => p.grade === 'hairpin')).toBe(true);
    expect(st.terrain.lakes.length).toBe(1);
    expect(st.cl.warnings).toEqual([]);
  });
  it('centerline has no self-intersection (non-adjacent road ≥ 35 m apart, hairpin legs excepted)', () => {
    const cl = st.cl;
    const hairpins = cl.pieces.filter((p) => p.grade === 'hairpin').map((p) => (p.s0 + p.s1) / 2);
    let worst = Infinity;
    for (let i = 0; i < cl.n; i += 4) for (let j = i + 90; j < cl.n; j += 4) {
      const si = i * DS, sj = j * DS;
      const nearHairpin = hairpins.some((h) => h > si - 40 && h < sj + 40) && sj - si < 260;
      const d = Math.hypot(cl.x[i] - cl.x[j], cl.z[i] - cl.z[j]);
      if (!nearHairpin) worst = Math.min(worst, d);
      else expect(d).toBeGreaterThan(14);
    }
    expect(worst).toBeGreaterThanOrEqual(34);
  });
  it('pace notes agree with the geometry (direction and severity)', () => {
    for (const n of st.notes.filter((x) => x.kind === 'turn')) {
      const piece = st.cl.pieces.find((p) => p.kind === 'turn' && p.s0 === n.s)!;
      expect(piece).toBeTruthy();
      // integrate heading change over the corner
      const i0 = Math.round(piece.s0 / DS), i1 = Math.round(piece.s1 / DS);
      const dTheta = st.cl.theta[i1] - st.cl.theta[i0];
      expect(Math.sign(dTheta)).toBe(n.dir === 'R' ? 1 : -1);
      let kmax = 0;
      for (let i = i0; i <= i1; i++) kmax = Math.max(kmax, Math.abs(st.cl.kappa[i]));
      const rMin = 1 / kmax;
      const [lo, hi] = GRADE_RADIUS[String(n.grade)];
      expect(rMin).toBeGreaterThan(lo * 0.8);
      expect(rMin).toBeLessThan(hi * 1.25);
    }
    // notes are ordered and inside the stage
    for (let i = 1; i < st.notes.length; i++) expect(st.notes[i].s).toBeGreaterThanOrEqual(st.notes[i - 1].s);
  });
  it('no tree or rock stands on the road', () => {
    for (const p of st.props) {
      if (p.type === 'cabin') continue;
      const q = st.terrain.nearest(p.x, p.z);
      if (q.found) expect(Math.abs(q.d)).toBeGreaterThan(st.def.halfWidth + 1);
    }
  });
  it('terrain is continuous across the road blend (no cliffs)', () => {
    const cl = st.cl;
    for (let i = 10; i < cl.n - 10; i += 37) {
      const p = st.pointAt(i * DS);
      let prev = st.height(p.x - p.rx * 60, p.z - p.rz * 60);
      for (let d = -60; d <= 60; d += 0.5) {
        const h = st.height(p.x + p.rx * d, p.z + p.rz * d);
        expect(Math.abs(h - prev)).toBeLessThan(1.2);
        prev = h;
      }
    }
  });
});

describe('vehicle', () => {
  it('handling probes pass (four-wheel drive)', () => {
    for (const [name, p] of Object.entries(PROBES)) {
      const r = p(car);
      expect(r.pass, `${name}: ${r.summary}`).toBe(true);
    }
  });
  it('front- and rear-drive variants drive forward', () => {
    for (const d of ['fwd', 'rwd'] as const) {
      // full throttle from rest: rear-drive 380 hp on gravel spins up (no traction control) but must still move forward
      const r = PROBES.accel(withDrive(car, d));
      expect(r.data.topKmh as number).toBeGreaterThan(40);
    }
  });
});
