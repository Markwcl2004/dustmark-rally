import { describe, expect, it } from 'vitest';
import { CARS } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { runBot } from '../src/sim/driver/run';

describe('robot driver', () => {
  const analog = runBot(STAGES['north-1'], CARS.kestrel, 0.9);
  it('finishes 镜湖林场 without resets or impacts at skill 0.9', () => {
    expect(analog.finished).toBe(true);
    expect(analog.resets).toBe(0);
    expect(analog.impacts).toBe(0);
    expect(analog.rollovers).toBe(0);
    expect(analog.time).toBeGreaterThan(120);
    expect(analog.time).toBeLessThan(270);
  });
  it('keyboard robot (0/1 keys, 0.1 s reaction, standard assists) finishes clean within +12 % of the analog robot', () => {
    const k = runBot(STAGES['north-1'], CARS.kestrel, 0.9, { keys: true });
    expect(k.finished).toBe(true);
    expect(k.resets).toBe(0);
    expect(k.impacts).toBe(0);
    expect(k.rollovers).toBe(0);
    expect(k.total / analog.total).toBeLessThanOrEqual(1.12);
  });
});
