// Ghost car: sampled poses (10 Hz) of a stage run, packed small enough to keep one per stage in localStorage.
// Poses rather than inputs: replaying inputs would need the exact same physics build, and the vehicle model is still
// being tuned — a pose trail stays valid. Size ≈ 16 bytes per sample → a 3:15 run ≈ 31 KB raw, ≈ 42 KB base64.
//
// Layout (little endian): u8 version, u8 hz, u32 count, f32 x0 y0 z0, then per sample
//   i16 dx dy dz (cm, relative to the previous *quantised* position — no drift), i16 qx qy qz qw (×32767), i16 ds (dm)
export interface GhostTrack { hz: number; n: number; pos: Float32Array; quat: Float32Array; s: Float32Array }
export interface GhostData { car: string; livery: number; total: number; date: number; data: string }

const VERSION = 1;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0));
    if (v.some((x) => x < 0)) throw new Error('bad base64');
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** records one sample every 1/hz s of stage time */
export class GhostRecorder {
  private pos: number[] = [];
  private quat: number[] = [];
  private s: number[] = [];
  private next = 0;
  constructor(readonly hz = 10) {}
  get count() { return this.s.length; }
  /** t: stage time (s, ≥ 0 once running) */
  push(t: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, s: number) {
    if (t < this.next) return;
    this.next = Math.floor(t * this.hz + 1e-6) / this.hz + 1 / this.hz;
    this.pos.push(x, y, z); this.quat.push(qx, qy, qz, qw); this.s.push(s);
  }
  encode(): string {
    const n = this.s.length;
    const buf = new ArrayBuffer(2 + 4 + 12 + n * 16);
    const dv = new DataView(buf);
    dv.setUint8(0, VERSION); dv.setUint8(1, this.hz); dv.setUint32(2, n, true);
    const x0 = this.pos[0] ?? 0, y0 = this.pos[1] ?? 0, z0 = this.pos[2] ?? 0;
    dv.setFloat32(6, x0, true); dv.setFloat32(10, y0, true); dv.setFloat32(14, z0, true);
    let qx = Math.round(Math.fround(x0) * 100), qy = Math.round(Math.fround(y0) * 100), qz = Math.round(Math.fround(z0) * 100), qs = 0;
    let o = 18;
    const i16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
    for (let i = 0; i < n; i++) {
      const cx = Math.round(this.pos[i * 3] * 100), cy = Math.round(this.pos[i * 3 + 1] * 100), cz = Math.round(this.pos[i * 3 + 2] * 100);
      const dx = i16(cx - qx), dy = i16(cy - qy), dz = i16(cz - qz);
      dv.setInt16(o, dx, true); dv.setInt16(o + 2, dy, true); dv.setInt16(o + 4, dz, true);
      qx += dx; qy += dy; qz += dz;
      for (let k = 0; k < 4; k++) dv.setInt16(o + 6 + k * 2, i16(this.quat[i * 4 + k] * 32767), true);
      const cs = Math.round(this.s[i] * 10), ds = i16(cs - qs);
      dv.setInt16(o + 14, ds, true); qs += ds;
      o += 16;
    }
    return toBase64(new Uint8Array(buf));
  }
}

export function decodeGhost(data: string): GhostTrack {
  const b = fromBase64(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint8(0) !== VERSION) throw new Error('ghost version');
  const hz = dv.getUint8(1), n = dv.getUint32(2, true);
  if (18 + n * 16 > b.length) throw new Error('ghost truncated');
  const pos = new Float32Array(n * 3), quat = new Float32Array(n * 4), s = new Float32Array(n);
  let qx = Math.round(dv.getFloat32(6, true) * 100), qy = Math.round(dv.getFloat32(10, true) * 100), qz = Math.round(dv.getFloat32(14, true) * 100), qs = 0;
  let o = 18;
  for (let i = 0; i < n; i++) {
    qx += dv.getInt16(o, true); qy += dv.getInt16(o + 2, true); qz += dv.getInt16(o + 4, true);
    pos[i * 3] = qx / 100; pos[i * 3 + 1] = qy / 100; pos[i * 3 + 2] = qz / 100;
    let l = 0;
    for (let k = 0; k < 4; k++) { const q = dv.getInt16(o + 6 + k * 2, true) / 32767; quat[i * 4 + k] = q; l += q * q; }
    l = Math.sqrt(l) || 1;
    for (let k = 0; k < 4; k++) quat[i * 4 + k] /= l;
    qs += dv.getInt16(o + 14, true); s[i] = qs / 10;
    o += 16;
  }
  return { hz, n, pos, quat, s };
}

/** pose at stage time t (Catmull-Rom position, normalised-lerp rotation); false when t is outside the track */
export function sampleGhost(g: GhostTrack, t: number, pos: number[], quat: number[]): boolean {
  if (g.n < 2 || t < 0) return false;
  const f = t * g.hz;
  if (f > g.n - 1) return false;
  const i = Math.min(g.n - 2, Math.floor(f)), u = f - i;
  const i0 = Math.max(0, i - 1), i2 = i + 1, i3 = Math.min(g.n - 1, i + 2);
  const u2 = u * u, u3 = u2 * u;
  for (let k = 0; k < 3; k++) {
    const p0 = g.pos[i0 * 3 + k], p1 = g.pos[i * 3 + k], p2 = g.pos[i2 * 3 + k], p3 = g.pos[i3 * 3 + k];
    pos[k] = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  }
  let dot = 0;
  for (let k = 0; k < 4; k++) dot += g.quat[i * 4 + k] * g.quat[i2 * 4 + k];
  const sg = dot < 0 ? -1 : 1;
  let l = 0;
  for (let k = 0; k < 4; k++) { quat[k] = g.quat[i * 4 + k] * (1 - u) + sg * g.quat[i2 * 4 + k] * u; l += quat[k] * quat[k]; }
  l = Math.sqrt(l) || 1;
  for (let k = 0; k < 4; k++) quat[k] /= l;
  return true;
}

/** ghost's stage time when it first reached distance s along the road (for split comparisons); NaN if never */
export function ghostTimeAt(g: GhostTrack, s: number): number {
  for (let i = 1; i < g.n; i++) {
    if (g.s[i] >= s) {
      const a = g.s[i - 1], b = g.s[i];
      return (i - 1 + (b > a ? (s - a) / (b - a) : 0)) / g.hz;
    }
  }
  return NaN;
}
