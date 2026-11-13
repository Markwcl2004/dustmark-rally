// The game shell: save, screens (title → menus → runs → results), run lifecycle, robot reference times.
// Screens are plain DOM (src/ui/screens/*); one is shown at a time in #ui, others (pause, results, replay bar)
// sit over a running stage. URL direct starts (?stage= / ?view= / ?bot= …) bypass all of this (main.ts).
import { bots } from './botService';
import { Game, type Compare, type RunConfig, type RunResult } from './game';
import { params } from './params';
import { Input } from './input';
import { feelOf } from './feel';
import { MemoryKV, clearSave, loadSave, needsIntro, readGhost, writeGhost, writeSave, type KV, type SaveData } from '../sim/rally/save';
import { showIntro } from '../ui/screens/intro';
import type { GhostData } from '../sim/rally/ghost';
import { artKey, carEntry, envInfo, listCars, recordKey, stageInfo, stageLength, variantId } from '../sim/rally/catalog';
import { curveAt, type BotRun } from '../sim/rally/botTimes';
import { medalTargets } from '../sim/rally/scoring';
import { nav, type Screen } from '../ui/nav';
import { sfx } from '../ui/sfx';
import { wipe } from '../ui/transition';
import { applyTheme, themeFor, type Theme } from '../ui/theme';
import { bgUrl, firstAsset, h } from '../ui/dom';

export interface RunHooks {
  /** stage finished: show a result screen (the game is still alive behind it) */
  finish(r: RunResult, game: Game): void;
  /** pause menu: which items and what "quit" means */
  pause: { restart: () => { allowed: boolean; label: string; run?: () => void }; quit: (game: Game) => void };
  /** async comparison target (personal best / medal line) */
  compare?: (game: Game) => void;
}

function storage(): KV {
  try { const k = '__dm_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } catch { return new MemoryKV(); }
}

export class App {
  kv = storage();
  save!: SaveData;
  loadStatus = '';
  ui!: HTMLElement;
  current: Screen | null = null;
  overlayStack: Screen[] = [];
  game: Game | null = null;
  hooks: RunHooks | null = null;
  readonly bots = bots;
  /** screen factories (registered by src/ui/screens/index.ts to avoid import cycles) */
  go!: Routes;

  init() {
    const r = loadSave(this.kv);
    this.save = r.save;
    this.loadStatus = r.status;
    if (r.status === 'corrupt') console.warn(`[save] unreadable save backed up to ${r.backupKey}; starting a new one`);
    if (r.status !== 'ok') this.persist();
    // the trajectory-prediction switch used to be kept in its own key as well (the overlay wrote it on every P press,
    // the save only by accident): take its last value once, then the save's setting is the only copy
    try {
      const legacy = this.kv.getItem('dustmark.predict');
      if (legacy !== null) { this.save.settings.predict = legacy === '1'; this.kv.removeItem('dustmark.predict'); this.persist(); }
    } catch { /* storage blocked */ }
    if (params.unlock) this.save.unlockedGroup = 2;
    this.ui = document.getElementById('ui') ?? document.body.appendChild(h('div', { id: 'ui' }));
    this.applyUiSettings();
    (window as unknown as { __app: App }).__app = this;
  }

  persist() { if (!writeSave(this.kv, this.save)) console.warn('[save] storage refused the save'); }

  /** a setting changed outside the settings screen (P in a run): into the save, written now */
  changeSettings(patch: Partial<SaveData['settings']>) {
    Object.assign(this.save.settings, patch);
    this.persist();
  }

  applyUiSettings() {
    const v = this.save.settings.vol;
    sfx.setVolume(v.ui * v.master);
  }

  resetSave() {
    clearSave(this.kv);
    const r = loadSave(this.kv);
    this.save = r.save;
    this.persist();
    this.applyUiSettings();
  }

  // ---- screens ----

  /** replace the screen (with the colour wipe unless instant) */
  show(make: () => Screen, opts: { theme?: Theme; instant?: boolean; colors?: string[] } = {}): Promise<void> {
    const swap = () => {
      this.closeOverlays();
      this.current?.leave?.();
      this.current?.el.remove();
      const s = make();
      s.el.classList.add('screen');
      applyTheme(s.el, opts.theme ?? themeFor(undefined));
      this.ui.appendChild(s.el);
      this.current = s;
      nav.set(s);
      (window as unknown as { __screen: string }).__screen = s.el.dataset.screen ?? '';
    };
    if (opts.instant) { swap(); return Promise.resolve(); }
    const t = opts.theme ?? themeFor(undefined);
    return wipe(swap, opts.colors ?? [t.deep, t.accent, '#1b1b1b']);
  }

  /** a screen over the current one / over the running game (pause, results, dialogs) */
  overlay(s: Screen, theme?: Theme) {
    s.el.classList.add('screen', 'overlay');
    applyTheme(s.el, theme ?? themeFor(this.game ? artKey(this.game.world.stage.env.id) : undefined));
    this.ui.appendChild(s.el);
    this.overlayStack.push(s);
    nav.set(s);
    (window as unknown as { __screen: string }).__screen = s.el.dataset.screen ?? '';
  }

  closeOverlay(s?: Screen) {
    const top = s ?? this.overlayStack[this.overlayStack.length - 1];
    if (!top) return;
    this.overlayStack = this.overlayStack.filter((x) => x !== top);
    top.leave?.();
    top.el.remove();
    const under = this.overlayStack[this.overlayStack.length - 1] ?? (this.game ? null : this.current);
    nav.set(under ?? null);
    (window as unknown as { __screen: string }).__screen = under?.el.dataset.screen ?? (this.game ? 'run' : '');
  }

  closeOverlays() { while (this.overlayStack.length) this.closeOverlay(); }

  // ---- runs ----

  /** start a stage run from the menus: wipe → loading card → build → go */
  async startRun(cfg: Omit<RunConfig, 'settings' | 'ff' | 'bot'> & { bot?: boolean }, hooks: RunHooks) {
    const full: RunConfig = { ...cfg, bot: cfg.bot ?? params.ai, ff: params.ff, settings: this.save.settings, feel: feelOf(this.save) };
    const env = stageInfo(cfg.stage)?.env ?? 'north';
    const theme = themeFor(artKey(env));
    const loading = document.getElementById('loading')!;
    await wipe(() => {
      this.closeOverlays();
      this.current?.leave?.();
      this.current?.el.remove();
      this.current = null;
      nav.set(null);
      this.endRun();
      this.fillLoading(loading, cfg.stage, cfg.reverse, cfg.weather, cfg.car);
      loading.style.display = 'flex';
    }, [theme.deep, theme.accent, '#1b1b1b']);
    const t0 = performance.now();
    const canvas = h('canvas', { id: 'game' });
    document.body.insertBefore(canvas, document.body.firstChild);
    const bar = loading.querySelector('.bar i') as HTMLElement;
    const sub = loading.querySelector('.sub') as HTMLElement;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const game = new Game(canvas, full);
    this.game = game;
    this.hooks = hooks;
    bar.style.width = '15%';
    await game.init((p, label) => { bar.style.width = `${15 + p * 85}%`; sub.textContent = `构建${label}…`; });
    (window as unknown as { __loadMs: number }).__loadMs = performance.now() - t0;
    console.log(`[dustmark] stage ready in ${(performance.now() - t0).toFixed(0)} ms`);
    game.onFinish = (r) => hooks.finish(r, game);
    game.onPause = () => this.go.pause(game, hooks);
    game.onSettingsChanged = (patch) => this.changeSettings(patch);
    hooks.compare?.(game);
    await wipe(() => { loading.style.display = 'none'; (window as unknown as { __screen: string }).__screen = 'run'; }, [theme.accent, theme.deep, '#1b1b1b']);
    game.start();
    // first stage of a new save: the "怎么开" card over the paused stage (career's first rally recommends 新手 assists)
    if (params.intro && needsIntro(this.save)) {
      game.setPaused(true);
      const c = this.save.career;
      await showIntro(cfg.mode === 'career' && c && c.season === 0 && c.rally === 0 ? 'novice' : undefined);
      if (this.game === game) game.setPaused(false);
    }
    this.save.stats.runs++;
  }

  endRun() {
    if (!this.game) return;
    this.game.dispose();
    this.game = null;
    this.hooks = null;
    Input.shared().setEnabled(false);
  }

  /** loading cards shown (the two loading pictures alternate) */
  private loads = 0;

  private fillLoading(el: HTMLElement, stage: string, reverse: boolean, weather: string, car: string) {
    const st = stageInfo(stage), env = st ? envInfo(st.env) : undefined;
    const art = artKey(env?.id ?? 'north');
    const img = firstAsset(`/assets/ui/loading_${(this.loads++ % 2) + 1}.jpg`, '/assets/ui/loading_1.jpg', `/assets/ui/env_${art}_wide.jpg`);
    const w = st?.weathers.find((x) => x.id === weather)?.name ?? '';
    const c = carEntry(car);
    applyTheme(el, themeFor(art));
    el.style.backgroundImage = bgUrl(img);
    el.innerHTML = '';
    el.append(
      h('div', { class: 'ld-block' },
        h('div', { class: 'ld-env' }, env?.name ?? ''),
        h('div', { class: 'ld-name' }, st?.name ?? stage),
        h('div', { class: 'ld-meta' }, `${reverse ? '反向' : '正向'} · ${w} · ${(stageLength(stage, reverse) / 1000).toFixed(2)} km · ${c ? `${c.name} ${c.model}` : ''}`),
        h('div', { class: 'bar' }, h('i')),
        h('div', { class: 'sub' }, '生成赛段…'),
        h('div', { class: 'ld-tip' }, TIPS[Math.floor(Math.random() * TIPS.length)]),
      ),
    );
  }

  // ---- robot references ----

  /** reference run (robot 0.9) for a stage + car, urgent */
  ref(stage: string, reverse: boolean, weather: string, car: string): Promise<BotRun> { return this.bots.get(stage, reverse, weather, car, 0.9, true); }

  /** medal targets once the reference is known */
  targets(stage: string, reverse: boolean, weather: string, car: string) {
    const r = this.bots.peek(stage, reverse, weather, car, 0.9);
    return r ? medalTargets(r.total) : null;
  }

  /** comparison against the reference robot (split curve) */
  static robotCompare(run: BotRun, label = '参考'): Compare | null {
    if (!run.curve) return null;
    const c = run.curve;
    return { label, at: (d) => curveAt(c, d) };
  }

  ghostFor(stage: string, reverse: boolean): GhostData | null { return readGhost(this.kv, recordKey(stage, reverse)); }
  storeGhost(stage: string, reverse: boolean, g: GhostData) {
    const ok = writeGhost(this.kv, recordKey(stage, reverse), g);
    const rec = this.save.records[recordKey(stage, reverse)];
    if (rec) rec.ghost = ok;
    return ok;
  }

  /** cars the player may drive */
  unlockedCars() { return listCars().filter((c) => c.available && c.groupIdx <= this.save.unlockedGroup); }
}

export const TIPS = [
  'R 回到路上，罚 5 秒；倒计时里越过起点线算抢跑，罚 10 秒。',
  '切弯绕过检查点罚 15 秒：冲出路面再从前面绕回来不算捷径。',
  '生涯每个赛段按用时拿金 / 银 / 铜（3 / 2 / 1 分），赛季攒够分数解锁下一组别。',
  'P 打开轨迹预测：路面上的色带是保持当前操作 2.5 秒后的去向。',
  '空格手刹过发卡：先刹车减速，再拉手刹甩尾，给油拉直。',
  'C 切换视角：追尾远 / 追尾近 / 引擎盖 / 保险杠。',
  '领航员按车速提前报路，可在设置里调早或调晚。',
  '计时挑战里，半透明的车是你在这条赛段上最好的一次。',
];

/** routes into the screens (filled by src/ui/screens/index.ts) */
export interface Routes {
  title(): void;
  menu(): void;
  garage(): void;
  stageSelect(mode: 'single' | 'time', env?: string): void;
  career(): void;
  /** tab: open on this settings page (e.g. 'feel' from the pause menu) */
  settings(back: () => void, overGame?: boolean, tab?: string): void;
  pause(game: Game, hooks: RunHooks): void;
}

export const app = new App();
