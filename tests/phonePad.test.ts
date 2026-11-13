// Phone steering wheel: pure mapping + protocol functions (pad/padcore.js).
import { describe, expect, it } from 'vitest';
import {
  holdAngle, shapeSteer, LowPass, pedalValue, sanitizePadMsg, sanitizeGameMsg, PadState, PAD_TIMEOUT_MS,
  codeMatches, makeCode, CODE_LEN, RateLimit, wrapDeg, PAD_DEFAULTS, TILT_OFF, type HoldState,
  PadHold, LinkStats, HOLD_MS, FADE_MS, RELEASE_MS, RECOVER_MS, quantile, type PadInputMsg,
} from '../pad/padcore.js';

const DEG = Math.PI / 180;
const G = 9.81;
/** "up" vector (spec sign) in device coordinates for a landscape hold.
 *  side +1: device +x points up at neutral; side −1: device −x points up.
 *  theta: clockwise rotation as seen from the front (deg); pitch: screen tilted back toward the sky (deg). */
function grav(side: 1 | -1, theta: number, pitch: number, ios = false): [number, number, number] {
  const c = Math.cos(pitch * DEG), s = Math.sin(pitch * DEG);
  const v: [number, number, number] = [side * c * Math.cos(theta * DEG) * G, side * c * Math.sin(theta * DEG) * G, s * G];
  return ios ? [-v[0], -v[1], -v[2]] : v;
}
/** run holdAngle a few times (hysteresis / side detection settle from the neutral hold first) */
function angleAt(side: 1 | -1, theta: number, pitch: number, ios = false) {
  let st: HoldState = { side: 0, reliable: true };
  st = holdAngle(...grav(side, 0, pitch, ios), st);
  return holdAngle(...grav(side, theta, pitch, ios), st);
}

describe('gravity → wheel angle', () => {
  for (const side of [1, -1] as const) {
    for (const ios of [false, true]) {
      it(`side ${side}, ${ios ? 'iOS' : 'spec'} sign: angle follows clockwise rotation at several pitches`, () => {
        for (const pitch of [0, 20, 40, 55]) {
          for (const theta of [-60, -25, -3, 0, 10, 45, 80]) {
            const r = angleAt(side, theta, pitch, ios);
            expect(r.reliable).toBe(true);
            expect(r.angle).toBeCloseTo(theta, 6);
          }
        }
      });
    }
  }

  it('a global sign flip (iOS vs spec) does not change the steering angle', () => {
    for (const theta of [-40, 0, 33]) expect(angleAt(1, theta, 30, true).angle).toBeCloseTo(angleAt(1, theta, 30, false).angle, 9);
  });

  it('phone close to flat → untrusted, angle 0; recovers with hysteresis', () => {
    let st: HoldState = { side: 0, reliable: true };
    st = holdAngle(...grav(1, 0, 30), st);
    expect(st.reliable).toBe(true);
    const flat = holdAngle(...grav(1, 30, 75), st); // in-plane share cos75 = 0.26
    expect(flat.reliable).toBe(false);
    expect(flat.angle).toBe(0);
    // 0.40 share: inside the hysteresis band → stays untrusted from below, stays trusted from above
    const mid = Math.acos(0.40) / DEG;
    expect(holdAngle(...grav(1, 10, mid), flat).reliable).toBe(false);
    expect(holdAngle(...grav(1, 10, mid), st).reliable).toBe(true);
    expect(holdAngle(...grav(1, 10, Math.acos(0.5) / DEG), flat).reliable).toBe(true);
    expect(TILT_OFF).toBeLessThan(0.45);
  });

  it('lying flat / zero vector / NaN → untrusted', () => {
    expect(holdAngle(0, 0, G).reliable).toBe(false);
    expect(holdAngle(0, 0, -G).reliable).toBe(false);
    expect(holdAngle(0, 0, 0).reliable).toBe(false);
    expect(holdAngle(NaN, 1, 1).reliable).toBe(false);
  });

  it('a big steering input does not flip the hold side; turning the phone round does', () => {
    let st: HoldState & { angle?: number } = { side: 0, reliable: true };
    st = holdAngle(...grav(1, 0, 20), st);
    expect(st.side).toBe(1);
    for (let t = 0; t <= 110; t += 5) st = holdAngle(...grav(1, t, 20), st);
    expect(st.side).toBe(1);
    expect(st.angle).toBeCloseTo(110, 6);
    st = holdAngle(...grav(1, 0, 20), st);
    // other landscape hold
    st = holdAngle(...grav(-1, 0, 20), st);
    expect(st.side).toBe(-1);
    expect(st.angle).toBeCloseTo(0, 6);
    expect(holdAngle(...grav(-1, 20, 20), st).angle).toBeCloseTo(20, 6);
  });
});

describe('angle → steering command', () => {
  const cfg = { ...PAD_DEFAULTS, zero: 0, curve: 1, deadzone: 2, range: 60, invert: false };
  it('deadzone, linear range, full lock, clamp', () => {
    expect(shapeSteer(1.5, cfg)).toBe(0);
    expect(shapeSteer(-2, cfg)).toBe(0);
    expect(shapeSteer(31, cfg)).toBeCloseTo(0.5, 6);
    expect(shapeSteer(-31, cfg)).toBeCloseTo(-0.5, 6);
    expect(shapeSteer(60, cfg)).toBe(1);
    expect(shapeSteer(95, cfg)).toBe(1);
    expect(shapeSteer(-200, cfg)).toBeCloseTo(1, 6); // wraps to +160 → full right
  });
  it('range is clamped to 30–90°', () => {
    expect(shapeSteer(30, { ...cfg, range: 10, deadzone: 0 })).toBe(1);
    expect(shapeSteer(45, { ...cfg, range: 200, deadzone: 0 })).toBeCloseTo(0.5, 6);
  });
  it('curve keeps the ends and softens the middle', () => {
    const c = { ...cfg, curve: 2, deadzone: 0 };
    expect(shapeSteer(30, c)).toBeCloseTo(0.25, 6);
    expect(shapeSteer(60, c)).toBe(1);
    expect(shapeSteer(-30, c)).toBeCloseTo(-0.25, 6);
  });
  it('回中: the zero point shifts the centre', () => {
    const c = { ...cfg, zero: 12, deadzone: 0 };
    expect(shapeSteer(12, c)).toBe(0);
    expect(shapeSteer(42, c)).toBeCloseTo(0.5, 6);
    expect(shapeSteer(-18, c)).toBeCloseTo(-0.5, 6);
    expect(shapeSteer(170, { ...c, zero: -170 })).toBeCloseTo(-20 / 60, 6); // across ±180
  });
  it('反向 flips the sign', () => {
    expect(shapeSteer(31, { ...cfg, invert: true })).toBeCloseTo(-0.5, 6);
    expect(Object.is(shapeSteer(0, { ...cfg, invert: true }), -0)).toBe(false);
  });
  it('wrapDeg', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
  });
});

describe('low-pass (12 Hz)', () => {
  it('first sample passes straight through', () => {
    expect(new LowPass(12).step([1, 2, 3], 1 / 60)).toEqual([1, 2, 3]);
  });
  it('time constant 1/(2π·12) ≈ 13.3 ms → 63 % of a step, independent of the sample rate', () => {
    const tau = 1 / (2 * Math.PI * 12);
    for (const rate of [60, 100, 1000]) {
      const lp = new LowPass(12);
      lp.step([0], 1 / rate);
      let v = 0;
      const n = Math.round(tau * rate * 3);
      for (let i = 0; i < n; i++) v = lp.step([1], 1 / rate)[0];
      expect(v).toBeCloseTo(1 - Math.exp(-n / rate / tau), 6);
    }
    // 60 Hz events: one sample already covers 71 % of a step (latency first)
    const lp = new LowPass(12); lp.step([0], 1 / 60);
    expect(lp.step([1], 1 / 60)[0]).toBeGreaterThan(0.7);
  });
  it('absurd dt is clamped', () => {
    const lp = new LowPass(12); lp.step([0], 0.016);
    expect(lp.step([1], 50)[0]).toBeLessThanOrEqual(1);
    expect(lp.step([1], -1)[0]).toBeGreaterThan(0);
  });
});

describe('pedals', () => {
  it('press 60 %, slide up to 100 %, down to 20 %, clamped', () => {
    expect(pedalValue(200, 200, 90)).toBeCloseTo(0.6, 9);
    expect(pedalValue(200, 110, 90)).toBeCloseTo(1, 9);
    expect(pedalValue(200, 155, 90)).toBeCloseTo(0.8, 9);
    expect(pedalValue(200, 290, 90)).toBeCloseTo(0.2, 9);
    expect(pedalValue(200, 0, 90)).toBe(1);
    expect(pedalValue(200, 400, 90)).toBe(0.2);
  });
  it('switch mode is all or nothing', () => {
    expect(pedalValue(200, 290, 90, 'switch')).toBe(1);
  });
});

describe('protocol validation', () => {
  it('accepts and clamps an input packet', () => {
    const m = sanitizePadMsg(JSON.stringify({ t: 'in', q: 5, ts: 1, ev: 2, s: 3, th: -1, br: 0.5, b: 7.4, a: [1, 2, 300], ok: 1, junk: 'x'.repeat(50) }));
    expect(m).toEqual({ t: 'in', q: 5, ts: 1, ev: 2, s: 1, th: 0, br: 0.5, b: 7, a: [1, 2, 255, 0], ok: 1 });
  });
  it('rejects bad JSON, oversize, arrays and unknown types; NaN → 0', () => {
    expect(sanitizePadMsg('{nope')).toBeNull();
    expect(sanitizePadMsg('[1,2]')).toBeNull();
    expect(sanitizePadMsg(JSON.stringify({ t: 'evil' }))).toBeNull();
    expect(sanitizePadMsg(JSON.stringify({ t: 'in', pad: 'x'.repeat(600) }))).toBeNull();
    expect(sanitizePadMsg(JSON.stringify({ t: 'in', s: 'left', th: null }))!).toMatchObject({ s: 0, th: 0 });
    expect(sanitizeGameMsg(JSON.stringify({ t: 'st', g: 3, v: 88.2, r: 1.5, n: '右三'.repeat(40), run: true }))).toMatchObject({ g: 3, r: 1, run: 1 });
    expect((sanitizeGameMsg(JSON.stringify({ t: 'st', n: '右三'.repeat(40) })) as { n: string }).n.length).toBe(40);
    expect(sanitizeGameMsg(JSON.stringify({ t: 'in' }))).toBeNull();
  });
  it('link messages: stats, acks, quality, WebRTC offers (SDP only, size-limited)', () => {
    expect(sanitizePadMsg(JSON.stringify({ t: 'stat', ch: 'dc', r50: 12.4, r95: 1e9, hz: 61, mhz: 60, rc: 2, dc: 2, x: 1 }))).toEqual(
      { t: 'stat', ch: 'dc', r50: 12.4, r95: 9999, rd50: 0, rd95: 0, hz: 61, mhz: 60, rc: 2, dc: 2 });
    expect(sanitizePadMsg(JSON.stringify({ t: 'stat', ch: 'evil' }))).toMatchObject({ ch: '' });
    expect(sanitizeGameMsg(JSON.stringify({ t: 'k', q: 77 }))).toEqual({ t: 'k', q: 77 });
    expect(sanitizeGameMsg(JSON.stringify({ t: 'lq', hz: 59.8, st: 3, gp: 1, mx: 412, lo: 2.5, j95: 18 }))).toEqual({ t: 'lq', hz: 59.8, st: 3, gp: 1, mx: 412, lo: 2.5, j95: 18 });
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' + 'a=candidate:1 1 udp 1 x.local 1 typ host\r\n'.repeat(40);
    expect(sanitizePadMsg(JSON.stringify({ t: 'rtc', id: 3, sdp }))).toEqual({ t: 'rtc', id: 3, sdp });
    expect(sanitizeGameMsg(JSON.stringify({ t: 'rtc', id: 3, sdp }))).toEqual({ t: 'rtc', id: 3, sdp });
    expect(sanitizePadMsg(JSON.stringify({ t: 'rtc', id: 1, sdp: 'hello' }))).toBeNull();
    expect(sanitizePadMsg(JSON.stringify({ t: 'rtc', id: 1, sdp: 'v=0\u0000' }))).toBeNull();
    expect(sanitizePadMsg(JSON.stringify({ t: 'rtc', id: 1, sdp: 'v=0' + 'x'.repeat(13000) }))).toBeNull();
    // only offers / answers may be big: an input packet of the same size is still refused
    expect(sanitizePadMsg(JSON.stringify({ t: 'in', q: 1, junk: 'x'.repeat(2000) }))).toBeNull();
  });
});

describe('game-side pad state', () => {
  const pkt = (q: number, a = [0, 0, 0, 0], extra = {}) => sanitizePadMsg(JSON.stringify({ t: 'in', q, s: 0.3, th: 0.8, a, ...extra }));
  it('fresh for 0.5 s after the last packet, then times out', () => {
    const s = new PadState();
    expect(s.fresh(0)).toBe(false);
    s.feed(pkt(1), 1000);
    expect(s.fresh(1000 + PAD_TIMEOUT_MS)).toBe(true);
    expect(s.fresh(1000 + PAD_TIMEOUT_MS + 1)).toBe(false);
  });
  it('action counters fire once per press, wrap at 255, ignore reorders', () => {
    const s = new PadState();
    s.feed(pkt(1, [0, 0, 0, 254]), 0);
    expect(s.takeActions()).toEqual([]);
    s.feed(pkt(2, [1, 0, 0, 255]), 16);
    s.feed(pkt(3, [1, 0, 2, 0]), 32);
    expect(s.takeActions()).toEqual(['reset', 'predict', 'camera', 'camera', 'predict']);
    s.feed(pkt(2, [9, 9, 9, 9]), 40); // stale
    expect(s.takeActions()).toEqual([]);
    expect(s.last!.q).toBe(3);
  });
  it('the same packet on two channels is taken once; older ones (reordered UDP, late TCP burst) are dropped', () => {
    const s = new PadState();
    const p = (q: number, ts: number) => sanitizePadMsg(JSON.stringify({ t: 'in', q, ts, s: q / 100, a: [0, 0, 0, 0] }));
    expect(s.feed(p(10, 1000), 0)).toBe(true);
    expect(s.feed(p(10, 1000), 1)).toBe(false); // same packet over the other channel
    expect(s.feed(p(12, 1033), 2)).toBe(true);
    expect(s.feed(p(11, 1016), 3)).toBe(false); // overtaken
    expect(s.last!.q).toBe(12);
    // page reloaded within the timeout: sequence restarts, send time keeps going up → accepted
    expect(s.feed(p(1, 1400), 300)).toBe(true);
    expect(s.last!.q).toBe(1);
  });
  it('after a gap (page reload: counters back to 0) nothing fires', () => {
    const s = new PadState();
    s.feed(pkt(50, [7, 3, 1, 0]), 0);
    s.feed(pkt(1, [0, 0, 0, 0]), 2000);
    expect(s.takeActions()).toEqual([]);
    s.feed(pkt(2, [0, 1, 0, 0]), 2016);
    expect(s.takeActions()).toEqual(['pause']);
    s.forget();
    expect(s.fresh(2016)).toBe(false);
  });
});

describe('pairing code + rate limit', () => {
  it('codes: length, alphabet, comparison', () => {
    let i = 0;
    const c = makeCode((n) => (i++ * 7) % n);
    expect(c).toHaveLength(CODE_LEN);
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    expect(codeMatches(c, c)).toBe(true);
    expect(codeMatches(c.toLowerCase(), c)).toBe(false);
    expect(codeMatches(c.slice(0, 5), c)).toBe(false);
    expect(codeMatches(null, c)).toBe(false);
    expect(codeMatches(c + 'A', c)).toBe(false);
  });
  it('token bucket', () => {
    const r = new RateLimit(100, 10);
    let ok = 0;
    for (let k = 0; k < 50; k++) if (r.take(0)) ok++;
    expect(ok).toBe(10);
    expect(r.take(5)).toBe(false); // 0.5 token
    expect(r.take(10)).toBe(true);
  });
});

describe('game side: riding out gaps (PadHold)', () => {
  const pkt = (q: number, s: number, th = 0.6, br = 0, b = 1) => sanitizePadMsg(JSON.stringify({ t: 'in', q, ts: q * 16, s, th, br, b, a: [0, 0, 0, 0] })) as PadInputMsg;
  /** packets every 16 ms up to `until`, steering `s`, then silence; sample every 8 ms */
  function run(until: number, end: number, s = 0.5) {
    const st = new PadState(), h = new PadHold(), out: { t: number; s: number; th: number; b: number; live: boolean }[] = [];
    for (let t = 0, q = 1; t <= end; t += 4) {
      if (t <= until && t % 16 === 0) st.feed(pkt(q++, s), t);
      if (t % 8 === 0) { const o = h.sample(st, t); out.push({ t, s: o?.s ?? 0, th: o?.th ?? 0, b: o?.b ?? 0, live: !!o }); }
    }
    return { st, h, out };
  }
  it(`holds ${HOLD_MS} ms unchanged, then eases steering to centre over ${FADE_MS} ms, pedals off in ${RELEASE_MS} ms, never brakes`, () => {
    const { out } = run(1000, 1700);
    const last = Math.floor(1000 / 16) * 16;
    const at = (dt: number) => out.find((o) => o.t >= last + dt)!;
    expect(at(HOLD_MS - 8)).toMatchObject({ s: 0.5, th: 0.6, b: 1 });
    const mid = at(HOLD_MS + FADE_MS / 2), half = at(HOLD_MS + RELEASE_MS / 2);
    expect(mid.s).toBeCloseTo(0.5 * (1 - (mid.t - last - HOLD_MS) / FADE_MS), 9);
    expect(half.th).toBeCloseTo(0.6 * (1 - (half.t - last - HOLD_MS) / RELEASE_MS), 9);
    expect(at(HOLD_MS + 8).b).toBe(0);
    expect(at(HOLD_MS + RELEASE_MS).th).toBe(0);
    expect(at(HOLD_MS + FADE_MS).s).toBe(0);
    expect(at(PAD_TIMEOUT_MS + 8).live).toBe(false); // keyboard / gamepad on their own again
    // monotonic, no step bigger than one 8 ms tick of the fade
    for (let i = 1; i < out.length; i++) if (out[i].t > last) expect(Math.abs(out[i].s - out[i - 1].s)).toBeLessThanOrEqual(0.5 * 8 / FADE_MS + 1e-9);
  });
  it('a packet after a gap blends in (no jump), also after a full timeout', () => {
    for (const gap of [120, 300, 900]) {
      const st = new PadState(), h = new PadHold();
      const outs: number[] = [];
      let q = 1;
      for (let t = 0; t <= 200; t += 16) { st.feed(pkt(q++, -0.6), t); h.sample(st, t); }
      for (let t = 208; t < 200 + gap; t += 8) outs.push(h.sample(st, t)?.s ?? 0);
      for (let t = 200 + gap; t <= 200 + gap + 300; t += 8) { if ((t - 200 - gap) % 16 === 0) st.feed(pkt(q++, 0.7), t); outs.push(h.sample(st, t)!.s); }
      let maxStep = 0;
      for (let i = 1; i < outs.length; i++) maxStep = Math.max(maxStep, Math.abs(outs[i] - outs[i - 1]));
      // blend over min(RECOVER_MS, gap − 34) ms in 8 ms ticks; a fade step is ≤ 0.6 · 8 / 300
      expect(maxStep, `gap ${gap}`).toBeLessThan(1.3 * 8 / Math.min(RECOVER_MS, gap - 34) + 0.02);
      expect(outs[outs.length - 1]).toBeCloseTo(0.7, 6);
    }
  });
  it('steady stream: output is the packet as it is', () => {
    const { out } = run(400, 400, -0.33);
    // (a new connection blends in from zero over RECOVER_MS too)
    expect(out.filter((o) => o.t > RECOVER_MS).every((o) => o.s === -0.33 && o.th === 0.6)).toBe(true);
    expect(out.find((o) => o.t === 48)!.s).toBeCloseTo(-0.33 * 0.48, 6);
  });
});

describe('game side: link statistics', () => {
  it('rate, stutters, gaps, loss and channel share over 5 s; session totals', () => {
    const L = new LinkStats();
    let q = 0, t = 0;
    const send = (ch: 'dc' | 'ws', dt = 16) => { t += dt; q++; L.onPacket(t, { q, ts: t }, ch, true, t + 20); };
    for (let i = 0; i < 200; i++) send('dc');
    send('ws', 80);                       // stutter (> 50 ms)
    q += 3; send('dc', 300);              // 3 lost, a 300 ms gap
    L.onPacket(t, { q, ts: t }, 'ws', false, t);  // the same packet again on the relay: duplicate
    for (let i = 0; i < 50; i++) send('dc');
    const w = L.window(t);
    expect(w.stalls).toBe(2);
    expect(w.gaps).toBe(1);
    expect(w.maxGap).toBe(300);
    expect(w.loss).toBeCloseTo((100 * 3) / (w.n + 3), 6);
    expect(w.share.ws).toBe(1);
    expect(w.jitter95).toBe(0);
    const s = L.session(t);
    expect(s).toMatchObject({ n: 252, lost: 3, stalls: 2, gaps: 1, maxGap: 300, gapMs: 300 });
    expect(s.ch).toEqual({ dc: 251, ws: 1, http: 0 });
    L.newStream();                         // a new phone: sequence numbers restart, no fake loss / gap
    L.onPacket(t + 5000, { q: 1, ts: 1 }, 'ws', true, t + 5000);
    expect(L.session(t + 5000).lost).toBe(3);
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    // stale: 400 ms later on the way than the quickest packet of the last 5 s (clock offset irrelevant)
    const L2 = new LinkStats();
    for (let i = 1; i <= 40; i++) L2.onPacket(i * 16, { q: i, ts: 1e6 + i * 16 }, 'dc', true, 5e6 + i * 16 + (i % 3) * 10);
    expect(L2.isStale({ ts: 1e6 + 600 }, 5e6 + 640 + 30, 650)).toBe(false);
    expect(L2.isStale({ ts: 1e6 + 200 }, 5e6 + 640 + 30, 650)).toBe(true);
    expect(new LinkStats().isStale({ ts: 1 }, 1e9, 0)).toBe(false); // nothing to compare with yet
    expect(quantile([], 0.5)).toBeNaN();
  });
});
