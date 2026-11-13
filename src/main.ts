import './ui/style.css';
import './ui/ui.css';
import { Game, type RunConfig } from './app/game';
import { App, app } from './app/app';
import { feelOf } from './app/feel';
import { params, urlHas, directStart } from './app/params';
import { startTurntable } from './app/turntable';
import { installRoutes } from './ui/screens';
import { resultScreen } from './ui/screens/results';
import { normalizeSettings } from './sim/rally/settings';
import { medalFor, medalTargets } from './sim/rally/scoring';
import { STAGES, resolveStage } from './data/stages';

const loading = document.getElementById('loading')!;
const bar = loading.querySelector('.bar i') as HTMLElement;
const sub = loading.querySelector('.sub') as HTMLElement;

/** tools / debugging: ?stage= ?view= ?bot= … start a run directly, exactly as before the menus existed */
async function directBoot() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const t0 = performance.now();
  sub.textContent = '生成赛段…';
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  // saved settings, with whatever the URL names explicitly on top (not written back)
  const s = normalizeSettings(JSON.parse(JSON.stringify(app.save.settings)));
  if (urlHas('quality')) s.quality = params.quality as typeof s.quality;
  if (urlHas('assist')) s.assist = params.assist;
  if (urlHas('dynres')) s.dynres = params.dynres;
  if (urlHas('predict')) s.predict = !!params.predict;
  if (urlHas('predictT')) s.predictT = params.predictT;
  if (urlHas('callearly')) s.callEarly = params.callEarly;
  const def = resolveStage(params.stage, params.weather) ?? STAGES['north-1'];
  const cfg: RunConfig = {
    stage: params.stage, reverse: false, weather: params.weather, car: params.car, livery: params.livery, mode: 'direct',
    bot: params.bot, ff: params.ff, settings: s, feel: feelOf(app.save), ghost: null, targets: null,
  };
  const game = new Game(canvas, cfg);
  app.game = game;
  bar.style.width = '25%';
  await game.init((p, label) => { bar.style.width = `${25 + p * 75}%`; sub.textContent = `构建${label}…`; });
  console.log(`[dustmark] stage ready in ${(performance.now() - t0).toFixed(0)} ms`, game.view.stats.build, game.view.terrain.stats);
  (window as unknown as { __loadMs: number }).__loadMs = performance.now() - t0;
  loading.style.display = 'none';
  const base = def.base ?? def.id, rev = !!def.reverse, weather = def.weather ?? params.weather;
  const hooks = {
    finish: (r: Parameters<NonNullable<Game['onFinish']>>[0]) => {
      const ref = app.bots.peek(base, rev, weather, game.world.car.spec.id, 0.9);
      resultScreen(game, {
        envName: game.world.stage.env.name, stageName: def.name, reverse: rev, result: r, medal: ref ? medalFor(r.total, ref.total) : null, ref: ref?.total ?? null,
        prevBest: null, newBest: false, ghostSaved: false, ghostCmp: null,
        buttons: [
          { label: '再来一次', fn: () => game.restart() },
          { label: '看回放', fn: 'replay' },
          { label: '主菜单', fn: () => { app.endRun(); location.search = ''; } },
        ],
      });
    },
    pause: { restart: () => ({ allowed: true, label: '重跑赛段' }), quit: () => { app.endRun(); location.search = ''; } },
  };
  game.onFinish = hooks.finish;
  game.onPause = () => app.go.pause(game, hooks);
  game.onSettingsChanged = (patch) => app.changeSettings(patch);
  // reference robot (worker) for the split deltas and medal targets
  void app.bots.get(base, rev, weather, game.world.car.spec.id, 0.9, true).then((run) => {
    if (!game.compare) game.compare = App.robotCompare(run);
    (game.cfg as { targets: RunConfig['targets'] }).targets = medalTargets(run.total);
  }).catch((e) => console.warn('[splits] reference run failed', e));
  game.start();
}

async function menuBoot() {
  loading.style.display = 'none';
  document.getElementById('game')?.remove();
  const sc = params.screen;
  if (sc === 'menu') app.go.menu();
  else if (sc === 'garage') app.go.garage();
  else if (sc === 'single' || sc === 'time') app.go.stageSelect(sc);
  else if (sc === 'career') app.go.career();
  else if (sc === 'settings') app.go.settings(() => app.go.menu());
  else app.go.title();
  window.__ready = true;
}

async function boot() {
  app.init();
  installRoutes();
  if (params.view === 'car' || params.view === 'lineup') {
    loading.style.display = 'none';
    startTurntable(document.getElementById('game') as HTMLCanvasElement);
    return;
  }
  if (directStart) await directBoot();
  else await menuBoot();
}
boot().catch((e) => { sub.textContent = '加载失败：' + e.message; console.error(e); });
