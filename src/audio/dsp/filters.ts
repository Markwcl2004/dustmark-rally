// Small DSP building blocks (pure TS: runs in the AudioWorklet and in Node for offline renders).

/** RBJ biquad, direct form I, coefficients updatable per block */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(readonly sr: number) {}

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  lowpass(f: number, q = 0.707) {
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); return this;
  }
  highpass(f: number, q = 0.707) {
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); return this;
  }
  /** constant 0 dB peak gain bandpass */
  bandpass(f: number, q = 1) {
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set(al, 0, -al, 1 + al, -2 * c, 1 - al); return this;
  }
  peaking(f: number, q: number, db: number) {
    const A = Math.pow(10, db / 40), w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A); return this;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/** one-pole lowpass / smoother */
export class OnePole {
  y = 0;
  private a: number;
  constructor(readonly sr: number, f: number) { this.a = 1 - Math.exp((-2 * Math.PI * f) / sr); }
  setFreq(f: number) { this.a = 1 - Math.exp((-2 * Math.PI * f) / this.sr); return this; }
  run(x: number) { this.y += (x - this.y) * this.a; return this.y; }
}

/** deterministic white noise (xorshift) so offline renders are reproducible */
export class Noise {
  private s: number;
  constructor(seed = 0x2545f491) { this.s = seed | 0 || 1; }
  /** uniform -1..1 */
  next() {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x;
    return (x | 0) / 2147483648;
  }
  /** uniform 0..1 */
  u() { return this.next() * 0.5 + 0.5; }
}

/** smoothed parameter: per-sample exponential approach (time constant tau seconds) */
export class Smooth {
  v: number;
  private k: number;
  constructor(sr: number, tau: number, v = 0) { this.v = v; this.k = 1 - Math.exp(-1 / (sr * tau)); }
  setTau(sr: number, tau: number) { this.k = 1 - Math.exp(-1 / (sr * tau)); }
  step(target: number) { this.v += (target - this.v) * this.k; return this.v; }
}

export const softClip = (x: number) => (x > 1.5 ? 1 : x < -1.5 ? -1 : x - (4 / 27) * x * x * x);
export const dbToGain = (db: number) => Math.pow(10, db / 20);
