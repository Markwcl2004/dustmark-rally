// Engine sound synthesis: a firing-pulse model rather than plain oscillators.
// Each cylinder firing launches a short exhaust pulse (slightly uneven per cylinder, with cycle-to-cycle jitter);
// the pulse train excites a fixed bank of exhaust resonances, is saturated and low-passed by load. Because the
// resonances stay put while the firing rate moves, the harmonics sweep through formants the way a real exhaust does,
// which is what keeps it from sounding like a buzzing oscillator. On top: intake roar, turbo whistle + blow-off,
// overrun pops/crackle, ignition cut on shifts and at the limiter, straight-cut gearbox whine.
import { Biquad, Noise, OnePole, Smooth, softClip } from './filters';

export interface EngineSound {
  cylinders: number;
  /** exhaust pulse decay (ms) */
  pulseMs: number;
  /** per-cylinder pulse strength (unevenness → half-order "rasp") */
  cylGain: number[];
  /** cycle-to-cycle amplitude jitter 0..0.3 */
  jitter: number;
  /** exhaust resonances [Hz, Q, gain] */
  exhaust: [number, number, number][];
  /** direct (unresonated) share of the pulse */
  direct: number;
  /** saturation drive */
  drive: number;
  /** tone low-pass at overrun / full load (Hz) */
  toneOff: number;
  toneOn: number;
  /** intake roar: centre as a multiple of the firing frequency, gain */
  intakeMul: number;
  intakeGain: number;
  /** turbo: whistle Hz at no boost / full boost, whistle gain, blow-off gain (0 = NA engine) */
  whistleLo: number;
  whistleHi: number;
  whistleGain: number;
  bovGain: number;
  /** overrun pops 0..1 */
  pops: number;
  /** straight-cut gearbox whine: Hz per m/s of road speed, gain */
  whineHzPerMs: number;
  whineGain: number;
  /** limiter stutter rate (Hz) */
  limiterHz: number;
  /** overall level */
  level: number;
  /** optional per-cylinder firing-interval offsets (fraction of the even interval, sums ~0): an uneven beat, e.g. a
   *  five's off-beat warble or a cross-plane burble */
  fireOffset?: number[];
}

export interface EngineState {
  rpm: number;
  /** -1 (overrun) .. 1 (full load) */
  load: number;
  /** pedal after traction control 0..1 */
  throttle: number;
  /** turbo boost 0..1 */
  boost: number;
  /** ignition cut (gear change) */
  shiftCut: boolean;
  /** rev limiter active */
  limiter: boolean;
  /** road speed m/s (gear whine) */
  speed: number;
  /** 0..1 how much the engine is audible from the camera (hood cam louder intake etc.) — reserved */
  redline: number;
}

export const defaultEngineState = (): EngineState => ({ rpm: 900, load: 0, throttle: 0, boost: 0, shiftCut: false, limiter: false, speed: 0, redline: 7200 });

export class EngineSynth {
  private ph = 0;
  private nextFire = 0;
  private cyl = 0;
  private env = 0;
  private envK: number;
  private popEnv = 0;
  private crackEnv = 0;
  private bovEnv = 0;
  private bovPh = 0;
  private whPh = 0;
  private whinePh = 0;
  private limPh = 0;
  private overrunT = 0;
  private prevThr = 0;
  private thrHist = 0;
  private res: Biquad[];
  private tone: Biquad;
  private tone2: Biquad;
  private dc: Biquad;
  private intake: Biquad;
  private crackBp: Biquad;
  private bovBp: Biquad;
  private nzLp: OnePole;
  private noise = new Noise(0x1234567);
  private rpmS: Smooth; private loadS: Smooth; private boostS: Smooth; private thrS: Smooth; private spdS: Smooth;
  private cutS: Smooth;
  state: EngineState = defaultEngineState();
  /** count of pops this render (for tests/diagnostics) */
  pops = 0;

  constructor(readonly p: EngineSound, readonly sr: number) {
    this.envK = Math.exp(-1 / ((p.pulseMs / 1000) * sr));
    this.res = p.exhaust.map(([f, q]) => new Biquad(sr).bandpass(f, q));
    this.tone = new Biquad(sr).lowpass(2000, 0.6);
    this.tone2 = new Biquad(sr).lowpass(2000, 0.6);
    this.dc = new Biquad(sr).highpass(35, 0.7);
    this.intake = new Biquad(sr).bandpass(600, 1.6);
    this.crackBp = new Biquad(sr).bandpass(1800, 0.9);
    this.bovBp = new Biquad(sr).bandpass(3000, 1.4);
    this.nzLp = new OnePole(sr, 2500);
    this.rpmS = new Smooth(sr, 0.012, 900);
    this.loadS = new Smooth(sr, 0.03, 0);
    this.boostS = new Smooth(sr, 0.06, 0);
    this.thrS = new Smooth(sr, 0.02, 0);
    this.spdS = new Smooth(sr, 0.05, 0);
    this.cutS = new Smooth(sr, 0.004, 0);
  }

  /** render n samples, adding into out */
  render(out: Float32Array, n: number, gain = 1) {
    const p = this.p, st = this.state, sr = this.sr, nz = this.noise;
    // control-rate updates (per block)
    const thrDrop = this.prevThr - st.throttle;
    this.prevThr = st.throttle;
    this.thrHist = Math.max(this.thrHist * Math.exp(-n / (sr * 0.12)), thrDrop);
    if (this.thrHist > 0.45 && this.boostS.v > 0.4 && this.bovEnv < 0.2 && p.bovGain > 0) { this.bovEnv = this.boostS.v; this.bovPh = 0; this.thrHist = 0; }
    if (st.load < -0.05 && st.throttle < 0.05) this.overrunT += n / sr; else this.overrunT = 0;
    const loadPos = Math.max(0, this.loadS.v);
    const toneF = p.toneOff + (p.toneOn - p.toneOff) * Math.min(1, loadPos * 1.2) + this.rpmS.v * 0.12;
    this.tone.lowpass(toneF, 0.55); this.tone2.lowpass(toneF * 1.6, 0.5);
    const fire = (this.rpmS.v / 60) * (p.cylinders / 2);
    this.intake.bandpass(Math.min(3000, Math.max(250, fire * p.intakeMul)), 1.4);
    const bovF = 3600 - 1600 * Math.min(1, this.bovPh * 3);
    this.bovBp.bandpass(bovF, 1.3);
    const cyl = p.cylinders;
    const redline = st.redline;

    for (let i = 0; i < n; i++) {
      const rpm = this.rpmS.step(st.rpm), load = this.loadS.step(st.load), boost = this.boostS.step(st.boost);
      const thr = this.thrS.step(st.throttle), spd = this.spdS.step(st.speed);
      const lp = Math.max(0, load);
      // ignition cut: shift cut, or limiter stutter
      let cut = st.shiftCut;
      if (st.limiter) { this.limPh += p.limiterHz / sr; if (this.limPh > 1) this.limPh -= 1; if (this.limPh < 0.5) cut = true; }
      const cutAmt = this.cutS.step(cut ? 1 : 0);
      // advance the 4-stroke cycle (two crank revolutions); fire every 1/cyl of a cycle
      this.ph += rpm / 60 / 2 / sr;
      if (this.ph >= this.nextFire) {
        const c = this.cyl;
        this.cyl = (this.cyl + 1) % cyl;
        const jit = 1 + p.jitter * nz.next();
        let a = p.cylGain[c % p.cylGain.length] * jit * (0.32 + 0.68 * lp) * (1 + 0.25 * thr);
        if (cutAmt > 0.5) a *= 0.04;
        // overrun: lean burble, occasional pops (more just after a lift from high revs)
        // idle: a light steady load (lumpy, not silent)
        const idle = rpm < 1500 && thr < 0.05;
        if (idle) a *= 1.6;
        else if (load < 0.02) {
          a *= 0.55;
          const hot = Math.min(1, rpm / 6500) * Math.exp(-this.overrunT * 0.9);
          if (nz.u() < p.pops * 0.16 * hot + (cutAmt > 0.5 ? p.pops * 0.05 : 0)) { this.popEnv = 1.6 + nz.u() * 1.8; this.crackEnv = 1; this.pops++; }
        }
        this.env += a;
        // timing jitter keeps the pulse train from being perfectly periodic
        const off = p.fireOffset ? p.fireOffset[c % p.fireOffset.length] : 0;
        this.nextFire = this.ph + (1 / cyl) * (1 + off + 0.004 * nz.next());
        if (this.ph > 1e6) { this.ph -= 1e6; this.nextFire -= 1e6; }
      }
      const rasp = this.nzLp.run(nz.next());
      const e = this.env * (0.75 + 0.5 * rasp) + this.popEnv * (0.6 + 0.6 * rasp);
      this.env *= this.envK;
      this.popEnv *= this.envK * 0.985;
      // exhaust resonances
      let y = e * p.direct;
      for (let k = 0; k < this.res.length; k++) y += this.res[k].run(e) * p.exhaust[k][2];
      y = softClip(y * p.drive) / p.drive;
      y = this.tone2.run(this.tone.run(y));
      // intake roar (pulsed by firing)
      y += this.intake.run(nz.next()) * p.intakeGain * (0.15 + 0.85 * thr) * Math.min(1, rpm / redline + 0.2) * (0.6 + 0.8 * this.env);
      // pop crackle
      if (this.crackEnv > 0.001) { y += this.crackBp.run(nz.next()) * this.crackEnv * 0.9; this.crackEnv *= 0.9965; }
      // turbo whistle and blow-off
      if (p.whistleGain > 0) {
        this.whPh += (p.whistleLo + (p.whistleHi - p.whistleLo) * boost) / sr;
        if (this.whPh > 1) this.whPh -= 1;
        y += Math.sin(2 * Math.PI * this.whPh) * p.whistleGain * boost * boost * Math.min(1, rpm / 4500);
      }
      if (this.bovEnv > 0.001) {
        y += this.bovBp.run(nz.next()) * this.bovEnv * p.bovGain;
        this.bovEnv *= 0.99984 - 0.0001 * Math.min(1, this.bovPh * 4);
        this.bovPh += 1 / sr;
      }
      // gearbox whine
      if (p.whineGain > 0 && spd > 1) {
        this.whinePh += (spd * p.whineHzPerMs) / sr;
        if (this.whinePh > 1) this.whinePh -= 1;
        y += Math.sin(2 * Math.PI * this.whinePh) * p.whineGain * (0.35 + 0.65 * Math.abs(load)) * Math.min(1, spd / 15);
      }
      out[i] += this.dc.run(y) * p.level * gain;
    }
  }
}
