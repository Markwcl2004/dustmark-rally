// Phone steering wheel: pure functions shared by the phone page (pad/pad.js), the relay (scripts/serve.mjs), the game
// (src/app/phonePad.ts) and the tests. Plain ES module, no imports, no DOM.
// serve.mjs inlines this file into the phone page by stripping the leading `export ` keywords, so keep every export
// at the start of a line and do not use `export default` / `export {}` lists.

/** button bits in the 60 Hz input packet (held state) */
export const BTN = { HB: 1, UP: 2, DN: 4 };
/** edge-triggered actions: the pad sends one 0..255 press counter per action; the game fires when a counter changes */
export const PAD_ACTIONS = ['reset', 'pause', 'camera', 'predict'];

export const PAD_DEFAULTS = {
  /** degrees of wheel rotation for full lock (30–90) */
  range: 60,
  /** degrees around the zero point that give 0 */
  deadzone: 2,
  /** response curve exponent (1 = linear) */
  curve: 1.25,
  /** flip steering direction (in case a browser reports the axes mirrored) */
  invert: false,
  /** 'analog' = press 60 %, slide up 100 %, slide down 20 %;  'switch' = press = 100 % */
  pedal: 'analog',
  /** CSS px of vertical slide from the press point to 100 % (and to 20 % downward) */
  travel: 90,
};

/** in-plane share of gravity below which the angle is not trusted (phone tilted back toward flat), with hysteresis.
 *  0.35 ≈ the screen within ~20° of horizontal; recovers above 0.45 (~27°). */
export const TILT_OFF = 0.35;
export const TILT_ON = 0.45;

const DEG = 180 / Math.PI;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
/** wrap degrees to (-180, 180] */
export const wrapDeg = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d === -180 ? 180 : d; };

/**
 * Rotation of the phone about the screen normal ("steering-wheel angle") from the gravity vector, for a phone held in
 * landscape.
 *
 * Device frame (W3C DeviceOrientation/Motion): x = right edge in portrait, y = top edge in portrait, z = out of the
 * screen. `accelerationIncludingGravity` at rest is the reaction to gravity, i.e. it points UP (+9.81 on z lying flat,
 * per the spec / MDN). iOS Safari reports all three axes with the opposite sign (W3C public-geolocation list,
 * Nov 2014; still observed on iOS 18 / iPadOS 26 — e.g. github.com/soroushdty/gaitscope PR #97). We do not need to know
 * which: a global sign flip is a 180° rotation of the in-plane vector, which does not change rotation *differences*.
 * The hold side (which device x direction currently points up) is detected from the vector itself, so the measured
 * vector is "up" or "down" only changes which side we call +1 — the steering angle comes out the same. Landscape-left
 * and landscape-right holds are therefore both handled, on both sign conventions.
 *
 * Angle sign: + = the phone rotated clockwise as the player looks at the screen (turning a wheel to the right).
 * Derivation: rotating the device by −θ about z (clockwise seen from the front) makes a fixed world vector appear rotated
 * by +θ (counter-clockwise) in device coordinates, so θ = atan2(gy, gx) − φ0 with φ0 the neutral direction (0 or π).
 *
 * @param {number} gx @param {number} gy @param {number} gz  accelerationIncludingGravity (any consistent unit)
 * @param {{side:number, reliable:boolean}} prev  state from the previous call ({side:0, reliable:true} initially)
 * @returns {{angle:number, side:number, reliable:boolean, ratio:number}} angle in degrees (+ = clockwise)
 */
export function holdAngle(gx, gy, gz, prev = { side: 0, reliable: true }) {
  const inPlane = Math.hypot(gx, gy), mag = Math.hypot(gx, gy, gz);
  if (!(mag > 1e-6) || !Number.isFinite(mag)) return { angle: 0, side: prev.side, reliable: false, ratio: 0 };
  const ratio = inPlane / mag;
  const reliable = prev.reliable ? ratio > TILT_OFF : ratio > TILT_ON;
  let side = prev.side;
  if (side === 0) { if (reliable) side = gx >= 0 ? 1 : -1; }
  // switch sides only when the other x direction is decisively "up" (≥ 120° away from the current neutral): the
  // player turned the phone round, not a big steering input (range is ≤ 90°)
  else if (reliable && Math.sign(gx) === -side && Math.abs(gx) > 0.5 * inPlane) side = -side;
  if (!reliable || side === 0) return { angle: 0, side, reliable: false, ratio };
  const angle = Math.atan2(gy * side, gx * side) * DEG;
  return { angle, side, reliable: true, ratio };
}

/**
 * Wheel angle (deg) → steering command −1..1.
 * @param {number} angle  from holdAngle
 * @param {{zero?:number, range:number, deadzone:number, curve:number, invert:boolean}} cfg  zero = angle set by 回中
 */
export function shapeSteer(angle, cfg) {
  const range = clamp(cfg.range, 30, 90);
  const dz = clamp(cfg.deadzone, 0, range * 0.5);
  const x = wrapDeg(angle - (cfg.zero ?? 0));
  const m = Math.max(0, (Math.abs(x) - dz) / (range - dz));
  const s = Math.sign(x) * Math.pow(Math.min(1, m), Math.max(0.5, cfg.curve));
  return cfg.invert ? -s || 0 : s || 0;
}

/** first-order low-pass on a vector; alpha from the real sample interval so the cutoff holds at any event rate */
export class LowPass {
  /** @param {number} fc cutoff (Hz) */
  constructor(fc = 12) { this.fc = fc; this.v = null; }
  /** @param {number[]} x @param {number} dt seconds */
  step(x, dt) {
    if (!this.v) { this.v = x.slice(); return this.v; }
    const a = 1 - Math.exp(-2 * Math.PI * this.fc * clamp(dt, 0.001, 0.1));
    for (let i = 0; i < x.length; i++) this.v[i] += (x[i] - this.v[i]) * a;
    return this.v;
  }
  reset() { this.v = null; }
}

/**
 * Pedal value from a touch: press = 60 %, slide up `travel` px = 100 %, slide down `travel` px = 20 %.
 * @param {number} y0 press y (px, down = +) @param {number} y current y @param {number} travel @param {'analog'|'switch'} mode
 */
export function pedalValue(y0, y, travel = 90, mode = 'analog') {
  if (mode === 'switch') return 1;
  const d = (y0 - y) / Math.max(10, travel);
  return clamp(0.6 + d * 0.4, 0.2, 1);
}

// ---------- protocol ----------
// pad → game (60 Hz):  {t:'in', q:seq, ts:sendEpochMs, ev:inputEventEpochMs, s:steer, th, br, b:bits, a:[4 counters], ok:0|1}
//                      sent on every open channel at once (UDP data channel + WebSocket / POST); the game keeps the
//                      newest by (ts, q) and drops the rest
//                      {t:'ping', ts}
//                      {t:'stat', ch, r50, r95, rd50, rd95, hz, mhz, rc, dc}  2 Hz, the pad's own view of the link
//                      {t:'rtc', id, sdp}  WebRTC offer (relay only)
// game → pad (10 Hz):  {t:'st', g:gear, v:kmh, r:rpm 0..1, n:'next note', d:metres, run:0|1}
//                      {t:'pong', ts}
//                      {t:'lq', hz, st, gp, mx, lo, j95}  2 Hz, what the game receives (rate, stalls, gaps, loss, jitter)
//                      {t:'k', q}  ack of input packet q (data channel; the relay acks WebSocket packets itself)
//                      {t:'rtc', id, sdp}  WebRTC answer (relay only)
// server → either:     {t:'pad', on:bool, mode:'ws'|'http'}  /  {t:'game', on:bool}  /  {t:'k', q} (to the pad)

export const MAX_PAD_MSG = 512;
export const MAX_GAME_MSG = 2048;
/** WebRTC session descriptions are a few kB (host candidates only) */
export const MAX_RTC_MSG = 12000;

const num = (v, a, b, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : d);
const int = (v, a, b) => Math.round(num(v, a, b));

/** an SDP blob as WebRTC produces it (printable ASCII lines), or null */
export function sdpOk(s) {
  return typeof s === 'string' && s.length <= MAX_RTC_MSG - 200 && s.startsWith('v=0') && /^[\x20-\x7e\r\n]*$/.test(s) ? s : null;
}
const rtcMsg = (o) => {
  const sdp = sdpOk(o.sdp);
  return sdp ? { t: 'rtc', id: int(o.id, 0, 1e6), sdp } : null;
};
const chName = (c) => (c === 'dc' || c === 'ws' || c === 'http' ? c : '');

/** validated copy of a pad message, or null (unknown type / bad JSON / too big) */
export function sanitizePadMsg(raw) {
  const o = parseSmall(raw, MAX_RTC_MSG);
  if (!o) return null;
  if (o.t === 'rtc') return rtcMsg(o);
  if (String(raw).length > MAX_PAD_MSG) return null;
  if (o.t === 'stat') {
    return {
      t: 'stat', ch: chName(o.ch), r50: num(o.r50, 0, 9999), r95: num(o.r95, 0, 9999), rd50: num(o.rd50, 0, 9999), rd95: num(o.rd95, 0, 9999),
      hz: num(o.hz, 0, 999), mhz: num(o.mhz, 0, 999), rc: int(o.rc, 0, 1e6), dc: int(o.dc, 0, 4),
    };
  }
  if (o.t === 'in') {
    const a = Array.isArray(o.a) ? o.a : [];
    return {
      t: 'in', q: int(o.q, 0, 2 ** 31), ts: num(o.ts, 0, 1e15), ev: num(o.ev, 0, 1e15),
      s: num(o.s, -1, 1), th: num(o.th, 0, 1), br: num(o.br, 0, 1), b: int(o.b, 0, 255),
      a: PAD_ACTIONS.map((_, i) => int(a[i], 0, 255)), ok: o.ok ? 1 : 0,
    };
  }
  if (o.t === 'ping') return { t: 'ping', ts: num(o.ts, 0, 1e15) };
  return null;
}

/** validated copy of a game message, or null */
export function sanitizeGameMsg(raw) {
  const o = parseSmall(raw, MAX_RTC_MSG);
  if (!o) return null;
  if (o.t === 'rtc') return rtcMsg(o);
  if (String(raw).length > MAX_GAME_MSG) return null;
  if (o.t === 'k') return { t: 'k', q: int(o.q, 0, 2 ** 31) };
  if (o.t === 'lq') {
    return { t: 'lq', hz: num(o.hz, 0, 999), st: int(o.st, 0, 9999), gp: int(o.gp, 0, 9999), mx: num(o.mx, 0, 1e5), lo: num(o.lo, 0, 100), j95: num(o.j95, 0, 1e5) };
  }
  if (o.t === 'st') {
    return {
      t: 'st', g: int(o.g, -1, 9), v: num(o.v, 0, 999), r: num(o.r, 0, 1),
      n: typeof o.n === 'string' ? o.n.slice(0, 40) : '', d: num(o.d, 0, 99999), run: o.run ? 1 : 0,
    };
  }
  if (o.t === 'pong') return { t: 'pong', ts: num(o.ts, 0, 1e15) };
  return null;
}

function parseSmall(raw, max) {
  if (typeof raw !== 'string') { try { raw = String(raw); } catch { return null; } }
  if (raw.length > max) return null;
  try { const o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

// ---------- pairing code ----------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;
/** @param {(n:number)=>number} randInt  uniform integer in [0, n) (crypto in the server) */
export function makeCode(randInt) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[randInt(CODE_CHARS.length)];
  return s;
}
/** constant-time-ish comparison; false for anything not shaped like a code */
export function codeMatches(given, code) {
  if (typeof given !== 'string' || typeof code !== 'string' || given.length !== code.length || given.length !== CODE_LEN) return false;
  let d = 0;
  for (let i = 0; i < code.length; i++) d |= given.charCodeAt(i) ^ code.charCodeAt(i);
  return d === 0;
}

// ---------- rate limit ----------
export class RateLimit {
  /** @param {number} rate tokens/s @param {number} burst */
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.tokens = burst; this.t = -1; }
  /** @param {number} now ms */
  take(now) {
    if (this.t < 0) this.t = now;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.t) / 1000) * this.rate);
    this.t = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ---------- game side: freshness + edge actions ----------
/** packets older than this → the phone counts as gone: throttle off, steering centred */
export const PAD_TIMEOUT_MS = 500;

/** packet a is newer than packet b: send time first (monotonic within one page load), sequence number on a tie */
export const newerPkt = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.q > b.q);

export class PadState {
  constructor() { this.last = null; this.at = -1e9; this.prevA = null; this.pending = []; this.connected = false; }
  /**
   * @param {ReturnType<typeof sanitizePadMsg>} p @param {number} now ms
   * @returns {boolean} true = accepted (newest so far); false = duplicate (the same packet on another channel) or older
   */
  feed(p, now) {
    if (!p || p.t !== 'in') return false;
    // after a gap the phone page may have reloaded (counters back to 0, sequence restarts): resync instead of firing
    if (now - this.at > PAD_TIMEOUT_MS) this.prevA = null;
    else if (this.last && !newerPkt(p, this.last)) return false; // duplicate or stale reordering
    if (this.prevA) {
      for (let i = 0; i < PAD_ACTIONS.length; i++) {
        const n = (p.a[i] - this.prevA[i] + 256) % 256;
        // a jump of more than a few presses inside 0.5 s is a counter reset, not a burst of presses
        if (n <= 4) for (let k = 0; k < n; k++) this.pending.push(PAD_ACTIONS[i]);
      }
    }
    this.prevA = p.a.slice();
    this.last = p; this.at = now;
    return true;
  }
  fresh(now) { return this.last !== null && now - this.at <= PAD_TIMEOUT_MS; }
  takeActions() { const a = this.pending; this.pending = []; return a; }
  /** after a disconnect the counters restart: forget them so a fresh connection does not fire stale actions */
  forget() { this.prevA = null; this.last = null; this.at = -1e9; this.pending = []; }
}

// ---------- game side: riding out gaps ----------
/** no new packet for HOLD_MS → keep the last input unchanged (a late or lost packet or two is invisible) */
export const HOLD_MS = 150;
/** after the hold, steering eases back to centre over FADE_MS (linear) */
export const FADE_MS = 300;
/** after the hold, throttle, brake and handbrake are released over RELEASE_MS (never an automatic brake) */
export const RELEASE_MS = 80;
/** when packets come back after a gap, the output blends to the live input over at most RECOVER_MS */
export const RECOVER_MS = 100;
/** inter-arrival gap that counts as a stutter (卡顿) / as a signal interruption (断流) */
export const STALL_MS = 50;
export const GAP_MS = HOLD_MS;
/** a packet this much later than the quickest recent one is dropped as stale (LinkStats.isStale) */
export const STALE_MS = 400;

const lerp = (a, b, k) => a + (b - a) * k;

/**
 * What the phone contributes to one sim tick, given the newest packet and its arrival time.
 *   age ≤ HOLD_MS                         the packet as it is
 *   HOLD_MS < age                         steering → 0 over FADE_MS, pedals + handbrake + shift bits → 0 over RELEASE_MS
 *   age > PAD_TIMEOUT_MS                  nothing (null): keyboard / gamepad are on their own
 *   a packet arrives after a gap > STALL_MS  blend from what was being output (0 after a timeout or for a new
 *                                         connection) to the live value over min(RECOVER_MS, gap − 2 frames), so a
 *                                         held / faded / dropped value never jumps
 */
export class PadHold {
  constructor() {
    /** what the last call returned (steer, throttle, brake) */
    this.out = { s: 0, th: 0, br: 0 };
    this.lastAt = -1e9; this.outAt = -1e9; this.from = null; this.recAt = 0; this.recMs = 0; this.fadeBase = null; this.fadeAt = -1e9;
  }
  /** @param {PadState} state @param {number} now ms (same clock as PadState.feed) */
  sample(state, now) {
    const p = state.last;
    if (!p) { this.lastAt = -1e9; this.from = null; this.out = { s: 0, th: 0, br: 0 }; this.outAt = -1e9; return null; }
    if (state.at !== this.lastAt) {
      // after a gap (also after a full timeout, or a new connection: then from zero) blend in instead of jumping
      const gap = state.at - this.lastAt;
      // (a packet in the middle of a blend leaves the blend running)
      if (gap > STALL_MS) { this.from = { ...this.out }; this.recAt = state.at; this.recMs = Math.min(RECOVER_MS, gap - 34); }
      this.lastAt = state.at;
    }
    const age = now - state.at;
    if (age > PAD_TIMEOUT_MS) { this.out = { s: 0, th: 0, br: 0 }; this.outAt = -1e9; this.from = null; return null; }
    let s = p.s, th = p.th, br = p.br, b = p.b;
    if (age > HOLD_MS) {
      // fade from what was being output when the hold ran out (it may still have been blending in)
      if (this.fadeAt !== state.at) { this.fadeBase = this.outAt === state.at ? { ...this.out } : { s, th, br }; this.fadeAt = state.at; }
      const k = Math.min(1, (age - HOLD_MS) / FADE_MS), r = Math.min(1, (age - HOLD_MS) / RELEASE_MS), fb = this.fadeBase;
      this.out = { s: fb.s * (1 - k), th: fb.th * (1 - r), br: fb.br * (1 - r) };
      return { ...this.out, b: 0, age, hold: true };
    }
    if (this.from && this.recMs > 0) {
      const k = Math.max(0, (now - this.recAt) / this.recMs);
      if (k < 1) { s = lerp(this.from.s, s, k); th = lerp(this.from.th, th, k); br = lerp(this.from.br, br, k); }
      else this.from = null;
    }
    this.out = { s, th, br }; this.outAt = state.at;
    return { s, th, br, b, age, hold: false };
  }
}

// ---------- link statistics ----------
/** p-quantile of an array (nearest rank), NaN when empty */
export function quantile(a, p) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
}

/** rolling window of (time, value) samples */
export class Rolling {
  constructor(ms = 5000) { this.ms = ms; this.t = []; this.v = []; }
  push(now, v) { this.t.push(now); this.v.push(v); this.trim(now); }
  trim(now) { let i = 0; while (i < this.t.length && now - this.t[i] > this.ms) i++; if (i) { this.t.splice(0, i); this.v.splice(0, i); } }
  values(now) { this.trim(now); return this.v; }
  q(now, p) { return quantile(this.values(now), p); }
  count(now) { this.trim(now); return this.t.length; }
}

/**
 * Game side: what arrives from the phone, per 5 s window and per session (one stage run).
 * onPacket() for every input packet that reached the game (any channel), accepted or not.
 */
export class LinkStats {
  constructor() {
    this.win = 5000;
    this.acc = new Rolling(this.win);    // accepted packets: value = channel
    this.stalls = new Rolling(this.win); // value = inter-arrival ms, for gaps > STALL_MS
    this.lost = new Rolling(this.win);   // value = missing sequence numbers before this accepted packet
    this.delay = new Rolling(this.win);  // value = arrival − send time (phone clock: only its spread means anything)
    this.prevAt = -1e9; this.prevQ = -1;
    this.gapOpen = 0;
    this.resetSession(0);
  }
  resetSession(now) {
    this.s = { t0: now, n: 0, dup: 0, lost: 0, stalls: 0, gaps: 0, gapMs: 0, maxGap: 0, ch: { dc: 0, ws: 0, http: 0 }, r50: [], r95: [] };
  }
  /** @param {number} now ms @param {{q:number, ts:number}} p @param {'dc'|'ws'|'http'} ch @param {boolean} accepted @param {number} epochNow */
  onPacket(now, p, ch, accepted, epochNow) {
    if (!accepted) { this.s.dup++; return; }
    const S = this.s;
    S.n++; S.ch[ch] = (S.ch[ch] ?? 0) + 1;
    this.acc.push(now, ch);
    const gap = now - this.prevAt;
    // a gap longer than the disconnect timeout is a new connection, not a stall of this one
    if (this.prevAt > -1e9 && gap <= 10000) {
      if (gap > STALL_MS) { this.stalls.push(now, gap); S.stalls++; }
      if (gap > GAP_MS) { S.gaps++; S.gapMs += gap; S.maxGap = Math.max(S.maxGap, gap); }
      const miss = p.q - this.prevQ - 1;
      if (miss > 0 && miss < 600) { this.lost.push(now, miss); S.lost += miss; }
    }
    this.prevAt = now; this.prevQ = p.q;
    if (p.ts > 0) this.delay.push(now, epochNow - p.ts);
  }
  /**
   * A packet that spent STALE_MS longer on the way than the quickest one of the last 5 s is old news (sent before the
   * phone was frozen / the link stalled, delivered late by TCP): better to keep holding than to apply it. Only the
   * spread of (arrival − send time) is used, so the two clocks need not agree.
   */
  isStale(p, epochNow, now) {
    if (!(p.ts > 0)) return false;
    const d = this.delay.values(now);
    if (d.length < 30) return false;
    let m = Infinity;
    for (const x of d) if (x < m) m = x;
    return epochNow - p.ts - m > STALE_MS;
  }
  /** a new phone (or the same page reloaded): its sequence numbers start again */
  newStream() { this.prevAt = -1e9; this.prevQ = -1; }
  /** the pad's own figures (RTT per channel), 2 Hz */
  onPadStat(m) { if (m.r50 > 0) { this.s.r50.push(m.r50); this.s.r95.push(m.r95); if (this.s.r50.length > 7200) { this.s.r50.splice(0, 3600); this.s.r95.splice(0, 3600); } } }
  /** gap still open right now (ms since the last accepted packet) */
  openGap(now) { return this.prevAt > -1e9 ? now - this.prevAt : 0; }
  window(now) {
    const n = this.acc.count(now), chs = this.acc.values(now), lost = this.lost.values(now).reduce((a, b) => a + b, 0);
    const share = { dc: 0, ws: 0, http: 0 };
    for (const c of chs) share[c] = (share[c] ?? 0) + 1;
    const stalls = this.stalls.values(now), d = this.delay.values(now);
    const dmin = d.length ? Math.min(...d) : 0;
    return {
      hz: n / (this.win / 1000), stalls: stalls.length, gaps: stalls.filter((g) => g > GAP_MS).length, maxGap: stalls.length ? Math.max(...stalls) : 0,
      loss: n + lost ? (100 * lost) / (n + lost) : 0, jitter95: d.length ? quantile(d, 0.95) - dmin : 0, share, n,
    };
  }
  session(now) {
    const S = this.s;
    return {
      secs: (now - S.t0) / 1000, n: S.n, lost: S.lost, loss: S.n + S.lost ? (100 * S.lost) / (S.n + S.lost) : 0, stalls: S.stalls, gaps: S.gaps,
      gapMs: S.gapMs, maxGap: S.maxGap, ch: { ...S.ch }, r50: quantile(S.r50, 0.5), r95: quantile(S.r95, 0.5), r95max: quantile(S.r95, 0.95),
    };
  }
}
