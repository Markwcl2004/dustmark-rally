// Every stage of the catalogue, forward and reverse: buildable, 3–7 km, no self-intersection, pace notes consistent
// with the geometry, nothing standing on the road, no terrain cliffs at the road, weather variants resolve.
import { describe, expect, it } from 'vitest';
import { ENVS } from '../src/data/envs';
import { CATALOG, STAGES, resolveStage } from '../src/data/stages';
import { DS } from '../src/sim/stage/centerline';
import { GRADE_RADIUS } from '../src/sim/stage/script';
import { Stage } from '../src/sim/stage/stage';

const ready = CATALOG.flatMap((e) => e.stages).filter((s) => s.ready);

describe('stage catalogue', () => {
  it('lists 4 environments × 3 stages with unique ids', () => {
    expect(CATALOG.length).toBe(4);
    const ids = CATALOG.flatMap((e) => e.stages.map((s) => s.id));
    expect(ids.length).toBe(12);
    expect(new Set(ids).size).toBe(12);
    for (const e of CATALOG) for (const s of e.stages) expect(Object.keys(ENVS[e.id].weathers)).toEqual(s.weathers.map((w) => w.id));
  });
  it('every ready stage resolves in both directions and every weather', () => {
    for (const s of ready) for (const r of ['', '-r']) for (const w of s.weathers) {
      const d = resolveStage(s.id + r, w.id)!;
      expect(d).toBeTruthy();
      expect(d.reverse ?? false).toBe(r === '-r');
      expect(d.weather).toBe(w.id);
    }
  });
});

for (const info of ready) for (const reverse of [false, true]) {
  const id = info.id + (reverse ? '-r' : '');
  describe(`stage ${id} 「${info.name}」`, () => {
    const st = new Stage(STAGES[id]);
    it('is 3–7 km, matches the catalogue length and has no generator warnings', () => {
      expect(st.length).toBeGreaterThan(3000);
      expect(st.length).toBeLessThan(7000);
      expect(Math.abs(st.length / 1000 - info.lengthKm)).toBeLessThan(0.06);
      expect(st.cl.warnings).toEqual([]);
    });
    it('centerline has no self-intersection (hairpin legs excepted)', () => {
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
    it('pace notes agree with the geometry (direction and severity) and are ordered', () => {
      for (const n of st.notes.filter((x) => x.kind === 'turn')) {
        const piece = st.cl.pieces.find((p) => p.kind === 'turn' && p.s0 === n.s)!;
        expect(piece).toBeTruthy();
        const i0 = Math.round(piece.s0 / DS), i1 = Math.round(piece.s1 / DS);
        expect(Math.sign(st.cl.theta[i1] - st.cl.theta[i0])).toBe(n.dir === 'R' ? 1 : -1);
        let kmax = 0;
        for (let i = i0; i <= i1; i++) kmax = Math.max(kmax, Math.abs(st.cl.kappa[i]));
        const [lo, hi] = GRADE_RADIUS[String(n.grade)];
        expect(1 / kmax).toBeGreaterThan(lo * 0.8);
        expect(1 / kmax).toBeLessThan(hi * 1.8);
      }
      for (let i = 1; i < st.notes.length; i++) expect(st.notes[i].s).toBeGreaterThanOrEqual(st.notes[i - 1].s);
    });
    it('nothing solid stands on the road', () => {
      for (const p of st.props) {
        if (p.type === 'cabin' || p.type === 'house') continue;
        const q = st.terrain.nearest(p.x, p.z);
        if (q.found) expect(Math.abs(q.d)).toBeGreaterThan(st.def.halfWidth + 0.9);
      }
      for (const o of st.obstacles) {
        const q = st.terrain.nearest(o.x, o.z);
        if (q.found) expect(Math.abs(q.d) - o.r).toBeGreaterThan(st.def.halfWidth - 0.05);
      }
    });
    it('terrain is continuous across the road (no cliffs or cracks within 40 m)', () => {
      const cl = st.cl;
      for (let i = 10; i < cl.n - 10; i += 41) {
        const p = st.pointAt(i * DS);
        let prev = st.height(p.x - p.rx * 40, p.z - p.rz * 40);
        for (let d = -40; d <= 40; d += 0.5) {
          const h = st.height(p.x + p.rx * d, p.z + p.rz * d);
          expect(Math.abs(h - prev)).toBeLessThan(1.4);
          prev = h;
        }
      }
    });
  });
}
