// Trajectory prediction (DESIGN §4 轨迹预测): zero side effects, accuracy against the real sim, impact detection.
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { Surface } from '../src/data/surfaces';
import { Bot } from '../src/sim/driver/bot';
import { TestGround, type Ground } from '../src/sim/ground';
import { V3 } from '../src/sim/math/vec';
import { Car, DT } from '../src/sim/vehicle/car';
import { emptyInput, type DriverInput } from '../src/sim/vehicle/controls';
import { Predictor, STOP_IMPACT, STOP_NONE, Trajectory, copyState, packTrajectory, packedSize, stageOffRoad, unpackTrajectory } from '../src/sim/vehicle/predict';
import { World } from '../src/sim/world';

const spec = CARS.kestrel;
const key = (steer: number, throttle = 0, brake = 0, handbrake = 0): DriverInput => ({ ...emptyInput(), steer, throttle, brake, handbrake, digital: true });

/** bot-driven run of the real stage; optionally running a prediction from the live car every 10 ticks */
function stageRun(ticks: number, predict: boolean, cacheGround = true) {
  const w = new World(STAGES['north-1'], spec, { cached: false });
  const bot = new Bot(w.stage, w.car, { skill: 0.85 });
  w.car.assists.counterSteer = false;
  const pr = predict ? new Predictor(w.car, w.stage, { cacheGround, offRoad: stageOffRoad(w.stage.terrain) }) : null;
  const hashes: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const inp = bot.drive(w);
    w.step(inp);
    if (pr && i % 10 === 0) {
      // the game hands the predictor the very input object the sim just used
      pr.begin(w.car, inp, w.tick);
      while (!pr.advance(37));
      expect(pr.aliased).toEqual([]);
    }
    if (i % 120 === 0) hashes.push(w.hash());
  }
  hashes.push(w.hash());
  return { hashes, w, pr };
}

describe('prediction: zero side effects', () => {
  it('real sim state hashes are identical with prediction on and off', () => {
    const off = stageRun(120 * 25, false);
    const on = stageRun(120 * 25, true);
    expect(on.hashes).toEqual(off.hashes);
    expect(on.w.session.penalties).toBe(off.w.session.penalties);
    expect(on.w.session.time).toBe(off.w.session.time);
    expect(on.pr!.count).toBeGreaterThan(200);
  });
});

/** every numeric/boolean/string leaf of an object graph, by path (skips the spec and functions) */
function leaves(o: unknown, path = '', out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (o === null || typeof o !== 'object') { out.set(path.slice(0, -1), o); return out; }
  for (const k of Object.keys(o as object)) {
    if (depth === 0 && k === 'spec') continue;
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'function') continue;
    if (v instanceof Float32Array || v instanceof Float64Array) { out.set(path + k, Array.from(v).join(',')); continue; }
    leaves(v, `${path}${k}.`, out, depth + 1);
  }
  return out;
}

describe('prediction: clone completeness', () => {
  it('the shadow car carries every field of the real car (incl. TC, handbrake timers, front grip, tyre load lag, input shaping)', () => {
    const g = new TestGround(Surface.Gravel);
    // mid handbrake flick with keys: TC/handbrake timers, hbHold, steer shaping and tyre-load lag are all non-trivial
    const car = padCar(g, 70, key(1, 1, 0, 1), 40);
    for (let i = 0; i < 20; i++) car.step(key(-1, 1, 0, 0), g);
    const pr = new Predictor(car, g, { cacheGround: false });
    pr.begin(car, key(-1, 1));
    const a = leaves(car), b = leaves(pr.shadow);
    // the private assist / shaping state the hand-off must not lose
    for (const k of ['tcMul', 'hbTimer', 'frontMu', 'prevUp', 'controls.hbHold', 'controls.steer', 'controls.throttle', 'wheels.0.tireLoad', 'wheels.2.compPrev'])
      expect(a.has(k), k).toBe(true);
    const diff = [...a].filter(([k, v]) => !Object.is(b.get(k), v)).map(([k]) => k);
    expect(diff).toEqual([]);
    expect(b.size).toBe(a.size);
    expect(pr.aliased).toEqual([]);
  });
});

/** settled car on a pad, rolling forward at v, then `warm` ticks of `inp` so the input shaping is mid-way */
function padCar(g: Ground, vKmh: number, warmInp: DriverInput, warm: number) {
  const car = new Car(spec);
  car.reset(g, 0, 0, 0, -1);
  for (let i = 0; i < 120; i++) car.step(emptyInput(), g);
  const v = vKmh / 3.6;
  car.vel.set(0, 0, -v);
  for (const w of car.wheels) w.omega = v / spec.wheel.radius;
  for (let gg = 1; gg <= 6; gg++) { car.gear = gg; car.pendingGear = gg; if ((v / spec.wheel.radius) * car.gearRatio(gg) * 9.549 < 6000) break; }
  for (let i = 0; i < warm; i++) car.step(warmInp, g);
  return car;
}

/** predict `secs` ahead, then really drive the same input for `secs`; distance between the two at the end (m) */
function predictVsActual(g: Ground, car: Car, inp: DriverInput, secs: number, step = DT) {
  const pr = new Predictor(car, g, { horizon: secs, step, cacheGround: false });
  const tr = pr.run(car, inp);
  const p = tr.posAt(secs, new V3());
  for (let i = 0; i < Math.round(secs / DT); i++) car.step(inp, g);
  return { err: Math.hypot(p.x - car.pos.x, p.y - car.pos.y, p.z - car.pos.z), tr, car };
}

describe('prediction: accuracy on the test pad (input held, 2 s)', () => {
  const cases: [string, number, DriverInput, DriverInput, number][] = [
    // name, start km/h, warm-up input, held input, warm-up ticks
    ['straight, full throttle', 40, key(0, 1), key(0, 1), 30],
    ['constant steer (circle)', 60, key(0.6, 0.5), key(0.6, 0.5), 20],
    ['handbrake flick (pendulum)', 70, key(1, 0, 0, 1), key(1, 0, 0, 1), 12],
  ];
  for (const [name, kmh, warmInp, inp, warm] of cases) {
    it(`${name}: 120 Hz prediction < 0.3 m off after 2 s`, () => {
      const g = new TestGround(Surface.Gravel);
      const car = padCar(g, kmh, warmInp, warm);
      const r = predictVsActual(g, car, inp, 2);
      // half-rate prediction for the record
      const car2 = padCar(g, kmh, warmInp, warm);
      const r2 = predictVsActual(g, car2, inp, 2, 2 * DT);
      const maxSlip = Math.max(...Array.from(r.tr.slip.subarray(0, r.tr.n))) * 180 / Math.PI;
      console.log(`[predict] ${name}: 120 Hz err ${r.err.toFixed(4)} m, 60 Hz err ${r2.err.toFixed(3)} m, travelled ${Math.hypot(r.car.pos.x, r.car.pos.z).toFixed(1)} m, max slip ${maxSlip.toFixed(1)}°`);
      expect(r.err).toBeLessThan(0.3);
      expect(r.tr.stop).toBe(STOP_NONE);
    });
  }
  it('handbrake flick prediction shows the car going sideways', () => {
    const g = new TestGround(Surface.Gravel);
    const car = padCar(g, 70, key(1, 0, 0, 1), 12);
    const tr = new Predictor(car, g, { cacheGround: false }).run(car, key(1, 0, 0, 1));
    const maxSlip = Math.max(...Array.from(tr.slip.subarray(0, tr.n)));
    expect(maxSlip).toBeGreaterThan(30 * Math.PI / 180);
  });
  it('real stage with the cached ground: 2 s prediction matches the real sim closely', () => {
    const w = new World(STAGES['north-1'], spec, { cached: false });
    const bot = new Bot(w.stage, w.car, { skill: 0.85 });
    w.car.assists.counterSteer = false;
    let inp = emptyInput();
    const errs: number[] = [], errs60: number[] = [];
    for (const until of [6, 12, 20, 30, 45, 60, 75, 90]) {
      while (w.session.time < until) { inp = { ...bot.drive(w) }; w.step(inp); }
      // the "actual" run: an exact clone driven by the real ground (bit-identical to the real sim, see the pad tests)
      const exact = new Predictor(w.car, w.stage, { horizon: 2, step: DT, cacheGround: false }).run(w.car, inp);
      const b = exact.posAt(2, new V3());
      for (const [step, out] of [[DT, errs], [2 * DT, errs60]] as const) {
        const tr = new Predictor(w.car, w.stage, { horizon: 2, step, cacheGround: true }).run(w.car, inp);
        const a = tr.posAt(2, new V3());
        out.push(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      }
    }
    const max = (a: number[]) => Math.max(...a);
    console.log(`[predict] stage, cached ground, 8 points: 120 Hz max err ${max(errs).toFixed(3)} m (${errs.map((e) => e.toFixed(3)).join(' ')}), 60 Hz max err ${max(errs60).toFixed(3)} m`);
    expect(max(errs)).toBeLessThan(0.3);
  });
  it('worker path (snapshot → structured clone → pack/unpack) gives the same trajectory', () => {
    const w = new World(STAGES['north-1'], spec, { cached: false });
    const bot = new Bot(w.stage, w.car, { skill: 0.85 });
    let inp = emptyInput();
    while (w.session.time < 15) { inp = { ...bot.drive(w) }; w.step(inp); }
    const direct = new Predictor(w.car, w.stage).run(w.car, inp);
    // main thread: snapshot; worker: own car + predictor
    const holder = {};
    copyState(holder, w.car);
    const snap = structuredClone(holder);
    const other = new Car(structuredClone(spec));
    copyState(other, snap);
    const tr = new Predictor(other, w.stage).run(other, structuredClone(inp));
    const back = unpackTrajectory(packTrajectory(tr, new Float32Array(packedSize(tr.cap))), new Trajectory(tr.cap));
    expect(back.n).toBe(direct.n);
    for (let i = 0; i < direct.n * 3; i++) expect(Math.abs(back.pos[i] - direct.pos[i])).toBeLessThan(1e-3);
  });
});

describe('prediction: impacts', () => {
  it('driving at a tree reports the impact and stops there', () => {
    const g = new TestGround(Surface.Gravel);
    g.grid.add({ kind: 'cyl', x: 0, y: -1, z: -30, r: 0.35, h: 8 });
    const car = padCar(g, 60, key(0, 1), 10);
    const tr = new Predictor(car, g, { cacheGround: false }).run(car, key(0, 1));
    expect(tr.stop).toBe(STOP_IMPACT);
    expect(Math.hypot(tr.hit.x - 0, tr.hit.z + 30)).toBeLessThan(0.8);
    expect(tr.stopT).toBeLessThan(2.0);
  });
  it('steering away from the tree: no impact', () => {
    const g = new TestGround(Surface.Gravel);
    g.grid.add({ kind: 'cyl', x: 0, y: -1, z: -30, r: 0.35, h: 8 });
    const car = padCar(g, 60, key(0, 1), 10);
    car.pos.x += 4;
    const tr = new Predictor(car, g, { cacheGround: false }).run(car, key(0, 1));
    expect(tr.stop).toBe(STOP_NONE);
  });
  it('sliding into an earth bank reports an impact or rollover', () => {
    const g = new TestGround(Surface.Gravel, (x) => (x < 3 ? 0 : Math.min(1.6, (x - 3) * 1.35)));
    const car = new Car(spec);
    car.reset(g, -8, 0, 0, -1);
    for (let i = 0; i < 120; i++) car.step(emptyInput(), g);
    car.vel.set(16, 0, -2);
    for (const w of car.wheels) w.omega = 2 / spec.wheel.radius;
    const tr = new Predictor(car, g, { cacheGround: false }).run(car, emptyInput());
    expect(tr.stop).not.toBe(STOP_NONE);
    expect(tr.stopT).toBeLessThan(1.5);
  });
});

describe('prediction: cost', () => {
  it('measures a full 2.5 s prediction on the stage', () => {
    const w = new World(STAGES['north-1'], spec, { cached: false });
    const bot = new Bot(w.stage, w.car, { skill: 0.85 });
    let inp = emptyInput();
    while (w.session.time < 20) { inp = { ...bot.drive(w) }; w.step(inp); }
    const res: string[] = [];
    for (const [label, step, cache] of [['120 Hz raw ground', DT, false], ['120 Hz cached', DT, true], ['60 Hz cached', 2 * DT, true]] as const) {
      const pr = new Predictor(w.car, w.stage, { step, cacheGround: cache });
      const times: number[] = [];
      // consecutive predictions as in the game: the car moves on 1/20 s between them
      for (let k = 0; k < 12; k++) {
        const t0 = performance.now();
        pr.run(w.car, inp);
        times.push(performance.now() - t0);
        for (let j = 0; j < 6; j++) { inp = { ...bot.drive(w) }; w.step(inp); }
      }
      const cold = times[0], warm = times.slice(2).sort((a, b) => a - b);
      res.push(`${label}: first ${cold.toFixed(1)} ms, steady median ${warm[warm.length >> 1].toFixed(2)} ms`);
    }
    console.log('[predict] cost ' + res.join(' | '));
    expect(res.length).toBe(3);
  });
});
