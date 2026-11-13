// 3D car on a slow turntable for the garage / car pickers. One renderer for all menus, with a transparent background
// so the poster art behind shows through; it only renders while mounted, and at most at 60 fps.
import * as THREE from 'three';
import { CARS } from '../data/cars';
import { buildCarModel, frameOf, preloadCarAssets, type CarModel } from '../render/carModel';

class MenuTurntable {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private models = new Map<string, CarModel>();
  private current: CarModel | null = null;
  private host: HTMLElement | null = null;
  private raf = 0;
  private angle = 0.6;
  private last = 0;
  private ro: ResizeObserver | null = null;
  /** frame times (ms) of the last renders, for the perf check */
  frameMs: number[] = [];
  spin = 0.32;

  private ensure() {
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setPixelRatio(Math.min(2, devicePixelRatio));
    r.setClearColor(0x000000, 0);
    r.domElement.className = 'turntable-canvas';
    // warm low sun from the front-left, cool sky fill (the poster light of the stages)
    const sun = new THREE.DirectionalLight('#ffe6b8', 1.35 * Math.PI);
    sun.position.set(-5, 8, -3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 30 });
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 4;
    this.scene.add(sun, new THREE.HemisphereLight('#d5e0e6', '#6f6352', 0.8 * Math.PI));
    const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(4.2, 64), new THREE.ShadowMaterial({ opacity: 0.32 }));
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.receiveShadow = true;
    this.scene.add(shadowCatcher);
    void preloadCarAssets();
    this.renderer = r;
    return r;
  }

  /** put the turntable canvas into a container (fills it) */
  mount(host: HTMLElement) {
    const r = this.ensure();
    this.host = host;
    host.appendChild(r.domElement);
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (!this.host?.isConnected) { this.unmount(); return; }
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.angle += dt * this.spin;
      const t0 = performance.now();
      this.render();
      this.frameMs.push(performance.now() - t0);
      if (this.frameMs.length > 120) this.frameMs.shift();
    };
    this.raf = requestAnimationFrame(loop);
  }

  unmount() {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.renderer?.domElement.remove();
    this.host = null;
  }

  private resize() {
    if (!this.renderer || !this.host) return;
    const w = Math.max(1, this.host.clientWidth), hgt = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, hgt, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.cam.aspect = w / hgt;
    this.cam.updateProjectionMatrix();
  }

  /** show a car + livery (models are built once and kept) */
  show(id: string, livery: number) {
    this.ensure();
    const key = `${id}#${livery}`;
    let m = this.models.get(key);
    if (!m) {
      const spec = CARS[id];
      m = buildCarModel(spec ?? id, livery, { lod: 0 });
      const f = frameOf(spec, m.visual);
      m.root.position.y = f.cgHeight;
      m.root.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) mm.castShadow = true; });
      m.setDirt(0);
      m.setBrake(0);
      m.wheels.forEach((w) => { if (w.front) w.pivot.rotation.y = 0.24; });
      this.models.set(key, m);
      // keep memory bounded: at most 8 models
      if (this.models.size > 8) {
        const [k0, m0] = this.models.entries().next().value as [string, CarModel];
        if (m0 !== this.current) { m0.dispose(); this.models.delete(k0); }
      }
    }
    if (this.current && this.current !== m) this.scene.remove(this.current.root);
    this.current = m;
    this.scene.add(m.root);
  }

  private render() {
    const r = this.renderer!;
    const R = 8.2, el = 0.2;
    this.cam.position.set(Math.sin(this.angle) * Math.cos(el) * R, 0.55 + Math.sin(el) * R, Math.cos(this.angle) * Math.cos(el) * R);
    this.cam.lookAt(0, 0.55, 0);
    r.render(this.scene, this.cam);
  }
}

export const turntable = new MenuTurntable();
(globalThis as unknown as { __turntable: MenuTurntable }).__turntable = turntable;
