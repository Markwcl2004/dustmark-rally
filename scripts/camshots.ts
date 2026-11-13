// npm run camshots -- <outdir> <name> "<query>" [waitMs]  — headless screenshot + chase-camera framing numbers (car height share, horizon line)
import { chromium } from 'playwright';
import { BASE, CHROME_ARGS, ensureServer } from './server';
const [outdir, name, query, wait = '2500'] = process.argv.slice(2);
const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await page.goto(`${BASE}/?${query}`);
  await page.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
  await page.waitForTimeout(+wait);
  const m = await page.evaluate(() => {
    const g = (window as any).__game; const cam = g.view.chase.cam; const car = g.view.car.root;
    const THREE = (window as any).__THREE;
    const box = new (cam.position.constructor as any)();
    // project car bbox corners (spec dims around CG)
    const spec = g.world.car.spec; const L = spec.dims.length / 2, W = spec.dims.width / 2, h0 = -spec.cgHeight, h1 = spec.dims.height - spec.cgHeight;
    let ymin = 9, ymax = -9;
    for (const x of [-W, W]) for (const y of [h0, h1]) for (const z of [-L, L]) {
      const v = box.set(x, y, z).applyMatrix4(car.matrixWorld).project(cam); ymin = Math.min(ymin, v.y); ymax = Math.max(ymax, v.y);
    }
    const dir = box.set(0, 0, -1).applyQuaternion(cam.quaternion); dir.y = 0; dir.normalize();
    const far = cam.position.clone().addScaledVector(dir, 5000); far.y = cam.position.y;
    const hz = far.project(cam).y;
    const cf = box.set(0, 0, -1).applyQuaternion(car.quaternion);
    const van = cam.position.clone().addScaledVector(cf, 5000).project(cam).y;
    const dist = cam.position.distanceTo(car.position), eyeUp = cam.position.y - car.position.y;
    return { carFrac: (ymax - ymin) / 2, carTop: (1 - ymax) / 2, carBottom: (1 - ymin) / 2, horizonFromTop: (1 - hz) / 2, roadVanishFromTop: (1 - van) / 2, dist, eyeUp, fov: cam.fov, kmh: g.world.car.speed * 3.6, pushed: g.view.chase.dbg.pushed, surge: g.view.chase.dbg.surge, tgt: g.view.chase.dbg.tgt, act: g.view.chase.dbg.act, dt: g.view.chase.dbg.dt };
  });
  await page.screenshot({ path: `${outdir}/${name}.jpg`, type: 'jpeg', quality: 85 });
  console.log(name, JSON.stringify(m), errors.slice(0, 5).join(' | '));
} finally { await browser.close(); stop(); }
