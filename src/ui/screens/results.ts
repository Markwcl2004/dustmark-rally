// Stage result (over the stopped car) and the replay control bar.
import { app } from '../../app/app';
import type { Game, RunResult } from '../../app/game';
import { REPLAY_CAMS, REPLAY_CAM_CN } from '../../app/replay';
import { h, fmtTime, fmtGap } from '../dom';
import type { Screen } from '../nav';
import { sfx } from '../sfx';
import { button, hints } from './common';
import { MEDAL_CN, medalTargets, type Medal } from '../../sim/rally/scoring';
import { medalImg } from './stages';

const PEN_CN: Record<string, string> = { reset: '回到路上', falsestart: '抢跑', cut: '切弯' };

export interface ResultOpts {
  envName: string; stageName: string; reverse: boolean;
  result: RunResult;
  medal: Medal;
  /** robot reference total (medal targets), if known */
  ref: number | null;
  prevBest: number | null;
  newBest: boolean;
  ghostSaved: boolean;
  ghostCmp: { label: string; total: number } | null;
  /** career: the stage's points and the season's progress */
  career?: { points: number; season: { points: number; need: number; toGo: number; reached: boolean; last: boolean } } | null;
  /** buttons; 'replay' opens the replay */
  buttons: { label: string; fn: (() => void) | 'replay'; disabled?: boolean }[];
}

export function resultScreen(game: Game, o: ResultOpts) {
  const r = o.result;
  const pens = r.log.reduce<Record<string, { n: number; s: number }>>((m, e) => { (m[e.kind] ??= { n: 0, s: 0 }).n++; m[e.kind].s += e.sec; return m; }, {});
  const penText = r.penalties > 0 ? Object.entries(pens).map(([k, v]) => `${PEN_CN[k] ?? k}${v.n > 1 ? ' ×' + v.n : ''} +${v.s}`).join('　') : '无';
  const total = r.total;
  const rows: [string, string, string?][] = [
    ['行驶用时', fmtTime(r.time)],
    ['罚时', penText, r.penalties > 0 ? 'bad' : ''],
  ];
  rows.push(['最高速度', `${r.topKmh.toFixed(0)} km/h`], ['平均速度', r.finished ? `${r.avgKmh.toFixed(1)} km/h` : '—']);
  if (o.ghostCmp) rows.push([`对比${o.ghostCmp.label}`, fmtGap(total - o.ghostCmp.total), total > o.ghostCmp.total ? 'bad' : 'good']);
  if (o.prevBest !== null) rows.push(['个人最好', o.newBest ? `新纪录（原 ${fmtTime(o.prevBest)}，${fmtGap(total - o.prevBest)}）` : `${fmtTime(o.prevBest)}（${fmtGap(total - o.prevBest)}）`, o.newBest ? 'good' : '']);
  // the next medal up and how far it was
  if (o.ref && r.finished && o.medal !== 'gold') {
    const t = medalTargets(o.ref), next = o.medal === 'silver' ? 'gold' : o.medal === 'bronze' ? 'silver' : 'bronze';
    rows.push([`${MEDAL_CN[next]}牌线`, `${fmtTime(t[next])}（差 ${(total - t[next]).toFixed(1)} 秒）`]);
  }

  const splits = h('div', { class: 'rs-splits' }, r.splits.map((t, i) => {
    const d = r.splitDeltas[i];
    return h('span', { class: `chip ${d === null ? '' : d > 0 ? 'bad' : 'good'}` }, h('i', null, `${i + 1} km`), h('b', { class: 'mono' }, Number.isFinite(t) ? (d === null ? fmtTime(t) : fmtGap(d)) : '—'));
  }));
  const btns = o.buttons.map((b) => button(b.label, () => {
    if (b.fn === 'replay') { app.closeOverlay(sc); replayBar(game, () => app.overlay(sc)); return; }
    app.closeOverlay(sc); b.fn();
  }, { disabled: b.disabled }));
  const medalBlock = o.medal ? h('div', { class: 'rs-medal' }, medalImg(o.medal, 'medal-lg'), h('span', null, `${MEDAL_CN[o.medal]}牌`, o.career ? h('small', null, `+${o.career.points} 分`) : null))
    : o.career ? h('div', { class: 'rs-medal none' }, h('span', null, r.finished ? '完赛' : '未完成', h('small', null, '+0 分'))) : null;
  const sp = o.career?.season;
  const seasonLine = sp ? h('div', { class: `rs-season ${sp.reached ? 'good' : ''}` },
    h('span', { class: 'mono' }, `本赛季 ${sp.points} / ${sp.need} 分`),
    h('span', null, sp.reached ? (sp.last ? '已够夺冠分数，跑完本季即夺冠' : '已够解锁分数，跑完本季即解锁下一组别') : `再拿 ${sp.toGo} 分${sp.last ? '夺得生涯冠军' : '解锁下一组别'}`)) : null;
  const card = h('div', { class: 'rs-card' },
    h('div', { class: 'rs-kicker' }, r.finished ? '赛段完成 · STAGE COMPLETE' : '未完成 · RETIRED'),
    h('div', { class: 'rs-stage' }, `${o.envName} · ${o.stageName}${o.reverse ? '（反向）' : ''}`),
    h('div', { class: 'rs-top' }, h('div', { class: 'rs-total mono' }, fmtTime(total)), medalBlock),
    seasonLine,
    o.newBest ? h('div', { class: 'rs-badge' }, o.ghostSaved ? '个人最佳 · 已存为幽灵车' : '个人最佳') : null,
    h('table', { class: 'rs-table' }, rows.map(([a, b, c]) => h('tr', { class: c ?? '' }, h('td', null, a), h('td', { class: 'mono' }, b)))),
    r.splits.length ? h('div', { class: 'rs-sub' }, '分段', splits) : null,
    h('div', { class: 'rs-btns' }, btns),
  );
  const el = h('div', { class: 'result', 'data-screen': 'result' }, card, hints([['← →', '选择'], ['Enter', '确认']]));
  const sc: Screen = { el, focus: btns[0] };
  app.overlay(sc);
  if (o.medal || o.newBest) sfx.play('medal');
  return sc;
}

/** replay controls: Space pause, ← → ±5 s, ↑ ↓ speed, C camera, Esc back */
export function replayBar(game: Game, back: () => void) {
  game.startReplay();
  const fill = h('i'), head = h('b');
  const bar = h('div', { class: 'rp-track' }, fill, head);
  const time = h('span', { class: 'rp-time mono' });
  const cam = h('span', { class: 'rp-cam' });
  const speed = h('span', { class: 'rp-speed mono' });
  const kmh = h('span', { class: 'rp-kmh mono' });
  const el = h('div', { class: 'replay', 'data-screen': 'replay' },
    h('div', { class: 'rp-badge' }, h('i'), '回放 · REPLAY'),
    h('div', { class: 'rp-bar' }, cam, bar, time, speed, kmh),
    hints([['空格', '暂停'], ['← →', '±5 秒'], ['↑ ↓', '速度'], ['C', '机位'], ['Esc', '返回']]),
  );
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const r = game.replay;
    if (!r) return;
    const f = `${(r.frac * 100).toFixed(2)}%`;
    fill.style.width = f; head.style.left = f;
    const tt = `${fmtTime(Math.max(0, r.t))} / ${fmtTime(r.t1)}`;
    if (time.textContent !== tt) time.textContent = tt;
    const sp = r.paused ? '暂停' : `${r.speed}×`;
    if (speed.textContent !== sp) speed.textContent = sp;
    // TV mode with no trackside spot that sees the car right now: the helicopter fills in
    const cm = r.cam === 'tv' && game.view.chase.mode === 'heli' ? `${REPLAY_CAM_CN.tv} · 航拍` : REPLAY_CAM_CN[r.cam];
    if (cam.textContent !== cm) cam.textContent = cm;
    const k = `${Math.round(game.replayInfo.kmh)} km/h`;
    if (kmh.textContent !== k) kmh.textContent = k;
  };
  raf = requestAnimationFrame(tick);
  let drag = false;
  const seekAt = (x: number) => { const rc = bar.getBoundingClientRect(); const r = game.replay; if (r) game.replaySeek(r.t0 + Math.min(1, Math.max(0, (x - rc.left) / rc.width)) * (r.t1 - r.t0)); };
  bar.addEventListener('pointerdown', (e) => { drag = true; bar.setPointerCapture(e.pointerId); seekAt(e.clientX); });
  bar.addEventListener('pointermove', (e) => { if (drag) seekAt(e.clientX); });
  bar.addEventListener('pointerup', () => { drag = false; });
  const close = () => { cancelAnimationFrame(raf); game.stopReplay(); app.closeOverlay(sc); back(); };
  const sc: Screen = {
    el,
    back: close,
    key: (k, e) => {
      const r = game.replay;
      if (!r) return false;
      if (k === 'any') {
        if (e?.code === 'KeyC') { r.cam = REPLAY_CAMS[(REPLAY_CAMS.indexOf(r.cam) + 1) % REPLAY_CAMS.length]; sfx.play('tick'); return true; }
        if (e?.code === 'Space') { if (r.t >= r.t1) game.replaySeek(r.t0); r.paused = !r.paused; sfx.play('tick'); return true; }
        return false;
      }
      if (k === 'ok') { if (r.t >= r.t1) game.replaySeek(r.t0); r.paused = !r.paused; return true; }
      if (k === 'left' || k === 'right') { game.replaySeek(r.t + (k === 'left' ? -5 : 5)); return true; }
      if (k === 'up' || k === 'down') { r.faster(k === 'up' ? 1 : -1); sfx.play('tick'); return true; }
      if (k === 'tabR' || k === 'tabL') { r.cam = REPLAY_CAMS[(REPLAY_CAMS.indexOf(r.cam) + (k === 'tabR' ? 1 : REPLAY_CAMS.length - 1)) % REPLAY_CAMS.length]; return true; }
      return false;
    },
    leave: () => cancelAnimationFrame(raf),
  };
  app.overlay(sc);
  return sc;
}
