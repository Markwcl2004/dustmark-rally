// npm run bench [-- --quality default|perf|high --scale 0.65 --no-dynres --size 1512x982 --dpr 2 --label x]
// Bot drives the stage for 60 s in headless Chrome on the Apple GPU (Metal ANGLE); frame-time stats → bench/results/<stamp>.json
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const params = new URLSearchParams({ bench: '1', bot: '1', hud: '1' });
params.set('quality', opt('quality', 'default')!);
if (opt('scale')) params.set('scale', opt('scale')!);
if (args.includes('--no-dynres')) params.set('dynres', '0');
if (opt('stage')) params.set('stage', opt('stage')!);
const [W, H] = opt('size', '1512x982')!.split('x').map(Number);
const dpr = +opt('dpr', '2')!;

const stop = await ensureServer();
// --uncapped: no vsync / frame-rate cap, so frame times show the real cost instead of the 60 Hz rAF clock
const uncapped = args.includes('--uncapped');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...CHROME_ARGS, ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
let result: any;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(`${BASE}/?${params}`);
  await page.waitForFunction(() => (window as any).__startBench && (window as any).__ready, null, { timeout: 90_000 });
  const loadMs = await page.evaluate(() => (window as any).__loadMs);
  await page.evaluate(() => (window as any).__startBench());
  console.log(`benchmark running (≈62 s)… page load→ready ${Date.now() - t0} ms, stage build ${Math.round(loadMs)} ms`);
  await page.waitForFunction(() => (window as any).__benchResult, null, { timeout: 180_000, polling: 1000 });
  result = await page.evaluate(() => (window as any).__benchResult);
  result.label = opt('label', '');
  result.viewport = `${W}x${H}@${dpr}`;
  result.headless = true;
  result.uncapped = uncapped;
  result.loadMs = Math.round(loadMs);
  result.consoleErrors = errors;
} finally {
  await browser.close();
  stop();
}
if (!/apple/i.test(result.gpu)) console.error(`WARNING: GPU is "${result.gpu}" — not the Apple GPU, numbers are not valid.`);
mkdirSync('bench/results', { recursive: true });
const prevFiles = readdirSync('bench/results').filter((f) => f.endsWith('.json')).sort();
const prev = prevFiles.length ? JSON.parse(readFileSync('bench/results/' + prevFiles[prevFiles.length - 1], 'utf8')) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`bench/results/${stamp}.json`, JSON.stringify(result, null, 2));
console.log(`GPU: ${result.gpu}`);
console.log(`viewport ${result.viewport}  drawing buffer ${result.resolution}  render scale ${result.renderScale}  quality ${result.quality}  dynres changes ${JSON.stringify(result.scaleChanges)}`);
const keys = ['avgMs', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'over16_7Pct', 'over50Count', 'drawCallsAvg', 'drawCallsMax', 'trianglesAvg', 'trianglesMax', 'heapMB'];
console.log('metric          now        prev');
for (const k of keys) console.log(`${k.padEnd(14)} ${String(result[k]).padStart(9)}  ${prev ? String(prev[k]).padStart(9) : '        —'}`);
console.log(`cpu: sim avg ${result.cpu.simAvgMs} ms p99 ${result.cpu.simP99Ms} ms · render submit avg ${result.cpu.renderAvgMs} ms p99 ${result.cpu.renderP99Ms} ms`);
console.log(`bot covered ${Math.round(result.distanceM)} m at ${result.avgKmh.toFixed(1)} km/h`);
console.log('longest frames:', result.longest.map((f: any) => `${f.ms}ms@${f.atS}s(sim ${f.simMs} render ${f.renderMs}${f.note ? ' ' + f.note : ''})`).join('  '));
if (result.consoleErrors?.length) console.log('console errors:', result.consoleErrors.slice(0, 5));
console.log(`\n${result.pass ? 'PASS' : 'FAIL'}: p99 ≤ 16.7 ms (+0.25 ms timer tolerance) and no frame > 50 ms   → bench/results/${stamp}.json`);
