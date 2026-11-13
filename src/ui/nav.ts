// Menu navigation: arrow keys / WASD / gamepad d-pad + stick move a visible focus between [data-nav] controls
// (spatially: the nearest control in that direction), Enter / Space / A activates, Esc / B goes back,
// Q E / LB RB switch tabs, ← → on a value row change the value. Mouse hover focuses, click activates.
import { ADJUST } from './dom';
import { sfx } from './sfx';

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'tabL' | 'tabR' | 'any';

export interface Screen {
  el: HTMLElement;
  /** Esc / B; return nothing */
  back?: () => void;
  /** screen-specific keys; return true when handled (runs before the default handling) */
  key?: (k: NavKey, e?: KeyboardEvent) => boolean;
  /** element to focus first */
  focus?: HTMLElement | null;
  /** called when the screen is removed */
  leave?: () => void;
  /** keep the focus inside this element (modal dialogs) */
  trap?: HTMLElement | null;
}

const KEYMAP: Record<string, NavKey> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Enter: 'ok', NumpadEnter: 'ok', Space: 'ok', Escape: 'back', Backspace: 'back', KeyQ: 'tabL', KeyE: 'tabR',
};

export class Nav {
  screen: Screen | null = null;
  current: HTMLElement | null = null;
  /** input is ignored (transition running) */
  locked = false;
  private pad = { prev: [] as boolean[], dir: '' as '' | NavKey, next: 0 };
  /** last focus per screen element (coming back to a screen restores it) */
  private memory = new WeakMap<HTMLElement, HTMLElement>();

  constructor() {
    addEventListener('keydown', (e) => this.onKey(e), true);
    addEventListener('mousemove', (e) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-nav]') as HTMLElement | null;
      if (t && t !== this.current && this.screen && this.inScope(t)) this.focus(t, false);
    }, { passive: true });
    const loop = () => { requestAnimationFrame(loop); this.pollPad(); };
    requestAnimationFrame(loop);
  }

  /** show a screen's controls to the navigator (call after its element is in the document) */
  set(screen: Screen | null) {
    if (this.screen && this.current) this.memory.set(this.screen.el, this.current);
    this.screen = screen;
    this.current = null;
    // a button already held when the screen appears (e.g. Start that opened the pause menu) must not act on it
    const p = this.gamepad();
    this.pad.prev = p ? p.buttons.map((b) => b.pressed) : [];
    if (!screen) return;
    const remembered = this.memory.get(screen.el);
    const first = (remembered && remembered.isConnected && this.inScope(remembered) ? remembered : null) ?? screen.focus ?? this.items()[0] ?? null;
    if (first) this.focus(first, false);
  }

  /** re-pick the focus after a screen re-rendered its controls */
  refresh(prefer?: HTMLElement | null) {
    if (!this.screen) return;
    const keep = prefer ?? (this.current?.isConnected ? this.current : null);
    this.current?.classList.remove('focus');
    this.current = null;
    const f = keep && this.inScope(keep) ? keep : this.screen.focus && this.screen.focus.isConnected ? this.screen.focus : this.items()[0];
    if (f) this.focus(f, false);
  }

  private scope() { return this.screen?.trap ?? this.screen?.el ?? null; }
  private inScope(e: HTMLElement) { const s = this.scope(); return !!s && s.contains(e) && e.offsetParent !== null; }

  items(): HTMLElement[] {
    const s = this.scope();
    if (!s) return [];
    return Array.from(s.querySelectorAll<HTMLElement>('[data-nav]')).filter((e) => e.offsetParent !== null && !e.closest('[data-nav-off]'));
  }

  focus(e: HTMLElement, sound = true) {
    if (this.current === e) return;
    this.current?.classList.remove('focus');
    this.current = e;
    e.classList.add('focus');
    e.focus({ preventScroll: true });
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (sound) sfx.play('move');
    e.dispatchEvent(new CustomEvent('navfocus', { bubbles: true }));
  }

  private onKey(e: KeyboardEvent) {
    if (!this.screen) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = KEYMAP[e.code];
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace'].includes(e.code)) e.preventDefault();
    if (this.locked) return;
    if (e.repeat && (k === 'ok' || k === 'back')) return;
    if (this.screen.key?.('any', e)) { e.preventDefault(); return; }
    if (k) { e.preventDefault(); this.handle(k, e); }
  }

  handle(k: NavKey, e?: KeyboardEvent) {
    const sc = this.screen;
    if (!sc || this.locked) return;
    if (sc.key?.(k, e)) return;
    if (k === 'back') { if (sc.back) { sfx.play('back'); sc.back(); } return; }
    const cur = this.current && this.current.isConnected && this.inScope(this.current) ? this.current : null;
    if (k === 'ok') {
      if (!cur) return;
      if (cur.getAttribute('aria-disabled') === 'true') { sfx.play('deny'); return; }
      sfx.play('ok');
      cur.click();
      return;
    }
    if ((k === 'left' || k === 'right') && cur && ADJUST.has(cur)) {
      if (cur.getAttribute('aria-disabled') === 'true') { sfx.play('deny'); return; }
      ADJUST.get(cur)!(k === 'left' ? -1 : 1);
      sfx.play('tick');
      return;
    }
    if (k === 'up' || k === 'down' || k === 'left' || k === 'right') this.move(k, cur);
  }

  /** spatial move: nearest control whose centre lies in that direction (perpendicular offset weighs double) */
  move(dir: 'up' | 'down' | 'left' | 'right', from: HTMLElement | null) {
    const items = this.items();
    if (!items.length) return;
    if (!from) { this.focus(items[0]); return; }
    const r0 = from.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best: HTMLElement | null = null, bs = Infinity;
    for (const e of items) {
      if (e === from) continue;
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      let main: number, perp: number, overlap: boolean;
      if (dir === 'left' || dir === 'right') {
        main = dir === 'right' ? r.left - r0.right : r0.left - r.right;
        if ((dir === 'right' ? x - cx : cx - x) <= 2) continue;
        overlap = r.bottom > r0.top + 2 && r.top < r0.bottom - 2;
        perp = overlap ? 0 : Math.abs(y - cy);
      } else {
        main = dir === 'down' ? r.top - r0.bottom : r0.top - r.bottom;
        if ((dir === 'down' ? y - cy : cy - y) <= 2) continue;
        overlap = r.right > r0.left + 2 && r.left < r0.right - 2;
        perp = overlap ? Math.abs(x - cx) * 0.1 : Math.abs(x - cx);
      }
      const score = Math.max(0, main) + perp * 2 + (overlap ? 0 : 40);
      if (score < bs) { bs = score; best = e; }
    }
    if (best) this.focus(best);
  }

  private gamepad(): Gamepad | null {
    for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected) return p;
    return null;
  }

  private pollPad() {
    const p = this.gamepad();
    if (!p || !this.screen) return;
    const prev = this.pad.prev;
    const pressed = (i: number) => p.buttons[i]?.pressed ?? false;
    const edge = (i: number) => pressed(i) && !prev[i];
    let fired: NavKey | null = null;
    if (edge(0)) fired = 'ok';
    else if (edge(1)) fired = 'back';
    else if (edge(4)) fired = 'tabL';
    else if (edge(5)) fired = 'tabR';
    else if (edge(9)) fired = 'ok';
    const anyEdge = p.buttons.some((_, i) => edge(i));
    this.pad.prev = p.buttons.map((b) => b.pressed);
    if (anyEdge && this.screen.key?.('any')) return;
    if (fired) { this.handle(fired); return; }
    // directions with auto-repeat (d-pad or left stick)
    const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
    const dir: '' | NavKey = pressed(12) || ay < -0.6 ? 'up' : pressed(13) || ay > 0.6 ? 'down' : pressed(14) || ax < -0.6 ? 'left' : pressed(15) || ax > 0.6 ? 'right' : '';
    const now = performance.now();
    if (dir !== this.pad.dir) { this.pad.dir = dir; if (dir) { this.handle(dir); this.pad.next = now + 380; } }
    else if (dir && now >= this.pad.next) { this.handle(dir); this.pad.next = now + 120; }
  }
}

export const nav = new Nav();
