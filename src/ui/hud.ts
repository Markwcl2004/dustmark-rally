// In-race HUD (DOM): timer + progress, pace notes (next 3), speed / gear / rpm, countdown, penalties, finish panel,
// penalty pop-ups, target/medal line, compact ("精简") mode.
// Per frame only text that changed is written (no layout churn).
import type { PaceNote } from '../sim/stage/pacenotes';
import { noteIcon } from './icons';

export const fmtTime = (t: number) => {
  const neg = t < 0; t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
};

const el = (tag: string, cls: string, parent: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

export interface HudState {
  time: number; penalties: number; progress: number; speedKmh: number; gear: number; rpm: number; redline: number; limiter: number;
  phase: 'countdown' | 'running' | 'finished'; notes: PaceNote[]; s: number; resets: number;
  /** index of the note the co-driver is reading (or about to read) → highlighted */
  callIdx?: number;
  /** split vs the reference robot: latest split number, total, delta (s, + = slower) */
  split?: { n: number; of: number; delta: number; label?: string } | null;
}

export class Hud {
  readonly root: HTMLElement;
  private timer: HTMLElement; private pen: HTMLElement; private bar: HTMLElement; private dot: HTMLElement;
  private speed: HTMLElement; private gear: HTMLElement; private rpmSegs: HTMLElement[] = [];
  private notesBox: HTMLElement; private noteEls: HTMLElement[] = [];
  private count: HTMLElement; private toast: HTMLElement;
  private finish: HTMLElement;
  private lastNotesKey = '';
  private audioHint: HTMLElement;
  private split: HTMLElement;
  private lastSplit = '';
  private splitFlash = 0;
  private lastCount = '';
  private toastT = 0;
  onRestart: (() => void) | null = null;

  constructor(parent: HTMLElement, stageName: string, notes: PaceNote[], startS: number, finishS: number, envName = '北境林道') {
    this.root = el('div', 'hud', parent);
    this.envName = envName;
    const top = el('div', 'hud-top', this.root);
    el('div', 'hud-stage', top, `<b>${envName}</b> · ${stageName}`);
    this.timer = el('div', 'hud-timer mono', top, '0:00.00');
    this.pen = el('div', 'hud-pen mono', top);
    this.target = el('div', 'hud-target mono', top);
    this.split = el('div', 'hud-split mono', top);
    const prog = el('div', 'hud-progress', top);
    this.bar = el('i', '', prog);
    this.dot = el('b', '', prog);
    // little ticks for jumps along the progress bar
    for (const n of notes) {
      if (n.kind !== 'jump' && n.grade !== 'hairpin') continue;
      const t = el('em', n.kind === 'jump' ? 'tick-jump' : 'tick-hp', prog);
      t.style.left = `${((n.s - startS) / (finishS - startS)) * 100}%`;
    }
    this.notesBox = el('div', 'hud-notes', this.root);
    for (let i = 0; i < 3; i++) this.noteEls.push(el('div', `note n${i}`, this.notesBox));
    const dash = el('div', 'hud-dash', this.root);
    this.predictTag = el('div', 'hud-predict', dash); this.predictTag.style.cssText = 'display:none;font-size:12px;letter-spacing:1px;padding:2px 8px;background:var(--panel);border-left:3px solid #5aa865';
    const rpm = el('div', 'hud-rpm', dash);
    for (let i = 0; i < 24; i++) this.rpmSegs.push(el('i', i >= 19 ? 'red' : i >= 15 ? 'amber' : '', rpm));
    const row = el('div', 'hud-row', dash);
    this.speed = el('div', 'hud-speed mono', row, '0');
    el('div', 'hud-unit', row, 'km/h');
    this.gear = el('div', 'hud-gear mono', row, '1');
    this.popEl = el('div', 'hud-pop', this.root);
    this.count = el('div', 'hud-count', this.root);
    this.toast = el('div', 'hud-toast', this.root);
    this.finish = el('div', 'hud-finish', this.root);
    this.finish.style.display = 'none';
    el('div', 'hud-keys', this.root, '方向键/WASD 驾驶（按住） · 空格 手刹 · 左Shift 轻踩 · R 回到路上(+5秒) · C 视角 · M 静音 · P 轨迹预测 · Esc 暂停');
    this.audioHint = el('div', 'hud-audio', this.root, '');
  }

  private envName: string;
  private target!: HTMLElement;
  private popEl!: HTMLElement;
  private popT = 0;
  private lastTimer = '';
  private lastPc = ''; private lastSpeed = ''; private lastGear = ''; private lastLit = -1;
  private lastPen = '';

  /** line under the timer (best medal still reachable, ghost gap …); '' hides it */
  setTarget(html: string) { if (this.target.innerHTML !== html) this.target.innerHTML = html; }

  /** big penalty pop-up ("+10 秒 · 抢跑") */
  showPenalty(sec: number, why: string) {
    this.popEl.innerHTML = `<b class="mono">+${sec} 秒</b><span>${why}</span>`;
    this.popEl.classList.remove('on');
    void this.popEl.offsetWidth;
    this.popEl.classList.add('on');
    this.popT = 2.6;
  }

  /** compact HUD: no key hints, one pace note, no progress ticks */
  setLite(on: boolean) { this.root.classList.toggle('lite', on); }

  private predictTag: HTMLElement;
  /** trajectory prediction label (empty = hidden) */
  setPredict(text: string) { if (this.predictTag.textContent !== text) { this.predictTag.textContent = text; this.predictTag.style.display = text ? '' : 'none'; } }

  setAudioHint(text: string) { if (this.audioHint.textContent !== text) this.audioHint.textContent = text; }

  showToast(text: string) { this.toast.textContent = text; this.toast.classList.add('on'); this.toastT = 2.2; }

  update(dt: number, h: HudState) {
    const tt = fmtTime(Math.max(0, h.time));
    if (tt !== this.lastTimer) { this.lastTimer = tt; this.timer.textContent = tt; }
    const pt = h.penalties > 0 ? `+${h.penalties}s 罚时` : '';
    if (pt !== this.lastPen) { this.lastPen = pt; this.pen.textContent = pt; }
    if (this.popT > 0) { this.popT -= dt; if (this.popT <= 0) this.popEl.classList.remove('on'); }
    const pc = `${(h.progress * 100).toFixed(1)}%`;
    if (pc !== this.lastPc) { this.lastPc = pc; this.bar.style.width = pc; this.dot.style.left = pc; }
    const spd = String(Math.round(h.speedKmh));
    if (spd !== this.lastSpeed) { this.lastSpeed = spd; this.speed.textContent = spd; }
    const gr = h.gear < 0 ? 'R' : h.gear === 0 ? 'N' : String(h.gear);
    if (gr !== this.lastGear) { this.lastGear = gr; this.gear.textContent = gr; }
    const lit = Math.round((Math.min(h.rpm, h.limiter) / h.limiter) * this.rpmSegs.length);
    if (lit !== this.lastLit) { this.lastLit = lit; for (let i = 0; i < this.rpmSegs.length; i++) this.rpmSegs[i].classList.toggle('on', i < lit); }
    // next three notes ahead of the car (keep one just passed visible very briefly); the one being read is lit
    let first = h.notes.findIndex((n) => n.s > h.s - 5);
    if (first < 0) first = h.notes.length;
    const ahead = h.notes.slice(first, first + 3);
    const key = ahead.map((n) => n.s).join(',') + '|' + (h.callIdx ?? -1);
    if (key !== this.lastNotesKey) {
      this.lastNotesKey = key;
      this.noteEls.forEach((e, i) => {
        const n = ahead[i];
        if (!n) { e.innerHTML = ''; e.style.visibility = 'hidden'; return; }
        e.style.visibility = 'visible';
        e.innerHTML = `<div class="ic">${noteIcon(n)}</div><div class="tx">${n.text}</div>`;
        e.classList.toggle('jump', n.kind === 'jump');
        e.classList.toggle('calling', first + i === h.callIdx);
      });
    }
    if (ahead[0]) {
      const d = ahead[0].s - h.s;
      const ds = d > 0 ? `${Math.round(d / 5) * 5} m` : '';
      if (this.noteEls[0].dataset.dist !== ds) this.noteEls[0].dataset.dist = ds;
    }
    // split vs reference
    const sp = h.split;
    const sk = sp ? `${sp.n}/${sp.of} ${sp.delta.toFixed(2)} ${sp.label ?? ''}` : '';
    if (sk !== this.lastSplit) {
      if (sp && this.lastSplit !== '' ) this.splitFlash = 3;
      this.lastSplit = sk;
      if (!sp) { this.split.textContent = ''; this.split.className = 'hud-split mono'; }
      else {
        const sign = sp.delta >= 0 ? '+' : '−';
        this.split.textContent = `分段 ${sp.n}/${sp.of}  ${sp.label ? sp.label + ' ' : ''}${sign}${Math.abs(sp.delta).toFixed(2)}`;
        this.split.className = `hud-split mono ${sp.delta > 0.005 ? 'slower' : 'faster'}`;
      }
    }
    if (this.splitFlash > 0) { this.splitFlash -= dt; this.split.classList.toggle('flash', this.splitFlash > 0); }
    // countdown
    let c = '';
    if (h.phase === 'countdown') c = String(Math.ceil(-h.time));
    else if (h.phase === 'running' && h.time < 0.9) c = 'GO';
    if (c !== this.lastCount) {
      this.lastCount = c;
      this.count.textContent = c;
      this.count.className = `hud-count ${c ? 'on' : ''} ${c === 'GO' ? 'go' : ''}`;
    }
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.toast.classList.remove('on'); }
  }

  showFinish(r: { time: number; penalties: number; total: number; topKmh: number; avgKmh: number; resets: number; stageName: string; ref?: number }) {
    this.finish.style.display = 'flex';
    this.finish.innerHTML = `
      <div class="fin-card">
        <div class="fin-head">赛段完成</div>
        <div class="fin-stage">${this.envName} · ${r.stageName}</div>
        <div class="fin-total mono">${fmtTime(r.total)}</div>
        <table>
          <tr><td>行驶用时</td><td class="mono">${fmtTime(r.time)}</td></tr>
          <tr><td>罚时</td><td class="mono">${r.penalties > 0 ? '+' + r.penalties + ' s（回到路上 ×' + r.resets + '）' : '无'}</td></tr>
          <tr><td>最高速度</td><td class="mono">${r.topKmh.toFixed(0)} km/h</td></tr>
          <tr><td>平均速度</td><td class="mono">${r.avgKmh.toFixed(1)} km/h</td></tr>
          ${r.ref ? `<tr><td>参考车手（机器人）</td><td class="mono">${fmtTime(r.ref)}  <span class="${r.total > r.ref ? 'slower' : 'faster'}">${r.total > r.ref ? '+' : '−'}${Math.abs(r.total - r.ref).toFixed(2)}</span></td></tr>` : ''}
        </table>
        <button class="fin-again">再来一次 <small>Enter</small></button>
      </div>`;
    (this.finish.querySelector('.fin-again') as HTMLButtonElement).onclick = () => this.onRestart?.();
  }

  hideFinish() { this.finish.style.display = 'none'; }
}
