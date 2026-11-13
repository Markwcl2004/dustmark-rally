// Pause menu (Esc / Start during a stage).
import { app, type RunHooks } from '../../app/app';
import type { Game } from '../../app/game';
import { h, navItem } from '../dom';
import type { Screen } from '../nav';
import { hints, H_NAV, HOLD_RULE } from './common';
import { fmtTime } from '../dom';

export function pauseScreen(game: Game, hooks: RunHooks) {
  const resume = () => { app.closeOverlay(sc); game.setPaused(false); };
  const rs = hooks.pause.restart();
  const item = (cn: string, sub: string, fn: () => void, disabled = false) =>
    navItem(h('div', { class: 'pz-item' }, h('b', null, cn), h('small', null, sub)), fn, { disabled });
  const items = [
    item('继续', 'RESUME', resume),
    item(rs.label, rs.allowed ? 'RESTART' : '本站重跑次数已用完', () => { app.closeOverlay(sc); if (rs.run) rs.run(); else game.restart(); }, !rs.allowed),
    // the settings screen comes back to a fresh pause menu
    item('设置', 'SETTINGS', () => { app.closeOverlay(sc); app.go.settings(() => { pauseScreen(game, hooks); }, true); }),
    // straight to the 手感 knobs (they apply from the next start / restart)
    item('手感', 'FEEL', () => { app.closeOverlay(sc); app.go.settings(() => { pauseScreen(game, hooks); }, true, 'feel'); }),
    item('退出到菜单', 'QUIT', () => hooks.pause.quit(game)),
  ];
  const s = game.world.session, st = game.world.stage;
  const el = h('div', { class: 'pause', 'data-screen': 'pause' },
    h('div', { class: 'pz-panel' },
      h('div', { class: 'pz-head' }, h('span', null, 'PAUSED'), h('h1', null, '暂停')),
      h('div', { class: 'pz-items' }, items),
    ),
    h('div', { class: 'pz-info' },
      h('div', { class: 'pz-stage' }, h('b', null, st.def.name), h('span', null, `${st.env.name}${st.def.reverse ? ' · 反向' : ''}`)),
      h('div', { class: 'pz-time mono' }, fmtTime(Math.max(0, s.time))),
      h('div', { class: 'pz-meta' }, `进度 ${(s.progress * 100).toFixed(0)}% · 罚时 ${s.penalties} 秒`),
      h('div', { class: 'pz-keys' },
        h('div', null, h('kbd', null, '↑ ↓ ← →'), ' 或 WASD 驾驶'), h('div', null, h('kbd', null, '空格'), ' 手刹 ', h('kbd', null, '左 Shift'), ' 轻踩'),
        h('div', null, h('kbd', null, 'E'), ' 升挡 ', h('kbd', null, 'Q'), ' 降挡（手动挡）'),
        h('div', null, h('kbd', null, 'R'), ' 回到路上（+5 秒）'), h('div', null, h('kbd', null, 'C'), ' 视角 ', h('kbd', null, 'P'), ' 轨迹预测 ', h('kbd', null, 'M'), ' 静音 ', h('kbd', null, 'K'), ' 手机配对'),
        // two lines, broken at the semicolon (the panel is narrow)
        h('div', { class: 'pz-rule' }, HOLD_RULE.split('；').map((t, i, all) => h('div', null, i < all.length - 1 ? `${t}；` : t))),
      ),
    ),
    hints(H_NAV),
  );
  const sc: Screen = { el, back: resume, focus: items[0] };
  app.overlay(sc);
  return sc;
}
