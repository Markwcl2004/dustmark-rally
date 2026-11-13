// Phone steering wheel, game side (DESIGN §4 手机方向盘). An analog input source at the same level as the gamepad.
// Talks to scripts/serve.mjs over ws://<this page's host>/ws?role=game; only active when the page is served by it
// (GET /pair-info answers JSON). Under `npm run dev` it stays idle and the pairing panel says to use ./play.sh.
//
//  in  {t:'in', q, ts, s, th, br, b, a, …, c} 60 Hz  relay (c = 'ws' | 'http') and/or the WebRTC data channel; the newest
//                                                    by (ts, q) wins, duplicates and older packets are dropped
//      {t:'ping', ts}                        → answered with {t:'pong', ts} (the phone shows the round trip)
//      {t:'pad', on, mode, re?}              → phone (dis)connected / changed relay channel (re = same phone)
//      {t:'stat', …}                         → the phone's own link figures (round trips, send rate), 2 Hz
//      {t:'rtc', id, sdp}                    → WebRTC offer: answered through the relay; inputs then also arrive on an
//                                              unordered, no-retransmit data channel, each acked there ({t:'k', q})
//  out {t:'st', g, v, r, n, d, run}  10 Hz   → gear / speed / rpm / next pace note for the phone screen
//      {t:'lq', hz, st, gp, mx, lo, j95} 2 Hz → what arrives here (rate, stalls, gaps, loss, jitter) for the phone screen
// Gaps (PadHold, pad/padcore.js): ≤ 150 ms the last input is held; then steering eases to centre over 300 ms and the
// pedals are released (no automatic brake); after 0.5 s the phone contributes nothing and "手机断开" shows. When packets
// come back the output blends to the live value over ≤ 100 ms.
import { BTN, PadState, PadHold, LinkStats, sanitizePadMsg, type PadAction, type PadInputMsg } from '../../pad/padcore.js';
import type { DriverInput } from '../sim/vehicle/controls';
import { installPairPanel, type PairStatus, type LinkFigures } from '../ui/pairPanel';

interface GameLike {
  world: {
    car: { speed: number; gear: number; pendingGear: number; shiftTimer: number; rpm: number; spec: { engine: { limiter: number } } };
    session: { phase: string; progressS: number };
    stage: { notes: { s: number; text: string }[] };
  };
  hud?: { root?: HTMLElement };
}
interface PadStat { ch: string; r50: number; r95: number; rd50: number; rd95: number; hz: number; mhz: number; rc: number; dc: number }
type Ch = 'dc' | 'ws' | 'http';

const epochNow = () => performance.timeOrigin + performance.now();
/** a finished gap at least this long shows "手机信号中断 x.x s" on the HUD */
const TOAST_GAP_MS = 250;
const CH_NAME: Record<string, string> = { dc: 'UDP', ws: 'WebSocket', http: 'HTTPS 备用', '': '—' };

export class PhonePad {
  readonly state = new PadState();
  readonly hold = new PadHold();
  readonly stats = new LinkStats();
  /** true = served by serve.mjs, false = not (dev server), null = not known yet */
  server: boolean | null = null;
  padOn = false;
  padMode: 'ws' | 'http' | '' = '';
  padStat: PadStat | null = null;
  private padStatAt = 0;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stopped = false;
  private everActive = false;
  private wasFresh = false;
  private badge: HTMLElement | null = null;
  private badgeT = 0;
  private tag: HTMLElement | null = null;
  private consumedQ = -1;
  private lastAcceptAt = -1e9;
  private pendingGap = 0;
  /** the last stage run's figures (shown in the pairing panel after the run) */
  lastRun: LinkFigures['session'] | null = null;
  private runKey: unknown = null;
  private runPhase = '';
  /** event → sim-sample latency samples (ms; meaningful only when phone page and game share a clock, i.e. tests) */
  readonly latency: number[] = [];
  readonly sendLatency: number[] = [];

  constructor(private pushAction: (a: PadAction) => void) {
    installPairPanel(() => this.status());
    void this.probe();
    setInterval(() => this.sendStatus(), 100);
    setInterval(() => this.sendQuality(), 500);
    setInterval(() => this.watch(), 100);
    (window as unknown as { __phonePad: PhonePad }).__phonePad = this;
  }

  status(): PairStatus {
    const now = performance.now();
    const w = this.stats.window(now);
    return {
      server: this.server, gameLinked: this.ws?.readyState === 1, padOn: this.padOn, mode: this.padMode, fresh: this.state.fresh(now),
      hz: Math.round(w.hz), link: this.figures(now),
    };
  }

  /** everything the pairing panel shows about the link */
  figures(now = performance.now()): LinkFigures {
    const w = this.stats.window(now);
    const ps = this.padStat && now - this.padStatAt < 3000 ? this.padStat : null;
    // every packet goes out on every open channel and the first copy wins: UDP counts as "the" channel when it delivers
    // at least a fifth of them (on a quiet LAN the two race and split ~50/50)
    const relay: Ch = w.share.http > w.share.ws ? 'http' : 'ws';
    const best: Ch = w.share.dc >= 0.2 * w.n ? 'dc' : relay;
    const both = best === 'dc' && w.share[relay] >= 0.2 * w.n;
    const s = this.stats.session(now);
    return {
      channel: w.n ? best : '', channelName: w.n ? CH_NAME[best] + (both ? ` + ${CH_NAME[relay]}` : '') : CH_NAME[''], share: w.share,
      udp: ps ? (ps.dc === 2 ? 'open' : ps.dc === 1 ? 'connecting' : ps.dc === 3 ? 'failed' : ps.dc === 4 ? 'unsupported' : 'off') : 'unknown',
      rtt50: ps?.r50 ?? NaN, rtt95: ps?.r95 ?? NaN, relay50: ps?.rd50 ?? NaN, relay95: ps?.rd95 ?? NaN,
      sendHz: ps?.hz ?? NaN, motionHz: ps?.mhz ?? NaN, reconnects: ps?.rc ?? 0,
      hz: w.hz, stalls5: w.stalls, gaps5: w.gaps, maxGap5: w.maxGap, loss5: w.loss, jitter95: w.jitter95,
      openGap: this.state.last ? this.stats.openGap(now) : 0,
      session: { secs: s.secs, n: s.n, loss: s.loss, stalls: s.stalls, gaps: s.gaps, gapMs: s.gapMs, maxGap: s.maxGap, ch: s.ch, rtt50: s.r50, rtt95: s.r95 },
      lastRun: this.lastRun,
    };
  }

  private async probe() {
    try {
      const r = await fetch('/pair-info', { cache: 'no-store' });
      const ct = r.headers.get('content-type') ?? '';
      const j = r.ok && ct.includes('json') ? await r.json() : null;
      this.server = !!j?.ok;
    } catch { this.server = false; }
    if (this.server) this.connect();
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://${location.host}/ws?role=game`); } catch { setTimeout(() => this.connect(), 2000); return; }
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(typeof e.data === 'string' ? e.data : '');
    ws.onclose = (e) => {
      if (this.ws === ws) this.ws = null;
      this.padOn = false; this.state.forget(); this.closeRtc('relay closed');
      if (e.code === 4002) { this.stopped = true; return; } // another game tab took over
      setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => {};
  }

  private onMessage(raw: string) {
    let m: { t?: string; on?: boolean; mode?: string; ts?: number; re?: number } & Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'in') {
      // the relay already validated and re-serialised the packet
      this.onInput(m as unknown as PadInputMsg, m.c === 'http' ? 'http' : 'ws');
    } else if (m.t === 'ping') {
      this.ws?.send(JSON.stringify({ t: 'pong', ts: m.ts }));
    } else if (m.t === 'pad') {
      this.padOn = !!m.on; this.padMode = m.mode === 'http' ? 'http' : m.mode === 'ws' ? 'ws' : '';
      if (!m.re) { this.state.forget(); this.stats.newStream(); }
      if (!m.on) this.closeRtc('phone gone');
    } else if (m.t === 'stat') {
      this.padStat = m as unknown as PadStat; this.padStatAt = performance.now();
      this.stats.onPadStat(this.padStat);
    } else if (m.t === 'rtc' && typeof m.sdp === 'string') {
      void this.answer(Number(m.id) || 0, m.sdp);
    }
  }

  private onInput(p: PadInputMsg, ch: Ch) {
    const now = performance.now(), ep = epochNow();
    const ok = !this.stats.isStale(p, ep, now) && this.state.feed(p, now);
    this.stats.onPacket(now, p, ch, ok, ep);
    if (ok) {
      // a gap that just ended: tell the player how long the phone was gone (not when it was a new connection)
      const gap = now - this.lastAcceptAt;
      if (gap >= TOAST_GAP_MS && gap < 10000 && this.everActive) this.pendingGap = gap;
      this.lastAcceptAt = now;
    }
    for (const a of this.state.takeActions()) this.pushAction(a);
  }

  // ------------------------------------------------------------ WebRTC (answerer)
  private async answer(id: number, sdp: string) {
    this.closeRtc(`offer ${id}`);
    if (typeof RTCPeerConnection !== 'function') return;
    // host candidates only: no STUN / TURN server, nothing leaves the LAN
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.ondatachannel = (e) => {
      if (this.pc !== pc) return;
      const dc = e.channel;
      this.dc = dc;
      dc.onmessage = (ev) => {
        if (this.dc !== dc || typeof ev.data !== 'string') return;
        const m = sanitizePadMsg(ev.data);
        if (!m) return;
        if (m.t === 'in') {
          if (dc.readyState === 'open' && dc.bufferedAmount < 1024) dc.send(`{"t":"k","q":${m.q}}`);
          this.onInput(m, 'dc');
        } else if (m.t === 'ping' && dc.readyState === 'open') dc.send(JSON.stringify({ t: 'pong', ts: m.ts }));
      };
      dc.onclose = () => { if (this.dc === dc) { this.dc = null; this.rtcNote('channel closed'); } };
      this.rtcNote('channel open');
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((res) => {
          const t = setTimeout(res, 1500);
          pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
        });
      }
      if (this.pc !== pc || !pc.localDescription) return;
      this.ws?.send(JSON.stringify({ t: 'rtc', id, sdp: pc.localDescription.sdp }));
      this.rtcNote(`answer ${id} sent`);
    } catch (e) { if (this.pc === pc) this.closeRtc(`error ${(e as Error)?.name}`); }
  }

  /** last WebRTC events (window.__phonePad.rtcLog), for debugging */
  readonly rtcLog: string[] = [];
  private rtcNote(s: string) { this.rtcLog.push(`${Math.round(performance.now())} ${s}`); if (this.rtcLog.length > 30) this.rtcLog.shift(); }

  private closeRtc(why: string) {
    const { pc, dc } = this;
    if (pc) this.rtcNote(`close (${why})`);
    this.pc = null; this.dc = null;
    try { dc?.close(); } catch { /* gone */ }
    try { pc?.close(); } catch { /* gone */ }
  }

  /** send to the phone on every open channel (status and figures are idempotent; the phone takes the newest) */
  private toPad(o: object) {
    const s = JSON.stringify(o);
    if (this.ws?.readyState === 1) this.ws.send(s);
    if (this.dc?.readyState === 'open' && this.dc.bufferedAmount < 1024) this.dc.send(s);
  }

  /** merge the phone into this tick's input (after keyboard + gamepad). Keyboard steering keys still win while held. */
  apply(out: DriverInput) {
    const now = performance.now();
    const h = this.hold.sample(this.state, now);
    if (!h) return;
    const p = this.state.last!;
    if (p.q !== this.consumedQ) {
      this.consumedQ = p.q;
      const t = epochNow();
      if (p.ev > 0) this.latency.push(t - p.ev);
      this.sendLatency.push(t - p.ts);
      if (this.latency.length > 2000) this.latency.splice(0, 1000);
      if (this.sendLatency.length > 2000) this.sendLatency.splice(0, 1000);
    }
    const keySteer = out.digital && out.steer !== 0;
    if (!keySteer) { out.steer = h.s; out.digital = false; }
    out.throttle = Math.max(out.throttle, h.th);
    out.brake = Math.max(out.brake, h.br);
    out.handbrake = Math.max(out.handbrake, h.b & BTN.HB ? 1 : 0);
    out.shiftUp = out.shiftUp || !!(h.b & BTN.UP);
    out.shiftDown = out.shiftDown || !!(h.b & BTN.DN);
  }

  private sendStatus() {
    if (!this.padOn || (this.ws?.readyState !== 1 && this.dc?.readyState !== 'open')) return;
    const g = (window as unknown as { __game?: GameLike }).__game;
    if (!g) return;
    const { car, session, stage } = g.world;
    const s = session.progressS;
    const next = stage.notes.find((n) => n.s > s - 5);
    this.toPad({
      t: 'st', g: car.shiftTimer > 0 ? car.pendingGear : car.gear, v: +(car.speed * 3.6).toFixed(1),
      r: +(Math.min(car.rpm, car.spec.engine.limiter) / car.spec.engine.limiter).toFixed(3),
      n: next?.text ?? '', d: next ? Math.max(0, Math.round(next.s - s)) : 0, run: session.phase === 'running' ? 1 : 0,
    });
  }

  private sendQuality() {
    if (!this.padOn) return;
    const w = this.stats.window(performance.now());
    this.toPad({ t: 'lq', hz: +w.hz.toFixed(1), st: w.stalls, gp: w.gaps, mx: Math.round(w.maxGap), lo: +w.loss.toFixed(1), j95: Math.round(w.jitter95) });
  }

  /** one stage run = one Game object from countdown on; a restart (countdown again) starts a new one */
  private trackRun(now: number) {
    const g = (window as unknown as { __game?: GameLike }).__game;
    const phase = g?.world.session.phase ?? '';
    const fresh = g && (g !== this.runKey || (phase === 'countdown' && this.runPhase !== 'countdown'));
    if (fresh || (!g && this.runKey)) {
      const s = this.stats.session(now);
      if (this.runKey && s.n > 0) this.lastRun = { secs: s.secs, n: s.n, loss: s.loss, stalls: s.stalls, gaps: s.gaps, gapMs: s.gapMs, maxGap: s.maxGap, ch: s.ch, rtt50: s.r50, rtt95: s.r95 };
      this.stats.resetSession(now);
      this.runKey = g ?? null;
    }
    this.runPhase = phase;
  }

  /** HUD: link tag (top right) while a phone drives; "手机断开" badge while it is gone; gap toasts */
  private watch() {
    const now = performance.now();
    this.trackRun(now);
    const fresh = this.state.fresh(now);
    const gap = this.pendingGap ? (this.pendingGap / 1000).toFixed(1) : '';
    if (fresh && !this.wasFresh) { if (this.everActive) this.showBadge(gap ? `手机已连接 · 中断了 ${gap} s` : '手机已连接', 'ok', 2); this.everActive = true; this.pendingGap = 0; }
    else if (!fresh && this.wasFresh) this.showBadge('手机断开 · 已收油回中 · 按 K 查看', 'alert', 0);
    else if (gap && fresh) { this.showBadge(`手机信号中断 ${gap} s`, 'warn', 2); this.pendingGap = 0; }
    this.wasFresh = fresh;
    if (this.badgeT > 0 && (this.badgeT -= 0.1) <= 0 && this.badge) this.badge.style.display = 'none';
    this.updateTag(now);
  }

  private updateTag(now: number) {
    const g = (window as unknown as { __game?: GameLike }).__game;
    const hudHidden = g?.hud?.root?.style.display === 'none';
    const show = !!g && !hudHidden && this.everActive && (this.padOn || this.state.fresh(now));
    if (!show) { if (this.tag) this.tag.style.display = 'none'; return; }
    if (!this.tag) {
      const t = document.createElement('div');
      t.className = 'phone-tag';
      t.style.cssText = 'position:fixed;top:40px;right:22px;z-index:12;padding:2px 8px;font:600 12px/1.5 Menlo,monospace;color:#f1ece0;background:rgba(27,27,27,.55);pointer-events:none;letter-spacing:0;white-space:nowrap';
      document.body.appendChild(t);
      this.tag = t;
    }
    const f = this.figures(now);
    const r = (v: number) => (Number.isFinite(v) ? Math.round(v) : '–');
    const text = this.state.fresh(now)
      ? `手机 ${f.channel === 'dc' ? 'UDP' : f.channel === 'http' ? 'POST' : 'WS'} ${r(f.rtt50)}/${r(f.rtt95)} ms · ${Math.round(f.hz)} Hz · 5 s 断流 ${f.gaps5}${f.loss5 >= 0.5 ? ` · 丢 ${f.loss5.toFixed(0)}%` : ''}`
      : '手机 —';
    if (this.tag.textContent !== text) this.tag.textContent = text;
    this.tag.style.display = '';
  }

  private showBadge(text: string, kind: 'ok' | 'warn' | 'alert', seconds: number) {
    if (!this.badge) {
      const b = document.createElement('div');
      b.className = 'phone-badge';
      b.style.cssText = 'position:fixed;top:96px;right:22px;z-index:12;padding:6px 12px;font-size:15px;font-weight:800;letter-spacing:1px;pointer-events:none;box-shadow:4px 4px 0 rgba(0,0,0,.55)';
      document.body.appendChild(b);
      this.badge = b;
    }
    this.badge.textContent = text;
    this.badge.style.background = kind === 'alert' ? '#c8362a' : kind === 'warn' ? '#e8b23a' : '#5aa865';
    this.badge.style.color = kind === 'warn' ? '#1b1b1b' : '#f1ece0';
    this.badge.style.display = '';
    this.badgeT = seconds;
  }
}
