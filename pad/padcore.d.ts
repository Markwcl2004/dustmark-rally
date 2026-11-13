// Types for pad/padcore.js (plain JS so the phone page and serve.mjs can use it without a build step).
export declare const BTN: { HB: number; UP: number; DN: number };
export type PadAction = 'reset' | 'pause' | 'camera' | 'predict';
export declare const PAD_ACTIONS: PadAction[];
export interface PadConfig { zero?: number; range: number; deadzone: number; curve: number; invert: boolean }
export declare const PAD_DEFAULTS: PadConfig & { pedal: 'analog' | 'switch'; travel: number };
export declare const TILT_OFF: number;
export declare const TILT_ON: number;
export declare function clamp(x: number, a: number, b: number): number;
export declare function wrapDeg(d: number): number;
export interface HoldState { side: number; reliable: boolean }
export declare function holdAngle(gx: number, gy: number, gz: number, prev?: HoldState): { angle: number; side: number; reliable: boolean; ratio: number };
export declare function shapeSteer(angle: number, cfg: PadConfig): number;
export declare class LowPass { constructor(fc?: number); fc: number; v: number[] | null; step(x: number[], dt: number): number[]; reset(): void }
export declare function pedalValue(y0: number, y: number, travel?: number, mode?: 'analog' | 'switch'): number;
export declare const MAX_PAD_MSG: number;
export declare const MAX_GAME_MSG: number;
export declare const MAX_RTC_MSG: number;
export interface PadInputMsg { t: 'in'; q: number; ts: number; ev: number; s: number; th: number; br: number; b: number; a: number[]; ok: 0 | 1 }
export interface PadPingMsg { t: 'ping'; ts: number }
export interface PadStatMsg { t: 'stat'; ch: '' | 'dc' | 'ws' | 'http'; r50: number; r95: number; rd50: number; rd95: number; hz: number; mhz: number; rc: number; dc: number }
export interface RtcMsg { t: 'rtc'; id: number; sdp: string }
export interface GameStatusMsg { t: 'st'; g: number; v: number; r: number; n: string; d: number; run: 0 | 1 }
export interface GamePongMsg { t: 'pong'; ts: number }
export interface GameAckMsg { t: 'k'; q: number }
export interface GameQualityMsg { t: 'lq'; hz: number; st: number; gp: number; mx: number; lo: number; j95: number }
export declare function sdpOk(s: unknown): string | null;
export declare function sanitizePadMsg(raw: unknown): PadInputMsg | PadPingMsg | PadStatMsg | RtcMsg | null;
export declare function sanitizeGameMsg(raw: unknown): GameStatusMsg | GamePongMsg | GameAckMsg | GameQualityMsg | RtcMsg | null;
export declare const CODE_LEN: number;
export declare function makeCode(randInt: (n: number) => number): string;
export declare function codeMatches(given: unknown, code: string): boolean;
export declare class RateLimit { constructor(rate: number, burst: number); take(now: number): boolean }
export declare const PAD_TIMEOUT_MS: number;
export declare function newerPkt(a: { ts: number; q: number }, b: { ts: number; q: number }): boolean;
export declare class PadState {
  last: PadInputMsg | null; at: number; connected: boolean;
  feed(p: PadInputMsg | PadPingMsg | PadStatMsg | RtcMsg | null, now: number): boolean;
  fresh(now: number): boolean;
  takeActions(): PadAction[];
  forget(): void;
}
export declare const HOLD_MS: number;
export declare const FADE_MS: number;
export declare const RELEASE_MS: number;
export declare const RECOVER_MS: number;
export declare const STALL_MS: number;
export declare const GAP_MS: number;
export declare const STALE_MS: number;
export interface HoldOut { s: number; th: number; br: number; b: number; age: number; hold: boolean }
export declare class PadHold { out: { s: number; th: number; br: number }; sample(state: PadState, now: number): HoldOut | null }
export declare function quantile(a: ArrayLike<number>, p: number): number;
export declare class Rolling { constructor(ms?: number); push(now: number, v: unknown): void; values(now: number): unknown[]; q(now: number, p: number): number; count(now: number): number }
export interface LinkWindow { hz: number; stalls: number; gaps: number; maxGap: number; loss: number; jitter95: number; share: { dc: number; ws: number; http: number }; n: number }
export interface LinkSession { secs: number; n: number; lost: number; loss: number; stalls: number; gaps: number; gapMs: number; maxGap: number; ch: { dc: number; ws: number; http: number }; r50: number; r95: number; r95max: number }
export declare class LinkStats {
  prevQ: number;
  resetSession(now: number): void;
  newStream(): void;
  isStale(p: { ts: number }, epochNow: number, now: number): boolean;
  onPacket(now: number, p: { q: number; ts: number }, ch: 'dc' | 'ws' | 'http', accepted: boolean, epochNow: number): void;
  onPadStat(m: { r50: number; r95: number }): void;
  openGap(now: number): number;
  window(now: number): LinkWindow;
  session(now: number): LinkSession;
}
