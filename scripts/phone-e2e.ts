// End-to-end check of the phone steering wheel without a phone (headless Chrome, no windows):
//   serve.mjs on test ports → game page (?stage=north-1&car=kestrel&mute=1) + phone page in an iPhone-sized touch
//   viewport; synthetic devicemotion + CDP touch events drive the car; asserts on window.__game; measures latency;
//   screenshots to docs/screenshots/m4/phone/.
//   Last: a second server on a fake interface list (DUSTMARK_FAKE_NET) — the iPhone cable appears / disappears while the
//   pairing panel is open (tabs, default 有线, QR content, manual choice kept).
//   npx tsx scripts/phone-e2e.ts [--dir dist] [--transport ws|http|both] [--no-shots] [--only-wired] [--real-net]
import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME_ARGS } from './server';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('dir', 'dist');
const TRANSPORTS = opt('transport', 'both') === 'both' ? ['ws', 'http'] : [opt('transport', 'ws')];
const SHOTS = !args.includes('--no-shots');
const PORT = 5281, HPORT = 6281;
const OUT = 'docs/screenshots/m4/phone';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };

const certDir = mkdtempSync(join(tmpdir(), 'dustmark-e2e-'));
let srv: ChildProcess | null = null;
// screenshots must not show this Mac's real LAN address: unless --real-net, the server sees one example Wi-Fi address
// (served on [::1]); the phone page itself is opened on https://localhost either way
const REAL_NET = args.includes('--real-net');
const mainNet = join(certDir, 'main-net.json');
writeFileSync(mainNet, JSON.stringify({ ifaces: [{ name: 'en0', address: '192.168.1.23', bind: '::1' }], hw: { en0: 'Wi-Fi' }, default: 'en0' }));
async function startServer() {
  srv = spawn(process.execPath, ['scripts/serve.mjs', '--dir', DIR, '--port', String(PORT), '--https-port', String(HPORT), '--cert-dir', certDir, '--quiet'],
    { stdio: ['ignore', 'pipe', 'inherit'], env: REAL_NET ? process.env : { ...process.env, DUSTMARK_FAKE_NET: mainNet } });
  let out = '';
  srv.stdout!.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('[dustmark] game'); i++) await sleep(100);
  if (!out.includes('[dustmark] game')) throw new Error('serve.mjs did not start');
}

/** phone page helpers: gravity generator (60 Hz devicemotion) + CDP multi-touch */
async function openPad(browser: Browser, w: number, h: number, query: string, init?: string) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => failures.push('pad page error: ' + e.message));
  await page.goto(`https://localhost:${HPORT}/pad?${query}`);
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}
/** start emitting devicemotion at 60 Hz from window.__sim = {theta, pitch, side} (spec sign convention ×(-1) = iOS) */
async function startMotion(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__sim = { theta: 0, pitch: 25, side: 1, ios: true };
    const D = Math.PI / 180;
    setInterval(() => {
      const s = w.__sim, c = Math.cos(s.pitch * D), k = s.ios ? -9.81 : 9.81;
      const g = { x: k * s.side * c * Math.cos(s.theta * D), y: k * s.side * c * Math.sin(s.theta * D), z: k * Math.sin(s.pitch * D) };
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: g, acceleration: { x: 0, y: 0, z: 0 }, interval: 16 }));
    }, 1000 / 60);
  });
}
const setSim = (page: Page, s: Record<string, number | boolean>) => page.evaluate((o) => Object.assign((window as any).__sim, o), s);
type TP = { x: number; y: number; id: number };
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: TP[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });

async function gameState(g: Page) {
  return g.evaluate(() => {
    const G = (window as any).__game, c = G.world.car;
    return { steerIn: G.simInp.steer, thIn: G.simInp.throttle, brIn: G.simInp.brake, hbIn: G.simInp.handbrake, steer: c.controls.steer, kmh: c.speed * 3.6, yawRate: c.yawRate, phase: G.world.session.phase, paused: G.paused };
  });
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 90 });
  console.log(`     shot ${OUT}/${name}.jpg`);
}

let wsrv: ChildProcess | null = null;
/** pairing panel with a fake wired iPhone interface (no phone needed: the address only has to be listed and certified) */
async function wiredPanel(browser: Browser) {
  const WP = 5284, WHP = 6284;
  const netFile = join(certDir, 'net.json');
  const WIFI = { name: 'en0', address: '192.168.77.23' }, VPN = { name: 'utun4', address: '10.8.0.2' }, USB = { name: 'en9', address: '172.20.10.2', bind: '::1' };
  const writeNet = (ifaces: object[]) => writeFileSync(netFile, JSON.stringify({ ifaces, hw: { en0: 'Wi-Fi', en9: 'iPhone USB' }, default: 'utun4' }));
  writeNet([WIFI, VPN]);
  wsrv = spawn(process.execPath, ['scripts/serve.mjs', '--dir', DIR, '--port', String(WP), '--https-port', String(WHP), '--cert-dir', join(certDir, 'wired'), '--quiet'],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, DUSTMARK_FAKE_NET: netFile } });
  let out = '';
  wsrv.stdout!.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('[dustmark] game'); i++) await sleep(100);
  const code: string = (await (await fetch(`http://localhost:${WP}/pair-info`)).json()).code;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const g = await ctx.newPage();
  g.on('pageerror', (e) => failures.push('wired panel page error: ' + e.message));
  await g.goto(`http://localhost:${WP}/?stage=north-1&car=kestrel&mute=1`);
  await g.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
  await g.keyboard.press('KeyK');
  await g.waitForSelector('.pair-qr svg', { timeout: 5000 });
  const view = () => g.evaluate(() => ({
    tabs: [...document.querySelectorAll('.pair-tabs button')].map((b) => ({ ip: (b as HTMLElement).dataset.ip, on: b.classList.contains('pt-on'), text: b.textContent })),
    qr: document.querySelector('.pair-qr svg')?.getAttribute('data-url'), via: document.querySelector('.pair-qr .via')?.textContent, body: document.querySelector('.pair-body')?.textContent ?? '',
  }));
  const url = (ip: string) => `https://${ip}:${WHP}/pad?k=${code}`;
  let v = await view();
  check(v.tabs.length === 2 && v.tabs[0].on && v.tabs[0].ip === WIFI.address && v.tabs[1].text!.includes('VPN') && v.qr === url(WIFI.address),
    `wired panel: Wi-Fi + VPN listed, Wi-Fi selected (VPN holds the default route but is never the default)`);
  writeNet([WIFI, VPN, USB]);
  await g.waitForFunction((u) => document.querySelector('.pair-qr svg')?.getAttribute('data-url') === u, url(USB.address), { timeout: 6000 }).catch(() => {});
  v = await view();
  check(v.qr === url(USB.address) && v.via!.includes('有线') && v.tabs.find((t) => t.on)?.ip === USB.address && v.body.includes('数据线') && v.body.includes('设定服务顺序'),
    `cable plugged in → panel switches to 有线 on its own: QR ${v.qr}`);
  await shot(g, 'pair-panel-wired');
  await g.click(`.pair-tabs button[data-ip="${WIFI.address}"]`);
  await sleep(2600); // one refresh of /pair-info: the manual choice stays
  v = await view();
  check(v.qr === url(WIFI.address) && v.tabs.find((t) => t.on)?.ip === WIFI.address, 'manual choice (Wi-Fi) kept across refreshes');
  await g.click(`.pair-tabs button[data-ip="${USB.address}"]`);
  writeNet([WIFI, VPN]);
  await g.waitForFunction((ip) => !document.querySelector(`.pair-tabs button[data-ip="${ip}"]`), USB.address, { timeout: 6000 }).catch(() => {});
  v = await view();
  check(!v.tabs.some((t) => t.ip === USB.address) && v.qr === url(WIFI.address), 'cable pulled → 有线 tab gone, back to Wi-Fi');
  await ctx.close();
  wsrv.kill('SIGTERM'); wsrv = null;
}

async function main() {
  if (args.includes('--only-wired')) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...CHROME_ARGS] });
    try { await wiredPanel(browser); } finally { await browser.close(); wsrv?.kill('SIGTERM'); rmSync(certDir, { recursive: true, force: true }); }
    console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall wired-panel checks passed');
    process.exit(failures.length ? 1 : 0);
  }
  await startServer();
  const info = await (await fetch(`http://localhost:${PORT}/pair-info`)).json();
  const code: string = info.code;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...CHROME_ARGS, '--ignore-certificate-errors'] });
  try {
    // ---------------- game page
    const gctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const game = await gctx.newPage();
    game.on('pageerror', (e) => failures.push('game page error: ' + e.message));
    await game.goto(`http://localhost:${PORT}/?stage=north-1&car=kestrel&mute=1`);
    await game.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
    await game.waitForFunction(() => (window as any).__phonePad?.status().gameLinked, null, { timeout: 10_000 });
    check(true, 'game page linked to the relay');

    // pairing panel
    await game.keyboard.press('KeyK');
    await game.waitForSelector('.pair-qr svg', { timeout: 5000 });
    const panelText = await game.textContent('.pair-card');
    check(!!panelText?.includes(info.url ?? '###') || !info.url, 'pairing panel shows the LAN URL');
    await shot(game, 'pair-panel');
    await game.keyboard.press('Escape');
    check(!(await game.$('.pair-ov')) && !(await game.evaluate(() => (window as any).__game.paused)), 'Esc closes the panel without pausing');

    for (const transport of TRANSPORTS) {
      for (const [w, h] of [[852, 393], [667, 375]] as const) {
        const tag = `${w}x${h}`;
        const main = w === 852;
        const shots = transport === TRANSPORTS[0];
        console.log(`-- phone ${tag}, transport ${transport}`);
        const { ctx, page, cdp } = await openPad(browser, w, h, `k=${code}${w >= 800 ? '&sim=notch' : ''}&transport=${transport}`);
        if (shots) await shot(page, `${tag}-01-start`);
        await page.tap('#bStart');
        await startMotion(page);
        await page.waitForFunction(() => (window as any).__pad.link.state === 'ok', null, { timeout: 8000 });
        const mode = await page.evaluate(() => (window as any).__pad.link.mode);
        check(mode === transport, `${tag}: pad link up over ${mode}`);
        await game.waitForFunction(() => (window as any).__phonePad.status().fresh, null, { timeout: 5000 });
        await game.waitForFunction(() => (window as any).__game.world.session.phase === 'running', null, { timeout: 15000 });
        await sleep(400);
        if (shots) await shot(page, `${tag}-02-controls`);

        // steer right 30° + throttle (press, slide up 45 px → 80 %)
        // same start for every run: 30 m into the stage, at rest, no countdown
        await game.evaluate(() => (window as any).__teleport(30, 0, 0));
        await setSim(page, { theta: 30 });
        const gx = Math.round(w * 0.8), gy = Math.round(h * 0.55);
        await touch(cdp, 'touchStart', [{ x: gx, y: gy, id: 1 }]);
        await touch(cdp, 'touchMove', [{ x: gx, y: gy - 45, id: 1 }]);
        await sleep(300);
        let s = await gameState(game);
        const expSteer = Math.pow((30 - 2) / 58, 1.25);
        check(Math.abs(s.steerIn - expSteer) < 0.02, `${tag}: steering 30° → sim input ${s.steerIn.toFixed(3)} (expected ${expSteer.toFixed(3)})`);
        check(Math.abs(s.thIn - 0.8) < 0.01, `${tag}: throttle slide → ${s.thIn.toFixed(2)} (expected 0.80)`);
        if (shots) await shot(page, `${tag}-03-gas-steer`);
        if (main) {
          await sleep(2500);
          s = await gameState(game);
          check(s.kmh > 25, `car accelerates under phone throttle: ${s.kmh.toFixed(1)} km/h`);
          check(s.steer > 0.1 && s.yawRate > 0.05, `car turns right: controls.steer ${s.steer.toFixed(2)}, yaw rate ${s.yawRate.toFixed(2)} rad/s`);
          // left + brake with a second finger, handbrake on
          await setSim(page, { theta: -40 });
          const bx = Math.round(w * 0.2), by = Math.round(h * 0.45);
          await touch(cdp, 'touchStart', [{ x: gx, y: gy - 45, id: 1 }, { x: bx, y: by, id: 2 }]);
          await sleep(500);
          s = await gameState(game);
          check(s.steerIn < -0.5 && s.brIn > 0.55 && s.thIn > 0.75, `multi-touch: steer ${s.steerIn.toFixed(2)}, brake ${s.brIn.toFixed(2)} + throttle ${s.thIn.toFixed(2)}`);
          await touch(cdp, 'touchEnd', [{ x: gx, y: gy - 45, id: 1 }]);
          await touch(cdp, 'touchEnd', [{ x: bx, y: by, id: 2 }]);
          // handbrake button (hold)
          const hb = (await page.locator('.hb').boundingBox())!;
          await touch(cdp, 'touchStart', [{ x: hb.x + hb.width / 2, y: hb.y + hb.height / 2, id: 3 }]);
          await sleep(200);
          s = await gameState(game);
          check(s.hbIn === 1 && s.thIn === 0, `handbrake held → ${s.hbIn}, throttle released → ${s.thIn}`);
          await touch(cdp, 'touchEnd', [{ x: hb.x + hb.width / 2, y: hb.y + hb.height / 2, id: 3 }]);
          // pause button → game pauses; again → resumes
          const pb = (await page.locator('[data-btn=pause]').boundingBox())!;
          const tapAt = async (b: { x: number; y: number; width: number; height: number }, id: number) => {
            await touch(cdp, 'touchStart', [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id }]);
            await sleep(60);
            await touch(cdp, 'touchEnd', [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id }]);
          };
          await tapAt(pb, 4); await sleep(250);
          const p1 = (await gameState(game)).paused;
          // the pause menu takes over input (the phone's 暂停 does not resume it any more): Esc on the Mac resumes
          await game.keyboard.press('Escape'); await sleep(250);
          const p2 = (await gameState(game)).paused;
          check(p1 === true && p2 === false, `pause button pauses the game; Esc resumes (${p1} → ${p2})`);
          // 回中: hold 12° and recentre → 0
          await setSim(page, { theta: 12 });
          await sleep(150);
          const cb = (await page.locator('[data-btn=center]').boundingBox())!;
          await tapAt(cb, 6); await sleep(200);
          s = await gameState(game);
          check(Math.abs(s.steerIn) < 0.01, `回中 at 12° → steer ${s.steerIn.toFixed(3)}`);
          await setSim(page, { theta: 12 + 31 });
          await sleep(200);
          s = await gameState(game);
          check(Math.abs(s.steerIn - Math.pow(29 / 58, 1.25)) < 0.02, `after 回中, +31° → ${s.steerIn.toFixed(3)}`);

          // latency: devicemotion event → first sim tick that used the packet
          await game.evaluate(() => { const p = (window as any).__phonePad; p.latency.length = 0; p.sendLatency.length = 0; });
          await setSim(page, { theta: 0 });
          await sleep(5000);
          const lat: number[] = await game.evaluate(() => (window as any).__phonePad.latency.slice());
          const sl: number[] = await game.evaluate(() => (window as any).__phonePad.sendLatency.slice());
          console.log(`     LATENCY (${transport}) event→sim: n=${lat.length} median ${pct(lat, 0.5).toFixed(1)} ms  p95 ${pct(lat, 0.95).toFixed(1)} ms  max ${Math.max(...lat).toFixed(1)} ms;  send→sim median ${pct(sl, 0.5).toFixed(1)} ms`);
          check(lat.length > 200 && pct(lat, 0.5) < 30, `latency samples ${lat.length}, median < 30 ms`);
          // WebRTC data channel (host candidates only) next to the relay; link figures on the phone, the HUD tag and the panel
          const rs = await page.evaluate(() => (window as any).__pad.rtc.state);
          const fig = await game.evaluate(() => (window as any).__phonePad.figures());
          check(rs === 2 && fig.channel === 'dc' && fig.share.dc > 50, `UDP data channel open; last 5 s: ${JSON.stringify(fig.share)} accepted per channel, ${fig.hz.toFixed(0)} Hz, round trip ${fig.rtt50}/${fig.rtt95} ms`);
          const detail = await page.textContent('#cDetail');
          check(/UDP \d+\/\d+ · (WS|POST) \d+\/\d+ ms/.test(detail ?? '') && /发 \d+ Hz · 游戏收 \d+ Hz · 5 秒断流 \d+/.test(detail ?? ''), `phone shows link figures: ${JSON.stringify(detail)}`);
          const tagText = await game.textContent('.phone-tag');
          check(/^手机 UDP \d+\/\d+ ms · \d+ Hz · 5 s 断流 \d+/.test(tagText ?? ''), `HUD tag: ${JSON.stringify(tagText)}`);
          if (shots && transport === TRANSPORTS[0]) { await shot(page, `${tag}-09-link`); await shot(game, 'game-phone-tag'); }
          await game.keyboard.press('KeyK');
          await game.waitForSelector('#pair-link b', { timeout: 3000 }).catch(() => {});
          const linkTxt = await game.textContent('#pair-link');
          check(/通道 UDP/.test(linkTxt ?? '') && /往返 \d+ \/ \d+ ms/.test(linkTxt ?? '') && /近 5 秒 卡顿/.test(linkTxt ?? '') && /本局/.test(linkTxt ?? ''), `pairing panel shows the link figures (${(linkTxt ?? '').split('\n').length} lines)`);
          if (shots && transport === TRANSPORTS[0]) await shot(game, 'pair-panel-link');
          await game.keyboard.press('Escape');
          await setSim(page, { theta: 30 });
          await touch(cdp, 'touchStart', [{ x: gx, y: gy, id: 7 }]);
          await sleep(300);

          // tilt back too far → untrusted → centred + warning
          await setSim(page, { pitch: 78 });
          await sleep(300);
          s = await gameState(game);
          check(Math.abs(s.steerIn) < 1e-6 && (await page.isVisible('#wTilt')), `phone nearly flat → steer ${s.steerIn}, warning shown`);
          if (shots) await shot(page, `${tag}-05-tilt`);
          await setSim(page, { pitch: 25 });
          await sleep(500);

          // phone goes silent (screen locked / Wi-Fi gone, sockets still open): hold 150 ms, then throttle released
          // within 80 ms and steering eased to centre over 300 ms (PadHold); the game's sim input, sampled per frame
          const s0 = (await gameState(game)).steerIn;
          await page.evaluate(() => { (window as any).__pad.link.send = () => {}; });
          // (a string: tsx would wrap a named inner function in __name(), which the page does not have)
          const trace: [number, number, number][] = await game.evaluate(`new Promise((res) => {
            const G = window.__game, out = [], t0 = performance.now();
            const f = () => { const t = performance.now() - t0; out.push([t, G.simInp.steer, G.simInp.throttle]); if (t < 700) requestAnimationFrame(f); else res(out); };
            requestAnimationFrame(f);
          })`);
          const lastAt = (pred: (r: [number, number, number]) => boolean) => trace.filter(pred).map((r) => r[0]).pop() ?? 0;
          const thOff = lastAt((r) => r[2] > 0), stOff = lastAt((r) => Math.abs(r[1]) > 1e-6), heldTo = lastAt((r) => Math.abs(r[1] - s0) < 1e-6);
          const mid = trace.find((r) => r[0] > 290 && r[0] < 330);
          check(s0 > 0.1 && heldTo >= 110 && heldTo <= 200 && thOff >= 170 && thOff <= 290 && stOff >= 380 && stOff <= 500 && !!mid && Math.abs(mid[1] / s0 - (1 - (mid[0] - 150 - 8) / 300)) < 0.15,
            `phone silent (${transport}): steer ${s0.toFixed(2)} held to ${heldTo.toFixed(0)} ms, throttle off after ${thOff.toFixed(0)} ms, steering centred after ${stOff.toFixed(0)} ms (linear: ${mid ? (mid[1] / s0).toFixed(2) : '–'} at ${mid?.[0].toFixed(0)} ms)`);
          await page.evaluate(() => (window as any).__pad.link.ws?.close?.());
          await game.waitForSelector('.phone-badge', { state: 'visible', timeout: 1500 }).catch(() => {});
          check(await game.isVisible('.phone-badge') && (await game.textContent('.phone-badge'))!.includes('手机断开'), 'HUD shows 手机断开');
          if (shots && transport === TRANSPORTS[0]) await shot(game, 'game-phone-lost');
          await ctx.close();
          // reconnect: a fresh page, no ?k= (code remembered in localStorage) — new context = new storage, so reuse
          // the same context type but seed storage first
          const r = await openPad(browser, w, h, `${w >= 800 ? 'sim=notch&' : ''}transport=${transport}`, `try{localStorage.setItem('dustmark.pad.k', ${JSON.stringify(code)})}catch{}`);
          await r.page.tap('#bStart');
          await startMotion(r.page);
          await r.page.waitForFunction(() => (window as any).__pad.link.state === 'ok', null, { timeout: 8000 });
          await game.waitForFunction(() => (window as any).__phonePad.status().fresh, null, { timeout: 5000 });
          check(true, 'reconnect without re-scanning (code from localStorage)');
          await r.ctx.close();
        } else {
          // tilt shot for the small size too
          await setSim(page, { pitch: 78 });
          await sleep(300);
          if (shots) await shot(page, `${tag}-05-tilt`);
          await ctx.close();
        }
        await sleep(700);
      }
    }

    // ---------------- portrait, permission denied, disconnected (screenshots)
    if (SHOTS) {
      for (const [w, h] of [[393, 852], [375, 667]] as const) {
        const { ctx, page } = await openPad(browser, w, h, `k=${code}`);
        await page.tap('#bStart');
        await sleep(300);
        check(await page.isVisible('#sPortrait'), `${w}x${h} portrait → 请横握手机`);
        await shot(page, `${h}x${w}-04-portrait`);
        await ctx.close();
      }
      const den = await openPad(browser, 852, 393, `k=${code}&sim=notch`, `DeviceMotionEvent.requestPermission = () => Promise.resolve('denied');`);
      await den.page.tap('#bStart');
      await den.page.waitForSelector('#sDeny.on');
      await shot(den.page, '852x393-07-denied');
      await den.ctx.close();
      const bad = await openPad(browser, 852, 393, `k=ZZZZZZ&sim=notch`);
      await bad.page.tap('#bStart');
      await startMotion(bad.page);
      await bad.page.waitForSelector('#sBadKey.on', { timeout: 8000 });
      check(true, 'wrong code → 配对码已失效');
      await bad.ctx.close();
      // settings sheet
      const set = await openPad(browser, 852, 393, `k=${code}&sim=notch`);
      await set.page.tap('#bStart');
      await startMotion(set.page);
      await set.page.waitForFunction(() => (window as any).__pad.link.state === 'ok', null, { timeout: 8000 });
      const sb = (await set.page.locator('[data-btn=settings]').boundingBox())!;
      await touch(set.cdp, 'touchStart', [{ x: sb.x + 10, y: sb.y + 10, id: 1 }]);
      await touch(set.cdp, 'touchEnd', [{ x: sb.x + 10, y: sb.y + 10, id: 1 }]);
      await set.page.waitForSelector('#sSettings.on');
      await shot(set.page, '852x393-08-settings');
      await set.page.tap('#bDone');
      // disconnected: stop the server under the phone (one phone at a time: a second one would take over)
      srv!.kill('SIGTERM');
      await set.page.waitForSelector('#sDown.on', { timeout: 6000 });
      await shot(set.page, '852x393-06-disconnected');
      await startServer();
      const code2 = (await (await fetch(`http://localhost:${PORT}/pair-info`)).json()).code;
      const small = await openPad(browser, 667, 375, `k=${code2}`);
      await small.page.tap('#bStart');
      await startMotion(small.page);
      await small.page.waitForFunction(() => (window as any).__pad.link.state === 'ok', null, { timeout: 8000 });
      srv!.kill('SIGTERM');
      await small.page.waitForSelector('#sDown.on', { timeout: 6000 });
      await shot(small.page, '667x375-06-disconnected');
      check(true, 'server gone → 连接断开 overlay');
      await set.ctx.close(); await small.ctx.close();
    }
    await gctx.close();
    await wiredPanel(browser);
  } finally {
    await browser.close();
    srv?.kill('SIGTERM');
    wsrv?.kill('SIGTERM');
    rmSync(certDir, { recursive: true, force: true });
  }
  console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall phone e2e checks passed');
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); srv?.kill('SIGTERM'); process.exit(1); });
