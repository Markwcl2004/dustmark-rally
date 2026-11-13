// Script segments → planar centerline (clothoid-eased arcs), with self-intersection rerolls.
import { Rng } from '../math/rng';
import type { Dir, Grade, Range, Segment, StageDef, TurnMod, Feature } from './script';
import { GRADE_ANGLE, GRADE_RADIUS } from './script';

/** a resolved corner or straight on the centerline */
export interface Piece {
  kind: 'line' | 'turn';
  /** index of the script segment this came from */
  seg: number;
  s0: number;
  s1: number;
  /** turns */
  dir?: Dir;
  grade?: Grade;
  mods?: TurnMod[];
  radius?: number;
  /** signed turn angle (rad, + = right) */
  angle?: number;
  /** features resolved to absolute s */
  features: ResolvedFeature[];
  lake?: Dir;
  /** scenery zone (inherited from the last segment that set one) */
  zone: string;
}

export interface ResolvedFeature { kind: Feature['kind']; s: number; height: number; length: number; count: number; water: boolean }

export interface Centerline {
  /** samples every DS metres */
  n: number;
  x: Float64Array;
  z: Float64Array;
  theta: Float64Array;
  kappa: Float64Array;
  length: number;
  pieces: Piece[];
  rerolls: number;
  warnings: string[];
}

export const DS = 1;

const pickR = (r: Range | undefined, rng: Rng, d: [number, number]) => {
  const v = r ?? d;
  return typeof v === 'number' ? v : rng.range(v[0], v[1]);
};

interface Prim { len: number; k0: number; k1: number; piece: Piece }

/** expand one segment into curvature primitives (linear κ ramps) */
function expand(seg: Segment, segIdx: number, rng: Rng, jitter: number): Prim[] {
  const out: Prim[] = [];
  const turn = (dir: Dir, grade: Grade, angleR: Range | undefined, mods: TurnMod[], features: Feature[] | undefined, lake?: Dir) => {
    const rr = GRADE_RADIUS[String(grade)];
    let R = rng.range(rr[0], rr[1]);
    const ar = GRADE_ANGLE[String(grade)];
    let ang = pickR(angleR, rng, ar) * (1 + jitter * rng.range(-0.25, 0.25));
    if (mods.includes('long')) ang *= 1.45;
    ang = (Math.min(ang, 200) * Math.PI) / 180;
    const sgn = dir === 'R' ? 1 : -1;
    let Rin = R, Rout = R;
    if (mods.includes('tightens')) { Rin = R * 1.5; Rout = R * 0.85; R = Rout; }
    if (mods.includes('opens')) { Rin = R * 0.85; Rout = R * 1.6; R = Rin; }
    const kin = sgn / Rin, kout = sgn / Rout;
    // transition length grows with radius (clothoid entry/exit)
    let Lc = Math.min(40, Math.max(6, R * 0.45));
    // arc length so that ∫κ = angle: entry ramp adds kin*Lc/2, exit ramp kout*Lc/2, arc avg (kin+kout)/2
    let Larc = (ang - (Math.abs(kin) + Math.abs(kout)) * Lc / 2) / ((Math.abs(kin) + Math.abs(kout)) / 2);
    if (Larc < 2) {
      Lc = Math.max(3, ang / ((Math.abs(kin) + Math.abs(kout)) / 2) / 2 - 1);
      Larc = Math.max(2, (ang - (Math.abs(kin) + Math.abs(kout)) * Lc / 2) / ((Math.abs(kin) + Math.abs(kout)) / 2));
    }
    const piece: Piece = { kind: 'turn', seg: segIdx, s0: 0, s1: 0, dir, grade, mods, radius: Math.min(Rin, Rout), angle: sgn * ang, features: [], lake, zone: '' };
    out.push({ len: Lc, k0: 0, k1: kin, piece });
    out.push({ len: Larc, k0: kin, k1: kout, piece });
    out.push({ len: Lc, k0: kout, k1: 0, piece });
    (piece as Piece & { _f?: Feature[] })._f = features;
  };
  if (seg.kind === 'straight') {
    const len = pickR(seg.len, rng, [100, 100]) * (1 + jitter * rng.range(-0.2, 0.2));
    const piece: Piece = { kind: 'line', seg: segIdx, s0: 0, s1: 0, features: [], lake: seg.lake, zone: '' };
    (piece as Piece & { _f?: Feature[] })._f = seg.features;
    if (seg.bend !== undefined) {
      // gentle sweep: total angle spread over the straight
      const a = (pickR(seg.bend, rng, [0, 0]) * Math.PI) / 180;
      const k = a / (len * 0.6);
      out.push({ len: len * 0.2, k0: 0, k1: k, piece }, { len: len * 0.4, k0: k, k1: k, piece }, { len: len * 0.4, k0: k, k1: 0, piece });
    } else out.push({ len, k0: 0, k1: 0, piece });
  } else if (seg.kind === 'turn') {
    turn(seg.dir, seg.grade, seg.angle, seg.mods ?? [], seg.features, seg.lake);
  } else {
    let dir = seg.dir;
    seg.grades.forEach((g, i) => {
      if (i > 0) {
        const gl = pickR(seg.gap, rng, [8, 20]);
        const piece: Piece = { kind: 'line', seg: segIdx, s0: 0, s1: 0, features: [], zone: '' };
        out.push({ len: gl, k0: 0, k1: 0, piece });
      }
      turn(dir, g, seg.angle, [], undefined);
      dir = dir === 'L' ? 'R' : 'L';
    });
  }
  return out;
}

export function buildCenterline(def: StageDef, minClear = 35): Centerline {
  const rng = new Rng(def.seed * 7919 + 17);
  const xs: number[] = [0], zs: number[] = [0], th: number[] = [0], ks: number[] = [0];
  const pieces: Piece[] = [];
  const warnings: string[] = [];
  let rerolls = 0;
  // spatial hash of committed samples (every 2 m)
  const CELL = 40;
  const grid = new Map<number, number[]>();
  const key = (x: number, z: number) => (Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096);
  const addGrid = (i: number) => { const k = key(xs[i], zs[i]); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); };
  let lastHairpinS = -1e9;
  let zone = '';
  const hairpinS: number[] = [];

  for (let si = 0; si < def.segments.length; si++) {
    const seg = def.segments[si];
    if (seg.zone) zone = seg.zone;
    let committed = false;
    for (let attempt = 0; attempt < 40 && !committed; attempt++) {
      const prims = expand(seg, si, rng, Math.min(1, attempt / 6));
      // integrate
      const cx: number[] = [], cz: number[] = [], ct: number[] = [], ck: number[] = [];
      let x = xs[xs.length - 1], z = zs[zs.length - 1], t = th[th.length - 1];
      let carry = 0; // fractional metres carried between primitives
      const segStart = xs.length - 1;
      const localPieces: Piece[] = [];
      let sAcc = segStart * DS;
      for (const p of prims) {
        if (!localPieces.includes(p.piece)) { localPieces.push(p.piece); p.piece.s0 = sAcc; }
        let u = carry;
        while (u < p.len) {
          const k = p.k0 + ((p.k1 - p.k0) * (u + DS / 2)) / p.len;
          const tm = t + (k * DS) / 2;
          x += Math.cos(tm) * DS; z += Math.sin(tm) * DS; t += k * DS;
          cx.push(x); cz.push(z); ct.push(t); ck.push(k);
          u += DS; sAcc += DS;
        }
        carry = u - p.len;
        p.piece.s1 = sAcc;
      }
      // self-intersection check against committed road
      let ok = true;
      const sNow = segStart * DS;
      for (let i = 0; i < cx.length && ok; i += 2) {
        const sc = sNow + (i + 1) * DS;
        const kx = Math.floor(cx[i] / CELL), kz = Math.floor(cz[i] / CELL);
        for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) {
          const arr = grid.get((kx + a + 4096) * 8192 + (kz + b + 4096));
          if (!arr) continue;
          for (const j of arr) {
            const sj = j * DS;
            if (sc - sj < 90) continue;
            // a hairpin between the two points: legs may run closer
            const hp = hairpinS.some((h) => h > sj - 40 && h < sc + 40) && sc - sj < 260;
            const need = hp ? 16 : minClear;
            const dx = cx[i] - xs[j], dz = cz[i] - zs[j];
            if (dx * dx + dz * dz < need * need) { ok = false; break; }
          }
        }
      }
      if (!ok && attempt < 39) { rerolls++; continue; }
      if (!ok) warnings.push(`segment ${si}: could not avoid self-intersection`);
      for (let i = 0; i < cx.length; i++) { xs.push(cx[i]); zs.push(cz[i]); th.push(ct[i]); ks.push(ck[i]); }
      for (let i = segStart; i < xs.length; i += 2) addGrid(i);
      for (const p of localPieces) {
        p.zone = zone;
        pieces.push(p);
        if (p.grade === 'hairpin') { lastHairpinS = (p.s0 + p.s1) / 2; hairpinS.push(lastHairpinS); }
        const f = (p as Piece & { _f?: Feature[] })._f;
        if (f) for (const ft of f) {
          const at = pickR(ft.at, rng, [0.5, 0.5]);
          p.features.push({
            kind: ft.kind,
            s: p.s0 + (p.s1 - p.s0) * at,
            height: pickR(ft.height, rng, ft.kind === 'jump' ? [1.4, 1.8] : ft.kind === 'crest' ? [2.5, 4] : ft.kind === 'dip' ? [1.5, 2.5] : ft.kind === 'ford' ? [1.1, 1.4] : [0.8, 1.2]),
            length: pickR(ft.length, rng, ft.kind === 'jump' ? [22, 22] : ft.kind === 'crest' ? [60, 90] : ft.kind === 'dip' ? [50, 70] : ft.kind === 'ford' ? [44, 56] : [30, 40]),
            count: ft.count ?? 3,
            water: ft.water ?? true,
          });
          delete (p as Piece & { _f?: Feature[] })._f;
        }
      }
      committed = true;
    }
  }
  const n = xs.length;
  const cl: Centerline = {
    n, x: Float64Array.from(xs), z: Float64Array.from(zs), theta: Float64Array.from(th), kappa: Float64Array.from(ks),
    length: (n - 1) * DS, pieces, rerolls, warnings,
  };
  return def.reverse ? reverseCenterline(cl) : cl;
}

const SWAP_MOD: Partial<Record<TurnMod, TurnMod>> = { tightens: 'opens', opens: 'tightens' };

/** the same road driven the other way: samples reversed, headings turned round, curvature and corner directions
 *  flipped, "tightens" ↔ "opens", features mirrored to the new arc length (a jump's kicker is rebuilt facing the
 *  new direction by the profile builder) */
export function reverseCenterline(cl: Centerline): Centerline {
  const n = cl.n, L = cl.length;
  const x = new Float64Array(n), z = new Float64Array(n), theta = new Float64Array(n), kappa = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    x[i] = cl.x[j]; z[i] = cl.z[j]; theta[i] = cl.theta[j] + Math.PI; kappa[i] = -cl.kappa[j];
  }
  const flip = (d?: Dir): Dir | undefined => (d === 'L' ? 'R' : d === 'R' ? 'L' : undefined);
  const pieces: Piece[] = cl.pieces.slice().reverse().map((p) => ({
    ...p,
    s0: L - p.s1, s1: L - p.s0,
    dir: flip(p.dir), lake: flip(p.lake),
    angle: p.angle === undefined ? undefined : -p.angle,
    mods: p.mods?.map((m) => SWAP_MOD[m] ?? m),
    features: p.features.map((f) => ({ ...f, s: L - f.s })).reverse(),
  }));
  return { n, x, z, theta, kappa, length: L, pieces, rerolls: cl.rerolls, warnings: cl.warnings };
}
