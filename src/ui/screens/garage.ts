// Garage: the six cars on a turntable with their sheet; liveries; locks. Also the car picker of the career.
import { app } from '../../app/app';
import { turntable } from '../../app/menuTurntable';
import { CARS } from '../../data/cars';
import { h, navItem, firstAsset, bgUrl } from '../dom';
import type { Screen } from '../nav';
import { sfx } from '../sfx';
import { button, hints } from './common';
import { GROUPS, listCars, type CarEntry } from '../../sim/rally/catalog';
import { SEASON_CN, SEASON_UNLOCK_POINTS } from '../../sim/rally/career';

const LOCK_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em"><path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1.5A1.5 1.5 0 0 1 20 11.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20.5v-9A1.5 1.5 0 0 1 5.5 10H7zm2 0h6V7a3 3 0 0 0-6 0v3z"/></svg>';

/** 0..1 ratings for the bars, from the car data (design targets + chassis) */
export function ratings(c: CarEntry) {
  const spec = CARS[c.id];
  const wb = spec?.wheelbase ?? 2.45;
  const cl = (v: number) => Math.min(1, Math.max(0.08, v));
  return {
    加速: cl((9.5 - c.zeroTo100) / 6),
    极速: cl((c.topKmh - 160) / 55),
    灵活: cl(1 - (wb - 2.3) / 0.35),
    稳定: cl((c.drive === 'awd' ? 0.6 : c.drive === 'fwd' ? 0.5 : 0.28) + (wb - 2.3) * 0.9),
  };
}

export function lockReason(c: CarEntry, unlocked: number) {
  if (!c.available) return '即将开放';
  if (c.groupIdx <= unlocked) return '';
  return `生涯「${SEASON_CN[c.groupIdx - 1]}」拿够 ${SEASON_UNLOCK_POINTS[c.groupIdx - 1]} 分解锁`;
}

export interface GarageOpts {
  /** career picker: only these cars, Enter picks */
  only?: string[];
  title?: [string, string];
  onPick?: (car: string, livery: number) => void;
  back: () => void;
}

export function garageScreen(opts: GarageOpts): Screen {
  const all = listCars();
  const cars = opts.only ? all.filter((c) => opts.only!.includes(c.id)) : all;
  const unlocked = app.save.unlockedGroup;
  let idx = Math.max(0, cars.findIndex((c) => c.id === app.save.garage.car));
  const livOf = (c: CarEntry) => app.save.garage.liveries[c.id] ?? 0;
  let liv = livOf(cars[idx]);

  const bgA = h('div', { class: 'art fade on' }), bgB = h('div', { class: 'art fade' });
  let front = bgA;
  const stage = h('div', { class: 'gr-stage' });
  const lock = h('div', { class: 'gr-lock' });
  const sheet = h('div', { class: 'gr-sheet' });
  const tabs = h('div', { class: 'gr-tabs' });
  const livs = h('div', { class: 'gr-livs' });
  const action = h('div', { class: 'gr-action' });
  let actBtn: HTMLElement | null = null;

  // car tabs grouped by class
  const tabEls: HTMLElement[] = [];
  GROUPS.forEach((g, gi) => {
    const inGroup = cars.filter((c) => c.groupIdx === gi);
    if (!inGroup.length) return;
    tabs.append(h('div', { class: 'gr-group' }, h('span', { class: 'gg-name' }, g), h('div', { class: 'gg-cars' }, inGroup.map((c) => {
      const t = h('div', { class: 'gr-tab', 'data-car': c.id, html: `${lockReason(c, unlocked) ? LOCK_SVG : ''}<b>${c.name}</b><small>${c.model}</small>` });
      t.addEventListener('click', () => { idx = cars.indexOf(c); liv = livOf(c); sfx.play('move'); render(); });
      tabEls.push(t);
      return t;
    }))));
  });

  const render = () => {
    const c = cars[idx];
    const reason = lockReason(c, unlocked);
    const art = firstAsset(`/assets/ui/card_bg_${all.indexOf(c) + 1}.jpg`, '/assets/ui/menu_bg_1.jpg');
    const url = bgUrl(art);
    if (front.style.backgroundImage !== url) { const back = front === bgA ? bgB : bgA; back.style.backgroundImage = url; back.classList.add('on'); front.classList.remove('on'); front = back; }
    for (const t of tabEls) t.classList.toggle('on', t.dataset.car === c.id);
    turntable.show(c.id, liv);
    lock.innerHTML = reason ? `<span>${LOCK_SVG}</span><b>${reason}</b>` : '';
    lock.style.display = reason ? '' : 'none';
    stage.classList.toggle('locked', !!reason);
    const recs = Object.values(app.save.records).filter((x) => x.car === c.id);
    const r = ratings(c);
    sheet.innerHTML = '';
    sheet.append(
      h('div', { class: 'gs-group' }, `${c.group} · ${c.driveCn}`),
      h('div', { class: 'gs-name' }, c.name),
      h('div', { class: 'gs-model' }, c.model),
      h('div', { class: 'gs-pers' }, c.personality || '　'),
      h('div', { class: 'gs-specs' },
        ...([['功率', `${c.hp}`, 'hp'], ['车重', `${c.massKg}`, 'kg'], ['0–100', c.zeroTo100.toFixed(1), 's'], ['极速', `${c.topKmh}`, 'km/h']] as const)
          .map(([k, v, u]) => h('div', null, h('span', null, k), h('b', { class: 'mono' }, v), h('i', null, u)))),
      h('div', { class: 'gs-bars' }, Object.entries(r).map(([k, v]) => h('div', { class: 'gb' }, h('span', null, k), h('span', { class: 'segs' }, ...Array.from({ length: 10 }, (_, i) => h('i', { class: i < Math.round(v * 10) ? 'on' : '' })))))),
      h('div', { class: 'gs-recs' }, recs.length ? `用这台车创下 ${recs.length} 项个人最佳 · 金牌 ${recs.filter((x) => x.medal === 'gold').length}` : '还没有用这台车创下的纪录'),
    );
    livs.innerHTML = '';
    c.liveries.forEach((l, i) => {
      const chip = h('div', { class: `liv ${i === liv ? 'on' : ''}` }, h('span', { class: 'liv-sw' }, h('i', { style: `background:${l.base}` }), h('i', { style: `background:${l.c1}` }), h('i', { style: `background:${l.c2}` })), h('b', null, l.name), h('small', { class: 'mono' }, `#${l.number}`));
      chip.addEventListener('click', () => { liv = i; sfx.play('tick'); render(); });
      livs.append(chip);
    });
    action.innerHTML = '';
    const isCur = !opts.onPick && app.save.garage.car === c.id && livOf(c) === liv;
    actBtn = button(opts.onPick ? '选这台车' : isCur ? '当前用车' : '设为当前用车', () => choose(), { disabled: !!reason, cls: 'go', sub: reason ? '' : 'Enter' });
    action.append(actBtn);
    queueMicrotask(() => { if (actBtn?.isConnected) app_nav_focus(actBtn); });
  };

  const choose = () => {
    const c = cars[idx];
    if (lockReason(c, unlocked)) { sfx.play('deny'); return; }
    if (opts.onPick) { opts.onPick(c.id, liv); return; }
    app.save.garage.car = c.id;
    app.save.garage.liveries[c.id] = liv;
    app.persist();
    sfx.play('ok');
    render();
  };

  const [cn, latin] = opts.title ?? ['车库', 'GARAGE'];
  const el = h('div', { class: 'garage', 'data-screen': opts.onPick ? 'car-pick' : 'garage' },
    bgA, bgB,
    h('div', { class: 'gr-head' }, h('div', { class: 'hl-latin' }, latin), h('h1', { class: 'hl-cn' }, cn)),
    tabs,
    stage, lock,
    h('div', { class: 'gr-side' }, sheet, h('div', { class: 'gr-livs-h' }, '涂装'), livs, action),
    hints([['← →', '换车'], ['↑ ↓', '涂装'], ['Enter', opts.onPick ? '选车' : '设为当前'], ['Esc', '返回']]),
  );
  const sc: Screen = {
    el,
    back: opts.back,
    key: (k) => {
      if (k === 'left' || k === 'right') { idx = (idx + (k === 'right' ? 1 : cars.length - 1)) % cars.length; liv = livOf(cars[idx]); sfx.play('move'); render(); return true; }
      if (k === 'up' || k === 'down') { const n = cars[idx].liveries.length || 3; liv = (liv + (k === 'down' ? 1 : n - 1)) % n; sfx.play('tick'); render(); return true; }
      if (k === 'ok') { choose(); return true; }
      return false;
    },
    leave: () => turntable.unmount(),
  };
  queueMicrotask(() => { turntable.mount(stage); render(); });
  return sc;
}

import { nav } from '../nav';
function app_nav_focus(e: HTMLElement) { nav.focus(e, false); }
export { navItem };
