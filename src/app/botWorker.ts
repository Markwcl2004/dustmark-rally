// Web Worker: one robot reference run (stage variant × car; analog robot 0.9) → total time + split curve. Only used
// when the precomputed table (botTimes.json) has no entry for the current sim sources.
import { CARS } from '../data/cars';
import { stageDef } from '../sim/rally/catalog';
import { runReference } from '../sim/rally/botTimes';

export interface BotJob { id: number; stage: string; reverse: boolean; weather: string; car: string; skill: number }

self.onmessage = (e: MessageEvent<BotJob>) => {
  const j = e.data;
  try {
    const def = stageDef(j.stage, j.reverse, j.weather);
    const spec = CARS[j.car];
    if (!def || !spec) throw new Error(`no stage/car ${j.stage}/${j.car}`);
    const r = runReference(def, spec, j.skill);
    (self as unknown as Worker).postMessage({ id: j.id, ok: true, run: r });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: j.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
