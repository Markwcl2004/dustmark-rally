// Trajectory prediction overlay (DESIGN §4 轨迹预测). The sim-side Predictor runs in a Web Worker (its own copy of
// the stage; the main thread only snapshots the car state and unpacks the result); until the worker is up, or if it
// cannot start, it runs here in small time-boxed slices per frame. The result is drawn on the road: a car-wide band (green on the road / yellow sliding / red off the road or crashing, dashed
// while airborne, fading with time), a heading arrow every 0.5 s, a translucent car at the end, and a cross at an
// impact. All geometry lives in fixed-size buffers that are rewritten in place; nothing is rebuilt per update.
import * as THREE from 'three';
import type { Stage } from '../sim/stage/stage';
import { DT, type Car } from '../sim/vehicle/car';
import type { DriverInput } from '../sim/vehicle/controls';
import { V3 } from '../sim/math/vec';
import { Predictor, STOP_NONE, Trajectory, copyState, packedSize, stageOffRoad, unpackTrajectory } from '../sim/vehicle/predict';
import { STAGES } from '../data/stages';
import { buildCarModel } from './carModel';
import type { PredictWorkerIn, PredictWorkerOut } from './predictWorker';

/** main-thread budget per frame for the prediction itself (ms); DESIGN: average ≤ 1 ms */
const BUDGET_MS = 0.75;
/** don't start predictions more often than this (Hz) */
const MAX_HZ = 30;
const LIFT = 0.07;
const SLIP_YELLOW_DEG: [number, number] = [9, 15];
const ACROSS = [-1, -0.5, 0, 0.5, 1];
const NA = ACROSS.length;
const BAND_ATTRS = ['position', 'aCol', 'aLine'];
const ARROW_TMP = new Float32Array(18);

const COL = {
  green: new THREE.Color('#5aa865'),
  yellow: new THREE.Color('#e8b23a'),
  red: new THREE.Color('#d23a2b'),
  cream: new THREE.Color('#f1ece0'),
  ink: new THREE.Color('#1f1d1a'),
};

const BAND_VERT = /* glsl */ `
attribute vec4 aCol;
attribute vec3 aLine; // u across (-1..1), arc length (m), airborne (0/1)
varying vec4 vCol;
varying vec3 vLine;
void main() {
  vCol = aCol; vLine = aLine;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BAND_FRAG = /* glsl */ `
uniform float uArc0; // arc length at the car's current position: the first metres (under / just ahead of the car) fade in
varying vec4 vCol;
varying vec3 vLine;
void main() {
  if (vLine.z > 0.5 && fract(vLine.y / 4.0) > 0.5) discard;   // airborne: dashes
  float au = abs(vLine.x);
  float rail = smoothstep(0.68, 0.76, au);
  float a = vCol.a * mix(0.34, 0.95, rail) * (1.0 - smoothstep(0.97, 1.0, au) * 0.6);
  a *= mix(0.25, 1.0, smoothstep(uArc0 + 1.5, uArc0 + 6.0, vLine.y));
  vec3 c = mix(vCol.rgb, vCol.rgb * 0.8, rail);
  gl_FragColor = vec4(c, a);
}`;

export interface PredictStats {
  /** EMA of main-thread ms spent on prediction per frame (frames where it is on) */
  msPerFrame: number;
  /** completed predictions per second */
  hz: number;
  /** last completed prediction: total ms of stepping, frames it took (worker: ms in the worker, 0 frames) */
  lastMs: number; lastFrames: number;
  /** 'worker' once the worker answers, 'local' = sliced on the main thread */
  mode: 'local' | 'worker';
  /** steps per frame currently allowed by the budget */
  stepsPerFrame: number;
}

export class PredictOverlay {
  readonly group = new THREE.Group();
  readonly predictor: Predictor;
  enabled: boolean;
  horizon: number;
  stats: PredictStats = { msPerFrame: 0, hz: 0, lastMs: 0, lastFrames: 0, mode: 'local', stepsPerFrame: 60 };

  private band: THREE.Mesh;
  private bandPos: Float32Array; private bandCol: Float32Array; private bandLine: Float32Array;
  private marks: THREE.Mesh;
  private markPos: Float32Array; private markCol: Float32Array;
  private ghost = new THREE.Group();
  private ghostMat: THREE.MeshLambertMaterial;
  private cross = new THREE.Group();
  private crossMats: THREE.MeshBasicMaterial[] = [];
  private usPerStep = 12;
  private lastStart = -1e9;
  private jobMs = 0; private jobFrames = 0;
  private hzWin: number[] = [];
  private shownTag = -1;
  private haveResult = false;
  private secT: Float32Array; private secArc: Float32Array; private nSec = 0;
  private markT = new Float32Array(8); private nMark = 0;
  private ghostOn = false;
  /** trajectory currently drawn */
  private cur: Trajectory | null = null;
  // worker
  private worker: Worker | null = null;
  private workerState: 'none' | 'starting' | 'ready' | 'failed' = 'none';
  private inFlight = false;
  private buf: ArrayBuffer | null = null;
  private recv: Trajectory;
  private snap: Record<string, unknown> = {};
  private stageKey: string | undefined;
  private spec: Car['spec'];
  private lastCar: Car | null = null;
  private lastTick = 0;
  // scratch
  private c1 = new THREE.Color(); private v1 = new THREE.Vector3(); private v2 = new THREE.Vector3();
  private p0 = new V3();
  private readonly maxSections: number;
  private readonly cgH: number;
  private readonly maxMarks = 8;

  constructor(stage: Stage, car: Car, opts: { on?: boolean; horizon?: number } = {}) {
    this.horizon = Math.min(4, Math.max(1.5, opts.horizon ?? 2.5));
    this.cgH = car.spec.cgHeight;
    this.predictor = new Predictor(car, stage, { horizon: this.horizon, offRoad: stageOffRoad(stage.terrain) });
    this.recv = new Trajectory(this.predictor.result.cap);
    this.buf = new Float32Array(packedSize(this.recv.cap)).buffer;
    this.spec = car.spec;
    this.stageKey = Object.keys(STAGES).find((k) => STAGES[k] === stage.def);
    // the switch lives in the save's settings (game passes it in; P goes through the game to the save)
    this.enabled = opts.on ?? false;
    this.group.name = 'predict-overlay';
    this.group.visible = false;

    // ---- band: NA vertices per section ----
    const cap = this.predictor.result.cap + 2;
    this.maxSections = cap;
    this.secT = new Float32Array(cap); this.secArc = new Float32Array(cap);
    this.bandPos = new Float32Array(cap * NA * 3);
    this.bandCol = new Float32Array(cap * NA * 4);
    this.bandLine = new Float32Array(cap * NA * 3);
    const idx: number[] = [];
    for (let i = 0; i < cap - 1; i++) for (let k = 0; k < NA - 1; k++) {
      const a = i * NA + k, b = a + 1, c = a + NA, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(this.bandPos, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aCol', new THREE.BufferAttribute(this.bandCol, 4).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aLine', new THREE.BufferAttribute(this.bandLine, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setIndex(idx);
    bg.setDrawRange(0, 0);
    const bm = new THREE.ShaderMaterial({
      vertexShader: BAND_VERT, fragmentShader: BAND_FRAG, uniforms: { uArc0: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.band = new THREE.Mesh(bg, bm);
    this.band.frustumCulled = false;
    this.band.renderOrder = 10;
    this.group.add(this.band);

    // ---- heading arrows: outline (ink) + fill (cream), 9 vertices each, non-indexed ----
    const vPer = 18;
    this.markPos = new Float32Array(this.maxMarks * vPer * 3);
    this.markCol = new Float32Array(this.maxMarks * vPer * 4);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(this.markPos, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('color', new THREE.BufferAttribute(this.markCol, 4).setUsage(THREE.DynamicDrawUsage));
    mg.setDrawRange(0, 0);
    this.marks = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    }));
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 11;
    this.group.add(this.marks);

    // ---- end-of-path car: low-LOD model, depth pre-pass + one translucent colour pass (no doubled layers) ----
    this.ghostMat = new THREE.MeshLambertMaterial({ color: COL.green, emissive: COL.green.clone().multiplyScalar(0.25), transparent: true, opacity: 0.3, depthWrite: false });
    const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true });
    const model = buildCarModel(car.spec, 0, { lod: 1 });
    model.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(model.root.matrixWorld).invert();
    const meshes: THREE.Mesh[] = [];
    model.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible) meshes.push(m); });
    for (const m of meshes) {
      const local = new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld);
      for (const [mat, order] of [[depthMat, 20], [this.ghostMat, 21]] as const) {
        let g: THREE.Mesh;
        if ((m as THREE.InstancedMesh).isInstancedMesh) {
          const im = m as THREE.InstancedMesh;
          const n = new THREE.InstancedMesh(im.geometry, mat, im.count);
          n.instanceMatrix.copy(im.instanceMatrix);
          g = n;
        } else g = new THREE.Mesh(m.geometry, mat);
        local.decompose(g.position, g.quaternion, g.scale);
        g.renderOrder = order;
        g.frustumCulled = false;
        this.ghost.add(g);
      }
    }
    // the LOD model's own materials/textures are not used
    for (const m of meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of mats) { for (const v of Object.values(mt)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose(); mt.dispose(); }
    }
    this.ghost.visible = false;
    this.group.add(this.ghost);

    // ---- impact cross (camera-facing): cream outline under a red cross ----
    const bar = (w: number, l: number) => new THREE.PlaneGeometry(w, l);
    for (const [w, l, col, order] of [[0.42, 1.75, COL.cream, 15], [0.22, 1.5, COL.red, 16]] as const) {
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.crossMats.push(mat);
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        const m = new THREE.Mesh(bar(w, l), mat);
        m.rotation.z = a; m.renderOrder = order; m.frustumCulled = false;
        this.cross.add(m);
      }
    }
    this.cross.visible = false;
    this.group.add(this.cross);
  }

  /** add to the scene and compile the programs now (not on the first P press) */
  attach(scene: THREE.Scene, renderer: THREE.WebGLRenderer, cam: THREE.Camera) {
    scene.add(this.group);
    const vis = [this.group.visible, this.ghost.visible, this.cross.visible];
    this.group.visible = this.ghost.visible = this.cross.visible = true;
    try { renderer.compile(this.group, cam, scene); } catch { /* compile is an optimisation only */ }
    [this.group.visible, this.ghost.visible, this.cross.visible] = vis;
  }

  toggle() { this.setEnabled(!this.enabled); return this.enabled; }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) { this.group.visible = false; this.haveResult = false; }
  }

  /** the run restarted (sim tick back to 0): forget the last trajectory and the rate limiter's clock, otherwise no new
   *  prediction starts until the new run's clock passes the old one */
  reset() {
    this.lastStart = -1e9;
    this.haveResult = false;
    this.cur = null;
    this.group.visible = false;
  }

  /** per frame. `show`: running phase (not countdown / finished); `frozen`: paused → keep the last picture */
  frame(car: Car, input: DriverInput, tick: number, show: boolean, frozen: boolean, cam: THREE.Camera) {
    if (!this.enabled || !show) { this.group.visible = false; this.haveResult = false; return; }
    if (!frozen) this.compute(car, input, tick);
    if (!this.haveResult || !this.cur) { this.group.visible = false; return; }
    // trim what the car has already driven since the prediction started (per frame: only draw ranges change)
    const tr = this.cur!;
    const age = Math.max(0, (tick - this.shownTag) * DT);
    const p0 = tr.posAt(age, this.p0);
    if (Math.hypot(p0.x - car.pos.x, p0.z - car.pos.z) > 6) { this.group.visible = false; return; } // reset / teleport
    this.group.visible = true;
    let k = 0;
    while (k < this.nSec - 2 && this.secT[k + 1] <= age) k++;
    const per = (NA - 1) * 6;
    this.band.geometry.setDrawRange(k * per, Math.max(0, this.nSec - 1 - k) * per);
    (this.band.material as THREE.ShaderMaterial).uniforms.uArc0.value = this.secArc[k];
    let m = 0;
    while (m < this.nMark && this.markT[m] < age + 0.3) m++;
    this.marks.geometry.setDrawRange(m * 18, (this.nMark - m) * 18);
    this.ghost.visible = this.ghostOn && Math.hypot(this.ghost.position.x - car.pos.x, this.ghost.position.z - car.pos.z) > 6;
    // the cross faces the camera
    if (this.cross.visible) this.cross.quaternion.copy(cam.quaternion);
  }

  private compute(car: Car, input: DriverInput, tick: number) {
    if (tick * DT < this.lastStart) this.lastStart = -1e9;
    this.lastCar = car; this.lastTick = tick;
    if (this.workerState === 'none') this.startWorker();
    if (this.workerState === 'ready') { this.request(car, input, tick); return; }
    const pr = this.predictor;
    const now = tick * DT;
    if (!pr.busy && now - this.lastStart >= 1 / MAX_HZ - 1e-6) {
      pr.opts.horizon = this.horizon;
      pr.begin(car, input, tick);
      this.lastStart = now;
      this.jobMs = 0; this.jobFrames = 0;
    }
    if (!pr.busy) { this.stats.msPerFrame *= 0.95; return; }
    const steps = this.stats.stepsPerFrame;
    const t0 = performance.now();
    const done = pr.advance(steps);
    const ms = performance.now() - t0;
    this.jobMs += ms; this.jobFrames++;
    this.stats.msPerFrame = this.stats.msPerFrame * 0.95 + ms * 0.05;
    // adapt the slice to the budget (per-step cost varies with ground-cache misses)
    if (steps > 0) this.usPerStep = this.usPerStep * 0.8 + ((ms * 1000) / steps) * 0.2;
    this.stats.stepsPerFrame = Math.max(10, Math.min(300, Math.floor((BUDGET_MS * 1000) / Math.max(1, this.usPerStep))));
    if (done) {
      this.stats.lastMs = this.jobMs; this.stats.lastFrames = this.jobFrames;
      const t = performance.now();
      this.hzWin.push(t);
      while (this.hzWin.length && t - this.hzWin[0] > 1000) this.hzWin.shift();
      this.stats.hz = this.hzWin.length;
      this.cur = pr.result;
      this.rebuild(pr.result, car, tick);
      // count the buffer rewrite in the frame cost too
      this.stats.msPerFrame += (performance.now() - t) * 0.05;
    }
  }

  private startWorker() {
    if (!this.stageKey || typeof Worker === 'undefined') { this.workerState = 'failed'; return; }
    try {
      this.worker = new Worker(new URL('./predictWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) { console.warn('[predict] worker unavailable, predicting on the main thread', e); this.workerState = 'failed'; return; }
    this.workerState = 'starting';
    this.worker.onmessage = (e: MessageEvent<PredictWorkerOut>) => this.onWorker(e.data);
    this.worker.onerror = (e) => { console.warn('[predict] worker error, predicting on the main thread', e.message); this.workerState = 'failed'; this.inFlight = false; this.worker?.terminate(); this.worker = null; };
    this.post({ type: 'init', stage: this.stageKey, spec: this.spec, horizon: this.horizon });
  }

  private post(m: PredictWorkerIn, transfer: Transferable[] = []) { this.worker!.postMessage(m, transfer); }

  /** worker mode: at most one request in flight, at most MAX_HZ per second of sim time */
  private request(car: Car, input: DriverInput, tick: number) {
    const now = tick * DT;
    if (this.inFlight || !this.buf || now - this.lastStart < 1 / MAX_HZ - 1e-6) return;
    const t0 = performance.now();
    copyState(this.snap, car);
    const buf = this.buf; this.buf = null;
    this.post({ type: 'predict', state: this.snap, input, tag: tick, horizon: this.horizon, buf }, [buf]);
    this.inFlight = true;
    this.lastStart = now;
    this.stats.msPerFrame = this.stats.msPerFrame * 0.95 + (performance.now() - t0) * 0.05;
  }

  private onWorker(m: PredictWorkerOut) {
    if (m.type === 'ready') { this.workerState = 'ready'; this.stats.mode = 'worker'; return; }
    if (m.type === 'error') { console.warn('[predict] worker:', m.message); this.workerState = 'failed'; this.inFlight = false; this.stats.mode = 'local'; return; }
    this.inFlight = false;
    this.buf = m.buf;
    if (!this.enabled || !this.lastCar) return;
    const t0 = performance.now();
    unpackTrajectory(new Float32Array(m.buf), this.recv);
    this.stats.lastMs = m.ms; this.stats.lastFrames = 0;
    this.hzWin.push(t0);
    while (this.hzWin.length && t0 - this.hzWin[0] > 1000) this.hzWin.shift();
    this.stats.hz = this.hzWin.length;
    this.cur = this.recv;
    this.rebuild(this.recv, this.lastCar, this.lastTick);
    this.stats.msPerFrame += (performance.now() - t0) * 0.05;
  }

  /** rewrite the buffers from a finished trajectory; `tick` = now, so the part already driven is trimmed */
  private rebuild(tr: Trajectory, car: Car, tick: number) {
    if (tr.n < 2) { this.haveResult = false; return; }
    const age = Math.max(0, (tick - tr.tag) * DT);
    // stale or the car was reset meanwhile → wait for the next one
    const p0 = tr.posAt(age, this.p0);
    if (Math.hypot(p0.x - car.pos.x, p0.z - car.pos.z) > 6) { this.haveResult = false; return; }
    this.shownTag = tr.tag;
    const H = Math.max(0.5, tr.horizon);
    const stopped = tr.stop !== STOP_NONE;
    // ---- band ----
    let ns = 0, arc = 0, px = 0, pz = 0;
    for (let i = 0; i < tr.n && ns < this.maxSections; i++) {
      // first section: interpolated at `age`
      let f = 1, j0 = i, j1 = i;
      if (tr.t[i] < age) {
        if (i + 1 < tr.n && tr.t[i + 1] > age) { j1 = i + 1; f = (age - tr.t[i]) / Math.max(1e-6, tr.t[i + 1] - tr.t[i]); } else continue;
      }
      const t = tr.t[j0] + (tr.t[j1] - tr.t[j0]) * f;
      const E = tr.edge;
      const lx = lerp(E[j0 * 6], E[j1 * 6], f), ly = lerp(E[j0 * 6 + 1], E[j1 * 6 + 1], f), lz = lerp(E[j0 * 6 + 2], E[j1 * 6 + 2], f);
      const rx = lerp(E[j0 * 6 + 3], E[j1 * 6 + 3], f), ry = lerp(E[j0 * 6 + 4], E[j1 * 6 + 4], f), rz = lerp(E[j0 * 6 + 5], E[j1 * 6 + 5], f);
      const cy = lerp(tr.groundY[j0], tr.groundY[j1], f);
      const cx = (lx + rx) / 2, cz = (lz + rz) / 2;
      if (ns > 0) arc += Math.hypot(cx - px, cz - pz);
      px = cx; pz = cz;
      // colour: green → yellow with body slip, red off the road / in the last 0.4 s before a crash
      const slipDeg = lerp(tr.slip[j0], tr.slip[j1], f) * 57.2958;
      const wy = smooth01((slipDeg - SLIP_YELLOW_DEG[0]) / (SLIP_YELLOW_DEG[1] - SLIP_YELLOW_DEG[0]));
      let wr = (tr.offRoad[j1] || tr.offRoad[j0]) ? 1 : 0;
      if (stopped) wr = Math.max(wr, smooth01(1 - (tr.stopT - t) / 0.4));
      const c = this.c1.copy(COL.green).lerp(COL.yellow, wy).lerp(COL.red, wr);
      const fade = 1 - 0.72 * Math.min(1, t / H);
      const air = tr.air[j0] && tr.air[j1] ? 1 : 0;
      // airborne: the ribbon follows the flight path (bottom of the wheels), never below the ground
      const flyY = air ? lerp(tr.pos[j0 * 3 + 1], tr.pos[j1 * 3 + 1], f) - this.cgH : -1e9;
      for (let k = 0; k < NA; k++) {
        const u = ACROSS[k], o = (ns * NA + k);
        // heights: left edge / CG / right edge ground, piecewise-linear across
        const y = u < 0 ? lerp(cy, ly, -u) : lerp(cy, ry, u);
        const s = (u + 1) / 2;
        this.bandPos[o * 3] = lx + (rx - lx) * s; this.bandPos[o * 3 + 1] = Math.max(y + LIFT, flyY); this.bandPos[o * 3 + 2] = lz + (rz - lz) * s;
        this.bandCol[o * 4] = c.r; this.bandCol[o * 4 + 1] = c.g; this.bandCol[o * 4 + 2] = c.b; this.bandCol[o * 4 + 3] = fade;
        this.bandLine[o * 3] = u; this.bandLine[o * 3 + 1] = arc; this.bandLine[o * 3 + 2] = air;
      }
      this.secT[ns] = t; this.secArc[ns] = arc;
      ns++;
    }
    this.nSec = ns;
    const bg = this.band.geometry;
    bg.setDrawRange(0, Math.max(0, ns - 1) * (NA - 1) * 6);
    for (const a of BAND_ATTRS) (bg.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;

    // ---- heading arrows every 0.5 s (not right under the car, not where the end car stands) ----
    let nm = 0;
    const lastT = tr.t[tr.n - 1];
    for (let k = 1; k * 0.5 < lastT - 0.2 && nm < this.maxMarks; k++) {
      const t = k * 0.5;
      if (t < age + 0.3) continue;
      const i = this.sampleAt(tr, t);
      this.markT[nm] = t;
      this.writeArrow(tr, i, nm++, 1 - 0.72 * Math.min(1, t / H));
    }
    this.nMark = nm;
    const mg = this.marks.geometry;
    mg.setDrawRange(0, nm * 18);
    (mg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (mg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    // ---- end car ----
    const e = tr.n - 1;
    const ex = tr.pos[e * 3], ey = tr.pos[e * 3 + 1], ez = tr.pos[e * 3 + 2];
    const far = Math.hypot(ex - car.pos.x, ez - car.pos.z) > 6;
    this.ghost.visible = this.ghostOn = far;
    if (far) {
      this.ghost.position.set(ex, ey, ez);
      this.ghost.quaternion.set(tr.quat[e * 4], tr.quat[e * 4 + 1], tr.quat[e * 4 + 2], tr.quat[e * 4 + 3]);
      const slipDeg = tr.slip[e] * 57.2958;
      const wy = smooth01((slipDeg - SLIP_YELLOW_DEG[0]) / (SLIP_YELLOW_DEG[1] - SLIP_YELLOW_DEG[0]));
      const c = this.c1.copy(COL.green).lerp(COL.yellow, wy).lerp(COL.red, stopped || tr.offRoad[e] ? 1 : 0);
      this.ghostMat.color.copy(c).lerp(COL.cream, 0.25);
      this.ghostMat.emissive.copy(c).multiplyScalar(0.3);
    }
    // ---- impact cross ----
    this.cross.visible = stopped;
    if (stopped) {
      this.cross.position.set(tr.hit.x, tr.hit.y + 0.2, tr.hit.z);
      // nudge toward the car so it is not swallowed by the trunk / bank it marks
      const d = this.v2.set(car.pos.x - tr.hit.x, 0, car.pos.z - tr.hit.z);
      const L = d.length();
      if (L > 1e-3) this.cross.position.addScaledVector(d, 0.7 / L);
    }
    this.haveResult = true;
  }

  private sampleAt(tr: Trajectory, t: number) {
    let i = 0;
    while (i < tr.n - 1 && tr.t[i] < t - 1e-4) i++;
    return i;
  }

  /** arrow on the ground at sample i along the body heading: ink outline then cream fill */
  private writeArrow(tr: Trajectory, i: number, slot: number, alpha: number) {
    const fx = tr.fwd[i * 2], fz = tr.fwd[i * 2 + 1];
    const rx = -fz, rz = fx;
    const cx = tr.pos[i * 3], cz = tr.pos[i * 3 + 2];
    // local ground plane from the CG ground point and the two band edges
    const E = tr.edge, gy = tr.groundY[i];
    const ex = E[i * 6 + 3] - E[i * 6], ey = E[i * 6 + 4] - E[i * 6 + 1], ez = E[i * 6 + 5] - E[i * 6 + 2];
    const el = Math.max(1e-3, ex * ex + ez * ez);
    const j = Math.min(tr.n - 1, i + 1), jb = Math.max(0, i - 1);
    const ax = tr.pos[j * 3] - tr.pos[jb * 3], az = tr.pos[j * 3 + 2] - tr.pos[jb * 3 + 2], ay = tr.groundY[j] - tr.groundY[jb];
    const al = Math.max(1e-3, ax * ax + az * az);
    const base = slot * 18;
    let v = base;
    for (let layer = 0; layer < 2; layer++) {
      const grow = layer === 0 ? 0.07 : 0, col = layer === 0 ? COL.ink : COL.cream, a = layer === 0 ? 0.45 : 0.95;
      // arrow shape (local: across, along the nose; metres): stem quad + head triangle
      const w = 0.13 + grow, h0 = -1.25 - grow, h1 = 0.45, hw = 0.6 + grow * 1.6, tip = 1.35 + grow * 1.4, hb = h1 - grow * 0.6;
      const P = ARROW_TMP;
      P[0] = -w; P[1] = h0; P[2] = w; P[3] = h0; P[4] = w; P[5] = h1; P[6] = -w; P[7] = h0; P[8] = w; P[9] = h1; P[10] = -w; P[11] = h1;
      P[12] = -hw; P[13] = hb; P[14] = hw; P[15] = hb; P[16] = 0; P[17] = tip;
      for (let k = 0; k < 9; k++) {
        const la = P[k * 2], lb = P[k * 2 + 1];
        const x = cx + rx * la + fx * lb, z = cz + rz * la + fz * lb;
        const dx = x - cx, dz = z - cz;
        const y = gy + ((dx * ex + dz * ez) / el) * ey + ((dx * ax + dz * az) / al) * ay;
        this.markPos[v * 3] = x; this.markPos[v * 3 + 1] = y + LIFT + 0.03; this.markPos[v * 3 + 2] = z;
        this.markCol[v * 4] = col.r; this.markCol[v * 4 + 1] = col.g; this.markCol[v * 4 + 2] = col.b; this.markCol[v * 4 + 3] = a * alpha;
        v++;
      }
    }
  }


  /** the trajectory currently drawn (tag = sim tick it started at), for tools */
  get shown() { return this.haveResult ? this.cur : null; }
  get shownTick() { return this.shownTag; }
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const smooth01 = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
