// Title and main menu.
import { app } from '../../app/app';
import { h, navItem, firstAsset, bgUrl } from '../dom';
import type { Screen } from '../nav';
import { sfx } from '../sfx';
import { hints, H_NAV } from './common';
import { SEASON_CN, currentRallyPlan } from '../../sim/rally/career';
import { carEntry, listEnvs } from '../../sim/rally/catalog';
import { BASE } from '../theme';

export function titleScreen(): Screen {
  const el = h('div', { class: 'title-screen', 'data-screen': 'title' },
    h('div', { class: 'art', style: `background-image:${bgUrl(firstAsset('/assets/ui/title_key.jpg', '/assets/ui/loading_2.jpg'))}` }),
    h('div', { class: 't-shade' }),
    h('div', { class: 't-block' },
      h('div', { class: 't-stripes' }, h('i'), h('i'), h('i')),
      h('div', { class: 't-cn' }, '尘迹拉力'),
      h('div', { class: 't-latin' }, 'DUSTMARK'),
      h('div', { class: 't-sub' }, '砂石 · 红土 · 雪岭 · 山海  —  四地十二赛段'),
    ),
    h('div', { class: 't-press' }, '按任意键开始'),
    h('div', { class: 't-corner' }, '键盘 / 手柄'),
  );
  let done = false;
  const go = () => { if (done) return; done = true; sfx.ensure(); sfx.play('start'); app.go.menu(); };
  el.addEventListener('click', go);
  return { el, key: (k) => { if (k === 'any' || k === 'ok') { go(); return true; } return false; } };
}

interface MenuEntry { id: string; cn: string; latin: string; desc: string; art: string | null; info: () => string; run: () => void }

export function mainMenu(): Screen {
  const s = app.save;
  const career = s.career;
  const nextRally = career ? currentRallyPlan(career) : undefined;
  const car = carEntry(s.garage.car);
  const golds = Object.values(s.records).filter((r) => r.medal === 'gold').length;
  const envs = listEnvs();
  const stagesReady = envs.reduce((n, e) => n + e.stages.filter((x) => x.available).length, 0);
  const entries: MenuEntry[] = [
    {
      id: 'career', cn: '生涯', latin: 'CAREER', desc: '三个赛季，十二站拉力，从入门组打到顶级组。',
      art: firstAsset('/assets/ui/podium_bg.jpg', '/assets/ui/menu_bg_3.jpg'),
      info: () => career ? `${SEASON_CN[career.season]}<br><b>${nextRally ? nextRally.name : '赛季结算'}</b>${career.current ? ` · 第 ${career.current.stage + 1} 赛段` : ''}` : '<b>新生涯</b><br>入门组 · 两辆小钢炮任选',
      run: () => app.go.career(),
    },
    {
      id: 'single', cn: '单赛段', latin: 'SINGLE STAGE', desc: '任选环境、赛段、方向和天气，跑一次。',
      art: firstAsset('/assets/ui/env_nordic_wide.jpg', '/assets/ui/loading_2.jpg'),
      info: () => `<b>${stagesReady}</b> 条赛段可跑 · 正向 / 反向`,
      run: () => app.go.stageSelect('single'),
    },
    {
      id: 'time', cn: '计时挑战', latin: 'TIME TRIAL', desc: '和自己最好的幽灵车同跑，冲金银铜目标。',
      art: firstAsset('/assets/ui/menu_bg_3.jpg', '/assets/ui/loading_1.jpg'),
      info: () => `金牌 <b>${golds}</b> · 幽灵车 <b>${Object.values(s.records).filter((r) => r.ghost).length}</b>`,
      run: () => app.go.stageSelect('time'),
    },
    {
      id: 'garage', cn: '车库', latin: 'GARAGE', desc: '六台赛车，看参数、挑涂装。',
      art: firstAsset('/assets/ui/menu_bg_1.jpg', '/assets/ui/loading_1.jpg'),
      info: () => car ? `当前用车<br><b>${car.name} ${car.model}</b>` : '',
      run: () => app.go.garage(),
    },
    {
      id: 'settings', cn: '设置', latin: 'SETTINGS', desc: '驾驶辅助、声音、画质、手柄。',
      art: firstAsset('/assets/ui/menu_bg_2.jpg', '/assets/ui/loading_1.jpg'),
      info: () => '',
      run: () => app.go.settings(() => app.go.menu()),
    },
  ];
  // two art layers cross-fade as the focus moves
  const artA = h('div', { class: 'art fade on' }), artB = h('div', { class: 'art fade' });
  let front = artA;
  const setArt = (p: string | null) => {
    const url = bgUrl(p);
    if (front.style.backgroundImage === url) return;
    const back = front === artA ? artB : artA;
    back.style.backgroundImage = url;
    back.classList.add('on'); front.classList.remove('on');
    front = back;
  };
  const desc = h('div', { class: 'mm-desc' });
  const info = h('div', { class: 'mm-info' });
  const items = entries.map((e) => {
    const it = navItem(h('div', { class: 'mm-item', 'data-id': e.id }, h('span', { class: 'mm-cn' }, e.cn), h('span', { class: 'mm-latin' }, e.latin)), e.run);
    it.addEventListener('navfocus', () => { setArt(e.art); desc.textContent = e.desc; info.innerHTML = e.info(); info.style.display = info.innerHTML ? '' : 'none'; });
    return it;
  });
  const el = h('div', { class: 'main-menu', 'data-screen': 'menu' },
    artA, artB,
    h('div', { class: 'mm-panel' },
      h('div', { class: 't-stripes mm-stripes' }, h('i'), h('i'), h('i')),
      h('div', { class: 'mm-logo' }, h('b', null, '尘迹拉力'), h('span', null, 'DUSTMARK')),
      h('div', { class: 'mm-items' }, items),
      desc,
    ),
    info,
    hints(H_NAV),
  );
  return { el, back: () => app.go.title(), focus: items[0] };
}

export const MENU_THEME = BASE;
