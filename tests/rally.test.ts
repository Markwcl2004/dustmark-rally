import { describe, expect, it } from 'vitest';
import { CARS } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { World } from '../src/sim/world';
import { emptyInput } from '../src/sim/vehicle/controls';
import { V3 } from '../src/sim/math/vec';
import { Session, CUT_PENALTY, FALSE_START_PENALTY } from '../src/sim/rally/session';
import { MEDAL_RATIO, medalFor } from '../src/sim/rally/scoring';
import { GhostRecorder, decodeGhost, sampleGhost, ghostTimeAt, toBase64, fromBase64 } from '../src/sim/rally/ghost';
import { BACKUP_PREFIX, GHOST_PREFIX, LEGACY_PREDICT_KEY, MemoryKV, SAVE_KEY, SAVE_VERSION, clearSave, loadSave, newSave, readGhost, updateRecord, writeGhost, writeSave } from '../src/sim/rally/save';
import type { EnvInfo } from '../src/sim/rally/catalog';
import { listCars, listEnvs, stageLength } from '../src/sim/rally/catalog';
import {
  MEDAL_POINTS, RALLIES_PER_SEASON, SEASON_UNLOCK_POINTS, STAGES_PER_RALLY, buildSeason, finishRally, finishSeason,
  newCareer, nextSeason, normalizeCareer, rallyPoints, recordStage, seasonOver, seasonProgress, startRally,
} from '../src/sim/rally/career';
import { runReference } from '../src/sim/rally/botTimes';

describe('scoring', () => {
  it('medal lines', () => {
    expect(MEDAL_RATIO.gold).toBeLessThan(MEDAL_RATIO.silver);
    expect(MEDAL_RATIO.silver).toBeLessThan(MEDAL_RATIO.bronze);
    expect(medalFor(100 * MEDAL_RATIO.gold, 100)).toBe('gold'); expect(medalFor(100 * MEDAL_RATIO.gold + 0.01, 100)).toBe('silver');
    expect(medalFor(100 * MEDAL_RATIO.bronze, 100)).toBe('bronze'); expect(medalFor(100 * MEDAL_RATIO.bronze + 0.01, 100)).toBe(null);
    expect(medalFor(90, null)).toBe(null);
  });
});

describe('ghost', () => {
  it('base64 round trip', () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(Array.from(fromBase64(toBase64(b)))).toEqual(Array.from(b));
  });
  it('records 10 Hz poses, decodes within a centimetre, interpolates, and is small', () => {
    const rec = new GhostRecorder(10);
    for (let k = 0; k <= 200 * 120; k++) {
      const t = k / 120, a = t * 0.05;
      rec.push(t, 100 + Math.cos(a) * 300, 20 + Math.sin(t) * 3, -50 + Math.sin(a) * 300, 0, Math.sin(a / 2), 0, Math.cos(a / 2), t * 15);
    }
    const data = rec.encode();
    expect(data.length).toBeLessThan(45_000);
    const g = decodeGhost(data);
    expect(g.n).toBe(rec.count);
    const t = 123.4, a = t * 0.05;
    const p = [0, 0, 0], q = [0, 0, 0, 1];
    expect(sampleGhost(g, t, p, q)).toBe(true);
    expect(Math.hypot(p[0] - (100 + Math.cos(a) * 300), p[2] - (-50 + Math.sin(a) * 300))).toBeLessThan(0.05);
    expect(Math.abs(q[1] - Math.sin(a / 2))).toBeLessThan(0.01);
    expect(ghostTimeAt(g, 150)).toBeCloseTo(10, 1);
  });
});

describe('save', () => {
  it('round trip, legacy migration, corrupt save backed up', () => {
    const kv = new MemoryKV();
    kv.setItem(LEGACY_PREDICT_KEY, '1');
    const first = loadSave(kv);
    expect(first.status).toBe('new');
    expect(first.save.settings.predict).toBe(true);
    first.save.unlockedGroup = 1;
    first.save.settings.vol.master = 0.4;
    expect(updateRecord(first.save, 'north-1', 200, 'pipit', 'silver')).toBe(true);
    expect(updateRecord(first.save, 'north-1', 210, 'pipit', 'gold')).toBe(false);
    expect(first.save.records['north-1'].medal).toBe('gold');
    writeSave(kv, first.save);
    const again = loadSave(kv);
    expect(again.status).toBe('ok');
    expect(again.save.unlockedGroup).toBe(1);
    expect(again.save.settings.vol.master).toBe(0.4);
    expect(again.save.records['north-1'].best).toBe(200);
    // missing fields of an older v1 save are filled in
    kv.setItem(SAVE_KEY, JSON.stringify({ v: 1, seed: 5, settings: { assist: 'hardcore', difficulty: 'hard' } }));
    const partial = loadSave(kv);
    expect(partial.save.settings.assist).toBe('hardcore');
    expect(partial.save.settings.quality).toBe('default');
    // the rivals' fields of the old career game are dropped
    expect('seed' in partial.save).toBe(false);
    expect('difficulty' in partial.save.settings).toBe(false);
    // corrupt and future saves → new save + backup key
    kv.setItem(SAVE_KEY, '{not json');
    const bad = loadSave(kv, 1234);
    expect(bad.status).toBe('corrupt');
    expect(kv.getItem(BACKUP_PREFIX + 1234)).toBe('{not json');
    expect(bad.save.v).toBe(SAVE_VERSION);
    kv.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION + 5 }));
    expect(loadSave(kv, 1235).status).toBe('corrupt');
  });
  it('ghost storage evicts the oldest ghost when full and clearing removes save + ghosts', () => {
    class TinyKV extends MemoryKV { setItem(k: string, v: string) { let n = 0; for (let i = 0; i < this.length; i++) n += (this.getItem(this.key(i)!) ?? '').length; if (n + v.length > 300) throw new Error('quota'); super.setItem(k, v); } }
    const kv = new TinyKV();
    const g = (date: number) => ({ car: 'pipit', livery: 0, total: 100, date, data: 'x'.repeat(80) });
    expect(writeGhost(kv, 'a', g(1))).toBe(true);
    expect(writeGhost(kv, 'b', g(2))).toBe(true);
    expect(writeGhost(kv, 'c', g(3))).toBe(true);
    expect(readGhost(kv, 'a')).toBe(null);
    expect(readGhost(kv, 'c')?.date).toBe(3);
    writeSave(kv, { ...newSave(), records: {} });
    clearSave(kv);
    expect(kv.getItem(SAVE_KEY)).toBe(null);
    expect(kv.getItem(GHOST_PREFIX + 'c')).toBe(null);
  });
});

/** straight road along +x, then a 15 m semicircle back along -x at z = 30: a car can cut across the U */
function uStage() {
  const R = 15, L = 200;
  const pts: [number, number][] = [];
  for (let s = 0; s <= L; s += 1) pts.push([s, 0]);
  for (let a = 0; a <= Math.PI; a += 1 / R) pts.push([L + Math.sin(a) * R, R - Math.cos(a) * R]);
  for (let s = 1; s <= L; s += 1) pts.push([L - s, 2 * R]);
  const sAt: number[] = []; let acc = 0;
  pts.forEach((p, i) => { if (i) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]); sAt.push(acc); });
  return {
    startS: 10, finishS: acc - 20, length: acc - 30, cl: { length: acc },
    terrain: { edge2: 2 },
    trackS(x: number, z: number) {
      let bd = Infinity, bs = 0;
      pts.forEach((p, i) => { const d = Math.hypot(x - p[0], z - p[1]); if (d < bd) { bd = d; bs = sAt[i]; } });
      return { s: bs, dist: bd };
    },
    pointAt(s: number) { return { x: s, z: 0, dx: 1, dz: 0 }; },
  };
}

describe('session penalties', () => {
  it('false start: creeping over the line during the countdown costs 10 s (only when not held)', () => {
    const go = (hold: boolean) => {
      const w = new World(STAGES['north-1'], CARS.kestrel);
      w.holdAtStart = hold;
      const inp = { ...emptyInput(), throttle: 1 };
      while (w.session.time < 0.5) w.step(inp);
      return w.session;
    };
    const free = go(false);
    expect(free.falseStart).toBe(true);
    expect(free.penalties).toBe(FALSE_START_PENALTY);
    expect(free.log[0].kind).toBe('falsestart');
    const held = go(true);
    expect(held.falseStart).toBe(false);
    expect(held.penalties).toBe(0);
  });
  it('cutting across a U costs 15 s; a crash excursion that comes back does not', () => {
    const st = uStage();
    const car = { pos: new V3(), quat: { rotate: (_v: V3, out: V3) => out.set(0, 1, 0) }, speed: 20, events: { obstacleHit: 0 } };
    const run = (path: [number, number][]) => {
      const s = new Session(st as never);
      s.phase = 'running'; s.time = 1; s.progressS = path[0][0];
      for (const [x, z] of path) { car.pos.set(x, 0, z); s.update(car as never, 1 / 120); }
      return s;
    };
    // along the road to x=185, then straight across to (185, 30) — 30 m instead of ≈77 m of road
    const cut: [number, number][] = [];
    for (let x = 20; x <= 185; x += 0.5) cut.push([x, 0]);
    for (let z = 0; z <= 30; z += 0.5) cut.push([185, z]);
    for (let x = 185; x >= 150; x -= 0.5) cut.push([x, 30]);
    const a = run(cut);
    expect(a.cuts).toBe(1);
    expect(a.penalties).toBe(CUT_PENALTY);
    // off the road sideways and back to the same place
    const crash: [number, number][] = [];
    for (let x = 20; x <= 100; x += 0.5) crash.push([x, 0]);
    for (let z = 0; z <= 25; z += 0.5) crash.push([100 + z * 0.4, -z]);
    for (let z = 25; z >= 0; z -= 0.5) crash.push([110 + (25 - z) * 0.4, -z]);
    for (let x = 120; x <= 160; x += 0.5) crash.push([x, 0]);
    const b = run(crash);
    expect(b.cuts).toBe(0);
    expect(b.penalties).toBe(0);
  });
});

describe('catalogue', () => {
  it('lists six cars and four environment slots with the stages that exist', () => {
    const cars = listCars();
    expect(cars.map((c) => c.id)).toEqual(['pipit', 'wren', 'heron', 'shrike', 'kestrel', 'petrel']);
    expect(cars.every((c) => c.liveries.length === 3)).toBe(true);
    const envs = listEnvs();
    expect(envs.slice(0, 4).map((e) => e.art)).toEqual(['nordic', 'savanna', 'snow', 'coast']);
    expect(envs[0].available).toBe(true);
    const L = stageLength('north-1');
    expect(L).toBeGreaterThan(3000);
    expect(L).toBeLessThan(7500);
  });
});

describe('career', () => {
  it('a whole career with robot times for the player: medals, points, unlocks, champion', () => {
    const envs = listEnvs();
    // robot reference per car on north-1, scaled by length for the other stages (keeps the test fast)
    const base: Record<string, number> = {};
    const refLen = stageLength('north-1');
    for (const id of ['pipit', 'heron', 'kestrel']) base[id] = runReference(STAGES['north-1'], CARS[id], 0.9, false).total;
    const groupCar = ['pipit', 'heron', 'kestrel'];
    let unlocked = 0;
    const plan0 = buildSeason(0, envs, stageLength);
    expect(plan0.rallies.length).toBe(RALLIES_PER_SEASON);
    expect(plan0.rallies.every((r) => r.stages.length === STAGES_PER_RALLY)).toBe(true);
    const c = newCareer('pipit', 0, plan0);
    for (let season = 0; season < 3; season++) {
      const car = groupCar[season];
      while (!seasonOver(c)) {
        const r = startRally(c);
        for (let k = 0; k < STAGES_PER_RALLY; k++) {
          const sp = r.plan.stages[k];
          const ref = base[car] * (stageLength(sp.id, sp.reverse) / refLen);
          // the robot's own time: gold on the first stage, silver on the second, the third with 20 s of penalties
          const t = ref * (k === 0 ? 1 : k === 1 ? (MEDAL_RATIO.gold + MEDAL_RATIO.silver) / 2 : 1);
          const pen = k === 2 ? 20 : 0;
          const out = recordStage(c, { total: t + pen, penalties: pen }, ref);
          expect(out.total).toBeCloseTo(t + pen);
          expect(out.medal).toBe(k === 0 ? 'gold' : k === 1 ? 'silver' : medalFor(t + pen, ref));
          expect(out.points).toBe(out.medal ? MEDAL_POINTS[out.medal] : 0);
        }
        const pts = rallyPoints(r);
        const sum = finishRally(c);
        expect(sum.points).toBe(pts);
        expect(sum.medals.length).toBe(STAGES_PER_RALLY);
      }
      const end = finishSeason(c);
      expect(end.need).toBe(SEASON_UNLOCK_POINTS[season]);
      expect(end.qualified).toBe(true);
      if (end.unlockGroup !== null) {
        unlocked = end.unlockGroup;
        nextSeason(c, buildSeason(season + 1, envs, stageLength), groupCar[season + 1], 0);
        expect(c.season).toBe(season + 1);
        expect(c.points).toBe(0);
      } else expect(end.careerDone).toBe(true);
    }
    expect(unlocked).toBe(2);
    expect(c.champion).toBe(true);
    expect(c.history.length).toBe(3);
  });
  it('too few points keep the group locked; progress counts the rally in progress', () => {
    const envs: EnvInfo[] = listEnvs();
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    let n = 0;
    while (!seasonOver(c)) {
      const r = startRally(c);
      for (let k = 0; k < STAGES_PER_RALLY; k++) {
        // bronze on the first two stages of the season, then finishes without a medal
        recordStage(c, { total: n++ < 2 ? 100 * MEDAL_RATIO.bronze : 200, penalties: 0 }, 100);
        if (n === 2) expect(seasonProgress(c).points).toBe(2);
      }
      void r;
      finishRally(c);
    }
    const end = finishSeason(c);
    expect(end.points).toBe(2);
    expect(end.qualified).toBe(false);
    expect(end.unlockGroup).toBe(null);
    expect(seasonProgress(c).toGo).toBe(SEASON_UNLOCK_POINTS[0] - 2);
  });
  it('a career from the rivals era is kept (season, car) and its season starts again', () => {
    const old = {
      season: 1, rally: 2, car: 'heron', livery: 2, plan: {}, points: { player: 40, o01: 50 }, bestPos: { player: 2 },
      rallies: [{ env: 'north', name: 'x', positions: { player: 2 }, points: { player: 18 } }],
      current: { plan: {}, stage: 1, results: [{ times: { player: 100 }, accidents: [], playerPen: 0 }] },
      history: [{ season: 0, position: 2, points: 70 }], champion: false,
    };
    const c = normalizeCareer(old, (s) => buildSeason(s, listEnvs(), stageLength))!;
    expect(c.season).toBe(1); expect(c.car).toBe('heron'); expect(c.livery).toBe(2);
    expect(c.points).toBe(0); expect(c.rally).toBe(0); expect(c.rallies).toEqual([]); expect(c.current).toBe(null);
    expect(c.plan.rallies.length).toBe(RALLIES_PER_SEASON);
    expect(c.history).toEqual([{ season: 0, points: 0, qualified: true }]);
    // through the save loader too
    const kv = new MemoryKV();
    kv.setItem(SAVE_KEY, JSON.stringify({ v: 1, seed: 3, unlockedGroup: 1, career: old, settings: { difficulty: 'easy' } }));
    const s = loadSave(kv).save;
    expect(s.career?.season).toBe(1); expect(s.career?.points).toBe(0); expect(s.unlockedGroup).toBe(1);
    // a current-format career passes through unchanged
    expect(normalizeCareer(JSON.parse(JSON.stringify(c)), () => { throw new Error('no rebuild'); })).toEqual(c);
    expect(normalizeCareer('nonsense', () => buildSeason(0, listEnvs(), stageLength))).toBe(null);
  });
  it('a solo career saved with car damage and a service park: those fields are dropped, progress kept', () => {
    const c = newCareer('pipit', 0, buildSeason(0, listEnvs(), stageLength));
    startRally(c);
    recordStage(c, { total: 200, penalties: 0 }, 190);
    const raw = JSON.parse(JSON.stringify(c));
    Object.assign(raw.current, { damage: { engine: 0.3, tyres: [1, 0, 0, 0] }, serviceDone: false, servicePenalty: 0 });
    raw.current.results[0].servicePen = 0;
    const kv = new MemoryKV();
    kv.setItem(SAVE_KEY, JSON.stringify({ v: 1, career: raw, settings: { damage: false, damageScale: 1.5 } }));
    const s = loadSave(kv).save;
    expect(s.career?.current?.stage).toBe(1);
    expect(s.career?.current?.results[0].medal).toBe('silver');
    expect(s.career?.current && 'damage' in s.career.current).toBe(false);
    expect(s.career?.current?.results[0] && 'servicePen' in s.career.current.results[0]).toBe(false);
    expect('damage' in s.settings || 'damageScale' in s.settings).toBe(false);
  });
});
