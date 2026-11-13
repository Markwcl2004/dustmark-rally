// Ghost car for the time challenge: the best run's sampled poses on a translucent low-LOD car model
// (depth pre-pass + one translucent colour pass, so overlapping body parts do not double up).
import * as THREE from 'three';
import { CARS } from '../data/cars';
import { buildCarModel } from '../render/carModel';
import { decodeGhost, sampleGhost, type GhostData, type GhostTrack } from '../sim/rally/ghost';

export class GhostCar {
  readonly root = new THREE.Group();
  readonly track: GhostTrack;
  private mat: THREE.MeshLambertMaterial;
  private p = [0, 0, 0];
  private q = [0, 0, 0, 1];

  constructor(readonly data: GhostData) {
    this.track = decodeGhost(data.data);
    this.mat = new THREE.MeshLambertMaterial({ color: '#cfe6ff', emissive: new THREE.Color('#4a7fb5'), transparent: true, opacity: 0.42, depthWrite: false });
    const depth = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true });
    const model = buildCarModel(CARS[data.car] ?? data.car, data.livery, { lod: 1 });
    model.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.root.matrixWorld).invert();
    const meshes: THREE.Mesh[] = [];
    model.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible) meshes.push(m); });
    for (const m of meshes) {
      const local = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      for (const [mat, order] of [[depth, 30], [this.mat, 31]] as const) {
        let g: THREE.Mesh;
        if ((m as THREE.InstancedMesh).isInstancedMesh) {
          const im = m as THREE.InstancedMesh;
          const n = new THREE.InstancedMesh(im.geometry, mat, im.count);
          n.instanceMatrix.copy(im.instanceMatrix);
          g = n;
        } else g = new THREE.Mesh(m.geometry, mat);
        local.decompose(g.position, g.quaternion, g.scale);
        g.renderOrder = order;
        g.frustumCulled = false;
        g.castShadow = false;
        this.root.add(g);
      }
    }
    // the LOD model's own materials / livery texture are not used
    for (const m of meshes) for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mt)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
      mt.dispose();
    }
    this.root.visible = false;
  }

  /** place at stage time t; fades out when the player's car is right on top of it */
  update(t: number, playerPos: THREE.Vector3) {
    const ok = sampleGhost(this.track, Math.max(0, t), this.p, this.q);
    this.root.visible = ok;
    if (!ok) return;
    this.root.position.set(this.p[0], this.p[1], this.p[2]);
    this.root.quaternion.set(this.q[0], this.q[1], this.q[2], this.q[3]);
    const d = this.root.position.distanceTo(playerPos);
    this.mat.opacity = 0.42 * THREE.MathUtils.smoothstep(d, 2.5, 9);
    this.root.visible = this.mat.opacity > 0.02;
  }

  dispose() { this.mat.dispose(); }
}
