// AudioWorklet processor: runs the pure-TS SoundDSP on the audio thread. The game posts telemetry ~60×/s.
import type { EngineSound, EngineState } from './dsp/engine';
import { SoundDSP, type MixGains } from './dsp/mix';
import type { RoadInput } from './dsp/road';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown); }

export type WorkletMsg =
  | { t: 'state'; engine: Partial<EngineState>; road: RoadInput; duck: number }
  | { t: 'impact'; kind: 'land' | 'bottom' | 'hit'; v: number }
  | { t: 'splash'; v: number }
  | { t: 'cheer'; v: number }
  | { t: 'gains'; gains: Partial<MixGains> }
  | { t: 'sound'; sound: EngineSound };

class DustmarkSound extends AudioWorkletProcessor {
  private dsp: SoundDSP;
  constructor(options: { processorOptions: { sound: EngineSound } }) {
    super();
    this.dsp = new SoundDSP(options.processorOptions.sound, sampleRate, 128);
    this.port.onmessage = (e: MessageEvent<WorkletMsg>) => {
      const m = e.data, d = this.dsp;
      if (m.t === 'state') { d.setEngine(m.engine); d.setRoad(m.road); d.ducking = m.duck; }
      else if (m.t === 'impact') d.road.impact(m.kind, m.v);
      else if (m.t === 'splash') d.road.splash(m.v);
      else if (m.t === 'cheer') d.road.cheer(m.v);
      else if (m.t === 'gains') Object.assign(d.gains, m.gains);
      else if (m.t === 'sound') this.dsp = new SoundDSP(m.sound, sampleRate, 128);
    };
  }
  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const ch0 = out[0];
    this.dsp.render(ch0, ch0.length);
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('dustmark-sound', DustmarkSound);
