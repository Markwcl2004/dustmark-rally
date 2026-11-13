// scripts/serve.mjs: static serving, pairing, relay, rejection, timeouts, HTTPS fallback, certificate SAN.
// Runs the real server on test ports (17198 / 18198) with a throw-away certificate directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { PadState, PAD_TIMEOUT_MS, sanitizePadMsg } from '../pad/padcore.js';

const PORT = 17198, HPORT = 18198;
const certDir = mkdtempSync(join(tmpdir(), 'dustmark-cert-'));
let srv: ChildProcess;
let code = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = new https.Agent({ rejectUnauthorized: false });

function get(path: string, headers: Record<string, string> = {}, secure = false): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    const req = lib.request({ host: '127.0.0.1', port: secure ? HPORT : PORT, path, headers: { host: `localhost:${PORT}`, ...headers }, agent: secure ? agent : undefined, method: 'GET' }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b, type: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject); req.end();
  });
}
function post(path: string, body: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: HPORT, path, method: 'POST', agent, headers: { 'content-type': 'text/plain' } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode!, json: j }); });
    });
    req.on('error', reject); req.end(body);
  });
}

/** a websocket client that records every message */
function client(url: string, opts: WebSocket.ClientOptions = {}) {
  const ws = new WebSocket(url, { rejectUnauthorized: false, ...opts });
  const msgs: any[] = [];
  let closed: { code: number } | null = null;
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { msgs.push(d.toString()); } });
  ws.on('close', (c) => { closed = { code: c }; });
  ws.on('error', () => {});
  const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('close', () => rej(new Error('closed before open'))); });
  return {
    ws, msgs, opened, get closed() { return closed; },
    async waitFor(pred: (m: any) => boolean, ms = 2000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await sleep(10); }
      throw new Error('timeout waiting for message; got ' + JSON.stringify(msgs.slice(-5)));
    },
    async waitClose(ms = 2000) { const t0 = Date.now(); while (!closed && Date.now() - t0 < ms) await sleep(10); return closed; },
  };
}
const gameUrl = () => `ws://127.0.0.1:${PORT}/ws?role=game`;
const padUrl = (k = code, sid = 'padsid001') => `wss://127.0.0.1:${HPORT}/ws?role=pad&k=${k}&sid=${sid}`;
const inPkt = (q: number, extra = {}) => JSON.stringify({ t: 'in', q, ts: Date.now(), ev: Date.now(), s: 0.4, th: 0.7, br: 0, b: 1, a: [0, 0, 0, 0], ok: 1, ...extra });

beforeAll(async () => {
  srv = spawn(process.execPath, ['scripts/serve.mjs', '--dir', 'dist', '--port', String(PORT), '--https-port', String(HPORT), '--cert-dir', certDir, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout!.on('data', (d) => (out += d));
  srv.stderr!.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('[dustmark] game'); i++) await sleep(100);
  if (!out.includes('[dustmark] game')) throw new Error('serve.mjs did not start: ' + out);
  code = JSON.parse((await get('/pair-info')).body).code;
}, 20000);
afterAll(() => { srv?.kill('SIGTERM'); rmSync(certDir, { recursive: true, force: true }); });

describe('static + pairing endpoints', () => {
  it('serves the game build and /pair-info on localhost', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<canvas id="game">');
    const info = JSON.parse((await get('/pair-info')).body);
    expect(info.ok).toBe(true);
    expect(info.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(info.httpsPort).toBe(HPORT);
    if (info.url) expect(info.url).toMatch(new RegExp(`^https://\\d+\\.\\d+\\.\\d+\\.\\d+:${HPORT}/pad\\?k=${info.code}$`));
  });
  it('blocks directory traversal and foreign Host headers', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/..%5cpackage.json', '/%00']) {
      const r = await get(p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain('"dependencies"');
    }
    expect((await get('/pair-info', { host: 'evil.example:17198' })).status).toBe(403);
  });
  it('serves the phone page over HTTPS as one document with everything inlined', async () => {
    const r = await get('/pad?k=' + code, {}, true);
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/html');
    expect(r.body).toContain('function holdAngle');
    expect(r.body).not.toMatch(/^export /m);
    expect(r.body).not.toMatch(/^import /m);
    expect(r.body).not.toContain('<!--PAD_');
    expect((await get('/package.json', {}, true)).status).toBe(404);
  });
});

describe('relay', () => {
  it('rejects a pad without the right pairing code, and roles on the wrong server', async () => {
    const bad = client(padUrl('WRONG1'));
    expect((await bad.waitClose())?.code).toBe(4003);
    const none = client(`wss://127.0.0.1:${HPORT}/ws?role=pad&sid=abcdefgh`);
    expect((await none.waitClose())?.code).toBe(4003);
    const padOnHttp = client(`ws://127.0.0.1:${PORT}/ws?role=pad&k=${code}&sid=abcdefgh`);
    await expect(padOnHttp.opened).rejects.toThrow();
    const gameOnHttps = client(`wss://127.0.0.1:${HPORT}/ws?role=game`);
    await expect(gameOnHttps.opened).rejects.toThrow();
    const foreignOrigin = client(gameUrl(), { origin: 'https://evil.example' });
    await expect(foreignOrigin.opened).rejects.toThrow();
    expect((await post(`/pad/io?k=WRONG1&sid=abcdefgh`, '{"m":[]}')).status).toBe(403);
  });

  it('pad → game input, game → pad status, ping/pong; junk is dropped', async () => {
    const game = client(gameUrl()); await game.opened;
    await game.waitFor((m) => m.t === 'pad' && m.on === false);
    const pad = client(padUrl()); await pad.opened;
    await game.waitFor((m) => m.t === 'pad' && m.on === true && m.mode === 'ws');
    await pad.waitFor((m) => m.t === 'game' && m.on === true);
    pad.ws.send('{not json');
    pad.ws.send(JSON.stringify({ t: 'in', q: 1, pad: 'x'.repeat(700) }));
    pad.ws.send(JSON.stringify({ t: 'hack', x: 1 }));
    pad.ws.send(inPkt(2, { s: 7, extra: 'drop me' }));
    const got = await game.waitFor((m) => m.t === 'in');
    expect(got).toMatchObject({ t: 'in', q: 2, s: 1, th: 0.7, b: 1 });
    expect(got.extra).toBeUndefined();
    expect(game.msgs.filter((m) => m.t === 'in')).toHaveLength(1);
    game.ws.send(JSON.stringify({ t: 'st', g: 3, v: 87.4, r: 0.66, n: '右三 接', d: 120, run: 1 }));
    expect(await pad.waitFor((m) => m.t === 'st')).toMatchObject({ g: 3, n: '右三 接', run: 1 });
    pad.ws.send(JSON.stringify({ t: 'ping', ts: 123 }));
    const ping = await game.waitFor((m) => m.t === 'ping');
    game.ws.send(JSON.stringify({ t: 'pong', ts: ping.ts }));
    expect(await pad.waitFor((m) => m.t === 'pong')).toMatchObject({ ts: 123 });
    pad.ws.close(); game.ws.close();
    await sleep(100);
  });

  it('acks every WebSocket input packet; channel tag, phone stats and WebRTC signalling relayed; POSTs from the same phone do not reset it', async () => {
    const game = client(gameUrl()); await game.opened;
    const pad = client(padUrl(code, 'linkpad01')); await pad.opened;
    await game.waitFor((m) => m.t === 'pad' && m.on && m.mode === 'ws');
    pad.ws.send(inPkt(41));
    expect(await pad.waitFor((m) => m.t === 'k')).toEqual({ t: 'k', q: 41 });
    expect(await game.waitFor((m) => m.t === 'in' && m.q === 41)).toMatchObject({ c: 'ws' });
    pad.ws.send(JSON.stringify({ t: 'stat', ch: 'dc', r50: 9, r95: 30, rd50: 12, rd95: 44, hz: 60, mhz: 60, rc: 1, dc: 2 }));
    expect(await game.waitFor((m) => m.t === 'stat')).toMatchObject({ ch: 'dc', r50: 9, r95: 30, hz: 60 });
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2122260223 0b3c1f0e-7a1d.local 5000 typ host\r\n';
    pad.ws.send(JSON.stringify({ t: 'rtc', id: 1, sdp }));
    // loopback is not a LAN address: nothing to add here (serve-net tests cover the rewriting)
    expect(await game.waitFor((m) => m.t === 'rtc')).toEqual({ t: 'rtc', id: 1, sdp });
    game.ws.send(JSON.stringify({ t: 'rtc', id: 1, sdp: sdp.replace('0b3c', 'aaaa') }));
    expect(await pad.waitFor((m) => m.t === 'rtc')).toMatchObject({ id: 1 });
    game.ws.send(JSON.stringify({ t: 'lq', hz: 60, st: 0, gp: 0, mx: 0, lo: 0, j95: 3 }));
    expect(await pad.waitFor((m) => m.t === 'lq')).toMatchObject({ hz: 60, j95: 3 });
    // the same phone also POSTs (its socket looked dead to it): no new connection for the game, inputs tagged http
    const n0 = game.msgs.length;
    const r = await post(`/pad/io?k=${code}&sid=linkpad01`, JSON.stringify({ m: [JSON.parse(inPkt(42))] }));
    expect(r.status).toBe(200);
    expect(await game.waitFor((m) => m.t === 'in' && m.q === 42)).toMatchObject({ c: 'http' });
    expect(game.msgs.slice(n0).some((m) => m.t === 'pad' && !m.re)).toBe(false);
    pad.ws.close(); game.ws.close();
    await sleep(100);
  });

  it('rate-limits a flooding pad', async () => {
    const game = client(gameUrl()); await game.opened;
    const pad = client(padUrl(code, 'flood0001')); await pad.opened;
    await game.waitFor((m) => m.t === 'pad' && m.on);
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) pad.ws.send(inPkt(i + 1));
    await sleep(300);
    const n = game.msgs.filter((m) => m.t === 'in').length;
    const allowed = 60 + ((Date.now() - t0) / 1000) * 150;
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThanOrEqual(Math.ceil(allowed) + 5);
    pad.ws.close(); game.ws.close();
    await sleep(100);
  });

  it('disconnect → game told after the 2 s reconnect grace; silence → game-side 0.5 s timeout; reconnect without re-pairing', async () => {
    const game = client(gameUrl()); await game.opened;
    const state = new PadState();
    game.ws.on('message', (d) => { const m = sanitizePadMsg(d.toString()); if (m) state.feed(m, Date.now()); });
    let pad = client(padUrl(code, 'reconn001')); await pad.opened;
    await game.waitFor((m) => m.t === 'pad' && m.on);
    pad.ws.send(inPkt(1));
    await game.waitFor((m) => m.t === 'in');
    expect(state.fresh(Date.now())).toBe(true);
    // pad goes quiet (phone screen locked / page in background) but the socket stays open
    await sleep(PAD_TIMEOUT_MS + 120);
    expect(state.fresh(Date.now())).toBe(false);
    // pad dies abruptly
    const before = game.msgs.length;
    pad.ws.terminate();
    const t0 = Date.now();
    await game.waitFor((m) => m.t === 'pad' && m.on === false && game.msgs.indexOf(m) >= before, 4000);
    expect(Date.now() - t0).toBeGreaterThan(1800);
    expect(Date.now() - t0).toBeLessThan(2600);
    // reconnect with the remembered code (no new scan)
    pad = client(padUrl(code, 'reconn001')); await pad.opened;
    const n0 = game.msgs.length;
    pad.ws.send(inPkt(1));
    await game.waitFor((m) => m.t === 'in' && game.msgs.indexOf(m) >= n0);
    expect(state.fresh(Date.now())).toBe(true);
    // a second phone takes over; the first is told why
    const other = client(padUrl(code, 'otherpad01')); await other.opened;
    expect((await pad.waitClose())?.code).toBe(4001);
    other.ws.close(); game.ws.close();
    await sleep(100);
  });

  it('HTTPS POST fallback (iOS: wss with a self-signed cert fails) carries input up and status down', async () => {
    const game = client(gameUrl()); await game.opened;
    const sid = 'httppad01';
    let r = await post(`/pad/io?k=${code}&sid=${sid}`, JSON.stringify({ m: [JSON.parse(inPkt(1, { s: -0.5 }))] }));
    expect(r.status).toBe(200);
    expect(r.json.game).toBe(1);
    await game.waitFor((m) => m.t === 'pad' && m.on && m.mode === 'http');
    expect(await game.waitFor((m) => m.t === 'in')).toMatchObject({ s: -0.5 });
    game.ws.send(JSON.stringify({ t: 'st', g: 2, v: 40, r: 0.5, n: '左二', d: 60, run: 1 }));
    await sleep(50);
    r = await post(`/pad/io?k=${code}&sid=${sid}`, JSON.stringify({ m: [JSON.parse(inPkt(2))] }));
    expect(r.json.m.find((m: any) => m.t === 'st')).toMatchObject({ g: 2, n: '左二' });
    expect((await post(`/pad/io?k=${code}&sid=${sid}`, 'x'.repeat(20000))).status).toBe(413);
    expect((await post(`/pad/io?k=${code}&sid=${sid}`, '{bad')).status).toBe(400);
    // the HTTP pad goes silent → reported gone after ~1.5 s
    await game.waitFor((m) => m.t === 'pad' && m.on === false, 3000);
    game.ws.close();
  });
});

describe('certificate', () => {
  it('one certificate per address: localhost / 127.0.0.1 and every private LAN IPv4 of this machine, each in its own file', () => {
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
    for (const ip of ['127.0.0.1', ...lan.map((i) => i!.address)]) {
      const f = join(certDir, `pad-ip-${ip}-cert.pem`);
      expect(existsSync(f), f).toBe(true);
      const text = execFileSync('openssl', ['x509', '-in', f, '-noout', '-text'], { encoding: 'utf8' });
      expect(text).toContain('DNS:localhost');
      expect(text).toContain('IP Address:127.0.0.1');
      expect(text).toContain(`IP Address:${ip}`);
      expect(text).toContain('TLS Web Server Authentication');
    }
    // no shared certificate is written any more (an existing one is only read)
    expect(existsSync(join(certDir, 'pad-cert.pem'))).toBe(false);
  });
});
