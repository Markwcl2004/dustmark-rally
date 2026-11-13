// "怎么开" — the first-run card: keys, how to read the pace notes, the one rule of rally driving, and the assist level.
// Shown over the loaded (paused) first stage of a new save; again from 设置 › 控制. Any key continues; ← → change the
// assist level (career's first rally preselects 新手).
import { app } from '../../app/app';
import type { AssistLevel } from '../../sim/rally/settings';
import type { PaceNote } from '../../sim/stage/pacenotes';
import { h } from '../dom';
import { noteIcon } from '../icons';
import type { Screen } from '../nav';
import { HOLD_RULE } from './common';

const ASSIST: { v: AssistLevel; label: string; desc: string }[] = [
  { v: 'novice', label: '新手', desc: 'ABS + 牵引力控制 + 稳定辅助，车不容易打转' },
  { v: 'standard', label: '标准', desc: '轻度 ABS / 牵引力控制 + 反打辅助' },
  { v: 'hardcore', label: '硬核', desc: '全部关闭' },
];

const KEYS: [string[], string][] = [
  [['↑', 'W'], '油门'], [['↓', 'S'], '刹车（停住后倒车）'], [['←', '→'], '转向（A / D 也行）'], [['空格'], '手刹'],
  [['左 Shift'], '轻踩：油门、方向减量'], [['E', 'Q'], '手动挡升挡 / 降挡'],
  [['R'], '回到赛道（罚 5 秒）'], [['C', 'P'], '换视角 / 轨迹预测'], [['Esc', 'M', 'K'], '暂停 / 静音 / 手机方向盘'],
];

const note = (text: string, n: Partial<PaceNote>): HTMLElement =>
  h('div', { class: 'in-note' }, h('div', { class: 'ic', html: noteIcon({ s: 0, kind: 'turn', text, mods: [], words: [], ...n } as PaceNote) }), h('b', null, text));

export interface IntroOpts {
  /** preselect this assist level (career's first rally: 新手) */
  recommend?: AssistLevel;
  onDone: () => void;
}

export function introCard(opts: IntroOpts): Screen {
  const s = app.save.settings;
  if (opts.recommend) { s.assist = opts.recommend; app.persist(); }
  const val = h('b', { class: 'vr-val' });
  const vdesc = h('small', null);
  const render = () => {
    const a = ASSIST.find((x) => x.v === s.assist) ?? ASSIST[1];
    val.textContent = a.label + (opts.recommend === a.v ? '（推荐）' : '');
    vdesc.textContent = a.desc;
  };
  const step = (d: -1 | 1) => {
    const i = Math.max(0, ASSIST.findIndex((x) => x.v === s.assist));
    s.assist = ASSIST[(i + d + ASSIST.length) % ASSIST.length].v;
    app.persist();
    app.game?.updateSettings(s);
    render();
  };
  const assist = h('div', { class: 'in-assist' },
    h('span', { class: 'in-k' }, '辅助档位'),
    h('span', { class: 'vr-ctl' }, h('i', { class: 'vr-l', on: { click: (e) => { e.stopPropagation(); step(-1); } } }, '‹'), val, h('i', { class: 'vr-r', on: { click: (e) => { e.stopPropagation(); step(1); } } }, '›')),
    vdesc,
    h('em', null, '← → 切换 · 随时可以在 设置 › 驾驶 或暂停菜单里改'),
  );
  render();
  const card = h('div', { class: 'intro-card' },
    h('div', { class: 'in-head' }, h('div', { class: 'hl-latin' }, 'HOW TO DRIVE'), h('h1', { class: 'hl-cn' }, '怎么开')),
    h('div', { class: 'in-cols' },
      h('div', { class: 'in-col in-keys' },
        h('h3', null, '按键'),
        KEYS.map(([ks, t]) => h('div', { class: 'in-key' }, h('span', null, ks.map((k) => h('kbd', null, k))), h('em', null, t))),
        h('p', { class: 'in-pad' }, '手柄：左摇杆转向，RT / LT 油门刹车，A 手刹。'),
      ),
      h('div', { class: 'in-col in-notes' },
        h('h3', null, '路书怎么读'),
        h('div', { class: 'in-examples' }, note('右四', { dir: 'R', grade: '4' as PaceNote['grade'] }), note('左二', { dir: 'L', grade: '2' as PaceNote['grade'] }), note('发卡右', { dir: 'R', grade: 'hairpin' }), note('直角左', { dir: 'L', grade: 'square' })),
        h('p', null, h('b', null, '左 / 右 + 数字'), '：数字越小弯越急，1 最急，6 最缓。'),
        h('p', null, h('b', null, '发卡'), '是掉头弯，', h('b', null, '直角'), '是 90° 弯，都要早早刹车。'),
        h('p', null, h('b', null, '后面的数字'), '是到下一条路书的距离：「右四 一百」= 过了右四，再开 100 米是下一个弯。'),
        h('h3', null, '基本开法'),
        h('p', { class: 'in-rule' }, HOLD_RULE),
        h('p', null, h('b', null, '慢进快出'), '：直线上刹好车再入弯，看到出口再按住油门。车尾滑出来时松开方向键，车会自己摆回来（硬核档除外）。'),
      ),
    ),
    assist,
    h('div', { class: 'in-go' }, '按任意键开始'),
  );
  const el = h('div', { class: 'dim intro', 'data-screen': 'intro' }, card);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    app.save.introSeen = true;
    app.persist();
    app.closeOverlay(sc);
    opts.onDone();
  };
  const sc: Screen = {
    el,
    focus: null,
    back: finish,
    key: (k, e) => {
      if (k === 'any') {
        // ← → / A D change the assist; every other key (or pad button) continues
        const code = e?.code ?? '';
        if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(code)) { step(code === 'ArrowLeft' || code === 'KeyA' ? -1 : 1); return true; }
        if (['ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'].includes(code)) return true;
        if (e && e.repeat) return true;
        finish();
        return true;
      }
      if (k === 'left' || k === 'right') { step(k === 'left' ? -1 : 1); return true; }
      finish();
      return true;
    },
  };
  el.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.vr-ctl')) finish(); });
  return sc;
}

/** show the card as an overlay; resolves when dismissed */
export function showIntro(recommend?: AssistLevel): Promise<void> {
  return new Promise((resolve) => app.overlay(introCard({ recommend, onDone: resolve })));
}
