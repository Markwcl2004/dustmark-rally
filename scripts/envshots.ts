// npm run envshots -- [--dir docs/screenshots/m2/env] [--only name,name] [--size 1600x900]
// Batch of scene screenshots for reviewing the environment art: one headless Chrome (Apple GPU), one page per view.
// Views are listed below as name → URL query (+ optional JS run before the capture and extra wait).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const dir = opt('dir', 'docs/screenshots/m2/env');
const only = opt('only', '').split(',').filter(Boolean);
const [W, H] = opt('size', '1600x900').split('x').map(Number);
// --dpr 2: simulate the Retina screen
const dpr = +opt('dpr', '1');

interface View { name: string; q: string; js?: string; wait?: number }
const V: View[] = [
  { name: '01-village-start', q: 's=-20&hud=0&pause=1&cam=far' },
  { name: '02-village-crowd', q: 's=140&hud=0&pause=1&cam=far' },
  { name: '03-forest-tunnel', q: 's=520&hud=0&pause=1&cam=far' },
  { name: '04-forest-crest', q: 's=760&hud=0&pause=1&cam=far' },
  { name: '05-logging', q: 's=1230&hud=0&pause=1&cam=far' },
  { name: '06-logging-yard', q: 's=1520&hud=0&pause=1&cam=far' },
  { name: '07-birch', q: 's=1840&hud=0&pause=1&cam=far' },
  { name: '08-birch-2', q: 's=2120&hud=0&pause=1&cam=far' },
  { name: '09-lake', q: 's=2470&hud=0&pause=1&cam=far' },
  { name: '10-lake-2', q: 's=2700&hud=0&pause=1&cam=far' },
  { name: '11-hairpin', q: 's=3010&hud=0&pause=1&cam=far' },
  { name: '12-moor', q: 's=3640&hud=0&pause=1&cam=far' },
  { name: '13-moor-2', q: 's=3900&hud=0&pause=1&cam=far' },
  { name: '14-village-finish', q: 's=4560&hud=0&pause=1&cam=far' },
  { name: '20-tv-lake', q: 's=2470&v=110&hud=0&cam=tv&tvs=2575&tvd=13&tvh=2.5&bot=1', wait: 3200 },
  { name: '21-tv-village', q: 's=30&v=80&hud=0&cam=tv&tvs=95&tvd=-10&tvh=3.5&bot=1', wait: 2600 },
  { name: '22-tv-forest-dust', q: 's=600&v=120&hud=0&cam=tv&tvs=680&tvd=10&tvh=4&bot=1', wait: 2600 },
  { name: '23-hairpin-drift', q: 's=2985&v=75&hud=0&cam=tv&tvs=3062&tvd=15&tvh=4&bot=1', wait: 3600 },
  { name: '24-jump-logging', q: 's=1200&v=125&hud=0&bot=1&cam=tv&tvs=1318&tvd=13&tvh=2.2', wait: 3000 },
  { name: '25-crowd', q: 's=1265&hud=0&pause=1&cam=far' },
  { name: '26-drift-chase', q: 's=2990&v=75&hud=0&cam=near&bot=1', wait: 3300 },
  { name: '27-jump-moor', q: 's=3590&v=130&hud=0&bot=1&cam=tv&tvs=3712&tvd=-13&tvh=2.5', wait: 2900 },
];

const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
mkdirSync(dir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  for (const v of V) {
    if (only.length && !only.some((o) => v.name.includes(o))) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(`${BASE}/?${v.q}`);
        await page.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
        if (v.js) await page.evaluate(v.js);
        await page.waitForTimeout(v.wait ?? 700);
        const ok = await page.evaluate(() => !!(window as any).__game);
        if (!ok) throw new Error('page reloaded');
        await page.screenshot({ path: `${dir}/${v.name}.jpg`, type: 'jpeg', quality: 86 });
        console.log('saved', `${dir}/${v.name}.jpg`);
        break;
      } catch (e) { console.log('retry', v.name, (e as Error).message.slice(0, 80)); }
    }
  }
} finally {
  await browser.close();
  stop();
}
