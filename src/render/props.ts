// Stage furniture and scenery props built from stage.props / markers / tape:
//  - start/finish arches, km and countdown boards, spectator tape (posts + striped tape);
//  - vertex-coloured models (red cabins/barns/sheds, fences, hay bales, log piles, power poles + wires, service vans,
//    media towers, flag poles), merged into one mesh per PROP_CHUNK of road (one draw per visible chunk);
//  - textured boards from one atlas (sponsor banners from the art, corner chevrons, flags that wave), merged per chunk;
//  - spectators: art crowd cut-outs as camera-facing billboards in one draw call, bobbing/waving, livelier as the car nears.
import * as THREE from 'three';
import { hash2 } from '../sim/math/rng';
import type { Prop } from '../sim/stage/scatter';
import type { Stage } from '../sim/stage/stage';
import { LOOK, posterVcol, posterize } from './look';
import { hasAsset, imageTexture, type Palette } from './materials';
import { signCanvas } from './texgen';

const PROP_CHUNK = 400;
const C = (h: string) => new THREE.Color(h);

function canvasTex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 8;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f1ece0'; g.fillRect(0, 0, 64, 8);
  g.fillStyle = '#c8362a'; g.fillRect(0, 0, 32, 8);
  const t = canvasTex(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

const lam = (c: THREE.ColorRepresentation, extra: THREE.MeshLambertMaterialParameters = {}) => posterize(new THREE.MeshLambertMaterial({ color: c, ...extra }), { key: 'prop' + (extra.map ? '-map' : '') });

// ---------------------------------------------------------------------------------------------------------------------
// geometry accumulator (position, normal, colour, uv, wave weight)

class Acc {
  pos: number[] = []; nor: number[] = []; col: number[] = []; uv: number[] = []; wave: number[] = [];
  private m = new THREE.Matrix4(); private n3 = new THREE.Matrix3();
  /** append geometry (non-indexed copy) transformed by (x,y,z,yaw,scale), single colour or per-vertex fn */
  add(g: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number, scale: number | THREE.Vector3, color: THREE.Color | ((x: number, y: number, z: number) => THREE.Color), uvRect?: [number, number, number, number], wave = 0) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const sc = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale;
    this.m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), sc);
    this.n3.getNormalMatrix(this.m);
    const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
    const v = new THREE.Vector3(), nn = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i));
      const c = typeof color === 'function' ? color(v.x, v.y, v.z) : color;
      v.applyMatrix4(this.m);
      nn.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(this.n3).normalize();
      this.pos.push(v.x, v.y, v.z); this.nor.push(nn.x, nn.y, nn.z); this.col.push(c.r, c.g, c.b);
      if (uvRect && uv) this.uv.push(uvRect[0] + uv.getX(i) * uvRect[2], uvRect[1] + uv.getY(i) * uvRect[3]);
      else this.uv.push(0, 0);
      this.wave.push(wave * (uv ? uv.getX(i) : 0));
    }
  }
  /** a raw quad strip (wires) */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color) {
    for (const v of [a, b, c, a, c, d]) { this.pos.push(v.x, v.y, v.z); this.nor.push(0, 1, 0); this.col.push(color.r, color.g, color.b); this.uv.push(0, 0); this.wave.push(0); }
  }
  get empty() { return this.pos.length === 0; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWave', new THREE.Float32BufferAttribute(this.wave, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function mergeSimple(geos: THREE.BufferGeometry[]) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array as Float32Array, o * 3); nor.set(g.attributes.normal.array as Float32Array, o * 3); o += g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (r0: number, r1: number, h: number, seg: number, x = 0, y = 0, z = 0) => new THREE.CylinderGeometry(r0, r1, h, seg, 1).translate(x, y, z);

/** gable roof prism along X: width w (z), length l (x), ridge height h, at base y */
function roof(l: number, w: number, h: number, y: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 - 0.35, 0); s.lineTo(w / 2 + 0.35, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: l + 0.6, bevelEnabled: false });
  g.translate(0, 0, -(l + 0.6) / 2);
  g.rotateY(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

let STYLE = { snowRoof: false };
/** crowd cut-outs are unlit: dimmed at night */
let STYLE_LIGHT = 1;

function addCabin(a: Acc, p: Prop) {
  const red = C('#a8382a'), white = C('#f1ebdc'), roofC = STYLE.snowRoof ? C('#eef0f6') : C('#3a3633'), dark = C('#2b2a2e');
  const v = p.variant;
  const [L, W, H] = v === 1 ? [10, 6.5, 4.2] : v === 2 ? [3.6, 3.0, 2.3] : [7, 4.6, 3];
  const parts: [THREE.BufferGeometry, THREE.Color][] = [
    [box(L, H, W, 0, H / 2, 0), red],
    [roof(L, W, v === 1 ? 3.2 : 2.2, H), roofC],
    // white corner boards and trims
    [box(0.22, H, 0.22, L / 2, H / 2, W / 2), white], [box(0.22, H, 0.22, -L / 2, H / 2, W / 2), white],
    [box(0.22, H, 0.22, L / 2, H / 2, -W / 2), white], [box(0.22, H, 0.22, -L / 2, H / 2, -W / 2), white],
    [box(L + 0.1, 0.2, W + 0.1, 0, H - 0.1, 0), white],
  ];
  if (v === 1) {
    parts.push([box(2.6, 2.9, 0.1, 0, 1.45, W / 2 + 0.03), white], [box(2.3, 2.6, 0.12, 0, 1.4, W / 2 + 0.04), red]);
    parts.push([box(3.3, 0.16, 0.14, 0, 1.4, W / 2 + 0.1).rotateZ(0.8).translate(0.95, 0.55, 0), white]);
  } else {
    parts.push([box(0.95, 1.95, 0.08, -L * 0.25, 0.97, W / 2 + 0.03), white], [box(0.75, 1.8, 0.1, -L * 0.25, 0.92, W / 2 + 0.05), dark]);
    for (const wx of v === 2 ? [L * 0.2] : [L * 0.12, L * 0.33]) {
      parts.push([box(1.1, 1.0, 0.08, wx, H * 0.58, W / 2 + 0.03), white], [box(0.85, 0.78, 0.1, wx, H * 0.58, W / 2 + 0.05), dark]);
      parts.push([box(1.1, 1.0, 0.08, wx, H * 0.58, -W / 2 - 0.03), white]);
    }
    if (v === 0) parts.push([box(0.6, 1.4, 0.6, L * 0.25, H + 1.6, 0), C('#7a3a2c')]);
  }
  for (const [g, c] of parts) a.add(g, p.x, p.y - 0.2, p.z, p.rot, p.scale, c);
}

function addFence(a: Acc, p: Prop) {
  const wood = C('#8c7a66'), dk = C('#6b5c4c');
  const L = p.len ?? 3;
  // geometry along +Z from the post at (x,z); rot = atan2(dx, dz)
  a.add(cyl(0.06, 0.07, 1.25, 5, 0, 0.62, 0), p.x, p.y, p.z, p.rot, 1, dk);
  for (const h of [0.45, 0.95]) a.add(box(0.07, 0.12, L, 0, h, L / 2), p.x, p.y, p.z, p.rot, 1, wood);
  // diagonal brace every other section (classic Nordic roundpole look)
  if (hash2(Math.round(p.x), Math.round(p.z), 4) < 0.5) a.add(box(0.06, 0.08, L * 1.1, 0, 0.7, L / 2).rotateX(0.32), p.x, p.y, p.z, p.rot, 1, wood);
}

function addHay(a: Acc, p: Prop) {
  const straw = C('#d6bf72'), end = C('#e8d89a'), wrap = C('#e9e4d8');
  const g = cyl(0.75, 0.75, 1.25, 12).rotateZ(Math.PI / 2).translate(0, 0.75, 0);
  const white = hash2(Math.round(p.x * 3), Math.round(p.z * 3), 2) < 0.35;
  a.add(g, p.x, p.y - 0.06, p.z, p.rot, p.scale, (x) => (Math.abs(x) > 0.6 ? (white ? wrap.clone().multiplyScalar(0.95) : end) : white ? wrap : straw));
}

function addLogs(a: Acc, p: Prop) {
  const wood = C('#8a5a3c'), end = C('#e3c48f'), endDk = C('#c9a36c');
  const rows = p.variant ? [[5, 0], [4, 1], [3, 2], [2, 3]] : [[3, 0], [2, 1], [1, 2]];
  for (const [count, layer] of rows) for (let i = 0; i < count; i++) {
    const r = 0.3 + hash2(i, layer, 3) * 0.06;
    const g = cyl(r, r, 5.2 + hash2(i, layer, 4) * 0.6, 7).rotateZ(Math.PI / 2).translate((hash2(i, layer, 5) - 0.5) * 0.4, 0.32 + layer * 0.55, (i - (count - 1) / 2) * 0.66);
    a.add(g, p.x, p.y, p.z, p.rot, p.scale, (x) => (Math.abs(x) > 2.5 ? (i % 2 ? end : endDk) : wood));
  }
}

function addPole(a: Acc, p: Prop) {
  const wood = C('#5f4a3a'), ins = C('#e8e6e0');
  a.add(cyl(0.12, 0.16, 9, 6, 0, 4.5, 0), p.x, p.y - 0.3, p.z, p.rot, 1, wood);
  a.add(box(1.8, 0.12, 0.12, 0, 8.4, 0), p.x, p.y - 0.3, p.z, p.rot, 1, wood);
  for (const x of [-0.75, 0, 0.75]) a.add(cyl(0.05, 0.05, 0.22, 4, x, 8.58, 0), p.x, p.y - 0.3, p.z, p.rot, 1, ins);
}

function addVan(a: Acc, p: Prop) {
  const bodies = [C('#efe9dc'), C('#2f6aa3'), C('#c8362a')];
  const body = bodies[p.variant % 3], glass = C('#2b3340'), tyre = C('#1e1e20'), stripe = C('#f2c230');
  const parts: [THREE.BufferGeometry, THREE.Color][] = [
    [box(2.0, 1.75, 5.0, 0, 1.25, 0), body],
    [box(1.92, 0.75, 1.0, 0, 1.55, -2.1), glass],
    [box(2.02, 0.18, 5.02, 0, 1.0, 0), stripe],
    [box(2.06, 0.5, 0.2, 0, 0.55, -2.55), C('#3a3a3a')],
  ];
  for (const [x, z] of [[-0.9, -1.6], [0.9, -1.6], [-0.9, 1.6], [0.9, 1.6]]) parts.push([cyl(0.36, 0.36, 0.28, 8).rotateZ(Math.PI / 2).translate(x, 0.36, z), tyre]);
  for (const [g, c] of parts) a.add(g, p.x, p.y, p.z, p.rot, 1, c);
}

function addTower(a: Acc, p: Prop) {
  const steel = C('#b8b4ac'), deck = C('#6b5c4c'), roofC = C('#c8362a');
  const H = 5.5;
  for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) a.add(box(0.1, H + 2.4, 0.1, x, (H + 2.4) / 2, z), p.x, p.y - 0.2, p.z, p.rot, 1, steel);
  for (let y = 1; y < H; y += 1.8) {
    a.add(box(2.7, 0.08, 0.08, 0, y, -1.3), p.x, p.y - 0.2, p.z, p.rot, 1, steel);
    a.add(box(2.7, 0.08, 0.08, 0, y, 1.3), p.x, p.y - 0.2, p.z, p.rot, 1, steel);
    a.add(box(0.08, 0.08, 2.7, -1.3, y, 0), p.x, p.y - 0.2, p.z, p.rot, 1, steel);
    a.add(box(0.08, 0.08, 2.7, 1.3, y, 0), p.x, p.y - 0.2, p.z, p.rot, 1, steel);
  }
  a.add(box(3.0, 0.15, 3.0, 0, H, 0), p.x, p.y - 0.2, p.z, p.rot, 1, deck);
  a.add(box(3.0, 0.9, 0.06, 0, H + 0.5, 1.5), p.x, p.y - 0.2, p.z, p.rot, 1, C('#f1ebdc'));
  a.add(box(3.2, 0.12, 3.2, 0, H + 2.45, 0), p.x, p.y - 0.2, p.z, p.rot, 1, roofC);
}

function addHut(a: Acc, p: Prop) {
  const wall = p.variant ? C('#c98a5a') : C('#b5704a'), thatch = C('#d6b067'), thatchDk = C('#a88440'), door = C('#3a2a22');
  a.add(cyl(2.0, 2.1, 2.2, 10, 0, 1.1, 0), p.x, p.y - 0.15, p.z, p.rot, p.scale, wall);
  a.add(new THREE.ConeGeometry(2.7, 2.4, 10, 1).translate(0, 3.35, 0), p.x, p.y - 0.15, p.z, p.rot, p.scale, (_x, y) => (y > 3.7 ? thatchDk : thatch));
  a.add(box(0.9, 1.6, 0.1, 0, 0.8, 2.02), p.x, p.y - 0.15, p.z, p.rot, p.scale, door);
}

function addTent(a: Acc, p: Prop) {
  const cols = [C('#c8362a'), C('#2f6aa3'), C('#f2c230')];
  const top = cols[p.variant % 3], white = C('#f1ece0'), leg = C('#9a948a');
  for (const [x, z] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) a.add(box(0.08, 2.4, 0.08, x, 1.2, z), p.x, p.y, p.z, p.rot, 1, leg);
  a.add(new THREE.ConeGeometry(2.9, 1.2, 4, 1).rotateY(Math.PI / 4).translate(0, 3.0, 0), p.x, p.y, p.z, p.rot, 1, top);
  a.add(box(4.0, 0.35, 4.0, 0, 2.3, 0), p.x, p.y, p.z, p.rot, 1, (x, _y, z) => ((Math.floor((x + z + 4) * 1.2) % 2) ? white : top));
  a.add(box(3.0, 0.8, 0.8, 0, 0.4, 0.6), p.x, p.y, p.z, p.rot, 1, white);
}

function addTermite(a: Acc, p: Prop, pal: Palette) {
  const c = pal.dirt.clone().lerp(pal.road, 0.3), dk = pal.dirt.clone().multiplyScalar(0.75);
  const g = new THREE.ConeGeometry(0.9, 2.6, 7, 3);
  wobbleG(g, 0.18, Math.round(p.x * 7));
  g.translate(0, 1.15, 0);
  a.add(g, p.x, p.y - 0.1, p.z, p.rot, p.scale, (_x, y) => dk.clone().lerp(c, Math.min(1, (y + 0.2) / 2.2)));
  if (p.variant) { const g2 = new THREE.ConeGeometry(0.5, 1.5, 6, 2); wobbleG(g2, 0.12, 3); g2.translate(0.7, 0.6, 0.2); a.add(g2, p.x, p.y - 0.1, p.z, p.rot, p.scale, c); }
}

function addRockpile(a: Acc, p: Prop, pal: Palette) {
  const lo = pal.rock.clone().multiplyScalar(0.72), hi = pal.rock.clone().lerp(C('#f0dcc0'), 0.25);
  const n = 4 + p.variant * 2;
  for (let i = 0; i < n; i++) {
    const r = 0.9 + hash2(i, p.variant, 41) * 1.1;
    const g = new THREE.DodecahedronGeometry(r, 0);
    wobbleG(g, 0.35, i * 13 + p.variant);
    const ang = i * 2.4, rr = i ? 1.1 + hash2(i, 2, 41) * 1.3 : 0;
    g.scale(1.2, 0.85, 1.0);
    g.translate(Math.cos(ang) * rr, r * 0.55 + (i ? 0 : 0.6), Math.sin(ang) * rr);
    a.add(g, p.x, p.y - 0.25, p.z, p.rot, p.scale * 0.6, (_x, y) => lo.clone().lerp(hi, Math.min(1, Math.max(0, (y + 0.3) / 2.2))));
  }
}

function addSnowfence(a: Acc, p: Prop) {
  const wood = C('#7a5a44'), slat = C('#9a7458');
  const L = p.len ?? 3;
  a.add(cyl(0.06, 0.07, 1.6, 5, 0, 0.8, 0), p.x, p.y - 0.1, p.z, p.rot, 1, wood);
  for (const h of [0.55, 1.25]) a.add(box(0.05, 0.08, L, 0, h, L / 2), p.x, p.y - 0.1, p.z, p.rot, 1, wood);
  for (let u = 0.15; u < L; u += 0.3) a.add(box(0.03, 1.2, 0.12, 0, 0.85, u), p.x, p.y - 0.1, p.z, p.rot, 1, slat);
}

function addSnowpile(a: Acc, p: Prop) {
  const g = new THREE.IcosahedronGeometry(1.6, 1);
  wobbleG(g, 0.35, Math.round(p.x * 3));
  g.scale(1.6, 0.6, 1.0);
  a.add(g, p.x, p.y - 0.25, p.z, p.rot, p.scale, (_x, y) => C('#dcdcea').lerp(C('#fafaff'), Math.min(1, Math.max(0, y + 0.4))));
}

function addHouse(a: Acc, p: Prop) {
  const walls = [C('#f2ede2'), C('#efe3c8'), C('#e9d4a8')][p.variant % 3], roofC = C('#c4553a'), shutter = [C('#2f6aa3'), C('#5a7a3a'), C('#2f6aa3')][p.variant % 3], dark = C('#3a3430');
  const [L, W, H] = p.variant === 1 ? [9, 6, 6.2] : p.variant === 2 ? [5, 4.5, 3.4] : [7.5, 5.5, 4.6];
  const parts: [THREE.BufferGeometry, THREE.Color][] = [
    [box(L, H, W, 0, H / 2, 0), walls],
    [roof(L, W, 1.4, H), roofC],
    [box(0.95, 2.0, 0.08, -L * 0.22, 1.0, W / 2 + 0.03), dark],
  ];
  for (const wx of p.variant === 2 ? [L * 0.2] : [L * 0.08, L * 0.32]) {
    for (const wy of H > 5 ? [H * 0.32, H * 0.7] : [H * 0.55]) {
      parts.push([box(0.8, 1.0, 0.06, wx, wy, W / 2 + 0.03), dark], [box(0.36, 1.0, 0.07, wx - 0.6, wy, W / 2 + 0.04), shutter], [box(0.36, 1.0, 0.07, wx + 0.6, wy, W / 2 + 0.04), shutter]);
    }
  }
  for (const [g, c] of parts) a.add(g, p.x, p.y - 0.3, p.z, p.rot, p.scale, c);
}

function addWall(a: Acc, p: Prop, pal: Palette) {
  const L = p.len ?? 2.5;
  const st = pal.rock.clone(), dk = pal.rock.clone().multiplyScalar(0.72);
  const g = box(0.7, 0.9, L, 0, 0.42, L / 2);
  a.add(g, p.x, p.y - 0.05, p.z, p.rot, 1, (x, y, z) => (hash2(Math.floor(y * 3.5), Math.floor(z * 2.2 + (Math.floor(y * 3.5) % 2) * 0.5), 5) < 0.3 ? dk : st.clone().multiplyScalar(0.9 + hash2(Math.floor(z * 2.2), Math.floor(y * 3.5), 6) * 0.2)));
  a.add(box(0.8, 0.12, L, 0, 0.9, L / 2), p.x, p.y - 0.05, p.z, p.rot, 1, dk);
}

function wobbleG(g: THREE.BufferGeometry, amt: number, seed: number) {
  const pp = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
    const k = Math.round(x * 100) * 7 + Math.round(y * 100) * 13 + Math.round(z * 100) * 31;
    pp.setXYZ(i, x + (hash2(k, 1, seed) - 0.5) * amt, y + (hash2(k, 2, seed) - 0.5) * amt * 0.5, z + (hash2(k, 3, seed) - 0.5) * amt);
  }
  g.computeVertexNormals();
}

// ---------------------------------------------------------------------------------------------------------------------
// textured atlas (2048²): banners 2×3 (1024×256), chevrons L/R (512×256) at y 768, flags 4 (256×256) at x 1024 y 768,
// crowd 4 (512×512) at y 1024

const AT = 2048;
const rectPx = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x / AT, 1 - (y + h) / AT, w / AT, h / AT];
const BANNER = (i: number) => rectPx((i % 2) * 1024 + 4, Math.floor(i / 2) * 256 + 4, 1016, 248);
const CHEVRON = (dir: number) => rectPx(dir * 512 + 4, 768 + 4, 504, 248);
const FLAG = (i: number) => rectPx(1024 + i * 256 + 4, 768 + 4, 248, 248);
const CROWD = (i: number) => rectPx(i * 512 + 2, 1024 + 2, 508, 508);

function buildAtlas(art: string, onLoaded: (i: number, aspect: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = AT;
  const g = c.getContext('2d')!;
  // chevrons: black board, white arrows (left = 0, right = 1)
  for (const dir of [0, 1]) {
    const x0 = dir * 512, y0 = 768;
    g.fillStyle = '#1b1b1b'; g.fillRect(x0, y0, 512, 256);
    g.fillStyle = '#f2c230'; g.fillRect(x0, y0, 512, 14); g.fillRect(x0, y0 + 242, 512, 14);
    g.fillStyle = '#f4efe2';
    for (let k = 0; k < 3; k++) {
      const cx = x0 + 110 + k * 145;
      g.beginPath();
      if (dir === 1) { g.moveTo(cx - 40, y0 + 40); g.lineTo(cx + 30, y0 + 128); g.lineTo(cx - 40, y0 + 216); g.lineTo(cx, y0 + 216); g.lineTo(cx + 70, y0 + 128); g.lineTo(cx, y0 + 40); }
      else { g.moveTo(cx + 40, y0 + 40); g.lineTo(cx - 30, y0 + 128); g.lineTo(cx + 40, y0 + 216); g.lineTo(cx, y0 + 216); g.lineTo(cx - 70, y0 + 128); g.lineTo(cx, y0 + 40); }
      g.closePath(); g.fill();
    }
  }
  // flags: simple fictional event pennants
  const fl = [['#c8362a', '#f4efe2'], ['#2f6aa3', '#f2c230'], ['#f2c230', '#1b1b1b'], ['#f4efe2', '#c8362a']];
  fl.forEach(([a, b], i) => {
    const x0 = 1024 + i * 256, y0 = 768;
    g.fillStyle = a; g.fillRect(x0, y0, 256, 256);
    g.fillStyle = b;
    if (i % 2) { g.fillRect(x0, y0 + 96, 256, 64); } else { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + 256, y0 + 128); g.lineTo(x0, y0 + 256); g.closePath(); g.fill(); }
  });
  const tex = canvasTex(c);
  tex.generateMipmaps = true;
  const draw = (url: string, x: number, y: number, w: number, h: number, fit: 'fill' | 'bottom') => {
    if (!hasAsset(url)) return;
    imageTexture(url, true, (t) => {
      const img = t.image as HTMLImageElement;
      if (fit === 'fill') g.drawImage(img, x, y, w, h);
      else { const s = Math.min(w / img.width, h / img.height); const dw = img.width * s, dh = img.height * s; g.drawImage(img, x + (w - dw) / 2, y + h - dh, dw, dh); }
      tex.needsUpdate = true;
      onLoaded(-1, img.width / img.height);
    });
  };
  for (let i = 0; i < 6; i++) draw(`/assets/sponsors/banner_${i + 1}.jpg`, (i % 2) * 1024, Math.floor(i / 2) * 256, 1024, 256, 'fill');
  // crowd: four cut-outs of the environment's spectators (8 exist per set; a stage-seeded pick of four)
  for (let i = 0; i < 4; i++) {
    const url = `/assets/crowd/${art}_${i + 1}.png`;
    if (!hasAsset(url)) continue;
    imageTexture(url, true, (t) => {
      const img = t.image as HTMLImageElement;
      const s = Math.min(508 / img.width, 508 / img.height); const dw = img.width * s, dh = img.height * s;
      g.drawImage(img, i * 512 + 2 + (508 - dw) / 2, 1024 + 2 + 508 - dh, dw, dh);
      tex.needsUpdate = true;
      onLoaded(i, img.width / img.height);
    });
  }
  // crowd image aspect ratios are needed for billboard widths: read once loaded
  return tex;
}


// ---------------------------------------------------------------------------------------------------------------------

export interface PropsBuild { group: THREE.Group; update(time: number, carPos: THREE.Vector3): void }

export function buildProps(stage: Stage, pal: Palette): PropsBuild {
  const group = new THREE.Group();
  group.name = 'props';
  const tr = stage.terrain;
  STYLE = { snowRoof: stage.env.road.kind === 'snow' };
  STYLE_LIGHT = stage.weather.night ? 0.32 : 1;

  // ---- arches (posts + banner box share one material; the two printed faces are planes) ----
  const archPosts: THREE.BufferGeometry[] = [];
  for (const mk of stage.markers) {
    if (mk.kind !== 'start' && mk.kind !== 'finish' && mk.kind !== 'stop') continue;
    const p = stage.pointAt(mk.s);
    const w = tr.edge2 + 1.2;
    const arch = new THREE.Group();
    const yL = stage.height(p.x - p.rx * w, p.z - p.rz * w), yR = stage.height(p.x + p.rx * w, p.z + p.rz * w);
    const baseY = Math.min(yL, yR);
    if (mk.kind !== 'stop') {
      const label = mk.kind === 'start' ? '起点  START' : '终点  FINISH';
      const bg = mk.kind === 'start' ? '#1f5e8c' : '#c8362a';
      const bh = Math.max(yL, yR) - baseY + 5.4;
      const frame = [
        new THREE.BoxGeometry(0.55, 6.2, 0.55).translate(-w, yL - baseY + 2.5, 0),
        new THREE.BoxGeometry(0.55, 6.2, 0.55).translate(w, yR - baseY + 2.5, 0),
        new THREE.BoxGeometry(w * 2 + 0.6, 1.5, 0.35).translate(0, bh, 0),
      ];
      const fm = new THREE.Mesh(mergeSimple(frame), lam(bg));
      fm.castShadow = true;
      arch.add(fm);
      for (const [face, text] of [[1, label], [-1, mk.kind === 'start' ? stage.def.name : label]] as const) {
        const pl = new THREE.Mesh(new THREE.PlaneGeometry(w * 2 + 0.5, 1.4), lam('#ffffff', { map: canvasTex(signCanvas(text, 1024, 128, bg, '#f4efe2')) }));
        pl.position.set(0, bh, face * 0.18);
        if (face < 0) pl.rotation.y = Math.PI;
        arch.add(pl);
      }
      const lineC = document.createElement('canvas'); lineC.width = 128; lineC.height = 16;
      const lg = lineC.getContext('2d')!;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { lg.fillStyle = (i + j) % 2 ? '#111' : '#eee'; lg.fillRect(i * 8, j * 8, 8, 8); }
      const line = new THREE.Mesh(new THREE.PlaneGeometry(stage.def.halfWidth * 2 + 0.6, 0.6), lam('#ffffff', { map: canvasTex(lineC), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, stage.height(p.x, p.z) - baseY + 0.03, 0);
      line.receiveShadow = true;
      arch.add(line);
    } else {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), lam('#ffffff', { map: canvasTex(signCanvas('STOP', 256, 256, '#c8362a', '#fff')), side: THREE.DoubleSide }));
      sign.position.set(w - 0.6, yR - baseY + 1.8, 0);
      arch.add(sign);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8), lam('#ddd'));
      pole.position.set(w - 0.6, yR - baseY + 0.9, 0.03);
      arch.add(pole);
    }
    arch.position.set(p.x, baseY, p.z);
    arch.rotation.y = Math.atan2(-p.dx, -p.dz);
    group.add(arch);
  }
  void archPosts;

  // ---- boards: km and finish countdown (printed plane + post; posts go into the merged prop mesh) ----
  const boardPosts: { x: number; y: number; z: number; rot: number }[] = [];
  for (const mk of stage.markers) {
    if (mk.kind !== 'km' && mk.kind !== 'board') continue;
    const p = stage.pointAt(mk.s);
    const side = mk.side || 1;
    const d = tr.edge2 + 0.9;
    const x = p.x + p.rx * d * side, z = p.z + p.rz * d * side;
    const y = stage.height(x, z);
    const isKm = mk.kind === 'km';
    const c = isKm ? signCanvas(mk.text, 256, 160, '#f4efe2', '#1b1b1b') : signCanvas(mk.text, 256, 160, '#f2c230', '#1b1b1b');
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8), lam('#ffffff', { map: canvasTex(c), side: THREE.DoubleSide }));
    sign.position.set(x, y + 1.7, z);
    sign.rotation.y = Math.atan2(-p.dx, -p.dz);
    sign.castShadow = true;
    group.add(sign);
    boardPosts.push({ x, y, z, rot: sign.rotation.y });
  }

  // ---- spectator tape (posts + striped tape) ----
  const posts: THREE.Vector3[] = [];
  const tapePos: number[] = [], tapeUv: number[] = [], tapeIdx: number[] = [];
  for (const t of stage.tape) {
    let first = true, u = 0, prev: THREE.Vector3 | null = null;
    for (let s = t.s0; s <= t.s1; s += 3.5) {
      const p = stage.pointAt(s);
      const x = p.x + p.rx * t.d * t.side, z = p.z + p.rz * t.d * t.side;
      const y = stage.height(x, z);
      const v = new THREE.Vector3(x, y, z);
      posts.push(v);
      if (prev) u += prev.distanceTo(v);
      const b = tapePos.length / 3;
      tapePos.push(x, y + 1.0, z, x, y + 0.88, z);
      tapeUv.push(u / 1.2, 1, u / 1.2, 0);
      if (!first) tapeIdx.push(b - 2, b, b - 1, b - 1, b, b + 1);
      first = false;
      prev = v;
    }
  }
  if (posts.length) {
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.04, 1.15, 5).translate(0, 0.575, 0), lam('#e8e2d4'), posts.length);
    const m4 = new THREE.Matrix4();
    posts.forEach((p, i) => im.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
    im.computeBoundingSphere();
    group.add(im);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tapePos, 3));
    tg.setAttribute('uv', new THREE.Float32BufferAttribute(tapeUv, 2));
    tg.setIndex(tapeIdx);
    tg.computeVertexNormals();
    group.add(new THREE.Mesh(tg, lam('#ffffff', { map: stripeTexture(), side: THREE.DoubleSide })));
  }

  // ---- scenery models + textured boards, merged per chunk ----
  const nC = Math.ceil(stage.cl.length / PROP_CHUNK);
  const vAcc = Array.from({ length: nC }, () => new Acc());
  const tAcc = Array.from({ length: nC }, () => new Acc());
  const chunkOf = (p: Prop) => Math.min(nC - 1, Math.max(0, Math.floor(Math.max(0, stage.corridor.sAt(p.x, p.z)) / PROP_CHUNK)));
  const white = C('#ffffff'), postC = C('#4a4038');
  const crowd: Prop[] = [];
  const poles: Prop[] = [];
  for (const b of boardPosts) {
    const c = Math.min(nC - 1, Math.max(0, Math.floor(Math.max(0, stage.corridor.sAt(b.x, b.z)) / PROP_CHUNK)));
    vAcc[c].add(cyl(0.05, 0.05, 1.7, 5, 0, 0.85, -0.05), b.x, b.y, b.z, b.rot, 1, C('#3a3a3a'));
    vAcc[c].add(box(1.34, 0.84, 0.04, 0, 1.7, -0.03), b.x, b.y, b.z, b.rot, 1, C('#d8d2c4'));
  }
  for (const p of stage.props) {
    const a = vAcc[chunkOf(p)], t = tAcc[chunkOf(p)];
    switch (p.type) {
      case 'cabin': addCabin(a, p); break;
      case 'fence': addFence(a, p); break;
      case 'hay': addHay(a, p); break;
      case 'logs': addLogs(a, p); break;
      case 'pole': addPole(a, p); poles.push(p); break;
      case 'van': addVan(a, p); break;
      case 'tower': addTower(a, p); t.add(new THREE.PlaneGeometry(3.0, 0.75).translate(0, 6.0, 1.54), p.x, p.y - 0.2, p.z, p.rot, 1, white, BANNER(hash2(Math.round(p.x), 1, 1) * 6 | 0)); break;
      case 'crowd': crowd.push(p); break;
      case 'hut': addHut(a, p); break;
      case 'tent': addTent(a, p); break;
      case 'termite': addTermite(a, p, pal); break;
      case 'rockpile': addRockpile(a, p, pal); break;
      case 'snowfence': addSnowfence(a, p); break;
      case 'snowpile': addSnowpile(a, p); break;
      case 'house': addHouse(a, p); break;
      case 'wall': addWall(a, p, pal); break;
      case 'banner': {
        // two posts + a 4×1 m sponsor panel, front facing the road
        for (const x of [-1.95, 1.95]) a.add(cyl(0.04, 0.04, 1.5, 4, x, 0.75, 0), p.x, p.y, p.z, p.rot, 1, postC);
        t.add(new THREE.PlaneGeometry(4, 1).translate(0, 0.95, 0.03), p.x, p.y, p.z, p.rot, 1, white, BANNER(p.variant % 6));
        t.add(new THREE.PlaneGeometry(4, 1).rotateY(Math.PI).translate(0, 0.95, -0.03), p.x, p.y, p.z, p.rot, 1, C('#d9d2c2'), BANNER(p.variant % 6));
        break;
      }
      case 'arrow': {
        a.add(cyl(0.05, 0.05, 1.2, 4, -0.6, 0.6, 0), p.x, p.y, p.z, p.rot, 1, postC);
        a.add(cyl(0.05, 0.05, 1.2, 4, 0.6, 0.6, 0), p.x, p.y, p.z, p.rot, 1, postC);
        t.add(new THREE.PlaneGeometry(1.7, 0.85).translate(0, 1.35, 0.04), p.x, p.y, p.z, p.rot, 1, white, CHEVRON(p.variant));
        a.add(box(1.72, 0.87, 0.05, 0, 1.35, 0), p.x, p.y, p.z, p.rot, 1, C('#9a948a'));
        break;
      }
      case 'flag': {
        a.add(cyl(0.035, 0.05, 5.2, 5, 0, 2.6, 0), p.x, p.y, p.z, p.rot, 1, C('#e8e2d4'));
        const fg = new THREE.PlaneGeometry(1.5, 0.95, 6, 1).translate(0.75, 4.6, 0);
        t.add(fg, p.x, p.y, p.z, p.rot, 1, white, FLAG(p.variant % 4), 1);
        break;
      }
    }
  }
  // guard rails: galvanised W-beam on posts, following the road at the rail offset
  const steel = C('#b9bcc0'), steelDk = C('#7d8288');
  for (const r of stage.rails) {
    let prev: THREE.Vector3 | null = null;
    for (let s = r.s0; s <= r.s1; s += 2) {
      const p = stage.pointAt(s);
      const x = p.x + p.rx * r.d * r.side, z = p.z + p.rz * r.d * r.side;
      const y = stage.height(x, z);
      const v = new THREE.Vector3(x, y, z);
      const acc = vAcc[Math.min(nC - 1, Math.floor(s / PROP_CHUNK))];
      if (Math.round(s / 2) % 2 === 0) acc.add(box(0.1, 0.9, 0.12, 0, 0.35, 0), x, y - 0.1, z, Math.atan2(p.dx, p.dz), 1, steelDk);
      if (prev) {
        for (const [h0, h1, c] of [[0.48, 0.66, steel], [0.66, 0.78, steelDk]] as const) {
          const o = 0.06 * r.side;
          const a0 = prev.clone().add(new THREE.Vector3(p.rx * o, h0, p.rz * o)), b0 = v.clone().add(new THREE.Vector3(p.rx * o, h0, p.rz * o));
          acc.quad(a0, b0, b0.clone().setY(v.y + h1), a0.clone().setY(prev.y + h1), c);
        }
      }
      prev = v;
    }
  }

  // snow walls: orange marker poles at the road edge every ~24 m (alternating sides), a retro-reflective band near the
  // top that lights up in the headlights (render only: thin flexible poles, not obstacles)
  const wallH = stage.env.road.kind === 'snow' ? stage.terrain.wallH : null;
  if (wallH) {
    const orange = C('#e8681e'), band = C('#f4f1ea');
    let k = 0;
    for (let s = 40; s < stage.cl.length - 40; s += 24, k++) {
      const wh = wallH[Math.min(wallH.length - 1, Math.round(s))];
      if (wh < 0.45) continue;
      for (const side of [-1, 1]) {
        if ((k + (side > 0 ? 1 : 0)) % 2 && hash2(k, side, 77) < 0.75) continue;
        const p = stage.pointAt(s + (side > 0 ? 9 : 0));
        const d = (stage.terrain.edge1 + 0.25) * side;
        const x = p.x + p.rx * d, z = p.z + p.rz * d;
        const y = stage.height(x, z) - 0.2;
        const acc = vAcc[Math.min(nC - 1, Math.floor(s / PROP_CHUNK))];
        const lean = (hash2(k, side, 78) - 0.5) * 0.12;
        acc.add(cyl(0.022, 0.026, 2.3, 5, 0, 1.15, 0).rotateZ(lean), x, y, z, 0, 1, orange);
        const n0 = acc.wave.length;
        acc.add(cyl(0.03, 0.03, 0.22, 5, 0, 1.95, 0).rotateZ(lean), x, y, z, 0, 1, band);
        for (let i = n0; i < acc.wave.length; i++) acc.wave[i] = -1;
      }
    }
  }

  // power line wires between consecutive poles (sagging, thin)
  poles.sort((a, b) => stage.corridor.sAt(a.x, a.z) - stage.corridor.sAt(b.x, b.z));
  const wireC = C('#2b2a2e');
  for (let i = 1; i < poles.length; i++) {
    const a = poles[i - 1], b = poles[i];
    if (Math.hypot(a.x - b.x, a.z - b.z) > 70) continue;
    const acc = vAcc[chunkOf(a)];
    for (const off of [-0.75, 0.75]) {
      const ra = new THREE.Vector3(Math.cos(a.rot) * off, 0, -Math.sin(a.rot) * off), rb = new THREE.Vector3(Math.cos(b.rot) * off, 0, -Math.sin(b.rot) * off);
      const N = 8;
      for (let k = 0; k < N; k++) {
        const u0 = k / N, u1 = (k + 1) / N;
        const pt = (u: number) => new THREE.Vector3(a.x + (b.x - a.x) * u, a.y - 0.3 + 8.65 + (b.y - a.y) * u - Math.sin(Math.PI * u) * 1.1, a.z + (b.z - a.z) * u).add(ra.clone().lerp(rb, u));
        const p0 = pt(u0), p1 = pt(u1);
        acc.quad(p0, p1, p1.clone().setY(p1.y + 0.035), p0.clone().setY(p0.y + 0.035), wireC);
      }
    }
  }
  const vMat = posterVcol('props', { side: THREE.DoubleSide }, { retro: true });
  const crowdAspect = new THREE.Vector4(1, 0.74, 1.13, 1.25);
  const atlas = buildAtlas(stage.env.art, (i, asp) => { if (i >= 0) crowdAspect.setComponent(i, asp); });
  const tMat = posterize(new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, side: THREE.FrontSide, alphaTest: 0.5 }), {
    key: 'boards',
    edit: (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWave;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
if (aWave > 0.0) {
  float ph = uTime * 5.0 - position.x * 2.4 + (modelMatrix[3].x + position.z) * 0.05;
  transformed.z += sin(ph) * 0.16 * aWave;
  transformed.y += sin(ph * 0.7) * 0.05 * aWave;
}`);
    },
  });
  tMat.side = THREE.DoubleSide;
  for (let c = 0; c < nC; c++) {
    if (!vAcc[c].empty) { const m = new THREE.Mesh(vAcc[c].geometry(), vMat); m.castShadow = true; m.receiveShadow = true; m.name = `props-${c}`; group.add(m); }
    if (!tAcc[c].empty) { const m = new THREE.Mesh(tAcc[c].geometry(), tMat); m.castShadow = true; m.receiveShadow = true; m.name = `boards-${c}`; group.add(m); }
  }

  // ---- spectators ----
  let crowdMat: THREE.ShaderMaterial | null = null;
  if (crowd.length) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    const aPos = new Float32Array(crowd.length * 4), aInfo = new Float32Array(crowd.length * 4);
    crowd.forEach((p, i) => {
      // cells are square with the cut-out bottom-aligned and scaled to fit: quad side = people height × max(1, aspect)
      const side = 2.05 * p.scale;
      aPos.set([p.x, p.y - 0.05, p.z, hash2(i, 7, 3) * 6.28], i * 4);
      aInfo.set([side, side, p.variant % 4, p.rot], i * 4);
    });
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 4));
    geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 4));
    geo.instanceCount = crowd.length;
    crowdMat = new THREE.ShaderMaterial({
      uniforms: { tAtlas: { value: atlas }, uTime: LOOK.uTime, uCar: { value: new THREE.Vector3(0, -1e5, 0) }, uShade: { value: pal.look.shadowTint.clone() }, uAspect: { value: crowdAspect }, uLight: { value: STYLE_LIGHT } },
      vertexShader: /* glsl */ `
        attribute vec4 aPos; attribute vec4 aInfo;
        uniform float uTime; uniform vec3 uCar; uniform vec4 uAspect;
        varying vec2 vUv; varying float vY;
        void main(){
          vec3 c = aPos.xyz;
          float cellI = aInfo.z;
          float asp = cellI < 0.5 ? uAspect.x : cellI < 1.5 ? uAspect.y : cellI < 2.5 ? uAspect.z : uAspect.w;
          vec2 sz = aInfo.xy * max(1.0, asp);
          // face the camera, but never turn more than ~50° away from facing the road (no edge-on cut-outs)
          vec3 toCam = normalize(vec3(cameraPosition.x - c.x, 0.0, cameraPosition.z - c.z));
          vec3 road = vec3(sin(aInfo.w), 0.0, cos(aInfo.w));
          vec3 f = normalize(mix(road, toCam, 0.6));
          vec3 right = vec3(f.z, 0.0, -f.x);
          float near = 1.0 - smoothstep(25.0, 90.0, distance(uCar.xz, c.xz));
          float ph = aPos.w + uTime * (3.0 + 5.0 * near);
          float hop = max(0.0, sin(ph)) * (0.03 + 0.17 * near);
          float sway = sin(ph * 0.5) * (0.015 + 0.04 * near);
          vec3 p = c + right * (position.x * sz.x + sway * position.y * sz.y) + vec3(0.0, position.y * sz.y + hop, 0.0);
          float cell = aInfo.z;
          vUv = vec2((cell * 512.0 + 2.0 + uv.x * 508.0) / 2048.0, 1.0 - (1024.0 + 2.0 + (1.0 - uv.y) * 508.0) / 2048.0);
          vY = uv.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tAtlas; uniform vec3 uShade; uniform float uLight; varying vec2 vUv; varying float vY;
        void main(){
          vec4 c = texture2D(tAtlas, vUv);
          if (c.a < 0.5) discard;
          vec3 col = mix(uShade * dot(c.rgb, vec3(0.6)), c.rgb, 0.82 + 0.18 * vY) * uLight;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(geo, crowdMat);
    mesh.frustumCulled = false;
    mesh.name = 'crowd';
    group.add(mesh);
  }

  return {
    group,
    update(_time: number, carPos: THREE.Vector3) {
      if (crowdMat) crowdMat.uniforms.uCar.value.copy(carPos);
    },
  };
}
