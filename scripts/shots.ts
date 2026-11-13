// npm run shots -- <name> "<url query>" [--wait ms] [--size 1600x900] [--dir docs/screenshots/m1] [--eval js]
// Headless Chrome on the Apple GPU → JPEG (PNG of a full frame can exceed the CDP message limit).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [name = 'shot', query = ''] = pos;
const wait = +(opt('wait', '1500')!);
const [W, H] = opt('size', '1600x900')!.split('x').map(Number);
const dir = opt('dir', 'docs/screenshots')!;
const js = opt('eval');
// --dpr 2: simulate the Retina screen (the game renders at devicePixelRatio × render scale)
const dpr = +(opt('dpr', '1')!);

const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (m.text().startsWith('[dustmark]')) console.log(m.text()); });
  await page.goto(`${BASE}/?${query}`);
  await page.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
  if (js) await page.evaluate(js);
  await page.waitForTimeout(wait);
  const gpu = await page.evaluate(() => (window as any).__game?.view?.gpuName ?? (() => { const c = document.createElement('canvas').getContext('webgl2')!; const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })());
  const out = `${dir}/${name}.jpg`;
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: 'jpeg', quality: 88 });
  console.log(`saved ${out}   gpu: ${gpu}`);
  if (!/apple/i.test(String(gpu))) console.warn('WARNING: not rendering on the Apple GPU');
  if (errors.length) console.log('page errors:', errors.slice(0, 8));
} finally {
  await browser.close();
  stop();
}
