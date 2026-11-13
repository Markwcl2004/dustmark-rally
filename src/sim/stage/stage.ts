// Stage = environment + seed + script → centerline, profile, height field, surfaces, obstacles, pace notes.
import { ENVS, envWithWeather, type EnvDef, type WeatherDef } from '../../data/envs';
import type { Surface } from '../../data/surfaces';
import { ObstacleGrid, type Ground, type Obstacle } from '../ground';
import { V3, clamp } from '../math/vec';
import { DS, buildCenterline, type Centerline } from './centerline';
import { buildPacenotes, type PaceNote } from './pacenotes';
import { hash2 } from '../math/rng';
import { buildProfile } from './profile';
import { Corridor, Zones, scatter, type Marker, type Prop, type TapeLine } from './scatter';
import type { StageDef } from './script';
import { Terrain } from './terrain';

export const CORRIDOR = 210;

export class Stage implements Ground {
  readonly def: StageDef;
  /** environment with the weather variant's palette/look applied */
  readonly env: EnvDef;
  readonly weather: WeatherDef;
  readonly weatherId: string;
  readonly cl: Centerline;
  readonly terrain: Terrain;
  readonly corridor: Corridor;
  /** scenery zones along the road (from the script) */
  readonly zones: Zones;
  readonly notes: PaceNote[];
  readonly props: Prop[];
  readonly markers: Marker[];
  readonly tape: TapeLine[];
  readonly rails: TapeLine[];
  readonly obstacles: Obstacle[];
  readonly startS: number;
  readonly finishS: number;
  readonly length: number;
  private grid = new ObstacleGrid(16);
  private extraNotes: PaceNote[] = [];

  constructor(def: StageDef) {
    this.def = def;
    const base = ENVS[def.env];
    if (!base) throw new Error(`unknown env ${def.env}`);
    const ew = envWithWeather(base, def.weather);
    this.env = ew.env; this.weather = ew.weather; this.weatherId = ew.weatherId;
    this.cl = buildCenterline(def);
    this.terrain = new Terrain(this.cl, this.env, def.seed, def.halfWidth);
    this.terrain.grip = this.weather.grip ?? {};
    const cst = this.env.terrain.coast;
    if (cst) {
      // sea side: perpendicular to the forward start→finish chord (the same world for both directions)
      const cl = this.cl, n = cl.n;
      let ax = cl.x[n - 1] - cl.x[0], az = cl.z[n - 1] - cl.z[0];
      if (def.reverse) { ax = -ax; az = -az; }
      const L = Math.hypot(ax, az) || 1; ax /= L; az /= L;
      const side = (def.sea ?? 'L') === 'R' ? 1 : -1;
      let mx = 0, mz = 0; for (let i = 0; i < n; i += 10) { mx += cl.x[i]; mz += cl.z[i]; } mx /= Math.ceil(n / 10); mz /= Math.ceil(n / 10);
      this.terrain.coast = { cx: mx, cz: mz, nx: -az * side, nz: ax * side, amp: cst.amp, width: cst.width, seaLevel: cst.seaLevel };
    }
    this.zones = new Zones(this.cl.pieces, this.env, this.cl.length);
    const follow = new Float64Array(this.cl.n);
    for (let i = 0; i < this.cl.n; i++) follow[i] = this.zones.def(i * DS).follow;
    const { prof, lakes } = buildProfile(this.cl, this.terrain, this.env.terrain.maxGrade, this.env.terrain.smooth, def.halfWidth, follow, this.env.terrain.crestSpeed ?? 0);
    this.terrain.prof = prof;
    this.terrain.lakes = lakes;
    if (cst && this.terrain.coast) {
      // the sea sits a fixed depth under the lowest stretch of road
      let lo = Infinity; for (let i = 0; i < prof.length; i += 5) lo = Math.min(lo, prof[i]);
      this.terrain.coast.seaLevel = Math.min(lo - 22, cst.seaLevel);
    }
    // sea cliffs: the shoreline comes up under the road along `seacliff` zones
    if (this.terrain.coast) {
      const n = this.cl.n, raw = new Uint8Array(n);
      let any = false;
      for (let i = 0; i < n; i++) if (this.zones.def(i * DS).seacliff) { raw[i] = 1; any = true; }
      if (any) this.terrain.buildSeaCliff(raw);
    }
    // per-sample zone data: snow walls, gravel stretches, ice patches
    {
      const n = this.cl.n;
      const wall = new Float32Array(n), grav = new Uint8Array(n), ice = new Uint8Array(n);
      let anyWall = false, anyGrav = false, anyIce = false;
      for (let i = 0; i < n; i++) {
        const zd = this.zones.def(i * DS);
        if (zd.wall) { wall[i] = zd.wall; anyWall = true; }
        if (zd.road === 'gravel') { grav[i] = 1; anyGrav = true; }
      }
      if (anyWall) {
        // smooth wall height changes; walls open up around the start/finish areas and at tight corners' outsides stay
        const w2 = new Float32Array(n);
        for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - 30); j <= Math.min(n - 1, i + 30); j += 3) { a += wall[j]; c++; } w2[i] = a / c; }
        for (let i = 0; i < n; i++) { const s = i * DS; const k = Math.min(1, Math.abs(s - 60) / 80, Math.abs(s - (this.cl.length - 170)) / 80); w2[i] *= 0.35 + 0.65 * Math.max(0, k); }
        this.terrain.wallH = w2;
      }
      if (anyGrav) this.terrain.gravel = grav;
      // ice: patches of 15–45 m, more where the zone says so; never in the first/last 150 m
      const notesIce: PaceNote[] = [];
      for (let s = 200; s < this.cl.length - 260;) {
        const zd = this.zones.def(s);
        const p = zd.ice ?? 0;
        if (p > 0 && hash2(Math.floor(s / 10), 7, def.seed + 91) < p * 0.18) {
          const len = 15 + hash2(Math.floor(s / 10), 8, def.seed + 91) * 30;
          for (let i = Math.floor(s / DS); i < Math.min(n, Math.ceil((s + len) / DS)); i++) ice[i] = 1;
          anyIce = true;
          notesIce.push({ s: s - 5, kind: 'caution', text: '小心 冰面', mods: [], words: ['小心', '冰面'] });
          s += len + 80;
        } else s += 10;
      }
      if (anyIce) this.terrain.ice = ice;
      this.extraNotes = notesIce;
    }
    // fords: a river channel across the road at every ford feature
    for (const pc of this.cl.pieces) for (const f of pc.features) {
      if (f.kind !== 'ford') continue;
      const p = this.pointAt(f.s);
      const bottom = prof[Math.round(f.s / DS)] ?? p.y;
      this.terrain.fords.push({ cx: p.x, cz: p.z, ux: -p.dz, uz: p.dx, hw: f.length * 0.32, bed: bottom - 0.85, level: bottom + 0.26, water: f.water, s: f.s });
    }
    this.startS = 60;
    this.finishS = this.cl.length - 170;
    this.length = this.finishS - this.startS;
    this.corridor = new Corridor(this.cl, CORRIDOR);
    const sc = scatter(this.cl, this.terrain, this.env, this.corridor, this.zones, def.seed, this.startS, this.finishS, [
      { s: this.startS, r: 26 }, { s: this.finishS, r: 26 }, { s: 0, r: 30 }, { s: this.cl.length, r: 40 },
    ]);
    this.props = sc.props;
    this.markers = sc.markers;
    this.tape = sc.tape;
    this.rails = sc.rails;
    this.obstacles = sc.obstacles;
    // arch legs are solid
    for (const m of this.markers) {
      if (m.kind !== 'start' && m.kind !== 'finish') continue;
      const p = this.pointAt(m.s);
      for (const side of [-1, 1]) {
        const d = this.terrain.edge2 + 1.2;
        this.obstacles.push({ kind: 'cyl', x: p.x + p.rx * d * side, y: p.y - 1, z: p.z + p.rz * d * side, r: 0.32, h: 8 });
      }
    }
    for (const o of this.obstacles) this.grid.add(o);
    this.notes = buildPacenotes(this.cl.pieces, this.finishS, this.extraNotes);
  }

  height(x: number, z: number) { return this.terrain.height(x, z); }
  normal(x: number, z: number, out: V3) { return this.terrain.normal(x, z, out); }
  surface(x: number, z: number): Surface { return this.terrain.surface(x, z); }
  obstaclesNear(x: number, z: number, r: number, visit: (o: Obstacle) => void) { this.grid.near(x, z, r, visit); }

  /** centreline point at arc length s: position, road height, tangent (dx,dz), right vector */
  pointAt(s: number) {
    const cl = this.cl;
    const f = clamp(s / DS, 0, cl.n - 1.0001);
    const i = Math.floor(f), t = f - i;
    const x = cl.x[i] + (cl.x[i + 1] - cl.x[i]) * t, z = cl.z[i] + (cl.z[i + 1] - cl.z[i]) * t;
    const th = cl.theta[i] + (cl.theta[i + 1] - cl.theta[i]) * t;
    const dx = Math.cos(th), dz = Math.sin(th);
    return { x, z, y: this.terrain.profAt(s), dx, dz, rx: -dz, rz: dx, theta: th, kappa: cl.kappa[i] };
  }

  /** arc length of the nearest centreline point, searched near a hint (keeps progress continuous across nearby road sections) */
  trackS(x: number, z: number, hint: number, back = 40, ahead = 120) {
    const cl = this.cl;
    const i0 = Math.max(0, Math.floor((hint - back) / DS)), i1 = Math.min(cl.n - 2, Math.ceil((hint + ahead) / DS));
    let best = hint, bd = Infinity;
    for (let i = i0; i <= i1; i++) {
      const ax = cl.x[i], az = cl.z[i], ex = cl.x[i + 1] - ax, ez = cl.z[i + 1] - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      const dx = x - (ax + ex * t), dz = z - (az + ez * t);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = (i + t) * DS; }
    }
    return { s: best, dist: Math.sqrt(bd) };
  }
}

const cache = new Map<string, Stage>();
export function getStage(def: StageDef) {
  let s = cache.get(def.id);
  if (!s) { s = new Stage(def); cache.set(def.id, s); }
  return s;
}
