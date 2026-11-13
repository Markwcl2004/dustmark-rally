// Minimal mutable 3D vector / quaternion math for the sim (no three.js dependency).

export class V3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v: V3) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v: V3) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v: V3) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaled(v: V3, s: number) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  scale(s: number) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v: V3) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  len() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lenSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.len(); if (l > 1e-12) this.scale(1 / l); return this; }
  /** this = a × b */
  crossOf(a: V3, b: V3) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  subOf(a: V3, b: V3) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
}

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}
  set(x: number, y: number, z: number, w: number) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q: Quat) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l; return this;
  }
  setAxisAngle(ax: number, ay: number, az: number, a: number) {
    const s = Math.sin(a / 2);
    this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(a / 2); return this;
  }
  /** this = a * b */
  mulOf(a: Quat, b: Quat) {
    const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
    const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
    const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
    const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    this.x = x; this.y = y; this.z = z; this.w = w; return this;
  }
  /** integrate world angular velocity w over dt */
  integrate(w: V3, dt: number) {
    const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
    const x = this.x, y = this.y, z = this.z, q = this.w;
    this.x += hx * q + hy * z - hz * y;
    this.y += hy * q + hz * x - hx * z;
    this.z += hz * q + hx * y - hy * x;
    this.w += -hx * x - hy * y - hz * z;
    return this.normalize();
  }
  /** rotate body-frame vector v into world frame -> out */
  rotate(v: V3, out: V3) {
    const { x, y, z, w } = this;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    out.x = ix * w + iw * -x + iy * -z - iz * -y;
    out.y = iy * w + iw * -y + iz * -x - ix * -z;
    out.z = iz * w + iw * -z + ix * -y - iy * -x;
    return out;
  }
  /** rotate world vector into body frame -> out */
  unrotate(v: V3, out: V3) {
    const { x, y, z, w } = this;
    // conjugate rotation
    const cx = -x, cy = -y, cz = -z;
    const ix = w * v.x + cy * v.z - cz * v.y;
    const iy = w * v.y + cz * v.x - cx * v.z;
    const iz = w * v.z + cx * v.y - cy * v.x;
    const iw = -cx * v.x - cy * v.y - cz * v.z;
    out.x = ix * w + iw * -cx + iy * -cz - iz * -cy;
    out.y = iy * w + iw * -cy + iz * -cx - ix * -cz;
    out.z = iz * w + iw * -cz + ix * -cy - iy * -cx;
    return out;
  }
  /** rotation whose columns are the body axes x (right), y (up), z (back) expressed in world */
  setFromBasis(x: V3, y: V3, z: V3) {
    const m00 = x.x, m01 = y.x, m02 = z.x, m10 = x.y, m11 = y.y, m12 = z.y, m20 = x.z, m21 = y.z, m22 = z.z;
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      this.w = 0.25 / s; this.x = (m21 - m12) * s; this.y = (m02 - m20) * s; this.z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = 0.25 * s; this.y = (m01 + m10) / s; this.z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      this.w = (m02 - m20) / s; this.x = (m01 + m10) / s; this.y = 0.25 * s; this.z = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      this.w = (m10 - m01) / s; this.x = (m02 + m20) / s; this.y = (m12 + m21) / s; this.z = 0.25 * s;
    }
    return this.normalize();
  }
  /** yaw rotation about +Y such that body forward (-Z) points along heading (dx,dz) */
  setFromHeading(dx: number, dz: number) {
    // forward = -Z rotated by yaw a about Y: (-sin a, 0, -cos a)
    const a = Math.atan2(-dx, -dz);
    return this.setAxisAngle(0, 1, 0, a);
  }
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const moveTowards = (v: number, target: number, maxDelta: number) =>
  v < target ? Math.min(target, v + maxDelta) : Math.max(target, v - maxDelta);
