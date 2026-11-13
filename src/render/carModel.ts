// Parametric rally car (see src/render/car/*): one generator builds all six cars from src/data/carVisuals.ts.
// Model space: x right, y up (y=0 is the ground at rest), -z forward; `root` sits at the CG like the physics body.
//
// Draw calls per car: body shell (1) + glass (1) + wheels (1, instanced ×4) + calipers (1, instanced ×4)
// + night light pod (1, hidden unless switched on) — plus shadow passes for shell, glass, wheels, pod.
//
// Runtime interface (all optional for callers):
//   setBrake(0..1)        brake lights; until called, the model infers braking from its own deceleration
//   setLights(head, pod)  headlights / light-pod glow 0..1 (night stages)
//   setLightPod(on)       show/hide the 4-lamp pod
//   setDirt(0..1, color)  mud/dust on the lower body; until called, dirt builds up with distance driven
//   addDirt(metres, k)    accumulate dirt by distance on a surface with looseness k (0 tarmac … 1 mud)
import * as THREE from 'three';
import type { CarSpec } from '../data/cars';
import { carVisual, type CarFrame, type CarVisual, type LiveryDef } from '../data/carVisuals';
import { buildBody, type BodyColors } from './car/body';
import { col, MeshBuilder } from './car/builder';
import { decalsReady, loadDecals, paintLivery } from './car/livery';
import { bodyMaterial, glassMaterial, makeUniforms, wheelMaterial, type CarUniforms } from './car/material';
import { buildParts, type PartSurfs } from './car/parts';
import { makeShape, type Shape } from './car/shape';
import { buildCaliperGeometry, buildWheelGeometry } from './car/wheels';

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean; left: boolean }[];
  frontZ: number; rearZ: number;
  visual: CarVisual;
  livery: LiveryDef;
  lightPod: THREE.Mesh;
  uniforms: CarUniforms;
  stats: { triangles: number; drawCalls: number; shadowCalls: number };
  setBrake(v: number): void;
  setLights(head: number, pod?: number): void;
  setLightPod(on: boolean): void;
  setDirt(amount: number, color?: THREE.ColorRepresentation): void;
  addDirt(metres: number, looseness?: number, color?: THREE.ColorRepresentation): void;
  dispose(): void;
}

export interface CarBuildOptions {
  /** 0 = full, 1 = simplified (ghost car / replay far shots) */
  lod?: 0 | 1;
}

if (typeof document !== 'undefined') void loadDecals();
/** resolves when the sponsor decal atlas is loaded (cars built earlier repaint themselves anyway) */
export const preloadCarAssets = () => loadDecals();

export function frameOf(spec: CarSpec | undefined, vis: CarVisual): CarFrame {
  if (!spec) return vis.frame;
  return { wheelbase: spec.wheelbase, frontWeight: spec.frontWeight, trackF: spec.trackF, trackR: spec.trackR, wheelR: spec.wheel.radius, wheelW: spec.wheel.width, cgHeight: spec.cgHeight };
}

export interface CarGeometry {
  shape: Shape; body: THREE.BufferGeometry; glass: THREE.BufferGeometry; pod: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry; caliper: THREE.BufferGeometry; triangles: number;
}

/** geometry only (no DOM): used by buildCarModel and by the Node tests */
export function buildCarGeometry(vis: CarVisual, frame: CarFrame, L: LiveryDef, lod = 0): CarGeometry {
  const S = makeShape(vis, frame);
  const body = new MeshBuilder(), glass = new MeshBuilder(), pod = new MeshBuilder();
  const C: BodyColors = {
    body: { c: col('#ffffff'), paint: 1 },
    frame: { c: col('#17181a') },
    dark: { c: col('#101010') },
    under: { c: col('#19191a') },
    trim: { c: col('#202022') },
    interior: { c: col('#1d1e21') },
    glass: { c: col('#1b252c') },
    cage: { c: col('#d3cdc0') },
    helmets: [col(L.c1 === L.base ? L.c2 : L.c1), col('#f2ede1')],
  };
  buildBody(S, body, glass, C, lod);
  const P: PartSurfs = { body: C.body, trim: { c: col(L.trim) }, dark: { c: col('#151516') }, chrome: { c: col('#d9dad6') }, base: { c: col(L.base) }, frame: C.frame };
  buildParts(S, body, pod, L, P, lod);
  const wheel = buildWheelGeometry(vis, L, frame.wheelR, frame.wheelW, lod);
  const caliper = buildCaliperGeometry(vis, frame.wheelR, frame.wheelW);
  const g = { shape: S, body: body.build(), glass: glass.build(), pod: pod.build(), wheel, caliper, triangles: 0 };
  g.triangles = body.triangles + glass.triangles + (wheel.attributes.position.count / 3) * 4 + (lod ? 0 : (caliper.attributes.position.count / 3) * 4);
  return g;
}

export function buildCarModel(spec: CarSpec | string, liveryIdx = 0, opts: CarBuildOptions = {}): CarModel {
  const lod = opts.lod ?? 0;
  const vis = carVisual(typeof spec === 'string' ? spec : spec.id);
  const frame = frameOf(typeof spec === 'string' ? undefined : spec, vis);
  const L = vis.liveries[((liveryIdx % vis.liveries.length) + vis.liveries.length) % vis.liveries.length];
  const G = buildCarGeometry(vis, frame, L, lod);
  const S = G.shape;

  // livery texture
  let tex: THREE.CanvasTexture | null = null;
  if (typeof document !== 'undefined') {
    const cv = document.createElement('canvas');
    let out = cv;
    const paint = (a: ReturnType<typeof decalsReady>) => {
      paintLivery(cv, S, L, a);
      if (lod) {
        out.width = cv.width / 2; out.height = cv.height / 2;
        out.getContext('2d')!.drawImage(cv, 0, 0, out.width, out.height);
      }
    };
    if (lod) out = document.createElement('canvas');
    paint(decalsReady());
    tex = new THREE.CanvasTexture(out);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    if (!decalsReady()) void loadDecals().then((a) => { if (a && tex) { paint(a); tex.needsUpdate = true; } });
  }
  const U = makeUniforms(S, tex);
  const bodyMat = bodyMaterial(U), glassMat = glassMaterial(U), wheelMat = wheelMaterial(U), calMat = wheelMaterial(U, true);

  const root = new THREE.Group();
  root.name = `car:${vis.id}`;
  const body = new THREE.Group();
  body.position.y = -frame.cgHeight;
  root.add(body);
  const shell = new THREE.Mesh(G.body, bodyMat);
  shell.castShadow = true; shell.receiveShadow = true;
  const glass = new THREE.Mesh(G.glass, glassMat);
  glass.castShadow = true; glass.renderOrder = 2;
  const pod = new THREE.Mesh(G.pod, bodyMat);
  pod.castShadow = true; pod.visible = vis.parts.lightPod;
  body.add(shell, glass, pod);

  // wheels: pivot/spin groups keep the M1 interface (view.updateCar moves them); instanced meshes follow them
  const wheels: CarModel['wheels'] = [];
  const zF = S.zF, zR = S.zR;
  for (let i = 0; i < 4; i++) {
    const front = i < 2, left = i % 2 === 0;
    const pivot = new THREE.Group(), spin = new THREE.Group();
    pivot.add(spin);
    const track = front ? frame.trackF : frame.trackR;
    pivot.position.set((left ? -1 : 1) * track / 2, frame.wheelR - frame.cgHeight, front ? zF : zR);
    root.add(pivot);
    wheels.push({ pivot, spin, front, left });
  }
  const wheelMesh = new THREE.InstancedMesh(G.wheel, wheelMat, 4);
  const calMesh = new THREE.InstancedMesh(G.caliper, calMat, 4);
  wheelMesh.castShadow = true; wheelMesh.receiveShadow = true;
  wheelMesh.frustumCulled = false; calMesh.frustumCulled = false;
  root.add(wheelMesh);
  if (!lod) root.add(calMesh);
  const flipY = new THREE.Matrix4().makeRotationY(Math.PI), mirX = new THREE.Matrix4().makeScale(-1, 1, 1);
  const tmp = new THREE.Matrix4();
  const syncWheels = () => {
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      tmp.copy(w.pivot.matrix);
      tmp.multiply(w.spin.matrix);
      if (w.left) tmp.multiply(flipY);
      wheelMesh.setMatrixAt(i, tmp);
      tmp.copy(w.pivot.matrix);
      if (w.left) tmp.multiply(mirX);
      calMesh.setMatrixAt(i, tmp);
    }
    wheelMesh.instanceMatrix.needsUpdate = true;
    calMesh.instanceMatrix.needsUpdate = true;
  };
  for (const w of wheels) { w.pivot.updateMatrix(); w.spin.updateMatrix(); }
  syncWheels();
  wheelMesh.onBeforeRender = syncWheels;
  wheelMesh.onBeforeShadow = syncWheels;

  // self-driven bits: mudflap swing, inferred brake lights, distance dirt (until a caller takes over)
  let brakeExplicit = false, dirtExplicit = false, dirtAmt = 0, last = -1;
  const prevPos = new THREE.Vector3(), prevVel = new THREE.Vector3(), pos = new THREE.Vector3(), vel = new THREE.Vector3(), fwd = new THREE.Vector3();
  const flapAng = [0, 0, 0, 0], flapVel = [0, 0, 0, 0];
  let decel = 0, havePrev = false;
  shell.onBeforeRender = () => {
    const now = performance.now() / 1000;
    const dt = last < 0 ? 0 : Math.min(0.1, now - last);
    last = now;
    pos.setFromMatrixPosition(root.matrixWorld);
    if (!havePrev || dt <= 0) { prevPos.copy(pos); havePrev = true; return; }
    vel.subVectors(pos, prevPos).divideScalar(dt);
    if (vel.length() > 120) vel.set(0, 0, 0); // teleport / reset
    fwd.set(0, 0, -1).transformDirection(root.matrixWorld);
    const speed = vel.dot(fwd);
    const acc = (speed - prevVel.dot(fwd)) / dt;
    const vy = (vel.y - prevVel.y) / dt;
    prevPos.copy(pos); prevVel.copy(vel);
    decel += (-acc - decel) * Math.min(1, dt * 8);
    if (!brakeExplicit) U.uLights.value.x = decel > 3.5 && Math.abs(speed) > 1.5 ? 1.4 : 0.35;
    if (!dirtExplicit) { dirtAmt = Math.min(0.6, dirtAmt + (Math.abs(speed) * dt) / 3500); U.uDirt.value = dirtAmt; }
    // flaps: trail back with speed, kick with vertical jolts and braking
    for (let i = 0; i < 4; i++) {
      const target = Math.min(0.55, Math.abs(speed) * 0.012) + Math.sin(now * (9 + i * 1.7) + i) * Math.min(0.05, Math.abs(speed) * 0.002);
      const f = (target - flapAng[i]) * 60 - flapVel[i] * 7 + vy * 0.25 + acc * 0.04;
      flapVel[i] += f * dt; flapAng[i] += flapVel[i] * dt;
      flapAng[i] = Math.max(-0.35, Math.min(0.9, flapAng[i]));
    }
    U.uFlap.value.set(flapAng[0], flapAng[1], flapAng[2], flapAng[3]);
  };

  const tris = G.triangles;
  const model: CarModel = {
    root, body, wheels, frontZ: zF, rearZ: zR, visual: vis, livery: L, lightPod: pod, uniforms: U,
    stats: { triangles: tris, drawCalls: lod ? 3 : 4, shadowCalls: 3 },
    setBrake(v) { brakeExplicit = true; U.uLights.value.x = 0.35 + Math.max(0, Math.min(1, v)) * 1.05; },
    setLights(head, podLevel = head) { U.uLights.value.y = 0.06 + head * 1.6; U.uLights.value.z = podLevel * 2.0; },
    setLightPod(on) { pod.visible = on; model.stats.drawCalls = (lod ? 3 : 4) + (on ? 1 : 0); model.stats.shadowCalls = 3 + (on ? 1 : 0); },
    setDirt(amount, color) { dirtExplicit = true; dirtAmt = Math.max(0, Math.min(1, amount)); U.uDirt.value = dirtAmt; if (color !== undefined) U.uDirtColor.value.set(color); },
    addDirt(metres, looseness = 0.6, color) {
      dirtExplicit = true;
      dirtAmt = Math.min(0.95, dirtAmt + (metres * (0.15 + looseness)) / 3000);
      U.uDirt.value = dirtAmt;
      if (color !== undefined) U.uDirtColor.value.lerp(new THREE.Color(color), Math.min(1, metres / 200));
    },
    dispose() {
      for (const g of [G.body, G.glass, G.pod, G.wheel, G.caliper]) g.dispose();
      for (const m of [bodyMat, glassMat, wheelMat, calMat]) m.dispose();
      tex?.dispose();
    },
  };
  model.setLightPod(pod.visible);
  return model;
}
