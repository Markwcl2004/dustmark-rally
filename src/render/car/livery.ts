// Livery canvas: base colour, per-pattern colour bands, panel lines, number panels, sponsor decals from the art
// atlas (public/assets/decals), driver-name strip, windscreen banner, wing/end-plate/mudflap decals.
// Everything is drawn in car-metre coordinates through the view mappings in layout.ts; text and decals are placed
// by centre + size so they are never mirrored, whichever flank they sit on.
import type { LiveryDef } from '../../data/carVisuals';
import { CANVAS_H, CANVAS_W, PAD, REG, type Rect } from './layout';
import { lampLayout } from './parts';
import type { Shape } from './shape';

export interface DecalAtlas { img: HTMLImageElement; rects: Record<string, [number, number, number, number]>; names: Record<string, string> }

let atlas: DecalAtlas | null = null;
let atlasP: Promise<DecalAtlas | null> | null = null;
/** start loading the sponsor decal atlas (idempotent). Cars built before it arrives repaint when it lands. */
export function loadDecals(): Promise<DecalAtlas | null> {
  if (atlasP) return atlasP;
  if (typeof document === 'undefined') return (atlasP = Promise.resolve(null));
  atlasP = (async () => {
    try {
      const j = await (await fetch('/assets/decals/atlas.json')).json();
      const img = new Image();
      img.src = '/assets/decals/atlas.png';
      await img.decode();
      const rects: DecalAtlas['rects'] = {};
      for (const [k, v] of Object.entries(j.rects as Record<string, { px: [number, number, number, number] }>)) rects[k] = v.px;
      const names: Record<string, string> = {};
      for (const s of j.sponsors as { id: string; name: string }[]) names[s.id] = s.name;
      atlas = { img, rects, names };
      return atlas;
    } catch (e) {
      console.warn('[car] decal atlas unavailable', e);
      return null;
    }
  })();
  return atlasP;
}
export const decalsReady = () => atlas;

type Kind = 'L' | 'R' | 'T' | 'F' | 'B';
interface View { kind: Kind; r: Rect; P(a: number, b: number): [number, number]; /** px per metre along canvas x / y */ kx: number; ky: number }

const FONT = '"Helvetica Neue", "Arial Narrow", Arial, sans-serif';
const FONT_CN = '"PingFang SC", "Hiragino Sans GB", "Heiti SC", sans-serif';

export function paintLivery(cv: HTMLCanvasElement, S: Shape, L: LiveryDef, A: DecalAtlas | null) {
  cv.width = CANVAS_W; cv.height = CANVAS_H;
  const g = cv.getContext('2d')!;
  const b = S.vis.body, pr = S.vis.parts;
  const Lz = S.zMax - S.zMin, W = 2 * S.xMax, Y = S.yMax;
  const inner = (r: Rect): Rect => [r[0] + PAD, r[1] + PAD, r[2] - 2 * PAD, r[3] - 2 * PAD];
  const mk = (kind: Kind, R: Rect): View => {
    const r = inner(R);
    const v: View = { kind, r, kx: 0, ky: 0, P: () => [0, 0] };
    if (kind === 'L') { v.P = (z, y) => [r[0] + ((z - S.zMin) / Lz) * r[2], r[1] + ((Y - y) / Y) * r[3]]; v.kx = r[2] / Lz; v.ky = r[3] / Y; }
    if (kind === 'R') { v.P = (z, y) => [r[0] + ((S.zMax - z) / Lz) * r[2], r[1] + ((Y - y) / Y) * r[3]]; v.kx = r[2] / Lz; v.ky = r[3] / Y; }
    if (kind === 'T') { v.P = (z, x) => [r[0] + ((S.zMax - z) / Lz) * r[2], r[1] + ((x + S.xMax) / W) * r[3]]; v.kx = r[2] / Lz; v.ky = r[3] / W; }
    if (kind === 'F') { v.P = (x, y) => [r[0] + ((S.xMax - x) / W) * r[2], r[1] + ((Y - y) / Y) * r[3]]; v.kx = r[2] / W; v.ky = r[3] / Y; }
    if (kind === 'B') { v.P = (x, y) => [r[0] + ((x + S.xMax) / W) * r[2], r[1] + ((Y - y) / Y) * r[3]]; v.kx = r[2] / W; v.ky = r[3] / Y; }
    return v;
  };
  const VL = mk('L', REG.L), VR = mk('R', REG.R), VT = mk('T', REG.T), VF = mk('F', REG.F), VB = mk('B', REG.B);
  const sides = [VL, VR];

  // ---- primitives (each clipped to its view so overshooting shapes never bleed into a neighbour) ----
  const clip = (v: View) => { g.save(); g.beginPath(); g.rect(v.r[0] - PAD, v.r[1] - PAD, v.r[2] + 2 * PAD, v.r[3] + 2 * PAD); g.clip(); };
  const poly = (v: View, pts: [number, number][], c: string) => {
    clip(v);
    g.fillStyle = c; g.beginPath();
    pts.forEach(([a, bb], i) => { const [x, y] = v.P(a, bb); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.closePath(); g.fill();
    g.restore();
  };
  const rect = (v: View, a0: number, b0: number, a1: number, b1: number, c: string) => poly(v, [[a0, b0], [a1, b0], [a1, b1], [a0, b1]], c);
  const line = (v: View, pts: [number, number][], c: string, wPx: number) => {
    clip(v);
    g.strokeStyle = c; g.lineWidth = wPx; g.lineJoin = 'round'; g.beginPath();
    pts.forEach(([a, bb], i) => { const [x, y] = v.P(a, bb); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    g.restore();
  };
  /** run fn in a local frame centred on car point (a,b) with 1 unit = 1 px vertically and the view's x stretch;
   *  rot: 0 = upright in the canvas, ±π/2 for the top view. Width/height arguments to fn are in px of that frame. */
  const frame = (v: View, a: number, bb: number, rot: number, fn: (k: number, ky: number) => void) => {
    const [x, y] = v.P(a, bb);
    clip(v);
    g.save(); g.translate(x, y);
    // top view: rotated text runs along canvas y, so the stretch factors swap
    const rotated = Math.abs(Math.sin(rot)) > 0.5;
    const kx = rotated ? v.ky : v.kx, ky = rotated ? v.kx : v.ky;
    g.rotate(rot);
    g.scale(kx / ky, 1);
    fn(kx, ky);
    g.restore();
    g.restore();
  };
  /** decal from the atlas, centred, width in metres (height from the decal's aspect unless given) */
  const decal = (v: View, id: string, a: number, bb: number, wM: number, rot = 0, hM?: number) => {
    const s = A?.rects[id];
    frame(v, a, bb, rot, (_kx, ky) => {
      const w = wM * ky, h = (hM ?? (s ? (wM * s[3]) / s[2] : wM * 0.24)) * ky;
      if (s && A) g.drawImage(A.img, s[0], s[1], s[2], s[3], -w / 2, -h / 2, w, h);
      else {
        // atlas not loaded: plain sponsor block with the id as text so the car still reads as sponsored
        g.fillStyle = '#f3ecdc'; g.fillRect(-w / 2, -h / 2, w, h);
        g.fillStyle = '#1c1c1c'; g.font = `800 ${h * 0.6}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(id.replace('_mark', '').toUpperCase(), 0, h * 0.04, w * 0.9);
      }
    });
  };
  const text = (v: View, s: string, a: number, bb: number, hM: number, c: string, opts: { rot?: number; weight?: number; font?: string; maxW?: number; italic?: boolean } = {}) => {
    frame(v, a, bb, opts.rot ?? 0, (_kx, ky) => {
      const h = hM * ky;
      g.fillStyle = c;
      g.font = `${opts.italic ? 'italic ' : ''}${opts.weight ?? 800} ${h}px ${opts.font ?? FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(s, 0, h * 0.05, opts.maxW ? opts.maxW * ky : undefined);
    });
  };
  const numberPanel = (v: View, a: number, bb: number, wM: number, hM: number, rot = 0) => {
    frame(v, a, bb, rot, (_kx, ky) => {
      const w = wM * ky, h = hM * ky, rr = h * 0.12;
      g.fillStyle = '#1c1c1c';
      round(g, -w / 2 - h * 0.03, -h / 2 - h * 0.03, w + h * 0.06, h * 1.06, rr * 1.2); g.fill();
      g.fillStyle = '#f6f1e6';
      round(g, -w / 2, -h / 2, w, h, rr); g.fill();
      // event strip
      g.fillStyle = L.c1;
      g.fillRect(-w / 2 + h * 0.06, -h / 2 + h * 0.06, w - h * 0.12, h * 0.2);
      g.fillStyle = '#f6f1e6'; g.font = `800 ${h * 0.15}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('DUSTMARK · 尘迹拉力', 0, -h / 2 + h * 0.165, w - h * 0.2);
      g.fillStyle = '#141414'; g.font = `800 ${h * 0.66}px ${FONT}`;
      g.fillText(String(L.number), 0, h * 0.16, w * 0.9);
    });
  };

  // ---- key positions ----
  const zN = S.zN, zT = S.zT, zF = S.zF, zR = S.zR, Rw = S.Rw;
  const sill = b.sill, waist = b.waist, belt = b.belt, top = b.roofH;
  const LL = lampLayout(S);
  const zD0 = zF + Rw + 0.05;
  const zD1 = b.doors === 4 ? S.zB - 0.02 : S.zB + 0.03;
  const zRD1 = zR - Rw - 0.05;
  const doorMid = (zD0 + zD1) / 2 + 0.05;
  const all = (fn: (v: View) => void) => [VL, VR, VT, VF, VB].forEach(fn);

  // ---- base ----
  g.fillStyle = L.base; g.fillRect(0, 0, CANVAS_W, CANVAS_H);
  // (side views also cover wing endplates etc. via explicit regions below)

  // ---- pattern ----
  const far = 4; // overshoot so polygons cover the body ends
  const along = (z: number) => (z - zN) / (zT - zN);
  // Rule: near the body ends the front/rear views repeat the flank's horizontal bands at the same heights, so the
  // projection blend on rounded corners (bumper ends, flares) meets the same colours and never smears.
  const sstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const bandPoly = (v: View, y0: (z: number) => number, h: number, zStart: number, c: string, cut = 0.12) => {
    const pts: [number, number][] = [[zStart - cut, y0(zStart) - 0.25]];
    for (let z = zStart; z <= zT + 0.6; z += 0.05) pts.push([z, y0(z)]);
    for (let z = zT + 0.6; z >= zStart; z -= 0.05) pts.push([z, y0(z) + h]);
    poly(v, pts, c);
  };
  switch (L.pattern) {
    case 'sweep': {
      // concept-poster sweep: low band along the flank that climbs over the rear quarter onto the tail panel
      const band = 0.15;
      const lift = Math.max(0, Math.min(LL.yTail - 0.1 - band, belt - 0.2) - (sill + 0.08));
      const lo = (z: number) => sill + 0.03 + 0.05 * along(z) + lift * sstep(zR - Rw - 0.6, zR + 0.15, z);
      const layers: [(z: number) => number, number, string, number][] = [
        [(z) => lo(z) - 0.07, 0.055, L.c2, zN], [lo, band, L.c1, zN + 0.12], [(z) => lo(z) + band + 0.025, 0.028, L.c3, zN + 0.22],
      ];
      for (const v of sides) for (const [f, h, c, z0] of layers) bandPoly(v, f, h, z0, c, 0.25);
      for (const [f, h, c] of layers) { rect(VB, -far, f(zT), far, f(zT) + h, c); rect(VF, -far, f(zN), far, f(zN) + h, c); }
      // twin pinstripes over the roof and hatch
      for (const sx of [-1, 1]) rect(VT, S.zRf + 0.05, sx * 0.1, zT - 0.03, sx * 0.16, L.c3);
      for (const sx of [-1, 1]) rect(VB, sx * 0.1, LL.yTt - 0.02, sx * 0.16, Y + 1, L.c3);
      break;
    }
    case 'chevron': {
      const mid = (sill + belt) / 2 - 0.02;
      const tipZ = zF + Rw + 0.15, backZ = zR + 0.1;
      for (const v of sides) {
        const ch = (dz: number): [number, number][] => [
          [tipZ + dz, mid], [tipZ + dz + 0.55, belt - 0.03], [zT + far, belt - 0.03], [zT + far, sill], [tipZ + dz + 0.55, sill],
        ];
        poly(v, ch(-0.09), L.c2);
        poly(v, ch(0), L.c1);
        // inner notch in base colour → reads as a chevron, not a wedge
        poly(v, [[backZ, mid], [backZ + 0.45, belt - 0.03], [zT + far, belt - 0.03], [zT + far, sill], [backZ + 0.45, sill]], L.base);
        poly(v, [[backZ + 0.12, mid], [backZ + 0.57, belt - 0.03], [zT + far, belt - 0.03], [zT + far, sill], [backZ + 0.57, sill]], L.c1);
      }
      // hood chevron (top view), roof block, tail in c1 like the flank ends
      const hz = (zN + S.zWs) / 2;
      poly(VT, [[zN - 0.1, -0.2], [hz, -far], [hz + 0.22, -far], [zN + 0.12, -0.2], [zN + 0.12, 0.2], [hz + 0.22, far], [hz, far], [zN - 0.1, 0.2]], L.c1);
      rect(VT, S.zRf + 0.15, -far, S.zRr - 0.05, far, L.c1);
      rect(VB, -far, sill, far, belt - 0.03, L.c1);
      rect(VB, -far, LL.yTt - 0.06, far, Y + 1, L.c1);
      rect(VF, -far, b.belly, far, b.belly + 0.08, L.c2);
      break;
    }
    case 'blocks': {
      const hi = waist + 0.06, lo = waist - 0.06;
      for (const v of sides) {
        const z1 = S.zB - 0.1, z2 = zR - Rw - 0.2;
        const edge: [number, number][] = [[zN - 0.1, hi], [z1, hi], [z1 + 0.12, lo], [z2, lo], [z2 + 0.25, belt - 0.02], [zT + far, belt - 0.02]];
        poly(v, [...edge.map(([z, y]): [number, number] => [z, y + 0.04]), [zT + far, -1], [zN - 0.1, -1]], L.c2);
        poly(v, [...edge, [zT + far, -1], [zN - 0.1, -1]], L.c1);
      }
      const hb = zN + Math.min(0.5, (S.zWs - zN) * 0.45);
      poly(VT, [[zN - 0.1, -far], [hb, -far], [hb, -0.3], [hb + 0.15, -0.15], [hb + 0.15, 0.15], [hb, 0.3], [hb, far], [zN - 0.1, far]], L.c1);
      rect(VT, S.zRf + 0.1, -far, S.zRr, far, L.c2);
      rect(VF, -far, hi, far, hi + 0.04, L.c2);
      rect(VF, -far, -1, far, hi, L.c1);
      rect(VB, -far, belt - 0.02, far, belt + 0.02, L.c2);
      rect(VB, -far, -1, far, belt - 0.02, L.c1);
      break;
    }
    case 'fade': {
      const kick = (z: number, base: number) => base + Math.max(0, z - S.zB) * 0.12;
      const bands: [number, number, string, number][] = [[sill + 0.02, 0.13, L.c1, 0.0], [sill + 0.18, 0.07, L.c1, 0.25], [sill + 0.28, 0.035, L.c2, 0.5]];
      for (const v of sides) for (const [y0, h, c, d] of bands) bandPoly(v, (z) => kick(z, y0), h, zN + d, c);
      for (const [y0, h, c] of bands) rect(VB, -far, kick(zT, y0), far, kick(zT, y0) + h, c);
      rect(VF, -far, sill + 0.02, far, sill + 0.15, L.c1);
      // hood bars
      for (const [k, c] of [[0, L.c1], [1, L.c1], [2, L.c2]] as const) {
        const z0 = zN - 0.1, z1 = zN + 0.45 - k * 0.12, x0 = 0.12 + k * 0.17;
        rect(VT, z0, -x0 - 0.12, z1, -x0, c); rect(VT, z0, x0, z1, x0 + 0.12, c);
      }
      break;
    }
    case 'twin': {
      for (const sx of [-1, 1]) {
        rect(VT, zN - far, sx * 0.05, zT + far, sx * 0.17, L.c1);
        rect(VF, sx * 0.05, -far, sx * 0.17, Y + 1, L.c1);
        rect(VB, sx * 0.05, LL.yTail + 0.08, sx * 0.17, Y + 1, L.c1);
      }
      for (const v of sides) {
        poly(v, [[zN - 0.1, sill - 0.1], [zT + far, sill - 0.1], [zT + far, waist - 0.05], [zN + 0.45, waist - 0.05], [zN + 0.2, sill + 0.06]], L.c2);
        poly(v, [[zN + 0.52, waist - 0.02], [zT + far, waist - 0.02], [zT + far, waist + 0.01], [zN + 0.55, waist + 0.01]], L.c1);
      }
      rect(VB, -far, -1, far, waist - 0.05, L.c2);
      rect(VB, -far, waist - 0.02, far, waist + 0.01, L.c1);
      rect(VF, -far, -1, far, sill + 0.06, L.c2);
      break;
    }
    case 'split': {
      const zs = S.zB;
      const zig = (dz: number): [number, number][] => [[zs - 0.35 + dz, -1], [zs - 0.35 + dz, sill], [zs - 0.05 + dz, waist], [zs - 0.2 + dz, waist + 0.08], [zs + 0.25 + dz, belt + 0.3]];
      for (const v of sides) {
        poly(v, [...zig(-0.08), [zT + far, belt + 0.3], [zT + far, -1]], L.c2);
        poly(v, [...zig(0), [zT + far, belt + 0.3], [zT + far, -1]], L.c1);
      }
      rect(VT, zs + 0.25, -far, zT + far, far, L.c1);
      rect(VT, zs + 0.17, -far, zs + 0.25, far, L.c2);
      rect(VB, -far, -1, far, Y + 1, L.c1);
      rect(VF, -far, b.belly, far, b.belly + 0.07, L.c2);
      break;
    }
  }

  // ---- panel lines (shut lines, handles, fuel cap) ----
  const shut = 'rgba(20,20,22,0.55)';
  for (const v of sides) {
    line(v, [[zD0, sill + 0.01], [zD0, belt - 0.01]], shut, 2.5);
    line(v, [[zD1, sill + 0.01], [zD1, belt - 0.01]], shut, 2.5);
    line(v, [[zD0, sill + 0.012], [b.doors === 4 ? zRD1 : zD1, sill + 0.012]], shut, 2.5);
    if (b.doors === 4) line(v, [[zRD1, sill + 0.01], [zRD1, belt - 0.01]], shut, 2.5);
    rect(v, zD1 - 0.16, belt - 0.075, zD1 - 0.06, belt - 0.05, 'rgba(25,25,25,0.7)');
    // front wing shut line from the arch to the door
    line(v, [[zF + Rw * 0.4, S.archY(0, Rw * 0.4) + 0.03], [zD0 - 0.05, b.shoulder - 0.01]], 'rgba(20,20,22,0.25)', 2);
  }
  {
    const fz = zR - Rw - 0.1;
    const [x, y] = VR.P(fz, belt - 0.1);
    g.fillStyle = 'rgba(30,30,30,0.6)'; g.beginPath(); g.arc(x, y, 0.045 * VR.ky, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#b9b5ac'; g.beginPath(); g.arc(x, y, 0.035 * VR.ky, 0, Math.PI * 2); g.fill();
  }
  // hood shut line + louvres, hatch line
  {
    const ring = S.ring(S.zWs);
    const hx = ring[6][0] - 0.04;
    line(VT, [[zN + 0.06, -hx + 0.08], [S.zWs - 0.05, -hx], [S.zWs - 0.05, hx], [zN + 0.06, hx - 0.08]], 'rgba(20,20,22,0.45)', 2.5);
    if (S.vis.drive === 'awd') for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) {
      const z = S.zWs - 0.22 - k * 0.045;
      rect(VT, z, sx * 0.18, z + 0.022, sx * 0.42, 'rgba(18,18,20,0.85)');
    }
    line(VB, [[-LL.tailW + 0.08, LL.yTt - 0.03], [LL.tailW - 0.08, LL.yTt - 0.03]], 'rgba(20,20,22,0.4)', 2.5);
  }

  // ---- front: intake / lower lip, rear: black panel between the lamps, plate ----
  if (pr.bumper.style === 'body') {
    const yb0 = b.belly + 0.05, yb1 = pr.bumper.topF - 0.11;
    poly(VF, [[-LL.fasciaW + 0.2, yb0], [LL.fasciaW - 0.2, yb0], [LL.fasciaW - 0.28, yb1], [-LL.fasciaW + 0.28, yb1]], '#17181a');
    for (const sx of [-1, 1]) poly(VF, [[sx * (LL.fasciaW - 0.05), yb0 + 0.02], [sx * (LL.fasciaW - 0.16), yb0 + 0.02], [sx * (LL.fasciaW - 0.16), yb1 - 0.02], [sx * (LL.fasciaW - 0.05), yb1 - 0.06]], '#17181a');
  }
  {
    const y0 = LL.yTail - 0.075, y1 = LL.yTail + 0.075;
    if (S.vis.parts.tail !== 'round') rect(VB, -(LL.xT - 0.14), y0, LL.xT - 0.14, y1, '#18191b');
    const py = pr.bumper.style === 'chrome' ? (pr.bumper.topR + LL.yTail) / 2 - 0.02 : LL.yTail - 0.02;
    frame(VB, 0, py, 0, (_kx, ky) => {
      const w = 0.36 * ky, h = 0.1 * ky;
      g.fillStyle = '#f4efe2'; round(g, -w / 2, -h / 2, w, h, h * 0.12); g.fill();
      g.strokeStyle = '#1c1c1c'; g.lineWidth = h * 0.06; round(g, -w / 2, -h / 2, w, h, h * 0.12); g.stroke();
      g.fillStyle = '#1c1c1c'; g.font = `800 ${h * 0.62}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`DM · ${String(L.number).padStart(2, '0')}`, 0, h * 0.04, w * 0.9);
    });
  }

  // ---- numbers and sponsors ----
  for (const v of sides) {
    const ny = (waist + belt) / 2 + 0.005;
    const ph = Math.min(0.3, belt - waist - 0.02);
    numberPanel(v, doorMid, ny, ph * 1.45, ph);
    decal(v, L.second, doorMid, sill + 0.075, Math.min(0.5, (zD1 - zD0) * 0.75));
    // small sponsor on the door's upper front corner (the front wing is all flare)
    decal(v, L.third, zD0 + 0.13, belt - 0.07, 0.2);
    // rear quarter marks
    const qz0 = b.doors === 4 ? zRD1 + 0.08 : zD1 + 0.1, qz1 = zR - Rw - 0.04;
    const n = Math.max(1, Math.min(L.marks.length, Math.floor((qz1 - qz0) / 0.14)));
    for (let i = 0; i < n; i++) decal(v, L.marks[i], qz0 + ((i + 0.5) * (qz1 - qz0)) / n, waist + 0.04, 0.11);
    decal(v, L.main, (zR + zT) / 2 + 0.02, sill + 0.08, Math.min(0.42, zT - zR - 0.05));
  }
  // hood: main sponsor readable from the front; roof: number readable from the chase camera
  {
    const hz = zN + (S.zWs - zN) * 0.45;
    const hw = S.ring(hz)[6][0];
    decal(VT, L.main, hz, 0, Math.min(1.0, hw * 1.5), -Math.PI / 2);
    const rz = (S.zRf + S.zRr) / 2 + 0.08;
    frame(VT, rz, 0, Math.PI / 2, (_kx, ky) => {
      const rl = Math.min(0.42, (S.zRr - S.zRf) * 0.7);
      const w = Math.min(0.62, rl * 1.5) * ky, h = rl * ky;
      g.fillStyle = '#f6f1e6'; round(g, -w / 2, -h / 2, w, h, h * 0.1); g.fill();
      g.fillStyle = '#141414'; g.font = `800 ${h * 0.82}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(L.number), 0, h * 0.06, w * 0.92);
    });
  }
  // front bumper + rear bumper sponsors
  decal(VF, L.second, 0, pr.bumper.style === 'body' ? pr.bumper.topF - 0.06 : (b.belly + pr.bumper.topF) / 2 + 0.02, 0.46);
  decal(VB, L.third, 0, pr.bumper.style === 'chrome' ? b.belly + 0.08 : (b.belly + pr.bumper.topR) / 2 + 0.03, 0.42);
  // rear corner marks
  for (const sx of [-1, 1]) decal(VB, L.marks[(sx + 1) / 2 % L.marks.length], sx * (LL.tailW - 0.16), (pr.bumper.topR + LL.yTail) / 2 - 0.01, 0.09);

  // ---- explicit-uv regions ----
  const fillR = (r: Rect, c: string) => { g.fillStyle = c; g.fillRect(r[0], r[1], r[2], r[3]); };
  const decalPx = (id: string, cx: number, cy: number, w: number) => {
    const s = A?.rects[id];
    const h = s ? (w * s[3]) / s[2] : w * 0.24;
    if (s && A) g.drawImage(A.img, s[0], s[1], s[2], s[3], cx - w / 2, cy - h / 2, w, h);
    else { g.fillStyle = '#f3ecdc'; g.fillRect(cx - w / 2, cy - h / 2, w, h); }
  };
  const textPx = (s: string, cx: number, cy: number, h: number, c: string, font = FONT, weight = 800, maxW?: number) => {
    g.fillStyle = c; g.font = `${weight} ${h}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, cx, cy, maxW);
  };
  // wing top: livery colour with the main sponsor
  fillR(REG.wingTop, L.c1 === L.base ? L.c2 : L.c1);
  decalPx(L.main, REG.wingTop[0] + REG.wingTop[2] / 2, REG.wingTop[1] + REG.wingTop[3] * 0.5, REG.wingTop[2] * 0.42);
  fillR(REG.wingLow, L.c2);
  decalPx(L.second, REG.wingLow[0] + REG.wingLow[2] / 2, REG.wingLow[1] + REG.wingLow[3] / 2, REG.wingLow[2] * 0.6);
  for (const r of [REG.plateL, REG.plateR]) {
    fillR(r, L.c1 === L.base ? L.c2 : L.c1);
    decalPx(L.marks[0], r[0] + r[2] * 0.3, r[1] + r[3] * 0.45, r[3] * 0.62);
    decalPx(L.third, r[0] + r[2] * 0.72, r[1] + r[3] * 0.45, r[2] * 0.42);
  }
  // driver names strip (rear glass top edge) and windscreen banner
  {
    const r = REG.nameStrip;
    fillR(r, '#151618');
    const flag = (x: number, a: string, c: string) => { g.fillStyle = a; g.fillRect(x, r[1] + r[3] * 0.25, r[3] * 0.4, r[3] * 0.5); g.fillStyle = c; g.fillRect(x + r[3] * 0.4, r[1] + r[3] * 0.25, r[3] * 0.4, r[3] * 0.5); };
    flag(r[0] + r[2] * 0.08, L.c1, L.c2);
    textPx(L.driver, r[0] + r[2] * 0.28, r[1] + r[3] * 0.52, r[3] * 0.62, '#f3ede0', FONT_CN, 700);
    flag(r[0] + r[2] * 0.56, L.c2, L.c3);
    textPx(L.codriver, r[0] + r[2] * 0.76, r[1] + r[3] * 0.52, r[3] * 0.62, '#f3ede0', FONT_CN, 700);
  }
  {
    const r = REG.sunStrip;
    fillR(r, L.c1 === L.base ? L.c2 : L.c1);
    textPx(`${A?.names[L.main] ?? L.main.toUpperCase()}  ·  DUSTMARK RALLY`, r[0] + r[2] / 2, r[1] + r[3] * 0.54, r[3] * 0.6, '#f6f1e6', FONT, 900, r[2] * 0.92);
  }
  // mudflaps: red with a white sponsor name
  for (const r of [REG.flap, REG.flapF]) {
    fillR(r, '#c63a2c');
    const nm = A?.names[L.third] ?? L.third.toUpperCase();
    g.save(); g.translate(r[0] + r[2] / 2, r[1] + r[3] * 0.32); g.scale(1, 1.5);
    textPx(nm, 0, 0, r[3] * 0.14, '#f6f1e6', FONT, 900, r[2] * 0.86);
    g.restore();
    decalPx(L.marks[1 % L.marks.length], r[0] + r[2] / 2, r[1] + r[3] * 0.66, r[2] * 0.36);
  }
}

function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
