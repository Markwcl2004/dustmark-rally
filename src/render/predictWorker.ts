// Web Worker for the trajectory prediction overlay: owns its own copy of the stage (built from the same def, so the
// same ground) and a Predictor; receives the car state snapshot + held input, returns the packed trajectory in the
// buffer it was handed (ping-pong transfer, nothing copied on the main thread).
import type { CarSpec } from '../data/cars';
import { STAGES } from '../data/stages';
import { getStage } from '../sim/stage/stage';
import { Car } from '../sim/vehicle/car';
import type { DriverInput } from '../sim/vehicle/controls';
import { Predictor, copyState, packTrajectory, stageOffRoad } from '../sim/vehicle/predict';

export type PredictWorkerIn =
  | { type: 'init'; stage: string; spec: CarSpec; horizon: number }
  | { type: 'predict'; state: object; input: DriverInput; tag: number; horizon: number; buf: ArrayBuffer };
export type PredictWorkerOut =
  | { type: 'ready'; ms: number }
  | { type: 'result'; buf: ArrayBuffer; ms: number }
  | { type: 'error'; message: string };

let pr: Predictor | null = null;
let src: Car | null = null;
const post = (m: PredictWorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<PredictWorkerIn>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const t0 = performance.now();
      const def = STAGES[m.stage];
      if (!def) throw new Error(`unknown stage ${m.stage}`);
      const st = getStage(def);
      src = new Car(m.spec);
      pr = new Predictor(src, st, { horizon: m.horizon, offRoad: stageOffRoad(st.terrain) });
      post({ type: 'ready', ms: performance.now() - t0 });
    } else if (m.type === 'predict' && pr && src) {
      const t0 = performance.now();
      copyState(src, m.state);
      pr.opts.horizon = m.horizon;
      const tr = pr.run(src, m.input, m.tag);
      packTrajectory(tr, new Float32Array(m.buf));
      post({ type: 'result', buf: m.buf, ms: performance.now() - t0 }, [m.buf]);
    }
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};
