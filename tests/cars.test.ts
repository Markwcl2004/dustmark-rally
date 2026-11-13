// The six cars (DESIGN §6): roster consistent with the visuals, every handling probe passes (standard assists),
// drive-layout character holds, and the robot can drive each of them.
import { describe, expect, it } from 'vitest';
import { CAR_LIST, CAR_ORDER, CARS } from '../src/data/cars';
import { CAR_SOUNDS } from '../src/data/carSounds';
import { CAR_IDS, carVisual } from '../src/data/carVisuals';
import { PROBES } from '../src/sim/vehicle/probes';

describe('six-car roster', () => {
  it('ids match the car models, every car has physics, a roster entry and an engine sound', () => {
    expect([...CAR_ORDER].sort()).toEqual([...CAR_IDS].sort());
    for (const id of CAR_ORDER) {
      expect(CARS[id]?.id).toBe(id);
      expect(CAR_SOUNDS[id]).toBeTruthy();
      expect(carVisual(id).drive).toBe(CARS[id].drive);
    }
    expect(CAR_LIST.map((c) => c.id)).toEqual([...CAR_ORDER]);
    for (const c of CAR_LIST) {
      expect(c.name && c.model && c.group && c.personality && c.driveCn).toBeTruthy();
      expect(c.zeroTo100).toBeGreaterThan(3);
      expect(c.topKmh).toBeGreaterThan(150);
    }
  });
});

describe('handling probes, all six cars (standard assists)', () => {
  for (const id of CAR_ORDER) {
    it(`${id}: all probes pass`, () => {
      for (const [name, p] of Object.entries(PROBES)) {
        const r = p(CARS[id]);
        expect(r.pass, `${id} ${name}: ${r.summary}`).toBe(true);
      }
    });
  }
  it('drive-layout character: front drive pushes on power, rear drive steps out, the turbo five lags', () => {
    const ch = Object.fromEntries(CAR_ORDER.map((id) => [id, PROBES.character(CARS[id]).data]));
    expect(ch.pipit.curvRatio as number).toBeLessThan(0.97);
    expect((ch.heron.maxSlip as number) - (ch.heron.slip0 as number)).toBeGreaterThan(6);
    expect(ch.shrike.t50 as number).toBeGreaterThan(0.2);
    expect(ch.kestrel.t50 as number).toBeLessThan(0.1);
    // the short-wheelbase car rotates more on a lift than the long one
    expect(ch.petrel.tuck as number).toBeGreaterThan(ch.kestrel.tuck as number);
  });
});
