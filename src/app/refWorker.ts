// Web Worker: runs the reference robot (skill 0.9) through the stage so the HUD can show split deltas.
import { CARS } from '../data/cars';
import { STAGES } from '../data/stages';
import { refTimes } from '../sim/driver/run';

self.onmessage = (e: MessageEvent<{ stage: string; car: string }>) => {
  const r = refTimes(STAGES[e.data.stage], CARS[e.data.car], 0.9);
  (self as unknown as Worker).postMessage({ step: r.step, times: r.times, total: r.total }, [r.times.buffer]);
};
