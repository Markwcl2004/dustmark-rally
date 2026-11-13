// Settings (persisted in the save; applied live where possible).
import { app } from '../../app/app';
import { h, navItem, clear, bgUrl, firstAsset } from '../dom';
import { nav, type Screen } from '../nav';
import { button, confirm, hints, sliderRow, valueRow, HOLD_RULE } from './common';
import type { Settings } from '../../sim/rally/settings';
import { showIntro } from './intro';
import { FEEL_DEFAULT, FEEL_RANGE, FEEL_URL, feelOf, isDefaultFeel, resetFeel, urlFeel, type FeelKey } from '../../app/feel';
import { gentleCaps } from '../../sim/vehicle/tune';

type Tab = 'drive' | 'feel' | 'event' | 'sound' | 'video' | 'control' | 'save';
const TABS: [Tab, string][] = [['drive', '驾驶'], ['feel', '手感'], ['event', '领航'], ['sound', '声音'], ['video', '画面'], ['control', '控制'], ['save', '存档']];
const pct = (v: number) => `${Math.round(v * 100)}%`;
const TAB_LATIN = ['DRIVING', 'FEEL', 'EVENT', 'SOUND', 'VIDEO', 'CONTROLS', 'SAVE DATA'];

/** keyboard map shown on the 控制 page (手感重做 key map: every driving key works by being held) */
const KEYMAP: [string, string][] = [
  ['↑ / W', '油门（按住）'], ['↓ / S', '刹车（停住后倒车）'], ['← → / A D', '转向（按住）'], ['空格', '手刹（按住）'],
  ['左 Shift', '轻踩：按住时油门、方向减量'], ['E / Q', '手动挡 升挡 / 降挡'],
  ['R', '回到路上（+5 秒）'], ['C / P', '视角 / 轨迹预测'], ['M / H', '静音 / 隐藏 HUD'], ['Esc / Enter', '暂停 / 重跑'],
  ['K', '手机方向盘配对'], ['手柄 左摇杆', '转向'], ['RT / LT', '油门 / 刹车'], ['A', '手刹'],
  ['X / B', '升挡 / 降挡'], ['Y / Back', '视角 / 回到路上'], ['Start', '暂停'],
];

/** 手感 page: what each knob does, in plain words */
const FEEL_ROWS: { k: FeelKey; label: string; fmt: (v: number) => string; note: string }[] = [
  { k: 'grip', label: '抓地', fmt: (v) => `${v.toFixed(2)}×`,
    note: '调大：所有路面都更抓地，弯里能开得更快、更不容易滑。调小：更滑，车尾更容易甩出去。' },
  { k: 'slipCap', label: '漂移角上限', fmt: (v) => (v > FEEL_RANGE.slipCap[1] ? '关' : `${v}°`),
    note: '调大：车身能横得更多，甩尾更大，也更难收。调小：车尾刚出去一点就被收住，更稳。拉到最右是关（不限制）；新手档按比例更小。' },
  { k: 'push', label: '推头保护', fmt: (v) => (v === 0 ? '关' : `${v.toFixed(2)}×`),
    note: '按住方向和油门过弯、车快往外冲时，自动收一点油。调大：收得更早更多，更稳，但可能觉得油门被掐。调小：管得少；拉到 0 就关掉，按住油门会越跑越快、冲出弯外。' },
  { k: 'steerRate', label: '方向键速度', fmt: (v) => `${v.toFixed(1)}×`,
    note: '调大：按下方向键前轮打得更快、松开回正也更快，更灵。调小：打得更慢更柔，高速更稳。' },
  { k: 'gentle', label: '轻踩比例', fmt: (v) => `${Math.round(v * 100)}%`,
    note: '按住左 Shift 时油门、刹车、方向各留多少。调大：留得多；调小：更轻。' },
];
const gentleNow = (g: number) => { const c = gentleCaps(g); return `现在：油门 ${Math.round(c.throttle * 100)}%、刹车 ${Math.round(c.brake * 100)}%、方向 ${Math.round(c.steer * 100)}%`; };

export function settingsScreen(back: () => void, overGame = false, startTab?: string): Screen {
  const s = app.save.settings;
  let tab: Tab = TABS.some(([id]) => id === startTab) ? (startTab as Tab) : 'drive';
  const changed = () => {
    app.persist();
    app.applyUiSettings();
    if (overGame && app.game) app.game.updateSettings(s);
  };
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => { s[k] = v; changed(); };
  const onOff = [{ v: true, label: '开' }, { v: false, label: '关' }];
  const body = h('div', { class: 'set-body' });
  const desc = h('div', { class: 'set-desc' });
  const tabEls = TABS.map(([id, cn]) => navItem(h('div', { class: 'set-tab', 'data-tab': id }, cn), () => { tab = id; render(); }));

  const rowsFor = (t: Tab): HTMLElement[] => {
    switch (t) {
      case 'drive': return [
        valueRow('辅助档位', [{ v: 'novice', label: '新手' }, { v: 'standard', label: '标准' }, { v: 'hardcore', label: '硬核' }], () => s.assist, set('assist'),
          '新手：ABS + 牵引力控制 + 稳定辅助；标准：轻度 ABS / TC + 反打辅助；硬核：全关'),
        valueRow('变速箱', [{ v: 'auto', label: '自动' }, { v: 'manual', label: '手动' }], () => s.transmission, set('transmission'), '手动：E 升挡，Q 降挡（手柄 X / B）'),
        valueRow('反打辅助', onOff, () => s.counterSteer, set('counterSteer'), '车在滑时松开方向键，前轮自动朝滑动方向反打、把车摆回来（硬核档始终关闭）'),
        valueRow('轨迹预测', onOff, () => s.predict, set('predict'), '按 P 随时开关：路面上画出保持当前操作后的去向'),
        sliderRow('预测时长', 1.5, 4, 0.5, () => s.predictT, set('predictT'), (v) => `${v.toFixed(1)} 秒`, '下次进入赛段生效'),
      ];
      case 'feel': {
        const f = feelOf(app.save);
        const url = urlFeel();
        const status = h('span', null);
        const showStatus = () => {
          status.textContent = isDefaultFeel(f) ? '现在是默认手感' : `默认：抓地 ${FEEL_DEFAULT.grip.toFixed(2)}× · 漂移角 ${FEEL_DEFAULT.slipCap}° · 推头保护 ${FEEL_DEFAULT.push.toFixed(2)}× · 方向键 ${FEEL_DEFAULT.steerRate.toFixed(1)}× · 轻踩 ${Math.round(FEEL_DEFAULT.gentle * 100)}%`;
        };
        showStatus();
        const save = () => { app.persist(); showStatus(); };
        const rows = FEEL_ROWS.map(({ k, label, fmt, note }) => {
          const [lo, hi, st] = FEEL_RANGE[k];
          // 漂移角上限: one step past the range is 关 (no cap)
          const off = k === 'slipCap', max = off ? hi + st : hi;
          const extra = k === 'gentle' ? h('span', { class: 'feel-now' }, gentleNow(f.gentle)) : null;
          const row = sliderRow(label, lo, max, st, () => (off && f[k] === 0 ? max : f[k]), (v) => {
            f[k] = off && v > hi ? 0 : +v.toFixed(2);
            if (extra) extra.textContent = gentleNow(f.gentle);
            save();
          }, fmt);
          row.classList.add('feel-slider');
          row.dataset.feel = k;
          return h('div', { class: 'feel-row' }, row,
            h('div', { class: 'feel-note' }, note, extra ? ' ' : null, extra),
            url[k] !== undefined ? h('div', { class: 'feel-url' }, `网址里写了 ${FEEL_URL[k]}=${url[k]}，开跑时以网址为准（这里的改动照样保存）`) : null);
        });
        const reset = button('恢复默认', () => {
          resetFeel(f); save(); render();
          nav.refresh(body.querySelector<HTMLElement>('.feel-reset'));
        }, { cls: 'feel-reset' });
        return [
          h('p', { class: 'feel-head' }, '下次开跑或重跑时生效。奖牌线和分段参考按默认手感计算。硬核档只用得到抓地、方向键速度和轻踩比例。'),
          ...rows,
          h('div', { class: 'feel-foot' }, reset, status),
        ];
      }
      case 'event': return [
        sliderRow('领航提前量', 2, 6, 0.5, () => s.callEarly, set('callEarly'), (v) => `${v.toFixed(1)} 秒`, '按车速提前多少秒的路程报路；下次进入赛段生效'),
        valueRow('领航声音', [{ v: 'meijia', label: '美佳' }, { v: 'tingting', label: '婷婷' }], () => s.voice, set('voice'), '下次进入赛段生效'),
      ];
      case 'sound': return [
        sliderRow('总音量', 0, 1, 0.05, () => s.vol.master, (v) => { s.vol.master = v; changed(); }, pct),
        sliderRow('引擎', 0, 1, 0.05, () => s.vol.engine, (v) => { s.vol.engine = v; changed(); }, pct),
        sliderRow('环境与路噪', 0, 1, 0.05, () => s.vol.ambient, (v) => { s.vol.ambient = v; changed(); }, pct),
        sliderRow('领航员', 0, 1, 0.05, () => s.vol.voice, (v) => { s.vol.voice = v; changed(); }, pct),
        sliderRow('界面音效', 0, 1, 0.05, () => s.vol.ui, (v) => { s.vol.ui = v; changed(); }, pct),
      ];
      case 'video': return [
        valueRow('画质预设', [{ v: 'perf', label: '性能（120 Hz）' }, { v: 'default', label: '默认' }, { v: 'high', label: '高' }], () => s.quality, set('quality'), '阴影、植被距离、扬尘数量；下次进入赛段生效'),
        valueRow('渲染比例', [0, 0.5, 0.6, 0.65, 0.75, 0.85, 1].map((v) => ({ v, label: v === 0 ? '随预设' : `${Math.round(v * 100)}%` })), () => s.renderScale, set('renderScale'), '物理像素的比例；下次进入赛段生效'),
        valueRow('动态分辨率', onOff, () => s.dynres, set('dynres'), '掉帧时自动降低渲染比例，稳定后升回'),
        valueRow('泛光', onOff, () => s.post.bloom, (v) => { s.post.bloom = v; changed(); }),
        valueRow('暗角', onOff, () => s.post.vignette, (v) => { s.post.vignette = v; changed(); }),
        valueRow('胶片颗粒', onOff, () => s.post.grain, (v) => { s.post.grain = v; changed(); }),
        valueRow('速度模糊', onOff, () => s.post.radialBlur, (v) => { s.post.radialBlur = v; changed(); }, '高速时画面边缘的径向模糊'),
        valueRow('HUD 精简', onOff, () => s.hudLite, set('hudLite'), '只留计时、速度挡位、下一条路书'),
      ];
      case 'control': {
        const pair = navItem(h('div', { class: 'vrow' }, h('span', { class: 'vr-label' }, '手机方向盘'), h('span', { class: 'vr-ctl' }, h('b', { class: 'vr-val' }, '显示配对二维码'))), () => {
          void import('../pairPanel').then((m) => (m as unknown as { openPairPanel?: () => void }).openPairPanel?.()).catch(() => {});
        });
        pair.dataset.desc = '用 ./play.sh 启动时，iPhone 扫码即可当方向盘（K 键也能打开）';
        const intro = navItem(h('div', { class: 'vrow' }, h('span', { class: 'vr-label' }, '新手引导'), h('span', { class: 'vr-ctl' }, h('b', { class: 'vr-val' }, '重看「怎么开」'))), () => {
          void showIntro().then(() => render());
        });
        intro.dataset.desc = '按键、路书怎么读、基本开法和辅助档位';
        return [
          sliderRow('手柄死区', 0, 0.3, 0.01, () => s.pad.deadzone, (v) => { s.pad.deadzone = v; changed(); }, (v) => `${Math.round(v * 100)}%`, '摇杆中间这一段不起作用'),
          sliderRow('手柄转向曲线', 1, 3, 0.1, () => s.pad.curve, (v) => { s.pad.curve = v; changed(); }, (v) => v.toFixed(1), '1 = 线性；越大中间越细腻、打满越快'),
          pair,
          intro,
          h('p', { class: 'keymap-rule' }, HOLD_RULE),
          h('div', { class: 'keymap' }, KEYMAP.map(([k, t]) => h('div', null, h('kbd', null, k), h('span', null, t)))),
        ];
      }
      case 'save': {
        const sv = app.save;
        const d = new Date(sv.created);
        return [
          h('div', { class: 'save-info' },
            h('div', null, h('span', null, '存档建立'), h('b', null, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)),
            h('div', null, h('span', null, '跑过赛段'), h('b', null, `${sv.stats.runs} 次 · ${sv.stats.km.toFixed(1)} km`)),
            h('div', null, h('span', null, '纪录 / 幽灵车'), h('b', null, `${Object.keys(sv.records).length} / ${Object.values(sv.records).filter((r) => r.ghost).length}`)),
            h('div', null, h('span', null, '生涯'), h('b', null, sv.career ? `第 ${sv.career.season + 1} 赛季进行中` : '未开始')),
          ),
          button('清除存档', () => confirm('清除存档？', '生涯进度、个人最佳、幽灵车和设置都会删除，不能撤销。', [
            { label: '清除', cls: 'danger', fn: () => { app.resetSave(); app.go.title(); } },
            { label: '取消', fn: () => {} },
          ]), { cls: 'danger' }),
        ];
      }
    }
  };

  const render = () => {
    for (const t of tabEls) t.classList.toggle('on', t.dataset.tab === tab);
    const ti = TABS.findIndex(([id]) => id === tab);
    artCap.innerHTML = `<b class="mono">0${ti + 1}</b><span>${TABS[ti][1]}</span><small>${TAB_LATIN[ti]}</small>`;
    clear(body);
    for (const r of rowsFor(tab)) body.appendChild(r);
    nav.refresh(body.querySelector<HTMLElement>('[data-nav]') ?? tabEls.find((t) => t.dataset.tab === tab));
  };
  const artCap = h('div', { class: 'set-art-cap' });
  const art = overGame ? null : h('div', { class: 'set-art', style: `background-image:${bgUrl(firstAsset('/assets/ui/menu_bg_2.jpg', '/assets/ui/loading_1.jpg'))}` }, artCap);
  const el = h('div', { class: `settings ${overGame ? 'over-game' : ''}`, 'data-screen': 'settings' },
    art,
    h('div', { class: 'set-panel' },
      h('div', { class: 'set-head' }, h('div', { class: 'hl-latin' }, 'SETTINGS'), h('h1', { class: 'hl-cn' }, '设置')),
      h('div', { class: 'set-tabs' }, tabEls, h('span', { class: 'tab-keys' }, h('kbd', null, 'Q'), h('kbd', null, 'E'))),
      body,
      desc,
    ),
    hints([['↑ ↓', '选择'], ['← →', '调整'], ['Q E', '分页'], ['Esc', '返回']]),
  );
  el.addEventListener('navfocus', (e) => { desc.textContent = (e.target as HTMLElement).dataset.desc ?? ''; });
  const sc: Screen = {
    el,
    back: () => { changed(); if (overGame) { app.closeOverlay(sc); back(); } else back(); },
    key: (k) => {
      if (k === 'tabL' || k === 'tabR') {
        const i = TABS.findIndex(([id]) => id === tab);
        tab = TABS[(i + (k === 'tabR' ? 1 : TABS.length - 1)) % TABS.length][0];
        render();
        return true;
      }
      return false;
    },
  };
  queueMicrotask(render);
  return sc;
}
