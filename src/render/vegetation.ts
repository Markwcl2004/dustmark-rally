// Vegetation and natural scatter:
//  - trees: spruce (pine), scots pine, birch, young spruce — low-poly geometry, two LODs, instanced per chunk;
//    birch crowns are alpha-tested leaf cards using the art leaf texture (palette-tinted);
//  - far trees: one global InstancedMesh of camera-facing art billboards (one draw call), shown per chunk when the
//    chunk is beyond the geometry LOD range;
//  - rocks, boulders, stumps, fallen trees;
//  - ground cover (grass tufts, ferns, flowers, reeds, art bushes): crossed cards from one atlas, one draw per chunk,
//    swaying, shrinking out with distance.
// Chunks: road split every VEG_CHUNK m × two lateral bands (inner < BAND m from the road, outer), so near/mid/far
// switches stay local while draw calls stay low.
import * as THREE from 'three';
import { zoneDef } from '../data/envs';
import { hash2 } from '../sim/math/rng';
import { DS } from '../sim/stage/centerline';
import { TREE_TYPES, type Prop, type PropType } from '../sim/stage/scatter';
import type { Stage } from '../sim/stage/stage';
import { LOOK, posterVcol, posterize } from './look';
import { hasAsset, imageTexture, type Palette } from './materials';

const VEG_CHUNK = 150;
const BAND = 45;

type Geo = THREE.BufferGeometry;

function colorize(g: Geo, fn: (x: number, y: number, z: number) => THREE.Color) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const col = fn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** merge vertex-coloured parts; flat=true keeps faceted normals (rocks), else smooth per part */
function merge(geos: Geo[], flat = false): Geo {
  const parts = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (flat || !g.index) ng.computeVertexNormals();
    else { g.computeVertexNormals(); const n2 = g.toNonIndexed(); return n2; }
    return ng;
  });
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** jitter vertices deterministically (weld-aware: same position → same offset) */
function wobble(g: Geo, amt: number, seed: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = Math.round(x * 100) * 7 + Math.round(y * 100) * 13 + Math.round(z * 100) * 31;
    p.setXYZ(i, x + (hash2(k, 1, seed) - 0.5) * amt, y + (hash2(k, 2, seed) - 0.5) * amt * 0.5, z + (hash2(k, 3, seed) - 0.5) * amt);
  }
  return g;
}

/** cone with a star-shaped (jagged) rim, apex up, rim at y=0 — a spruce tier */
function starCone(r: number, h: number, seg: number, inner: number, seed: number, droop = 0.25, under = false) {
  const pos: number[] = [];
  const rim: [number, number, number][] = [];
  for (let i = 0; i < seg * 2; i++) {
    const a = (i / (seg * 2)) * Math.PI * 2 + hash2(i, 1, seed) * 0.15;
    const rr = (i % 2 ? r * inner : r) * (0.85 + hash2(i, 2, seed) * 0.3);
    rim.push([Math.cos(a) * rr, (i % 2 ? h * 0.12 : -droop * (0.6 + hash2(i, 3, seed) * 0.8)), Math.sin(a) * rr]);
  }
  const apex: [number, number, number] = [(hash2(9, 4, seed) - 0.5) * r * 0.15, h, (hash2(9, 5, seed) - 0.5) * r * 0.15];
  for (let i = 0; i < rim.length; i++) {
    const a = rim[i], b = rim[(i + 1) % rim.length];
    pos.push(...apex, ...b, ...a);
    // underside (shallow) so the lowest tier reads from below
    if (under) pos.push(0, h * 0.18, 0, ...a, ...b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const C = (h: string) => new THREE.Color(h);

export function pineGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const trunk = new THREE.CylinderGeometry(0.14, 0.32, 7, lod ? 3 : 5, 1, true);
  trunk.translate(0, 3.5, 0);
  parts.push(colorize(trunk, () => pal.trunk.clone().multiplyScalar(0.8)));
  const tiers = lod ? 3 : 5;
  const dark = pal.pineDark, light = pal.pine.clone().lerp(C('#a7b77e'), 0.12);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = (lod ? 3.0 - t * 1.9 : 3.1 - t * 2.3);
    const h = lod ? 5.6 - t * 1.4 : 4.0 - t * 1.3;
    const y = lod ? 2.0 + i * 3.4 : 1.9 + i * 2.35;
    const cone = starCone(r, h, lod ? 5 : 8, 0.55, 40 + i, lod ? 0.3 : 0.45, i === 0 && !lod);
    cone.translate(0, y, 0);
    parts.push(colorize(cone, (_x, yy, _z) => {
      const k = Math.min(1, Math.max(0, (yy - y + 0.4) / (h + 0.4)));
      return dark.clone().lerp(light, 0.1 + k * 0.75);
    }));
  }
  return merge(parts, true);
}

export function spruceGeometry(pal: Palette): Geo {
  const parts: Geo[] = [];
  const trunk = new THREE.CylinderGeometry(0.08, 0.14, 1.4, 3, 1, true);
  trunk.translate(0, 0.7, 0);
  parts.push(colorize(trunk, () => pal.trunk));
  const dark = pal.pine.clone().multiplyScalar(0.85), light = pal.pine.clone().lerp(C('#b9c27a'), 0.28);
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    const r = 2.0 - t * 1.3, h = 2.8 - t * 0.7, y = 0.5 + i * 1.6;
    const cone = starCone(r, h, 6, 0.6, 60 + i, 0.3);
    cone.translate(0, y, 0);
    parts.push(colorize(cone, (_x, yy) => dark.clone().lerp(light, Math.min(1, Math.max(0, (yy - y + 0.3) / h)))));
  }
  return merge(parts, true);
}

export function scotsGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const trunk = new THREE.CylinderGeometry(0.13, 0.27, 13.5, lod ? 3 : 5, lod ? 1 : 2, true);
  if (!lod) wobble(trunk, 0.12, 5);
  trunk.translate(0, 6.75, 0);
  const bark = C('#9a5135'), barkTop = C('#c97a4a');
  parts.push(colorize(trunk, (_x, y) => bark.clone().lerp(barkTop, Math.min(1, y / 13))));
  if (!lod) {
    for (const [a, y, l] of [[0.4, 8.5, 2.2], [2.6, 9.6, 1.8]]) {
      const br = new THREE.CylinderGeometry(0.04, 0.08, l, 3, 1, true);
      br.translate(0, l / 2, 0); br.rotateZ(-1.1); br.rotateY(a); br.translate(0, y, 0);
      parts.push(colorize(br, () => bark));
    }
  }
  const blobs = lod ? [[0, 13.2, 0, 2.6], [1.2, 11.4, 0.6, 1.8]] : [[0, 13.6, 0, 2.4], [1.7, 12.3, 0.7, 1.8], [-1.5, 12.0, -0.5, 1.9], [0.5, 10.9, -1.6, 1.5]];
  const dk = pal.pineDark.clone().lerp(pal.pine, 0.25), lt = pal.pine.clone().lerp(C('#9db07a'), 0.22);
  blobs.forEach(([x, y, z, r], i) => {
    const b = new THREE.IcosahedronGeometry(r, 0);
    if (!lod) wobble(b, 0.55, 80 + i);
    b.scale(1.25, 0.62, 1.25);
    b.translate(x, y, z);
    parts.push(colorize(b, (_x, yy) => dk.clone().lerp(lt, Math.min(1, Math.max(0, (yy - y + r * 0.6) / (r * 1.1))))));
  });
  return merge(parts, true);
}

export function birchTrunkGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const segs = lod ? 1 : 6;
  const trunk = new THREE.CylinderGeometry(0.1, 0.19, 10, lod ? 3 : 5, segs, true);
  if (!lod) wobble(trunk, 0.06, 9);
  trunk.translate(0, 5, 0);
  const dark = C('#2a2622'), bark = pal.birchBark;
  parts.push(colorize(trunk, (x, y, z) => {
    if (lod) return bark;
    const k = Math.round(y * 1.0);
    const mark = hash2(k, Math.round(Math.atan2(z, x) * 2), 3) > 0.72 || y < 0.9;
    return mark ? dark.clone().lerp(bark, y < 0.9 ? 0.25 : 0.1) : bark;
  }));
  if (!lod) {
    for (const [a, y, l] of [[0.3, 6.5, 1.8], [2.4, 7.6, 1.5], [4.3, 5.8, 1.6]]) {
      const br = new THREE.CylinderGeometry(0.025, 0.06, l, 3, 1, true);
      br.translate(0, l / 2, 0); br.rotateZ(-0.8); br.rotateY(a); br.translate(0, y, 0);
      parts.push(colorize(br, () => bark.clone().multiplyScalar(0.8)));
    }
  }
  return merge(parts, false);
}

/** birch crown: alpha-tested leaf cards around the crown centre, normals pointing out of the crown (volume shading) */
export function birchLeafGeometry(lod: 0 | 1): Geo {
  const cards = lod ? 4 : 10;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const cy = 8.1;
  for (let i = 0; i < cards; i++) {
    const a = (i / cards) * Math.PI * 2 * 1.618 + hash2(i, 1, 7);
    const el = (hash2(i, 2, 7) - 0.4) * 1.2;
    const rr = lod ? 0.4 : 0.9 + hash2(i, 3, 7) * 0.9;
    const c = new THREE.Vector3(Math.cos(a) * rr * Math.cos(el), cy + Math.sin(el) * 1.9 + (lod ? 0 : 0.3), Math.sin(a) * rr * Math.cos(el));
    const size = lod ? 4.4 : 2.4 + hash2(i, 4, 7) * 1.0;
    const yaw = hash2(i, 5, 7) * Math.PI, tilt = (hash2(i, 6, 7) - 0.5) * 0.7;
    const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(right, tilt);
    const b = pos.length / 3;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const p = c.clone().addScaledVector(right, (u - 0.5) * size).addScaledVector(up, (v - 0.5) * size * 1.15);
      pos.push(p.x, p.y, p.z);
      const n = p.clone().sub(new THREE.Vector3(0, cy, 0)).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.25).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(u, v);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function rockGeometry(pal: Palette, variant: number, mossy = false): Geo {
  const g = new THREE.DodecahedronGeometry(1, variant === 2 ? 1 : 0);
  wobble(g, variant === 2 ? 0.35 : 0.45, 90 + variant);
  g.scale(1.25, variant === 1 ? 0.9 : 0.7, 1);
  g.translate(0, 0.18, 0);
  const lo = pal.rock.clone().multiplyScalar(0.7), hi = pal.rock.clone().lerp(C('#f3ead7'), 0.22), moss = pal.bush.clone().lerp(pal.grassDry, 0.3);
  return merge([colorize(g, (_x, y) => {
    const c = lo.clone().lerp(hi, Math.min(1, Math.max(0, (y + 0.4) / 1.3)));
    return mossy && y > 0.45 ? c.lerp(moss, 0.7) : c;
  })], true);
}

export function stumpGeometry(pal: Palette): Geo {
  const s = new THREE.CylinderGeometry(0.28, 0.36, 0.5, 7, 1);
  s.translate(0, 0.25, 0);
  const wood = C('#e3c48f'), bark = pal.trunk;
  return merge([colorize(s, (_x, y) => (y > 0.49 ? wood : bark))], true);
}

export function deadwoodGeometry(pal: Palette): Geo {
  const parts: Geo[] = [];
  const log = new THREE.CylinderGeometry(0.2, 0.26, 5, 6, 1);
  log.rotateZ(Math.PI / 2); log.translate(0, 0.22, 0);
  const grey = C('#9a8f80'), end = C('#d6bd8e');
  parts.push(colorize(log, (x) => (Math.abs(x) > 2.45 ? end : grey)));
  const root = new THREE.CylinderGeometry(0.75, 0.75, 0.25, 7, 1);
  wobble(root, 0.3, 3);
  root.rotateZ(Math.PI / 2); root.translate(-2.55, 0.45, 0);
  parts.push(colorize(root, () => pal.dirt.clone().lerp(grey, 0.3)));
  return merge(parts, true);
}

/** paint snow on every upward-facing triangle (snow-laden branches) — patchy */
function snowCap(g: Geo, snow: THREE.Color, minY = 0.42, seed = 1) {
  const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, c = g.attributes.color as THREE.BufferAttribute;
  for (let t = 0; t < p.count; t += 3) {
    const ny = (n.getY(t) + n.getY(t + 1) + n.getY(t + 2)) / 3;
    const k = hash2(t, 3, seed);
    if (ny > minY + (k - 0.5) * 0.2 && k > 0.12) for (let i = t; i < t + 3; i++) c.setXYZ(i, snow.r * (0.93 + k * 0.07), snow.g * (0.93 + k * 0.07), snow.b);
  }
  return g;
}

/** flat-topped acacia: forked leaning trunk, layered umbrella canopy */
export function acaciaGeometry(pal: Palette, lod: 0 | 1, small = false): Geo {
  const parts: Geo[] = [];
  const bark = pal.trunk, H = small ? 3.2 : 5.6;
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, H * 0.55, lod ? 4 : 6, 1, true);
  trunk.translate(0, H * 0.27, 0); trunk.rotateZ(0.08);
  parts.push(colorize(trunk, () => bark));
  const forks = lod ? [[0.5, 0.0], [-0.55, 2.4]] : [[0.55, 0.0], [-0.6, 2.2], [0.35, 4.1]];
  for (const [lean, yaw] of forks) {
    const b = new THREE.CylinderGeometry(0.08, 0.16, H * 0.6, lod ? 3 : 5, 1, true);
    b.translate(0, H * 0.3, 0); b.rotateZ(lean); b.rotateY(yaw); b.translate(0, H * 0.48, 0);
    parts.push(colorize(b, () => bark));
  }
  const dk = pal.pineDark.clone().lerp(pal.pine, 0.35), lt = pal.pine.clone().lerp(C('#c9c26a'), 0.25);
  const blobs = lod ? [[0, H + 0.6, 0, 3.6]] : [[0, H + 0.7, 0, 3.0], [2.2, H + 0.3, 0.8, 2.2], [-2.0, H + 0.45, -0.6, 2.4], [0.6, H + 0.2, -2.1, 2.0], [-0.8, H + 0.35, 2.0, 2.0]];
  blobs.forEach(([x, y, z, r], i) => {
    const b = new THREE.IcosahedronGeometry(r, 0);
    if (!lod) wobble(b, 0.5, 120 + i);
    b.scale(1.35, small ? 0.32 : 0.26, 1.35);
    b.translate(x, y, z);
    parts.push(colorize(b, (_x, yy) => dk.clone().lerp(lt, Math.min(1, Math.max(0, (yy - y + r * 0.3) / (r * 0.6))))));
  });
  const g = merge(parts, true);
  if (small) g.scale(0.75, 0.8, 0.75);
  return g;
}

/** snow-laden spruce: the north spruce with snow on every upward face */
export function snowPineGeometry(pal: Palette, lod: 0 | 1): Geo {
  return snowCap(pineGeometry(pal, lod), C('#f4f4fa'), 0.4, 3);
}
export function snowSpruceGeometry(pal: Palette): Geo {
  return snowCap(spruceGeometry(pal), C('#f4f4fa'), 0.4, 5);
}

/** leafless tree: trunk and a few forking branches */
export function bareGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const bark = pal.trunk.clone().lerp(C('#6a625e'), 0.4);
  const trunk = new THREE.CylinderGeometry(0.1, 0.22, 7, lod ? 3 : 5, 1, true);
  trunk.translate(0, 3.5, 0);
  parts.push(colorize(trunk, () => bark));
  const n = lod ? 4 : 8;
  for (let i = 0; i < n; i++) {
    const l = 2.2 + hash2(i, 1, 9) * 2.0, y = 3.0 + (i / n) * 3.6;
    const b = new THREE.CylinderGeometry(0.025, 0.07, l, 3, 1, true);
    b.translate(0, l / 2, 0); b.rotateZ(-0.55 - hash2(i, 2, 9) * 0.5); b.rotateY(i * 2.4); b.translate(0, y, 0);
    parts.push(colorize(b, () => bark));
  }
  return merge(parts, true);
}

/** Mediterranean cypress: a tall dark flame */
export function cypressGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const trunk = new THREE.CylinderGeometry(0.1, 0.16, 1.2, 4, 1, true);
  trunk.translate(0, 0.6, 0);
  parts.push(colorize(trunk, () => pal.trunk));
  const dk = pal.pineDark, lt = pal.pine.clone().lerp(C('#8fa05a'), 0.25);
  const b = new THREE.IcosahedronGeometry(1, lod ? 0 : 1);
  if (!lod) wobble(b, 0.18, 33);
  b.scale(1.05, 5.2, 1.05);
  b.translate(0, 5.4, 0);
  parts.push(colorize(b, (x, y) => dk.clone().lerp(lt, Math.min(1, Math.max(0, 0.15 + x * 0.25 + (y - 3) / 14)))));
  return merge(parts, true);
}

/** olive: short gnarled grey trunk, several silvery-green clumps */
export function oliveGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const bark = C('#7a6e62');
  for (const [lean, yaw] of lod ? [[0.25, 0]] : [[0.3, 0], [-0.35, 2.1], [0.2, 4.0]]) {
    const t = new THREE.CylinderGeometry(0.1, 0.24, 2.6, lod ? 4 : 5, 1, true);
    if (!lod) wobble(t, 0.15, 7);
    t.translate(0, 1.3, 0); t.rotateZ(lean); t.rotateY(yaw);
    parts.push(colorize(t, () => bark));
  }
  const dk = pal.birchLeaf.clone().lerp(pal.pineDark, 0.45), lt = pal.birchLeaf.clone().lerp(C('#dcdcb8'), 0.25);
  const blobs = lod ? [[0, 3.0, 0, 2.1]] : [[0, 3.3, 0, 1.6], [1.3, 2.8, 0.4, 1.2], [-1.2, 2.9, -0.4, 1.3], [0.3, 2.6, -1.3, 1.1], [-0.3, 2.7, 1.3, 1.1]];
  blobs.forEach(([x, y, z, r], i) => {
    const b = new THREE.IcosahedronGeometry(r, 0);
    if (!lod) wobble(b, 0.45, 150 + i);
    b.scale(1.2, 0.75, 1.2); b.translate(x, y, z);
    parts.push(colorize(b, (_x, yy) => dk.clone().lerp(lt, Math.min(1, Math.max(0, (yy - y + r * 0.5) / r)))));
  });
  return merge(parts, true);
}

/** umbrella (stone) pine: tall bare reddish trunk, wide flat dark canopy */
export function umbrellaGeometry(pal: Palette, lod: 0 | 1): Geo {
  const parts: Geo[] = [];
  const trunk = new THREE.CylinderGeometry(0.15, 0.3, 9, lod ? 4 : 6, 1, true);
  if (!lod) wobble(trunk, 0.12, 21);
  trunk.translate(0, 4.5, 0); trunk.rotateZ(0.06);
  parts.push(colorize(trunk, (_x, y) => C('#8a4a32').lerp(C('#b0683e'), Math.min(1, y / 9))));
  const dk = pal.pineDark.clone().lerp(pal.pine, 0.3), lt = pal.pine.clone().lerp(C('#9fb070'), 0.2);
  const blobs = lod ? [[0, 9.6, 0, 4.0]] : [[0, 9.8, 0, 3.4], [2.6, 9.3, 0.9, 2.4], [-2.5, 9.5, -0.6, 2.6], [0.4, 9.2, -2.6, 2.2], [-0.6, 9.4, 2.5, 2.3]];
  blobs.forEach(([x, y, z, r], i) => {
    const b = new THREE.IcosahedronGeometry(r, 0);
    if (!lod) wobble(b, 0.5, 170 + i);
    b.scale(1.3, 0.42, 1.3); b.translate(x, y, z);
    parts.push(colorize(b, (_x, yy) => dk.clone().lerp(lt, Math.min(1, Math.max(0, (yy - y + r * 0.3) / (r * 0.7))))));
  });
  return merge(parts, true);
}

// ---------------------------------------------------------------------------------------------------------------------
// ground cover atlas (4×2 cells): 0 grass, 1 dry grass, 2 fern, 3 flowers, 4 reeds, 5 bush (art), 6 bush 2 (art), 7 heather

const ATLAS_W = 4, ATLAS_H = 2, CELL = 256;

/** art cut-outs that replace painted cover cells, per art set (cell → file) */
const COVER_ART: Record<string, Record<number, string>> = {
  nordic: { 5: 'bush.png', 6: 'bush_2.png' },
  savanna: { 0: 'grass_tuft.png', 1: 'grass_tuft_2.png', 5: 'dry_bush.png', 6: 'dry_bush_2.png' },
  snow: { 2: 'snow_bush.png', 5: 'snow_bush.png', 6: 'snow_bush_2.png' },
  coast: { 2: 'agave.png', 3: 'flower_bush.png', 5: 'bush.png', 6: 'bush_2.png' },
};

function paintCover(pal: Palette, art: string, onArt: () => void) {
  const c = document.createElement('canvas');
  c.width = ATLAS_W * CELL; c.height = ATLAS_H * CELL;
  const g = c.getContext('2d')!;
  const hex = (col: THREE.Color, k = 1) => '#' + col.clone().multiplyScalar(k).getHexString();
  const cell = (i: number) => [(i % ATLAS_W) * CELL, Math.floor(i / ATLAS_W) * CELL] as const;
  const blade = (x0: number, y0: number, len: number, ang: number, w: number, col: string) => {
    g.fillStyle = col;
    g.beginPath();
    const tx = x0 + Math.sin(ang) * len, ty = y0 - Math.cos(ang) * len;
    g.moveTo(x0 - w, y0); g.quadraticCurveTo(x0 + Math.sin(ang) * len * 0.4, y0 - len * 0.55, tx, ty); g.quadraticCurveTo(x0 + Math.sin(ang) * len * 0.5, y0 - len * 0.5, x0 + w, y0);
    g.fill();
  };
  const tuft = (i: number, base: THREE.Color, n: number, seed: number) => {
    const [ox, oy] = cell(i);
    for (let k = 0; k < n; k++) {
      const h = hash2(k, 1, seed), x = ox + 40 + hash2(k, 2, seed) * (CELL - 80);
      const shade = 0.62 + hash2(k, 3, seed) * 0.6;
      blade(x, oy + CELL - 6, 90 + h * 140, (hash2(k, 4, seed) - 0.5) * 1.1, 4 + h * 5, hex(base, shade));
    }
  };
  tuft(0, pal.grass.clone().lerp(pal.grassDry, 0.35), 46, 1);
  tuft(1, pal.grassDry.clone().lerp(C('#e6d58e'), 0.25), 40, 2);
  // fern: fronds of small leaflets
  {
    const [ox, oy] = cell(2);
    const col = pal.bush.clone().lerp(pal.pine, 0.2);
    for (let f = 0; f < 7; f++) {
      const ang = -1.25 + f * 0.42 + (hash2(f, 1, 5) - 0.5) * 0.2, len = 150 + hash2(f, 2, 5) * 70;
      const x0 = ox + CELL / 2, y0 = oy + CELL - 8;
      g.strokeStyle = hex(col, 0.7); g.lineWidth = 3;
      g.beginPath(); g.moveTo(x0, y0);
      const tip = [x0 + Math.sin(ang) * len, y0 - Math.cos(ang) * len * 0.8];
      g.quadraticCurveTo(x0 + Math.sin(ang) * len * 0.3, y0 - len * 0.7, tip[0], tip[1]); g.stroke();
      for (let k = 1; k < 14; k++) {
        const t = k / 14;
        const px = x0 + (tip[0] - x0) * t + Math.sin(ang) * 0, py = y0 + (tip[1] - y0) * t - Math.sin(Math.PI * t) * 30;
        const l = (1 - t) * 26 + 6;
        g.fillStyle = hex(col, 0.75 + hash2(k, f, 9) * 0.5);
        for (const sgn of [-1, 1]) {
          g.beginPath(); g.ellipse(px + Math.cos(ang) * sgn * l * 0.6, py + Math.sin(ang) * sgn * l * 0.6 - 4, l * 0.6, 5, ang + sgn * 0.5, 0, Math.PI * 2); g.fill();
        }
      }
    }
  }
  // flowers: grass + dots
  {
    tuft(3, pal.grass.clone().lerp(pal.grassDry, 0.5), 28, 3);
    const [ox, oy] = cell(3);
    const cols = ['#f4efe2', '#f2c230', '#d8573c', '#f4efe2', '#9db3e0'];
    for (let k = 0; k < 26; k++) {
      const x = ox + 40 + hash2(k, 1, 4) * (CELL - 80), y = oy + 70 + hash2(k, 2, 4) * 140;
      g.strokeStyle = hex(pal.grass, 0.8); g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (hash2(k, 5, 4) - 0.5) * 10, oy + CELL - 6); g.stroke();
      g.fillStyle = cols[k % cols.length]; g.beginPath(); g.arc(x, y, 6 + hash2(k, 3, 4) * 5, 0, Math.PI * 2); g.fill();
    }
  }
  // reeds: tall straight blades + brown heads
  {
    const [ox, oy] = cell(4);
    for (let k = 0; k < 30; k++) {
      const x = ox + 30 + hash2(k, 1, 6) * (CELL - 60), len = 160 + hash2(k, 2, 6) * 85, ang = (hash2(k, 3, 6) - 0.5) * 0.35;
      blade(x, oy + CELL - 4, len, ang, 3, hex(pal.grassDry.clone().lerp(pal.grass, 0.4), 0.7 + hash2(k, 4, 6) * 0.5));
      if (k % 4 === 0) { g.fillStyle = '#6b4a2e'; g.beginPath(); g.ellipse(x + Math.sin(ang) * len * 0.9, oy + CELL - 4 - len * 0.9, 5, 18, ang, 0, Math.PI * 2); g.fill(); }
    }
  }
  // heather / low shrub
  {
    const [ox, oy] = cell(7);
    for (let k = 0; k < 60; k++) {
      const x = ox + 30 + hash2(k, 1, 8) * (CELL - 60), y = oy + 120 + hash2(k, 2, 8) * 120;
      g.fillStyle = k % 3 ? hex(pal.bush, 0.6 + hash2(k, 3, 8) * 0.5) : art === 'nordic' ? '#8a5a7a' : hex(pal.heath, 0.9);
      g.beginPath(); g.ellipse(x, y, 18, 12, 0, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // art bushes into cells 5, 6
  const map = COVER_ART[art] ?? COVER_ART.nordic;
  for (const i of [5, 6]) if (!map[i] || !hasAsset(`/assets/tex/${art}/${map[i]}`)) tuft(i, pal.bush, 60, 10 + i);
  for (const [ci, f] of Object.entries(map)) {
    const i = Number(ci);
    const url = `/assets/tex/${art}/${f}`;
    if (!hasAsset(url)) continue;
    imageTexture(url, true, (t) => {
      const img = t.image as HTMLImageElement;
      const [ox, oy] = cell(i);
      g.clearRect(ox, oy, CELL, CELL);
      const s = Math.min((CELL - 8) / img.width, (CELL - 8) / img.height);
      const w = img.width * s, h = img.height * s;
      g.drawImage(img, ox + (CELL - w) / 2, oy + CELL - 4 - h, w, h);
      tex.needsUpdate = true;
      onArt();
    });
  }
  return tex;
}

// ---------------------------------------------------------------------------------------------------------------------

interface ChunkBuild {
  center: THREE.Vector3; radius: number;
  near: THREE.Object3D[]; mid: THREE.Object3D[]; cover: THREE.Object3D[];
  state: number; index: number;
  batch: THREE.BatchedMesh | null;
  /** per instance: lod0 / lod1 geometry id (-1 = hidden at mid range) */
  lodIds: { inst: number; g0: number; g1: number }[];
}

function setChunkLod(ch: ChunkBuild, st: number) {
  for (const m of ch.near) m.visible = st === 0;
  for (const m of ch.mid) m.visible = st === 1;
  if (!ch.batch) return;
  ch.batch.visible = st <= 1;
  if (st > 1) return;
  for (const it of ch.lodIds) {
    if (st === 0) { ch.batch.setGeometryIdAt(it.inst, it.g0); ch.batch.setVisibleAt(it.inst, true); }
    else if (it.g1 < 0) ch.batch.setVisibleAt(it.inst, false);
    else ch.batch.setGeometryIdAt(it.inst, it.g1);
  }
}

export interface VegBuild {
  group: THREE.Group;
  chunks: ChunkBuild[];
  counts: Record<string, number>;
  billboards: THREE.Mesh | null;
  /** per-frame: chunk LOD + billboard visibility */
  update(camPos: THREE.Vector3, time: number): void;
  /** make everything visible (shader warm-up) */
  showAll(): void;
}

const TREE: PropType[] = [...TREE_TYPES];

export function buildVegetation(stage: Stage, pal: Palette, lod: { near: number; mid: number; cover: number }): VegBuild {
  const cl = stage.cl;
  const nS = Math.ceil(cl.length / VEG_CHUNK);
  const chunkKey = (p: { x: number; z: number; d: number }) => {
    const s = stage.corridor.sAt(p.x, p.z);
    const si = Math.min(nS - 1, Math.max(0, Math.floor(Math.max(0, s) / VEG_CHUNK)));
    return si * 2 + (p.d < BAND ? 0 : 1);
  };
  const nChunks = nS * 2;
  const vcol = posterVcol('veg', { alphaToCoverage: true }, { lodFade: true });
  LOOK.uLodFade.value.set(lod.mid - 30, lod.mid);
  const art = stage.env.art;
  const leafTex = imageTexture(hasAsset('/assets/tex/nordic/birch_leaves.png') ? '/assets/tex/nordic/birch_leaves.png' : '/assets/tex/nordic/birch_leaves_2.png');
  const leafMat = posterize(new THREE.MeshLambertMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: false, alphaToCoverage: true }), {
    key: 'leaf', wrap: true, lodFade: true,
    uniforms: { uLeafA: { value: pal.birchLeaf.clone().lerp(pal.pine, 0.55) }, uLeafB: { value: pal.birchLeaf.clone().lerp(C('#e8e39a'), 0.25) } },
    edit: (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uLeafA, uLeafB;')
        .replace('#include <map_fragment>', `vec4 tx = texture2D(map, vMapUv);
float ll = dot(tx.rgb, vec3(0.299, 0.587, 0.114));
diffuseColor.rgb *= mix(uLeafA, uLeafB, smoothstep(0.35, 0.75, ll));
diffuseColor.a *= tx.a;`);
    },
  });
  // geometry per kind, built only for kinds this stage uses
  const used0 = new Set(stage.props.map((p) => p.type));
  const G = (k: string, f: () => [Geo, Geo]) => (used0.has(k as PropType) ? f() : undefined);
  const geos: Partial<Record<string, [Geo, Geo]>> = {
    pine: G('pine', () => [pineGeometry(pal, 0), pineGeometry(pal, 1)]),
    scots: G('scots', () => [scotsGeometry(pal, 0), scotsGeometry(pal, 1)]),
    birch: G('birch', () => [birchTrunkGeometry(pal, 0), birchTrunkGeometry(pal, 1)]),
    spruce: G('spruce', () => { const g = spruceGeometry(pal); return [g, g]; }),
    acacia: G('acacia', () => [acaciaGeometry(pal, 0), acaciaGeometry(pal, 1)]),
    thorn: G('thorn', () => [acaciaGeometry(pal, 0, true), acaciaGeometry(pal, 1, true)]),
    snowpine: G('snowpine', () => [snowPineGeometry(pal, 0), snowPineGeometry(pal, 1)]),
    snowspruce: G('snowspruce', () => { const g = snowSpruceGeometry(pal); return [g, g]; }),
    bare: G('bare', () => [bareGeometry(pal, 0), bareGeometry(pal, 1)]),
    cypress: G('cypress', () => [cypressGeometry(pal, 0), cypressGeometry(pal, 1)]),
    olive: G('olive', () => [oliveGeometry(pal, 0), oliveGeometry(pal, 1)]),
    umbrella: G('umbrella', () => [umbrellaGeometry(pal, 0), umbrellaGeometry(pal, 1)]),
    rock0: [rockGeometry(pal, 0), rockGeometry(pal, 0)],
    rock1: [rockGeometry(pal, 1), rockGeometry(pal, 1)],
    boulder: [rockGeometry(pal, 2, true), rockGeometry(pal, 1, true)],
    stump: [stumpGeometry(pal), stumpGeometry(pal)],
    deadwood: [deadwoodGeometry(pal), deadwoodGeometry(pal)],
  };
  const leafGeo: [Geo, Geo] = [birchLeafGeometry(0), birchLeafGeometry(1)];
  const meshKinds = [...TREE, 'rock0', 'rock1', 'boulder', 'stump', 'deadwood'];
  const per: Prop[][][] = Array.from({ length: nChunks }, () => meshKinds.map(() => []));
  const bushes: Prop[][] = Array.from({ length: nChunks }, () => []);
  const counts: Record<string, number> = {};
  for (const p of stage.props) {
    let kind: string | null = null;
    if (TREE.includes(p.type)) kind = p.type;
    else if (p.type === 'rock') kind = 'rock0';
    else if (p.type === 'boulder' || p.type === 'stump' || p.type === 'deadwood') kind = p.type;
    else if (p.type === 'bush') { bushes[chunkKey(p)].push(p); counts.bush = (counts.bush ?? 0) + 1; continue; }
    if (!kind) continue;
    per[chunkKey(p)][meshKinds.indexOf(kind)].push(p);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const group = new THREE.Group();
  group.name = 'vegetation';
  const chunks: ChunkBuild[] = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color(), e = new THREE.Euler();
  const coverTex = paintCover(pal, art, () => {});
  const coverMat = coverMaterial(coverTex, lod.cover);
  const coverGeo = crossedCards();
  const bbTrees: { p: Prop; chunk: number }[] = [];

  for (let c = 0; c < nChunks; c++) {
    const near: THREE.Object3D[] = [], mid: THREE.Object3D[] = [], cover: THREE.Object3D[] = [];
    const box = new THREE.Box3();
    // all solid vegetation of the chunk in one BatchedMesh (one multi-draw per pass); LOD = per-instance geometry swap
    let nInst = 0, nVert = 0;
    const used = new Set<string>();
    meshKinds.forEach((kind, ki) => { if (per[c][ki].length) { nInst += per[c][ki].length; used.add(kind); } });
    let batch: THREE.BatchedMesh | null = null;
    const lodIds: { inst: number; g0: number; g1: number }[] = [];
    let birchList: Prop[] = [];
    if (nInst) {
      for (const kind of used) nVert += geos[kind]![0].attributes.position.count + geos[kind]![1].attributes.position.count;
      batch = new THREE.BatchedMesh(nInst, nVert, 0, vcol);
      batch.sortObjects = false;
      const gid: Record<string, [number, number]> = {};
      for (const kind of used) {
        const g0 = batch.addGeometry(geos[kind]![0]);
        const g1 = geos[kind]![1] === geos[kind]![0] ? g0 : batch.addGeometry(geos[kind]![1]);
        gid[kind] = [g0, g1];
      }
      meshKinds.forEach((kind, ki) => {
        const list = per[c][ki];
        if (!list.length) return;
        const isTree = TREE.includes(kind as PropType);
        const noMid = kind === 'stump' || kind === 'deadwood' || kind === 'rock0';
        if (!geos[kind]) return;
        list.forEach((p, i) => {
          const tilt = isTree ? (hash2(i, c, 5) - 0.5) * 0.07 : 0;
          e.set(tilt, p.rot, tilt * 0.7);
          q.setFromEuler(e);
          const sc = p.scale;
          const sy = kind === 'rock0' ? sc * (0.7 + 0.5 * hash2(i, c, 6)) : isTree ? sc * (0.9 + hash2(i, c, 9) * 0.25) : sc;
          s.set(sc, sy, sc);
          v.set(p.x, p.y - (kind.startsWith('rock') || kind === 'boulder' ? 0.18 * sc : 0.05), p.z);
          m4.compose(v, q, s);
          const id = batch!.addInstance(gid[kind][0]);
          batch!.setMatrixAt(id, m4);
          const k = 0.86 + hash2(i, c, 7) * 0.26;
          col.setRGB(k, k * (0.96 + hash2(i, c, 8) * 0.08), k * (0.94 + hash2(i, c, 10) * 0.06));
          batch!.setColorAt(id, col);
          lodIds.push({ inst: id, g0: gid[kind][0], g1: noMid ? -1 : gid[kind][1] });
          box.expandByPoint(v);
        });
        if (kind === 'birch') birchList = list;
        if (isTree) for (const p of list) bbTrees.push({ p, chunk: c });
      });
      batch.castShadow = true;
      batch.receiveShadow = true;
      batch.name = `trees-${c}`;
      batch.visible = false;
      batch.computeBoundingSphere();
      group.add(batch);
    }
    // birch crowns (alpha-tested cards): one InstancedMesh per LOD
    const leaves: THREE.InstancedMesh[] = [];
    if (birchList.length) {
      for (const l of [0, 1] as const) {
        const im = new THREE.InstancedMesh(leafGeo[l], leafMat, birchList.length);
        birchList.forEach((p, i) => {
          const tilt = (hash2(i, c, 5) - 0.5) * 0.07;
          e.set(tilt, p.rot, tilt * 0.7);
          q.setFromEuler(e);
          s.set(p.scale, p.scale * (0.9 + hash2(i, c, 9) * 0.25), p.scale);
          v.set(p.x, p.y - 0.05, p.z);
          m4.compose(v, q, s);
          im.setMatrixAt(i, m4);
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = true; im.receiveShadow = true;
        im.name = `leaves-${c}-lod${l}`;
        im.visible = false;
        (l === 0 ? near : mid).push(im);
        leaves.push(im);
        group.add(im);
      }
    }
    // ground cover + bushes
    const cov = coverInstances(stage, c, nS, bushes[c]);
    if (cov.length) {
      const im = new THREE.InstancedMesh(coverGeo, coverMat, cov.length);
      const cell = new Float32Array(cov.length);
      cov.forEach((it, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rot);
        s.set(it.w, it.h, it.w);
        v.set(it.x, it.y - 0.04, it.z);
        m4.compose(v, q, s);
        im.setMatrixAt(i, m4);
        const k = 0.85 + hash2(i, c, 11) * 0.3;
        col.setRGB(k, k, k * 0.97);
        im.setColorAt(i, col);
        cell[i] = it.cell;
        box.expandByPoint(v);
      });
      im.geometry = coverGeo.clone();
      im.geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 1));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.receiveShadow = true;
      im.castShadow = false;
      im.name = `cover-${c}`;
      im.visible = false;
      cover.push(im);
      group.add(im);
      counts.cover = (counts.cover ?? 0) + cov.length;
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(stage.cl.x[0], 0, stage.cl.z[0]), new THREE.Vector3(1, 1, 1));
    box.expandByScalar(12);
    const sph = new THREE.Sphere();
    box.getBoundingSphere(sph);
    chunks.push({ center: sph.center, radius: sph.radius, near, mid, cover, state: -1, index: c, batch, lodIds });
  }

  const billboards = buildBillboards(bbTrees, pal, nChunks, art);
  if (billboards) group.add(billboards);
  const flags = billboards ? (billboards.material as THREE.ShaderMaterial).uniforms.uChunkFar.value as Float32Array : null;

  return {
    group, chunks, counts, billboards,
    update(camPos: THREE.Vector3, time: number) {
      LOOK.uTime.value = time;
      for (const ch of chunks) {
        const d = Math.max(0, ch.center.distanceTo(camPos) - ch.radius);
        const st = d < lod.near ? 0 : d < lod.mid ? 1 : 2;
        const coverOn = d < lod.cover;
        if (st !== ch.state) {
          ch.state = st;
          setChunkLod(ch, st);
        }
        // billboards fade in (dithered) over the same band the geometry dissolves out
        if (flags) flags[ch.index] = d + 2 * ch.radius > lod.mid - 45 ? 1 : 0;
        for (const m of ch.cover) m.visible = coverOn;
      }
    },
    showAll() {
      for (const ch of chunks) { for (const m of [...ch.near, ...ch.mid, ...ch.cover]) m.visible = true; if (ch.batch) ch.batch.visible = true; ch.state = -1; }
    },
  };
}

/** two crossed vertical cards, base at y=0, 1×1 */
function crossedCards() {
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
  for (const a of [0, Math.PI / 2]) {
    const cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const b = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) nor.push(0, 1, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function coverMaterial(tex: THREE.Texture, fadeEnd: number) {
  return posterize(new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }), {
    key: 'cover', flatNormal: true,
    uniforms: { uFadeA: { value: fadeEnd * 0.6 }, uFadeB: { value: fadeEnd } },
    edit: (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aCell;\nuniform float uFadeA, uFadeB, uTime;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
vMapUv = vec2((mod(aCell, ${ATLAS_W}.0) + uv.x) / ${ATLAS_W}.0, (${ATLAS_H}.0 - 1.0 - floor(aCell / ${ATLAS_W}.0) + uv.y) / ${ATLAS_H}.0);
`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vec3 ip = (modelMatrix * instanceMatrix[3]).xyz;
float dc = distance(ip.xz, cameraPosition.xz);
transformed *= 1.0 - smoothstep(uFadeA, uFadeB, dc);
float sway = sin(uTime * 1.6 + ip.x * 0.31 + ip.z * 0.23) * 0.06 + sin(uTime * 3.1 + ip.x * 0.9) * 0.02;
transformed.xz += vec2(sway, sway * 0.6) * position.y;`);
    },
  });
}

interface CoverItem { x: number; y: number; z: number; rot: number; w: number; h: number; cell: number }

/** ground cover for one chunk: zone densities, deterministic hash scatter on a 1.6 m grid around the road */
function coverInstances(stage: Stage, chunk: number, nS: number, bushes: Prop[]): CoverItem[] {
  const out: CoverItem[] = [];
  for (const b of bushes) {
    const big = b.scale;
    out.push({ x: b.x, y: b.y, z: b.z, rot: b.rot, w: 2.6 * big, h: 1.9 * big, cell: hash2(Math.round(b.x), Math.round(b.z), 3) < 0.5 ? 5 : 6 });
  }
  const si = Math.floor(chunk / 2), band = chunk % 2;
  if (band === 1) return out; // cover only near the road (inner band); outer band shows bushes only
  const tr = stage.terrain, e2 = tr.edge2;
  const seed = stage.def.seed;
  const s0 = si * VEG_CHUNK, s1 = Math.min(stage.cl.length, (si + 1) * VEG_CHUNK);
  const step = 1.7;
  for (let s = s0; s < s1; s += step) {
    const p = stage.pointAt(s);
    const zd = zoneDef(stage.env, stage.zones.id(s));
    const tot = zd.cover.grass + zd.cover.fern + zd.cover.flower;
    for (let d = -BAND; d <= BAND; d += step) {
      const ad = Math.abs(d);
      if (ad < e2 - 1.2) continue;
      const ix = Math.round(s / step), iz = Math.round(d / step);
      const h = hash2(ix, iz, seed + 501);
      // denser right at the verge (tufts in the ditch and shoulder edge), thinning with distance
      const dens = tot * (ad < e2 + 3 ? 1.6 : 1 - Math.min(0.6, (ad - e2) / 80));
      if (h > (dens * step * step) / 100) continue;
      const jx = (hash2(ix, iz, seed + 502) - 0.5) * step, jz = (hash2(ix, iz, seed + 503) - 0.5) * step;
      const x = p.x + p.rx * (d + jz) + p.dx * jx, z = p.z + p.rz * (d + jz) + p.dz * jx;
      const q = tr.nearest(x, z);
      if (q.found && Math.abs(q.d) < stage.def.halfWidth + 0.55) continue;
      if (stage.surface(x, z) === 8 /* water */) continue;
      if (tr.coast && tr.offshore(x, z)) continue;
      const r = hash2(ix, iz, seed + 504) * tot;
      let cell = r < zd.cover.grass ? (hash2(ix, iz, seed + 505) < 0.55 ? 0 : 1) : r < zd.cover.grass + zd.cover.fern ? 2 : 3;
      if (cell === 0 && zd.ground.forest < 0.3 && hash2(ix, iz, seed + 509) < 0.12) cell = 7;
      const sz = 0.55 + hash2(ix, iz, seed + 506) * 0.7;
      const w = cell === 2 ? 1.5 * sz : 1.1 * sz, hh = cell === 2 ? 0.95 * sz : 0.75 * sz;
      out.push({ x, y: stage.height(x, z), z, rot: hash2(ix, iz, seed + 507) * Math.PI, w, h: hh, cell });
    }
  }
  // reeds along lake shores in this stretch
  for (const L of tr.lakes) {
    if (L.s1 < s0 - 60 || L.s0 > s1 + 60) continue;
    const zd = zoneDef(stage.env, stage.zones.id((s0 + s1) / 2));
    const n = Math.round(zd.cover.reed * 30);
    for (let k = 0; k < n; k++) {
      const a = hash2(k, chunk, seed + 520) * Math.PI * 2;
      const rho = 0.83 + hash2(k, chunk, seed + 521) * 0.1;
      const x = L.cx + (Math.cos(a) * L.a * L.ux - Math.sin(a) * L.b * L.uz) * rho;
      const z = L.cz + (Math.cos(a) * L.a * L.uz + Math.sin(a) * L.b * L.ux) * rho;
      const sp = stage.corridor.sAt(x, z);
      if (sp < s0 || sp >= s1) continue;
      const sz = 0.8 + hash2(k, chunk, seed + 522) * 0.6;
      out.push({ x, y: Math.max(stage.height(x, z), L.level - 0.2), z, rot: hash2(k, chunk, seed + 523) * Math.PI, w: 1.6 * sz, h: 1.7 * sz, cell: 4 });
    }
  }
  return out;
}

/** far-tree billboards per art set: up to four images; per tree kind: which images, height at scale 1 (m) */
const BILLBOARDS: Record<string, { files: [string, number][]; kinds: Record<string, { img: number[]; h: number }> }> = {
  nordic: {
    files: [['pine_billboard.png', 0.55], ['pine_billboard_2.png', 0.6], ['birch_billboard.png', 0.62], ['birch_billboard_2.png', 0.62]],
    kinds: { pine: { img: [0], h: 14.5 }, scots: { img: [1], h: 16 }, spruce: { img: [0], h: 6.5 }, birch: { img: [2, 3], h: 12.5 } },
  },
  savanna: {
    files: [['acacia_billboard.png', 1.38], ['acacia_billboard_2.png', 1.51], ['acacia_billboard.png', 1.38], ['acacia_billboard_2.png', 1.51]],
    kinds: { acacia: { img: [0, 1], h: 8.0 }, thorn: { img: [1], h: 4.6 } },
  },
  snow: {
    files: [['snow_pine_billboard.png', 0.6], ['snow_pine_billboard_2.png', 0.74], ['bare_tree_billboard.png', 0.9], ['bare_tree_billboard_2.png', 0.56]],
    kinds: { snowpine: { img: [0, 1], h: 15 }, snowspruce: { img: [1], h: 6.8 }, bare: { img: [2, 3], h: 10 } },
  },
  coast: {
    files: [['cypress_billboard.png', 0.23], ['cypress_billboard_2.png', 0.25], ['olive_billboard.png', 1.16], ['pine_umbrella_billboard.png', 1.03]],
    kinds: { cypress: { img: [0, 1], h: 11 }, olive: { img: [2], h: 4.6 }, umbrella: { img: [3], h: 12.5 } },
  },
};

/** far trees: art billboards, cylindrical facing, chosen per instance; hidden unless their chunk is in far state */
function buildBillboards(trees: { p: Prop; chunk: number }[], pal: Palette, nChunks: number, art: string) {
  const set = BILLBOARDS[art];
  if (!set) return null;
  const files = set.files.map(([f]) => `/assets/tex/${art}/${f}`);
  trees = trees.filter((t) => set.kinds[t.p.type]);
  if (!files.every(hasAsset) || !trees.length) return null;
  const texs = files.map((f) => imageTexture(f));
  for (const t of texs) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  const n = trees.length;
  const aPos = new Float32Array(n * 4), aSize = new Float32Array(n * 4);
  trees.forEach(({ p, chunk }, i) => {
    const k = set.kinds[p.type];
    const img = k.img[Math.floor(hash2(i, 1, 3) * k.img.length)];
    const h = k.h * p.scale;
    aPos.set([p.x, p.y - 0.2, p.z, chunk], i * 4);
    aSize.set([h * set.files[img][1], h, img, 0.85 + hash2(i, 2, 3) * 0.25], i * 4);
  });
  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 4));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 4));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      t0: { value: texs[0] }, t1: { value: texs[1] }, t2: { value: texs[2] }, t3: { value: texs[3] },
      uChunkFar: { value: new Float32Array(Math.max(nChunks, 1)) },
      uShade: { value: pal.look.shadowTint.clone() }, uSunDir: { value: new THREE.Vector3() }, uLodFade: LOOK.uLodFade, uLight: { value: Math.min(1, pal.look.sunStrength * 1.05) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aPos; attribute vec4 aSize;
      uniform float uChunkFar[${Math.max(nChunks, 1)}];
      varying vec2 vUv; varying float vKind; varying float vTone; varying float vSide; varying float vDist;
      void main(){
        vDist = distance(cameraPosition, aPos.xyz + vec3(0.0, aSize.y * 0.5, 0.0));
        float on = uChunkFar[int(aPos.w)];
        vec3 c = aPos.xyz;
        vec3 toCam = cameraPosition - c; toCam.y = 0.0;
        vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
        vec3 p = c + right * position.x * aSize.x + vec3(0.0, position.y * aSize.y, 0.0);
        vUv = uv; vKind = aSize.z; vTone = aSize.w; vSide = position.x;
        gl_Position = on > 0.5 ? projectionMatrix * viewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D t0, t1, t2, t3; uniform vec3 uShade; uniform vec2 uLodFade; uniform float uLight;
      varying vec2 vUv; varying float vKind; varying float vTone; varying float vSide; varying float vDist;
      void main(){
        float fadeIn = smoothstep(uLodFade.x, uLodFade.y, vDist);
        if (fadeIn < 0.02) discard;
        vec4 c = vKind < 0.5 ? texture2D(t0, vUv) : vKind < 1.5 ? texture2D(t1, vUv) : vKind < 2.5 ? texture2D(t2, vUv) : texture2D(t3, vUv);
        if (c.a < 0.5) discard;
        vec3 col = c.rgb * vTone * uLight;
        col = mix(col, uShade * dot(col, vec3(0.5)), 0.12 + 0.12 * smoothstep(-0.1, 0.5, vSide));
        gl_FragColor = vec4(col, fadeIn);
        #include <colorspace_fragment>
      }`,
  });
  mat.alphaToCoverage = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'billboards';
  void DS;
  return mesh;
}
