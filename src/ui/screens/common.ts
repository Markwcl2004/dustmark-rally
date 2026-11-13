// Shared bits of the menu screens: key-hint footer, headers, buttons, value rows, confirm dialog.
import { app } from '../../app/app';
import { navItem, h, bgUrl } from '../dom';
import { nav, type NavKey, type Screen } from '../nav';

export type Hint = [string, string];

/** bottom bar: [key] action … */
export function hints(list: Hint[]) {
  return h('div', { class: 'hints' }, list.map(([k, t]) => h('span', null, ...k.split(' ').map((x) => h('kbd', null, x)), h('em', null, t))));
}
export const H_NAV: Hint[] = [['↑ ↓', '选择'], ['Enter', '确认'], ['Esc', '返回']];

/** the keyboard method in one line (手感重做: every driving key works by being held) — intro card, 控制 page, pause */
export const HOLD_RULE = '按住就行：方向、油门、手刹都不用点按；想温柔一点按住左 Shift。';

/** big poster headline: Chinese title + Latin kicker */
export function headline(cn: string, latin: string, cls = '') {
  return h('div', { class: `headline ${cls}` }, h('div', { class: 'hl-latin' }, latin), h('h1', { class: 'hl-cn' }, cn));
}

export function button(label: string, fn: () => void, opts: { cls?: string; disabled?: boolean; sub?: string } = {}) {
  return navItem(h('button', { class: `btn ${opts.cls ?? ''}` }, h('span', null, label), opts.sub ? h('small', null, opts.sub) : null), fn, { disabled: opts.disabled });
}

/** value row: label · ‹ value › ; ← → or click on the arrows changes it */
export function valueRow<T>(label: string, options: { v: T; label: string; disabled?: boolean }[], get: () => T, set: (v: T) => void, desc = '') {
  const val = h('b', { class: 'vr-val' });
  const row = h('div', { class: 'vrow', 'data-desc': desc }, h('span', { class: 'vr-label' }, label), h('span', { class: 'vr-ctl' }, h('i', { class: 'vr-l' }, '‹'), val, h('i', { class: 'vr-r' }, '›')));
  const render = () => {
    const cur = options.find((o) => o.v === get());
    val.textContent = cur?.label ?? String(get());
    row.classList.toggle('dis-val', !!cur?.disabled);
  };
  const step = (dir: -1 | 1) => {
    const ok = options.filter((o) => !o.disabled);
    if (!ok.length) return;
    let i = ok.findIndex((o) => o.v === get());
    i = (i + dir + ok.length) % ok.length;
    set(ok[i].v);
    render();
  };
  navItem(row, () => step(1), { adjust: step });
  row.querySelector('.vr-l')!.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  row.querySelector('.vr-r')!.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  render();
  return Object.assign(row, { render });
}

/** slider row 0..1 (or any range) shown as a bar */
export function sliderRow(label: string, min: number, max: number, stepV: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, desc = '') {
  const fill = h('i');
  const val = h('b', { class: 'vr-val' });
  const row = h('div', { class: 'vrow slider', 'data-desc': desc }, h('span', { class: 'vr-label' }, label), h('span', { class: 'vr-ctl' }, h('span', { class: 'sl-bar' }, fill), val));
  const render = () => { const v = get(); fill.style.width = `${((v - min) / (max - min)) * 100}%`; val.textContent = fmt(v); };
  const step = (dir: -1 | 1) => { const v = Math.round((get() + dir * stepV) / stepV) * stepV; set(Math.min(max, Math.max(min, +v.toFixed(4)))); render(); };
  navItem(row, () => step(1), { adjust: step });
  row.querySelector('.sl-bar')!.addEventListener('click', (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = ((e as MouseEvent).clientX - r.left) / r.width;
    set(Math.min(max, Math.max(min, Math.round((min + f * (max - min)) / stepV) * stepV))); render();
    e.stopPropagation();
  });
  render();
  return row;
}

/** modal choice dialog over whatever is shown */
export function confirm(title: string, body: string, choices: { label: string; sub?: string; fn: () => void; disabled?: boolean; cls?: string }[], onBack?: () => void) {
  const btns = choices.map((c) => button(c.label, () => { app.closeOverlay(sc); c.fn(); }, { sub: c.sub, disabled: c.disabled, cls: c.cls }));
  const card = h('div', { class: 'dialog' }, h('h2', null, title), h('p', { html: body }), h('div', { class: 'dlg-btns' }, btns));
  const el = h('div', { class: 'dim', 'data-screen': 'dialog' }, card);
  const sc: Screen = { el, back: () => { app.closeOverlay(sc); onBack?.(); }, focus: btns.find((b) => b.getAttribute('aria-disabled') !== 'true') ?? btns[0], trap: card };
  app.overlay(sc);
  return sc;
}

/** full-bleed art layer */
export function art(path: string | null, cls = 'art') { return h('div', { class: cls, style: `background-image:${bgUrl(path)}` }); }

/** focus a nav element and keep the navigator in sync */
export function focusEl(e: HTMLElement | null | undefined) { if (e) nav.focus(e, false); }

export type KeyFn = (k: NavKey, e?: KeyboardEvent) => boolean;
