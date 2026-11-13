// npm run loadtime [-- --dir dist] — load times of a production build served by scripts/serve.mjs (like ./play.sh),
// headless Chrome, 1512×982 @2x:
//   首屏到可操作  navigation start → the title screen takes keys (__screen = title, __ready)
//   菜单进赛段    the key press on 开跑 → the stage is drawn and the countdown runs (__screen = run; the colour wipes in
//                and out of the loading card are included, the stage build alone is __loadMs)
// once with a cold cache (new browser profile) and once warm (same profile, second visit). Also screenshots the
// loading card while the stage builds (docs/screenshots/m6/loading-*.jpg).
//   --dir <build dir>  serve that build (default: build into node_modules/.cache)  --port 5225
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME_ARGS } from './server';
import { ensurePreview } from './uidrive';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', '5225'));
const stop = await ensurePreview(port, args.includes('--dir') ? opt('dir', 'dist') : undefined);
const base = `http://localhost:${process.env.DUSTMARK_PORT ?? port}`;
const profile = mkdtempSync(join(tmpdir(), 'dustmark-load-'));
const rows: string[] = [];
try {
  for (const pass of ['冷缓存', '热缓存']) {
    const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: CHROME_ARGS, viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    if (pass === '冷缓存') await page.goto(`${base}/?intro=0`); // seed nothing: the profile is empty
    else await page.goto(`${base}/?intro=0`);
    // keys are taken once the colour wipe that brings the title in has finished (#wipe has no class)
    await page.waitForFunction(() => (window as any).__screen === 'title' && (window as any).__ready && !document.getElementById('wipe')?.className, null, { timeout: 60_000, polling: 20 });
    const first = await page.evaluate(() => performance.now());
    await page.waitForTimeout(300);
    // title → menu → 单赛段 → env → stage config → 开跑
    const key = async (k: string) => { await page.keyboard.press(k); await page.waitForTimeout(120); };
    const waitScreen = (n: string) => page.waitForFunction((x) => (window as any).__screen === x, n, { timeout: 60_000, polling: 100 }).then(() => page.waitForTimeout(700));
    await key('Enter'); await waitScreen('menu');
    await key('ArrowDown'); await key('Enter'); await waitScreen('single-env');
    await key('Enter'); await waitScreen('single-stage');
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press('Enter');
    // the loading card while the stage builds
    await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')!).display !== 'none', null, { timeout: 10_000, polling: 50 });
    await page.waitForTimeout(350);
    const card = await page.evaluate(() => ({ name: document.querySelector('#loading .ld-name')?.textContent ?? '', bg: getComputedStyle(document.getElementById('loading')!).backgroundImage }));
    await page.screenshot({ path: `docs/screenshots/m6/loading-${pass === '冷缓存' ? 'cold' : 'warm'}.jpg`, type: 'jpeg', quality: 80 });
    await page.waitForFunction(() => (window as any).__screen === 'run' && (window as any).__game, null, { timeout: 60_000, polling: 100 });
    // first frames drawn after the wipe
    await page.waitForFunction(() => (window as any).__game.world.session.phase === 'countdown' && (window as any).__game.frameStats().avg > 0, null, { timeout: 30_000, polling: 100 });
    const t1 = await page.evaluate(() => performance.now());
    const build = await page.evaluate(() => (window as any).__loadMs);
    rows.push(`| ${pass} | ${(first / 1000).toFixed(2)} s | ${((t1 - t0) / 1000).toFixed(2)} s | ${(build / 1000).toFixed(2)} s | 「${card.name}」 ${card.bg.includes('url(') ? card.bg.replace(/^.*\/assets\/ui\/([^")]+).*$/, '$1') : '无图'} | ${errors.length} |`);
    await ctx.close();
  }
} finally {
  stop();
  rmSync(profile, { recursive: true, force: true });
}
console.log('| 缓存 | 首屏到可操作 | 菜单进赛段（按开跑 → 倒计时画面） | 其中赛段生成+建网格 | 加载卡 | 控制台错误 |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
