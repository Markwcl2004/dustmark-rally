// Keyboard + Gamepad → DriverInput. Edge-triggered actions (reset, camera, pause, perf) are queued for the game loop.
//
// Keyboard map (手感重做 2026-11-12; every driving key works by being HELD):
//   ← → / A D   steer            ↑ / W   throttle        ↓ / S   brake        Space   handbrake
//   Left Shift  轻踩 (gentle): while held, throttle ≤ 50 %, brake ≤ 45 %, steering ≤ 60 % (URL gentle= sets the ratio)
//   E / Q       shift up / down (manual gearbox)          R reset · C camera · P prediction · H HUD · M mute
//   Esc pause · Enter restart · F3 perf
// The feel knobs (grip= slipcap= push= steerrate= gentle=, src/sim/vehicle/tune.ts) are read from the URL here, before
// the game builds its car; the saved 手感 settings (src/app/feel.ts) fill the knobs the URL does not name.
import { emptyInput, type DriverInput } from '../sim/vehicle/controls';
import { applyTuneParams, gentleCaps, TUNE } from '../sim/vehicle/tune';
import { PhonePad } from './phonePad';

if (typeof location !== 'undefined') {
  const q = new URLSearchParams(location.search);
  applyTuneParams((k) => q.get(k));
}

export type Action = 'reset' | 'camera' | 'pause' | 'perf' | 'restart' | 'hud' | 'mute' | 'predict';

export interface PadSettings { deadzone: number; curve: number }

export class Input {
  private keys = new Set<string>();
  private actions: Action[] = [];
  private prevPad: boolean[] = [];
  pad: PadSettings = { deadzone: 0.08, curve: 1.6 };
  /** 轻踩 ratio (the game sets it from its car's tune when the car is set up) */
  gentle = TUNE.gentle;
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';
  enabled = true;
  /** iPhone steering wheel (scripts/serve.mjs relay); idle when the page is not served by it */
  readonly phone = new PhonePad((a) => { if (this.enabled) this.actions.push(a); });

  constructor() {
    addEventListener('keydown', (e) => {
      // the key that closed a menu (Esc / Enter) must not act on the game in the same event
      if (!this.enabled || e.timeStamp <= this.enabledAt) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      const map: Record<string, Action> = { KeyR: 'reset', KeyC: 'camera', Escape: 'pause', F3: 'perf', Enter: 'restart', KeyH: 'hud', KeyM: 'mute', KeyP: 'predict' };
      if (map[e.code]) this.actions.push(map[e.code]);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  takeActions(): Action[] { const a = this.actions; this.actions = []; return a; }

  /** one Input for the whole page (keyboard listeners and the phone pad connection live as long as the page) */
  private static inst: Input | null = null;
  static shared(): Input { return (Input.inst ??= new Input()); }

  /** menus on top of the game: stop reading driving keys and drop anything held / queued */
  setEnabled(on: boolean) { if (on && !this.enabled) this.enabledAt = performance.now(); this.enabled = on; this.keys.clear(); this.actions = []; }
  private enabledAt = -1;

  private k(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }

  sample(out: DriverInput = emptyInput()): DriverInput {
    const left = this.k('ArrowLeft', 'KeyA'), right = this.k('ArrowRight', 'KeyD');
    out.steer = (right ? 1 : 0) - (left ? 1 : 0);
    out.throttle = this.k('ArrowUp', 'KeyW') ? 1 : 0;
    out.brake = this.k('ArrowDown', 'KeyS') ? 1 : 0;
    out.handbrake = this.k('Space') ? 1 : 0;
    // 轻踩: held left Shift caps the keyboard pedals and steering (a partial key target; the sim ramps toward it)
    if (this.k('ShiftLeft')) {
      const c = gentleCaps(this.gentle);
      out.steer *= c.steer; out.throttle *= c.throttle; out.brake *= c.brake;
    }
    out.shiftUp = this.k('KeyE');
    out.shiftDown = this.k('KeyQ');
    out.digital = true;
    this.samplePad(out);
    this.phone.apply(out);
    return out;
  }

  private samplePad(out: DriverInput) {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] ?? 0;
      const dz = this.pad.deadzone;
      const mag = Math.max(0, (Math.abs(ax) - dz) / (1 - dz));
      const steer = Math.sign(ax) * Math.pow(mag, this.pad.curve);
      const rt = p.buttons[7]?.value ?? 0, lt = p.buttons[6]?.value ?? 0;
      const a = p.buttons[0]?.pressed ?? false;
      const used = Math.abs(steer) > 0.02 || rt > 0.05 || lt > 0.05 || a;
      if (used) this.lastDevice = 'gamepad';
      if (this.lastDevice === 'gamepad') {
        out.steer = steer; out.digital = false;
        out.throttle = Math.max(out.throttle, rt);
        out.brake = Math.max(out.brake, lt);
        out.handbrake = Math.max(out.handbrake, a ? 1 : 0);
      }
      out.shiftUp = out.shiftUp || (p.buttons[2]?.pressed ?? false); // X
      out.shiftDown = out.shiftDown || (p.buttons[1]?.pressed ?? false); // B
      // edge actions: Y = camera, Back/View = reset, Start = pause
      const edges: [number, Action][] = [[3, 'camera'], [8, 'reset'], [9, 'pause']];
      for (const [bi, act] of edges) {
        const now = p.buttons[bi]?.pressed ?? false;
        if (now && !this.prevPad[bi]) this.actions.push(act);
        this.prevPad[bi] = now;
      }
      break;
    }
  }
}
