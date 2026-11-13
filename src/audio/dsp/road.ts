// Road / tyre / impact / ambience synthesis (pure TS).
//  - rolling noise per surface: gravel hiss + grit grains, asphalt low hum + tread tone, grass swish, snow crunch,
//    mud/water slosh; level and colour follow speed
//  - tyre slide: gravel/snow → louder hiss and spray; asphalt → narrow-band squeal
//  - stones on the underbody: random short ringing clicks (rate ∝ speed × looseness × slip)
//  - one-shots from a fixed voice pool: thumps (landing / bump-stop / impact, light → heavy), splash, crowd cheer
//  - wind rush with speed
import { SURFACE_COUNT, Surface } from '../../data/surfaces';
import { Biquad, Noise, OnePole, Smooth } from './filters';

export interface RoadInput {
  speed: number;
  surfMix: ArrayLike<number>;
  slide: number;
  loose: number;
  grounded: number;
}

const NS = SURFACE_COUNT;

/** a pooled one-shot voice: noise burst through a resonator + a low sine thump */
class Shot {
  active = false;
  t = 0;
  dur = 0;
  amp = 0;
  thumpF = 60;
  thumpAmp = 0;
  noiseAmp = 0;
  ringF = [0, 0, 0];
  ringAmp = 0;
  bp: Biquad;
  lp: Biquad;
  kind: 'thump' | 'clunk' | 'splash' | 'stone' = 'thump';
  constructor(sr: number) { this.bp = new Biquad(sr).bandpass(800, 1); this.lp = new Biquad(sr).lowpass(1200); }
}

export class RoadSynth {
  private noise = new Noise(0x77aa13);
  private bed: { bp: Biquad; lp: Biquad; hp: Biquad; gain: Smooth }[] = [];
  private gritBp: Biquad;
  private grainEnv = 0;
  private squealPh = 0;
  private squealBp: Biquad;
  private slideBp: Biquad;
  private windLp: Biquad;
  private windHp: Biquad;
  private humLp: Biquad;
  private treadPh = 0;
  private speedS: Smooth; private slideS: Smooth; private looseS: Smooth; private gndS: Smooth;
  private mixS: Smooth[] = [];
  private shots: Shot[] = [];
  private stoneAcc = 0;
  // crowd
  private crowdAmp = 0;
  private crowdT = 0;
  private crowdBp: Biquad[];
  private crowdLfo = 0;
  private crowdMod: OnePole;
  input: RoadInput = { speed: 0, surfMix: new Float32Array(NS), slide: 0, loose: 0, grounded: 0 };

  constructor(readonly sr: number) {
    for (let s = 0; s < NS; s++) this.bed.push({ bp: new Biquad(sr), lp: new Biquad(sr), hp: new Biquad(sr), gain: new Smooth(sr, 0.08) });
    this.gritBp = new Biquad(sr).bandpass(3200, 1.2);
    this.squealBp = new Biquad(sr).bandpass(1150, 18);
    this.slideBp = new Biquad(sr).bandpass(1800, 0.8);
    this.windLp = new Biquad(sr).lowpass(500, 0.6);
    this.windHp = new Biquad(sr).highpass(90, 0.7);
    this.humLp = new Biquad(sr).lowpass(220, 0.8);
    this.speedS = new Smooth(sr, 0.05); this.slideS = new Smooth(sr, 0.04); this.looseS = new Smooth(sr, 0.1); this.gndS = new Smooth(sr, 0.02);
    for (let s = 0; s < NS; s++) this.mixS.push(new Smooth(sr, 0.12));
    for (let i = 0; i < 12; i++) this.shots.push(new Shot(sr));
    this.crowdBp = [new Biquad(sr).bandpass(450, 1.2), new Biquad(sr).bandpass(1100, 1.5), new Biquad(sr).bandpass(2400, 2)];
    this.crowdMod = new OnePole(sr, 6);
  }

  private shot(): Shot {
    let best = this.shots[0];
    for (const s of this.shots) { if (!s.active) return s; if (s.amp * (1 - s.t / s.dur) < best.amp * (1 - best.t / best.dur)) best = s; }
    return best;
  }

  /** landing / bump-stop / collision thump; strength in m/s of closing speed */
  impact(kind: 'land' | 'bottom' | 'hit', strength: number) {
    if (strength < 0.4) return;
    const s = this.shot(), nz = this.noise;
    s.active = true; s.t = 0;
    const k = Math.min(1, strength / (kind === 'hit' ? 10 : 7));
    if (kind === 'bottom') {
      s.kind = 'clunk'; s.dur = 0.22; s.amp = 0.35 + 0.5 * k; s.thumpF = 75; s.thumpAmp = 0.6; s.noiseAmp = 0.25;
      s.ringF = [310 + nz.u() * 40, 690 + nz.u() * 60, 1290 + nz.u() * 90]; s.ringAmp = 0.35;
      s.bp.bandpass(900, 1.2);
    } else if (kind === 'land') {
      s.kind = 'thump'; s.dur = 0.35 + 0.2 * k; s.amp = 0.3 + 0.7 * k; s.thumpF = 52 + 10 * nz.u(); s.thumpAmp = 1; s.noiseAmp = 0.35 + 0.3 * k;
      s.ringF = [180, 420, 0]; s.ringAmp = 0.15;
      s.bp.bandpass(500, 0.8);
    } else {
      // collision: light knock … heavy crunch
      s.kind = 'thump'; s.dur = 0.25 + 0.45 * k; s.amp = 0.35 + 0.65 * k; s.thumpF = 70 - 20 * k; s.thumpAmp = 0.8; s.noiseAmp = 0.5 + 0.6 * k;
      s.ringF = [240 + nz.u() * 80, 560 + nz.u() * 120, 1450 + nz.u() * 300]; s.ringAmp = 0.25 + 0.3 * k;
      s.bp.bandpass(1400 - 600 * k, 0.7);
      if (k > 0.55) {
        // a big one: torn metal (a second, rougher crunch) and breaking glass / lamp tinkle
        const c = this.shot();
        c.active = true; c.t = 0; c.kind = 'thump'; c.dur = 0.5; c.amp = 0.5 * k; c.thumpF = 38; c.thumpAmp = 0.4; c.noiseAmp = 1;
        c.ringF = [410 + nz.u() * 90, 930 + nz.u() * 200, 2100 + nz.u() * 500]; c.ringAmp = 0.45; c.bp.bandpass(700, 0.5); c.lp.lowpass(4000);
        for (let g = 0; g < 3; g++) {
          const t = this.shot();
          t.active = true; t.t = -0.03 - 0.05 * g - nz.u() * 0.04; t.kind = 'stone'; t.dur = 0.09 + nz.u() * 0.08; t.amp = 0.12 + 0.12 * k;
          t.thumpAmp = 0; t.noiseAmp = 0.6; t.ringF = [3800 + nz.u() * 2400, 6100 + nz.u() * 1800, 0]; t.ringAmp = 0.9;
          t.bp.bandpass(5200, 2.5); t.lp.lowpass(11000);
        }
      }
    }
    s.lp.lowpass(2500 + 3000 * k);
  }

  /** water splash (interface for M3 fords) */
  splash(strength: number) {
    const s = this.shot();
    s.active = true; s.t = 0; s.kind = 'splash'; s.dur = 0.8 + strength * 0.6; s.amp = 0.4 + 0.5 * Math.min(1, strength);
    s.thumpF = 45; s.thumpAmp = 0.3; s.noiseAmp = 1; s.ringAmp = 0; s.bp.bandpass(900, 0.6); s.lp.lowpass(3500);
  }

  /** crowd cheer swell (0..1) */
  cheer(intensity: number) {
    this.crowdAmp = Math.max(this.crowdAmp, Math.min(1, intensity));
    this.crowdT = 0;
  }

  render(out: Float32Array, n: number, gain = 1) {
    const inp = this.input, nz = this.noise, sr = this.sr;
    const sp = this.speedS.v;
    // control-rate filter tuning per surface (speed brightens)
    const b = this.bed;
    b[Surface.Gravel].bp.bandpass(1600 + sp * 40, 0.7); b[Surface.Gravel].hp.highpass(500);
    b[Surface.Dirt].bp.bandpass(1100 + sp * 30, 0.7); b[Surface.Dirt].hp.highpass(300);
    b[Surface.AsphaltDry].bp.bandpass(380 + sp * 8, 0.8); b[Surface.AsphaltDry].hp.highpass(60);
    b[Surface.AsphaltWet].bp.bandpass(2600, 0.6); b[Surface.AsphaltWet].hp.highpass(800);
    b[Surface.Grass].bp.bandpass(900, 0.9); b[Surface.Grass].hp.highpass(250);
    b[Surface.Snow].bp.bandpass(520, 1.1); b[Surface.Snow].hp.highpass(120);
    b[Surface.Ice].bp.bandpass(2200, 0.8); b[Surface.Ice].hp.highpass(700);
    b[Surface.Mud].bp.bandpass(380, 0.9); b[Surface.Mud].hp.highpass(80);
    b[Surface.Water].bp.bandpass(700, 0.6); b[Surface.Water].hp.highpass(150);
    b[Surface.DeepSnow].bp.bandpass(420, 1.0); b[Surface.DeepSnow].hp.highpass(90);
    const BED_GAIN = [0.07, 0.09, 0.16, 0.14, 0.12, 0.1, 0.13, 0.05, 0.16, 0.15];
    const SLIDE_TONAL = [1, 0.7, 0, 0, 0, 0, 0, 0.2, 0, 0];
    this.windLp.lowpass(250 + sp * 9, 0.6);
    this.crowdLfo += n / sr;
    if (this.crowdAmp > 0) { this.crowdT += n / sr; if (this.crowdT > 2.5) this.crowdAmp *= Math.exp((-n / sr) * 0.9); if (this.crowdAmp < 0.002) this.crowdAmp = 0; }
    const shots = this.shots;

    for (let i = 0; i < n; i++) {
      const v = this.speedS.step(inp.speed), sl = this.slideS.step(inp.slide), ls = this.looseS.step(inp.loose);
      const gnd = this.gndS.step(inp.grounded / 4);
      const roll = Math.min(1.4, Math.pow(v / 30, 0.8)) * gnd;
      let y = 0;
      const w = nz.next();
      // rolling beds (shared white noise, different colours)
      let tonal = 0;
      for (let s = 0; s < NS; s++) {
        const m = this.mixS[s].step(inp.surfMix[s] ?? 0);
        const g = b[s].gain.step(m * BED_GAIN[s] * roll);
        if (g > 1e-5) y += b[s].hp.run(b[s].bp.run(w)) * g;
        tonal += m * SLIDE_TONAL[s];
      }
      // asphalt hum + tread tone
      if (tonal > 0.01 && v > 1) {
        this.treadPh += (v * 7.5) / sr; if (this.treadPh > 1) this.treadPh -= 1;
        y += (this.humLp.run(w) * 0.5 + Math.sin(2 * Math.PI * this.treadPh) * 0.02) * tonal * roll;
      }
      // gravel grit grains
      if (ls > 0.05 && v > 1) {
        if (nz.u() < (v * 0.9 + sl * 3) / sr * ls) this.grainEnv = 0.4 + nz.u() * 0.8;
        y += this.gritBp.run(w) * this.grainEnv * 0.12 * ls;
        this.grainEnv *= 0.993;
      }
      // tyre slide: loose → hiss/spray, tarmac → squeal
      const slideAmt = Math.min(1.5, sl / 12) * gnd;
      if (slideAmt > 0.01) {
        y += this.slideBp.run(w) * slideAmt * 0.14 * (1 - tonal * 0.7);
        if (tonal > 0.05) {
          this.squealPh += (1100 + 60 * Math.sin(this.crowdLfo * 9)) / sr; if (this.squealPh > 1) this.squealPh -= 1;
          y += (Math.sin(2 * Math.PI * this.squealPh) * 0.05 + this.squealBp.run(w) * 0.5) * slideAmt * tonal;
        }
      }
      // stones hitting the underbody
      if (ls > 0.1 && v > 3) {
        this.stoneAcc += ((v * 0.06 + sl * 0.25) * ls) / sr;
        if (this.stoneAcc > nz.u() * 8 + 0.5) {
          this.stoneAcc = 0;
          const s = this.shot();
          s.active = true; s.t = 0; s.kind = 'stone'; s.dur = 0.03 + nz.u() * 0.04; s.amp = 0.08 + nz.u() * 0.14;
          s.thumpAmp = 0; s.noiseAmp = 1; s.ringF = [2200 + nz.u() * 2500, 4100 + nz.u() * 2000, 0]; s.ringAmp = 0.7;
          s.bp.bandpass(3000 + nz.u() * 2000, 2); s.lp.lowpass(9000);
        }
      }
      // wind
      y += this.windLp.run(this.windHp.run(w)) * Math.min(1.2, (v / 45) ** 2) * 0.09;
      // one-shots
      for (let k = 0; k < shots.length; k++) {
        const s = shots[k];
        if (!s.active) continue;
        const t = s.t, u = t / s.dur;
        if (u >= 1) { s.active = false; continue; }
        if (t < 0) { s.t += 1 / sr; continue; } // delayed one-shot (glass after a crunch)
        const env = s.kind === 'splash' ? Math.sin(Math.PI * Math.min(1, u * 3)) * (1 - u) : Math.exp(-u * 5) * Math.min(1, t * 900);
        let z = s.lp.run(s.bp.run(w)) * s.noiseAmp;
        if (s.thumpAmp > 0) z += Math.sin(2 * Math.PI * s.thumpF * t * (1 - 0.3 * u)) * s.thumpAmp * Math.exp(-u * 3);
        if (s.ringAmp > 0) for (const f of s.ringF) if (f > 0) z += Math.sin(2 * Math.PI * f * t) * s.ringAmp * 0.35 * Math.exp(-u * 7);
        y += z * env * s.amp * 0.5;
        s.t += 1 / sr;
      }
      // crowd: band-passed noise with slow random swells
      if (this.crowdAmp > 0) {
        const mod = 0.6 + 0.8 * Math.abs(this.crowdMod.run(nz.next() * 3));
        const c = this.crowdBp[0].run(w) * 0.6 + this.crowdBp[1].run(w) * 0.5 * mod + this.crowdBp[2].run(w) * 0.25 * mod;
        y += c * this.crowdAmp * 0.35 * Math.min(1, this.crowdT * 3);
      }
      out[i] += y * gain;
    }
  }
}
