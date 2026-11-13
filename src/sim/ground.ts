// Ground interface the vehicle queries: analytic height field + normal + surface + obstacles.
import { Surface } from '../data/surfaces';
import { V3 } from './math/vec';

export interface Obstacle {
  kind: 'cyl' | 'sphere';
  x: number; y: number; z: number;
  /** radius */
  r: number;
  /** cylinder height (cyl only, from y up) */
  h: number;
}

export interface Ground {
  height(x: number, z: number): number;
  /** unit surface normal at (x,z) written into out */
  normal(x: number, z: number, out: V3): V3;
  surface(x: number, z: number): Surface;
  /** visit obstacles that may touch a sphere at (x,z) with radius r */
  obstaclesNear(x: number, z: number, r: number, visit: (o: Obstacle) => void): void;
}

/** numeric normal from any height function */
export function normalFromHeight(h: (x: number, z: number) => number, x: number, z: number, out: V3, e = 0.25) {
  const dx = h(x + e, z) - h(x - e, z);
  const dz = h(x, z + e) - h(x, z - e);
  return out.set(-dx, 2 * e, -dz).normalize();
}

/** Uniform 2D grid of obstacles for fast proximity queries. */
export class ObstacleGrid {
  private cells = new Map<number, Obstacle[]>();
  constructor(readonly cell = 16) {}
  private key(ix: number, iz: number) { return (ix + 32768) * 65536 + (iz + 32768); }
  add(o: Obstacle) {
    const r = o.r;
    const x0 = Math.floor((o.x - r) / this.cell), x1 = Math.floor((o.x + r) / this.cell);
    const z0 = Math.floor((o.z - r) / this.cell), z1 = Math.floor((o.z + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = this.key(ix, iz);
      let a = this.cells.get(k);
      if (!a) this.cells.set(k, (a = []));
      a.push(o);
    }
  }
  near(x: number, z: number, r: number, visit: (o: Obstacle) => void) {
    const x0 = Math.floor((x - r) / this.cell), x1 = Math.floor((x + r) / this.cell);
    const z0 = Math.floor((z - r) / this.cell), z1 = Math.floor((z + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const a = this.cells.get(this.key(ix, iz));
      if (a) for (let i = 0; i < a.length; i++) visit(a[i]);
    }
  }
}

/** Test pads for probes: flat gravel plane with optional features. */
export class TestGround implements Ground {
  grid = new ObstacleGrid();
  constructor(
    readonly surf: Surface = Surface.Gravel,
    /** optional extra height feature h(x,z) */
    readonly feature: ((x: number, z: number) => number) | null = null,
  ) {}
  height(x: number, z: number) { return this.feature ? this.feature(x, z) : 0; }
  normal(x: number, z: number, out: V3) {
    if (!this.feature) return out.set(0, 1, 0);
    return normalFromHeight((a, b) => this.height(a, b), x, z, out, 0.15);
  }
  surface() { return this.surf; }
  obstaclesNear(x: number, z: number, r: number, visit: (o: Obstacle) => void) { this.grid.near(x, z, r, visit); }
}
