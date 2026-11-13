// Phone wheel under a bad network, without a phone (headless Chrome, no windows):
//   serve.mjs (test ports) → game page + phone page; the phone page reaches the server through an impairing TCP proxy,
//   and the WebRTC data channel (if the build has one) is impaired in-page (RTCDataChannel.prototype.send wrapped on
//   both pages). Synthetic devicemotion turns the wheel ±40° at 0.4 Hz with the throttle held; the game page records
//   what its sim actually got every tick. Same scenarios for the old and the new code → PROGRESS table.
//
//   npx tsx scripts/phone-netsim.ts --root <repo with scripts/serve.mjs + pad/> --dir <game build> --label NAME
//        [--variant ws|http|dc|http-dc] [--scenarios clean,wifi,outage,bg,combo] [--secs 40] [--port 5282] [--out file.json]
//
// Network model (both directions, the same for every variant):
//   wifi    one-way delay uniform 10–90 ms (50 ± 40), 5 % loss.
//           UDP (data channel): a lost message is gone; each message delayed independently (may reorder).
//           TCP (WebSocket / POST, in the proxy): in order; a lost segment holds itself and everything behind it for a
//           fast retransmit (3 later packets ≈ 50 ms + one round trip).
//   outage  every 10 s the link is down for 400 ms (+ 2–8 ms delay otherwise). UDP: dropped. TCP: held, then released
//           at the first retransmission after the outage (RTO 200 ms doubling: 200, 600, 1400 … ms after the send).
//   bg      the phone page goes to the background for 3 s at 8 s, 20 s, 32 s: visibility hidden, page frozen (CDP), link
//           down; on return every TCP connection through the proxy has been reset (worst case: iOS dropped the
//           sockets), then visible again.
//   combo   wifi + outage.
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHROME_ARGS } from './server';
import { shapeSteer, PAD_DEFAULTS } from '../pad/padcore.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(opt('root', '.'));
const DIR = resolve(opt('dir', 'dist'));
const LABEL = opt('label', 'run');
const VARIANT = opt('variant', 'dc');
const SCEN = opt('scenarios', 'clean,wifi,outage,bg,combo').split(',');
const SECS = Number(opt('secs', '40'));
const PORT = Number(opt('port', '5282')), HPORT = PORT + 1000, PROXY = PORT + 1001;
if (![5281, 5282, 5283, 5284].includes(PORT) || PROXY > 6284) throw new Error('use ports 5281–5283 (proxy = port + 1001)');
const OUT = opt('out', '');
const DEBUG = args.includes('--debug');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]; };

interface Net { loss: number; dmin: number; dmax: number; T0: number; period: number; olen: number; ooff: number; bg: [number, number][] }
const SCENARIOS: Record<string, Omit<Net, 'T0'>> = {
  clean: { loss: 0, dmin: 0, dmax: 0, period: 0, olen: 0, ooff: 0, bg: [] },
  wifi: { loss: 0.05, dmin: 10, dmax: 90, period: 0, olen: 0, ooff: 0, bg: [] },
  outage: { loss: 0, dmin: 2, dmax: 8, period: 10000, olen: 400, ooff: 5000, bg: [] },
  bg: { loss: 0, dmin: 2, dmax: 8, period: 0, olen: 0, ooff: 0, bg: [[8000, 11000], [20000, 23000], [32000, 35000]] },
  combo: { loss: 0.05, dmin: 10, dmax: 90, period: 10000, olen: 400, ooff: 5000, bg: [] },
};
/** end of the outage containing `t` (epoch ms), or 0 */
function outageEnd(n: Net, t: number): number {
  const r = t - n.T0;
  if (n.period > 0) { const m = ((r - n.ooff) % n.period + n.period) % n.period; if (r >= n.ooff && m < n.olen) return t - m + n.olen; }
  for (const [a, b] of n.bg) if (r >= a && r < b) return n.T0 + b;
  return 0;
}

// ---------------------------------------------------------------- TCP proxy (WebSocket / POST path)
let net0: Net = { ...SCENARIOS.clean, T0: Date.now() };
const conns = new Set<net.Socket>();
function pipe(src: net.Socket, dst: net.Socket) {
  // strictly in order: one queue per direction, drained by a single timer (separate timers with equal deadlines are
  // not guaranteed to fire in order, which would corrupt the TLS stream)
  const queue: { t: number; chunk: Buffer | string }[] = [];
  let lastOut = 0, timer: NodeJS.Timeout | null = null, ended = false;
  const drain = () => {
    timer = null;
    const now = Date.now();
    while (queue.length && queue[0].t <= now) { const { chunk } = queue.shift()!; if (!dst.destroyed) dst.write(chunk); }
    if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].t - now));
    else if (ended && !dst.destroyed) dst.end();
  };
  src.on('data', (chunk) => {
    const n = net0, now = Date.now();
    const mean = (n.dmin + n.dmax) / 2;
    let t: number;
    const end = outageEnd(n, now);
    if (end) {
      // retransmissions at send + 200, 600, 1400 … ms; the first one after the outage gets through
      let k = 200; while (now + k < end) k = k * 2 + 200;
      t = now + k + mean;
    } else {
      t = now + n.dmin + Math.random() * (n.dmax - n.dmin);
      if (n.loss && Math.random() < n.loss) t += 3 * 16.7 + 2 * mean; // fast retransmit
    }
    t = Math.max(t, lastOut);
    lastOut = t;
    queue.push({ t, chunk });
    if (!timer) timer = setTimeout(drain, Math.max(0, t - now));
  });
  src.on('end', () => { ended = true; if (!queue.length && !timer && !dst.destroyed) dst.end(); });
  src.on('error', () => dst.destroy());
  src.on('close', () => setTimeout(() => dst.destroy(), Math.max(0, lastOut - Date.now() + 5)));
}
const proxy = net.createServer((c) => {
  const s = net.connect(HPORT, '127.0.0.1');
  c.setNoDelay(true); s.setNoDelay(true);
  conns.add(c); conns.add(s);
  c.on('close', () => conns.delete(c)); s.on('close', () => conns.delete(s));
  pipe(c, s); pipe(s, c);
});
const resetAll = () => { for (const c of conns) c.resetAndDestroy?.() ?? c.destroy(); conns.clear(); };

// ---------------------------------------------------------------- in-page data channel impairment
const DC_IMPAIR = `(() => {
  window.__net = { loss: 0, dmin: 0, dmax: 0, T0: 0, period: 0, olen: 0, ooff: 0, bg: [] };
  const down = (n, t) => { const r = t - n.T0;
    if (n.period > 0 && r >= n.ooff && (((r - n.ooff) % n.period) + n.period) % n.period < n.olen) return true;
    for (const [a, b] of n.bg) if (r >= a && r < b) return true; return false; };
  if (typeof RTCDataChannel === 'undefined') return;
  const orig = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (d) {
    const n = window.__net, now = Date.now();
    if (down(n, now) || (n.loss && Math.random() < n.loss)) return;
    const dl = n.dmin + Math.random() * (n.dmax - n.dmin);
    if (dl < 0.5) return orig.call(this, d);
    setTimeout(() => { try { if (this.readyState === 'open') orig.call(this, d); } catch (e) {} }, dl);
  };
})();`;
// 60 Hz devicemotion: wheel angle 40° · sin(2π · 0.4 Hz · t), phone pitched 25°, iOS sign convention
const MOTION = `(() => {
  const D = Math.PI / 180;
  window.__simOn = false;
  setInterval(() => {
    if (!window.__simOn) return;
    const t = (performance.timeOrigin + performance.now()) / 1000, th = 40 * Math.sin(2 * Math.PI * 0.4 * t), c = Math.cos(25 * D), k = -9.81;
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: k * c * Math.cos(th * D), y: k * c * Math.sin(th * D), z: k * Math.sin(25 * D) }, acceleration: { x: 0, y: 0, z: 0 }, interval: 16 }));
  }, 1000 / 60);
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
  window.__setVis = (v) => { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
})();`;
// game page: record what the sim got every tick (wraps PhonePad.apply, present in old and new code)
const RECORD = `(() => {
  const pp = window.__phonePad; window.__rec = [];
  const orig = pp.apply.bind(pp);
  pp.apply = (out) => { orig(out); const l = pp.state.last; window.__rec.push([performance.timeOrigin + performance.now(), out.steer, out.throttle, l ? l.q : -1, l ? l.ev : 0]); };
})()`;

let srv: ChildProcess | null = null;
async function startServer(certDir: string) {
  srv = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '--dir', DIR, '--port', String(PORT), '--https-port', String(HPORT), '--cert-dir', certDir, '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  srv.stdout!.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('[dustmark] game'); i++) await sleep(100);
  if (!out.includes('[dustmark] game')) throw new Error('serve.mjs did not start');
}

async function runScenario(browser: Browser, game: Page, code: string, name: string) {
  const sc = SCENARIOS[name];
  const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  await ctx.addInitScript(DC_IMPAIR);
  await ctx.addInitScript(MOTION);
  const page = await ctx.newPage();
  const tr = VARIANT === 'http' || VARIANT === 'http-dc' ? 'http' : 'ws';
  const rtcOff = VARIANT === 'ws' || VARIANT === 'http';
  await page.goto(`https://localhost:${PROXY}/pad?k=${code}&transport=${tr}${rtcOff ? '&rtc=0' : ''}`);
  const cdp = await ctx.newCDPSession(page);
  await page.tap('#bStart');
  await page.evaluate(() => { (window as any).__simOn = true; });
  await page.waitForFunction(() => (window as any).__pad.link.state === 'ok', null, { timeout: 10000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 220, id: 1 }] }); // gas held (60 %)
  await game.waitForFunction(() => (window as any).__phonePad.state.fresh(performance.now()), null, { timeout: 5000 });
  await sleep(VARIANT.endsWith('dc') ? 2500 : 800); // let the data channel come up
  // start the clock: impairment + recording
  const T0 = Date.now() + 200;
  const n: Net = { ...sc, T0 };
  net0 = n;
  for (const p of [page, game]) await p.evaluate((x) => { (window as any).__net = x; }, n);
  await game.evaluate(`window.__rec = []`);
  // each page's epoch clock (timeOrigin + now) vs the shared wall clock: pages created minutes apart can disagree by
  // tens of ms when the system clock was slewed in between, so latencies are corrected by the difference
  const skew = async (p: Page) => p.evaluate(() => { let best = Infinity; for (let i = 0; i < 20; i++) { const a = performance.timeOrigin + performance.now(), d = Date.now(); if (Math.abs(a - d) < Math.abs(best)) best = a - d; } return best; });
  const skG = await skew(game), skP = await skew(page), clockOff = skG - skP;
  await sleep(200);
  const resumes: number[] = [], retouch: number[] = [];
  const bgDone = (async () => {
    for (const [a, b] of sc.bg) {
      await sleep(Math.max(0, T0 + a - Date.now()));
      // iOS cancels touches when the page goes away; the player presses again when back
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await page.evaluate(() => (window as any).__setVis('hidden'));
      let frozen = true;
      try { await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); } catch { frozen = false; await cdp.send('Debugger.enable'); await cdp.send('Debugger.pause'); }
      await sleep(Math.max(0, T0 + b - Date.now()));
      resetAll(); // the phone dropped its TCP connections while in the background
      if (frozen) await cdp.send('Page.setWebLifecycleState', { state: 'active' }); else await cdp.send('Debugger.resume');
      resumes.push(Date.now());
      await page.evaluate(() => (window as any).__setVis('visible'));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 220, id: 2 }] });
      retouch.push(Date.now());
    }
  })();
  const t1 = Date.now() + SECS * 1000;
  while (Date.now() < t1) {
    await sleep(1000);
    if (DEBUG && !sc.bg.some(([a, b]) => Date.now() - T0 > a - 1100 && Date.now() - T0 < b + 100)) {
      console.log(((Date.now() - T0) / 1000).toFixed(0), JSON.stringify(await game.evaluate(() => (window as any).__phonePad.rtcLog?.slice(-2))), JSON.stringify(await page.evaluate(() => { const p = (window as any).__pad, l = p.link; return { st: l.state, mode: l.mode, ws: l.ws?.readyState, tries: l.wsTries, rc: l.reconnects, rtc: p.rtc?.state, log: p.rtc?.log?.slice(-2), d: document.getElementById('cDetail')?.textContent }; })));
    }
  }
  await bgDone;
  const rec: [number, number, number, number, number][] = await game.evaluate(`window.__rec.slice()`);
  const fig = await game.evaluate(() => { const p = (window as any).__phonePad; return p.figures ? p.figures() : null; });
  const tag = await game.evaluate(() => document.querySelector('.phone-tag')?.textContent ?? null);
  const padView = await page.evaluate(() => document.getElementById('cDetail')?.textContent ?? document.getElementById('cText')?.textContent ?? '');
  net0 = { ...SCENARIOS.clean, T0: 0 };
  await ctx.close();
  await sleep(800);
  return { name, clockOff: +clockOff.toFixed(2), ...analyse(rec, resumes, skG, skP, retouch), fig, tag, padView };
}

const idealSteer = (tMs: number) => shapeSteer(40 * Math.sin(2 * Math.PI * 0.4 * (tMs / 1000)), { ...PAD_DEFAULTS, zero: 0 });

function analyse(rec: [number, number, number, number, number][], resumes: number[], skG: number, skP: number, retouch: number[] = []) {
  const clockOff = skG - skP;
  if (rec.length < 10) return { ticks: rec.length, error: 'no data' };
  const dur = (rec[rec.length - 1][0] - rec[0][0]) / 1000;
  const upd: number[] = [], lat: number[] = [];
  let lastQ = -2, lastT = 0, maxJump = 0, jumps = 0, err2 = 0, dead = 0, thDead = 0, jumpAt = 0;
  const intervals: number[] = [];
  for (let i = 0; i < rec.length; i++) {
    const [t, s, th, qq, ev] = rec[i];
    if (qq !== lastQ && qq >= 0) {
      if (lastT) intervals.push(t - lastT);
      lastT = t; lastQ = qq; upd.push(t);
      if (ev > 0) lat.push(t - ev - clockOff);
    }
    if (i > 0) { const d = Math.abs(s - rec[i - 1][1]); if (d > maxJump) { maxJump = d; jumpAt = i; } if (d > 0.1) jumps++; }
    const id = idealSteer(t);
    err2 += (s - id) ** 2;
    if (Math.abs(s) < 0.01 && Math.abs(id) > 0.2) dead++;
    if (th < 0.05) thDead++;
  }
  const tick = dur / rec.length;
  if (DEBUG) for (let i = Math.max(0, jumpAt - 6); i < Math.min(rec.length, jumpAt + 4); i++) console.log('   ', (rec[i][0] - rec[0][0]).toFixed(1), rec[i].slice(1).map((v) => +v.toFixed(3)).join(' '));
  // recovery after each return from the background: first new packet whose input event is after the return
  const recov = resumes.map((r) => { const hit = rec.find((x) => x[0] - skG > r && x[4] - skP > r); return hit ? hit[0] - skG - r : NaN; });
  return {
    secs: +dur.toFixed(1), ticks: rec.length, updates: upd.length, updHz: +(upd.length / dur).toFixed(1),
    stalls50: intervals.filter((x) => x > 50).length, gaps150: intervals.filter((x) => x > 150).length, maxGap: Math.round(Math.max(...intervals)),
    maxJump: +maxJump.toFixed(3), jumps01: jumps,
    lat50: +q(lat, 0.5).toFixed(1), lat95: +q(lat, 0.95).toFixed(1), lat99: +q(lat, 0.99).toFixed(1), latMax: Math.round(Math.max(...lat)),
    rmsErr: +Math.sqrt(err2 / rec.length).toFixed(3), steerDeadS: +(dead * tick).toFixed(2), throttleDeadS: +(thDead * tick).toFixed(2),
    recoverMs: recov.map((x) => Math.round(x)),
    gasBackMs: retouch.map((r) => { const hit = rec.find((x) => x[0] - skG > r && x[2] > 0.05); return hit ? Math.round(hit[0] - skG - r) : NaN; }),
  };
}

async function main() {
  const certDir = mkdtempSync(join(tmpdir(), 'dustmark-netsim-'));
  await startServer(certDir);
  await new Promise<void>((r) => proxy.listen(PROXY, '127.0.0.1', () => r()));
  const code: string = (await (await fetch(`http://localhost:${PORT}/pair-info`)).json()).code;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...CHROME_ARGS, '--ignore-certificate-errors'] });
  const results: unknown[] = [];
  try {
    const gctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    await gctx.addInitScript(DC_IMPAIR);
    const game = await gctx.newPage();
    await game.goto(`http://localhost:${PORT}/?stage=north-1&car=kestrel&mute=1`);
    await game.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
    await game.waitForFunction(() => (window as any).__phonePad?.status().gameLinked, null, { timeout: 10_000 });
    await game.evaluate(RECORD);
    for (const s of SCEN) {
      const r = await runScenario(browser, game, code, s);
      console.log(`${LABEL} ${VARIANT} ${JSON.stringify(r)}`);
      results.push({ label: LABEL, variant: VARIANT, ...r });
    }
  } finally {
    await browser.close();
    proxy.close(); resetAll();
    srv?.kill('SIGTERM');
    rmSync(certDir, { recursive: true, force: true });
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
}
main().catch((e) => { console.error(e); srv?.kill('SIGTERM'); process.exit(1); });
