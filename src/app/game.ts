// One stage run: fixed 120 Hz sim with render interpolation, input, camera, HUD, sound, co-driver, splits against a
// comparison target (personal best / medal line), ghost car, replay + ghost recording, penalties
// carry-over, pause / finish hand-off to the menus, replay playback, and clean disposal (menus start many runs).
import { CARS } from '../data/cars';
import { STAGES, resolveStage } from '../data/stages';
import { Bot } from '../sim/driver/bot';
import { DT } from '../sim/vehicle/car';
import { emptyInput, type DriverInput } from '../sim/vehicle/controls';
import { World } from '../sim/world';
import { CAM_MODES, TvDirector, type CamMode } from '../render/camera';
import { QUALITIES, StageView, clonePose, lerpPose, poseFromCar, type CarPose } from '../render/view';
import { Hud } from '../ui/hud';
import { PredictOverlay } from '../render/predictOverlay';
import { artPending } from '../render/materials';
import { Bench } from './bench';
import { AudioSystem } from '../audio/audio';
import { Codriver } from '../audio/codriver';
import { defaultEngineState } from '../audio/dsp/engine';
import { engineState, newRoadState, roadState } from '../audio/telemetry';
import { CAR_SOUNDS } from '../data/carSounds';
import { SURFACES } from '../data/surfaces';
import { assistsFor } from '../sim/vehicle/controls';
import { Input } from './input';
import { tuneFor, type Feel } from './feel';
import { params } from './params';
import { stageDef } from '../sim/rally/catalog';
import type { Settings } from '../sim/rally/settings';
import { GhostRecorder, type GhostData, type GhostTrack } from '../sim/rally/ghost';
import { WadingFx } from '../render/car/wading';
import type { PenaltyEvent } from '../sim/rally/session';
import { MEDAL_CN } from '../sim/rally/scoring';
import { GhostCar } from './ghostCar';
import { ReplayClock, ReplayRecorder, replayPose, replaySound, type ReplayCam } from './replay';
import { fmtTime } from '../ui/dom';
import { sfx } from '../ui/sfx';

declare global {
  interface Window { __game?: Game; __ready?: boolean; __benchResult?: unknown; __startBench?: () => void }
}

export type RunMode = 'direct' | 'single' | 'time' | 'career';

export interface RunConfig {
  /** forward base id for menu runs; for 'direct' the URL id as given (may carry -r / @weather) */
  stage: string;
  reverse: boolean;
  weather: string;
  car: string;
  livery: number;
  mode: RunMode;
  bot: boolean;
  /** sim fast-forward (robot only; smoke tests) */
  ff: number;
  settings: Settings;
  /** saved 手感 knobs (src/app/feel.ts; the live save object, so a restart picks up changes); null/absent = defaults */
  feel?: Feel | null;
  ghost: GhostData | null;
  /** medal times (s) */
  targets: { gold: number; silver: number; bronze: number } | null;
}

/** what the splits / target line compare against */
export interface Compare {
  label: string;
  /** comparison stage time at d metres from the start line */
  at(d: number): number;
}

export interface RunResult {
  finished: boolean;
  time: number;
  penalties: number;
  total: number;
  log: PenaltyEvent[];
  resets: number; cuts: number; falseStart: boolean;
  topKmh: number; avgKmh: number;
  /** my time at every km and the delta to the comparison (null = not known) */
  splits: number[];
  splitDeltas: (number | null)[];
  /** encoded ghost of this run (10 Hz poses) */
  ghost: string | null;
  lengthM: number;
}

const PEN_CN: Record<string, string> = { reset: '回到路上', falsestart: '抢跑', cut: '切弯绕过检查点' };
/** post-chain uniforms of the speed / radial blur (src/render: render task) */
const RADIAL = ['uRadial', 'uRadialBlur', 'uSpeedBlur'] as const;

export class Game {
  world: World;
  view!: StageView;
  hud!: Hud;
  input = Input.shared();
  bot: Bot | null = null;
  private acc = 0;
  private last = -1;
  private prevPose!: CarPose;
  private currPose!: CarPose;
  private drawPose!: CarPose;
  private inp: DriverInput = emptyInput();
  /** input the sim used on the last tick (held constant by the trajectory prediction) */
  private simInp: DriverInput = this.inp;
  predict: PredictOverlay | null = null;
  private wading = new WadingFx();
  paused = false;
  private perfEl: HTMLElement | null;
  private perfOn = params.perf;
  private frames = 0;
  private simMs = 0;
  private renderMs = 0;
  private bench: Bench | null = null;
  // dynamic resolution
  private drFrames = new Float32Array(90);
  private drIdx = 0;
  private drCool = 3000;
  private drDownAt = -1e9;
  private drMax: number;
  private scaleLog: number[] = [];
  private frameTimes = new Float32Array(120);
  private ftIdx = 0;
  // sound + co-driver
  audio!: AudioSystem;
  codriver: Codriver | null = null;
  private es = defaultEngineState();
  private rs = newRoadState();
  /** engine telemetry recorded with the replay (per sim tick) */
  private recEs = defaultEngineState();
  private ev = { landed: 0, bottom: 0, hit: 0 };
  private crowd: { s: number; n: number; done: boolean }[] = [];
  // splits against the comparison target
  compare: Compare | null = null;
  private splitTimes: number[] = [];
  private splitInfo: { n: number; of: number; delta: number; label?: string } | null = null;
  // flow
  onFinish: ((r: RunResult) => void) | null = null;
  onPause: (() => void) | null = null;
  /** a setting changed from inside the run (P = trajectory prediction): the app writes it to the save */
  onSettingsChanged: ((patch: Partial<Settings>) => void) | null = null;
  private finishAt = -1;
  private finishSent = false;
  private stopped = false;
  private raf = 0;
  private onResize = () => this.view.resize();
  // recording, ghost, replay
  private rec = new ReplayRecorder();
  private ghostRec = new GhostRecorder(10);
  private ghostCar: GhostCar | null = null;
  private ghostTrack: GhostTrack | null = null;
  private ghostCursor = { i: 1 };
  private targetT = 0;
  mode: 'run' | 'replay' = 'run';
  replay: ReplayClock | null = null;
  private director: TvDirector | null = null;
  private replayCamPrev: ReplayCam | '' = '';
  private replayPose!: CarPose;
  replayInfo = { s: 0, kmh: 0, gear: 1, t: 0 };
  private settings: Settings;
  private radialOn: Record<string, number> = {};
  readonly ff: number;

  constructor(readonly canvas: HTMLCanvasElement, readonly cfg: RunConfig) {
    const def = (cfg.mode === 'direct' ? resolveStage(cfg.stage, cfg.weather) : stageDef(cfg.stage, cfg.reverse, cfg.weather)) ?? STAGES['north-1'];
    const spec = CARS[cfg.car] ?? CARS.kestrel;
    // menu runs build their own stage (no module-level cache growing over a long session)
    this.world = new World(def, spec, { cached: cfg.mode === 'direct' });
    this.settings = cfg.settings;
    this.world.holdAtStart = cfg.bot;
    this.ff = cfg.bot ? Math.max(1, cfg.ff) : 1;
    this.applyCarSettings();
    this.perfEl = document.getElementById('perf');
    this.drMax = 1;
  }

  /** assists, gearbox, feel knobs (also on restart: the car is reset) */
  private applyCarSettings() {
    const car = this.world.car, s = this.settings;
    car.assists = assistsFor(s.assist);
    if (!s.counterSteer || this.cfg.bot) car.assists.counterSteer = false;
    car.transmission = s.transmission;
    // feel knobs: defaults ⊕ saved 手感 ⊕ URL (robot-driven runs: defaults ⊕ URL)
    car.tune = tuneFor(this.cfg.bot ? null : this.cfg.feel ?? null);
    this.input.gentle = car.tune.gentle;
  }

  async init(progress: (p: number, label: string) => void) {
    const s = this.settings;
    const q = QUALITIES[s.quality] ?? QUALITIES.default;
    const scale = params.scale ?? (s.renderScale > 0 ? s.renderScale : undefined);
    this.drMax = scale ?? q.renderScale;
    this.view = new StageView(this.canvas, this.world.stage, this.world.car.spec, q, scale);
    await this.view.build(progress);
    this.applyPost();
    this.view.chase.fitToModel(this.view.car.root, this.world.car.spec.cgHeight);
    const direct = this.cfg.mode === 'direct';
    if (direct && params.cam && (CAM_MODES.includes(params.cam) || params.cam === 'tv')) this.view.chase.mode = params.cam;
    if (direct && params.cam === 'tv') {
      const st = this.world.stage, ss = st.startS + (params.tvS ?? (params.s ?? 0) + 40);
      const p = st.pointAt(ss), x = p.x + p.rx * params.tvD, z = p.z + p.rz * params.tvD;
      this.view.chase.tvPos.set(x, st.height(x, z) + params.tvH, z);
    }
    const st = this.world.stage;
    this.hud = new Hud(document.body, st.def.name, st.notes, st.startS, st.finishS, st.env.name);
    this.hud.root.style.display = params.hud || !direct ? '' : 'none';
    this.hud.setLite(s.hudLite);
    this.initAudio();
    if (this.cfg.bot || params.bench) this.enableBot();
    if (direct) this.applyStartParams(); else this.syncPoses();
    this.predict = new PredictOverlay(this.world.stage, this.world.car, { on: s.predict, horizon: s.predictT });
    this.predict.attach(this.view.scene, this.view.renderer, this.view.chase.cam);
    if (this.cfg.ghost) {
      try {
        this.ghostCar = new GhostCar(this.cfg.ghost);
        this.ghostTrack = this.ghostCar.track;
        this.view.scene.add(this.ghostCar.root);
        this.ghostCar.root.visible = true;
        this.view.renderer.compile(this.ghostCar.root, this.view.chase.cam, this.view.scene);
        this.ghostCar.root.visible = false;
      } catch (e) { console.warn('[ghost] unreadable ghost', e); this.ghostCar = null; this.ghostTrack = null; }
    }
    this.replayPose = clonePose(this.currPose);
    addEventListener('resize', this.onResize);
    window.__game = this;
    // tools hook: goes through window.__game (no closure over this Game, so a finished run is not kept alive by it)
    (window as unknown as { __teleport: (s: number, v?: number, yaw?: number) => void }).__teleport = (s, v, yaw) => window.__game?.teleport(s, v, yaw);
    if (params.bench) window.__startBench = () => { this.bench = new Bench(60); };
  }

  /** settings → post chain switches (after the view exists) */
  applyPost() {
    const u = this.view.post.final.uniforms as Record<string, { value: number }>;
    const L = this.world.stage.env.look as unknown as Record<string, number>;
    const p = this.settings.post;
    if (u.uBloom) u.uBloom.value = p.bloom ? L.bloom ?? u.uBloom.value : 0;
    if (u.uVignette) u.uVignette.value = p.vignette ? L.vignette ?? u.uVignette.value : 0;
    if (u.uGrain) u.uGrain.value = p.grain ? L.grain ?? u.uGrain.value : 0;
    // speed blur (the render task's radial blur): a flag the view can read (StageView.speedBlur), and the uniforms —
    // remember the stage's own strength, zero it while switched off
    (this.view as unknown as { speedBlur?: boolean }).speedBlur = p.radialBlur;
    for (const k of RADIAL) if (u[k]) {
      if (!(k in this.radialOn)) this.radialOn[k] = u[k].value;
      u[k].value = p.radialBlur ? this.radialOn[k] : 0;
    }
  }

  /** the post chain may drive the blur per frame (by speed): keep it off after the view's frame when switched off */
  private holdRadialOff() {
    if (this.settings.post.radialBlur) return;
    const u = this.view.post.final.uniforms as Record<string, { value: number } | undefined>;
    for (const k of RADIAL) { const x = u[k]; if (x && x.value !== 0) x.value = 0; }
  }

  /** live settings change from the pause menu */
  updateSettings(s: Settings) {
    this.settings = s;
    this.hud.setLite(s.hudLite);
    const car = this.world.car;
    car.transmission = s.transmission;
    car.assists = assistsFor(s.assist);
    if (!s.counterSteer || this.bot) car.assists.counterSteer = false;
    this.input.pad.deadzone = s.pad.deadzone; this.input.pad.curve = s.pad.curve;
    this.audio?.setSettings({ master: s.vol.master, engine: s.vol.engine, ambient: s.vol.ambient, voice: s.vol.voice });
    if (this.predict && this.predict.enabled !== s.predict) this.predict.setEnabled(s.predict);
    this.applyPost();
  }

  enableBot() {
    this.bot = new Bot(this.world.stage, this.world.car, { skill: 0.9 });
    this.world.car.assists.counterSteer = false;
    this.world.holdAtStart = true;
  }

  /** ?s= teleport, ?t= fast-forward */
  private applyStartParams() {
    if (params.s !== undefined) this.teleport(params.s, params.v ?? 0, params.yaw ?? 0, false);
    const w = this.world;
    if (params.t !== undefined) {
      const inp = emptyInput();
      while (w.session.time < params.t && w.session.phase !== 'finished') {
        w.step(this.bot ? this.bot.drive(w) : inp);
        if (this.bot?.wantsReset(w)) w.session.resetCar(w.car);
        const d = w.session.maxProgressS - w.stage.startS;
        if (d >= (this.splitTimes.length + 1) * 1000) this.splitTimes.push(w.session.time + w.session.penalties);
      }
      w.session.events.length = 0;
    }
    this.syncPoses();
  }

  /** place the car sRel metres into the stage at vKmh along the road, nose yawed by yawDeg (+ right); skips the countdown */
  teleport(sRel: number, vKmh = 0, yawDeg = 0, sync = true) {
    const w = this.world, st = w.stage;
    const s = st.startS + sRel;
    const p = st.pointAt(s);
    const yaw = (yawDeg * Math.PI) / 180;
    const hx = p.dx * Math.cos(yaw) - p.dz * Math.sin(yaw), hz = p.dz * Math.cos(yaw) + p.dx * Math.sin(yaw);
    w.car.reset(st, p.x, p.z, hx, hz);
    w.session.phase = 'running';
    w.session.time = 1; // debug entry: skip the GO banner
    w.session.progressS = s; w.session.maxProgressS = s;
    const v = vKmh / 3.6;
    if (v > 0) {
      w.car.vel.set(p.dx * v, 0, p.dz * v);
      for (const wh of w.car.wheels) wh.omega = v / w.car.spec.wheel.radius;
      for (let g = 1; g <= 6; g++) { w.car.gear = g; w.car.pendingGear = g; if ((v / w.car.spec.wheel.radius) * w.car.gearRatio(g) * 9.549 < 6500) break; }
    }
    this.codriver?.seek(s);
    this.splitTimes = []; this.splitInfo = null;
    for (let k = 1; k * 1000 <= sRel; k++) this.splitTimes.push(NaN);
    if (sync) this.syncPoses();
  }

  private syncPoses() {
    this.currPose = poseFromCar(this.world.car, this.currPose);
    this.prevPose = clonePose(this.currPose);
    this.drawPose = clonePose(this.currPose);
    this.acc = 0;
    this.view.chase.snap();
    this.view.chase.update(0, this.currPose.pos, this.currPose.quat, this.currPose.vel, this.world.stage, 0);
  }

  /** back to the start line (also: restart from the pause / results screens) */
  restart() {
    this.stopReplay();
    this.world.placeAtStart();
    this.predict?.reset();
    this.applyCarSettings();
    this.codriver?.reset();
    this.audio?.hush();
    for (const c of this.crowd) c.done = false;
    this.splitTimes = []; this.splitInfo = null;
    if (this.bot) this.bot = new Bot(this.world.stage, this.world.car, { skill: 0.9 });
    this.finishAt = -1; this.finishSent = false;
    this.hud.hideFinish();
    this.rec.reset();
    this.ghostRec = new GhostRecorder(10);
    this.ghostCursor.i = 1;
    this.setPaused(false);
    this.syncPoses();
  }

  setPaused(on: boolean) {
    this.paused = on;
    this.input.setEnabled(!on && this.mode === 'run' && !this.finishSent);
    this.audio?.setPaused(on);
  }

  start() {
    this.input.setEnabled(true);
    this.input.pad.deadzone = this.settings.pad.deadzone; this.input.pad.curve = this.settings.pad.curve;
    const loop = (now: number) => {
      if (this.stopped) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** stage result so far */
  result(): RunResult {
    const w = this.world, s = w.session;
    const finished = s.phase === 'finished';
    const time = finished ? s.finishTime : Math.max(0, s.time);
    const deltas = this.splitTimes.map((t, i) => (this.compare && Number.isFinite(t) ? t - this.compare.at((i + 1) * 1000) : null));
    return {
      finished, time, penalties: s.penalties, total: time + s.penalties, log: [...s.log], resets: s.resets, cuts: s.cuts, falseStart: s.falseStart,
      topKmh: s.topSpeed * 3.6, avgKmh: finished ? (w.stage.length / Math.max(1, s.finishTime)) * 3.6 : 0,
      splits: [...this.splitTimes], splitDeltas: deltas,
      ghost: finished && this.ghostRec.count > 10 ? this.ghostRec.encode() : null,
      lengthM: w.stage.length,
    };
  }

  private frame(now: number) {
    if (this.last < 0) this.last = now;
    let dtMs = now - this.last;
    this.last = now;
    if (dtMs > 250) dtMs = 250;
    const dt = dtMs / 1000;
    if (this.mode === 'replay') { this.replayFrame(dt); this.frames++; return; }
    const w = this.world;
    // actions
    for (const a of this.input.takeActions()) {
      if (a === 'camera') { const i = CAM_MODES.indexOf(this.view.chase.mode); this.view.chase.mode = CAM_MODES[(i + 1) % CAM_MODES.length]; this.view.chase.snap(); }
      else if (a === 'reset' && w.session.phase === 'running' && !this.paused) { w.session.resetCar(w.car); this.view.chase.snap(); this.currPose = poseFromCar(w.car, this.currPose); this.prevPose = clonePose(this.currPose); this.audio.hush(); this.codriver?.seek(w.session.progressS - 30); }
      else if (a === 'mute') { this.audio.setMuted(!this.audio.muted); this.hud.showToast(this.audio.muted ? '静音' : '声音开'); }
      else if (a === 'pause') { if (!this.paused && !this.finishSent && this.onPause) { this.setPaused(true); this.onPause(); } }
      else if (a === 'perf') this.perfOn = !this.perfOn;
      else if (a === 'predict' && this.predict) {
        // one source of truth: the settings (saved through the app); the overlay only follows it
        const on = !this.settings.predict;
        this.settings.predict = on;
        this.predict.setEnabled(on);
        this.onSettingsChanged?.({ predict: on });
        this.hud.showToast(on ? (w.car.speed < 1 ? '轨迹预测 开 · 车动起来后路面上出现预测带' : '轨迹预测 开') : '轨迹预测 关');
      }
      else if (a === 'hud') this.hud.root.style.display = this.hud.root.style.display === 'none' ? '' : 'none';
    }
    // fixed-step sim
    const t0 = performance.now();
    if (!this.paused && !params.pause) {
      this.acc += dt * this.ff;
      let steps = 0;
      const maxSteps = 8 * this.ff;
      while (this.acc >= DT && steps < maxSteps) {
        this.prevPose = lerpPose(this.currPose, this.currPose, 0, this.prevPose);
        const inp = this.bot ? this.bot.drive(w) : this.input.sample(this.inp);
        w.step(inp);
        this.simInp = inp;
        if (this.bot?.wantsReset(w)) w.session.resetCar(w.car);
        const e = w.car.events;
        this.ev.landed = Math.max(this.ev.landed, e.landed);
        this.ev.bottom = Math.max(this.ev.bottom, e.bottomOut);
        this.ev.hit = Math.max(this.ev.hit, e.obstacleHit, e.bodyHit > 2 ? e.bodyHit * 0.6 : 0);
        this.currPose = poseFromCar(w.car, this.currPose);
        this.record();
        this.acc -= DT;
        steps++;
      }
      if (steps === maxSteps) this.acc = 0;
    }
    const t1 = performance.now();
    const alpha = params.pause ? 1 : Math.min(1, this.acc / DT);
    lerpPose(this.prevPose, this.currPose, alpha, this.drawPose);
    this.view.updateCar(this.drawPose);
    this.wading.update(w.car, params.pause ? 0 : dt, null, (v) => this.audio?.splash(v)); // M3-B: ford splash sound (spray: StageView)
    const rough = w.car.groundedCount > 0 ? 1 : 0;
    this.feedCameraAndSound();
    this.predict?.frame(w.car, this.simInp, w.tick, w.session.phase === 'running' || w.session.phase === 'countdown', this.paused, this.view.chase.cam);
    this.hud.setPredict(this.predict?.enabled ? `轨迹预测 ${this.predict.horizon.toFixed(1)}s` : '');
    const ses = w.session;
    if (this.ghostCar) this.ghostCar.update(ses.phase === 'countdown' ? 0 : ses.phase === 'finished' ? ses.time : ses.time, this.drawPose.pos);
    // fast-forward: the camera, particles and props run on sim time so the chase camera keeps up
    this.view.frame(params.pause ? 0 : dt * this.ff, this.drawPose, rough);
    this.holdRadialOff();
    const t2 = performance.now();
    // HUD
    this.hud.update(dt, {
      time: ses.phase === 'finished' ? ses.finishTime : ses.time, penalties: ses.penalties, progress: ses.progress, speedKmh: w.car.speed * 3.6, gear: w.car.shiftTimer > 0 ? w.car.pendingGear : w.car.gear,
      rpm: w.car.rpm, redline: w.car.spec.engine.redline, limiter: w.car.spec.engine.limiter,
      phase: ses.phase, notes: w.stage.notes, s: ses.progressS, resets: ses.resets,
      callIdx: this.codriver?.highlight(w.tick * DT), split: this.splitInfo,
    });
    for (const e of ses.events) { this.hud.showPenalty(e.sec, PEN_CN[e.kind] ?? '罚时'); sfx.play('penalty'); }
    ses.events.length = 0;
    if ((this.targetT -= dt) <= 0) { this.targetT = 0.25; this.updateTargetLine(); }
    // finish → hand the result to the menus after a moment
    if (ses.phase === 'finished') {
      if (this.finishAt < 0) this.finishAt = now;
      if (!this.finishSent && now - this.finishAt > 1100 / this.ff) {
        this.finishSent = true;
        this.input.setEnabled(false);
        this.onFinish?.(this.result());
      }
    }
    // perf + dynres + bench
    this.simMs = this.simMs * 0.9 + (t1 - t0) * 0.1;
    this.renderMs = this.renderMs * 0.9 + (t2 - t1) * 0.1;
    this.frameTimes[this.ftIdx] = dtMs; this.ftIdx = (this.ftIdx + 1) % this.frameTimes.length;
    if (this.settings.dynres && params.dynres) this.dynamicResolution(dtMs);
    const info = this.view.info();
    if (this.bench) {
      this.bench.record(now, dtMs, t1 - t0, t2 - t1, info.calls, info.triangles, `p${info.programs} g${info.geometries} t${info.textures}`);
      if (this.bench.done(now) && !window.__benchResult) {
        const cv = this.view.renderer.domElement;
        window.__benchResult = this.bench.result({
          resolution: `${cv.width}x${cv.height}`, renderScale: this.view.renderScale, quality: this.view.quality.name, gpu: this.view.gpuName,
          scaleChanges: this.scaleLog, distanceM: ses.maxProgressS - w.stage.startS, avgKmh: ((ses.maxProgressS - w.stage.startS) / Math.max(1, ses.time)) * 3.6,
        });
      }
    }
    this.frames++;
    if (!window.__ready && this.frames >= 6 && (artPending() === 0 || this.frames > 400)) window.__ready = true;
    if (this.perfEl) {
      if (this.perfOn && this.frames % 15 === 0) {
        const ft = Array.from(this.frameTimes).sort((a, b) => a - b);
        this.perfEl.style.display = 'block';
        this.perfEl.textContent = `FPS ${(1000 / (ft.reduce((a, b) => a + b, 0) / ft.length)).toFixed(0)}  p95 ${ft[Math.floor(ft.length * 0.95)].toFixed(1)} ms\n` +
          `sim ${this.simMs.toFixed(2)} ms  render ${this.renderMs.toFixed(2)} ms\n` +
          `draws ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k  scale ${this.view.renderScale.toFixed(2)}\n` +
          `s ${ses.progressS.toFixed(0)} m  ${this.view.gpuName.slice(0, 40)}`;
      } else if (!this.perfOn) this.perfEl.style.display = 'none';
    }
  }

  /** frame-time stats of the last 120 frames (smoke test / perf checks) */
  frameStats() {
    const ft = Array.from(this.frameTimes).filter((x) => x > 0).sort((a, b) => a - b);
    return { avg: ft.reduce((a, b) => a + b, 0) / Math.max(1, ft.length), p95: ft[Math.floor(ft.length * 0.95)] ?? 0, max: ft[ft.length - 1] ?? 0 };
  }

  /** per sim tick: replay frames (from the countdown to 4 s after the finish) and ghost samples (running) */
  private record() {
    const w = this.world, s = w.session, car = w.car;
    if (s.phase === 'finished' && s.time > s.finishTime + 4) return;
    this.rec.push(s.time, s.progressS, car.speed * 3.6, car.rpm, car.gear, this.currPose, engineState(car, this.recEs));
    // km splits, tick-exact (the robot reference curve is per tick too)
    if (s.phase === 'running') {
      const st = w.stage, nSplits = Math.max(1, Math.floor(st.length / 1000)), d = s.maxProgressS - st.startS;
      while (this.splitTimes.length < nSplits && d >= (this.splitTimes.length + 1) * 1000) this.splitTimes.push(s.time + s.penalties);
    }
    if (s.phase === 'running') {
      const p = this.currPose;
      this.ghostRec.push(s.time, p.pos.x, p.pos.y, p.pos.z, p.quat.x, p.quat.y, p.quat.z, p.quat.w, s.progressS - w.stage.startS);
    }
  }

  /** line under the timer: live gap to the ghost, and the best medal still within reach */
  private updateTargetLine() {
    const s = this.world.session;
    const parts: string[] = [];
    const now = s.phase === 'finished' ? s.finishTime : Math.max(0, s.time);
    if (this.ghostTrack && s.phase === 'running') {
      const d = s.progressS - this.world.stage.startS;
      const gt = this.ghostAt(d);
      if (Number.isFinite(gt) && d > 30) {
        const gap = now + s.penalties - gt;
        parts.push(`<span class="${gap > 0 ? 'slower' : 'faster'}">幽灵 ${gap >= 0 ? '+' : '−'}${Math.abs(gap).toFixed(1)}</span>`);
      }
    }
    const tg = this.cfg.targets;
    if (tg && s.phase !== 'finished') {
      const tot = now + s.penalties;
      const m = tot < tg.gold ? 'gold' : tot < tg.silver ? 'silver' : tot < tg.bronze ? 'bronze' : null;
      if (m) parts.push(`<i class="medal-dot ${m}"></i>${MEDAL_CN[m]} ${fmtTime(tg[m])}`);
    }
    this.hud.setTarget(parts.join('<em>·</em>'));
  }

  /** ghost's time at distance d (monotonic cursor: d only grows while running) */
  private ghostAt(d: number) {
    const g = this.ghostTrack!;
    const c = this.ghostCursor;
    if (c.i > 1 && g.s[c.i - 1] > d) c.i = 1;
    while (c.i < g.n && g.s[c.i] < d) c.i++;
    if (c.i >= g.n) return NaN;
    const a = g.s[c.i - 1], b = g.s[c.i];
    return (c.i - 1 + (b > a ? (d - a) / (b - a) : 0)) / g.hz;
  }

  private initAudio() {
    const spec = this.world.car.spec, s = this.settings;
    const voice = this.cfg.mode === 'direct' && params.voice !== 'meijia' ? params.voice : s.voice;
    this.audio = new AudioSystem(CAR_SOUNDS[spec.id] ?? CAR_SOUNDS.kestrel, voice);
    this.audio.setSettings({ master: s.vol.master, engine: s.vol.engine, ambient: s.vol.ambient, voice: s.vol.voice });
    if (params.mute) this.audio.setMuted(true);
    // a menu run starts after a key press: the page may already play sound
    if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) void this.audio.start();
    const st = this.world.stage;
    const pts = st.props.filter((p) => p.type === 'crowd').map((p) => st.terrain.nearest(p.x, p.z).s).sort((a, b) => a - b);
    for (const x of pts) {
      const last = this.crowd[this.crowd.length - 1];
      if (last && x - last.s < 35) last.n++; else this.crowd.push({ s: x, n: 1, done: false });
    }
  }

  /** per frame: camera feed (impacts, roughness), engine/road telemetry, co-driver, cheers, splits */
  private feedCameraAndSound() {
    const w = this.world, car = w.car, st = w.stage, ses = w.session;
    const now = w.tick * DT;
    let rough = 0, g = 0;
    for (const wh of car.wheels) if (wh.grounded) { rough += SURFACES[wh.surface]?.bump ?? 0.01; g++; }
    rough = g ? Math.min(1, rough / g / 0.03) : 0;
    this.view.chase.setFeed({ landed: this.ev.landed, impact: this.ev.hit, bottomOut: this.ev.bottom, rough, grounded: g });
    if (this.audio) {
      if (this.ev.landed > 0) this.audio.impact('land', this.ev.landed);
      if (this.ev.bottom > 1) this.audio.impact('bottom', this.ev.bottom);
      if (this.ev.hit > 0.5) this.audio.impact('hit', this.ev.hit);
      this.audio.setPaused(this.paused);
      if (!this.codriver && this.audio.manifest) {
        const early = this.cfg.mode === 'direct' && params.callEarly !== 4 ? params.callEarly : this.settings.callEarly;
        this.codriver = new Codriver(st.notes, this.audio.manifest, { callEarly: early });
        this.codriver.seek(ses.progressS - 1);
      }
      let duck = 0;
      if (this.codriver && !this.paused) {
        const live = ses.phase !== 'finished';
        for (const u of this.codriver.update(now, ses.progressS, Math.max(0, car.fwdSpeed), live)) this.audio.say(u.words, now);
        duck = this.codriver.speaking(now) ? 1 : 0;
      }
      this.audio.update(engineState(car, this.es), roadState(car, this.rs), duck);
      for (const c of this.crowd) {
        if (!c.done && ses.progressS > c.s - 25 && ses.progressS < c.s + 10) {
          c.done = true;
          this.audio.cheer(Math.min(1, 0.35 + c.n * 0.12 + Math.min(0.3, Math.abs(car.slideAngle))));
        }
      }
      this.hud.setAudioHint(this.audio.running ? (this.audio.muted ? '静音 (M)' : '') : '按任意键开启声音');
    }
    this.ev.landed = 0; this.ev.bottom = 0; this.ev.hit = 0;
    // splits every km: record our own time when crossing; compare once the comparison is known
    if (ses.phase === 'running' || ses.phase === 'finished') {
      const nSplits = Math.max(1, Math.floor(st.length / 1000));
      const k = this.splitTimes.length;
      if (this.compare && k > 0 && Number.isFinite(this.splitTimes[k - 1]) && (!this.splitInfo || this.splitInfo.n !== k)) {
        this.splitInfo = { n: k, of: nSplits, delta: this.splitTimes[k - 1] - this.compare.at(k * 1000), label: this.compare.label };
      }
    }
  }

  // ---- replay ----

  startReplay() {
    if (!this.rec.n) return;
    this.mode = 'replay';
    this.paused = false;
    this.input.setEnabled(false);
    // the replay plays the recorded engine (replayFrame); no co-driver, no crowd
    this.audio?.hush();
    this.audio?.setPaused(false);
    this.hud.root.style.display = 'none';
    if (this.ghostCar) this.ghostCar.root.visible = false;
    this.director ??= new TvDirector(this.world.stage);
    this.replay = new ReplayClock(this.rec.t0, this.rec.t1);
    this.replayCamPrev = '';
    this.view.chase.tvZoom = true;
  }

  stopReplay() {
    if (this.mode !== 'replay') return;
    this.mode = 'run';
    this.replay = null;
    this.view.chase.tvZoom = false;
    this.view.chase.mode = 'far';
    this.view.chase.snap();
    this.audio?.setPaused(true);
    this.hud.root.style.display = params.hud || this.cfg.mode !== 'direct' ? '' : 'none';
    this.view.updateCar(this.drawPose);
  }

  private replayFrame(dt: number) {
    const r = this.replay!;
    r.advance(dt);
    const info = replayPose(this.rec, r.t, this.replayPose);
    this.replayInfo = { s: info.s, kmh: info.kmh, gear: info.gear, t: r.t };
    const ch = this.view.chase;
    let mode: CamMode = r.cam;
    if (r.cam === 'tv') {
      const pos = this.director!.pick(info.s, this.replayPose.pos);
      // no trackside spot covers this stretch: the helicopter fills in (still a broadcast view)
      if (pos) ch.tvPos.copy(pos); else mode = 'heli';
    }
    if (mode !== ch.mode || r.cam !== this.replayCamPrev) { ch.mode = mode; ch.snap(); this.replayCamPrev = r.cam; }
    this.view.updateCar(this.replayPose);
    // the ghost (time challenge) races along in the replay too, on the same stage clock
    if (this.ghostCar) this.ghostCar.update(r.t, this.replayPose.pos);
    // sound: the recorded engine + road under the replayed wheels; silent while paused
    if (this.audio) {
      this.audio.setPaused(r.paused);
      const snd = replaySound(this.rec, info, this.replayPose, this.world.car.spec.engine.redline, this.es, this.rs);
      this.audio.update(snd.es, snd.rs, 0);
    }
    this.predict?.frame(this.world.car, this.simInp, this.world.tick, false, true, ch.cam);
    this.view.frame(r.paused ? 0 : dt * r.speed, this.replayPose, 1);
  }

  /** seek (the chase camera restarts behind the car) */
  replaySeek(t: number) { if (!this.replay) return; this.replay.seek(t); this.view.chase.snap(); }

  dispose() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.input.setEnabled(false);
    try { (this.predict as unknown as { worker?: Worker | null })?.worker?.terminate(); } catch { /* */ }
    // the AudioSystem still has a one-shot "unlock on first key" listener: make it a no-op before closing the context
    if (this.audio) { (this.audio as unknown as { start: () => Promise<void> }).start = () => Promise.resolve(); this.audio.ctx?.close().catch(() => {}); }
    this.ghostCar?.dispose();
    this.hud?.root.remove();
    try {
      this.view.scene.traverse((o) => {
        const m = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
        m.geometry?.dispose();
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose()); else m.material?.dispose();
      });
      this.view.renderer.dispose();
      this.view.renderer.forceContextLoss();
    } catch { /* */ }
    this.canvas.remove();
    if (window.__game === this) { window.__game = undefined; window.__startBench = undefined; }
  }

  private dynamicResolution(dtMs: number) {
    this.drFrames[this.drIdx] = dtMs; this.drIdx = (this.drIdx + 1) % this.drFrames.length;
    if ((this.drCool -= dtMs) > 0) return;
    // M5-A (render task): on a 60 Hz display every rAF interval is ≥ 16 ms, so "no frame over 12 ms" never held and
    // the scale never came back up. Headroom = no frame over the display interval + 1 ms (≈17.5 ms at 60 Hz, 12 ms at
    // 120 Hz); after a step down, wait 15 s before trying to step up again (no oscillation at the edge).
    let slow = 0, fast = 0, minF = Infinity;
    for (const f of this.drFrames) if (f > 0) minF = Math.min(minF, f);
    const fastLimit = minF > 14 ? 17.5 : 12;
    for (const f of this.drFrames) { if (f > 17.5) slow++; if (f > fastLimit) fast++; }
    const s = this.view.renderScale;
    if (slow >= this.drFrames.length * 0.08 && s > 0.41) {
      this.view.setRenderScale(Math.max(0.4, +(s - 0.05).toFixed(2)));
      this.drCool = 2000; this.drFrames.fill(0); this.scaleLog.push(this.view.renderScale);
      this.drDownAt = performance.now();
    } else if (fast === 0 && s < this.drMax - 0.01 && performance.now() - this.drDownAt > 15000) {
      this.view.setRenderScale(Math.min(this.drMax, +(s + 0.05).toFixed(2)));
      this.drCool = 6000; this.drFrames.fill(0); this.scaleLog.push(this.view.renderScale);
    } else this.drCool = 300;
  }
}
