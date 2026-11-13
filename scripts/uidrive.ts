// Headless browser helpers for the menu tools (uishots, smoke): keyboard driving, screen waits, JPEG shots, error log.
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { CHROME_ARGS, PORT } from './server';

/** Production build served by scripts/serve.mjs — the same server ./play.sh uses, no HMR, so other tasks' edits cannot
 *  reload the page mid-run — on its own port (smoke 5223, uishots 5224; never the user's 5198 / 5199).
 *  DUSTMARK_PORT=<port> with a server already up there: use that one instead (no build). `dir`: serve an existing
 *  build directory instead of building. Returns a stop function. */
export async function ensurePreview(port = 5223, dir?: string): Promise<() => void> {
  const env = process.env.DUSTMARK_PORT ? Number(process.env.DUSTMARK_PORT) : 0;
  const up = async (p: number) => { try { return (await fetch(`http://localhost:${p}/`)).ok; } catch { return false; } };
  if (env && await up(env)) { console.log(`using the server on :${env} (DUSTMARK_PORT)`); return () => {}; }
  if (env) port = env;
  if (port === 5198 || port === 5199) throw new Error(`port ${port} belongs to play.sh / play-stable.sh`);
  if (await up(port)) throw new Error(`port ${port} is already in use by another server — stop it or set DUSTMARK_PORT`);
  const out = dir ?? `node_modules/.cache/dustmark-preview-${port}`;
  if (!dir) {
    console.log('building (no HMR) …');
    execSync(`npx vite build --outDir ${out} --emptyOutDir --logLevel error`, { stdio: 'inherit' });
  }
  const child = spawn('node', ['scripts/serve.mjs', '--dir', out, '--port', String(port), '--https-port', String(port + 1000), '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 150 && !exited && !(await up(port)); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await up(port))) { child.kill('SIGTERM'); throw new Error(`build server on :${port} did not start`); }
  process.env.DUSTMARK_PORT = String(port);
  return () => { child.kill('SIGTERM'); };
}

export interface Ui {
  browser: Browser;
  page: Page;
  errors: string[];
  key(k: string, times?: number, gap?: number): Promise<void>;
  screen(): Promise<string>;
  waitScreen(name: string | RegExp, timeout?: number): Promise<void>;
  shot(path: string): Promise<void>;
  wait(ms: number): Promise<void>;
  eval<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
}

export async function openUi(query: string, size = { width: 1600, height: 900 }, opts: { browser?: Browser; storage?: string } = {}): Promise<Ui> {
  const browser = opts.browser ?? await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
    else if (m.text().startsWith('[dustmark]')) console.log('   ', m.text());
  });
  if (opts.storage) await page.addInitScript((s) => { if (!sessionStorage.getItem('__seeded')) { localStorage.clear(); for (const [k, v] of Object.entries(JSON.parse(s))) localStorage.setItem(k, String(v)); sessionStorage.setItem('__seeded', '1'); } }, opts.storage);
  await page.goto(`http://localhost:${process.env.DUSTMARK_PORT ?? PORT}/?${query}`);
  await page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
  const ui: Ui = {
    browser, page, errors,
    async key(k, times = 1, gap = 90) { for (let i = 0; i < times; i++) { await page.keyboard.press(k); await page.waitForTimeout(gap); } },
    async screen() { return page.evaluate(() => (window as any).__screen ?? ''); },
    async waitScreen(name, timeout = 30_000) {
      const src = typeof name === 'string' ? `^${name}$` : name.source;
      await page.waitForFunction((re) => new RegExp(re).test((window as any).__screen ?? ''), src, { timeout });
      await page.waitForTimeout(650); // wipe out + art fade
    },
    async shot(path) { mkdirSync(dirname(path), { recursive: true }); await page.screenshot({ path, type: 'jpeg', quality: 86 }); console.log('  shot', path); },
    async wait(ms) { await page.waitForTimeout(ms); },
    async eval(fn) { return page.evaluate(fn); },
    async close() { await ctx.close(); if (!opts.browser) await browser.close(); },
  };
  return ui;
}
