// Browser audio: AudioContext (unlocked on the first key / click / pad button), the DSP worklet, the co-driver voice
// bus, mixing groups and ducking. Everything heavy happens in the worklet; per frame the game only posts telemetry.
//
// Graph:  worklet (engine + road/ambience, ducked)  ─┐
//         voice sources → voiceGain ─────────────────┼→ master → limiter → destination
import type { EngineSound } from './dsp/engine';
import type { RoadInput } from './dsp/road';
import type { WorkletMsg } from './worklet';
import type { EngineState } from './dsp/engine';
import type { VoiceManifest } from './codriver';
import workletUrl from './worklet.ts?worker&url';

export interface AudioSettings { master: number; engine: number; ambient: number; voice: number }

export class AudioSystem {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master!: GainNode;
  private voiceGain!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private ready = false;
  private starting: Promise<void> | null = null;
  settings: AudioSettings = { master: 0.85, engine: 1, ambient: 0.9, voice: 1 };
  /** voice sprite */
  private voiceBuf: AudioBuffer | null = null;
  manifest: VoiceManifest | null = null;
  /** codriver clock → context time offset */
  private clockOffset = 0;
  /** active voice sources (stopped on restart) */
  private sources: AudioBufferSourceNode[] = [];
  muted = false;

  constructor(readonly sound: EngineSound, readonly voice = 'meijia') {
    // browsers only allow audio after a user gesture: unlock on the first one
    const unlock = () => { this.start(); };
    addEventListener('keydown', unlock, { once: true, capture: true });
    addEventListener('pointerdown', unlock, { once: true, capture: true });
    // fetch the voice manifest early (decoding needs a context, done in start())
    void fetch(`/assets/voice/${voice}/manifest.json`).then((r) => (r.ok ? r.json() : null)).then((m) => { this.manifest = m; }).catch(() => {});
  }

  get running() { return this.ready && this.ctx?.state === 'running'; }

  /** create/resume the context; safe to call repeatedly (must be inside a user gesture the first time) */
  start(): Promise<void> {
    if (this.starting) { void this.ctx?.resume(); return this.starting; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    void ctx.resume();
    this.starting = (async () => {
      await ctx.audioWorklet.addModule(workletUrl);
      this.limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 2, ratio: 12, attack: 0.002, release: 0.15 });
      this.master = new GainNode(ctx, { gain: this.muted ? 0 : this.settings.master });
      this.voiceGain = new GainNode(ctx, { gain: this.settings.voice });
      this.node = new AudioWorkletNode(ctx, 'dustmark-sound', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { sound: this.sound } });
      this.node.connect(this.master);
      this.voiceGain.connect(this.master);
      this.master.connect(this.limiter).connect(ctx.destination);
      this.post({ t: 'gains', gains: { master: 1, engine: this.settings.engine, ambient: this.settings.ambient } });
      try {
        if (!this.manifest) this.manifest = await (await fetch(`/assets/voice/${this.voice}/manifest.json`)).json();
        const data = await (await fetch(`/assets/voice/${this.voice}/${this.manifest!.file}`)).arrayBuffer();
        this.voiceBuf = await ctx.decodeAudioData(data);
      } catch (e) { console.warn('[audio] co-driver voice unavailable', e); }
      this.ready = true;
    })();
    return this.starting;
  }

  private post(m: WorkletMsg) { this.node?.port.postMessage(m); }

  setSettings(s: Partial<AudioSettings>) {
    Object.assign(this.settings, s);
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.settings.master, t, 0.05);
    this.voiceGain.gain.setTargetAtTime(this.settings.voice, t, 0.05);
    this.post({ t: 'gains', gains: { engine: this.settings.engine, ambient: this.settings.ambient } });
  }

  setMuted(m: boolean) { this.muted = m; this.setSettings({}); }
  /** pause menu: silence the car but keep the context */
  setPaused(p: boolean) {
    if (!this.ready || !this.ctx) return;
    this.master.gain.setTargetAtTime(p || this.muted ? 0 : this.settings.master, this.ctx.currentTime, 0.04);
  }

  /** per-frame telemetry */
  update(engine: EngineState, road: RoadInput, duck: number) {
    if (!this.ready) return;
    this.post({ t: 'state', engine, road, duck });
  }

  impact(kind: 'land' | 'bottom' | 'hit', v: number) { if (this.ready) this.post({ t: 'impact', kind, v }); }
  splash(v: number) { if (this.ready) this.post({ t: 'splash', v }); }
  /** crowd cheer (0..1) — the scene calls this near spectator areas */
  cheer(intensity: number) { if (this.ready) this.post({ t: 'cheer', v: intensity }); }

  /** align the co-driver clock (game seconds) with the audio clock */
  syncClock(gameNow: number) { if (this.ctx) this.clockOffset = this.ctx.currentTime - gameNow; }

  /** play words back to back starting at codriver time `at` */
  say(words: string[], at: number) {
    const ctx = this.ctx, buf = this.voiceBuf, mf = this.manifest;
    if (!ctx || !buf || !mf || !this.ready) return;
    let t = Math.max(ctx.currentTime + 0.01, at + this.clockOffset);
    // tidy finished sources
    this.sources = this.sources.filter((s) => (s as unknown as { _end: number })._end > ctx.currentTime);
    for (const w of words) {
      const c = mf.clips[w];
      if (!c) continue;
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      src.connect(this.voiceGain);
      src.start(t, c.start, c.dur);
      (src as unknown as { _end: number })._end = t + c.dur;
      this.sources.push(src);
      t += c.dur + mf.gap;
    }
  }

  /** stop any queued speech (restart / reset to road) */
  hush() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    this.sources = [];
  }
}
