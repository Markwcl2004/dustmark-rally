// Single stage and time challenge: environment → stage + direction + weather + car → run → result.
import { app, type RunHooks } from '../../app/app';
import { soloCompare } from './splits';
import type { Compare, Game, RunResult } from '../../app/game';
import { h, navItem, firstAsset, bgUrl, fmtTime, fmtGap } from '../dom';
import { nav, type Screen } from '../nav';
import { hints, button, valueRow, H_NAV } from './common';
import { artKey, carEntry, listEnvs, recordKey, stageLength, type EnvInfo } from '../../sim/rally/catalog';
import { MEDAL_CN, medalFor, medalTargets, type Medal } from '../../sim/rally/scoring';
import { updateRecord, writeSave } from '../../sim/rally/save';
import type { GhostData } from '../../sim/rally/ghost';
import { themeFor } from '../theme';
import { resultScreen } from './results';
import { turntable } from '../../app/menuTurntable';

type Mode = 'single' | 'time';
const MODE_CN: Record<Mode, [string, string]> = { single: ['单赛段', 'SINGLE STAGE'], time: ['计时挑战', 'TIME TRIAL'] };

/** last choices this session */
const last = { env: '', stage: '', reverse: false, weather: '', car: '', livery: -1 };

export function medalImg(m: Medal, cls = 'medal') {
  const src = m ? firstAsset(`/assets/ui/medal_${m}.png`) : null;
  return src ? h('img', { class: cls, src, alt: MEDAL_CN[m!] }) : h('span', { class: `${cls} medal-css ${m ?? ''}` }, m ? MEDAL_CN[m] : '');
}

export function envSelect(mode: Mode): Screen {
  const envs = listEnvs().slice(0, 4);
  const cards = envs.map((e) => {
    const ready = e.stages.filter((s) => s.available).length;
    const poster = firstAsset(`/assets/ui/poster_${e.art}.jpg`, `/assets/ui/env_${e.art}_wide.jpg`);
    const c = navItem(h('div', { class: `env-card ${e.available ? '' : 'soon'}`, 'data-env': e.id, style: `--deep:${themeFor(e.art).deep};--accent:${themeFor(e.art).accent}` },
      h('div', { class: 'ec-img', style: `background-image:${bgUrl(poster)}` }),
      h('div', { class: 'ec-tag' },
        h('b', null, e.name),
        h('span', null, e.surface),
        h('em', null, e.available ? `${ready} 条赛段` : '即将开放'),
      ),
    ), () => app.show(() => stageConfig(mode, e.id), { theme: themeFor(e.art) }), { disabled: !e.available });
    return c;
  });
  const [cn, latin] = MODE_CN[mode];
  const el = h('div', { class: 'env-select', 'data-screen': `${mode}-env` },
    h('div', { class: 'es-head' }, h('div', { class: 'hl-latin' }, latin), h('h1', { class: 'hl-cn' }, cn), h('div', { class: 'es-step' }, '选择环境')),
    h('div', { class: 'env-row' }, cards),
    hints([['← →', '选择'], ['Enter', '确认'], ['Esc', '返回']]),
  );
  const pre = cards.find((c) => c.dataset.env === last.env && c.getAttribute('aria-disabled') !== 'true') ?? cards.find((c) => c.getAttribute('aria-disabled') !== 'true');
  return { el, back: () => app.go.menu(), focus: pre };
}

export function stageConfig(mode: Mode, envId: string): Screen {
  const env = listEnvs().find((e) => e.id === envId) as EnvInfo;
  const cars = app.unlockedCars();
  const sel = {
    stage: (last.env === envId && env.stages.find((s) => s.id === last.stage && s.available)?.id) || env.stages.find((s) => s.available)?.id || env.stages[0].id,
    reverse: last.env === envId ? last.reverse : false,
    weather: last.env === envId && last.weather ? last.weather : env.stages[0].defaultWeather,
    car: cars.some((c) => c.id === (last.car || app.save.garage.car)) ? (last.car || app.save.garage.car) : cars[0]?.id ?? 'pipit',
    livery: 0,
  };
  sel.livery = app.save.garage.liveries[sel.car] ?? 0;
  const theme = themeFor(env.art);
  const stageObj = () => env.stages.find((s) => s.id === sel.stage)!;

  // stage list
  const rows = env.stages.map((st, i) => {
    const rk = (rev: boolean) => app.save.records[recordKey(st.id, rev)];
    const r = navItem(h('div', { class: `st-row ${st.available ? '' : 'soon'}`, 'data-stage': st.id },
      h('span', { class: 'st-idx' }, String(i + 1)),
      h('span', { class: 'st-main' }, h('b', null, st.name), h('small', null, st.available ? st.blurb : '即将开放')),
      h('span', { class: 'st-len mono' }, `${(stageLength(st.id) / 1000).toFixed(2)} km`),
      h('span', { class: 'st-pb' }, ...[false, true].map((rev) => {
        const rec = rk(rev);
        return rec ? h('span', { class: 'pb' }, medalImg(rec.medal, 'medal-xs'), h('i', null, rev ? '反' : '正'), h('b', { class: 'mono' }, fmtTime(rec.best))) : null;
      })),
    ), () => { if (st.available) { sel.stage = st.id; refresh(); nav.focus(goBtn); } }, { disabled: !st.available });
    r.addEventListener('navfocus', () => { if (st.available && sel.stage !== st.id) { sel.stage = st.id; refresh(); } });
    return r;
  });

  const dirRow = valueRow('方向', [{ v: false, label: '正向' }, { v: true, label: '反向' }], () => sel.reverse, (v) => { sel.reverse = v; refresh(); }, '反向跑同一条路，路书重新生成');
  const weatherRow = valueRow('天气 / 时段', stageObj().weathers.map((w) => ({ v: w.id, label: w.available ? w.name : `${w.name}（即将开放）`, disabled: !w.available })), () => sel.weather, (v) => { sel.weather = v; refresh(); });
  const carRow = valueRow('赛车', cars.map((c) => ({ v: c.id, label: `${c.name} ${c.model}` })), () => sel.car, (v) => { sel.car = v; sel.livery = app.save.garage.liveries[v] ?? 0; refresh(); });
  const livRow = valueRow('涂装', [0, 1, 2].map((i) => ({ v: i, label: '' })), () => sel.livery, (v) => { sel.livery = v; refresh(); });
  const targetsBox = h('div', { class: 'targets' });
  const ghostBox = h('div', { class: 'ghost-info' });
  const blurb = h('div', { class: 'sc-blurb' });
  const goBtn = button('开跑', () => launch(), { cls: 'go' });
  const carBox = h('div', { class: 'sc-car' });

  const refresh = () => {
    for (const r of rows) r.classList.toggle('sel', r.dataset.stage === sel.stage);
    const st = stageObj();
    if (!st.reversible) sel.reverse = false;
    dirRow.classList.toggle('locked', !st.reversible);
    dirRow.render();
    weatherRow.render();
    const c = carEntry(sel.car);
    const lv = c?.liveries[sel.livery];
    turntable.show(sel.car, sel.livery);
    livRow.querySelector('.vr-val')!.innerHTML = lv ? `<i class="sw" style="background:${lv.base}"></i><i class="sw" style="background:${lv.c1}"></i><i class="sw" style="background:${lv.c2}"></i> ${lv.name} · #${lv.number}` : '';
    carRow.render();
    const zones = sel.reverse ? [...st.zones].reverse() : st.zones;
    const pb = (rev: boolean) => { const x = app.save.records[recordKey(st.id, rev)]; return x ? fmtTime(x.best) : '—'; };
    blurb.innerHTML = `<div class="zl">${zones.map((z) => `<span>${z}</span>`).join('<i>→</i>')}</div><div class="pbl">个人最佳　正向 <b class="mono">${pb(false)}</b>　反向 <b class="mono">${pb(true)}</b></div>`;
    // medal targets (robot reference for this car)
    const ref = app.bots.peek(sel.stage, sel.reverse, sel.weather, sel.car, 0.9);
    const rec = app.save.records[recordKey(sel.stage, sel.reverse)];
    if (ref) {
      const t = medalTargets(ref.total);
      targetsBox.innerHTML = '';
      targetsBox.append(...(['gold', 'silver', 'bronze'] as const).map((m) => h('div', { class: `tg ${m}` }, medalImg(m, 'medal-sm'), h('b', { class: 'mono' }, fmtTime(t[m])))),
        h('div', { class: 'tg pb' }, h('span', null, '最佳'), h('b', { class: 'mono' }, rec ? fmtTime(rec.best) : '—')));
    } else {
      targetsBox.innerHTML = `<div class="tg wait">目标时间计算中…<small>机器人车手正在这条赛段上跑一趟</small></div>`;
      const key = `${sel.stage}|${sel.reverse}|${sel.weather}|${sel.car}`;
      void app.ref(sel.stage, sel.reverse, sel.weather, sel.car).then(() => { if (key === `${sel.stage}|${sel.reverse}|${sel.weather}|${sel.car}` && el.isConnected) refresh(); }).catch(() => { targetsBox.innerHTML = '<div class="tg wait">目标时间暂不可用</div>'; });
    }
    if (mode === 'time') {
      const g = app.ghostFor(sel.stage, sel.reverse);
      const gc = g ? carEntry(g.car) : null;
      ghostBox.innerHTML = g ? `<span class="gh-dot"></span>幽灵车 <b class="mono">${fmtTime(g.total)}</b>　${gc ? gc.name + ' ' + gc.model : ''}` : '<span class="gh-dot off"></span>这条赛段还没有幽灵车：先跑一次，最好成绩会变成幽灵';
    }
  };

  const launch = () => {
    const st = stageObj();
    if (!st.available) return;
    Object.assign(last, { env: envId, stage: sel.stage, reverse: sel.reverse, weather: sel.weather, car: sel.car, livery: sel.livery });
    app.save.garage.liveries[sel.car] = sel.livery;
    app.persist();
    void runStage(mode, { stage: sel.stage, reverse: sel.reverse, weather: sel.weather, car: sel.car, livery: sel.livery });
  };

  const [cn, latin] = MODE_CN[mode];
  const el = h('div', { class: 'stage-config', 'data-screen': `${mode}-stage` },
    h('div', { class: 'sc-art', style: `background-image:${bgUrl(firstAsset(`/assets/ui/env_${env.art}_wide.jpg`, `/assets/ui/poster_${env.art}.jpg`))}` }),
    h('div', { class: 'sc-head' }, h('div', { class: 'hl-latin' }, `${latin} · ${cn}`), h('h1', { class: 'hl-cn' }, env.name), h('div', { class: 'sc-char' }, env.character)),
    h('div', { class: 'sc-body' },
      h('div', { class: 'sc-list' }, h('div', { class: 'col-h' }, '赛段'), rows, blurb),
      h('div', { class: 'sc-opts' }, h('div', { class: 'col-h' }, mode === 'time' ? '挑战设置' : '出发设置'), dirRow, weatherRow, carRow, livRow, mode === 'time' ? ghostBox : null, targetsBox, h('div', { class: 'sc-go' }, carBox, goBtn)),
    ),
    hints([['↑ ↓', '选择'], ['← →', '调整'], ['Enter', '开跑'], ['Esc', '返回']]),
  );
  queueMicrotask(() => { turntable.mount(carBox); refresh(); });
  return { el, back: () => app.show(() => envSelect(mode)), focus: goBtn, leave: () => turntable.unmount() };
}

export interface StageChoice { stage: string; reverse: boolean; weather: string; car: string; livery: number }

/** run a single / time-challenge stage and handle its result */
export async function runStage(mode: Mode, c: StageChoice) {
  const env = listEnvs().find((e) => e.stages.some((s) => s.id === c.stage));
  const ghost: GhostData | null = mode === 'time' ? app.ghostFor(c.stage, c.reverse) : null;
  const refNow = app.bots.peek(c.stage, c.reverse, c.weather, c.car, 0.9);
  const hooks: RunHooks = {
    finish: (r, game) => onFinish(mode, c, r, game),
    pause: {
      restart: () => ({ allowed: true, label: '重跑赛段' }),
      quit: () => { app.endRun(); void app.show(() => stageConfig(mode, env?.id ?? 'north'), { theme: themeFor(env?.art) }); },
    },
    // splits: personal best (the ghost) if there is one, else the medal lines
    compare: (game) => soloCompare(game, c, ghost ? '幽灵' : '个人最好'),
  };
  // medal targets for the HUD once the reference run is known
  const withTargets = hooks.compare!;
  hooks.compare = (game) => {
    withTargets(game);
    if (!game.cfg.targets) void app.ref(c.stage, c.reverse, c.weather, c.car).then((run) => { (game.cfg as { targets: unknown }).targets = medalTargets(run.total); }).catch(() => {});
  };
  await app.startRun({ ...c, mode, ghost, targets: refNow ? medalTargets(refNow.total) : null }, hooks);
}

function onFinish(mode: Mode, c: StageChoice, r: RunResult, game: Game) {
  const env = listEnvs().find((e) => e.stages.some((s) => s.id === c.stage));
  const key = recordKey(c.stage, c.reverse);
  const prev = app.save.records[key];
  const show = (ref: number | null) => {
    const medal = r.finished ? medalFor(r.total, ref) : null;
    let newBest = false, ghostSaved = false;
    if (r.finished) {
      newBest = updateRecord(app.save, key, r.total, c.car, medal);
      if (newBest && r.ghost) ghostSaved = app.storeGhost(c.stage, c.reverse, { car: c.car, livery: c.livery, total: r.total, date: Date.now(), data: r.ghost });
      app.save.stats.km += r.lengthM / 1000;
      writeSave(app.kv, app.save);
    }
    const ghostCmp = game.cfg.ghost ? { label: '幽灵', total: game.cfg.ghost.total } : null;
    resultScreen(game, {
      envName: env?.name ?? '', stageName: game.world.stage.def.name, reverse: c.reverse, result: r, medal, ref, prevBest: prev?.best ?? null, newBest, ghostSaved, ghostCmp,
      buttons: [
        { label: '继续', fn: () => { app.endRun(); void app.show(() => stageConfig(mode, env?.id ?? 'north'), { theme: themeFor(env?.art) }); } },
        { label: '重跑', fn: () => restartRun(mode, c, game) },
        { label: '看回放', fn: 'replay' },
        { label: '回菜单', fn: () => { app.endRun(); app.go.menu(); } },
      ],
    });
  };
  const ref = app.bots.peek(c.stage, c.reverse, c.weather, c.car, 0.9);
  if (ref) show(ref.total);
  else void Promise.race([app.ref(c.stage, c.reverse, c.weather, c.car).then((x) => x.total), new Promise<null>((res) => setTimeout(() => res(null), 4000))]).then((x) => show(x)).catch(() => show(null));
}

/** restart the same run (a new ghost may exist now: rebuild if the ghost changed) */
function restartRun(mode: Mode, c: StageChoice, game: Game) {
  const g = mode === 'time' ? app.ghostFor(c.stage, c.reverse) : null;
  if ((g?.date ?? 0) !== (game.cfg.ghost?.date ?? 0)) { void runStage(mode, c); return; }
  game.restart();
}

export function compareLabel(cmp: Compare | null) { return cmp?.label ?? ''; }
export { fmtGap, artKey };
