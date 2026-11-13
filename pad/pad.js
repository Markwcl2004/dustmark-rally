import { BTN, PAD_ACTIONS, PAD_DEFAULTS, LowPass, holdAngle, shapeSteer, pedalValue, clamp, sanitizeGameMsg, Rolling } from './padcore.js';
// Phone steering-wheel page. Served by scripts/serve.mjs as one HTML document (padcore.js + this file inlined).
//
// iOS notes (checked against MDN / WebKit, not from memory):
//  - DeviceMotionEvent.requestPermission() rejects with NotAllowedError unless called with transient user activation
//    (MDN "DeviceMotionEvent: requestPermission() static method"), so both requestPermission calls are made
//    synchronously inside the 开始 click handler, before any await.
//  - The permission is remembered per origin; a self-signed origin that changes certificate / IP is a new prompt.
//  - wss:// to a self-signed host fails on iOS even after the page's certificate warning was accepted (WebKit bug
//    145819) → while no WebSocket is open we relay over fetch() POSTs to the same origin (/pad/io) and keep retrying
//    the socket in the background.
//  - Wake Lock: Safari ≥ 16.4; may be refused (NotAllowedError) or silently ignored (Low Power Mode, older standalone
//    web apps, WebKit bug 254545); it is also released whenever the page is hidden and must be re-requested on
//    visibilitychange. Without it: a muted, inline, looping 16 × 16 video (the NoSleep.js technique) — iOS does not
//    auto-lock while a video plays.
//  - WebRTC data channels work in iOS Safari ≥ 11 without camera permission; host candidates are then mDNS names
//    (xxxx.local). No STUN / TURN servers are configured (iceServers: []): nothing is sent outside the LAN.
//  - accelerationIncludingGravity has the opposite sign on iOS vs the spec/Android; holdAngle() is sign-agnostic,
//    and there is a 反向 switch in the settings anyway.
//  - iPhone Safari has no element Fullscreen API (iPadOS does) and no vibration API.
//
// Link (see docs/PHONE.md "连接"): every input packet goes out on every open channel — the UDP data channel
// (unordered, no retransmits: a lost packet is simply replaced by the next one 16 ms later) and the relay (WebSocket,
// or POSTs while no socket is open). The game keeps the newest by (ts, q). Acks per packet give round-trip times per
// channel; the page shows them, and sends a summary to the game twice a second.

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const epoch = () => performance.timeOrigin + performance.now();
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const sget = (k) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const sset = (k, v) => { try { store?.setItem(k, v); } catch { /* private mode */ } };

if (q.get('sim') === 'notch') document.body.classList.add('simnotch');

// ---------------------------------------------------------------- pairing code + session id
let key = q.get('k');
if (key) sset('dustmark.pad.k', key); else key = sget('dustmark.pad.k');
let sid = null;
try { sid = sessionStorage.getItem('dustmark.pad.sid'); } catch { /* */ }
if (!sid) {
  sid = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  try { sessionStorage.setItem('dustmark.pad.sid', sid); } catch { /* */ }
}

// ---------------------------------------------------------------- settings
const cfg = { ...PAD_DEFAULTS, zero: 0 };
try { Object.assign(cfg, JSON.parse(sget('dustmark.pad.cfg') ?? '{}')); } catch { /* */ }
cfg.zero = 0;
const saveCfg = () => { const { zero, ...rest } = cfg; sset('dustmark.pad.cfg', JSON.stringify(rest)); };

// ---------------------------------------------------------------- screens
const screens = ['sStart', 'sDeny', 'sNoKey', 'sBadKey', 'sReplaced', 'sDown'];
function show(id) { for (const s of screens) $(s).classList.toggle('on', s === id); }

// ---------------------------------------------------------------- state
const st = {
  started: false, angle: 0, steer: 0, ok: false, side: 0, ev: 0, motionAt: 0,
  th: 0, br: 0, bits: 0, latch: 0, counters: PAD_ACTIONS.map(() => 0),
};
let hold = { side: 0, reliable: true };
const lp = new LowPass(12);
let lastMotionT = 0;
const motionRate = new Rolling(2000);

// ---------------------------------------------------------------- start / permissions
$('bStart').addEventListener('click', onStart);
$('bRetry').addEventListener('click', onStart);
// a page that was taken over keeps its session id across a reload (sessionStorage): start a new session instead
$('bReload').addEventListener('click', () => { try { sessionStorage.removeItem('dustmark.pad.sid'); } catch { /* */ } location.reload(); });

function onStart() {
  // both calls happen synchronously in the click's call stack (transient activation)
  const DME = window.DeviceMotionEvent, DOE = window.DeviceOrientationEvent;
  const motionReq = DME && typeof DME.requestPermission === 'function' ? DME.requestPermission() : Promise.resolve('granted');
  const orientReq = DOE && typeof DOE.requestPermission === 'function' ? DOE.requestPermission() : Promise.resolve('granted');
  orientReq.catch(() => {}); // orientation is not used for steering; only motion has to be granted
  primeVideo(); // inside the gesture: a later play() of the keep-awake video needs it on iOS
  requestWakeLock();
  try { const r = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); r?.catch?.(() => {}); } catch { /* iPhone: unsupported */ }
  try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch { /* unsupported */ }
  motionReq.then((r) => {
    if (r === 'granted') begin();
    else { $('denyWhy').textContent = `结果：${r}`; show('sDeny'); }
  }).catch((e) => { $('denyWhy').textContent = `${e?.name ?? ''} ${e?.message ?? e}`; show('sDeny'); });
}

function begin() {
  if (st.started) return;
  st.started = true;
  document.body.classList.add('started');
  show(null);
  addEventListener('devicemotion', onMotion);
  link.connect();
  schedule(0);
  setTimeout(() => { if (!st.motionAt) $('wSensor').classList.add('on'); }, 1500);
}

// ---------------------------------------------------------------- keep the screen on
let wakeLock = null, awake = '';
const VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMebW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAm10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAAAAABAAAAAAHlbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABkG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVBzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMAEDxYuSABAAVoy4PEyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAC2AAAAAAAAABhzdHRzAAAAAAAAAAEAAAAIAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAIAAAAAQAAADRzdHN6AAAAAAAAAAAAAAAIAAAAEwAAAAsAAAALAAAACgAAAAoAAAAKAAAACgAAAAoAAAAUc3RjbwAAAAAAAAABAAADTgAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAACGlsc3QAAAAIZnJlZQAAAGNtZGF0AAAAD2WIhAXzn///D0UAAVefgAAAAAdBmjgL5zqAAAAAB0GaVAL5zqAAAAAGQZpgF851AAAABkGagBfOdQAAAAZBmqAXznUAAAAGQZrAF851AAAABkGa4BXOdQ==';
let video = null;
function primeVideo() {
  if (video) return;
  video = document.createElement('video');
  video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.loop = true;
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none';
  video.src = VIDEO;
  document.body.appendChild(video);
  // load inside the gesture; it only plays if the Wake Lock API is missing or refused
  try { video.load(); } catch { /* */ }
}
async function requestWakeLock() {
  const note = $('wLock');
  try {
    if (!navigator.wakeLock) throw new Error('unsupported');
    wakeLock = await navigator.wakeLock.request('screen');
    awake = 'lock';
    video?.pause();
    note.classList.remove('on');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  } catch {
    // fallback: a playing inline video keeps iOS from auto-locking
    try { await video?.play(); awake = 'video'; note.classList.remove('on'); return; } catch { /* autoplay refused */ }
    awake = '';
    note.textContent = '屏幕可能会自动锁定（低电量模式或系统不支持防息屏）。可在 设置 › 显示与亮度 › 自动锁定 选“永不”，玩完再改回。';
    note.classList.add('on');
  }
}
function onResume() {
  if (!st.started) return;
  requestWakeLock();
  link.resume();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onResume(); });
addEventListener('pageshow', (e) => { if (e.persisted) onResume(); });

// ---------------------------------------------------------------- motion → steering
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null || g.z == null) return;
  const t = e.timeStamp || performance.now();
  const dt = lastMotionT ? (t - lastMotionT) / 1000 : 1 / 60;
  lastMotionT = t;
  motionRate.push(performance.now(), 1);
  const v = lp.step([g.x, g.y, g.z], dt);
  const h = holdAngle(v[0], v[1], v[2], hold);
  if (hold.side !== 0 && h.side !== hold.side) cfg.zero = 0; // phone turned round: the old zero belongs to the other hold
  hold = h;
  st.angle = h.angle; st.ok = h.reliable; st.side = h.side;
  st.steer = h.reliable && !portrait() ? shapeSteer(h.angle, cfg) : 0;
  st.ev = performance.timeOrigin + t;
  if (!st.motionAt) $('wSensor').classList.remove('on');
  st.motionAt = t;
  sendSoon(MOTION_GAP);
}
const portraitMq = matchMedia('(orientation: portrait)');
const portrait = () => portraitMq.matches;

// ---------------------------------------------------------------- touch
const zones = { brake: $('zBrake'), gas: $('zGas') };
/** touch id → {kind:'pedal', zone, y0, y} | {kind:'btn', name, el} */
const touches = new Map();
const HELD = { hb: BTN.HB, up: BTN.UP, dn: BTN.DN };

function isNative(t) { return t instanceof Element && !!t.closest('.native'); }
document.addEventListener('touchstart', onTouch, { passive: false });
document.addEventListener('touchmove', onTouch, { passive: false });
document.addEventListener('touchend', onTouch, { passive: false });
document.addEventListener('touchcancel', onTouch, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu', 'selectstart']) {
  document.addEventListener(ev, (e) => { if (!isNative(e.target)) e.preventDefault(); }, { passive: false });
}

function onTouch(e) {
  if (isNative(e.target)) return; // start/settings screens use normal clicks
  e.preventDefault();
  if (!st.started) return;
  // the "连接断开" overlay does not block the controls: a pedal pressed while the link comes back is there when it does
  const ctlOn = !portrait() && !$('sSettings').classList.contains('on');
  for (const t of e.changedTouches) {
    if (e.type === 'touchstart') {
      if (!ctlOn) continue;
      const btn = document.elementsFromPoint(t.clientX, t.clientY).find((el) => el.closest('#ctl'))?.closest?.('[data-btn]');
      if (btn) { touches.set(t.identifier, { kind: 'btn', name: btn.dataset.btn, el: btn }); press(btn.dataset.btn, btn); }
      else {
        const zone = t.clientX < innerWidth / 2 ? 'brake' : 'gas';
        touches.set(t.identifier, { kind: 'pedal', zone, y0: t.clientY, x0: t.clientX, y: t.clientY });
      }
    } else if (e.type === 'touchmove') {
      const s = touches.get(t.identifier);
      if (s?.kind === 'pedal') s.y = t.clientY;
    } else {
      const s = touches.get(t.identifier);
      touches.delete(t.identifier);
      if (s?.kind === 'btn') release(s.name, s.el);
    }
  }
  updatePedals();
  sendSoon(TOUCH_GAP);
}

function press(name, el) {
  if (HELD[name]) { st.bits |= HELD[name]; st.latch |= HELD[name]; el.classList.add('on'); return; }
  flash(el);
  const ai = PAD_ACTIONS.indexOf(name);
  if (ai >= 0) { st.counters[ai] = (st.counters[ai] + 1) & 255; return; }
  if (name === 'center') { if (st.ok) cfg.zero = st.angle; return; }
  if (name === 'settings') openSettings();
}
function release(name, el) {
  if (HELD[name]) {
    // another finger may still hold the same button
    for (const s of touches.values()) if (s.kind === 'btn' && s.name === name) return;
    st.bits &= ~HELD[name]; el.classList.remove('on');
  }
}
function flash(el) { el.classList.add('flash', 'on'); setTimeout(() => el.classList.remove('flash', 'on'), 160); }

function updatePedals() {
  const val = { brake: 0, gas: 0 };
  let markAt = { brake: null, gas: null };
  for (const s of touches.values()) {
    if (s.kind !== 'pedal') continue;
    const v = pedalValue(s.y0, s.y, cfg.travel, cfg.pedal);
    if (v > val[s.zone]) { val[s.zone] = v; markAt[s.zone] = s; }
  }
  st.br = val.brake; st.th = val.gas;
  for (const z of ['brake', 'gas']) {
    const el = zones[z], v = val[z];
    el.classList.toggle('on', v > 0);
    el.querySelector('.fill').style.height = `${(v * 100).toFixed(1)}%`;
    el.querySelector('.pct').textContent = v > 0 ? `${Math.round(v * 100)}%` : '0';
    const m = markAt[z], mk = el.querySelector('.mark');
    if (m) {
      const r = el.getBoundingClientRect();
      mk.style.left = `${m.x0 - r.left}px`; mk.style.top = `${m.y0 - r.top}px`;
      mk.querySelector('.t100').style.top = `${-cfg.travel - 2}px`;
      mk.querySelector('.t20').style.top = `${cfg.travel - 2}px`;
      mk.querySelectorAll('b').forEach((b) => { b.style.display = cfg.pedal === 'analog' ? '' : 'none'; });
    }
  }
}
// orientation change / settings sheet: drop everything held so nothing sticks
function releaseAll() {
  for (const s of touches.values()) if (s.kind === 'btn') s.el.classList.remove('on');
  touches.clear(); st.bits = 0; updatePedals();
}
portraitMq.addEventListener?.('change', releaseAll);

// ---------------------------------------------------------------- settings sheet
const S = { range: $('iRange'), dz: $('iDz'), curve: $('iCurve'), inv: $('iInv'), pedal: $('iPedal') };
function syncSettings() {
  S.range.value = cfg.range; S.dz.value = cfg.deadzone; S.curve.value = cfg.curve; S.inv.checked = !!cfg.invert; S.pedal.value = cfg.pedal;
  $('oRange').textContent = `±${cfg.range}°`; $('oDz').textContent = `${cfg.deadzone}°`; $('oCurve').textContent = Number(cfg.curve).toFixed(2);
}
function openSettings() { releaseAll(); syncSettings(); $('sSettings').classList.add('on'); }
S.range.oninput = () => { cfg.range = clamp(+S.range.value, 30, 90); syncSettings(); saveCfg(); };
S.dz.oninput = () => { cfg.deadzone = clamp(+S.dz.value, 0, 10); syncSettings(); saveCfg(); };
S.curve.oninput = () => { cfg.curve = clamp(+S.curve.value, 1, 2.2); syncSettings(); saveCfg(); };
S.inv.onchange = () => { cfg.invert = S.inv.checked; saveCfg(); };
S.pedal.onchange = () => { cfg.pedal = S.pedal.value === 'switch' ? 'switch' : 'analog'; saveCfg(); };
$('bDone').addEventListener('click', () => $('sSettings').classList.remove('on'));

// ---------------------------------------------------------------- sending: a steady 60 Hz, plus changes at once
// A packet goes out every 16.7 ms whatever the sensor does (iOS delivers devicemotion at ~60 Hz but not evenly, and
// stops it in some states); a new sensor reading goes out at once if the last packet is ≥ 12 ms old, a touch change
// if it is ≥ 8 ms old (else in the free slot). So the game sees ≥ 60 Hz, and a press is never 16 ms late.
const SEND_MS = 1000 / 60, MOTION_GAP = 12, TOUCH_GAP = 8;
let seq = 0, lastSent = -1e9, sendTimer = 0;
const sendRate = new Rolling(2000);
/** q → send time, for round trips from acks */
const sentQ = new Int32Array(256).fill(-1), sentT = new Float64Array(256);
function packet() {
  const live = !portrait() && !$('sSettings').classList.contains('on');
  const b = live ? st.bits | st.latch : 0;
  st.latch = 0;
  return { t: 'in', q: ++seq, ts: epoch(), ev: st.ev, s: live ? st.steer : 0, th: live ? st.th : 0, br: live ? st.br : 0, b, a: st.counters, ok: st.ok ? 1 : 0 };
}
function sendNow() {
  const now = performance.now();
  lastSent = now;
  const p = packet();
  sentQ[p.q & 255] = p.q; sentT[p.q & 255] = now;
  sendRate.push(now, 1);
  link.send(p);
  schedule(SEND_MS);
}
function schedule(ms) { clearTimeout(sendTimer); sendTimer = setTimeout(() => { sendTimer = 0; if (st.started) sendNow(); }, ms); }
function sendSoon(minGap) {
  if (!st.started) return;
  const wait = minGap - (performance.now() - lastSent);
  if (wait <= 0) sendNow();
  else if (wait < SEND_MS - (performance.now() - lastSent)) schedule(wait);
}

// ---------------------------------------------------------------- link
/** per-channel round trips (ms) over the last 5 s */
const rtt = { dc: new Rolling(5000), ws: new Rolling(5000), http: new Rolling(5000) };
const NAMES = { dc: 'UDP', ws: 'WebSocket', http: 'HTTPS 备用' };
const SHORT = { dc: 'UDP', ws: 'WS', http: 'POST' };
const WS_STALE_MS = 800;   // open socket but no ack / message for this long → reconnect at once
const DOWN_MS = 2000;      // nothing from any channel this long → full-screen "连接断开"

const link = {
  /** relay transport in use: 'ws' while a WebSocket is open, else 'http' (POSTs) */
  mode: 'ws',
  forceHttp: q.get('transport') === 'http',
  ws: null, wsTries: 0, wsTimer: 0, wsEver: sget(`dustmark.pad.wsok.${location.host}`) === '1',
  wsNever: sget(`dustmark.pad.wsok.${location.host}`) === '0',
  state: 'idle', game: false, rx: { dc: 0, ws: 0, http: 0 }, lastOk: 0, reconnects: 0, resumedAt: 0,
  inflight: 0, queue: [], httpFails: 0, lq: null, rtt: 0,
  connect() {
    if (!key) { show('sNoKey'); return; }
    this.setState('connecting');
    if (this.forceHttp || this.wsNever) { this.mode = 'http'; this.pump(); if (!this.forceHttp) this.retryWs(1000); }
    else this.openWs();
  },
  /**
   * page visible again / back from the back-forward cache: a closed socket is reopened now; an open one gets 300 ms to
   * show it is alive (the server acks every packet) before it is replaced — iOS may have dropped it silently.
   */
  resume() {
    const now = performance.now();
    this.resumedAt = now;
    if (!this.forceHttp) {
      if (!this.ws || this.ws.readyState > 1) { this.reconnects++; this.openWs(); }
      else this.rx.ws = Math.max(this.rx.ws, now - WS_STALE_MS + 300);
    }
    if (this.mode === 'http') this.pump();
    sendNow();
    rtc.resume();
  },
  retryWs(ms) { clearTimeout(this.wsTimer); this.wsTimer = setTimeout(() => this.openWs(), ms); },
  openWs() {
    if (this.forceHttp || this.state === 'badkey' || this.state === 'replaced') return;
    clearTimeout(this.wsTimer);
    const old = this.ws;
    if (old) { this.ws = null; try { old.close(); } catch { /* */ } }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/ws?role=pad&k=${encodeURIComponent(key)}&sid=${sid}`); } catch { this.wsFailed(false); return; }
    this.ws = ws;
    let opened = false;
    const guard = setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* */ } } }, 2500);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true; clearTimeout(guard); this.wsTries = 0;
      this.rx.ws = performance.now();
      if (!this.wsEver) { this.wsEver = true; this.wsNever = false; sset(`dustmark.pad.wsok.${location.host}`, '1'); }
      this.mode = 'ws'; this.queue = [];
      this.ok();
    };
    ws.onmessage = (m) => { if (this.ws === ws) { this.rx.ws = performance.now(); this.recv(m.data, 'ws'); } };
    ws.onclose = (ev) => {
      clearTimeout(guard);
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4003) { this.setState('badkey'); return; }
      if (ev.code === 4001) { this.setState('replaced'); return; }
      this.wsFailed(opened);
    };
  },
  /** the socket closed or never opened: relay over POSTs meanwhile, retry the socket with back-off */
  wsFailed(wasOpen) {
    // never opened on this host at all → probably iOS refusing wss with a self-signed certificate: remember it so the
    // next visit starts on POSTs right away (the socket is still retried in the background)
    if (!wasOpen && !this.wsEver) { sset(`dustmark.pad.wsok.${location.host}`, '0'); this.wsNever = true; }
    this.mode = 'http';
    this.pump();
    this.wsTries++;
    const back = this.wsNever ? [1000, 10000, 30000] : [0, 300, 1000, 2000, 5000, 10000];
    this.retryWs(back[Math.min(back.length - 1, this.wsTries - 1)] ?? 15000);
  },
  send(o) {
    const s = JSON.stringify(o);
    rtc.send(s);
    if (this.mode === 'ws') { if (this.ws?.readyState === 1) this.ws.send(s); return; }
    if (this.state === 'badkey' || this.state === 'replaced') return;
    // newest input packet only (older ones are superseded); keep pings / stats / signalling
    if (o.t === 'in') this.queue = this.queue.filter((m) => m.t !== 'in');
    this.queue.push(o);
    if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 8);
    this.pump();
  },
  /** a message that must reach the game but not over the data channel (signalling, stats) */
  sendRelay(o) {
    if (this.mode === 'ws' && this.ws?.readyState === 1) { this.ws.send(JSON.stringify(o)); return; }
    this.queue.push(o); this.pump();
  },
  pump() {
    if (this.mode !== 'http' || this.inflight >= 2 || this.state === 'badkey' || this.state === 'replaced') return;
    const body = JSON.stringify({ m: this.queue.splice(0, 6) });
    const t0 = performance.now();
    this.inflight++;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const guard = setTimeout(() => ac?.abort(), 1500); // a hung request on a dead Wi-Fi must not hold a slot
    fetch(`/pad/io?k=${encodeURIComponent(key)}&sid=${sid}`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, cache: 'no-store', signal: ac?.signal })
      .then(async (r) => {
        if (r.status === 403) { this.setState('badkey'); return; }
        if (r.status === 409) { this.setState('replaced'); return; }
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        const now = performance.now();
        rtt.http.push(now, now - t0);
        this.httpFails = 0; this.rx.http = now;
        this.game = !!j.game;
        for (const m of j.m ?? []) this.recv(m, 'http');
        this.ok();
      })
      .catch(() => { this.httpFails++; })
      .finally(() => { clearTimeout(guard); this.inflight--; if (this.mode === 'http' && (this.queue.length || this.httpFails)) setTimeout(() => this.pump(), this.httpFails ? Math.min(500, 50 * this.httpFails) : 0); });
  },
  recv(raw, ch) {
    let o = raw;
    if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return; } }
    if (!o || typeof o !== 'object') return;
    const now = performance.now();
    this.rx[ch] = now;
    if (o.t === 'k') {
      const i = o.q & 255;
      if (sentQ[i] === o.q) rtt[ch].push(now, now - sentT[i]);
      return;
    }
    if (o.t === 'game') { this.game = !!o.on; if (this.game) rtc.kick(); render(); return; }
    if (o.t === 'pad' || o.t === 'ping') return;
    if (o.t === 'pong') { const r = epoch() - o.ts; if (r >= 0 && r < 5000) this.rtt = this.rtt ? this.rtt * 0.7 + r * 0.3 : r; return; }
    const m = sanitizeGameMsg(JSON.stringify(o));
    if (!m) return;
    if (m.t === 'st') { this.game = true; status = m; statusAt = now; rtc.kick(); }
    else if (m.t === 'lq') { this.lq = m; this.lqAt = now; }
    else if (m.t === 'rtc') rtc.answer(m);
  },
  ok() { if (this.state !== 'ok') { this.setState('ok'); rtc.kick(); } },
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (s === 'badkey') { show('sBadKey'); releaseAll(); }
    else if (s === 'replaced') { show('sReplaced'); releaseAll(); rtc.close(); }
    else if (s === 'down') { $('downWhy').textContent = this.mode === 'http' ? '正在重连（HTTPS 备用通道）…' : `正在重连（第 ${this.wsTries || 1} 次）…`; show('sDown'); }
    else show(null);
    render();
  },
  /** newest message from any channel (ms ago) */
  silence(now) { return now - Math.max(this.rx.dc, this.rx.ws, this.rx.http); },
};
// liveness: an open socket that has gone quiet is dead (half-open after Wi-Fi trouble, or the page was suspended);
// a new one is cheaper than waiting for TCP to notice. "连接断开" only after 2 s of total silence — a short gap shows
// in the status line and the game rides it out — and touches are not released by it.
setInterval(() => {
  if (!st.started || link.state === 'badkey' || link.state === 'replaced' || document.visibilityState === 'hidden') return;
  const now = performance.now();
  if (link.mode === 'ws' && link.ws?.readyState === 1 && now - link.rx.ws > WS_STALE_MS) { link.reconnects++; link.openWs(); }
  if (link.mode === 'http' && link.inflight === 0) link.pump();
  const quiet = link.silence(now);
  // (just back from the background the link gets 1.5 s to recover before the overlay)
  if (link.state === 'ok' && quiet > DOWN_MS && now - link.resumedAt > 1500) link.setState('down');
  else if (link.state === 'down' && quiet < 300) link.setState('ok');
}, 100);
// round trip through the game every second (game present?); stats for the game twice a second
setInterval(() => { if (st.started && link.state === 'ok') link.sendRelay({ t: 'ping', ts: epoch() }); }, 1000);
setInterval(() => {
  if (!st.started || link.state !== 'ok') return;
  const now = performance.now(), ch = bestChannel(now), relay = link.mode;
  const r = (c, p) => Math.round(rtt[c].q(now, p) || 0);
  const m = { t: 'stat', ch, r50: r(ch, 0.5), r95: r(ch, 0.95), rd50: r(relay, 0.5), rd95: r(relay, 0.95), hz: Math.round(sendRate.count(now) / 2), mhz: Math.round(motionRate.count(now) / 2), rc: link.reconnects, dc: rtc.state };
  link.sendRelay(m);
}, 500);

/** the channel the game is getting the newest packets on (data channel while it answers, else the relay) */
function bestChannel(now) { return rtc.state === 2 && now - link.rx.dc < 1000 ? 'dc' : link.mode; }

// ---------------------------------------------------------------- WebRTC data channel (unordered, no retransmits)
// The phone makes the offer once the relay is up and a game page is there; the game answers through the relay. Host
// candidates only (iceServers: []), so it only works when the two devices reach each other directly — which they must
// anyway. Not open after 6 s → closed and retried later (10 s, 20 s, … 60 s); meanwhile everything goes over the relay.
// ?rtc=0 turns it off.
const rtc = {
  /** 0 off / not tried, 1 connecting, 2 open, 3 failed (retry later), 4 unsupported */
  state: typeof RTCPeerConnection === 'function' && q.get('rtc') !== '0' ? 0 : 4,
  pc: null, dc: null, id: 0, tries: 0, retryAt: 0, timer: 0,
  /** last state changes with the reason (window.__pad.rtc.log, for debugging on a real phone) */
  log: [],
  note(what) { this.log.push(`${Math.round(performance.now())} ${what}`); if (this.log.length > 30) this.log.shift(); },
  kick() {
    if (this.state === 4 || this.state === 1 || this.state === 2) return;
    if (link.state !== 'ok' || !link.game || performance.now() < this.retryAt) return;
    this.start();
  },
  async start() {
    this.close();
    this.state = 1;
    const id = ++this.id;
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      const dc = pc.createDataChannel('in', { ordered: false, maxRetransmits: 0 });
      this.dc = dc;
      dc.onopen = () => { if (this.dc === dc) { this.state = 2; this.tries = 0; link.rx.dc = performance.now(); clearTimeout(this.timer); this.note('open'); } };
      dc.onmessage = (e) => { if (this.dc === dc) link.recv(e.data, 'dc'); };
      dc.onclose = () => { if (this.dc === dc) { this.note('channel closed'); this.fail(2000); } };
      pc.onconnectionstatechange = () => { if (this.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) { this.note(`pc ${pc.connectionState}`); this.fail(2000); } };
      await pc.setLocalDescription(await pc.createOffer());
      // non-trickle: wait for the host candidates (fast without STUN), at most 1.5 s
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((res) => { const t = setTimeout(res, 1500); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });
      }
      if (this.pc !== pc) return;
      link.sendRelay({ t: 'rtc', id, sdp: pc.localDescription.sdp });
      this.note(`offer ${id} sent (${(pc.localDescription.sdp.match(/a=candidate/g) ?? []).length} candidates)`);
      this.timer = setTimeout(() => { if (this.pc === pc && this.state !== 2) { this.note(`not open after 6 s (ice ${pc.iceConnectionState})`); this.fail(Math.min(60000, 10000 * 2 ** this.tries++)); } }, 6000);
    } catch (e) { if (this.pc === pc) { this.note(`error ${e?.name ?? e}`); this.fail(30000); } }
  },
  async answer(m) {
    if (!this.pc || m.id !== this.id || this.pc.signalingState !== 'have-local-offer') return;
    try { await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); this.note(`answer ${m.id}`); } catch (e) { this.note(`bad answer ${e?.name ?? e}`); this.fail(10000); }
  },
  send(s) {
    const dc = this.dc;
    // a backed-up channel means the path is stalled: drop rather than queue (the next packet supersedes this one)
    if (this.state === 2 && dc && dc.readyState === 'open' && dc.bufferedAmount < 1024) { try { dc.send(s); } catch { /* */ } }
  },
  fail(retryMs) { this.close(); this.state = 3; this.retryAt = performance.now() + retryMs; },
  close() {
    clearTimeout(this.timer);
    const { pc, dc } = this;
    this.pc = null; this.dc = null;
    if (this.state !== 4) this.state = 0;
    try { dc?.close(); } catch { /* */ }
    try { pc?.close(); } catch { /* */ }
  },
  /** back from the background: not open → try again now; open → rebuilt if nothing comes back on it within 600 ms */
  resume() {
    if (this.state === 4) return;
    if (this.state !== 2) { this.retryAt = 0; this.kick(); return; }
    link.rx.dc = Math.max(link.rx.dc, performance.now() - DC_SILENT_MS + 600);
  },
};
const DC_SILENT_MS = 3000;
// retry when due; rebuild a channel that has been silent for 3 s while the relay works
setInterval(() => {
  if (!st.started) return;
  const now = performance.now();
  if (rtc.state === 2 && now - link.rx.dc > DC_SILENT_MS && link.silence(now) < 500) { rtc.note('silent'); rtc.fail(0); }
  rtc.kick();
}, 100);

// ---------------------------------------------------------------- status display
let status = null, statusAt = 0;
const rpmEl = $('gRpm');
const RPM_N = 16;
for (let i = 0; i < RPM_N; i++) { const s = document.createElement('i'); if (i >= 13) s.className = 'red'; else if (i >= 10) s.className = 'amber'; rpmEl.appendChild(s); }
const rpmSegs = Array.from(rpmEl.children);
let lastNote = '', lastDetail = '', detailAt = 0;
const ms = (v) => (Number.isFinite(v) ? Math.round(v) : '–');
function render() {
  const now = performance.now();
  const c = $('cText').parentElement;
  const stale = !status || now - statusAt > 2000;
  const connected = link.state === 'ok';
  const quiet = link.silence(now);
  const ch = bestChannel(now);
  const gap = connected && quiet > 300;
  c.className = `conn ${connected && !gap ? (link.game ? 'ok' : '') : link.state === 'down' || gap ? 'down' : ''}`;
  $('cText').textContent = gap ? `信号中断 ${(quiet / 1000).toFixed(1)} s…`
    : connected
      ? `${link.game ? '已连接' : '已连上电脑'} · ${NAMES[ch]} ${ms(rtt[ch].q(now, 0.5))} ms`
      : link.state === 'down' ? '连接断开' : '连接中…';
  // link detail, 4×/s: round trips (median / p95) per channel, send rate, what the game receives
  if (now - detailAt > 250) {
    detailAt = now;
    const chans = [...(rtc.state === 2 ? ['dc'] : []), link.mode];
    const l1 = chans.map((k) => `${SHORT[k]} ${ms(rtt[k].q(now, 0.5))}/${ms(rtt[k].q(now, 0.95))}`).join(' · ') + ' ms'
      + (rtc.state === 3 ? ' · UDP 未通' : rtc.state === 1 ? ' · UDP 连接中' : '');
    const lq = link.lq && now - link.lqAt < 2000 ? link.lq : null;
    const l2 = `发 ${Math.round(sendRate.count(now) / 2)} Hz` + (lq ? ` · 游戏收 ${Math.round(lq.hz)} Hz · 5 秒断流 ${lq.gp} · 丢 ${lq.lo.toFixed(lq.lo < 10 ? 1 : 0)}%` : '');
    const d = connected ? `${l1}\n${l2}` : '';
    if (d !== lastDetail) { $('cDetail').textContent = d; lastDetail = d; }
  }
  $('wGame').classList.toggle('on', connected && !link.game);
  const cl = document.querySelector('.cluster');
  cl.classList.toggle('nogame', !link.game);
  cl.classList.toggle('untrusted', !st.ok);
  $('wTilt').classList.toggle('on', st.started && !!st.motionAt && !st.ok);
  if (status && !stale) {
    $('gGear').textContent = status.g < 0 ? 'R' : status.g === 0 ? 'N' : String(status.g);
    $('gSpeed').textContent = String(Math.round(status.v));
    const lit = Math.round(status.r * RPM_N);
    rpmSegs.forEach((s, i) => s.classList.toggle('on', i < lit));
    const note = status.n ? `${status.n}<small>${status.d > 0 ? Math.round(status.d) + ' m' : ''}</small>` : status.run ? '' : '等待发车';
    if (note !== lastNote) { $('gNote').innerHTML = note || '&nbsp;'; lastNote = note; }
  } else if (stale && lastNote !== '-') {
    $('gGear').textContent = '–'; $('gSpeed').textContent = '0'; rpmSegs.forEach((s) => s.classList.remove('on'));
    $('gNote').innerHTML = '&nbsp;'; lastNote = '-';
  }
  // steering: wheel icon turns with the output, bar shows −1..1
  const s = st.steer;
  $('sWheel').style.transform = `rotate(${(s * cfg.range).toFixed(1)}deg)`;
  const f = $('sFill');
  f.style.left = s < 0 ? `${50 + s * 50}%` : '50%';
  f.style.width = `${Math.abs(s) * 50}%`;
}
const frame = () => { if (st.started) render(); requestAnimationFrame(frame); };
requestAnimationFrame(frame);

// ---------------------------------------------------------------- boot
if (!key) show('sNoKey'); else show('sStart');
// test / debug hook (read-only view of the state)
window.__pad = { st, cfg, link, rtc, rtt, get hold() { return hold; }, get awake() { return awake; } };
