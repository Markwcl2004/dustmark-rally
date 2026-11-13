#!/usr/bin/env node
// 尘迹拉力 DUSTMARK local server (used by play.sh / play-stable.sh; plain JS, runs with `node`, no build step).
//
//   node scripts/serve.mjs --dir dist --port 5198 [--https-port 6198] [--cert-dir ~/.dustmark] [--quiet]
//
// 1. http://localhost:<port>            the game build (static, loopback only) + GET /pair-info (loopback only)
// 2. https://<LAN IP>:<https-port>/pad  the phone steering-wheel page (iOS only exposes motion sensors to secure
//                                       contexts → HTTPS with a self-signed certificate made by openssl)
// 3. relay                              game: ws://localhost:<port>/ws?role=game
//                                       pad:  wss://<LAN IP>:<https-port>/ws?role=pad&k=<code>&sid=<id>
//                                       pad fallback: POST https://<LAN IP>:<https-port>/pad/io?k=<code>&sid=<id>
//    The HTTP fallback exists because iOS Safari does not apply a click-through certificate exception to wss://
//    connections (WebKit bug 145819, open since 2015): the page loads, the WebSocket fails. fetch() to the same origin
//    uses the page's exception, so the pad page falls back to 60 Hz POSTs whose responses carry the game status.
// 4. WebRTC signalling                  {t:'rtc'} offer / answer between pad and game through the relay, so the two can
//                                       open an unordered, no-retransmit data channel for the input packets (host
//                                       candidates only: no STUN / TURN, nothing leaves the LAN). The relay adds the
//                                       real LAN address next to each mDNS candidate (see serve-net.mjs).
//
// Every private IPv4 address of every interface is offered (Wi-Fi, the "iPhone USB" interface that appears when an
// iPhone with Personal Hotspot on is plugged in, Ethernet; VPN / VM interfaces are listed but never the default), with
// one certificate per address (see "certificates"); interfaces are re-checked every 2 s. Binds only to loopback and
// private IPv4 addresses (10/8, 172.16/12, 192.168/16); no tunnels, no public interfaces.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { sanitizePadMsg, sanitizeGameMsg, makeCode, codeMatches, RateLimit } from '../pad/padcore.js';
import { isPrivate4, classifyIfaces, parseHardwarePorts, addLanCandidates } from './serve-net.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) args[k] = v;
    else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[k] = process.argv[++i];
    else args[k] = true;
  }
}
const DIR = fs.realpathSync(path.resolve(process.cwd(), args.dir ?? path.join(ROOT, 'dist')));
const PAD_DIR = path.join(ROOT, 'pad');
const PORT = Number(args.port ?? 5198);
const HTTPS_PORT = Number(args['https-port'] ?? PORT + 1000);
const CERT_DIR = path.resolve(args['cert-dir'] ?? process.env.DUSTMARK_CERT_DIR ?? path.join(os.homedir(), '.dustmark'));
const QUIET = !!args.quiet;
const CODE = makeCode((n) => crypto.randomInt(n));
const log = (...a) => { if (!QUIET) console.log('[dustmark]', ...a); };

// ---------------------------------------------------------------- addresses
const plain = (a) => (a ?? '').replace(/^::ffff:/, '');
const isLoopback = (a) => { a = plain(a); return a === '::1' || a.startsWith('127.'); };
const remoteOk = (a) => isLoopback(a) || isPrivate4(plain(a));

// Test hook: DUSTMARK_FAKE_NET=<json file> replaces the interface list, the hardware-port names and the default route
// ({"ifaces":[{"name","address","bind"?}], "hw":{"en9":"iPhone USB"}, "default":"en0"}); re-read on every poll, so a
// test can make an interface appear and disappear. "bind" = the address actually listened on (fake addresses do not
// exist on this machine).
const FAKE_NET = process.env.DUSTMARK_FAKE_NET || null;
let hwCache = { key: '', map: new Map() };
let routeCache = { t: 0, key: '', iface: null };
function hardwarePorts(names) {
  const key = names.join();
  if (hwCache.key === key) return hwCache.map;
  let map = new Map();
  try { map = parseHardwarePorts(execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* not macOS */ }
  hwCache = { key, map };
  return map;
}
function defaultIface(key) {
  if (routeCache.key === key && Date.now() - routeCache.t < 10000) return routeCache.iface;
  let iface = null;
  try {
    const r = execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    iface = r.match(/interface:\s*(\S+)/)?.[1] ?? null;
  } catch { /* no default route */ }
  routeCache = { t: Date.now(), key, iface };
  return iface;
}
/** every reachable private IPv4 address, classified, best first: [{name, address, bind, kind, label, virtual, rank}] */
function lanAddrs() {
  if (FAKE_NET) {
    try {
      const j = JSON.parse(fs.readFileSync(FAKE_NET, 'utf8'));
      const list = (j.ifaces ?? []).filter((i) => isPrivate4(i.address));
      const binds = new Map(list.map((i) => [i.address, i.bind ?? i.address]));
      return classifyIfaces(list, new Map(Object.entries(j.hw ?? {})), j.default ?? null).map((a) => ({ ...a, bind: binds.get(a.address) }));
    } catch (e) { log('fake net:', e.message); return []; }
  }
  const list = [];
  for (const [name, l] of Object.entries(os.networkInterfaces())) {
    for (const i of l ?? []) if (i.family === 'IPv4' && !i.internal && isPrivate4(i.address)) list.push({ name, address: i.address });
  }
  const names = [...new Set(list.map((i) => i.name))].sort();
  return classifyIfaces(list, hardwarePorts(names), defaultIface(names.join()) ).map((a) => ({ ...a, bind: a.address }));
}

// ---------------------------------------------------------------- certificates
// One self-signed certificate per LAN address, each file written once and never rewritten (until it nears expiry).
// iOS remembers "访问此网站" per certificate: re-issuing a certificate because another address appeared (plugging in
// the iPhone cable) would make every already-paired phone go through the warning again. The certificate made by
// earlier versions (pad-cert.pem, one SAN list) is still used — read-only — for the addresses it covers.
const LEGACY = { key: path.join(CERT_DIR, 'pad-key.pem'), cert: path.join(CERT_DIR, 'pad-cert.pem') };
const certCache = new Map(); // ip → {key, cert, file, fp}
function readCert(keyF, certF, ip) {
  try {
    const cert = fs.readFileSync(certF), key = fs.readFileSync(keyF);
    const x = new crypto.X509Certificate(cert);
    if (Date.parse(x.validTo) < Date.now() + 14 * 864e5) return null;
    const sans = (x.subjectAltName ?? '').split(',').map((s) => s.trim());
    if (!sans.includes(`IP Address:${ip}`) && !(ip === '127.0.0.1' && sans.includes('DNS:localhost'))) return null;
    return { key, cert, file: certF, fp: x.fingerprint256 };
  } catch { return null; }
}
function certFor(ip) {
  const hit = certCache.get(ip);
  if (hit) return hit;
  let c = readCert(LEGACY.key, LEGACY.cert, ip);
  const base = path.join(CERT_DIR, `pad-ip-${ip}`);
  if (!c) c = readCert(`${base}-key.pem`, `${base}-cert.pem`, ip);
  if (!c) {
    fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...(ip !== '127.0.0.1' ? [`IP:${ip}`] : [])].join(',');
    const tk = `${base}-key.pem.tmp`, tc = `${base}-cert.pem.tmp`;
    // ≤ 398 days and EKU serverAuth: Apple's TLS server certificate requirements (support.apple.com/HT210176, HT211025)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', tk, '-out', tc, '-days', '365', '-subj', `/CN=DUSTMARK phone pad ${ip}/O=DUSTMARK local`,
      '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth',
      '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature'], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.chmodSync(tk, 0o600);
    fs.renameSync(tk, `${base}-key.pem`); fs.renameSync(tc, `${base}-cert.pem`);
    log(`certificate issued for ${san}`);
    c = readCert(`${base}-key.pem`, `${base}-cert.pem`, ip);
    if (!c) throw new Error(`certificate for ${ip} unusable`);
  }
  certCache.set(ip, c);
  return c;
}

// ---------------------------------------------------------------- relay state
/** @type {import('ws').WebSocket | null} */
let game = null;
/**
 * The one active phone. A phone may use its WebSocket and POSTs at the same time (it falls back to POSTs when the
 * socket dies and keeps retrying the socket), so one entry per session id holds both.
 * @type {null | {sid:string, ws:import('ws').WebSocket|null, wsLast:number, httpLast:number, last:number, since:number,
 *   st:string|null, q:string[], remote:string, local:string, mode:string, rtcRl:RateLimit}}
 */
let pad = null;
const replacedSids = new Set();
let badCodes = { n: 0, t: 0 };

const sendGame = (o) => { if (game && game.readyState === 1) game.send(typeof o === 'string' ? o : JSON.stringify(o)); };
const wsOpen = (p) => !!p?.ws && p.ws.readyState === 1;
const httpActive = (p, now = Date.now()) => now - p.httpLast < 1500;
/** the channel the phone is relaying on right now (the game shows it) */
const padMode = (p, now = Date.now()) => (wsOpen(p) && now - p.wsLast < 1500 ? 'ws' : httpActive(p, now) ? 'http' : wsOpen(p) ? 'ws' : p.mode);
function sendPad(o) {
  if (!pad) return;
  const s = typeof o === 'string' ? o : JSON.stringify(o);
  if (wsOpen(pad)) pad.ws.send(s);
  // a phone that is POSTing gets its messages in the next response (it may have given up on a socket that still
  // looks open from here)
  if (httpActive(pad) || !wsOpen(pad)) {
    if (s.startsWith('{"t":"st"')) pad.st = s; // only the newest status is worth delivering
    else if (!s.startsWith('{"t":"k"')) { pad.q.push(s); if (pad.q.length > 8) pad.q.shift(); }
  }
}

function notifyMode(p) {
  const m = padMode(p);
  if (m !== p.mode) { p.mode = m; sendGame({ t: 'pad', on: true, mode: m, re: 1 }); log(`phone link now ${m}`); }
}

/** the phone with session `sid` spoke (over `kind`): make it the active one, replacing any other */
function padFor(sid, kind, req, ws = null) {
  const now = Date.now();
  if (pad && pad.sid !== sid) {
    replacedSids.add(pad.sid);
    if (replacedSids.size > 32) replacedSids.delete(replacedSids.values().next().value);
    if (pad.ws) try { pad.ws.close(4001, 'replaced'); } catch { /* gone */ }
    pad = null;
  }
  const fresh = !pad;
  if (fresh) pad = { sid, ws: null, wsLast: 0, httpLast: 0, last: now, since: now, st: null, q: [], remote: '', local: '', mode: kind, rtcRl: new RateLimit(1, 4) };
  const sock = req?.socket;
  if (sock) { pad.remote = plain(sock.remoteAddress); pad.local = plain(sock.localAddress); }
  if (ws && pad.ws !== ws) {
    if (pad.ws) try { pad.ws.terminate(); } catch { /* gone */ } // the phone reconnected: the old socket is dead
    pad.ws = ws;
  }
  pad.last = now;
  if (kind === 'http') pad.httpLast = now; else pad.wsLast = now;
  if (fresh) {
    log(`phone connected (${kind})`);
    sendGame({ t: 'pad', on: true, mode: kind });
    sendPad({ t: 'game', on: !!game });
  } else notifyMode(pad);
  return pad;
}
function dropPad(p, why) {
  if (pad !== p) return;
  pad = null;
  log(`phone disconnected (${why})`);
  sendGame({ t: 'pad', on: false });
}

/** one validated message from the active pad; `ch` = the channel it came in on */
function onPadMsg(p, raw, ch) {
  const m = sanitizePadMsg(raw);
  if (!m) return null;
  if (m.t === 'in') { m.c = ch; sendGame(m); return m; }
  if (m.t === 'ping') { if (game) sendGame(m); else sendPad({ t: 'pong', ts: m.ts, srv: 1 }); return m; }
  if (m.t === 'stat') { sendGame(m); return m; }
  if (m.t === 'rtc' && p.rtcRl.take(Date.now())) {
    // the phone's mDNS candidates also on the address this connection comes from
    sendGame({ ...m, sdp: addLanCandidates(m.sdp, isPrivate4(p.remote) ? p.remote : '') });
  }
  return m;
}
function onGameMsg(raw) {
  const m = sanitizeGameMsg(raw);
  if (!m || !pad) return;
  // the Mac's mDNS candidates also on the address the phone reached this server on
  if (m.t === 'rtc') m.sdp = addLanCandidates(m.sdp, isPrivate4(pad.local) ? pad.local : '');
  sendPad(m);
}

function badCode() {
  const now = Date.now();
  if (now - badCodes.t > 60000) badCodes = { n: 0, t: now };
  badCodes.n++;
}
const lockedOut = () => Date.now() - badCodes.t < 60000 && badCodes.n > 30;

// a phone with no open socket and nothing from it for 2 s is gone. The grace period lets it reconnect (it does so
// within ~0.1–0.8 s) without the game dropping its state and its data channel; the game rides out the input gap on its
// own (hold, then ease to centre). The reported channel follows what the phone uses.
const GONE_MS = 2000;
setInterval(() => {
  if (!pad) return;
  if (!wsOpen(pad) && Date.now() - Math.max(pad.httpLast, pad.wsLast) > GONE_MS) dropPad(pad, 'timeout');
  else notifyMode(pad);
}, 100).unref();

// ---------------------------------------------------------------- websocket
// perMessageDeflate off (no compression: 100-byte packets, latency first); `ws` turns Nagle off (setNoDelay) on every
// socket it accepts. maxPayload fits a WebRTC offer.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false, clientTracking: false });

function attachGame(ws) {
  if (game && game !== ws) try { game.close(4002, 'replaced'); } catch { /* gone */ }
  game = ws;
  log('game page connected');
  const rl = new RateLimit(60, 30);
  ws.send(JSON.stringify(pad ? { t: 'pad', on: true, mode: padMode(pad) } : { t: 'pad', on: false }));
  sendPad({ t: 'game', on: true });
  ws.on('message', (data, isBinary) => { if (!isBinary && rl.take(Date.now())) onGameMsg(data.toString()); });
  ws.on('close', () => { if (game === ws) { game = null; sendPad({ t: 'game', on: false }); log('game page disconnected'); } });
  ws.on('error', () => {});
}

function attachPadWs(ws, sid, req) {
  ws._socket?.setNoDelay?.(true);
  notifyMode(padFor(sid, 'ws', req, ws));
  const rl = new RateLimit(150, 60);
  // heartbeat: ping every second; a socket that has been silent for 5 s (no message, no pong) is dropped. Not
  // shorter: TCP holds data through a Wi-Fi hiccup and releases it late, and the phone replaces a quiet socket by
  // itself after 0.8 s anyway.
  let seen = Date.now();
  const hb = setInterval(() => {
    if (Date.now() - seen > 5000) { ws.terminate(); return; }
    try { ws.ping(); } catch { /* closing */ }
  }, 1000);
  ws.on('pong', () => { seen = Date.now(); });
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    seen = now;
    if (isBinary || !rl.take(now)) return;
    if (replacedSids.has(sid)) return;
    const me = pad && pad.sid === sid && pad.ws === ws ? pad : padFor(sid, 'ws', req, ws);
    me.last = me.wsLast = now;
    const m = onPadMsg(me, data.toString(), 'ws');
    // ack every input packet at once: the phone measures the round trip per packet, and data going back means the
    // phone's TCP gets its ACK piggybacked instead of waiting for a delayed ACK (Nagle on the phone side)
    if (m?.t === 'in' && ws.readyState === 1) ws.send(`{"t":"k","q":${m.q}}`);
  });
  ws.on('close', () => {
    clearInterval(hb);
    if (pad && pad.ws === ws) { pad.ws = null; pad.wsLast = Date.now(); notifyMode(pad); } // gone after GONE_MS unless it reconnects
  });
  ws.on('error', () => {});
}

const sidOk = (s) => typeof s === 'string' && /^[A-Za-z0-9]{6,32}$/.test(s);

function onUpgrade(kind) {
  return (req, socket, head) => {
    socket.on('error', () => {});
    let u;
    try { u = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    const remote = req.socket.remoteAddress;
    if (u.pathname !== '/ws' || !remoteOk(remote)) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const role = u.searchParams.get('role');
    if (kind === 'http' && role === 'game' && isLoopback(remote) && hostIsLocal(req) && originIsLocal(req)) {
      wss.handleUpgrade(req, socket, head, attachGame);
      return;
    }
    if (kind === 'https' && role === 'pad') {
      const sid = u.searchParams.get('sid');
      if (lockedOut()) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // accept-then-close so the page can tell "wrong code" (4003) from "network" (1006)
        if (!codeMatches(u.searchParams.get('k'), CODE)) { badCode(); ws.close(4003, 'bad code'); return; }
        if (!sidOk(sid)) { ws.close(4004, 'bad sid'); return; }
        if (replacedSids.has(sid)) { ws.close(4001, 'replaced'); return; }
        attachPadWs(ws, sid, req);
      });
      return;
    }
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  };
}

// ---------------------------------------------------------------- http helpers
function hostIsLocal(req) {
  const h = (req.headers.host ?? '').toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h); // DNS-rebinding guard
}
function originIsLocal(req) {
  const o = req.headers.origin;
  if (!o) return true; // non-browser client (tests)
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o.toLowerCase());
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ktx2': 'image/ktx2',
};
const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
};
const json = (res, code, o) => send(res, code, JSON.stringify(o), 'application/json; charset=utf-8');

/** static files under root; rejects traversal (.., encoded or not, symlinks pointing outside) */
function serveStatic(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'bad path'); }
  if (p.includes('\0') || p.includes('\\')) return send(res, 400, 'bad path');
  if (p.endsWith('/')) p += 'index.html';
  let f = path.resolve(root, '.' + path.posix.normalize(p));
  const inside = (x) => x === root || x.startsWith(root + path.sep);
  if (!inside(f)) return send(res, 403, 'forbidden');
  let st;
  try { f = fs.realpathSync(f); st = fs.statSync(f); } catch { return send(res, 404, 'not found'); }
  if (!inside(f)) return send(res, 403, 'forbidden');
  if (st.isDirectory()) { f = path.join(f, 'index.html'); try { st = fs.statSync(f); } catch { return send(res, 404, 'not found'); } }
  const lm = st.mtime.toUTCString();
  if (req.headers['if-modified-since'] === lm) { res.writeHead(304); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size,
    'Last-Modified': lm, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
}

/** the phone page as one HTML document: CSS and JS inlined, so nothing else has to load over the self-signed cert */
function padHtml() {
  const rd = (n) => fs.readFileSync(path.join(PAD_DIR, n), 'utf8');
  const core = rd('padcore.js').replace(/^export (?=(const|let|function|class) )/gm, '');
  const app = rd('pad.js').replace(/^import [^\n]*\n/gm, '');
  return rd('index.html')
    .replace('<!--PAD_CSS-->', () => `<style>\n${rd('pad.css')}\n</style>`)
    .replace('<!--PAD_JS-->', () => `<script type="module">\n${core}\n${app}\n</script>`);
}
function servePad(req, res) {
  try { send(res, 200, padHtml(), 'text/html; charset=utf-8', { 'Referrer-Policy': 'no-referrer' }); } catch (e) { send(res, 500, String(e)); }
}

function readBody(req, max) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    // over the limit: discard (so a 413 can still be answered), hang up only on something absurd
    req.on('data', (c) => { n += c.length; if (n > 65536) { resolve(null); req.destroy(); } else if (n <= max) chunks.push(c); });
    req.on('end', () => resolve(n > max ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const httpRl = new Map(); // sid → RateLimit
async function padIo(req, res, u) {
  if (req.method !== 'POST') return send(res, 405, 'method not allowed');
  if (lockedOut()) return json(res, 429, { err: 'busy' });
  if (!codeMatches(u.searchParams.get('k'), CODE)) { badCode(); return json(res, 403, { err: 'code' }); }
  const sid = u.searchParams.get('sid');
  if (!sidOk(sid)) return json(res, 400, { err: 'sid' });
  if (replacedSids.has(sid)) return json(res, 409, { err: 'replaced' });
  let rl = httpRl.get(sid);
  if (!rl) { rl = new RateLimit(100, 40); httpRl.set(sid, rl); if (httpRl.size > 16) httpRl.delete(httpRl.keys().next().value); }
  const now = Date.now();
  if (!rl.take(now)) return json(res, 429, { err: 'rate' });
  const body = await readBody(req, 16384); // fits a WebRTC offer
  if (body === null) return json(res, 413, { err: 'size' });
  let msgs;
  try { msgs = JSON.parse(body).m; } catch { return json(res, 400, { err: 'json' }); }
  if (!Array.isArray(msgs)) return json(res, 400, { err: 'json' });
  if (replacedSids.has(sid)) return json(res, 409, { err: 'replaced' });
  const me = padFor(sid, 'http', req);
  for (const m of msgs.slice(0, 6)) onPadMsg(me, JSON.stringify(m), 'http');
  const out = me.q; me.q = [];
  if (me.st) { out.push(me.st); me.st = null; }
  send(res, 200, `{"game":${game ? 1 : 0},"m":[${out.join(',')}]}`, 'application/json; charset=utf-8');
}

// ---------------------------------------------------------------- servers
let addrs = lanAddrs();

function pairInfo() {
  const url = (ip) => `https://${ip}:${HTTPS_PORT}/pad?k=${CODE}`;
  const list = addrs.map((a) => ({
    ip: a.address, iface: a.name, kind: a.kind, label: a.label, virtual: a.virtual, url: url(a.address),
    listening: httpsServers.has(a.bind),
  }));
  const best = list.find((a) => a.listening && !a.virtual) ?? list.find((a) => a.listening) ?? null;
  return {
    ok: true, server: 'dustmark-serve', dir: DIR, code: CODE, port: PORT, httpsPort: HTTPS_PORT,
    url: best?.url ?? null,
    default: best?.ip ?? null,
    addrs: list,
    urls: list.map((a) => ({ ip: a.ip, url: a.url, primary: a.ip === best?.ip })), // older pairing panels
    game: !!game,
    pad: pad ? { mode: padMode(pad), since: pad.since } : null,
  };
}

const gameServer = (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !hostIsLocal(req)) return send(res, 403, 'forbidden');
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad url'); }
  if (u.pathname === '/pair-info') return json(res, 200, pairInfo());
  if (u.pathname === '/pad' || u.pathname === '/pad/') return servePad(req, res); // local preview of the phone page
  serveStatic(req, res, DIR);
};

const padServer = (req, res) => {
  if (!remoteOk(req.socket.remoteAddress)) { req.socket.destroy(); return; }
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad url'); }
  if (u.pathname === '/pad' || u.pathname === '/pad/') return servePad(req, res);
  if (u.pathname === '/pad/io') return void padIo(req, res, u).catch(() => send(res, 500, 'error'));
  if (u.pathname === '/') { res.writeHead(302, { Location: '/pad' + u.search }); res.end(); return; }
  send(res, 404, 'not found');
};

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}

const httpServers = [];
/** bind address → {server, ip (the address its certificate is for), fp} */
const httpsServers = new Map();
const bindFailed = new Set();
function makeHttps(c) {
  const s = https.createServer({ key: c.key, cert: c.cert }, padServer);
  s.on('upgrade', onUpgrade('https'));
  s.on('tlsClientError', () => {}); // phones that have not accepted the certificate yet abort the handshake
  s.on('connection', (sock) => sock.setNoDelay(true)); // POST fallback: no Nagle on the responses either
  s.keepAliveTimeout = 30000;
  return s;
}

/** listen on every address in `want` ({ip, bind}); stop listening on addresses that went away */
async function bindHttps(want) {
  for (const { ip, bind } of want) {
    const have = httpsServers.get(bind);
    let c;
    try { c = certFor(ip); } catch (e) { log(`certificate for ${ip} failed: ${e.message}`); if (ip === '127.0.0.1') throw e; continue; }
    if (have && have.ip === ip) {
      if (have.fp !== c.fp) { have.server.setSecureContext({ key: c.key, cert: c.cert }); have.fp = c.fp; } // renewed near expiry
      continue;
    }
    if (have) { have.server.close(); httpsServers.delete(bind); }
    const s = makeHttps(c);
    try { await listen(s, bind, HTTPS_PORT); httpsServers.set(bind, { server: s, ip, fp: c.fp }); bindFailed.delete(bind); } catch (e) {
      if (!bindFailed.has(bind)) log(`https ${bind}:${HTTPS_PORT} failed: ${e.code ?? e.message}`);
      bindFailed.add(bind);
      if (bind === '127.0.0.1') throw e;
    }
  }
  const binds = new Set(want.map((w) => w.bind));
  for (const [b, h] of httpsServers) if (!binds.has(b)) { h.server.close(); httpsServers.delete(b); log(`stopped listening on ${b}`); }
}
const wanted = () => [{ ip: '127.0.0.1', bind: '127.0.0.1' }, ...addrs.map((a) => ({ ip: a.address, bind: a.bind }))];

async function main() {
  for (const h of ['127.0.0.1', '::1']) {
    const s = http.createServer(gameServer);
    s.on('upgrade', onUpgrade('http'));
    try { await listen(s, h, PORT); httpServers.push(s); } catch (e) {
      if (h === '127.0.0.1') { console.error(`[dustmark] port ${PORT} busy (${e.code})`); process.exit(1); }
    }
  }
  try { await bindHttps(wanted()); } catch (e) { console.error(`[dustmark] https port ${HTTPS_PORT} busy (${e.code ?? e.message})`); process.exit(1); }
  const info = pairInfo();
  console.log(`[dustmark] game http://localhost:${PORT}/   phone ${info.url ?? '(no LAN address)'}   (K in game = pairing panel)`);

  // interfaces come and go (cable plugged in, hotspot on, Wi-Fi changed): rebind within ~2 s, no restart needed
  let busy = false, retryAt = 0;
  setInterval(async () => {
    if (busy) return;
    const next = lanAddrs();
    const key = (l) => l.map((a) => `${a.name}=${a.address}/${a.kind}/${a.bind}`).join();
    // an address that could not be bound yet (just appeared, still being configured) is retried every 10 s
    const missing = addrs.some((a) => !httpsServers.has(a.bind)) && Date.now() > retryAt;
    if (key(next) === key(addrs) && !missing) return;
    if (missing) retryAt = Date.now() + 10000;
    addrs = next;
    busy = true;
    try {
      await bindHttps(wanted());
      log(`LAN addresses now ${addrs.map((a) => `${a.address} (${a.name}, ${a.kind})`).join(', ') || '(none)'}`);
    } catch (e) { log('rebind failed', e.message); }
    busy = false;
  }, 2000).unref();
}

const stop = () => { for (const s of [...httpServers, ...[...httpsServers.values()].map((h) => h.server)]) s.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
main().catch((e) => { console.error('[dustmark]', e); process.exit(1); });
