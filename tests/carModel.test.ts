// Car generator: every car × livery builds without DOM, stays inside the triangle budget, has sane geometry,
// and the tyres fit inside the arches/flares.
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/data/cars';
import { CAR_IDS, CAR_VISUALS, carVisual } from '../src/data/carVisuals';
import { buildCarGeometry, frameOf } from '../src/render/carModel';

describe('car visuals', () => {
  it('six cars with three liveries each, fictional names', () => {
    expect(CAR_IDS.length).toBe(6);
    const names = new Set<string>();
    for (const id of CAR_IDS) {
      const v = CAR_VISUALS[id];
      expect(v.id).toBe(id);
      expect(v.liveries.length).toBe(3);
      names.add(v.model);
      expect(new Set(v.liveries.map((l) => l.pattern)).size).toBe(3); // three different graphic patterns per car
    }
    expect(names.size).toBe(6);
    expect(carVisual('kestrel-fwd').id).toBe('kestrel');
  });

  for (const id of CAR_IDS) {
    it(`${id}: geometry within budget and well-formed`, () => {
      const v = CAR_VISUALS[id];
      const frame = frameOf(CARS[id], v);
      for (const L of v.liveries) {
        const g = buildCarGeometry(v, frame, L, 0);
        expect(g.triangles).toBeLessThanOrEqual(20000);
        const lo = buildCarGeometry(v, frame, L, 1);
        expect(lo.triangles).toBeLessThan(g.triangles * 0.6);
        for (const geo of [g.body, g.glass, g.pod, g.wheel]) {
          const p = geo.attributes.position.array as Float32Array, n = geo.attributes.normal.array as Float32Array;
          for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i])).toBe(true);
          for (let i = 0; i < n.length; i += 3) expect(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1)).toBeLessThan(1e-3);
        }
        const bb = g.body.boundingBox!;
        expect(bb.min.y).toBeGreaterThan(-0.01); // nothing below the ground at rest
        expect(bb.max.y).toBeLessThan(v.body.roofH + 0.5); // antenna is the tallest part
      }
      // tyres stay inside the flares and under the arches
      const S = buildCarGeometry(v, frame, v.liveries[0]).shape;
      const tyreOuter = Math.max(frame.trackF, frame.trackR) / 2 + frame.wheelW / 2;
      expect(S.xFlare).toBeGreaterThan(tyreOuter);
      expect(S.archY(0, 0)).toBeGreaterThan(2 * frame.wheelR + 0.02);
    });
  }

  it('glass and body share the greenhouse (glass exists, sits above the beltline)', () => {
    const v = CAR_VISUALS.kestrel;
    const g = buildCarGeometry(v, frameOf(CARS.kestrel, v), v.liveries[0]);
    expect(g.glass.attributes.position.count).toBeGreaterThan(100);
    expect(g.glass.boundingBox!.min.y).toBeGreaterThan(v.body.belt - 0.05);
  });
});
