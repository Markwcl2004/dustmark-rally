// Career screens (solo — no rivals): new career (car pick) → season overview (calendar, medals, season points) →
// rally briefing → stage → stage result (medal, points, personal best) → next stage → … →
// rally result (three medals, points) → season result (points against the unlock threshold) → next season / ending.
import { app, type RunHooks } from '../../app/app';
import type { Game, RunResult } from '../../app/game';
import { h, navItem, firstAsset, bgUrl, fmtTime } from '../dom';
import { nav, type Screen } from '../nav';
import { sfx } from '../sfx';
import { button, confirm, hints } from './common';
import { garageScreen } from './garage';
import { resultScreen } from './results';
import { medalImg } from './stages';
import { soloCompare } from './splits';
import { themeFor, BASE } from '../theme';
import {
  MEDAL_POINTS, RALLIES_PER_SEASON, SEASON_CN, SEASON_MAX_POINTS, STAGES_PER_RALLY, buildSeason, currentRallyPlan, finishRally,
  finishSeason, judgeStage, newCareer, nextSeason, rallyPoints, rallyTime, recordStage, seasonMedals, seasonOver,
  seasonProgress, startRally, useRestart, type CareerState, type RallyProgress, type StagePlan,
} from '../../sim/rally/career';
import { artKey, carEntry, carsInGroup, envInfo, listEnvs, recordKey, stageInfo, stageLength, GROUPS } from '../../sim/rally/catalog';
import { MEDAL_CN, medalFor, medalTargets, type Medal } from '../../sim/rally/scoring';
import { updateRecord } from '../../sim/rally/save';
import '../career.css';

const C = () => app.save.career!;
const save = () => app.persist();
const rallyTheme = (env: string) => themeFor(artKey(env));
const mmss = (min: number) => `${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, '0')}`;

// ---- medal lines (robot reference, analog 0.9) ----

/** the reference run of a calendar stage with the career car (table → cache → worker); a failed run is estimated
 *  from the stage length so the rally can go on */
async function stageRef(sp: StagePlan, car: string, urgent: boolean): Promise<number> {
  try { return (await app.bots.get(sp.id, sp.reverse, sp.weather, car, 0.9, urgent)).total; } catch (e) {
    console.warn('[career] reference run failed, estimating', e);
    return stageLength(sp.id, sp.reverse) / 23;
  }
}
const peekRef = (sp: StagePlan, car: string) => app.bots.peek(sp.id, sp.reverse, sp.weather, car, 0.9)?.total ?? null;

/** queue the reference runs the rally will need (current stage first; normally all in the precomputed table) */
export function prefetchRally(c: CareerState) {
  const plan = currentRallyPlan(c);
  if (!plan) return;
  const from = c.current?.stage ?? 0;
  plan.stages.forEach((sp, k) => { if (k >= from) void stageRef(sp, c.car, k === from).catch(() => {}); });
}

const medalRow = (ms: Medal[], n = STAGES_PER_RALLY, cls = 'medal-sm') => h('span', { class: 'cr-medals' },
  Array.from({ length: n }, (_, i) => (i < ms.length ? (ms[i] ? medalImg(ms[i], cls) : h('span', { class: `cr-nomedal ${cls}` }, '—')) : h('span', { class: `cr-slot ${cls}` }))));

/** "本赛季 x / y 分 · 再拿 z 分解锁下一组别" + a bar with the threshold mark */
function seasonBar(c: CareerState, compact = false) {
  const p = seasonProgress(c);
  const goal = p.last ? '夺得生涯冠军' : `解锁${GROUPS[c.season + 1]}`;
  const msg = p.reached ? `已够${p.last ? '夺冠' : '解锁'}分数，跑完本季即${p.last ? '夺冠' : `解锁${GROUPS[c.season + 1]}`}`
    : p.reachable ? `再拿 ${p.toGo} 分${goal}` : `本季已拿不够 ${p.need} 分，跑完后可以重赛本季`;
  return h('div', { class: `cr-season ${compact ? 'compact' : ''} ${p.reached ? 'ok' : ''}` },
    h('div', { class: 'cr-season-h' }, h('b', { class: 'mono' }, `${p.points}`), h('span', null, `/ ${p.need} 分`), h('em', null, msg)),
    h('div', { class: 'cr-bar' }, h('i', { style: `width:${(Math.min(p.points, p.max) / p.max) * 100}%` }), h('b', { style: `left:${(p.need / p.max) * 100}%` })),
  );
}

const RULES = `每个赛段按用时拿奖牌：金 ${MEDAL_POINTS.gold} 分、银 ${MEDAL_POINTS.silver} 分、铜 ${MEDAL_POINTS.bronze} 分，完赛无奖牌 0 分。本季 ${RALLIES_PER_SEASON * STAGES_PER_RALLY} 个赛段，满分 ${SEASON_MAX_POINTS}。`;

// ---- entry ----

export function careerEntry() {
  const c = app.save.career;
  if (!c) { newCareerPick(0, true); return; }
  if (c.current?.inStage) { c.current.inStage = false; save(); }
  void app.show(overview, { theme: BASE });
}

/** choose the car for a season (new career / next season / retry) */
function newCareerPick(season: number, fresh: boolean) {
  const group = carsInGroup(season).filter((c) => c.available).map((c) => c.id);
  void app.show(() => garageScreen({
    only: group, title: [fresh ? '新生涯 · 选车' : `${SEASON_CN[season]} · 选车`, `${GROUPS[season]} · CHOOSE YOUR CAR`],
    back: () => (fresh ? app.go.menu() : careerEntry()),
    onPick: (car, liv) => {
      const plan = buildSeason(season, listEnvs(), stageLength);
      if (fresh || !app.save.career) app.save.career = newCareer(car, liv, plan);
      else nextSeason(app.save.career, plan, car, liv);
      app.save.garage.liveries[car] = liv;
      save();
      void app.show(overview, { theme: BASE });
    },
  }), { theme: BASE });
}

// ---- season overview ----

function overview(): Screen {
  const c = C();
  const plan = c.plan;
  const car = carEntry(c.car);
  const cards = plan.rallies.map((r, i) => {
    const env = envInfo(r.env)!;
    const done = c.rallies[i];
    const isNext = i === c.rally;
    const cur = isNext ? c.current : null;
    return h('div', { class: `cal-card ${done ? 'done' : ''} ${isNext ? 'next' : ''}`, style: `--deep:${themeFor(env.art).deep};--accent:${themeFor(env.art).accent}` },
      h('div', { class: 'cal-img', style: `background-image:${bgUrl(firstAsset(`/assets/ui/poster_${env.art}.jpg`))}` }),
      h('div', { class: 'cal-n mono' }, String(i + 1).padStart(2, '0')),
      h('div', { class: 'cal-tag' },
        h('b', null, r.name),
        h('span', null, env.name),
        done ? h('div', { class: 'cal-medals' }, medalRow(done.medals, STAGES_PER_RALLY, 'medal-xs2'), h('em', null, `+${done.points} 分`))
          : h('em', null, cur ? `进行中 · 第 ${cur.stage + 1} / ${STAGES_PER_RALLY} 赛段${cur.results.length ? ` · +${rallyPoints(cur)} 分` : ''}` : isNext ? '下一站' : '未开始'),
      ),
    );
  });
  const m = seasonMedals(c);
  const panel = h('div', { class: 'co-table panel cr-panel' },
    h('div', { class: 'panel-h' }, '赛季进度', h('small', null, `${c.rallies.length} / ${RALLIES_PER_SEASON} 站`)),
    seasonBar(c),
    h('div', { class: 'cr-counts' }, (['gold', 'silver', 'bronze'] as const).map((k) => h('span', null, medalImg(k, 'medal-sm'), h('b', { class: 'mono' }, `× ${m[k]}`))), h('span', null, h('span', { class: 'cr-nomedal medal-sm' }, '—'), h('b', { class: 'mono' }, `× ${m.none}`))),
    h('p', { class: 'cr-rules' }, RULES, ' ', c.season < 2 ? `攒够 ${seasonProgress(c).need} 分解锁${GROUPS[c.season + 1]}和它的两台车。` : `攒够 ${seasonProgress(c).need} 分拿下生涯冠军。`),
  );

  const actions: HTMLElement[] = [];
  const cur = c.current;
  if (c.champion && c.seasonEnd?.careerDone) {
    actions.push(button('看结局', () => void app.show(ending, { theme: BASE }), { cls: 'go' }));
    actions.push(button('重新开始生涯', () => confirm('重新开始生涯？', '当前生涯进度会清空；已解锁的车和组别保留。', [{ label: '重新开始', fn: () => { app.save.career = null; save(); newCareerPick(0, true); } }, { label: '取消', fn: () => {} }])));
  } else if (seasonOver(c)) actions.push(button('赛季结算', () => void app.show(seasonResult, { theme: BASE }), { cls: 'go' }));
  else if (cur && cur.stage >= STAGES_PER_RALLY) actions.push(button('分站结算', () => void app.show(rallyResult, { theme: rallyTheme(cur.plan.env) }), { cls: 'go' }));
  else {
    const p = currentRallyPlan(c)!;
    actions.push(button(cur ? `继续 · 第 ${cur.stage + 1} 赛段` : `开始 · ${p.name}`, () => { if (!c.current) { startRally(c); save(); } void app.show(briefing, { theme: rallyTheme(p.env) }); }, { cls: 'go' }));
  }
  actions.push(button('放弃生涯', () => confirm('放弃生涯？', '进度会清空，已解锁的车和组别保留。', [{ label: '放弃', cls: 'danger', fn: () => { app.save.career = null; save(); app.go.menu(); } }, { label: '取消', fn: () => {} }])));
  const el = h('div', { class: 'career-ov', 'data-screen': 'career' },
    h('div', { class: 'art dim-art', style: `background-image:${bgUrl(firstAsset('/assets/ui/menu_bg_3.jpg'))}` }),
    h('div', { class: 'co-main' },
      h('div', { class: 'co-head' }, h('div', { class: 'hl-latin' }, `CAREER · SEASON ${c.season + 1}`), h('h1', { class: 'hl-cn' }, SEASON_CN[c.season]),
        h('div', { class: 'co-car' }, car ? `${car.name} ${car.model} · ${car.driveCn} · ${car.hp} hp` : '')),
      h('div', { class: 'cal' }, cards),
      h('div', { class: 'co-actions' }, actions),
    ),
    panel,
    hints([['← →', '选择'], ['Enter', '确认'], ['Esc', '主菜单']]),
  );
  if (!seasonOver(c) && !c.champion) prefetchRally(c);
  return { el, back: () => app.go.menu(), focus: actions[0] };
}

// ---- rally briefing ----

function briefing(): Screen {
  const c = C(), r = c.current!;
  const env = envInfo(r.plan.env)!;
  const car = carEntry(c.car)!;
  const rows = r.plan.stages.map((sp, k) => {
    const st = stageInfo(sp.id)!;
    const w = st.weathers.find((x) => x.id === sp.weather)?.name ?? sp.weather;
    const res = r.results[k];
    return [
      h('div', { class: `bf-stage ${k === r.stage ? 'next' : ''} ${res ? 'done' : ''}` },
        h('span', { class: 'bf-k mono' }, `SS${k + 1}`),
        h('span', { class: 'bf-main' }, h('b', null, st.name), h('small', null, `${sp.reverse ? '反向' : '正向'} · ${w} · ${st.surface}`)),
        h('span', { class: 'bf-len mono' }, `${(stageLength(sp.id, sp.reverse) / 1000).toFixed(2)} km`),
        h('span', { class: 'bf-res mono' }, res ? h('span', { class: 'cr-res' }, fmtTime(res.total), res.medal ? medalImg(res.medal, 'medal-xs2') : null, h('small', null, res.retired ? '退赛 0 分' : `+${res.points} 分`)) : k === r.stage ? '下一个' : ''),
      ),
    ];
  });
  // the next stage's medal lines (shown once its reference run is known — normally at once, from the table)
  const sp = r.plan.stages[r.stage];
  const lines = h('div', { class: 'cr-lines' });
  const fillLines = (ref: number | null) => {
    lines.textContent = '';
    if (!ref) { lines.append(h('span', { class: 'cr-wait' }, '奖牌线计算中…')); return; }
    const t = medalTargets(ref);
    lines.append(...(['gold', 'silver', 'bronze'] as const).map((m) => h('span', null, medalImg(m, 'medal-sm'), h('b', { class: 'mono' }, fmtTime(t[m])), h('small', null, `+${MEDAL_POINTS[m]} 分`))));
  };
  if (sp) { fillLines(peekRef(sp, c.car)); if (!peekRef(sp, c.car)) void stageRef(sp, c.car, true).then((x) => fillLines(x)); }
  const go = button(`出发 · 第 ${r.stage + 1} 赛段`, () => runCareerStage(), { cls: 'go' });
  const el = h('div', { class: 'briefing', 'data-screen': 'briefing' },
    h('div', { class: 'bf-poster', style: `background-image:${bgUrl(firstAsset(`/assets/ui/poster_${env.art}.jpg`))}` }),
    h('div', { class: 'bf-body' },
      h('div', { class: 'hl-latin' }, `${SEASON_CN[c.season]} · 第 ${c.rally + 1} / ${RALLIES_PER_SEASON} 站`),
      h('h1', { class: 'hl-cn' }, r.plan.name),
      h('div', { class: 'bf-env' }, `${env.name} · ${env.character}`),
      h('div', { class: 'bf-stages' }, rows),
      sp ? h('div', { class: 'cr-next' }, h('span', null, `SS${r.stage + 1} 奖牌线`), lines) : null,
      h('div', { class: 'bf-facts' },
        h('div', null, h('span', null, '赛车'), h('b', null, `${car.name} ${car.model}`)),
        h('div', null, h('span', null, '重跑机会'), h('b', null, `${r.restartsLeft} 次`)),
        h('div', null, h('span', null, '本站'), h('b', { class: 'mono' }, r.results.length ? `${fmtTime(rallyTime(r))} · +${rallyPoints(r)} 分` : '—')),
      ),
      seasonBar(c, true),
      h('div', { class: 'bf-actions' }, go, button('返回赛季', () => void app.show(overview, { theme: BASE }))),
    ),
    hints([['↑ ↓', '选择'], ['Enter', '出发'], ['Esc', '返回']]),
  );
  prefetchRally(c);
  return { el, back: () => void app.show(overview, { theme: BASE }), focus: go };
}

// ---- the stage ----

function runCareerStage() {
  const c = C(), r = c.current!, k = r.stage, sp = r.plan.stages[k];
  r.inStage = true;
  save();
  const ref = peekRef(sp, c.car);
  const hooks: RunHooks = {
    finish: (res, game) => void onStageFinish(res, game),
    pause: {
      restart: () => ({
        allowed: r.restartsLeft > 0, label: `重跑 · 剩 ${r.restartsLeft} 次`,
        run: () => { if (useRestart(r)) { save(); app.game?.restart(); } },
      }),
      quit: (game) => confirm('退出这个赛段？', '生涯里中途退出有代价：', [
        { label: '保存并退出', sub: r.restartsLeft > 0 ? '本次作废，下次从本赛段起点重跑（用掉本站 1 次重跑）' : '本站重跑次数已用完，只能退赛', disabled: r.restartsLeft <= 0, fn: () => { useRestart(r); r.inStage = false; save(); app.endRun(); void app.show(overview, { theme: BASE }); } },
        { label: '退赛本赛段', sub: '本赛段 0 分，进度保存', cls: 'danger', fn: () => void retire(game) },
        { label: '继续比赛', fn: () => { app.closeOverlays(); game.setPaused(false); } },
      ]),
    },
    // splits: personal best on this stage (its ghost) if there is one, else the medal lines; HUD target line = medals
    compare: (game) => {
      soloCompare(game, { stage: sp.id, reverse: sp.reverse, weather: sp.weather, car: c.car });
      if (!game.cfg.targets) void stageRef(sp, c.car, true).then((x) => { (game.cfg as { targets: unknown }).targets = medalTargets(x); });
    },
  };
  void app.startRun({ stage: sp.id, reverse: sp.reverse, weather: sp.weather, car: c.car, livery: c.livery, mode: 'career', ghost: null, targets: ref ? medalTargets(ref) : null }, hooks);
}

/** after the stage: the screen that comes next in the rally */
function nextAfterStage() {
  const r = C().current!;
  if (r.stage < STAGES_PER_RALLY) void app.show(briefing, { theme: rallyTheme(r.plan.env) });
  else void app.show(rallyResult, { theme: rallyTheme(r.plan.env) });
}

async function onStageFinish(res: RunResult, game: Game) {
  const c = C(), r = c.current!, k = r.stage, sp = r.plan.stages[k];
  const ref = await stageRef(sp, c.car, true);
  const j = judgeStage({ total: res.total }, ref);
  // personal best on the stage variant (shared with single stage / time challenge; judged on the run's own time)
  const key = recordKey(sp.id, sp.reverse);
  const prev = app.save.records[key];
  let newBest = false, ghostSaved = false;
  if (res.finished) {
    newBest = updateRecord(app.save, key, res.total, c.car, medalFor(res.total, ref));
    if (newBest && res.ghost) ghostSaved = app.storeGhost(sp.id, sp.reverse, { car: c.car, livery: c.livery, total: res.total, date: Date.now(), data: res.ghost });
    save();
  }
  const sNow = seasonProgress(c);
  const season = { ...sNow, points: sNow.points + j.points, toGo: Math.max(0, sNow.need - sNow.points - j.points), reached: sNow.points + j.points >= sNow.need };
  const commit = () => {
    if (r.stage !== k) return false;
    r.inStage = false;
    recordStage(c, { total: res.total, penalties: res.penalties }, ref);
    app.save.stats.km += res.lengthM / 1000;
    save();
    return true;
  };
  const env = envInfo(r.plan.env)!;
  resultScreen(game, {
    envName: env.name, stageName: game.world.stage.def.name, reverse: sp.reverse, result: res, medal: j.medal, ref, prevBest: prev?.best ?? null, newBest, ghostSaved, ghostCmp: null,
    career: { points: j.points, season },
    buttons: [
      { label: '继续', fn: () => { const ok = commit(); app.endRun(); if (ok) nextAfterStage(); else void app.show(overview, { theme: BASE }); } },
      { label: `重跑 · 剩 ${r.restartsLeft}`, disabled: r.restartsLeft <= 0, fn: () => { if (useRestart(r)) { save(); game.restart(); } } },
      { label: '看回放', fn: 'replay' },
      { label: '回菜单', fn: () => { commit(); app.endRun(); app.go.menu(); } },
    ],
  });
}

async function retire(game: Game) {
  const c = C(), r = c.current!, k = r.stage;
  const res = game.result();
  const ref = peekRef(r.plan.stages[k], c.car);
  r.inStage = false;
  recordStage(c, { total: res.total, penalties: res.penalties, retired: true }, ref);
  save();
  app.endRun();
  nextAfterStage();
}

// ---- rally result ----

function rallyResult(): Screen {
  const c = C();
  const r = c.current;
  const results = r && r.stage >= STAGES_PER_RALLY ? r.results : null;
  const plan = r?.plan;
  const sum = r && r.stage >= STAGES_PER_RALLY ? finishRally(c) : c.rallies[c.rallies.length - 1];
  save();
  const env = envInfo(sum.env)!;
  const best = (['gold', 'silver', 'bronze'] as const).find((m) => sum.medals.includes(m)) ?? null;
  const trophy = sum.medals.every((m) => m === 'gold') ? firstAsset('/assets/ui/trophy_gold.png') : null;
  const go = button(seasonOver(c) ? '赛季结算' : '赛季总览', () => void app.show(seasonOver(c) ? seasonResult : overview, { theme: BASE }), { cls: 'go' });
  const rows = sum.medals.map((m, k) => {
    const sp = plan?.stages[k], st = sp ? stageInfo(sp.id) : null, res = results?.[k];
    return h('tr', null,
      h('td', { class: 'pos mono' }, `SS${k + 1}`),
      h('td', { class: 'nm' }, st?.name ?? '', sp ? h('small', null, sp.reverse ? '反向' : '正向') : null),
      h('td', { class: 'tm mono' }, res ? fmtTime(res.total) : ''),
      h('td', { class: 'cr-mcell' }, m ? medalImg(m, 'medal-sm') : h('span', { class: 'cr-nomedal medal-sm' }, '—')),
      h('td', { class: 'pts mono' }, res?.retired ? '退赛' : `+${m ? MEDAL_POINTS[m] : 0}`),
    );
  });
  const el = h('div', { class: 'rally-result', 'data-screen': 'rally-result' },
    h('div', { class: 'art dim-art', style: `background-image:${bgUrl(firstAsset(`/assets/ui/env_${env.art}_wide.jpg`))}` }),
    h('div', { class: 'rr-left' },
      h('div', { class: 'hl-latin' }, 'RALLY RESULT'),
      h('h1', { class: 'hl-cn' }, sum.name),
      h('div', { class: 'rr-pos cr-pts' }, h('b', { class: 'mono' }, `+${sum.points}`), h('span', null, '分', h('br'), `总用时 ${fmtTime(sum.time)}`)),
      trophy ? h('img', { class: 'rr-trophy', src: trophy, alt: '' }) : h('div', { class: 'cr-big-medals' }, medalRow(sum.medals, STAGES_PER_RALLY, 'medal-lg')),
      h('div', { class: 'rr-note' }, trophy ? '三个赛段全金' : best ? `最好的一段：${MEDAL_CN[best]}牌` : '这一站没有拿到奖牌'),
      h('div', { class: 'rr-actions' }, go),
    ),
    h('div', { class: 'panel rr-table' }, h('div', { class: 'panel-h' }, '本站赛段'), h('table', { class: 'tbl' }, rows),
      h('div', { class: 'cr-rr-season' }, seasonBar(c, true))),
    hints([['Enter', '继续']]),
  );
  if (sum.points > 0) sfx.play('medal');
  return { el, back: () => void app.show(overview, { theme: BASE }), focus: go };
}

// ---- season result ----

function seasonResult(): Screen {
  const c = C();
  const end = finishSeason(c);
  if (end.unlockGroup !== null && end.unlockGroup > app.save.unlockedGroup) app.save.unlockedGroup = end.unlockGroup;
  save();
  const unlockedCars = end.unlockGroup !== null ? carsInGroup(end.unlockGroup) : [];
  const m = seasonMedals(c);
  const actions: HTMLElement[] = [];
  if (end.careerDone) actions.push(button('看结局', () => void app.show(ending, { theme: BASE }), { cls: 'go' }));
  else if (end.qualified) actions.push(button('进入下一赛季', () => newCareerPick(c.season + 1, false), { cls: 'go' }));
  else actions.push(button('重赛本季', () => newCareerPick(c.season, false), { cls: 'go' }));
  actions.push(button('回主菜单', () => app.go.menu()));
  const rallies = h('table', { class: 'tbl cr-sr-tbl' }, c.rallies.map((x) => h('tr', null, h('td', { class: 'nm' }, x.name), h('td', null, medalRow(x.medals, STAGES_PER_RALLY, 'medal-xs2')), h('td', { class: 'pts mono' }, `+${x.points}`))));
  const el = h('div', { class: 'season-result', 'data-screen': 'season-result' },
    h('div', { class: 'art', style: `background-image:${bgUrl(firstAsset('/assets/ui/podium_bg.jpg'))}` }),
    h('div', { class: 'sr-head' }, h('div', { class: 'hl-latin' }, `SEASON ${c.season + 1} · RESULT`), h('h1', { class: 'hl-cn' }, `${SEASON_CN[c.season]} 结束`)),
    end.qualified && firstAsset('/assets/ui/trophy_gold.png') ? h('img', { class: 'cr-sr-trophy', src: firstAsset('/assets/ui/trophy_gold.png')!, alt: '' }) : null,
    h('div', { class: 'sr-card panel' },
      h('div', { class: 'sr-me' }, h('b', { class: 'mono' }, String(end.points)), h('span', null, `赛季总分 · 需要 ${end.need} 分`)),
      h('div', { class: 'cr-counts' }, (['gold', 'silver', 'bronze'] as const).map((k) => h('span', null, medalImg(k, 'medal-sm'), h('b', { class: 'mono' }, `× ${m[k]}`))), h('span', null, h('span', { class: 'cr-nomedal medal-sm' }, '—'), h('b', { class: 'mono' }, `× ${m.none}`))),
      rallies,
      h('p', { class: 'sr-msg' }, end.careerDone ? `顶级组拿到 ${end.points} 分：你拿下了尘迹拉力的全部三个赛季。`
        : end.qualified ? `够了！解锁 ${GROUPS[end.unlockGroup!]}：${unlockedCars.map((x) => `${x.name} ${x.model}`).join('、')}`
        : `还差 ${end.need - end.points} 分，下一组别还锁着——再跑一季，或者换台车试试。`),
      h('div', { class: 'sr-actions' }, actions),
    ),
    hints([['← →', '选择'], ['Enter', '确认']]),
  );
  sfx.play(end.qualified ? 'medal' : 'back');
  return { el, back: () => app.go.menu(), focus: actions[0] };
}

// ---- ending ----

function ending(): Screen {
  app.save.seenEnding = true;
  save();
  const c = C();
  const hist = c.history.slice(-3);
  const go = button('回主菜单', () => app.go.menu(), { cls: 'go' });
  const el = h('div', { class: 'ending', 'data-screen': 'ending' },
    h('div', { class: 'art', style: `background-image:${bgUrl(firstAsset('/assets/ui/title_key.jpg'))}` }),
    h('div', { class: 'en-shade' }),
    h('div', { class: 'en-block' },
      firstAsset('/assets/ui/trophy_gold.png') ? h('img', { class: 'en-trophy', src: firstAsset('/assets/ui/trophy_gold.png')!, alt: '' }) : null,
      h('div', { class: 'hl-latin' }, 'DUSTMARK CHAMPION'),
      h('h1', { class: 'en-title' }, '尘迹拉力 · 生涯冠军'),
      h('p', null, '从入门组的小钢炮到顶级组的四驱，从北境的砂石到山海的柏油，十二站、三十六个赛段。尘土落下，奖牌留在了柜子里。'),
      h('div', { class: 'en-hist' }, hist.map((x) => h('div', null, h('span', null, SEASON_CN[x.season]), h('b', { class: 'mono' }, `${x.points} 分`)))),
      go,
    ),
  );
  sfx.play('medal');
  return { el, back: () => app.go.menu(), focus: go };
}

export { nav };
