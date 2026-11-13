// npm run hudshots — HUD legibility check: every environment in its brightest and darkest weather, robot driving,
// with all HUD lines filled (medal target, split vs a medal line / personal best, penalty, pace notes, key hints,
// audio hint). JPEGs to docs/screenshots/m6/hud/<stage>@<weather>.jpg (1512×982 @2x, like the MacBook screen).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { CHROME_ARGS } from './server';
import { ensurePreview } from './uidrive';

const SHOTS: [string, string, number][] = [
  ['north-1', 'clear', 600], ['north-1', 'dusk', 600], ['north-1', 'fog', 600],
  ['savanna-1', 'noon', 900], ['savanna-1', 'dust', 900], ['savanna-1', 'sunset', 900],
  ['snow-3', 'cold', 700], ['snow-3', 'snowfall', 700], ['snow-3', 'night', 700],
  ['coast-3', 'clear', 800], ['coast-3', 'night', 800],
];
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const stop = await ensurePreview(5226);
const base = `http://localhost:${process.env.DUSTMARK_PORT}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
mkdirSync('docs/screenshots/m6/hud', { recursive: true });
const errors: string[] = [];
try {
  for (const [stage, weather, s] of SHOTS) {
    if (only.length && !only.some((o) => `${stage}@${weather}`.includes(o))) continue;
    const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${stage}@${weather}: ${e.message}`));
    await page.goto(`${base}/?stage=${stage}&weather=${weather}&s=${s}&v=70&bot=1&mute=1`);
    await page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
    await page.waitForTimeout(2500);
    // fill every HUD line: medal target (from the run's own clock), a split, a penalty
    await page.evaluate(() => {
      const g = (window as any).__game;
      const t = g.world.session.time;
      g.cfg.targets = { gold: t + 150, silver: t + 160, bronze: t + 170 };
      g.compare = null; g.splitInfo = { n: 1, of: 4, delta: -0.88, label: '金牌线' };
      g.world.session.penalties = 5;
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `docs/screenshots/m6/hud/${stage}@${weather}.jpg`, type: 'jpeg', quality: 82 });
    // the slower colour on the same background
    await page.evaluate(() => { const g = (window as any).__game; g.compare = null; g.splitInfo = { n: 2, of: 4, delta: 1.37, label: '个人最好' }; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `docs/screenshots/m6/hud/${stage}@${weather}-slower.jpg`, type: 'jpeg', quality: 82, clip: { x: 456, y: 0, width: 600, height: 220 } });
    console.log('shot', `${stage}@${weather}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
if (errors.length) { console.log(errors.join('\n')); process.exitCode = 1; }
