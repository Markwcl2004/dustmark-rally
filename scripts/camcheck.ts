// npm run camcheck -- [--stages a,b] [--mode far|near] [--tv [--old <camera.ts of another version>]]
// Chase camera vs terrain, in Node: the robot drives each stage, the real ChaseCamera follows at 60 Hz, and every frame
// is checked for (a) the eye inside / under the ground and (b) the line of sight to the car crossing the terrain
// (a bank, a cutting wall, a crest). A second pass snaps the camera every 40 m (reset to road / teleport / replay seek
// = no time to settle) and checks the first frame. Prints a table; worst spots are listed with their distance.
import * as THREE from 'three';
import { CARS } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { ChaseCamera, TvDirector } from '../src/render/camera';
import { runBot } from '../src/sim/driver/run';
import type { World } from '../src/sim/world';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ids = opt('stages', 'north-3,savanna-2,snow-1,coast-2,coast-2-r,coast-1').split(',');
const mode = opt('mode', 'far') as 'far' | 'near';

const pos = new THREE.Vector3(), vel = new THREE.Vector3(), quat = new THREE.Quaternion();
function check(w: World, cam: THREE.PerspectiveCamera) {
  const st = w.stage, p = cam.position;
  // inside: under the ground at the eye, or within 0.3 m of the ground in a 1 m ring (a steep bank face that the near
  // plane would clip through)
  let ring = st.height(p.x, p.z);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) ring = Math.max(ring, st.height(p.x + dx, p.z + dz) - 0.25);
  const inside = p.y < ring + 0.3;
  let blocked = false;
  for (let f = 0.1; f < 0.92 && !blocked; f += 0.08) {
    const x = p.x + (pos.x - p.x) * f, z = p.z + (pos.z - p.z) * f, y = p.y + (pos.y + 0.5 - p.y) * f;
    if (st.height(x, z) + 0.1 > y) blocked = true;
  }
  return { inside, blocked };
}

// --tv: replay trackside cameras — how much of the run the chosen spot actually sees the car (terrain + grass +
// tree crowns / buildings, the director's own test), and how often no spot covers the car (helicopter instead)
if (args.includes('--tv')) {
  const oldPath = opt('old', '');
  const Old = oldPath ? ((await import(oldPath)) as { TvDirector: typeof TvDirector }).TvDirector : null;
  console.log(`| 赛段 | 机位数 | 看得见车 | 被挡 | 无机位（直升机） |${Old ? ' 旧版：机位 / 看得见 / 被挡 |' : ''}`);
  console.log(`|---|---|---|---|---|${Old ? '---|' : ''}`);
  for (const id of ids) {
    const def = STAGES[id];
    if (!def) continue;
    let dir: TvDirector | null = null, old: InstanceType<typeof TvDirector> | null = null;
    const c = { vis: 0, blk: 0, none: 0, n: 0, ovis: 0, oblk: 0, onone: 0 };
    let tick = 0;
    runBot(def, CARS.kestrel, 0.9, {
      onTick: (w) => {
        if (!dir) { dir = new TvDirector(w.stage); if (Old) old = new Old(w.stage) as unknown as TvDirector; }
        if (w.session.phase !== 'running' || ++tick % 12) return;
        const car = w.car, s = w.session.progressS;
        c.n++;
        const p = dir.pick(s, new THREE.Vector3(car.pos.x, car.pos.y, car.pos.z));
        if (!p) c.none++; else if (dir.sees(p, car.pos.x, car.pos.y + 0.3, car.pos.z)) c.vis++; else c.blk++;
        if (old) { const q = old.pick(s); if (!q) c.onone++; else if (dir.sees(q, car.pos.x, car.pos.y + 0.3, car.pos.z)) c.ovis++; else c.oblk++; }
      },
    });
    const pc = (x: number) => `${Math.round((x / Math.max(1, c.n)) * 100)}%`;
    console.log(`| ${id} | ${(dir as TvDirector | null)?.spots.length ?? 0} | ${pc(c.vis)} | ${pc(c.blk)} | ${pc(c.none)} |${old ? ` ${(old as TvDirector).spots.length} / ${pc(c.ovis)} / ${pc(c.oblk)} |` : ''}`);
  }
  process.exit(0);
}

const Chase = opt('old', '') ? ((await import(opt('old', ''))) as { ChaseCamera: typeof ChaseCamera }).ChaseCamera : ChaseCamera;
console.log(`| 赛段 | 帧 | 穿地/贴坡 | 视线被地形挡 | 瞬移后首帧 穿地 / 挡 | 最差位置 (m) |`);
console.log('|---|---|---|---|---|---|');
for (const id of ids) {
  const def = STAGES[id];
  if (!def) { console.log(`| ${id} | 不存在 |`); continue; }
  const cc = new Chase(16 / 9);
  cc.mode = mode;
  let frames = 0, inside = 0, blocked = 0, snaps = 0, sIn = 0, sBl = 0, lastSnap = -1e9, acc = 0;
  const bad: number[] = [];
  runBot(def, CARS.kestrel, 0.9, {
    onTick: (w) => {
      acc += 1;
      if (acc % 2) return; // 60 Hz camera
      const c = w.car;
      pos.set(c.pos.x, c.pos.y, c.pos.z); vel.set(c.vel.x, c.vel.y, c.vel.z); quat.set(c.quat.x, c.quat.y, c.quat.z, c.quat.w);
      const s = w.session.progressS - w.stage.startS;
      if (w.session.phase !== 'running') { cc.snap(); cc.update(1 / 60, pos, quat, vel, w.stage, 0); return; }
      // snap pass: every 40 m the camera starts from scratch
      if (s - lastSnap > 40) {
        lastSnap = s; snaps++;
        const sc = new Chase(16 / 9); sc.mode = mode; sc.snap(); sc.update(1 / 60, pos, quat, vel, w.stage, 0);
        const r = check(w, sc.cam);
        if (r.inside) sIn++;
        if (r.blocked) sBl++;
      }
      cc.update(1 / 60, pos, quat, vel, w.stage, 0);
      frames++;
      const r = check(w, cc.cam);
      if (r.inside) inside++;
      if (r.blocked) blocked++;
      if ((r.inside || r.blocked) && (!bad.length || s - bad[bad.length - 1] > 25)) bad.push(Math.round(s));
    },
  });
  console.log(`| ${id} | ${frames} | ${inside} | ${blocked} | ${sIn} / ${sBl}（${snaps} 次） | ${bad.slice(0, 8).join(', ') || '—'} |`);
}
