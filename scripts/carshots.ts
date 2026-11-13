// npm run carshots -- [car ids…|all] [--livery n] [--dir docs/screenshots/m2/cars] [--only turntable|views|lineup] [--size 1600x900]
// Headless Chrome on the Apple GPU → JPEG turntable shots of each car: 30/120/210/300°, side, rear, top, + lineup.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const ALL = ['pipit', 'wren', 'heron', 'shrike', 'kestrel', 'petrel'];
const cars = !pos.length || pos[0] === 'all' ? ALL : pos;
const livery = opt('livery', '0')!;
const dir = opt('dir', 'docs/screenshots/m2/cars')!;
const only = opt('only');
const extra = opt('q', '')!;
const [W, H] = opt('size', '1600x900')!.split('x').map(Number);
mkdirSync(dir, { recursive: true });

const shots: [string, string][] = [];
for (const id of cars) {
  if (!only || only === 'turntable') for (const a of [30, 120, 210, 300]) shots.push([`${id}-${a}`, `view=car&car=${id}&livery=${livery}&angle=${a}${extra}`]);
  if (!only || only === 'views') {
    shots.push([`${id}-side`, `view=car&car=${id}&livery=${livery}&angle=90&elev=3&steer=0${extra}`]);
    shots.push([`${id}-rear`, `view=car&car=${id}&livery=${livery}&angle=0&elev=8&steer=0${extra}`]);
    shots.push([`${id}-top`, `view=car&car=${id}&livery=${livery}&angle=0&elev=90&dist=9&steer=0${extra}`]);
  }
}
if (!only || only === 'lineup') shots.push([`lineup${livery === '0' ? '' : '-' + livery}`, `view=lineup&livery=${livery}`]);

const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  for (const [name, query] of shots) {
    await page.goto(`${BASE}/?${query}`);
    await page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
    await page.waitForTimeout(300);
    const stats = await page.evaluate(() => ({ car: (window as any).__carStats, info: (window as any).__renderInfo }));
    await page.screenshot({ path: `${dir}/${name}.jpg`, type: 'jpeg', quality: 88 });
    const s = stats.car?.[0];
    console.log(`${name}.jpg  tris ${s?.triangles ?? '?'}  calls ${s?.drawCalls ?? '?'}+${s?.shadowCalls ?? '?'}sh  frame calls ${stats.info?.calls} tris ${stats.info?.triangles}`);
  }
  if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 10));
} finally {
  await browser.close();
  stop();
}
