// The whole in-car soundscape as one pure-TS DSP graph: engine + road/ambience, group gains, voice ducking and a
// soft limiter. The AudioWorklet runs exactly this; offline renders in Node run it too.
import { EngineSynth, type EngineSound, type EngineState } from './engine';
import { RoadSynth, type RoadInput } from './road';
import { Smooth } from './filters';

export interface MixGains { master: number; engine: number; ambient: number }

export class SoundDSP {
  readonly engine: EngineSynth;
  readonly road: RoadSynth;
  gains: MixGains = { master: 0.8, engine: 1, ambient: 1 };
  /** 1 while the co-driver speaks: engine/ambience dip */
  ducking = 0;
  /** how far the duck goes (gain while speaking) */
  duckDepth = 0.55;
  private duckS: Smooth;
  private eng: Float32Array;
  private amb: Float32Array;
  private env = 0;
  private envRel: number;

  constructor(sound: EngineSound, readonly sr: number, block = 128) {
    this.engine = new EngineSynth(sound, sr);
    this.road = new RoadSynth(sr);
    this.duckS = new Smooth(sr, 0.08, 1);
    this.eng = new Float32Array(block);
    this.amb = new Float32Array(block);
    this.envRel = Math.exp(-1 / (sr * 0.25));
  }

  setEngine(s: Partial<EngineState>) { Object.assign(this.engine.state, s); }
  setRoad(r: RoadInput) {
    const d = this.road.input;
    d.speed = r.speed; d.slide = r.slide; d.loose = r.loose; d.grounded = r.grounded;
    for (let i = 0; i < r.surfMix.length; i++) (d.surfMix as Float32Array)[i] = r.surfMix[i];
  }

  /** render n samples (n ≤ block) of mono into out (overwrites) */
  render(out: Float32Array, n: number) {
    if (this.eng.length < n) { this.eng = new Float32Array(n); this.amb = new Float32Array(n); }
    const e = this.eng, a = this.amb;
    e.fill(0, 0, n); a.fill(0, 0, n);
    this.engine.render(e, n, this.gains.engine);
    this.road.render(a, n, this.gains.ambient);
    const target = 1 - (1 - this.duckDepth) * this.ducking;
    const m = this.gains.master;
    for (let i = 0; i < n; i++) {
      const d = this.duckS.step(target);
      let y = (e[i] + a[i]) * d * m;
      // soft limiter: fast attack envelope, 250 ms release, knee at 0.7
      const ay = Math.abs(y);
      this.env = ay > this.env ? ay : this.env * this.envRel + ay * (1 - this.envRel);
      if (this.env > 0.7) y *= 0.7 / this.env + (1 - 0.7 / this.env) * 0.25;
      out[i] = y;
    }
  }
}
