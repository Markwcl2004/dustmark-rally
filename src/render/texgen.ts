// Procedural placeholder textures (canvas). Neutral grey, mean luminance ≈ 0.5, tileable — tinted by the palette in shaders,
// exactly like the art pipeline's normalised ground textures, so real art drops in without retuning colours.
import { hash2, noise2 } from '../sim/math/rng';

type Painter = (g: CanvasRenderingContext2D, size: number) => void;

function canvas(size: number, paint: Painter) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  paint(g, size);
  return c;
}

/** tileable fbm in [-1,1] over a size×size domain with period p cells */
function tileNoise(x: number, y: number, p: number, seed: number, oct = 4) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) {
    const P = p * f;
    // periodic noise via 4-corner blend of the same noise with wrap
    const u = x * f, v = y * f;
    const nx = noise2(u, v, seed + o), nx1 = noise2(u - P, v, seed + o), ny1 = noise2(u, v - P, seed + o), nxy = noise2(u - P, v - P, seed + o);
    const tx = u / P, ty = v / P;
    const val = nx * (1 - tx) * (1 - ty) + nx1 * tx * (1 - ty) + ny1 * (1 - tx) * ty + nxy * tx * ty;
    s += val * a; n += a; a *= 0.5; f *= 2;
  }
  return s / n;
}

/** evaluate fn on a coarse wrap-around grid (cheap), upsample bilinearly with wrap to size×size */
function fieldImage(g: CanvasRenderingContext2D, size: number, fn: (x: number, y: number) => number, grain = 0.04, coarse = 128) {
  const C = coarse, f = new Float32Array(C * C), k = size / C;
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) f[y * C + x] = fn(x * k, y * k);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const fy = y / k, y0 = Math.floor(fy), ty = fy - y0, y1 = (y0 + 1) % C;
    for (let x = 0; x < size; x++) {
      const fx = x / k, x0 = Math.floor(fx), tx = fx - x0, x1 = (x0 + 1) % C;
      const v0 = f[y0 * C + x0] * (1 - tx) + f[y0 * C + x1] * tx, v1 = f[y1 * C + x0] * (1 - tx) + f[y1 * C + x1] * tx;
      const v = (v0 * (1 - ty) + v1 * ty + grain * (hash2(x, y, 77) - 0.5)) * 255;
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v < 0 ? 0 : v > 255 ? 255 : v; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** scatter tileable blobs (wraps across edges) */
function blobs(g: CanvasRenderingContext2D, size: number, count: number, seed: number, rMin: number, rMax: number, shade: (h: number) => string) {
  for (let i = 0; i < count; i++) {
    const x = hash2(i, 1, seed) * size, y = hash2(i, 2, seed) * size;
    const r = rMin + (rMax - rMin) * Math.pow(hash2(i, 3, seed), 2.2);
    g.fillStyle = shade(hash2(i, 4, seed));
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const cx = x + ox, cy = y + oy;
      if (cx < -r || cy < -r || cx > size + r || cy > size + r) continue;
      g.beginPath();
      g.ellipse(cx, cy, r, r * (0.6 + 0.4 * hash2(i, 5, seed)), hash2(i, 6, seed) * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }
}

export const PROC_TEX: Record<string, () => HTMLCanvasElement> = {
  gravel_road: () => canvas(512, (g, S) => {
    const P = 8;
    fieldImage(g, S, (x, y) => 0.5 + 0.07 * tileNoise((x / S) * P, (y / S) * P, P, 11));
    blobs(g, S, 2600, 21, 0.7, 2.6, (h) => (h < 0.5 ? `rgba(70,62,55,${0.25 + h * 0.4})` : `rgba(255,250,240,${0.15 + (h - 0.5) * 0.5})`));
    blobs(g, S, 140, 22, 2.5, 5.5, (h) => `rgba(${90 + h * 60},${85 + h * 50},${78 + h * 40},0.55)`);
  }),
  gravel_shoulder: () => canvas(512, (g, S) => {
    const P = 6;
    fieldImage(g, S, (x, y) => 0.48 + 0.1 * tileNoise((x / S) * P, (y / S) * P, P, 12));
    blobs(g, S, 1800, 23, 1, 3.4, (h) => (h < 0.55 ? `rgba(60,55,45,${0.3 + h * 0.4})` : `rgba(240,235,220,${0.12 + (h - 0.5) * 0.4})`));
    blobs(g, S, 120, 24, 3, 7, (h) => `rgba(${80 + h * 70},${78 + h * 60},${70 + h * 50},0.6)`);
  }),
  grass: () => canvas(512, (g, S) => {
    const P = 4;
    fieldImage(g, S, (x, y) => 0.5 + 0.16 * tileNoise((x / S) * P, (y / S) * P, P, 13));
    // gouache brush strokes
    for (let i = 0; i < 3800; i++) {
      const x = hash2(i, 7, 31) * S, y = hash2(i, 8, 31) * S;
      const len = 3 + hash2(i, 9, 31) * 9, a = -Math.PI / 2 + (hash2(i, 10, 31) - 0.5) * 0.9;
      const h = hash2(i, 11, 31);
      g.strokeStyle = h < 0.5 ? `rgba(40,45,30,${0.18 + h * 0.3})` : `rgba(255,250,215,${0.1 + (h - 0.5) * 0.35})`;
      g.lineWidth = 1 + hash2(i, 12, 31) * 1.6;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const cx = x + ox, cy = y + oy;
        if (cx < -12 || cy < -12 || cx > S + 12 || cy > S + 12) continue;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke();
      }
    }
  }),
  forest_floor: () => canvas(512, (g, S) => {
    const P = 5;
    fieldImage(g, S, (x, y) => 0.47 + 0.14 * tileNoise((x / S) * P, (y / S) * P, P, 14));
    blobs(g, S, 900, 25, 1.5, 4, (h) => (h < 0.5 ? `rgba(45,38,30,${0.25 + h * 0.4})` : `rgba(230,215,170,${0.1 + (h - 0.5) * 0.3})`));
  }),
  dirt_bank: () => canvas(512, (g, S) => {
    const P = 6;
    fieldImage(g, S, (x, y) => 0.5 + 0.12 * tileNoise((x / S) * P, (y / S) * P, P, 15) + 0.04 * Math.sin((y / S) * Math.PI * 2 * 24 + tileNoise((x / S) * P, (y / S) * P, P, 16) * 3));
    blobs(g, S, 600, 26, 1, 3, (h) => (h < 0.5 ? `rgba(50,40,30,${0.3 + h * 0.4})` : `rgba(245,230,200,${0.12 + (h - 0.5) * 0.3})`));
  }),
  rock: () => canvas(512, (g, S) => {
    const P = 4;
    fieldImage(g, S, (x, y) => {
      const n = tileNoise((x / S) * P, (y / S) * P, P, 17, 5);
      const cr = Math.abs(tileNoise((x / S) * P * 2, (y / S) * P * 2, P * 2, 18, 3));
      return 0.52 + 0.2 * n - (cr < 0.04 ? 0.18 : 0);
    });
  }),
  bark_pine: () => canvas(256, (g, S) => {
    fieldImage(g, S, (x, y) => 0.5 + 0.18 * tileNoise((x / S) * 8, (y / S) * 2, 2, 19) * (0.6 + 0.4 * Math.sin((x / S) * Math.PI * 2 * 9)));
  }),
};

/** livery number plate canvas: white plate, black number */
export function numberPlate(num: string, accent: string) {
  return canvas(256, (g, S) => {
    g.fillStyle = '#f4efe2'; g.fillRect(0, 0, S, S);
    g.fillStyle = accent; g.fillRect(0, 0, S, S * 0.16);
    g.fillStyle = '#1b1b1b';
    g.font = `900 ${S * 0.66}px "Helvetica Neue", "PingFang SC", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(num, S / 2, S * 0.6);
  });
}

/** text sign (distance boards, arch banners) */
export function signCanvas(text: string, w: number, h: number, bg: string, fg: string, font = '900') {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `${font} ${Math.floor(h * 0.62)}px "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h * 0.54);
  return c;
}
