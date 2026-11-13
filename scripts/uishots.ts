// npm run uishots — every menu screen + HUD states to docs/screenshots/m4/ (1600×900, main screens also 1512×982).
// Career states are seeded through the real rally state machine (src/sim/rally) into localStorage; runs are driven by
// the robot with fast-forward (?ai=1&ff=). Options: --only a,b (scene name substrings), --size 1600x900 (one size)
import { chromium } from 'playwright';
import { CHROME_ARGS } from './server';
import { ensurePreview, openUi, type Ui } from './uidrive';
import { listEnvs, stageLength } from '../src/sim/rally/catalog';
import { buildSeason, finishRally, finishSeason, newCareer, recordStage, startRally, type CareerState } from '../src/sim/rally/career';
import { SAVE_KEY, newSave, type SaveData } from '../src/sim/rally/save';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('only', '');
const DIR = 'docs/screenshots/m4';
const SIZES: Record<string, { width: number; height: number }> = { '': { width: 1600, height: 900 }, '-1512': { width: 1512, height: 982 } };

// ---- seeded saves (real state machine, synthetic times) ----
const envs = listEnvs();
/** a synthetic medal reference for stage k of the current rally (solo career: no rivals) */
function refFor(c: CareerState, k: number) {
  const sp = c.current!.plan.stages[k];
  return stageLength(sp.id, sp.reverse) / 24.5;
}
function playRally(c: CareerState, myFactor: number) {
  startRally(c);
  for (let k = 0; k < 3; k++) {
    const ref = refFor(c, k);
    recordStage(c, { total: ref * myFactor * (1 + 0.06 * k), penalties: 0 }, ref);
  }
}
function baseSave(): SaveData {
  const s = newSave(1_700_000_000_000);
  s.records = {
    'north-1': { best: 199.31, car: 'pipit', date: 1, medal: 'silver', ghost: false },
    'north-1-r': { best: 204.12, car: 'wren', date: 1, medal: 'bronze', ghost: false },
  };
  s.stats = { runs: 23, km: 104.6 };
  return s;
}
function seed(fn: (s: SaveData) => void) { const s = baseSave(); fn(s); return JSON.stringify({ [SAVE_KEY]: JSON.stringify(s) }); }
const seeds = {
  /** third rally finished, result not yet shown */
  rallyDone: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    playRally(c, 1.02); finishRally(c);
    playRally(c, 0.99); finishRally(c);
    playRally(c, 0.985);
    s.career = c;
  }),
  /** all four rallies done (second overall) */
  seasonDone: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    for (const f of [1.0, 0.99, 1.01, 0.995]) { playRally(c, f); finishRally(c); }
    s.career = c;
  }),
  /** mid season overview */
  overview: seed((s) => {
    const c = newCareer('wren', 2, buildSeason(0, envs, stageLength));
    playRally(c, 1.005); finishRally(c);
    playRally(c, 0.99); finishRally(c);
    s.career = c;
  }),
  /** champion after three seasons */
  champion: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    for (let season = 0; season < 3; season++) {
      if (season) { c.season = season; c.plan = buildSeason(season, envs, stageLength); c.rally = 0; c.points = 0; c.rallies = []; c.seasonEnd = null; }
      for (let i = 0; i < 4; i++) { playRally(c, 0.98); finishRally(c); }
      finishSeason(c);
    }
    s.unlockedGroup = 2;
    s.career = c;
  }),
};

const stop = await ensurePreview(5224);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
const errors: string[] = [];
const sizes = Object.entries(SIZES).filter(([suf]) => !args.includes('--size') || opt('size', '') === `${SIZES[suf].width}x${SIZES[suf].height}`);

async function scene(name: string, query: string, storage: string | undefined, multi: boolean, run: (ui: Ui, shot: (n: string) => Promise<void>) => Promise<void>) {
  if (ONLY && !ONLY.split(',').some((o) => name.includes(o))) return;
  for (const [suf, size] of multi ? sizes : sizes.slice(0, 1)) {
    console.log(`scene ${name}${suf}`);
    // intro=0: no first-run "怎么开" card unless the scene asks for it (scene 'intro')
    const ui = await openUi(query.includes('intro=') ? query : `${query}${query ? '&' : ''}intro=0`, size, { browser, storage: storage ?? JSON.stringify({}) });
    try { await run(ui, (n) => ui.shot(`${DIR}/${n}${suf}.jpg`)); }
    catch (e) { errors.push(`${name}${suf}: ${(e as Error).message}`); await ui.shot(`${DIR}/_failed-${name}${suf}.jpg`).catch(() => {}); }
    finally { errors.push(...ui.errors.map((e) => `${name}${suf}: ${e}`)); await ui.close(); }
  }
}
let stored = '';
const focusOn = async (ui: Ui, label: string, key = 'ArrowDown', max = 14) => {
  for (let i = 0; i < max; i++) {
    const t = await ui.eval(() => (document.querySelector('.focus') as HTMLElement | null)?.textContent?.trim() ?? '');
    if (t.startsWith(label)) return;
    await ui.key(key, 1, 120);
  }
  throw new Error('cannot focus ' + label);
};

try {
  await scene('front', '', undefined, true, async (ui, shot) => {
    await ui.waitScreen('title'); await ui.wait(400); await shot('01-title');
    await ui.key('Enter'); await ui.waitScreen('menu'); await shot('02-menu');
    await ui.key('ArrowDown', 2); await ui.wait(600); await shot('02-menu-time');
  });
  await scene('garage', 'screen=garage', seeds.overview, true, async (ui, shot) => {
    await ui.waitScreen('garage'); await ui.wait(1200); await shot('03-garage');
    await ui.key('ArrowRight', 3); await ui.wait(1200); await shot('03-garage-locked');
  });
  await scene('single', 'screen=single', seeds.overview, true, async (ui, shot) => {
    await ui.waitScreen('single-env'); await shot('04-env-select');
    await ui.key('Enter'); await ui.waitScreen('single-stage'); await ui.wait(4000); await shot('05-stage-select');
  });
  await scene('settings', 'screen=settings', seeds.overview, true, async (ui, shot) => {
    await ui.waitScreen('settings'); await ui.wait(300);
    const tabs = ['drive', 'feel', 'event', 'sound', 'video', 'control', 'save'];
    for (const [i, t] of tabs.entries()) { if (i) await ui.key('KeyE'); await ui.wait(250); await shot(`06-settings-${t}`); }
    await ui.key('ArrowDown', 6); await ui.key('Enter'); await ui.wait(400); await shot('06-settings-clear-dialog');
    await ui.key('Escape');
  });
  await scene('career-overview', 'screen=career', seeds.overview, true, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.wait(300); await shot('07-career-overview');
    await ui.key('Enter'); await ui.waitScreen('briefing'); await shot('08-briefing');
  });
  // first stage of a new save: the "怎么开" card over the paused stage (career: 新手 assists recommended)
  await scene('intro', 'screen=career&intro=1&ai=1', JSON.stringify({}), true, async (ui, shot) => {
    await ui.waitScreen('car-pick'); await ui.key('Enter'); await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('briefing');
    await ui.key('Enter'); await ui.waitScreen('intro', 60_000); await ui.wait(600); await shot('19-intro');
  });
  await scene('career-new', 'screen=career', undefined, false, async (ui, shot) => {
    await ui.waitScreen('car-pick'); await ui.wait(1200); await shot('07-career-new-carpick');
  });
  await scene('rally-result', 'screen=career', seeds.rallyDone, false, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('rally-result'); await ui.wait(300); await shot('11-rally-result');
  });
  await scene('season-result', 'screen=career', seeds.seasonDone, true, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('season-result'); await ui.wait(300); await shot('12-season-result');
  });
  await scene('ending', 'screen=career', seeds.champion, false, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.wait(300); await shot('12-career-champion');
    await ui.key('Enter'); await ui.waitScreen('ending'); await ui.wait(300); await shot('13-ending');
  });
  // a career stage: HUD with medal-line splits, pause, stage result with medal and season points
  await scene('career-run', 'screen=career&ai=1&ff=6', seeds.overview, false, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('briefing'); await ui.key('Enter');
    await ui.waitScreen('run', 60_000);
    await ui.page.waitForFunction(() => (window as any).__game.world.session.time > 70, null, { timeout: 120_000 });
    await ui.wait(700); await shot('14-hud-career');
    await ui.eval(() => (window as any).__game.hud.setLite(true)); await ui.wait(400); await shot('14-hud-lite');
    await ui.eval(() => (window as any).__game.hud.setLite(false));
    await ui.eval(() => { const g = (window as any).__game; g.world.session.resetCar(g.world.car); }); await ui.wait(250); await shot('14-hud-penalty');
    await ui.key('Escape'); await ui.waitScreen('pause'); await shot('09-pause-career');
    await focusOn(ui, '退出到菜单'); await ui.key('Enter'); await ui.wait(400); await shot('09-pause-quit-dialog');
    await ui.key('Escape'); await ui.wait(300); await ui.key('Escape');
    await ui.waitScreen('result', 240_000); await ui.wait(500); await shot('15-result-career');
    await focusOn(ui, '继续', 'ArrowLeft'); await ui.key('Enter'); await ui.waitScreen('briefing'); await ui.wait(300); await shot('16-briefing-after-stage');
  });
  // single stage: result + replay cameras; time challenge with a ghost
  await scene('single-run', 'screen=time&ai=1&ff=10', JSON.stringify({}), false, async (ui, shot) => {
    await ui.waitScreen('time-env'); await ui.key('Enter'); await ui.waitScreen('time-stage'); await ui.wait(3500); await shot('05-time-stage-noghost');
    await ui.key('Enter'); await ui.waitScreen('run', 60_000); await ui.wait(1200); await shot('14-hud-start');
    await ui.waitScreen('result', 240_000); await ui.wait(600); await shot('15-result');
    await focusOn(ui, '看回放', 'ArrowRight'); await ui.key('Enter'); await ui.waitScreen('replay');
    await ui.eval(() => (window as any).__game.replaySeek(42)); await ui.wait(1600); await shot('17-replay-tv');
    await ui.key('KeyC'); await ui.wait(1500); await shot('17-replay-chase');
    await ui.key('KeyC'); await ui.wait(2500); await shot('17-replay-heli');
    await ui.key('Escape'); await ui.waitScreen('result');
    stored = await ui.eval(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))));
  });
  // time challenge against the ghost of that run (real time; the robot waits 2.5 s after the start so the ghost leads)
  await scene('ghost', 'screen=time&ai=1', stored || undefined, false, async (ui, shot) => {
    await ui.waitScreen('time-env'); await ui.key('Enter'); await ui.waitScreen('time-stage'); await ui.wait(800); await shot('05-time-stage-ghost');
    await ui.key('Enter'); await ui.waitScreen('run', 60_000);
    await ui.eval(() => { const g = (window as any).__game; g.bot = null; });
    await ui.page.waitForFunction(() => (window as any).__game.world.session.time > 1.2, null, { timeout: 60_000 });
    await ui.eval(() => { (window as any).__game.enableBot(); });
    await ui.page.waitForFunction(() => (window as any).__game.world.session.time > 21, null, { timeout: 60_000 });
    await shot('18-time-ghost');
  });
} finally {
  await browser.close();
  stop();
}
if (errors.length) { console.log('\nerrors:'); for (const e of errors) console.log(' - ' + e); process.exitCode = 1; }
else console.log('\nall scenes ok');
