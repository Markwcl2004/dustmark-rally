// npm run tour -- [--stage north-1] [--every 200] [--cols 5] [--cam far]
// Drives the camera along the whole stage (car parked on the road every N metres), one JPEG per stop,
// then tiles them into docs/screenshots/tour-<stage>.jpg with ffmpeg for a one-page review of the road.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const stage = opt('stage', 'north-1');
const every = +opt('every', '200');
const cols = +opt('cols', '5');
const cam = opt('cam', 'far');
const out = opt('out', `docs/screenshots/m1/tour-${stage}.jpg`);
const tmp = '.shots-tmp/tour';
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
let n = 0;
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${BASE}/?stage=${stage}&cam=${cam}&hud=0&pause=1&s=0`);
  await page.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
  const len: number = await page.evaluate(() => (window as any).__game.world.stage.length);
  for (let s = 0; s <= len; s += every) {
    await page.evaluate((s) => {
      (window as any).__teleport(s, 0, 0);
      let l = document.getElementById('tour-label');
      if (!l) { l = document.createElement('div'); l.id = 'tour-label'; l.style.cssText = 'position:fixed;left:12px;top:10px;z-index:99;font:700 28px Menlo,monospace;color:#fff;background:rgba(0,0,0,.5);padding:2px 10px'; document.body.appendChild(l); }
      l.textContent = (s / 1000).toFixed(1) + ' km';
    }, s);
    await page.waitForTimeout(250);
    const f = `${tmp}/${String(n).padStart(3, '0')}.jpg`;
    await page.screenshot({ path: f, type: 'jpeg', quality: 80 });
    n++;
  }
} finally {
  await browser.close();
  stop();
}
const rows = Math.ceil(n / cols);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', `${tmp}/%03d.jpg`, '-vf', `scale=480:-1,tile=${cols}x${rows}:padding=4:color=0x1b1b1b`, '-frames:v', '1', '-q:v', '3', out]);
console.log(`${n} stops every ${every} m → ${out}`);
