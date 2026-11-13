// Deterministic PRNG and 2D gradient noise. Pure functions of seed — identical in Node and Chrome.

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }
  /** mulberry32, [0,1) */
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p: number) { return this.next() < p; }
}

export function hash2(x: number, y: number, seed: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 2D value-gradient noise in [-1,1] (Perlin style with hashed gradients) */
export function noise2(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const a = hash2(ix, iy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(xi, yi, xf, yf), n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1), n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  const nx0 = n00 + (n10 - n00) * u, nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.414;
}

/** fractal noise; returns roughly [-1,1] */
export function fbm(x: number, y: number, seed: number, octaves: number, lacunarity = 2, gain = 0.5) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * noise2(x * f, y * f, seed + i * 1013);
    norm += a; a *= gain; f *= lacunarity;
  }
  return sum / norm;
}

/** ridged fractal noise in [0,1] (sharp crests for mountains) */
export function ridged(x: number, y: number, seed: number, octaves: number) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * f, y * f, seed + i * 977));
    sum += a * n * n; norm += a; a *= 0.5; f *= 2.03;
  }
  return sum / norm;
}
