// UI sounds, synthesised in a small AudioContext of their own (the game's AudioSystem in src/audio is not touched).
// The context is created on the first key / click / pad button (browser autoplay rule).
type Kind = 'move' | 'tick' | 'ok' | 'back' | 'deny' | 'start' | 'go' | 'penalty' | 'medal';

class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.6;

  constructor() {
    if (typeof window === 'undefined') return;
    const unlock = () => this.ensure();
    addEventListener('keydown', unlock, { capture: true });
    addEventListener('pointerdown', unlock, { capture: true });
  }

  /** create / resume the context (inside a user gesture) */
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.out = new GainNode(ctx, { gain: this.volume });
      const comp = new DynamicsCompressorNode(ctx, { threshold: -10, ratio: 6 });
      this.out.connect(comp).connect(ctx.destination);
      const n = ctx.sampleRate * 0.3;
      this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      let s = 1;
      for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1; }
    } catch { this.ctx = null; }
  }

  setVolume(v: number) { this.volume = v; if (this.out && this.ctx) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  private tone(t: number, f0: number, f1: number, dur: number, type: OscillatorType, gain: number) {
    const ctx = this.ctx!, o = new OscillatorNode(ctx, { type, frequency: f0 }), g = new GainNode(ctx, { gain: 0 });
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out!);
    o.start(t); o.stop(t + dur + 0.02);
  }

  private click(t: number, freq: number, dur: number, gain: number) {
    const ctx = this.ctx!, s = new AudioBufferSourceNode(ctx, { buffer: this.noise });
    const f = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: freq, Q: 2.5 }), g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.out!);
    s.start(t, Math.random() * 0.2); s.stop(t + dur + 0.02);
  }

  play(k: Kind) {
    if (!this.ctx || !this.out || this.volume <= 0) return;
    if (this.ctx.state !== 'running') { void this.ctx.resume(); }
    const t = this.ctx.currentTime + 0.005;
    switch (k) {
      case 'move': this.click(t, 2400, 0.035, 0.5); this.tone(t, 900, 820, 0.04, 'triangle', 0.05); break;
      case 'tick': this.click(t, 3200, 0.025, 0.45); break;
      case 'ok': this.tone(t, 523, 523, 0.07, 'square', 0.07); this.tone(t + 0.06, 784, 790, 0.12, 'square', 0.07); this.click(t, 1500, 0.05, 0.4); break;
      case 'back': this.tone(t, 620, 400, 0.12, 'triangle', 0.12); this.click(t, 900, 0.05, 0.3); break;
      case 'deny': this.tone(t, 150, 120, 0.16, 'sawtooth', 0.06); break;
      case 'start': for (const [i, f] of [392, 523, 659, 784].entries()) this.tone(t + i * 0.07, f, f, 0.18, 'square', 0.06); break;
      case 'go': this.tone(t, 880, 880, 0.3, 'square', 0.06); break;
      case 'penalty': this.tone(t, 330, 220, 0.25, 'sawtooth', 0.07); this.tone(t + 0.12, 330, 200, 0.25, 'sawtooth', 0.06); break;
      case 'medal': for (const [i, f] of [659, 784, 1047].entries()) this.tone(t + i * 0.09, f, f, 0.35, 'triangle', 0.09); break;
    }
  }
}

export const sfx = new Sfx();
