// Car review page.
//   ?view=car&car=<id>[&livery=n&angle=deg&elev=deg&dist=m&dirt=0..1&lod=1&pod=1&night=1&brake=1&steer=deg]
//   ?view=lineup[&livery=n&angle=deg&elev=deg]   — all six cars side by side
// Any car in src/data/carVisuals.ts can be shown, with or without a physics entry in cars.ts.
import * as THREE from 'three';
import { CARS } from '../data/cars';
import { CAR_IDS, carVisual } from '../data/carVisuals';
import { buildCarModel, frameOf, preloadCarAssets, type CarModel } from '../render/carModel';
import { params } from './params';

const q = new URLSearchParams(location.search);
const qn = (k: string, d: number) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : d);

function makeModel(id: string, livery: number): CarModel {
  const spec = CARS[id];
  const m = buildCarModel(spec ?? id, livery, { lod: q.get('lod') === '1' ? 1 : 0 });
  const f = frameOf(spec, m.visual);
  m.root.position.y = f.cgHeight;
  return m;
}

export function startTurntable(canvas: HTMLCanvasElement) {
  const lineup = params.view === 'lineup';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const scene = new THREE.Scene();
  const night = q.get('night') === '1';
  scene.background = new THREE.Color(night ? '#1c2230' : '#d9d2bf');
  const cam = new THREE.PerspectiveCamera(lineup ? 30 : 32, innerWidth / innerHeight, 0.1, 200);
  const resize = () => { renderer.setSize(innerWidth, innerHeight, false); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); };
  resize();
  addEventListener('resize', resize);
  // nordic palette light: warm low sun from front-left, cool sky fill
  const sun = new THREE.DirectionalLight('#ffe0a6', (night ? 0.15 : 1.3) * Math.PI);
  sun.position.set(-6, 7, -4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const ext = lineup ? 9 : 4;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 40 });
  sun.shadow.bias = -0.0004;
  scene.add(sun, new THREE.HemisphereLight('#c7d4c9', '#6f6352', (night ? 0.15 : 0.75) * Math.PI));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(lineup ? 14 : 4.4, 96), new THREE.MeshLambertMaterial({ color: night ? '#3a3a3e' : '#c9b08c' }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const models: CarModel[] = [];
  const liv = params.livery;
  if (lineup) {
    const ids = [...CAR_IDS];
    // echelon: each car a step back and to the side, all nose-left, so every silhouette stays readable
    const gap = 2.75;
    ids.forEach((id, i) => {
      const m = makeModel(id, liv);
      const k = i - (ids.length - 1) / 2;
      m.root.position.set(k * gap, m.root.position.y, k * 0.9);
      m.root.rotation.y = 0.62;
      scene.add(m.root);
      models.push(m);
    });
  } else {
    const m = makeModel(params.car, liv);
    scene.add(m.root);
    models.push(m);
    const steer = (qn('steer', 14) * Math.PI) / 180;
    m.wheels.forEach((w) => { if (w.front) w.pivot.rotation.y = steer; });
    if (q.has('dirt')) m.setDirt(qn('dirt', 0));
    else m.setDirt(0);
    if (q.get('pod') === '1') m.setLightPod(true);
    if (q.get('pod') === '0') m.setLightPod(false);
    if (night) m.setLights(1, 1);
    m.setBrake(q.get('brake') === '1' ? 1 : 0);
  }
  for (const m of models) { m.setDirt(lineup ? 0 : m.uniforms.uDirt.value); if (!q.has('brake')) m.setBrake(0); }

  // labels
  const label = document.createElement('div');
  label.className = 'tt-label';
  if (!lineup) {
    const m = models[0], v = m.visual;
    const hp = CARS[v.id]?.target.hp ?? v.hp, mass = CARS[v.id]?.mass ?? v.mass;
    label.innerHTML = `<b>${v.name} ${v.model}</b>${v.group} · ${v.era} · ${v.drive.toUpperCase()} · ${hp} hp / ${mass} kg · 涂装 ${(liv % v.liveries.length) + 1}/${v.liveries.length}「${m.livery.name}」 · #${m.livery.number} ${m.livery.driver}/${m.livery.codriver}`;
  } else {
    label.innerHTML = `<b>尘迹拉力 · 六台赛车</b>涂装 ${(liv % 3) + 1}/3`;
  }
  document.body.appendChild(label);
  const tags: HTMLDivElement[] = [];
  if (lineup) for (const m of models) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;transform:translate(-50%,0);font:600 13px/1.3 "PingFang SC",sans-serif;color:#1b1b1b;text-align:center;letter-spacing:1px;white-space:nowrap';
    d.innerHTML = `<b style="font-size:16px">${m.visual.name}</b><br>${m.visual.model}<br><span style="opacity:.7">${m.visual.era}</span>`;
    document.body.appendChild(d);
    tags.push(d);
  }

  let a = ((params.angle ?? (lineup ? 180 : 35)) * Math.PI) / 180;
  const elevDeg = params.elev ?? (lineup ? 16 : 14);
  const elev = (elevDeg * Math.PI) / 180;
  const R = qn('dist', lineup ? 21 : 8.5);
  const lookY = lineup ? 0.45 : 0.62;
  let last = performance.now(), frames = 0, ready = false;
  void preloadCarAssets().then(() => { ready = true; });
  setTimeout(() => { ready = true; }, 4000);
  const v = new THREE.Vector3();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (params.angle === undefined && !lineup) a += ((now - last) / 1000) * 0.35;
    last = now;
    if (elevDeg >= 89.5) { cam.up.set(0, 0, -1); cam.position.set(0, R, 0.0001); cam.lookAt(0, 0, 0); }
    else {
      cam.up.set(0, 1, 0);
      cam.position.set(Math.sin(a) * Math.cos(elev) * R, lookY + Math.sin(elev) * R, Math.cos(a) * Math.cos(elev) * R);
      cam.lookAt(0, lookY, 0);
    }
    renderer.render(scene, cam);
    if (lineup) models.forEach((m, i) => {
      // below the lowest projected corner of the car's footprint
      let sx = 0, sy = -1;
      for (const [dx, dz] of [[-1, -2.3], [1, -2.3], [-1, 2.3], [1, 2.3]]) {
        v.set(dx, -m.root.position.y, dz).applyEuler(m.root.rotation).add(m.root.position).project(cam);
        sy = Math.max(sy, (1 - v.y) / 2);
      }
      v.copy(m.root.position).setY(0).project(cam); sx = (v.x + 1) / 2;
      tags[i].style.left = `${sx * innerWidth}px`;
      tags[i].style.top = `${sy * innerHeight + 4}px`;
    });
    if (ready && ++frames === 6) {
      const info = renderer.info.render;
      (window as unknown as Record<string, unknown>).__carStats = models.map((m) => ({ id: m.visual.id, ...m.stats }));
      (window as unknown as Record<string, unknown>).__renderInfo = { calls: info.calls, triangles: info.triangles };
      window.__ready = true;
    }
  };
  requestAnimationFrame(loop);
}
