// npm-less dev tool (收尾：去掉对手): screenshots of the solo career screens → docs/screenshots/m6/solo/ (1600×900 and
// 1280×720 for the text-overflow check). Career states are seeded through the real state machine (src/sim/rally/career)
// with synthetic times; one real career stage is driven by the robot (?ai=1&ff=) for the stage result and the HUD.
//   npx tsx scripts/soloshots.ts [--only a,b]   (server: its own build on DUSTMARK_PORT or 5252)
import { chromium } from 'playwright';
import { CHROME_ARGS } from './server';
import { ensurePreview, openUi, type Ui } from './uidrive';
import { listEnvs, stageLength } from '../src/sim/rally/catalog';
import { MEDAL_RATIO } from '../src/sim/rally/scoring';
import { SEASON_UNLOCK_POINTS, buildSeason, finishRally, finishSeason, newCareer, recordStage, startRally, type CareerState } from '../src/sim/rally/career';
import { SAVE_KEY, newSave, type SaveData } from '../src/sim/rally/save';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('only', '');
const DIR = 'docs/screenshots/m6/solo';
const SIZES: [string, { width: number; height: number }][] = [['', { width: 1600, height: 900 }], ['-720p', { width: 1280, height: 720 }]];

const envs = listEnvs();
const ref = (c: CareerState, k: number) => { const sp = c.current!.plan.stages[k]; return stageLength(sp.id, sp.reverse) / 24.5; };
/** a rally with the given time ratios against the medal reference (one per stage) */
function playRally(c: CareerState, ratios: number[]) {
  startRally(c);
  for (let k = 0; k < 3; k++) recordStage(c, { total: ref(c, k) * ratios[k], penalties: 0 }, ref(c, k));
}
const G = (MEDAL_RATIO.gold + 1) / 2, S = (MEDAL_RATIO.gold + MEDAL_RATIO.silver) / 2, B = (MEDAL_RATIO.silver + MEDAL_RATIO.bronze) / 2, N = MEDAL_RATIO.bronze * 1.05;
function seed(fn: (s: SaveData) => void) {
  const s = newSave(1_700_000_000_000);
  s.records = { 'north-1': { best: 199.31, car: 'pipit', date: 1, medal: 'silver', ghost: false } };
  s.stats = { runs: 23, km: 104.6 };
  s.introSeen = true;
  fn(s);
  return JSON.stringify({ [SAVE_KEY]: JSON.stringify(s) });
}
const seeds = {
  /** two rallies done, the third started (one stage) */
  overview: seed((s) => {
    const c = newCareer('wren', 2, buildSeason(0, envs, stageLength));
    playRally(c, [S, B, N]); finishRally(c);
    playRally(c, [B, B, S]); finishRally(c);
    startRally(c); recordStage(c, { total: ref(c, 0) * B, penalties: 5 }, ref(c, 0));
    s.career = c;
  }),
  /** third rally finished, result not shown yet */
  rallyDone: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    playRally(c, [S, B, N]); finishRally(c);
    playRally(c, [B, B, B]); finishRally(c);
    playRally(c, [G, S, B]);
    s.career = c;
  }),
  /** season over with enough points (unlock) */
  seasonOk: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    for (const rs of [[S, B, N], [B, S, B], [G, S, B], [S, B, B]]) { playRally(c, rs); finishRally(c); }
    s.career = c;
  }),
  /** season over short of the points */
  seasonShort: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    for (const rs of [[N, B, N], [B, N, N], [N, N, B], [N, B, N]]) { playRally(c, rs); finishRally(c); }
    s.career = c;
  }),
  /** champion after three seasons */
  champion: seed((s) => {
    const c = newCareer('pipit', 0, buildSeason(0, envs, stageLength));
    for (let season = 0; season < 3; season++) {
      if (season) { c.season = season; c.plan = buildSeason(season, envs, stageLength); c.rally = 0; c.points = 0; c.rallies = []; c.seasonEnd = null; }
      for (let i = 0; i < 4; i++) { playRally(c, [G, S, B]); finishRally(c); }
      finishSeason(c);
    }
    s.unlockedGroup = 2;
    s.career = c;
  }),
};
console.log(`unlock points ${SEASON_UNLOCK_POINTS.join('/')}, medal lines ×${MEDAL_RATIO.gold}/${MEDAL_RATIO.silver}/${MEDAL_RATIO.bronze}`);

if (!process.env.DUSTMARK_PORT) process.env.DUSTMARK_PORT = '5252';
const stop = await ensurePreview(Number(process.env.DUSTMARK_PORT));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
const errors: string[] = [];
async function scene(name: string, query: string, storage: string, multi: boolean, run: (ui: Ui, shot: (n: string) => Promise<void>) => Promise<void>) {
  if (ONLY && !ONLY.split(',').some((o) => name.includes(o))) return;
  for (const [suf, size] of multi ? SIZES : SIZES.slice(0, 1)) {
    console.log(`scene ${name}${suf}`);
    const ui = await openUi(`${query}${query ? '&' : ''}intro=0`, size, { browser, storage });
    try { await run(ui, (n) => ui.shot(`${DIR}/${n}${suf}.jpg`)); }
    catch (e) { errors.push(`${name}${suf}: ${(e as Error).message}`); await ui.shot(`${DIR}/_failed-${name}${suf}.jpg`).catch(() => {}); }
    finally { errors.push(...ui.errors.map((e) => `${name}${suf}: ${e}`)); await ui.close(); }
  }
}
const focusOn = async (ui: Ui, label: string, key = 'ArrowDown', max = 14) => {
  for (let i = 0; i < max; i++) {
    const t = await ui.eval(() => (document.querySelector('.focus') as HTMLElement | null)?.textContent?.trim() ?? '');
    if (t.startsWith(label)) return;
    await ui.key(key, 1, 120);
  }
  throw new Error('cannot focus ' + label);
};
/** overflow check: elements whose text is wider / taller than their box */
const overflow = (ui: Ui) => ui.eval(() => Array.from(document.querySelectorAll('[data-screen] *')).filter((e) => {
  const x = e as HTMLElement;
  if (!x.offsetParent || !x.textContent?.trim() || x.children.length > 3) return false;
  const cs = getComputedStyle(x);
  if (cs.overflow === 'visible' && cs.whiteSpace !== 'nowrap') return x.scrollWidth > x.clientWidth + 2 && x.clientWidth > 0 && cs.display !== 'inline';
  return x.scrollWidth > x.clientWidth + 2 || x.scrollHeight > x.clientHeight + 2;
}).map((e) => `${(e as HTMLElement).className || e.tagName}: ${(e.textContent ?? '').slice(0, 40)}`).slice(0, 8));
const checkText = async (ui: Ui, where: string) => {
  const txt = await ui.eval(() => document.body.innerText);
  for (const w of ['对手', '名次', '积分榜', '难度', '车手', '第 1 名', '领奖台', '车损', '维修', '损伤', '损坏', '爆胎', '车况']) if (txt.includes(w)) errors.push(`${where}: text contains "${w}"`);
  const of = await overflow(ui);
  if (of.length) console.log(`  ${where}: possible overflow → ${of.join(' | ')}`);
};

try {
  await scene('overview', 'screen=career', seeds.overview, true, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.wait(400); await checkText(ui, 'overview'); await shot('01-career-overview');
    await ui.key('Enter'); await ui.waitScreen('briefing'); await ui.wait(400); await checkText(ui, 'briefing'); await shot('02-briefing');
  });
  await scene('rally-result', 'screen=career', seeds.rallyDone, true, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('rally-result'); await ui.wait(400); await checkText(ui, 'rally-result'); await shot('05-rally-result');
    await ui.key('Enter'); await ui.waitScreen('career'); await ui.wait(300); await shot('05b-overview-after-rally');
  });
  await scene('season-ok', 'screen=career', seeds.seasonOk, true, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('season-result'); await ui.wait(400); await checkText(ui, 'season-result'); await shot('06-season-result-unlock');
  });
  await scene('season-short', 'screen=career', seeds.seasonShort, true, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('season-result'); await ui.wait(400); await checkText(ui, 'season-short'); await shot('07-season-result-short');
  });
  await scene('garage', 'screen=garage', seeds.seasonShort, false, async (ui, shot) => {
    await ui.waitScreen('garage'); await ui.key('ArrowRight', 3); await ui.wait(1400); await checkText(ui, 'garage'); await shot('08-garage-locked');
  });
  await scene('ending', 'screen=career', seeds.champion, false, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.wait(300); await shot('09-career-champion');
    await ui.key('Enter'); await ui.waitScreen('ending'); await ui.wait(400); await checkText(ui, 'ending'); await shot('10-ending');
  });
  // a real career stage driven by the robot: HUD (medal-line split + target line), stage result with medal + points
  await scene('stage', 'screen=career&ai=1&ff=8', seeds.overview, false, async (ui, shot) => {
    await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('briefing'); await ui.key('Enter');
    await ui.waitScreen('run', 60_000);
    await ui.page.waitForFunction(() => (window as any).__game.world.session.maxProgressS - (window as any).__game.world.stage.startS > 1030, null, { timeout: 120_000 });
    await ui.wait(300); await checkText(ui, 'hud'); await shot('11-hud-career-split');
    await ui.waitScreen('result', 300_000); await ui.wait(700); await checkText(ui, 'stage-result'); await shot('04-stage-result');
    await focusOn(ui, '继续', 'ArrowLeft'); await ui.key('Enter'); await ui.waitScreen('briefing'); await ui.wait(400); await checkText(ui, 'between-stages'); await shot('04b-between-stages');
  });
} finally {
  await browser.close();
  stop();
}
if (errors.length) { console.log('\nproblems:'); for (const e of errors) console.log(' - ' + e); process.exitCode = 1; }
else console.log('\nall scenes ok');
